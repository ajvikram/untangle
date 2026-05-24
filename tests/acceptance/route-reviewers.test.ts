/**
 * Acceptance tests for `route_reviewers`.
 * Spec: specs/07-route-reviewers.md
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { routeReviewers, matchPathPattern, parseCodeowners } from "../../src/tools/route-reviewers.js";
import type { SplitProposal } from "../../src/schemas/types.js";

const execFileP = promisify(execFile);

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "untangle-route-test-"));
  await execFileP("git", ["init", "-b", "main"], { cwd: dir });
  await execFileP("git", ["config", "user.email", "test@untangle.dev"], { cwd: dir });
  await execFileP("git", ["config", "user.name", "Untangle Test"], { cwd: dir });
  
  // Add seed code
  await writeFile(join(dir, "README.md"), "seed\n");
  await execFileP("git", ["add", "-A"], { cwd: dir });
  await execFileP("git", ["commit", "-m", "seed"], { cwd: dir });
  return dir;
}

let repo: string;

beforeEach(async () => {
  repo = await makeRepo();
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("route_reviewers", () => {
  describe("Pattern matching unit tests", () => {
    it("matches exact paths", () => {
      expect(matchPathPattern("foo.ts", "foo.ts")).toBe(true);
      expect(matchPathPattern("bar.ts", "foo.ts")).toBe(false);
    });

    it("matches extension wildcards", () => {
      expect(matchPathPattern("src/foo.ts", "*.ts")).toBe(true);
      expect(matchPathPattern("src/foo.ts", "src/*.ts")).toBe(true);
      expect(matchPathPattern("src/nested/foo.ts", "src/*.ts")).toBe(false);
      expect(matchPathPattern("src/nested/foo.ts", "src/**/*.ts")).toBe(true);
    });

    it("matches directories", () => {
      expect(matchPathPattern("src/main.ts", "src/")).toBe(true);
      expect(matchPathPattern("tests/main.ts", "src/")).toBe(false);
    });
  });

  describe("CODEOWNERS parser", () => {
    it("parses patterns and owners", () => {
      const content = `
        # This is a comment
        *.ts @alice @bob
        src/ @charlie
      `;
      const rules = parseCodeowners(content);
      expect(rules).toHaveLength(2);
      expect(rules[0].pattern).toBe("*.ts");
      expect(rules[0].owners).toEqual(["alice", "bob"]);
      expect(rules[1].pattern).toBe("src/");
      expect(rules[1].owners).toEqual(["charlie"]);
    });
  });

  describe("Acceptance Tests on Git Fixtures", () => {
    it("resolves owners using codeowners-strict and excludes specified users", async () => {
      // 1. Write a CODEOWNERS file in the temp repo
      const codeownersContent = `
        *.ts @alice @bob
        src/ @charlie
      `;
      await writeFile(join(repo, "CODEOWNERS"), codeownersContent);
      
      // 2. Add some files and commit them to establish blame
      await mkdir(join(repo, "src"), { recursive: true });
      await writeFile(join(repo, "src/main.ts"), "console.log('main');\n");
      await writeFile(join(repo, "index.ts"), "console.log('index');\n");
      await execFileP("git", ["add", "-A"], { cwd: repo });
      await execFileP("git", ["commit", "-m", "add TS files"], { cwd: repo });

      // 3. Construct a SplitProposal
      const proposal: SplitProposal = {
        slices: [
          {
            id: "slice1",
            title: "update index.ts",
            concernIds: ["c1"],
            hunks: [
              { filePath: "index.ts", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, hash: "h1" }
            ],
            effortScore: 0.2
          },
          {
            id: "slice2",
            title: "update main.ts",
            concernIds: ["c2"],
            hunks: [
              { filePath: "src/main.ts", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, hash: "h2" }
            ],
            effortScore: 0.3
          }
        ],
        stackStrategy: "flat",
        rejected: false,
        meta: {
          originalLoC: 2,
          sliceCount: 2,
          proposalId: "prop1"
        }
      };

      // Test codeowners-strict policy
      const result = await routeReviewers({
        proposal,
        repo,
        policy: "codeowners-strict",
        excludeUsers: ["alice"]
      });

      expect(result.schemaVersion).toBe("1");
      expect(result.unassigned).toHaveLength(0);
      expect(result.assignments).toHaveLength(2);

      // Slice 1: index.ts -> owned by *.ts (@alice @bob). Since @alice is excluded, should only be @bob
      const slice1 = result.assignments.find(a => a.sliceId === "slice1");
      expect(slice1).toBeDefined();
      expect(slice1!.reviewers).toHaveLength(1);
      expect(slice1!.reviewers[0].login).toBe("bob");

      // Slice 2: src/main.ts -> matched by src/ @charlie (since it matches last)
      const slice2 = result.assignments.find(a => a.sliceId === "slice2");
      expect(slice2).toBeDefined();
      expect(slice2!.reviewers).toHaveLength(1);
      expect(slice2!.reviewers[0].login).toBe("charlie");
    });

    it("resolves owners using blame-weighted and incorporates blame statistics", async () => {
      // Establish blame with another author
      await execFileP("git", ["config", "user.email", "alice@example.com"], { cwd: repo });
      await execFileP("git", ["config", "user.name", "alice"], { cwd: repo });
      await writeFile(join(repo, "index.ts"), "line 1 by alice\nline 2 by alice\n");
      await execFileP("git", ["add", "-A"], { cwd: repo });
      await execFileP("git", ["commit", "-m", "index by alice"], { cwd: repo });

      const proposal: SplitProposal = {
        slices: [
          {
            id: "slice1",
            title: "update index.ts",
            concernIds: ["c1"],
            hunks: [
              { filePath: "index.ts", oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, hash: "h1" }
            ],
            effortScore: 0.2
          }
        ],
        stackStrategy: "flat",
        rejected: false,
        meta: {
          originalLoC: 2,
          sliceCount: 1,
          proposalId: "prop1"
        }
      };

      const result = await routeReviewers({
        proposal,
        repo,
        policy: "blame-weighted"
      });

      expect(result.schemaVersion).toBe("1");
      expect(result.assignments).toHaveLength(1);
      
      const slice1 = result.assignments[0];
      // alice should be recommended as author since she wrote the code
      expect(slice1.reviewers.some(r => r.login === "alice")).toBe(true);
      expect(slice1.reviewers.find(r => r.login === "alice")!.weight).toBeGreaterThan(0);
    });
  });
});
