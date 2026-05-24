/**
 * Unit tests for src/core/slice-builder.ts.
 * Pure logic — no I/O.
 */

import { describe, it, expect } from "vitest";
import { buildSlices } from "../../src/core/slice-builder.js";
import type { Concern, ConcernGraph, HunkRef } from "../../src/schemas/types.js";

const hunk = (file: string, hash: string, loc = 10): HunkRef => ({
  filePath: file,
  oldStart: 1,
  oldLines: loc,
  newStart: 1,
  newLines: loc,
  hash,
});

const concern = (
  id: string,
  kind: Concern["kind"],
  dependsOn: string[] = [],
  hunks = [hunk(`${id}.ts`, `h-${id}`)],
): Concern => ({
  id,
  kind,
  summary: `concern ${id}`,
  hunks,
  dependsOn,
  confidence: 0.9,
  riskHints: { touchesPublicAPI: false, touchesConfig: false, touchesSecurity: false },
});

function graphOf(concerns: Concern[]): ConcernGraph {
  const dag: Array<[string, string]> = [];
  for (const c of concerns) {
    for (const d of c.dependsOn) dag.push([c.id, d]);
  }
  const totalLoc = concerns.flatMap((c) => c.hunks).reduce((s, h) => s + h.newLines, 0);
  return {
    concerns,
    dag,
    meta: { hunkCount: concerns.length, fileCount: concerns.length, loc: totalLoc, languagesDetected: ["ts"] },
  };
}

describe("buildSlices", () => {
  it("produces one slice per concern under maxConcernsPerSlice=1", () => {
    const g = graphOf([concern("a", "feature"), concern("b", "refactor"), concern("c", "test")]);
    const slices = buildSlices(g, { maxConcernsPerSlice: 1, maxLocPerSlice: 1000, stackStrategy: "flat" });
    expect(slices).toHaveLength(3);
    expect(slices.every((s) => s.concernIds.length === 1)).toBe(true);
  });

  it("respects DAG order in topological sort", () => {
    const g = graphOf([
      concern("a", "feature"),
      concern("b", "test", ["a"]),
    ]);
    const slices = buildSlices(g, { maxConcernsPerSlice: 1, maxLocPerSlice: 1000, stackStrategy: "flat" });
    const aIdx = slices.findIndex((s) => s.concernIds.includes("a"));
    const bIdx = slices.findIndex((s) => s.concernIds.includes("b"));
    expect(aIdx).toBeLessThan(bIdx);
  });

  it("hard-caps at 3 concerns per slice even when asked for more", () => {
    const concerns = ["a", "b", "c", "d", "e"].map((id) => concern(id, "feature"));
    const g = graphOf(concerns);
    const slices = buildSlices(g, { maxConcernsPerSlice: 10, maxLocPerSlice: 10000, stackStrategy: "flat" });
    expect(slices.every((s) => s.concernIds.length <= 3)).toBe(true);
  });

  it("assigns parentSliceId for stacked strategies", () => {
    const g = graphOf([
      concern("a", "feature"),
      concern("b", "test", ["a"]),
    ]);
    const slices = buildSlices(g, { maxConcernsPerSlice: 1, maxLocPerSlice: 1000, stackStrategy: "gh-stack" });
    const dependent = slices.find((s) => s.concernIds.includes("b"));
    expect(dependent?.parentSliceId).toBeDefined();
  });

  it("keeps every concern accounted for (no drops)", () => {
    const concerns = ["a", "b", "c", "d"].map((id) => concern(id, "feature"));
    const g = graphOf(concerns);
    const slices = buildSlices(g, { maxConcernsPerSlice: 2, maxLocPerSlice: 10000, stackStrategy: "flat" });
    const allConcernIds = slices.flatMap((s) => s.concernIds).sort();
    expect(allConcernIds).toEqual(["a", "b", "c", "d"]);
  });

  it("never produces overlapping hunks across sibling slices", () => {
    const g = graphOf([
      concern("a", "feature", [], [hunk("x.ts", "h1")]),
      concern("b", "refactor", [], [hunk("y.ts", "h2")]),
    ]);
    const slices = buildSlices(g, { maxConcernsPerSlice: 1, maxLocPerSlice: 1000, stackStrategy: "flat" });
    const allHashes = slices.flatMap((s) => s.hunks.map((h) => h.hash));
    expect(new Set(allHashes).size).toBe(allHashes.length);
  });
});
