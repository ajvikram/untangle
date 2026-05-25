/**
 * Unit tests for src/tools/git-ops.ts.
 * Pure-logic checks: input validation, dry-run paths, protected-ref guards.
 * Wrapper-level integration is covered via a temp git repo for status/log/branch.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  gitStatus, gitDiff, gitLog, gitShow, gitBranch,
  gitCommit, gitPush, gitCheckout,
} from "../../src/tools/git-ops.js";
import { UntangleErrorImpl } from "../../src/schemas/types.js";

function gitInit(dir: string) {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
}

describe("git-ops: input validation", () => {
  it("git_commit requires a non-empty message", async () => {
    await expect(gitCommit({ message: "" })).rejects.toBeInstanceOf(UntangleErrorImpl);
    await expect(gitCommit({ message: "   " })).rejects.toBeInstanceOf(UntangleErrorImpl);
  });

  it("git_diff mode=range requires base + head", async () => {
    await expect(gitDiff({ mode: "range" })).rejects.toBeInstanceOf(UntangleErrorImpl);
    await expect(gitDiff({ mode: "range", base: "main" })).rejects.toBeInstanceOf(UntangleErrorImpl);
  });
});

describe("git-ops: protected ref guards", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "untangle-gitops-protect-"));
    gitInit(tmp);
    writeFileSync(join(tmp, "a.txt"), "hello\n");
    execFileSync("git", ["add", "a.txt"], { cwd: tmp });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: tmp });
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("git_push refuses default-protected branches (main)", async () => {
    await expect(gitPush({ repo: tmp, branch: "main" })).rejects.toMatchObject({
      code: "REF_PROTECTED",
    });
  });

  it("git_push respects custom protectRefs override (empty list allows main)", async () => {
    // Empty array overrides defaults — caller is opting in to push to main.
    // We can't actually push (no remote) so dryRun:true validates the guard path.
    const out = await gitPush({ repo: tmp, branch: "main", protectRefs: [], dryRun: true });
    expect(out.dryRun).toBe(true);
    expect(out.branch).toBe("main");
  });

  it("git_push dryRun does not actually push", async () => {
    execFileSync("git", ["checkout", "-q", "-b", "feature/safe"], { cwd: tmp });
    const out = await gitPush({ repo: tmp, branch: "feature/safe", dryRun: true });
    expect(out.dryRun).toBe(true);
    expect(out.pushed).toBe(false);
  });
});

describe("git-ops: introspection over a real repo", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "untangle-gitops-introspect-"));
    gitInit(tmp);
    writeFileSync(join(tmp, "README.md"), "# hello\n");
    execFileSync("git", ["add", "README.md"], { cwd: tmp });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: tmp });
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src/a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "src/a.ts"], { cwd: tmp });
    execFileSync("git", ["commit", "-q", "-m", "feat: add a"], { cwd: tmp });
    writeFileSync(join(tmp, "src/b.ts"), "export const b = 2;\n"); // untracked
    writeFileSync(join(tmp, "README.md"), "# hello\nupdated\n");   // modified
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("git_status returns structured branch + file state", async () => {
    const out = await gitStatus({ repo: tmp });
    expect(out.schemaVersion).toBe("1");
    expect(out.status.branch).toBe("main");
    expect(out.status.untracked).toContain("src/b.ts");
    expect(out.status.modified).toContain("README.md");
    expect(out.status.clean).toBe(false);
  });

  it("git_log returns commits in reverse-chronological order", async () => {
    const out = await gitLog({ repo: tmp, maxCount: 10 });
    expect(out.commits.length).toBe(2);
    expect(out.commits[0]!.subject).toBe("feat: add a");
    expect(out.commits[1]!.subject).toBe("init");
    expect(out.commits[0]!.author).toBe("Test");
  });

  it("git_show renders a commit with stat", async () => {
    const log = await gitLog({ repo: tmp, maxCount: 1 });
    const out = await gitShow({ repo: tmp, ref: log.commits[0]!.sha, stat: true });
    expect(out.content).toContain("src/a.ts");
  });

  it("git_branch lists branches and current", async () => {
    execFileSync("git", ["checkout", "-q", "-b", "feature/x"], { cwd: tmp });
    const out = await gitBranch({ repo: tmp });
    expect(out.current).toBe("feature/x");
    const names = out.branches.map((b) => b.name);
    expect(names).toContain("main");
    expect(names).toContain("feature/x");
  });

  it("git_diff working mode returns unstaged changes", async () => {
    execFileSync("git", ["checkout", "-q", "main"], { cwd: tmp });
    const out = await gitDiff({ repo: tmp, mode: "working" });
    expect(out.mode).toBe("working");
    expect(out.diff).toContain("README.md");
  });

  it("git_checkout dryRun does not change ref", async () => {
    const before = await gitBranch({ repo: tmp });
    const out = await gitCheckout({ repo: tmp, ref: "feature/x", dryRun: true });
    expect(out.dryRun).toBe(true);
    const after = await gitBranch({ repo: tmp });
    expect(after.current).toBe(before.current);
  });

  it("git_commit dryRun reports staged paths without committing", async () => {
    // start clean
    execFileSync("git", ["checkout", "-q", "--", "README.md"], { cwd: tmp });
    rmSync(join(tmp, "src/b.ts"), { force: true });
    const before = await gitLog({ repo: tmp, maxCount: 5 });
    const out = await gitCommit({ repo: tmp, message: "feat: dryrun", dryRun: true, addAll: true });
    expect(out.dryRun).toBe(true);
    expect(out.sha).toBeNull();
    const after = await gitLog({ repo: tmp, maxCount: 5 });
    expect(after.commits.length).toBe(before.commits.length);
  });
});
