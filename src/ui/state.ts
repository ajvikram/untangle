/**
 * In-memory state store for the UI server.
 * Holds recent analyze/propose/apply outputs and emits events for SSE subscribers.
 * Lifetime is the MCP server process — dies with the host.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { ConcernGraph, SplitProposal } from "../schemas/types.js";

export type ActivityKind =
  | "analyze_diff"
  | "propose_split"
  | "apply_split"
  | "score_review_effort"
  | "route_reviewers"
  | "summarize_slice"
  | "decompose"
  | "git_commit"
  | "git_push"
  | "git_checkout"
  | "pr_review"
  | "pr_comment"
  | "pr_merge"
  | "pr_close"
  | "pr_reopen"
  | "pr_ready"
  | "ui_open";

export interface ActivityEntry {
  id: string;
  ts: string;
  kind: ActivityKind;
  summary: string;
  details?: Record<string, unknown>;
  error?: string;
}

export interface ProposalRecord {
  id: string;
  ts: string;
  repo?: string;
  branch?: string;
  base?: string;
  graph?: ConcernGraph;
  proposal?: SplitProposal;
  applied?: {
    ts: string;
    branches: string[];
    prs: Array<{ url: string; sliceId: string }>;
    dryRun: boolean;
  };
}

class StateStore extends EventEmitter {
  readonly sessionId = randomUUID();
  readonly startedAt = new Date().toISOString();

  private proposals = new Map<string, ProposalRecord>();
  private activity: ActivityEntry[] = [];
  private readonly maxActivity = 500;
  private readonly maxProposals = 50;

  recordAnalyze(opts: { repo?: string; branch?: string; base?: string; graph: ConcernGraph }): string {
    const id = randomUUID();
    this.proposals.set(id, {
      id,
      ts: new Date().toISOString(),
      repo: opts.repo,
      branch: opts.branch,
      base: opts.base,
      graph: opts.graph,
    });
    this.trimProposals();
    this.emit("change", { type: "proposal_added", id });
    return id;
  }

  attachProposal(proposalId: string, proposal: SplitProposal): void {
    const rec = this.proposals.get(proposalId);
    if (!rec) return;
    rec.proposal = proposal;
    this.emit("change", { type: "proposal_updated", id: proposalId });
  }

  attachApplyResult(
    proposalId: string,
    result: { branches: string[]; prs: Array<{ url: string; sliceId: string }>; dryRun: boolean },
  ): void {
    const rec = this.proposals.get(proposalId);
    if (!rec) return;
    rec.applied = { ts: new Date().toISOString(), ...result };
    this.emit("change", { type: "proposal_applied", id: proposalId });
  }

  listProposals(): ProposalRecord[] {
    return [...this.proposals.values()].sort((a, b) => b.ts.localeCompare(a.ts));
  }

  getProposal(id: string): ProposalRecord | undefined {
    return this.proposals.get(id);
  }

  logActivity(entry: Omit<ActivityEntry, "id" | "ts">): ActivityEntry {
    const e: ActivityEntry = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      ...entry,
    };
    this.activity.push(e);
    if (this.activity.length > this.maxActivity) {
      this.activity = this.activity.slice(-this.maxActivity);
    }
    this.emit("activity", e);
    return e;
  }

  listActivity(limit = 100): ActivityEntry[] {
    return this.activity.slice(-limit).reverse();
  }

  private trimProposals(): void {
    if (this.proposals.size <= this.maxProposals) return;
    const sorted = [...this.proposals.values()].sort((a, b) => a.ts.localeCompare(b.ts));
    const drop = sorted.slice(0, this.proposals.size - this.maxProposals);
    for (const r of drop) this.proposals.delete(r.id);
  }
}

let _store: StateStore | null = null;
export function getStore(): StateStore {
  if (!_store) _store = new StateStore();
  return _store;
}

/** Test-only: reset the singleton. */
export function _resetStore(): void {
  _store = null;
}
