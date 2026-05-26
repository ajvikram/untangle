/**
 * Unit tests for src/core/concern-graph.ts.
 * Pure logic — no I/O, no LLM.
 */

import { describe, it, expect } from "vitest";
import {
  buildConcernGraph,
  validateDag,
  stableConcernId,
} from "../../src/core/concern-graph.js";
import type { Concern, HunkRef } from "../../src/schemas/types.js";

const hunk = (file: string, hash: string): HunkRef => ({
  filePath: file,
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 1,
  hash,
});

describe("stableConcernId", () => {
  it("returns the same ID for the same hunks regardless of order", () => {
    const hunks = [hunk("a.ts", "h1"), hunk("b.ts", "h2")];
    expect(stableConcernId(hunks)).toBe(stableConcernId([...hunks].reverse()));
  });

  it("returns different IDs for different hunk sets", () => {
    expect(stableConcernId([hunk("a.ts", "h1")])).not.toBe(
      stableConcernId([hunk("a.ts", "h2")]),
    );
  });
});

describe("validateDag", () => {
  it("accepts a valid DAG", () => {
    const concerns: Concern[] = [
      { id: "a", kind: "feature", summary: "a", hunks: [], dependsOn: [], confidence: 1, riskHints: { touchesPublicAPI: false, touchesConfig: false, touchesSecurity: false } },
      { id: "b", kind: "test", summary: "b", hunks: [], dependsOn: ["a"], confidence: 1, riskHints: { touchesPublicAPI: false, touchesConfig: false, touchesSecurity: false } },
    ];
    expect(() => validateDag(concerns)).not.toThrow();
  });

  it("detects a 2-cycle", () => {
    const concerns: Concern[] = [
      { id: "a", kind: "feature", summary: "a", hunks: [], dependsOn: ["b"], confidence: 1, riskHints: { touchesPublicAPI: false, touchesConfig: false, touchesSecurity: false } },
      { id: "b", kind: "feature", summary: "b", hunks: [], dependsOn: ["a"], confidence: 1, riskHints: { touchesPublicAPI: false, touchesConfig: false, touchesSecurity: false } },
    ];
    expect(() => validateDag(concerns)).toThrow(
      expect.objectContaining({ code: "DAG_CYCLE" }),
    );
  });

  it("detects a 3-cycle through transitive deps", () => {
    const concerns: Concern[] = [
      { id: "a", kind: "feature", summary: "a", hunks: [], dependsOn: ["b"], confidence: 1, riskHints: { touchesPublicAPI: false, touchesConfig: false, touchesSecurity: false } },
      { id: "b", kind: "feature", summary: "b", hunks: [], dependsOn: ["c"], confidence: 1, riskHints: { touchesPublicAPI: false, touchesConfig: false, touchesSecurity: false } },
      { id: "c", kind: "feature", summary: "c", hunks: [], dependsOn: ["a"], confidence: 1, riskHints: { touchesPublicAPI: false, touchesConfig: false, touchesSecurity: false } },
    ];
    expect(() => validateDag(concerns)).toThrow(
      expect.objectContaining({ code: "DAG_CYCLE" }),
    );
  });
});

describe("buildConcernGraph", () => {
  it("builds meta correctly from concerns", () => {
    const concerns: Concern[] = [
      {
        id: "a",
        kind: "feature",
        summary: "a",
        hunks: [hunk("src/a.ts", "h1"), hunk("src/b.ts", "h2")],
        dependsOn: [],
        confidence: 1,
        riskHints: { touchesPublicAPI: false, touchesConfig: false, touchesSecurity: false },
      },
    ];
    const graph = buildConcernGraph(concerns, ["ts"]);
    expect(graph.meta.hunkCount).toBe(2);
    expect(graph.meta.fileCount).toBe(2);
    expect(graph.meta.languagesDetected).toEqual(["ts"]);
  });

  it("emits one DAG edge per dependsOn entry", () => {
    const concerns: Concern[] = [
      { id: "a", kind: "feature", summary: "a", hunks: [hunk("a", "h1")], dependsOn: [], confidence: 1, riskHints: { touchesPublicAPI: false, touchesConfig: false, touchesSecurity: false } },
      { id: "b", kind: "test", summary: "b", hunks: [hunk("b", "h2")], dependsOn: ["a"], confidence: 1, riskHints: { touchesPublicAPI: false, touchesConfig: false, touchesSecurity: false } },
    ];
    const graph = buildConcernGraph(concerns, ["ts"]);
    expect(graph.dag).toEqual([["b", "a"]]);
  });

  it("breaks dependency cycles instead of throwing", () => {
    // Regression: agent-generated dependencies sometimes form a cycle when
    // multiple concerns touch the same file. buildConcernGraph used to throw
    // DAG_CYCLE; it must now break the cycle and proceed.
    const concerns: Concern[] = [
      { id: "a", kind: "feature", summary: "a", hunks: [hunk("shared.ts", "h1")], dependsOn: ["b"], confidence: 0.9, riskHints: { touchesPublicAPI: false, touchesConfig: false, touchesSecurity: false } },
      { id: "b", kind: "feature", summary: "b", hunks: [hunk("shared.ts", "h2")], dependsOn: ["a"], confidence: 0.9, riskHints: { touchesPublicAPI: false, touchesConfig: false, touchesSecurity: false } },
    ];
    expect(() => buildConcernGraph(concerns, ["ts"])).not.toThrow();
    // After breaking the cycle, the resulting graph has only one of the
    // two edges (whichever direction the cycle-breaker dropped).
    const graph = buildConcernGraph(concerns, ["ts"]);
    expect(graph.dag.length).toBeLessThan(2);
  });

  it("breaks a 3-cycle", () => {
    const concerns: Concern[] = [
      { id: "a", kind: "feature", summary: "a", hunks: [], dependsOn: ["b"], confidence: 1, riskHints: { touchesPublicAPI: false, touchesConfig: false, touchesSecurity: false } },
      { id: "b", kind: "feature", summary: "b", hunks: [], dependsOn: ["c"], confidence: 1, riskHints: { touchesPublicAPI: false, touchesConfig: false, touchesSecurity: false } },
      { id: "c", kind: "feature", summary: "c", hunks: [], dependsOn: ["a"], confidence: 1, riskHints: { touchesPublicAPI: false, touchesConfig: false, touchesSecurity: false } },
    ];
    expect(() => buildConcernGraph(concerns, [])).not.toThrow();
  });
});
