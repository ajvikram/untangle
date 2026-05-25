/**
 * Tool: decompose — orchestrate end-to-end git/GitHub analysis and split.
 * Chains analyze_diff -> propose_split -> route_reviewers -> apply_split.
 */

import { analyzeDiff } from "./analyze-diff.js";
import { proposeSplit } from "./propose-split.js";
import { routeReviewers } from "./route-reviewers.js";
import { applySplit } from "./apply-split.js";
import { normalizeTarget } from "../schemas/types.js";
import type { Target } from "../schemas/types.js";

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

  // 1. Analyze the diff
  const analysis = await analyzeDiff({ target });

  // 2. Propose the stack proposal plan
  const { proposal } = await proposeSplit({ graph: analysis.graph });

  // 3. Resolve repo path for routing
  const repo =
    target.kind === "branch" || target.kind === "pr" || target.kind === "working"
      ? target.repo
      : ".";

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

  return {
    schemaVersion: "1",
    proposalId: proposal.meta.proposalId,
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
