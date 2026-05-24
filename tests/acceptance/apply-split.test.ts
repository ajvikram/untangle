/**
 * Acceptance tests for `apply_split`.
 * Spec: specs/05-apply-split.md
 * Safety: §S1, §S2, §S3, §S7, §S10
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { applySplit } from "../../src/tools/apply-split.js";
import { canonicalHash } from "../../src/util/hash.js";
import type { SplitProposal, Target } from "../../src/schemas/types.js";

const execFileP = promisify(execFile);

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "untangle-test-"));
  await execFileP("git", ["init", "-b", "main"], { cwd: dir });
  await execFileP("git", ["config", "user.email", "test@untangle.dev"], { cwd: dir });
  await execFileP("git", ["config", "user.name", "Untangle Test"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "seed\n");
  await execFileP("git", ["add", "-A"], { cwd: dir });
  await execFileP("git", ["commit", "-m", "seed"], { cwd: dir });
  return dir;
}

async function currentSha(dir: string): Promise<string> {
  const { stdout } = await execFileP("git", ["rev-parse", "HEAD"], { cwd: dir });
  return stdout.trim();
}

let repo: string;

beforeEach(async () => {
  repo = await makeRepo();
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function trivialProposal(repoPath: string): { proposal: SplitProposal; target: Target } {
  // A proposal with a single slice that adds a file.
  const proposal: SplitProposal = {
    slices: [
      {
        id: "s1",
        title: "add hello.txt",
        concernIds: ["c1"],
        hunks: [
          { filePath: "hello.txt", oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, hash: "h1" },
        ],
        effortScore: 0.6,
        kindMix: { feature: 1.0 },
      },
    ],
    stackStrategy: "flat",
    rejected: false,
    meta: { originalLoC: 1, sliceCount: 1, proposalId: "" },
  };
  proposal.meta.proposalId = canonicalHash(proposal.slices.map((s) => s.id).sort());
  const target: Target = { kind: "branch", repo: repoPath, branch: "main", base: "main" };
  return { proposal, target };
}

describe("apply_split", () => {
  describe("dry-run", () => {
    it("creates branches locally but does not push or open PRs", async () => {
      const { proposal, target } = trivialProposal(repo);
      const result = await applySplit({ proposal, target, dryRun: true });

      expect(result.rolledBack).toBe(false);
      expect(result.created).toHaveLength(1);
      expect(result.created[0]!.prUrl).toBeNull();
      expect(result.created[0]!.branch.startsWith("untangle/")).toBe(true);
    });
  });

  describe("safety", () => {
    it("leaves the original branch unchanged after dry-run (§S2)", async () => {
      const { proposal, target } = trivialProposal(repo);
      const before = await currentSha(repo);
      await applySplit({ proposal, target, dryRun: true });
      const after = await currentSha(repo);
      expect(after).toBe(before);
    });

    it("rejects a proposal whose ID does not match its slices (§S7)", async () => {
      const { proposal, target } = trivialProposal(repo);
      const tampered = { ...proposal, meta: { ...proposal.meta, proposalId: "wrong-id" } };
      await expect(
        applySplit({ proposal: tampered, target, dryRun: true }),
      ).rejects.toMatchObject({ code: "PROPOSAL_TAMPERED" });
    });

    it("errors on dirty working tree before any git op (§S10)", async () => {
      const { proposal, target } = trivialProposal(repo);
      await writeFile(join(repo, "dirty.txt"), "dirt\n");
      await expect(
        applySplit({ proposal, target, dryRun: true }),
      ).rejects.toMatchObject({ code: "GIT_DIRTY" });
    });
  });

  describe("rollback", () => {
    it("rolls back created branches on mid-stack failure", async () => {
      // Crafted: a 2-slice proposal where the second slice references a non-applicable hunk.
      const { target } = trivialProposal(repo);
      const proposal: SplitProposal = {
        slices: [
          {
            id: "s1",
            title: "good slice",
            concernIds: ["c1"],
            hunks: [
              { filePath: "ok.txt", oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, hash: "h1" },
            ],
            effortScore: 0.6,
            kindMix: { feature: 1.0 },
          },
          {
            id: "s2",
            title: "bad slice",
            concernIds: ["c2"],
            hunks: [
              // intentionally bogus hunk that will fail to apply
              { filePath: "nope.txt", oldStart: 999, oldLines: 999, newStart: 999, newLines: 999, hash: "h2" },
            ],
            effortScore: 0.6,
            kindMix: { fix: 1.0 },
          },
        ],
        stackStrategy: "flat",
        rejected: false,
        meta: { originalLoC: 2, sliceCount: 2, proposalId: "" },
      };
      proposal.meta.proposalId = canonicalHash(proposal.slices.map((s) => s.id).sort());

      const before = await currentSha(repo);
      await expect(
        applySplit({ proposal, target, dryRun: true }),
      ).rejects.toMatchObject({ code: "PATCH_REJECT" });
      const after = await currentSha(repo);
      expect(after).toBe(before);

      // No untangle/* branches should remain.
      const { stdout } = await execFileP("git", ["branch"], { cwd: repo });
      expect(stdout).not.toContain("untangle/");
    });
  });

  describe("idempotency", () => {
    it("re-applying the same proposal does not duplicate branches", async () => {
      const { proposal, target } = trivialProposal(repo);
      const a = await applySplit({ proposal, target, dryRun: true });
      const b = await applySplit({ proposal, target, dryRun: true });
      expect(a.created.map((c) => c.branch).sort()).toEqual(
        b.created.map((c) => c.branch).sort(),
      );
    });
  });
});
