/**
 * Acceptance tests for `summarize_slice`.
 * Spec: specs/06-summarize-slice.md
 */

import { describe, it, expect } from "vitest";
import { summarizeSlice } from "../../src/tools/summarize-slice.js";
import type { ConcernGraph, Slice } from "../../src/schemas/types.js";

function fixture(): { graph: ConcernGraph; slice: Slice } {
  const graph: ConcernGraph = {
    concerns: [
      {
        id: "c-feat",
        kind: "feature",
        summary: "add user export endpoint",
        hunks: [{ filePath: "src/api/export.ts", oldStart: 1, oldLines: 0, newStart: 1, newLines: 40, hash: "h1" }],
        dependsOn: [],
        confidence: 0.9,
        riskHints: { touchesPublicAPI: true, touchesConfig: false, touchesSecurity: false },
      },
    ],
    dag: [],
    meta: { hunkCount: 1, fileCount: 1, loc: 40, languagesDetected: ["ts"] },
  };
  const slice: Slice = {
    id: "s-feat",
    title: "add user export endpoint",
    concernIds: ["c-feat"],
    hunks: graph.concerns[0]!.hunks,
    effortScore: 0.65,
    kindMix: { feature: 1.0 },
  };
  return { graph, slice };
}

describe("summarize_slice", () => {
  it("returns a title under 72 chars in imperative voice", async () => {
    const { graph, slice } = fixture();
    const result = await summarizeSlice({ slice, graph });

    expect(result.title.length).toBeLessThanOrEqual(72);
    expect(result.title.trim().length).toBeGreaterThan(0);
    // Imperative — no "this PR" wording, no "Adds" gerund.
    expect(result.title.toLowerCase()).not.toContain("this pr");
  });

  it("body contains required sections (## Summary, ## Changes)", async () => {
    const { graph, slice } = fixture();
    const result = await summarizeSlice({ slice, graph });

    expect(result.body).toMatch(/^## Summary/m);
    expect(result.body).toMatch(/^## Changes/m);
  });

  it("references parent slice when parentSliceId is set", async () => {
    const { graph, slice } = fixture();
    const stacked: Slice = { ...slice, parentSliceId: "s-parent" };
    const result = await summarizeSlice({ slice: stacked, graph });

    expect(result.body.toLowerCase()).toContain("builds on");
  });

  it("returns empty specDeltaRefs when specSource is none", async () => {
    const { graph, slice } = fixture();
    const result = await summarizeSlice({ slice, graph, specSource: "none" });

    expect(result.specDeltaRefs).toEqual([]);
  });

  it("never exceeds 72-char title across 20 randomized slices", async () => {
    const { graph } = fixture();
    for (let i = 0; i < 20; i++) {
      const slice: Slice = {
        ...fixture().slice,
        id: `s-${i}`,
        title: `placeholder-${i}`,
      };
      const result = await summarizeSlice({ slice, graph });
      expect(result.title.length).toBeLessThanOrEqual(72);
    }
  });
});
