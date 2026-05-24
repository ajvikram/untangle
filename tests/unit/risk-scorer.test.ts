/**
 * Unit tests for src/core/risk-scorer.ts (the heuristic Circuit Breaker).
 * No LLM, no I/O.
 */

import { describe, it, expect } from "vitest";
import { HeuristicScorer } from "../../src/core/risk-scorer.js";

const scorer = new HeuristicScorer();

describe("HeuristicScorer", () => {
  it("scores an empty patch as 0", () => {
    expect(
      scorer.score({ patchSize: 0, filesTouched: 0, configEdits: 0, highRiskFiles: [], estimatedConcerns: 0 }),
    ).toBe(0);
  });

  it("scores a tiny 1-line / 1-file change low", () => {
    const s = scorer.score({
      patchSize: 1,
      filesTouched: 1,
      configEdits: 0,
      highRiskFiles: [],
      estimatedConcerns: 1,
    });
    expect(s).toBeLessThan(0.3);
  });

  it("scores a large multi-file mixed change high", () => {
    const s = scorer.score({
      patchSize: 1200,
      filesTouched: 24,
      configEdits: 3,
      highRiskFiles: [],
      estimatedConcerns: 4,
    });
    expect(s).toBeGreaterThan(0.6);
  });

  it("biases up when high-risk files are touched, even at small patch size", () => {
    const small = scorer.score({
      patchSize: 8,
      filesTouched: 1,
      configEdits: 0,
      highRiskFiles: [],
      estimatedConcerns: 1,
    });
    const smallButRisky = scorer.score({
      patchSize: 8,
      filesTouched: 1,
      configEdits: 0,
      highRiskFiles: ["src/auth/login.ts"],
      estimatedConcerns: 1,
    });
    expect(smallButRisky).toBeGreaterThan(small);
    expect(smallButRisky).toBeGreaterThanOrEqual(0.5);
  });

  it("output is always in [0, 1]", () => {
    const samples = [
      { patchSize: 0, filesTouched: 0, configEdits: 0, highRiskFiles: [], estimatedConcerns: 0 },
      { patchSize: 1e6, filesTouched: 1e3, configEdits: 100, highRiskFiles: ["a", "b"], estimatedConcerns: 50 },
      { patchSize: 50, filesTouched: 5, configEdits: 1, highRiskFiles: [], estimatedConcerns: 2 },
    ];
    for (const s of samples) {
      const out = scorer.score(s);
      expect(out).toBeGreaterThanOrEqual(0);
      expect(out).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic for the same input", () => {
    const input = { patchSize: 100, filesTouched: 4, configEdits: 1, highRiskFiles: [], estimatedConcerns: 2 };
    expect(scorer.score(input)).toBe(scorer.score(input));
  });
});
