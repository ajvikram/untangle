/**
 * Stash family tests against a real temp git repo.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  gitStash, gitStashList, gitStashPop, gitStashDrop,
} from "../../src/tools/git-ops.js";

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
}

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "untangle-stash-"));
  gitInit(tmp);
  writeFileSync(join(tmp, "a.txt"), "v1\n");
  execFileSync("git", ["add", "a.txt"], { cwd: tmp });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: tmp });
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("git_stash family", () => {
  it("stash + list + pop round-trip", async () => {
    writeFileSync(join(tmp, "a.txt"), "v2\n");
    const push = await gitStash({ repo: tmp, message: "test stash" });
    expect(push.ref).toMatch(/^stash@\{0\}$/);

    const listed = await gitStashList({ repo: tmp });
    expect(listed.stashes.length).toBeGreaterThanOrEqual(1);
    expect(listed.stashes[0]!.subject).toContain("test stash");

    const pop = await gitStashPop({ repo: tmp });
    expect(pop.popped).toBe(true);

    const after = await gitStashList({ repo: tmp });
    expect(after.stashes.length).toBe(listed.stashes.length - 1);
  });

  it("stash --apply leaves the stash in the list", async () => {
    writeFileSync(join(tmp, "a.txt"), "v3\n");
    await gitStash({ repo: tmp, message: "apply-only" });

    const before = await gitStashList({ repo: tmp });
    expect(before.stashes[0]!.subject).toContain("apply-only");

    // Reset the working file so apply doesn't conflict
    execFileSync("git", ["checkout", "--", "a.txt"], { cwd: tmp });

    const out = await gitStashPop({ repo: tmp, apply: true });
    expect(out.popped).toBe(false);

    const after = await gitStashList({ repo: tmp });
    expect(after.stashes.length).toBe(before.stashes.length); // still there

    // Cleanup
    execFileSync("git", ["checkout", "--", "a.txt"], { cwd: tmp });
    await gitStashDrop({ repo: tmp });
  });

  it("stash_list returns [] when no stashes", async () => {
    // Drain any leftover
    while ((await gitStashList({ repo: tmp })).stashes.length > 0) {
      await gitStashDrop({ repo: tmp });
    }
    const out = await gitStashList({ repo: tmp });
    expect(out.stashes).toEqual([]);
  });
});
