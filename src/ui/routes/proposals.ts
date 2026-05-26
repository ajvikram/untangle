/**
 * Routes for proposals: list, detail, slice updates.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getStore } from "../state.js";
import { proposeSplit } from "../../tools/propose-split.js";
import { applySplit } from "../../tools/apply-split.js";
import { readJsonBody, sendJson, sendError } from "./util.js";
import type { ConcernGraph, SplitProposal } from "../../schemas/types.js";

export async function listProposals(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const store = getStore();
  sendJson(res, 200, { proposals: store.listProposals() });
}

export async function getProposal(_req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const rec = getStore().getProposal(id);
  if (!rec) return sendError(res, 404, "Proposal not found");
  sendJson(res, 200, rec);
}

export async function reproposeProposal(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const rec = getStore().getProposal(id);
  if (!rec || !rec.graph) return sendError(res, 404, "Proposal/graph not found");
  const body = await readJsonBody<{
    maxConcernsPerSlice?: number;
    maxLocPerSlice?: number;
    stackStrategy?: "gh-stack" | "sapling" | "graphite" | "flat";
    preserveOrder?: string[];
  }>(req);
  try {
    const result = await proposeSplit({ graph: rec.graph as ConcernGraph, ...body });
    getStore().attachProposal(id, result.proposal as SplitProposal);
    sendJson(res, 200, { ok: true, proposal: result.proposal });
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : String(err));
  }
}

/**
 * PUT /api/proposals/:id — replace the proposal's slices.
 * Body: { slices: Slice[] }  (sliceIds + hunks the UI editor produced).
 * Used by the slice editor for rename / move-hunk-between-slices.
 */
export async function editProposal(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const rec = getStore().getProposal(id);
  if (!rec || !rec.proposal) return sendError(res, 404, "Proposal not found or has no split");
  const body = await readJsonBody<{ slices?: SplitProposal["slices"] }>(req);
  if (!Array.isArray(body.slices)) return sendError(res, 400, "body.slices must be an array");
  // Validate: every slice has id + title + hunks + concernIds + effortScore.
  for (const s of body.slices) {
    if (!s || typeof s.id !== "string" || typeof s.title !== "string" || !Array.isArray(s.hunks)) {
      return sendError(res, 400, "each slice must have { id, title, hunks, concernIds, effortScore }");
    }
  }
  const next = {
    ...rec.proposal,
    slices: body.slices,
    meta: { ...rec.proposal.meta, sliceCount: body.slices.length },
  };
  getStore().attachProposal(id, next);
  sendJson(res, 200, { ok: true, proposal: next });
}

export async function applyProposal(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const rec = getStore().getProposal(id);
  if (!rec || !rec.proposal) return sendError(res, 404, "Proposal not found or has no split");
  const body = await readJsonBody<{
    target: Parameters<typeof applySplit>[0]["target"];
    dryRun?: boolean;
    draftPRs?: boolean;
    branchPrefix?: string;
  }>(req);
  if (!body.target) return sendError(res, 400, "target is required");
  try {
    const result = await applySplit({
      proposal: rec.proposal,
      target: body.target,
      dryRun: body.dryRun,
      draftPRs: body.draftPRs,
      branchPrefix: body.branchPrefix,
    });
    const branches: string[] = (result as { branches?: string[] }).branches ?? [];
    const prs: Array<{ url: string; sliceId: string }> = ((result as { prs?: Array<{ url: string; sliceId: string }> }).prs) ?? [];
    getStore().attachApplyResult(id, { branches, prs, dryRun: !!body.dryRun });
    getStore().logActivity({
      kind: "apply_split",
      summary: body.dryRun ? `Dry-run applied proposal ${id}` : `Applied proposal ${id}`,
      details: { branches, prs, dryRun: !!body.dryRun },
    });
    sendJson(res, 200, { ok: true, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getStore().logActivity({ kind: "apply_split", summary: `Apply failed: ${msg}`, error: msg });
    sendError(res, 500, msg);
  }
}
