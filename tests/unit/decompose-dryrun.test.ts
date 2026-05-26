/**
 * Regression: decompose's `dryRun` defaults to TRUE. A user calling
 * `decompose({ target, draftPRs: true, pushRemote: "origin" })` without
 * explicitly setting dryRun must:
 *   1. Not actually push or create PRs.
 *   2. Get a response with `dryRun: true`, `pushed: false`, `prsCreated: 0`,
 *      and a `status` string that explains they need dryRun:false to materialize.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { decompose } from "../../src/tools/decompose.js";

const execFileP = promisify(execFile);

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "untangle-dryrun-"));
  await execFileP("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await execFileP("git", ["config", "user.email", "t@e.com"], { cwd: repo });
  await execFileP("git", ["config", "user.name", "T"], { cwd: repo });
  await execFileP("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "init\n");
  await execFileP("git", ["add", "-A"], { cwd: repo });
  await execFileP("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  // Feature branch with a real change
  await execFileP("git", ["checkout", "-q", "-b", "feature/x"], { cwd: repo });
  await writeFile(join(repo, "a.ts"), "export const a = 1;\n");
  await execFileP("git", ["add", "-A"], { cwd: repo });
  await execFileP("git", ["commit", "-q", "-m", "feat: add a"], { cwd: repo });
  await execFileP("git", ["checkout", "-q", "main"], { cwd: repo });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("decompose: dryRun default", () => {
  it("defaults dryRun to true and surfaces it in the response", async () => {
    const out = await decompose({
      target: { kind: "branch", repo, branch: "feature/x", base: "main" },
      // no `dryRun` field — must default to true
      draftPRs: true,
      pushRemote: "origin",
    });
    expect(out.dryRun).toBe(true);
    expect(out.pushed).toBe(false);
    expect(out.prsCreated).toBe(0);
    expect(out.status).toContain("DRY-RUN");
    expect(out.status).toContain("dryRun:false");
    for (const s of out.slices) {
      expect(s.prUrl).toBeNull();
    }
  });

  it("logs a dry_run_skip entry explaining what was skipped", async () => {
    const out = await decompose({
      target: { kind: "branch", repo, branch: "feature/x", base: "main" },
    });
    const skip = out.logs.find((l) => l.includes("dry_run_skip"));
    expect(skip).toBeDefined();
    expect(skip).toContain("origin");
  });
});
