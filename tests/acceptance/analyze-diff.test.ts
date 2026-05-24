/**
 * Acceptance tests for `analyze_diff` (specs/02-analyze-diff.md).
 *
 * Red phase: these tests reference modules that don't exist yet.
 * They go green once src/tools/analyze-diff.ts is implemented per spec.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// These imports will fail until implementation lands. That's the point.
import { analyzeDiff } from "../../src/tools/analyze-diff.js";
import { setLlmClient } from "../../src/llm/client.js";
import type { ConcernGraph, Target } from "../../src/schemas/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");

async function loadFixture(name: string): Promise<Target> {
  const content = await readFile(join(fixtures, `${name}.diff`), "utf8");
  return { kind: "diff", content };
}

beforeAll(() => {
  setLlmClient({
    async chat(prompt: string) {
      // Find all indices of the form [index] in prompt
      const matches = [...prompt.matchAll(/\n\[(\d+)\]/g)];
      const indices = matches.map((m) => parseInt(m[1]!, 10));

      if (prompt.includes("cycle.diff") || (prompt.includes("src/a.ts") && prompt.includes("src/b.ts"))) {
        return {
          text: JSON.stringify({
            concerns: [
              {
                summary: "update a.ts",
                kind: "chore",
                hunkIndices: [0],
                dependsOn: [1],
              },
              {
                summary: "update b.ts",
                kind: "chore",
                hunkIndices: [1],
                dependsOn: [0],
              },
            ],
          }),
          inputTokens: 10,
          outputTokens: 10,
        };
      }

      if (prompt.includes("feature-refactor-test.diff") || prompt.includes("tests/api/export.test.ts")) {
        const hasCommitMsgs = prompt.includes("COMMIT MESSAGES:");
        const suffix = hasCommitMsgs ? " (msg)" : "";
        return {
          text: JSON.stringify({
            concerns: [
              {
                summary: "add user export endpoint" + suffix,
                kind: "feature",
                hunkIndices: [0],
              },
              {
                summary: "extract serializer logic" + suffix,
                kind: "refactor",
                hunkIndices: [1],
              },
              {
                summary: "add test suite for export endpoint" + suffix,
                kind: "test",
                hunkIndices: [2],
              },
            ],
          }),
          inputTokens: 10,
          outputTokens: 10,
        };
      }

      if (prompt.includes("feature-only.diff") || prompt.includes("feature-only")) {
        return {
          text: JSON.stringify({
            concerns: [
              {
                summary: "add user export endpoint",
                kind: "feature",
                hunkIndices: [0],
              },
            ],
          }),
          inputTokens: 10,
          outputTokens: 10,
        };
      }

      // Default response for feature-with-refactor, binary-mixed, or other tests
      const firstHunk = indices[0] ?? 0;
      const otherHunks = indices.slice(1);

      const concerns = [
        {
          summary: "add export functionality",
          kind: "feature",
          hunkIndices: [firstHunk],
        },
      ];

      if (otherHunks.length > 0) {
        concerns.push({
          summary: "refactor settings",
          kind: "refactor",
          hunkIndices: otherHunks,
        });
      }

      return {
        text: JSON.stringify({ concerns }),
        inputTokens: 10,
        outputTokens: 10,
      };
    },
  });
});

describe("analyze_diff", () => {
  describe("happy paths", () => {
    it("returns 3 concerns for the feature-refactor-test fixture", async () => {
      const target = await loadFixture("feature-refactor-test");
      const result = await analyzeDiff({ target });

      expect(result.schemaVersion).toBe("1");
      expect(result.graph.concerns).toHaveLength(3);

      const kinds = result.graph.concerns.map((c) => c.kind).sort();
      expect(kinds).toEqual(["feature", "refactor", "test"]);
    });

    it("returns a single concern for feature-only", async () => {
      const target = await loadFixture("feature-only");
      const result = await analyzeDiff({ target });

      expect(result.graph.concerns).toHaveLength(1);
      expect(result.graph.concerns[0]!.kind).toBe("feature");
    });

    it("batches large diffs into ≤ 2 LLM calls at default batch size", async () => {
      const target = await loadFixture("feature-with-refactor");
      const result = await analyzeDiff({ target, maxHunksPerCall: 40 });

      expect(result.costMeta.llmCalls).toBeLessThanOrEqual(2);
    });
  });

  describe("edge cases", () => {
    it("returns an empty graph for an empty diff", async () => {
      const target: Target = { kind: "diff", content: "" };
      const result = await analyzeDiff({ target });

      expect(result.graph.concerns).toHaveLength(0);
      expect(result.graph.dag).toHaveLength(0);
      expect(result.graph.meta.hunkCount).toBe(0);
    });

    it("rejects circular dependencies with DAG_CYCLE", async () => {
      const target = await loadFixture("cycle");
      await expect(analyzeDiff({ target })).rejects.toMatchObject({
        code: "DAG_CYCLE",
      });
    });

    it("handles binary-mixed diffs with a warning", async () => {
      const target = await loadFixture("binary-mixed");
      const result = await analyzeDiff({ target });

      expect(result.warnings.some((w) => w.includes("binary"))).toBe(true);
    });
  });

  describe("stability and determinism", () => {
    it("produces identical concern IDs on repeat invocation", async () => {
      const target = await loadFixture("feature-refactor-test");
      const a = await analyzeDiff({ target });
      const b = await analyzeDiff({ target });

      const ids = (g: ConcernGraph) => g.concerns.map((c) => c.id).sort();
      expect(ids(a.graph)).toEqual(ids(b.graph));
    });
  });

  describe("commit message signal", () => {
    it("uses commit messages when includeCommitMessages is true", async () => {
      const target = await loadFixture("feature-refactor-test");
      const without = await analyzeDiff({ target, includeCommitMessages: false });
      const withMsg = await analyzeDiff({ target, includeCommitMessages: true });

      // The two calls should produce structurally similar graphs but differ in
      // at least one concern's summary or confidence — proves the signal is wired.
      const summariesWithout = without.graph.concerns.map((c) => c.summary).join("|");
      const summariesWith = withMsg.graph.concerns.map((c) => c.summary).join("|");
      expect(summariesWithout).not.toBe(summariesWith);
    });
  });
});
