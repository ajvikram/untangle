/**
 * Tool: decompose — orchestrate end-to-end git/GitHub analysis and split.
 * Chains analyze_diff -> propose_split -> route_reviewers -> apply_split.
 */

import { analyzeDiff } from "./analyze-diff.js";
import { proposeSplit } from "./propose-split.js";
import { routeReviewers } from "./route-reviewers.js";
import { applySplit } from "./apply-split.js";
import { GitWrapper } from "../core/git.js";
import { normalizeTarget, UntangleErrorImpl } from "../schemas/types.js";
import type { Target } from "../schemas/types.js";

/**
 * If the target is kind:'working' and the tree is dirty, auto-commit everything
 * to the current branch and return a kind:'branch' target so apply_split can run.
 * Avoids asking the user to manually commit before every decompose.
 */
async function resolveToCommittedTarget(
  target: Target,
  base: string,
): Promise<Extract<Target, { kind: "branch" }>> {
  if (target.kind === "branch") return target;

  if (target.kind === "pr") {
    throw new UntangleErrorImpl(
      "NOT_IMPLEMENTED",
      "decompose with kind:'pr' is not yet supported. Use pr_diff to fetch the diff, pass it as kind:'diff' to analyze_diff, then call apply_split manually.",
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

  // kind === 'working': auto-commit any pending changes to the current branch
  const git = new GitWrapper(target.repo);
  const branch = await git.currentBranch();
  if (!branch) {
    throw new UntangleErrorImpl(
      "BAD_INPUT",
      "decompose requires a branch — detached HEAD is not supported. Check out a branch first.",
      false,
    );
  }

  const status = await git.status();
  const hasPending = !status.clean;
  if (hasPending) {
    await git.addAll();
    await git.commit("wip: auto-commit for decompose");
  }

  return { kind: "branch", repo: target.repo, branch, base };
}

export interface DecomposeInput {
  target: Target;
  base?: string;
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
    base = "main",
    dryRun = true,
    draftPRs = true,
    pushRemote = "origin",
    policy = "blame-weighted",
    excludeUsers = [],
    branchPrefix = "untangle/",
  } = input;

  // Auto-commit uncommitted changes and resolve to a branch target.
  // This removes the need for callers to manually commit before calling decompose.
  const target = await resolveToCommittedTarget(normalizeTarget(input.target), base);

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
