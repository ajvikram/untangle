/**
 * Wrappers that call existing tool functions and push their results
 * into the UI state store so the dashboard can render them.
 * Pure pass-through if the UI server is disabled.
 */

import { getStore } from "./state.js";
import { analyzeDiff } from "../tools/analyze-diff.js";
import { proposeSplit } from "../tools/propose-split.js";
import { applySplit } from "../tools/apply-split.js";
import { scoreReviewEffort } from "../tools/score-review-effort.js";
import { decompose } from "../tools/decompose.js";
import { routeReviewers } from "../tools/route-reviewers.js";
import { summarizeSlice } from "../tools/summarize-slice.js";
import type { ConcernGraph, SplitProposal } from "../schemas/types.js";

let _proposalIdByGraphHash = new Map<string, string>();
let _lastProposalId: string | null = null;

function graphKey(g: ConcernGraph): string {
  return JSON.stringify(g.concerns.map((c) => c.id).sort());
}

export async function instrumentedAnalyzeDiff(input: Parameters<typeof analyzeDiff>[0]): Promise<Awaited<ReturnType<typeof analyzeDiff>>> {
  const out = await analyzeDiff(input);
  const store = getStore();
  try {
    const repo = input.target.kind === "branch" || input.target.kind === "pr" ? input.target.repo : undefined;
    const branch = input.target.kind === "branch" ? input.target.branch : undefined;
    const base = input.target.kind === "branch" ? input.target.base : undefined;
    const graph = (out as { graph?: ConcernGraph }).graph;
    if (graph) {
      const id = store.recordAnalyze({ repo, branch, base, graph });
      _proposalIdByGraphHash.set(graphKey(graph), id);
      _lastProposalId = id;
      store.logActivity({
        kind: "analyze_diff",
        summary: `Analyzed diff: ${graph.concerns.length} concerns, ${graph.meta.fileCount} files, ${graph.meta.loc} LoC`,
        details: { concernCount: graph.concerns.length, fileCount: graph.meta.fileCount, loc: graph.meta.loc, proposalId: id },
      });
    }
  } catch { /* never fail the tool because of instrumentation */ }
  return out;
}

export async function instrumentedProposeSplit(input: Parameters<typeof proposeSplit>[0]): Promise<Awaited<ReturnType<typeof proposeSplit>>> {
  const out = await proposeSplit(input);
  const store = getStore();
  try {
    const proposal: SplitProposal | undefined = (out as { proposal?: SplitProposal }).proposal;
    if (proposal) {
      // Try to attach to the latest analyzed proposal for this graph; otherwise create a fresh record.
      const key = graphKey(input.graph);
      let id = _proposalIdByGraphHash.get(key) ?? _lastProposalId;
      if (!id) {
        id = store.recordAnalyze({ graph: input.graph });
        _proposalIdByGraphHash.set(key, id);
      }
      store.attachProposal(id, proposal);
      _lastProposalId = id;
      store.logActivity({
        kind: "propose_split",
        summary: proposal.rejected
          ? `Split proposal rejected: ${proposal.rejectionReason ?? "unknown"}`
          : `Proposed ${proposal.slices.length} slice(s) (${proposal.stackStrategy})`,
        details: { proposalId: id, sliceCount: proposal.slices.length, rejected: proposal.rejected },
      });
    }
  } catch { /* never fail */ }
  return out;
}

export async function instrumentedApplySplit(input: Parameters<typeof applySplit>[0]): Promise<Awaited<ReturnType<typeof applySplit>>> {
  const out = await applySplit(input);
  const store = getStore();
  try {
    const proposal = input.proposal;
    const key = graphKey({ concerns: [], dag: [], meta: { fileCount: 0, hunkCount: 0, loc: 0, languagesDetected: [] } } as unknown as ConcernGraph);
    // Use the last known id for the proposal we just applied
    const id = _lastProposalId;
    if (id) {
      const branches: string[] = (out as { branches?: string[] }).branches ?? [];
      const prs: Array<{ url: string; sliceId: string }> = ((out as { prs?: Array<{ url: string; sliceId: string }> }).prs) ?? [];
      store.attachApplyResult(id, { branches, prs, dryRun: !!input.dryRun });
    }
    store.logActivity({
      kind: "apply_split",
      summary: input.dryRun
        ? `Dry-run applied ${proposal.slices.length} slice(s)`
        : `Applied ${proposal.slices.length} slice(s)`,
      details: { sliceCount: proposal.slices.length, dryRun: !!input.dryRun },
    });
    // unused — silence linter
    void key;
  } catch { /* never fail */ }
  return out;
}

export async function instrumentedScoreReviewEffort(input: Parameters<typeof scoreReviewEffort>[0]): Promise<Awaited<ReturnType<typeof scoreReviewEffort>>> {
  const out = await scoreReviewEffort(input);
  try {
    getStore().logActivity({
      kind: "score_review_effort",
      summary: `Score ${(out as { score: number }).score.toFixed(2)} — ${(out as { shouldDecompose: boolean }).shouldDecompose ? "decompose" : "skip"}`,
      details: out as unknown as Record<string, unknown>,
    });
  } catch { /* never fail */ }
  return out;
}

export async function instrumentedRouteReviewers(input: Parameters<typeof routeReviewers>[0]): Promise<Awaited<ReturnType<typeof routeReviewers>>> {
  const out = await routeReviewers(input);
  try {
    getStore().logActivity({
      kind: "route_reviewers",
      summary: `Routed reviewers for ${out.assignments.length} slice(s)`,
      details: { assignmentCount: out.assignments.length, unassigned: out.unassigned.length },
    });
  } catch { /* never fail */ }
  return out;
}

export async function instrumentedSummarizeSlice(input: Parameters<typeof summarizeSlice>[0]): Promise<Awaited<ReturnType<typeof summarizeSlice>>> {
  const out = await summarizeSlice(input);
  try {
    getStore().logActivity({
      kind: "summarize_slice",
      summary: `Summarized slice "${(out as { title?: string }).title ?? input.slice.title}"`,
    });
  } catch { /* never fail */ }
  return out;
}

export async function instrumentedDecompose(input: Parameters<typeof decompose>[0]): Promise<Awaited<ReturnType<typeof decompose>>> {
  const out = await decompose(input);
  try {
    getStore().logActivity({
      kind: "decompose",
      summary: `Decomposed ${input.target.kind === "branch" ? input.target.branch : "diff"}`,
      details: out as unknown as Record<string, unknown>,
    });
  } catch { /* never fail */ }
  return out;
}

/** Test-only: reset accumulated mapping. */
export function _resetInstrumentation(): void {
  _proposalIdByGraphHash = new Map();
  _lastProposalId = null;
}
