/**
 * Unit tests for the UI state store: proposal lifecycle, trim caps, event emission.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getStore, _resetStore } from "../../src/ui/state.js";
import type { ConcernGraph, SplitProposal } from "../../src/schemas/types.js";

const sampleGraph: ConcernGraph = {
  concerns: [{
    id: "c1",
    kind: "feature",
    summary: "add login",
    hunks: [],
    dependsOn: [],
    confidence: 0.9,
    riskHints: { touchesPublicAPI: false, touchesConfig: false, touchesSecurity: false },
  }],
  dag: [],
  meta: { hunkCount: 0, fileCount: 1, loc: 5, languagesDetected: ["ts"] },
};

const sampleProposal: SplitProposal = {
  slices: [{ id: "s1", title: "feat", concernIds: ["c1"], hunks: [], effortScore: 0.2 }],
  stackStrategy: "flat",
  rejected: false,
  meta: { originalLoC: 5, sliceCount: 1, proposalId: "abc" },
};

beforeEach(() => { _resetStore(); });

describe("StateStore: proposal lifecycle", () => {
  it("recordAnalyze returns an id and stores the graph", () => {
    const id = getStore().recordAnalyze({ graph: sampleGraph, repo: ".", branch: "feat", base: "main" });
    const rec = getStore().getProposal(id);
    expect(rec).toBeDefined();
    expect(rec!.graph).toEqual(sampleGraph);
    expect(rec!.branch).toBe("feat");
  });

  it("attachProposal links a split to an analyzed proposal", () => {
    const id = getStore().recordAnalyze({ graph: sampleGraph });
    getStore().attachProposal(id, sampleProposal);
    expect(getStore().getProposal(id)!.proposal).toEqual(sampleProposal);
  });

  it("attachApplyResult adds an applied record", () => {
    const id = getStore().recordAnalyze({ graph: sampleGraph });
    getStore().attachApplyResult(id, { branches: ["a", "b"], prs: [{ url: "u", sliceId: "s1" }], dryRun: false });
    expect(getStore().getProposal(id)!.applied!.branches).toEqual(["a", "b"]);
    expect(getStore().getProposal(id)!.applied!.dryRun).toBe(false);
  });

  it("listProposals returns newest first", async () => {
    const a = getStore().recordAnalyze({ graph: sampleGraph });
    await new Promise((r) => setTimeout(r, 5));
    const b = getStore().recordAnalyze({ graph: sampleGraph });
    const list = getStore().listProposals();
    expect(list[0]!.id).toBe(b);
    expect(list[1]!.id).toBe(a);
  });

  it("attachProposal is a no-op for unknown id", () => {
    expect(() => getStore().attachProposal("unknown-id", sampleProposal)).not.toThrow();
  });
});

describe("StateStore: activity log", () => {
  it("logActivity assigns id+ts and emits event", () => {
    let received: unknown = null;
    getStore().on("activity", (e) => { received = e; });
    const entry = getStore().logActivity({ kind: "git_commit", summary: "test" });
    expect(entry.id).toBeDefined();
    expect(entry.ts).toBeDefined();
    expect((received as { summary?: string } | null)?.summary).toBe("test");
  });

  it("listActivity returns newest first within the limit", () => {
    for (let i = 0; i < 5; i++) getStore().logActivity({ kind: "git_commit", summary: `c${i}` });
    const list = getStore().listActivity(3);
    expect(list).toHaveLength(3);
    expect(list[0]!.summary).toBe("c4");
    expect(list[2]!.summary).toBe("c2");
  });
});

describe("StateStore: change events", () => {
  it("emits change on recordAnalyze, attachProposal, attachApplyResult", () => {
    const events: unknown[] = [];
    getStore().on("change", (e) => events.push(e));
    const id = getStore().recordAnalyze({ graph: sampleGraph });
    getStore().attachProposal(id, sampleProposal);
    getStore().attachApplyResult(id, { branches: [], prs: [], dryRun: true });
    expect(events).toHaveLength(3);
  });
});
