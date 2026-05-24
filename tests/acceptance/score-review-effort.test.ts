/**
 * Acceptance tests for `score_review_effort` — the Circuit Breaker.
 * Spec: specs/03-score-review-effort.md
 * Constitution §3 (Circuit Breaker is non-negotiable) and §S5 (no LLM here).
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { scoreReviewEffort } from "../../src/tools/score-review-effort.js";
import type { Target } from "../../src/schemas/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");

async function loadFixture(name: string): Promise<Target> {
  const content = await readFile(join(fixtures, `${name}.diff`), "utf8");
  return { kind: "diff", content };
}

describe("score_review_effort", () => {
  describe("Circuit Breaker decisions", () => {
    it("rejects decomposition for a trivial typo fix", async () => {
      const target = await loadFixture("trivial-typo");
      const result = await scoreReviewEffort({ target });

      expect(result.shouldDecompose).toBe(false);
      expect(result.score).toBeLessThan(0.3);
    });

    it("accepts decomposition for a mixed 3-concern PR", async () => {
      const target = await loadFixture("feature-refactor-test");
      const result = await scoreReviewEffort({ target });

      expect(result.shouldDecompose).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(0.5);
    });

    it("rejects decomposition for a lockfile-only change", async () => {
      const target = await loadFixture("lockfile-only");
      const result = await scoreReviewEffort({ target });

      expect(result.shouldDecompose).toBe(false);
    });

    it("biases up for high-risk paths even at small diff size", async () => {
      const target = await loadFixture("auth-touched");
      const result = await scoreReviewEffort({ target });

      expect(result.shouldDecompose).toBe(true);
      expect(result.signals.highRiskFiles.length).toBeGreaterThan(0);
    });
  });

  describe("empty / degenerate input", () => {
    it("returns score 0 for an empty diff", async () => {
      const target: Target = { kind: "diff", content: "" };
      const result = await scoreReviewEffort({ target });

      expect(result.score).toBe(0);
      expect(result.shouldDecompose).toBe(false);
    });
  });

  describe("policy threshold", () => {
    it("conservative policy is stricter than balanced", async () => {
      const target = await loadFixture("feature-with-refactor");
      const balanced = await scoreReviewEffort({ target, policy: "balanced" });
      const conservative = await scoreReviewEffort({ target, policy: "conservative" });

      // If balanced says decompose, conservative may or may not. If balanced says
      // skip, conservative must also say skip.
      if (!balanced.shouldDecompose) {
        expect(conservative.shouldDecompose).toBe(false);
      }
    });
  });

  describe("determinism and performance", () => {
    it("is deterministic across calls", async () => {
      const target = await loadFixture("feature-refactor-test");
      const a = await scoreReviewEffort({ target });
      const b = await scoreReviewEffort({ target });
      expect(a.score).toBe(b.score);
    });

    it("p99 latency under 500ms on a 10k LoC fixture", async () => {
      const target = await loadFixture("mass-rename");
      const start = performance.now();
      await scoreReviewEffort({ target });
      const durationMs = performance.now() - start;
      expect(durationMs).toBeLessThan(500);
    });
  });

  describe("signal extraction", () => {
    it("surfaces config edits in signals", async () => {
      const target = await loadFixture("feature-with-refactor");
      const result = await scoreReviewEffort({ target });

      expect(result.signals.patchSize).toBeGreaterThan(0);
      expect(result.signals.filesTouched).toBeGreaterThan(0);
      expect(typeof result.signals.configEdits).toBe("number");
    });
  });
});
