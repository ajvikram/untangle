/**
 * Routes for PR list / view / diff / checks and PR mutations.
 * Thin wrappers over pr-ops tool functions; record activity for SSE.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getStore } from "../state.js";
import {
  prList, prView, prDiff, prChecks,
  prReview, prComment, prMerge, prClose, prReopen, prReady,
  prRequestReviewers, prReviewDismiss,
} from "../../tools/pr-ops.js";
import { readJsonBody, sendJson, sendError, sendText } from "./util.js";

function repoFromUrl(url: URL): string | undefined {
  return url.searchParams.get("repo") ?? undefined;
}

export async function listPrsRoute(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const out = await prList({
      repo: repoFromUrl(url),
      state: (url.searchParams.get("state") as "open" | "closed" | "merged" | "all" | null) ?? undefined,
      base: url.searchParams.get("base") ?? undefined,
      head: url.searchParams.get("head") ?? undefined,
      author: url.searchParams.get("author") ?? undefined,
      limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
      search: url.searchParams.get("search") ?? undefined,
    });
    sendJson(res, 200, out);
  } catch (err) {
    sendError(res, 502, err instanceof Error ? err.message : String(err));
  }
}

export async function viewPrRoute(_req: IncomingMessage, res: ServerResponse, url: URL, number: number): Promise<void> {
  try {
    const out = await prView({ repo: repoFromUrl(url), number });
    sendJson(res, 200, out);
  } catch (err) {
    sendError(res, 502, err instanceof Error ? err.message : String(err));
  }
}

export async function diffPrRoute(_req: IncomingMessage, res: ServerResponse, url: URL, number: number): Promise<void> {
  try {
    const out = await prDiff({ repo: repoFromUrl(url), number });
    sendText(res, 200, out.diff, "text/x-diff; charset=utf-8");
  } catch (err) {
    sendError(res, 502, err instanceof Error ? err.message : String(err));
  }
}

export async function checksPrRoute(_req: IncomingMessage, res: ServerResponse, url: URL, number: number): Promise<void> {
  try {
    const out = await prChecks({ repo: repoFromUrl(url), number });
    sendJson(res, 200, out);
  } catch (err) {
    sendError(res, 502, err instanceof Error ? err.message : String(err));
  }
}

export async function reviewPrRoute(req: IncomingMessage, res: ServerResponse, url: URL, number: number): Promise<void> {
  const body = await readJsonBody<{ event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body?: string }>(req);
  try {
    const out = await prReview({ repo: repoFromUrl(url), number, event: body.event, body: body.body });
    getStore().logActivity({
      kind: "pr_review",
      summary: `Reviewed PR #${number}: ${body.event}`,
      details: { number, event: body.event },
    });
    sendJson(res, 200, out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getStore().logActivity({ kind: "pr_review", summary: `Review failed on PR #${number}`, error: msg });
    sendError(res, 502, msg);
  }
}

export async function commentPrRoute(req: IncomingMessage, res: ServerResponse, url: URL, number: number): Promise<void> {
  const body = await readJsonBody<{ body: string }>(req);
  try {
    const out = await prComment({ repo: repoFromUrl(url), number, body: body.body });
    getStore().logActivity({ kind: "pr_comment", summary: `Commented on PR #${number}` });
    sendJson(res, 200, out);
  } catch (err) {
    sendError(res, 502, err instanceof Error ? err.message : String(err));
  }
}

export async function mergePrRoute(req: IncomingMessage, res: ServerResponse, url: URL, number: number): Promise<void> {
  const body = await readJsonBody<{
    method?: "merge" | "squash" | "rebase";
    deleteBranch?: boolean;
    adminOverride?: boolean;
    auto?: boolean;
    matchSha?: string;
    body?: string;
    confirmProtectedBase?: boolean;
    dryRun?: boolean;
  }>(req);
  try {
    const out = await prMerge({ repo: repoFromUrl(url), number, ...body });
    getStore().logActivity({
      kind: "pr_merge",
      summary: body.dryRun
        ? `Dry-run merge of PR #${number} (${body.method ?? "merge"})`
        : `Merged PR #${number} (${body.method ?? "merge"})`,
      details: { number, method: body.method ?? "merge", dryRun: !!body.dryRun },
    });
    sendJson(res, 200, out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getStore().logActivity({ kind: "pr_merge", summary: `Merge failed on PR #${number}`, error: msg });
    sendError(res, 502, msg);
  }
}

export async function closePrRoute(req: IncomingMessage, res: ServerResponse, url: URL, number: number): Promise<void> {
  const body = await readJsonBody<{ dryRun?: boolean }>(req);
  try {
    const out = await prClose({ repo: repoFromUrl(url), number, dryRun: body.dryRun });
    getStore().logActivity({
      kind: "pr_close",
      summary: body.dryRun ? `Dry-run close PR #${number}` : `Closed PR #${number}`,
    });
    sendJson(res, 200, out);
  } catch (err) {
    sendError(res, 502, err instanceof Error ? err.message : String(err));
  }
}

export async function reopenPrRoute(_req: IncomingMessage, res: ServerResponse, url: URL, number: number): Promise<void> {
  try {
    const out = await prReopen({ repo: repoFromUrl(url), number });
    getStore().logActivity({ kind: "pr_reopen", summary: `Reopened PR #${number}` });
    sendJson(res, 200, out);
  } catch (err) {
    sendError(res, 502, err instanceof Error ? err.message : String(err));
  }
}

export async function readyPrRoute(_req: IncomingMessage, res: ServerResponse, url: URL, number: number): Promise<void> {
  try {
    const out = await prReady({ repo: repoFromUrl(url), number });
    getStore().logActivity({ kind: "pr_ready", summary: `Marked PR #${number} ready for review` });
    sendJson(res, 200, out);
  } catch (err) {
    sendError(res, 502, err instanceof Error ? err.message : String(err));
  }
}

export async function requestReviewersPrRoute(req: IncomingMessage, res: ServerResponse, url: URL, number: number): Promise<void> {
  const body = await readJsonBody<{ reviewers?: string[]; teamReviewers?: string[] }>(req);
  try {
    const out = await prRequestReviewers({ repo: repoFromUrl(url), number, ...body });
    sendJson(res, 200, out);
  } catch (err) {
    sendError(res, 502, err instanceof Error ? err.message : String(err));
  }
}

export async function dismissReviewRoute(req: IncomingMessage, res: ServerResponse, url: URL, number: number): Promise<void> {
  const body = await readJsonBody<{ reviewId: number | string; message: string }>(req);
  try {
    const out = await prReviewDismiss({ repo: repoFromUrl(url), number, reviewId: body.reviewId, message: body.message });
    sendJson(res, 200, out);
  } catch (err) {
    sendError(res, 502, err instanceof Error ? err.message : String(err));
  }
}
