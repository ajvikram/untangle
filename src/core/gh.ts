/**
 * gh CLI wrapper — GitHub operations.
 * Wraps the `gh` CLI for PR creation, review, merge, comments and other PR ops.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UntangleErrorImpl } from "../schemas/types.js";
import { logger } from "../util/logger.js";

const execFileP = promisify(execFile);

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
export type MergeMethod = "merge" | "squash" | "rebase";
export type PrState = "open" | "closed" | "merged" | "all";

export interface PrSummary {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  author: string;
  baseRef: string;
  headRef: string;
  url: string;
  updatedAt: string;
}

export interface PrDetails extends PrSummary {
  body: string;
  createdAt: string;
  mergedAt: string | null;
  reviewDecision: string | null;
  mergeable: string | null;
  labels: string[];
  assignees: string[];
  reviewers: string[];
  checks: Array<{ name: string; status: string; conclusion: string | null }>;
}

export class GhWrapper {
  constructor(private readonly cwd: string) {}

  /** Pass-through to `gh` CLI returning trimmed stdout. */
  private async gh(args: string[], stdin?: string): Promise<string> {
    const start = Date.now();
    try {
      const child = execFile("gh", args, { cwd: this.cwd });
      if (stdin !== undefined && child.stdin) {
        child.stdin.write(stdin);
        child.stdin.end();
      }
      const result = await new Promise<string>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (d) => (stdout += d.toString()));
        child.stderr?.on("data", (d) => (stderr += d.toString()));
        child.on("close", (code) => {
          if (code === 0) resolve(stdout);
          else reject(new Error(stderr || `gh exited with code ${code}`));
        });
        child.on("error", reject);
      });
      logger.info("gh_op", { args: args.slice(0, 3), durationMs: Date.now() - start });
      return result.trim();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("gh_op_failed", { args: args.slice(0, 3), error: msg });
      throw err;
    }
  }

  /** Check that `gh` is authenticated. Throws GH_AUTH if not. */
  async assertAuth(): Promise<void> {
    try {
      await execFileP("gh", ["auth", "status"], { cwd: this.cwd });
    } catch {
      throw new UntangleErrorImpl(
        "GH_AUTH",
        "GitHub CLI (gh) is not authenticated — run `gh auth login`",
        true,
      );
    }
  }

  /** Create a pull request. Returns the PR URL. */
  async createPR(opts: {
    base: string;
    head: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<string> {
    const args = [
      "pr", "create",
      "--base", opts.base,
      "--head", opts.head,
      "--title", opts.title,
      "--body", opts.body,
    ];
    if (opts.draft) args.push("--draft");

    try {
      const out = await this.gh(args);
      logger.info("gh_pr_created", { url: out });
      return out;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new UntangleErrorImpl("GH_PR_FAILED", msg, true);
    }
  }

  /** Close a pull request by URL or number. */
  async closePR(prRef: string | number): Promise<void> {
    try {
      await this.gh(["pr", "close", String(prRef)]);
    } catch (err: unknown) {
      throw new UntangleErrorImpl(
        "GH_PR_CLOSE_FAILED",
        err instanceof Error ? err.message : String(err),
        true,
      );
    }
  }

  /** Reopen a closed PR. */
  async reopenPR(prRef: string | number): Promise<void> {
    try {
      await this.gh(["pr", "reopen", String(prRef)]);
    } catch (err: unknown) {
      throw new UntangleErrorImpl(
        "GH_PR_REOPEN_FAILED",
        err instanceof Error ? err.message : String(err),
        true,
      );
    }
  }

  /** Get the raw diff for a PR. */
  async prDiff(prRef: string | number): Promise<string> {
    return this.gh(["pr", "diff", String(prRef)]);
  }

  /** List PRs. */
  async listPRs(opts: {
    state?: PrState;
    base?: string;
    head?: string;
    author?: string;
    limit?: number;
    search?: string;
  } = {}): Promise<PrSummary[]> {
    const args = ["pr", "list", "--json", "number,title,state,isDraft,author,baseRefName,headRefName,url,updatedAt"];
    if (opts.state) args.push("--state", opts.state);
    if (opts.base) args.push("--base", opts.base);
    if (opts.head) args.push("--head", opts.head);
    if (opts.author) args.push("--author", opts.author);
    if (opts.limit) args.push("--limit", String(opts.limit));
    if (opts.search) args.push("--search", opts.search);
    const out = await this.gh(args);
    if (!out) return [];
    const parsed = JSON.parse(out) as Array<{
      number: number;
      title: string;
      state: string;
      isDraft: boolean;
      author: { login: string };
      baseRefName: string;
      headRefName: string;
      url: string;
      updatedAt: string;
    }>;
    return parsed.map((p) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      isDraft: p.isDraft,
      author: p.author?.login ?? "",
      baseRef: p.baseRefName,
      headRef: p.headRefName,
      url: p.url,
      updatedAt: p.updatedAt,
    }));
  }

  /** Get full PR details. */
  async viewPR(prRef: string | number): Promise<PrDetails> {
    const fields = [
      "number", "title", "state", "isDraft", "author",
      "baseRefName", "headRefName", "url", "updatedAt",
      "body", "createdAt", "mergedAt", "reviewDecision",
      "mergeable", "labels", "assignees", "reviewRequests",
      "statusCheckRollup",
    ].join(",");
    const out = await this.gh(["pr", "view", String(prRef), "--json", fields]);
    const p = JSON.parse(out) as {
      number: number;
      title: string;
      state: string;
      isDraft: boolean;
      author: { login: string };
      baseRefName: string;
      headRefName: string;
      url: string;
      updatedAt: string;
      body: string;
      createdAt: string;
      mergedAt: string | null;
      reviewDecision: string | null;
      mergeable: string | null;
      labels: Array<{ name: string }>;
      assignees: Array<{ login: string }>;
      reviewRequests: Array<{ login?: string; name?: string }>;
      statusCheckRollup: Array<{ name?: string; context?: string; status?: string; state?: string; conclusion?: string | null }>;
    };
    return {
      number: p.number,
      title: p.title,
      state: p.state,
      isDraft: p.isDraft,
      author: p.author?.login ?? "",
      baseRef: p.baseRefName,
      headRef: p.headRefName,
      url: p.url,
      updatedAt: p.updatedAt,
      body: p.body,
      createdAt: p.createdAt,
      mergedAt: p.mergedAt,
      reviewDecision: p.reviewDecision,
      mergeable: p.mergeable,
      labels: (p.labels ?? []).map((l) => l.name),
      assignees: (p.assignees ?? []).map((a) => a.login),
      reviewers: (p.reviewRequests ?? []).map((r) => r.login ?? r.name ?? "").filter(Boolean),
      checks: (p.statusCheckRollup ?? []).map((c) => ({
        name: c.name ?? c.context ?? "",
        status: c.status ?? c.state ?? "",
        conclusion: c.conclusion ?? null,
      })),
    };
  }

  /** Get check runs for a PR. */
  async prChecks(prRef: string | number): Promise<Array<{ name: string; status: string; conclusion: string | null; link?: string }>> {
    const out = await this.gh(["pr", "view", String(prRef), "--json", "statusCheckRollup"]);
    const parsed = JSON.parse(out) as {
      statusCheckRollup: Array<{ name?: string; context?: string; status?: string; state?: string; conclusion?: string | null; detailsUrl?: string; targetUrl?: string }>;
    };
    return (parsed.statusCheckRollup ?? []).map((c) => ({
      name: c.name ?? c.context ?? "",
      status: c.status ?? c.state ?? "",
      conclusion: c.conclusion ?? null,
      link: c.detailsUrl ?? c.targetUrl,
    }));
  }

  /** Submit a review (approve / request changes / comment). */
  async reviewPR(prRef: string | number, opts: { event: ReviewEvent; body?: string }): Promise<void> {
    const args = ["pr", "review", String(prRef)];
    if (opts.event === "APPROVE") args.push("--approve");
    else if (opts.event === "REQUEST_CHANGES") args.push("--request-changes");
    else args.push("--comment");
    if (opts.body) args.push("--body", opts.body);
    try {
      await this.gh(args);
      logger.info("gh_pr_review", { prRef: String(prRef), event: opts.event });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new UntangleErrorImpl("GH_PR_REVIEW_FAILED", msg, true);
    }
  }

  /** Post a comment on a PR (issue-level, not a review). */
  async commentPR(prRef: string | number, body: string): Promise<void> {
    try {
      await this.gh(["pr", "comment", String(prRef), "--body", body]);
      logger.info("gh_pr_comment", { prRef: String(prRef) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new UntangleErrorImpl("GH_PR_COMMENT_FAILED", msg, true);
    }
  }

  /** Merge a PR using one of merge|squash|rebase. */
  async mergePR(
    prRef: string | number,
    opts: {
      method?: MergeMethod;
      deleteBranch?: boolean;
      adminOverride?: boolean;
      auto?: boolean;
      matchSha?: string;
      body?: string;
    } = {},
  ): Promise<void> {
    const args = ["pr", "merge", String(prRef)];
    const method = opts.method ?? "merge";
    if (method === "merge") args.push("--merge");
    else if (method === "squash") args.push("--squash");
    else args.push("--rebase");
    if (opts.deleteBranch) args.push("--delete-branch");
    if (opts.adminOverride) args.push("--admin");
    if (opts.auto) args.push("--auto");
    if (opts.matchSha) args.push("--match-head-commit", opts.matchSha);
    if (opts.body) args.push("--body", opts.body);
    try {
      await this.gh(args);
      logger.info("gh_pr_merged", { prRef: String(prRef), method });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new UntangleErrorImpl("GH_PR_MERGE_FAILED", msg, true);
    }
  }

  /** Mark a draft PR as ready for review. */
  async markReady(prRef: string | number): Promise<void> {
    try {
      await this.gh(["pr", "ready", String(prRef)]);
      logger.info("gh_pr_ready", { prRef: String(prRef) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new UntangleErrorImpl("GH_PR_READY_FAILED", msg, true);
    }
  }

  /** Dismiss a submitted review on a PR. Uses the GitHub REST API via `gh api`. */
  async dismissReview(prRef: string | number, reviewId: string | number, message: string): Promise<void> {
    // Resolve repo nwo (owner/repo) via gh repo view
    let nwo: string;
    try {
      const repoOut = await this.gh(["repo", "view", "--json", "nameWithOwner"]);
      nwo = (JSON.parse(repoOut) as { nameWithOwner: string }).nameWithOwner;
    } catch (err: unknown) {
      throw new UntangleErrorImpl(
        "GH_REPO_LOOKUP_FAILED",
        err instanceof Error ? err.message : String(err),
        true,
      );
    }
    try {
      await this.gh([
        "api", "--method", "PUT",
        `/repos/${nwo}/pulls/${prRef}/reviews/${reviewId}/dismissals`,
        "-f", `message=${message}`,
      ]);
      logger.info("gh_pr_review_dismissed", { prRef: String(prRef), reviewId: String(reviewId) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new UntangleErrorImpl("GH_PR_REVIEW_DISMISS_FAILED", msg, true);
    }
  }

  /** Request reviewers on a PR. */
  async requestReviewers(prRef: string | number, reviewers: string[], teamReviewers: string[] = []): Promise<void> {
    const args = ["pr", "edit", String(prRef)];
    for (const r of reviewers) args.push("--add-reviewer", r);
    for (const t of teamReviewers) args.push("--add-reviewer", t);
    try {
      await this.gh(args);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new UntangleErrorImpl("GH_PR_REVIEWER_REQUEST_FAILED", msg, true);
    }
  }
}
