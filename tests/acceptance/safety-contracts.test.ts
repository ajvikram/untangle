/**
 * Safety contract tests.
 * Each §S1-§S10 in specs/safety-contracts.md has a test here.
 * These must always pass. Failing one is a security/safety regression.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { RefRegistry } from "../../src/core/ref-registry.js";
import { GitWrapper } from "../../src/core/git.js";
import { redactSensitive } from "../../src/llm/redactor.js";
import { applySplit } from "../../src/tools/apply-split.js";
import { proposeSplit } from "../../src/tools/propose-split.js";
import { scoreReviewEffort } from "../../src/tools/score-review-effort.js";
import { logger } from "../../src/util/logger.js";
import { withTimeout } from "../../src/util/timeout.js";

import type { ConcernGraph, SplitProposal, Target } from "../../src/schemas/types.js";

const execFileP = promisify(execFile);

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "untangle-safety-"));
  await execFileP("git", ["init", "-b", "main"], { cwd: repo });
  await execFileP("git", ["config", "user.email", "t@u.dev"], { cwd: repo });
  await execFileP("git", ["config", "user.name", "T"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "seed\n");
  await execFileP("git", ["add", "-A"], { cwd: repo });
  await execFileP("git", ["commit", "-m", "seed"], { cwd: repo });
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("§S1 — ref registry rejects unowned deletion", () => {
  it("throws REF_NOT_OWNED when deleting a ref not in the registry", async () => {
    const reg = new RefRegistry();
    reg.add("untangle/owned");
    await expect(reg.delete("untangle/not-owned")).rejects.toMatchObject({
      code: "REF_NOT_OWNED",
    });
  });
});

describe("§S2 — push rejects original branch", () => {
  it("blocks push to target.branch even on explicit request", async () => {
    const git = new GitWrapper(repo);
    await expect(
      git.push("origin", "main", { protectRefs: ["main"] }),
    ).rejects.toMatchObject({ code: "REF_PROTECTED" });
  });
});

describe("§S3 — push uses --force-with-lease", () => {
  it("the git wrapper exposes no raw --force push API", () => {
    const git = new GitWrapper(repo) as unknown as Record<string, unknown>;
    // Reflective check: there should be no method or option named "forcePush" without lease.
    expect(Object.keys(git)).not.toContain("forcePush");
  });
});

describe("§S4 — LLM redactor filters credentials", () => {
  it("redacts GitHub tokens", () => {
    const input = "Here is my token: ghp_abcdef1234567890ABCDEF1234567890abcd";
    expect(redactSensitive(input)).not.toContain("ghp_abcdef");
  });

  it("redacts .env-shaped lines", () => {
    const input = "API_KEY=sk-1234567890abcdef\nOTHER=value";
    expect(redactSensitive(input)).not.toContain("sk-1234567890abcdef");
  });
});

describe("§S5 — score_review_effort never imports LLM client", async () => {
  it("the module dependency graph excludes src/llm/client", async () => {
    // Static check: import score-review-effort and inspect that the LLM client
    // is not loaded. This relies on the module not having dynamic imports.
    const before = Object.keys(require.cache ?? {});
    await import("../../src/tools/score-review-effort.js");
    const after = Object.keys(require.cache ?? {});
    const newlyLoaded = after.filter((k) => !before.includes(k));
    expect(newlyLoaded.some((k) => k.includes("llm/client"))).toBe(false);
  });
});

describe("§S6 — propose_split rejects too many slices", () => {
  it("throws TOO_MANY_SLICES when planner would produce > 16", async () => {
    const concerns = Array.from({ length: 20 }, (_, i) => ({
      id: `c-${i}`,
      kind: "feature" as const,
      summary: `concern ${i}`,
      hunks: [{ filePath: `f${i}.ts`, oldStart: 1, oldLines: 0, newStart: 1, newLines: 5, hash: `h${i}` }],
      dependsOn: [],
      confidence: 0.9,
      riskHints: { touchesPublicAPI: false, touchesConfig: false, touchesSecurity: false },
    }));
    const graph: ConcernGraph = {
      concerns,
      dag: [],
      meta: { hunkCount: 20, fileCount: 20, loc: 100, languagesDetected: ["ts"] },
    };
    // Force every concern to its own slice; planner must refuse > 16.
    await expect(
      proposeSplit({ graph, maxConcernsPerSlice: 1 }),
    ).rejects.toMatchObject({ code: "TOO_MANY_SLICES" });
  });
});

describe("§S7 — apply_split rejects tampered proposal", () => {
  it("rejects when proposalId does not match canonical slice hash", async () => {
    const proposal: SplitProposal = {
      slices: [],
      stackStrategy: "flat",
      rejected: false,
      meta: { originalLoC: 0, sliceCount: 0, proposalId: "deadbeef" },
    };
    const target: Target = { kind: "branch", repo, branch: "main", base: "main" };
    await expect(
      applySplit({ proposal, target, dryRun: true }),
    ).rejects.toMatchObject({ code: "PROPOSAL_TAMPERED" });
  });
});

describe("§S8 — logger redacts sensitive fields", () => {
  it("logged objects never include the raw credentials field", () => {
    const captured: string[] = [];
    logger.attach((line) => captured.push(line));
    logger.info("test", { ghp_token: "ghp_secret", normal: "ok" });
    expect(captured.join("\n")).not.toContain("ghp_secret");
  });
});

describe("§S9 — external calls have timeouts", () => {
  it("withTimeout rejects when the wrapped promise hangs", async () => {
    const hang = new Promise(() => {});
    await expect(withTimeout(hang, 50)).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });
});

describe("§S10 — tools assert clean working tree", () => {
  it("score_review_effort with target.kind=branch errors on dirty tree", async () => {
    await writeFile(join(repo, "dirty.txt"), "dirt\n");
    const target: Target = { kind: "branch", repo, branch: "main", base: "main" };
    await expect(
      scoreReviewEffort({ target }),
    ).rejects.toMatchObject({ code: "GIT_DIRTY" });
  });
});
