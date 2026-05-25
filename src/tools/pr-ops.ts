/**
 * GitHub PR operation tools — thin handlers over GhWrapper exposed as MCP tools.
 * Destructive ops accept dryRun and refuse without explicit confirm on protected refs.
 */

import { GhWrapper } from "../core/gh.js";
import type { MergeMethod, PrState, ReviewEvent } from "../core/gh.js";
import { UntangleErrorImpl } from "../schemas/types.js";
import { logger } from "../util/logger.js";

const PROTECTED_BASE_REFS = ["main", "master", "develop", "production", "release"];

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

export interface PrListInput {
  repo?: string;
  state?: PrState;
  base?: string;
  head?: string;
  author?: string;
  limit?: number;
  search?: string;
}
export async function prList(input: PrListInput = {}): Promise<{ schemaVersion: "1"; prs: Awaited<ReturnType<GhWrapper["listPRs"]>> }> {
  const gh = new GhWrapper(input.repo ?? ".");
  const prs = await gh.listPRs({
    state: input.state,
    base: input.base,
    head: input.head,
    author: input.author,
    limit: input.limit ?? 30,
    search: input.search,
  });
  return { schemaVersion: "1", prs };
}

export interface PrViewInput { repo?: string; number: number | string }
export async function prView(input: PrViewInput): Promise<{ schemaVersion: "1"; pr: Awaited<ReturnType<GhWrapper["viewPR"]>> }> {
  if (input.number === undefined || input.number === null) {
    throw new UntangleErrorImpl("BAD_INPUT", "PR number is required", false);
  }
  const gh = new GhWrapper(input.repo ?? ".");
  const pr = await gh.viewPR(input.number);
  return { schemaVersion: "1", pr };
}

export interface PrDiffInput { repo?: string; number: number | string }
export async function prDiff(input: PrDiffInput): Promise<{ schemaVersion: "1"; diff: string }> {
  if (input.number === undefined || input.number === null) {
    throw new UntangleErrorImpl("BAD_INPUT", "PR number is required", false);
  }
  const gh = new GhWrapper(input.repo ?? ".");
  const diff = await gh.prDiff(input.number);
  return { schemaVersion: "1", diff };
}

export interface PrChecksInput { repo?: string; number: number | string }
export async function prChecks(input: PrChecksInput): Promise<{
  schemaVersion: "1";
  checks: Awaited<ReturnType<GhWrapper["prChecks"]>>;
  summary: { total: number; success: number; failure: number; pending: number };
}> {
  if (input.number === undefined || input.number === null) {
    throw new UntangleErrorImpl("BAD_INPUT", "PR number is required", false);
  }
  const gh = new GhWrapper(input.repo ?? ".");
  const checks = await gh.prChecks(input.number);
  const summary = { total: checks.length, success: 0, failure: 0, pending: 0 };
  for (const c of checks) {
    const concl = (c.conclusion ?? "").toLowerCase();
    const stat = (c.status ?? "").toLowerCase();
    if (concl === "success") summary.success++;
    else if (concl === "failure" || concl === "cancelled" || concl === "timed_out") summary.failure++;
    else if (stat === "in_progress" || stat === "queued" || stat === "pending" || concl === "") summary.pending++;
  }
  return { schemaVersion: "1", checks, summary };
}

// ---------------------------------------------------------------------------
// Review / approval / comment
// ---------------------------------------------------------------------------

export interface PrReviewInput {
  repo?: string;
  number: number | string;
  event: ReviewEvent;
  body?: string;
}
export async function prReview(input: PrReviewInput): Promise<{ schemaVersion: "1"; event: ReviewEvent; number: number | string }> {
  if (input.number === undefined || input.number === null) {
    throw new UntangleErrorImpl("BAD_INPUT", "PR number is required", false);
  }
  if (!["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(input.event)) {
    throw new UntangleErrorImpl("BAD_INPUT", `invalid review event '${input.event}'`, false);
  }
  if (input.event === "REQUEST_CHANGES" && (!input.body || input.body.trim().length === 0)) {
    throw new UntangleErrorImpl("BAD_INPUT", "REQUEST_CHANGES requires a non-empty body", false);
  }
  const gh = new GhWrapper(input.repo ?? ".");
  await gh.reviewPR(input.number, { event: input.event, body: input.body });
  return { schemaVersion: "1", event: input.event, number: input.number };
}

export interface PrCommentInput {
  repo?: string;
  number: number | string;
  body: string;
}
export async function prComment(input: PrCommentInput): Promise<{ schemaVersion: "1"; number: number | string }> {
  if (input.number === undefined || input.number === null) {
    throw new UntangleErrorImpl("BAD_INPUT", "PR number is required", false);
  }
  if (!input.body || input.body.trim().length === 0) {
    throw new UntangleErrorImpl("BAD_INPUT", "comment body is required", false);
  }
  const gh = new GhWrapper(input.repo ?? ".");
  await gh.commentPR(input.number, input.body);
  return { schemaVersion: "1", number: input.number };
}

export interface PrReviewDismissInput {
  repo?: string;
  number: number | string;
  reviewId: number | string;
  message: string;
}
export async function prReviewDismiss(input: PrReviewDismissInput): Promise<{ schemaVersion: "1"; reviewId: number | string }> {
  if (!input.message || input.message.trim().length === 0) {
    throw new UntangleErrorImpl("BAD_INPUT", "dismiss message is required by GitHub", false);
  }
  const gh = new GhWrapper(input.repo ?? ".");
  await gh.dismissReview(input.number, input.reviewId, input.message);
  return { schemaVersion: "1", reviewId: input.reviewId };
}

export interface PrRequestReviewersInput {
  repo?: string;
  number: number | string;
  reviewers?: string[];
  teamReviewers?: string[];
}
export async function prRequestReviewers(input: PrRequestReviewersInput): Promise<{ schemaVersion: "1"; requested: number }> {
  const reviewers = input.reviewers ?? [];
  const teams = input.teamReviewers ?? [];
  if (reviewers.length === 0 && teams.length === 0) {
    throw new UntangleErrorImpl("BAD_INPUT", "at least one reviewer or teamReviewer is required", false);
  }
  const gh = new GhWrapper(input.repo ?? ".");
  await gh.requestReviewers(input.number, reviewers, teams);
  return { schemaVersion: "1", requested: reviewers.length + teams.length };
}

// ---------------------------------------------------------------------------
// Merge / ready / close / reopen
// ---------------------------------------------------------------------------

export interface PrMergeInput {
  repo?: string;
  number: number | string;
  method?: MergeMethod;
  deleteBranch?: boolean;
  adminOverride?: boolean;
  auto?: boolean;
  matchSha?: string;
  body?: string;
  dryRun?: boolean;
  confirmProtectedBase?: boolean;
}
export async function prMerge(input: PrMergeInput): Promise<{
  schemaVersion: "1";
  merged: boolean;
  method: MergeMethod;
  number: number | string;
  dryRun: boolean;
}> {
  if (input.number === undefined || input.number === null) {
    throw new UntangleErrorImpl("BAD_INPUT", "PR number is required", false);
  }
  const method = input.method ?? "merge";
  const gh = new GhWrapper(input.repo ?? ".");

  // Look up the PR to check base ref and check status before merging
  const pr = await gh.viewPR(input.number);
  if (pr.state !== "OPEN") {
    throw new UntangleErrorImpl("PR_NOT_OPEN", `PR #${pr.number} is ${pr.state}, cannot merge`, false);
  }
  if (PROTECTED_BASE_REFS.includes(pr.baseRef) && !input.confirmProtectedBase && !input.dryRun) {
    throw new UntangleErrorImpl(
      "PROTECTED_BASE",
      `PR targets protected base '${pr.baseRef}'. Re-run with confirmProtectedBase:true to proceed.`,
      false,
      { baseRef: pr.baseRef, defaults: PROTECTED_BASE_REFS },
    );
  }
  if (input.dryRun) {
    return { schemaVersion: "1", merged: false, method, number: input.number, dryRun: true };
  }
  await gh.mergePR(input.number, {
    method,
    deleteBranch: input.deleteBranch,
    adminOverride: input.adminOverride,
    auto: input.auto,
    matchSha: input.matchSha,
    body: input.body,
  });
  logger.info("pr_merge_tool", { number: input.number, method });
  return { schemaVersion: "1", merged: true, method, number: input.number, dryRun: false };
}

export interface PrReadyInput { repo?: string; number: number | string }
export async function prReady(input: PrReadyInput): Promise<{ schemaVersion: "1"; number: number | string }> {
  if (input.number === undefined || input.number === null) {
    throw new UntangleErrorImpl("BAD_INPUT", "PR number is required", false);
  }
  const gh = new GhWrapper(input.repo ?? ".");
  await gh.markReady(input.number);
  return { schemaVersion: "1", number: input.number };
}

export interface PrCloseInput {
  repo?: string;
  number: number | string;
  dryRun?: boolean;
}
export async function prClose(input: PrCloseInput): Promise<{ schemaVersion: "1"; closed: boolean; number: number | string; dryRun: boolean }> {
  if (input.number === undefined || input.number === null) {
    throw new UntangleErrorImpl("BAD_INPUT", "PR number is required", false);
  }
  if (input.dryRun) {
    return { schemaVersion: "1", closed: false, number: input.number, dryRun: true };
  }
  const gh = new GhWrapper(input.repo ?? ".");
  await gh.closePR(input.number);
  return { schemaVersion: "1", closed: true, number: input.number, dryRun: false };
}

export interface PrReopenInput { repo?: string; number: number | string }
export async function prReopen(input: PrReopenInput): Promise<{ schemaVersion: "1"; number: number | string }> {
  if (input.number === undefined || input.number === null) {
    throw new UntangleErrorImpl("BAD_INPUT", "PR number is required", false);
  }
  const gh = new GhWrapper(input.repo ?? ".");
  await gh.reopenPR(input.number);
  return { schemaVersion: "1", number: input.number };
}
