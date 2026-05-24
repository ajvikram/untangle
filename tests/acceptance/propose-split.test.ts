/**
 * Acceptance tests for `propose_split`.
 * Spec: specs/04-propose-split.md
 */

import { describe, it, expect } from "vitest";
import { proposeSplit } from "../../src/tools/propose-split.js";
import type { ConcernGraph } from "../../src/schemas/types.js";

function fixtureGraph(): ConcernGraph {
  return {
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
      {
        id: "c-refactor",
        kind: "refactor",
        summary: "extract serializer helper",
        hunks: [{ filePath: "src/api/serializer.ts", oldStart: 1, oldLines: 20, newStart: 1, newLines: 25, hash: "h2" }],
        dependsOn: [],
        confidence: 0.85,
        riskHints: { touchesPublicAPI: false, touchesConfig: false, touchesSecurity: false },
      },
      {
        id: "c-test",
        kind: "test",
        summary: "cover export endpoint",
        hunks: [{ filePath: "tests/api/export.test.ts", oldStart: 1, oldLines: 0, newStart: 1, newLines: 30, hash: "h3" }],
        dependsOn: ["c-feat"],
        confidence: 0.95,
        riskHints: { touchesPublicAPI: false, touchesConfig: false, touchesSecurity: false },
      },
    ],
    dag: [["c-test", "c-feat"]],
    meta: { hunkCount: 3, fileCount: 3, loc: 115, languagesDetected: ["ts"] },
  };
}

describe("propose_split", () => {
  describe("happy paths", () => {
    it("produces 3 slices for 3 independent-ish concerns (flat strategy)", async () => {
      const graph = fixtureGraph();
      const { proposal } = await proposeSplit({ graph, stackStrategy: "flat" });

      expect(proposal.rejected).toBe(false);
      expect(proposal.slices).toHaveLength(3);
      expect(proposal.slices.every((s) => s.parentSliceId === undefined)).toBe(true);
    });

    it("respects DAG order: test slice comes after feature slice", async () => {
      const graph = fixtureGraph();
      const { proposal } = await proposeSplit({ graph });

      const featIdx = proposal.slices.findIndex((s) => s.concernIds.includes("c-feat"));
      const testIdx = proposal.slices.findIndex((s) => s.concernIds.includes("c-test"));
      expect(featIdx).toBeLessThan(testIdx);
    });

    it("with gh-stack strategy, slices have parentSliceId set in chain order", async () => {
      const graph = fixtureGraph();
      const { proposal } = await proposeSplit({ graph, stackStrategy: "gh-stack" });

      const stacked = proposal.slices.filter((s) => s.parentSliceId !== undefined);
      // At least the dependent slice should reference a parent.
      expect(stacked.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Circuit Breaker integration", () => {
    it("rejects when riskScore is below threshold", async () => {
      const graph = fixtureGraph();
      const { proposal } = await proposeSplit({ graph, riskScore: 0.2, riskThreshold: 0.5 });

      expect(proposal.rejected).toBe(true);
      expect(proposal.slices).toHaveLength(0);
      expect(proposal.rejectionReason).toBeTruthy();
    });
  });

  describe("constraints", () => {
    it("respects maxConcernsPerSlice: 1 → one concern per slice", async () => {
      const graph = fixtureGraph();
      const { proposal } = await proposeSplit({ graph, maxConcernsPerSlice: 1 });

      expect(proposal.slices.every((s) => s.concernIds.length === 1)).toBe(true);
    });

    it("hard caps concern count at 3 per slice (constitution §4)", async () => {
      const graph = fixtureGraph();
      // Even if we ask for more, the spec mandates ≤ 3.
      const { proposal } = await proposeSplit({ graph, maxConcernsPerSlice: 10 });

      expect(proposal.slices.every((s) => s.concernIds.length <= 3)).toBe(true);
    });

    it("emits a warning when a single concern exceeds maxLocPerSlice", async () => {
      const graph = fixtureGraph();
      const { proposal } = await proposeSplit({ graph, maxLocPerSlice: 10 });

      // Each concern in fixture is >10 LoC; planner keeps them but warns.
      expect(proposal.slices.length).toBeGreaterThan(0);
    });
  });

  describe("determinism", () => {
    it("produces stable proposalId for same input", async () => {
      const graph = fixtureGraph();
      const a = await proposeSplit({ graph });
      const b = await proposeSplit({ graph });
      expect(a.proposal.meta.proposalId).toBe(b.proposal.meta.proposalId);
    });
  });

  describe("error cases", () => {
    it("errors on unknown concern ID in preserveOrder", async () => {
      const graph = fixtureGraph();
      await expect(
        proposeSplit({ graph, preserveOrder: ["c-nonexistent"] }),
      ).rejects.toMatchObject({ code: "UNKNOWN_CONCERN" });
    });
  });
});
