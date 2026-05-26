/**
 * Tool: decompose — orchestrate end-to-end git/GitHub analysis and split.
 * Chains analyze_diff -> propose_split -> route_reviewers -> apply_split.
 */

import { analyzeDiff } from "./analyze-diff.js";
import { proposeSplit } from "./propose-split.js";
import { routeReviewers } from "./route-reviewers.js";
import { applySplit } from "./apply-split.js";
import { normalizeTarget, UntangleErrorImpl } from "../schemas/types.js";
import type { Target } from "../schemas/types.js";

/**
 * decompose materializes slices as commits on stacked branches via apply_split,
 * which can only address hunks present in `git diff base...branch`. Refuse early
 * for shapes that can't produce branches.
 */
function assertApplyableTarget(target: Target): asserts target is Extract<Target, { kind: "branch" }> {
  if (target.kind === "branch") return;
  if (target.kind === "pr") {
    throw new UntangleErrorImpl(
      "NOT_IMPLEMENTED",
      "decompose with kind:'pr' is not yet supported. Fetch the PR diff with pr_diff and pass it as kind:'diff' to analyze_diff, then drive apply_split manually.",
      false,
    );
  }
  if (target.kind === "diff") {
    throw new UntangleErrorImpl(
      "BAD_INPUT",
      "decompose with kind:'diff' cannot produce branches/PRs. Pass kind:'branch' with { repo, branch, base } instead.",
      false,
    );
  }
  // kind === 'working' — uncommitted changes cannot be materialized as stacked
  // branches because apply_split slices hunks out of `git diff base...branch`,
  // which only sees committed history. Refuse early with a clear path forward.
  throw new UntangleErrorImpl(
    "BAD_INPUT",
    "decompose cannot materialize uncommitted (working-tree) changes as stacked branches. " +
      "Commit your changes first (use git_commit), then re-run decompose with " +
      "{ kind:'branch', repo, branch: <your-branch>, base: <base-branch> }. " +
      "(analyze_diff alone supports kind:'working' for read-only inspection.)",
    false,
  );
}

export interface DecomposeInput {
  target: Target;
  dryRun?: boolean;
  draftPRs?: boolean;
  pushRemote?: string;
  policy?: "codeowners-strict" | "blame-weighted" | "expertise-graph";
  excludeUsers?: string[];
  branchPrefix?: string;
}

export interface DecomposeOutput {
  schemaVersion: "1";
  proposalId: string;
  dryRun: boolean;
  pushed: boolean;
  prsCreated: number;
  /** Top-level human-readable status: tells the user what actually happened. */
  status: string;
  slices: Array<{
    index: number;
    title: string;
    branch: string | null;
    commitSha: string | null;
    prUrl: string | null;
    reviewers: Array<{ login: string; reason: string; weight: number }>;
  }>;
  rolledBack: boolean;
  logs: string[];
}

export async function decompose(input: DecomposeInput): Promise<DecomposeOutput> {
  const {
    dryRun = true,
    draftPRs = true,
    pushRemote = "origin",
    policy = "blame-weighted",
    excludeUsers = [],
    branchPrefix = "untangle/",
  } = input;
  const target = normalizeTarget(input.target);
  // Validate up front so we don't burn an LLM call analyzing a target we can't act on.
  assertApplyableTarget(target);

  // 1. Analyze the diff
  const analysis = await analyzeDiff({ target });

  // 2. Propose the stack proposal plan
  const { proposal } = await proposeSplit({ graph: analysis.graph });

  // 3. Repo path for routing reviewers
  const repo = target.repo;

  // 4. route reviewers for the proposal slices
  const routing = await routeReviewers({
    proposal,
    repo,
    policy,
    excludeUsers,
  }).catch(() => ({ assignments: [] })); // non-fatal fallback

  // 5. Materialize git branches/commits and PRs
  const applyResult = await applySplit({
    proposal,
    target,
    dryRun,
    draftPRs,
    pushRemote,
    branchPrefix,
  });

  const prsCreated = applyResult.created.filter((c) => !!c.prUrl).length;
  const sliceCount = proposal.slices.length;
  const status = dryRun
    ? `DRY-RUN: ${sliceCount} branch(es) created locally only. NO push to ${pushRemote}, NO PRs opened. ` +
      `Re-run with dryRun:false to push and create ${draftPRs ? "draft " : ""}PRs.`
    : `Applied ${sliceCount} slice(s): pushed to ${pushRemote}, ${prsCreated} ${draftPRs ? "draft " : ""}PR(s) opened.`;

  return {
    schemaVersion: "1",
    proposalId: proposal.meta.proposalId,
    dryRun,
    pushed: !dryRun && applyResult.created.length > 0,
    prsCreated,
    status,
    slices: proposal.slices.map((slice, i) => {
      const created = applyResult.created.find((c) => c.sliceId === slice.id);
      const assignment = routing.assignments.find((a) => a.sliceId === slice.id);
      return {
        index: i,
        title: slice.title,
        branch: created?.branch ?? null,
        commitSha: created?.commitSha ?? null,
        prUrl: created?.prUrl ?? null,
        reviewers: assignment?.reviewers ?? [],
      };
    }),
    rolledBack: applyResult.rolledBack,
    logs: applyResult.logs,
  };
}
