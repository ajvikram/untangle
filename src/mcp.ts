#!/usr/bin/env node
/**
 * MCP server entry point for untangle.
 * Exposes decomposition tools plus a rich git + GitHub PR operations surface.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  instrumentedScoreReviewEffort as scoreReviewEffort,
  instrumentedAnalyzeDiff as analyzeDiff,
  instrumentedProposeSplit as proposeSplit,
  instrumentedApplySplit as applySplit,
  instrumentedSummarizeSlice as summarizeSlice,
  instrumentedRouteReviewers as routeReviewers,
  instrumentedDecompose as decompose,
} from "./ui/instrument.js";
import {
  gitStatus, gitDiff, gitLog, gitShow, gitBranch,
  gitCommit, gitPush, gitCheckout,
  gitStash, gitStashPop, gitStashList, gitStashDrop,
} from "./tools/git-ops.js";
import {
  prList, prView, prDiff, prChecks,
  prReview, prComment, prReviewDismiss, prRequestReviewers,
  prMerge, prReady, prClose, prReopen, prCreate, ghAuthStatus,
} from "./tools/pr-ops.js";
import { startUiServer } from "./ui/server.js";
import { uiOpen, registerUiServer } from "./tools/ui-open.js";
import { flushPendingState } from "./ui/persist.js";
import { registerMcpServer } from "./llm/client.js";
import { registerServerForWorkspace, discoverWorkspaceRoot } from "./util/workspace.js";
import { logger } from "./util/logger.js";

const server = new Server(
  { name: "untangle", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

registerMcpServer(server);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // -----------------------------------------------------------------------
    // Decomposition tools
    // -----------------------------------------------------------------------
    {
      name: "score_review_effort",
      description: "Circuit Breaker — predict review effort from static signals. Returns shouldDecompose.",
      inputSchema: {
        type: "object" as const,
        properties: {
          target: { type: "object", description: "Target to score (branch, diff, or PR)" },
          threshold: { type: "number" },
          policy: { type: "string", enum: ["conservative", "balanced", "aggressive"] },
        },
        required: ["target"],
      },
    },
    {
      name: "analyze_diff",
      description: "Parse a diff into a ConcernGraph (DAG of concerns).",
      inputSchema: {
        type: "object" as const,
        properties: {
          target: { type: "object" },
          languages: {},
          includeCommitMessages: { type: "boolean" },
          model: { type: "string" },
          maxHunksPerCall: { type: "number" },
        },
        required: ["target"],
      },
    },
    {
      name: "propose_split",
      description: "Plan a stack of slices from a ConcernGraph.",
      inputSchema: {
        type: "object" as const,
        properties: {
          graph: { type: "object" },
          maxConcernsPerSlice: { type: "number" },
          maxLocPerSlice: { type: "number" },
          stackStrategy: { type: "string" },
          riskScore: { type: "number" },
          riskThreshold: { type: "number" },
        },
        required: ["graph"],
      },
    },
    {
      name: "apply_split",
      description: "Materialize a SplitProposal as git commits and branches (atomic, reversible). REQUIRES target.kind:'branch' with a clean working tree — if you have uncommitted changes use `decompose` instead, or commit first then call this.",
      inputSchema: {
        type: "object" as const,
        properties: {
          proposal: { type: "object" },
          target: { type: "object" },
          dryRun: { type: "boolean" },
          draftPRs: { type: "boolean" },
          branchPrefix: { type: "string" },
        },
        required: ["proposal", "target"],
      },
    },
    {
      name: "summarize_slice",
      description: "Generate a reviewer-ready PR title and body for a slice.",
      inputSchema: {
        type: "object" as const,
        properties: {
          slice: { type: "object" },
          graph: { type: "object" },
          specSource: { type: "string" },
          style: { type: "string" },
        },
        required: ["slice", "graph"],
      },
    },
    {
      name: "route_reviewers",
      description: "Map stacked slices to suggested reviewers using CODEOWNERS and git blame.",
      inputSchema: {
        type: "object" as const,
        properties: {
          proposal: { type: "object", description: "Split proposal containing slices" },
          repo: { type: "string", description: "Local path to the git repository" },
          policy: { type: "string", enum: ["codeowners-strict", "blame-weighted", "expertise-graph"] },
          maxReviewersPerSlice: { type: "number" },
          excludeUsers: { type: "array", items: { type: "string" } },
        },
        required: ["proposal", "repo"],
      },
    },
    {
      name: "decompose",
      description: "PREFERRED entry point. Decompose changes end-to-end: analyze, propose slices, find reviewers, materialize stacked branches/PRs. Pass target: { kind:'branch', repo, branch, base } against a committed feature branch (clean tree). IMPORTANT: dryRun defaults to TRUE — branches are created LOCALLY ONLY, nothing is pushed and NO PRs are opened. Pass dryRun:false to actually push + open PRs. The response includes `dryRun`, `pushed`, `prsCreated`, and `status` fields so you can verify what happened.",
      inputSchema: {
        type: "object" as const,
        properties: {
          target: { type: "object" },
          dryRun: { type: "boolean" },
          draftPRs: { type: "boolean" },
          pushRemote: { type: "string" },
          policy: { type: "string", enum: ["codeowners-strict", "blame-weighted", "expertise-graph"] },
          excludeUsers: { type: "array", items: { type: "string" } },
        },
        required: ["target"],
      },
    },
    {
      name: "git_stash",
      description: "Stash uncommitted changes. Returns the created stash ref (e.g. 'stash@{0}').",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          message: { type: "string" },
          includeUntracked: { type: "boolean" },
          keepIndex: { type: "boolean" },
        },
      },
    },
    {
      name: "git_stash_list",
      description: "List stashes in the repo.",
      inputSchema: { type: "object" as const, properties: { repo: { type: "string" } } },
    },
    {
      name: "git_stash_pop",
      description: "Pop a stash (apply and drop). Pass `apply:true` to apply without dropping.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          ref: { type: "string", description: "Stash ref like 'stash@{0}' (default: top of stack)" },
          apply: { type: "boolean", description: "Apply but don't drop the stash" },
        },
      },
    },
    {
      name: "git_stash_drop",
      description: "Drop a stash without applying it.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          ref: { type: "string" },
        },
      },
    },
    {
      name: "pr_create",
      description: "Create a new pull request from `head` to `base`. Pass `draft:true` for a draft PR.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          base: { type: "string" },
          head: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          draft: { type: "boolean" },
        },
        required: ["base", "head", "title"],
      },
    },
    {
      name: "gh_auth_status",
      description: "Check whether the GitHub CLI (`gh`) is authenticated. Use this before PR ops to diagnose auth failures.",
      inputSchema: { type: "object" as const, properties: { repo: { type: "string" } } },
    },
    {
      name: "ui_open",
      description: "Return the local URL of the embedded untangle dashboard (concern graph + PR/git actions). Pass `path` to deep-link, e.g. /proposals/abc.",
      inputSchema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Optional in-app path to deep-link to" },
        },
      },
    },

    // -----------------------------------------------------------------------
    // Git introspection
    // -----------------------------------------------------------------------
    {
      name: "git_status",
      description: "Get structured working-tree status (branch, ahead/behind, staged/modified/untracked).",
      inputSchema: {
        type: "object" as const,
        properties: { repo: { type: "string", description: "Path to repo (default: '.')" } },
      },
    },
    {
      name: "git_diff",
      description: "Get a git diff. Modes: working (unstaged), staged, head (working+staged vs HEAD), range (base...head).",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          mode: { type: "string", enum: ["working", "staged", "head", "range"] },
          base: { type: "string", description: "For mode=range" },
          head: { type: "string", description: "For mode=range" },
          paths: { type: "array", items: { type: "string" }, description: "Limit diff to specific paths" },
        },
      },
    },
    {
      name: "git_log",
      description: "Get commit history. Returns an array of {sha, author, email, date, subject, body}.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          maxCount: { type: "number", description: "Default 20" },
          range: { type: "string", description: "e.g. 'main..HEAD' or a ref" },
          paths: { type: "array", items: { type: "string" } },
        },
      },
    },
    {
      name: "git_show",
      description: "Show a commit / ref. Optionally just stat or name-only.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          ref: { type: "string" },
          stat: { type: "boolean" },
          nameOnly: { type: "boolean" },
          format: { type: "string", enum: ["full", "patch"] },
        },
        required: ["ref"],
      },
    },
    {
      name: "git_branch",
      description: "List branches and current branch. Set includeRemote:true to include remote-tracking refs.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          includeRemote: { type: "boolean" },
        },
      },
    },

    // -----------------------------------------------------------------------
    // Git mutations
    // -----------------------------------------------------------------------
    {
      name: "git_commit",
      description: "Create a commit. Optionally stage paths first (paths) or stage everything (addAll). Supports dryRun.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          message: { type: "string" },
          paths: { type: "array", items: { type: "string" } },
          addAll: { type: "boolean" },
          trailers: { type: "object" },
          dryRun: { type: "boolean" },
        },
        required: ["message"],
      },
    },
    {
      name: "git_push",
      description: "Push current (or named) branch to remote with --force-with-lease. Refuses protected refs (main/master/develop/production/release) unless protectRefs is overridden. Supports dryRun.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          remote: { type: "string", description: "Default 'origin'" },
          branch: { type: "string", description: "Default: current branch" },
          protectRefs: { type: "array", items: { type: "string" }, description: "Override the protected-refs list" },
          dryRun: { type: "boolean" },
        },
      },
    },
    {
      name: "git_checkout",
      description: "Checkout a ref. Set createBranch:true (with optional 'from') to create a new branch.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          ref: { type: "string" },
          createBranch: { type: "boolean" },
          from: { type: "string", description: "Source ref for createBranch (default: HEAD)" },
          dryRun: { type: "boolean" },
        },
        required: ["ref"],
      },
    },

    // -----------------------------------------------------------------------
    // GitHub PR introspection
    // -----------------------------------------------------------------------
    {
      name: "pr_list",
      description: "List pull requests via gh CLI. Filter by state/base/head/author/search.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          state: { type: "string", enum: ["open", "closed", "merged", "all"] },
          base: { type: "string" },
          head: { type: "string" },
          author: { type: "string" },
          limit: { type: "number", description: "Default 30" },
          search: { type: "string", description: "GitHub search qualifier" },
        },
      },
    },
    {
      name: "pr_view",
      description: "Get full PR details (state, body, labels, reviewers, checks, mergeable status).",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          number: { type: "number" },
        },
        required: ["number"],
      },
    },
    {
      name: "pr_diff",
      description: "Get the raw unified diff for a PR.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          number: { type: "number" },
        },
        required: ["number"],
      },
    },
    {
      name: "pr_checks",
      description: "Get the check runs and an aggregated success/failure/pending summary for a PR.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          number: { type: "number" },
        },
        required: ["number"],
      },
    },

    // -----------------------------------------------------------------------
    // PR review / approval / comment
    // -----------------------------------------------------------------------
    {
      name: "pr_review",
      description: "Submit a PR review: APPROVE, REQUEST_CHANGES (requires body), or COMMENT.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          number: { type: "number" },
          event: { type: "string", enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"] },
          body: { type: "string" },
        },
        required: ["number", "event"],
      },
    },
    {
      name: "pr_comment",
      description: "Post an issue-level (non-review) comment on a PR.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          number: { type: "number" },
          body: { type: "string" },
        },
        required: ["number", "body"],
      },
    },
    {
      name: "pr_review_dismiss",
      description: "Dismiss a submitted PR review (requires a message).",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          number: { type: "number" },
          reviewId: { type: "number" },
          message: { type: "string" },
        },
        required: ["number", "reviewId", "message"],
      },
    },
    {
      name: "pr_request_reviewers",
      description: "Request reviewers on a PR (user logins and/or team slugs).",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          number: { type: "number" },
          reviewers: { type: "array", items: { type: "string" } },
          teamReviewers: { type: "array", items: { type: "string" } },
        },
        required: ["number"],
      },
    },

    // -----------------------------------------------------------------------
    // PR merge / ready / close / reopen
    // -----------------------------------------------------------------------
    {
      name: "pr_merge",
      description: "Merge a PR (merge/squash/rebase). Refuses protected bases (main/master/develop/production/release) unless confirmProtectedBase:true. Supports dryRun.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          number: { type: "number" },
          method: { type: "string", enum: ["merge", "squash", "rebase"] },
          deleteBranch: { type: "boolean" },
          adminOverride: { type: "boolean", description: "Pass --admin to bypass required reviews" },
          auto: { type: "boolean", description: "Enable auto-merge once checks pass" },
          matchSha: { type: "string", description: "Refuse merge unless head matches this sha" },
          body: { type: "string" },
          confirmProtectedBase: { type: "boolean" },
          dryRun: { type: "boolean" },
        },
        required: ["number"],
      },
    },
    {
      name: "pr_ready",
      description: "Mark a draft PR as ready for review.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          number: { type: "number" },
        },
        required: ["number"],
      },
    },
    {
      name: "pr_close",
      description: "Close a PR without merging. Supports dryRun.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          number: { type: "number" },
          dryRun: { type: "boolean" },
        },
        required: ["number"],
      },
    },
    {
      name: "pr_reopen",
      description: "Reopen a closed (non-merged) PR.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string" },
          number: { type: "number" },
        },
        required: ["number"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result: unknown;
    switch (name) {
      // Decomposition
      case "score_review_effort": result = await scoreReviewEffort(args as unknown as Parameters<typeof scoreReviewEffort>[0]); break;
      case "analyze_diff":        result = await analyzeDiff(args as unknown as Parameters<typeof analyzeDiff>[0]); break;
      case "propose_split":       result = await proposeSplit(args as unknown as Parameters<typeof proposeSplit>[0]); break;
      case "apply_split":         result = await applySplit(args as unknown as Parameters<typeof applySplit>[0]); break;
      case "summarize_slice":     result = await summarizeSlice(args as unknown as Parameters<typeof summarizeSlice>[0]); break;
      case "route_reviewers":     result = await routeReviewers(args as unknown as Parameters<typeof routeReviewers>[0]); break;
      case "decompose":           result = await decompose(args as unknown as Parameters<typeof decompose>[0]); break;

      // Git introspection
      case "git_status":   result = await gitStatus(args as unknown as Parameters<typeof gitStatus>[0]); break;
      case "git_diff":     result = await gitDiff(args as unknown as Parameters<typeof gitDiff>[0]); break;
      case "git_log":      result = await gitLog(args as unknown as Parameters<typeof gitLog>[0]); break;
      case "git_show":     result = await gitShow(args as unknown as Parameters<typeof gitShow>[0]); break;
      case "git_branch":   result = await gitBranch(args as unknown as Parameters<typeof gitBranch>[0]); break;

      // Git mutations
      case "git_commit":   result = await gitCommit(args as unknown as Parameters<typeof gitCommit>[0]); break;
      case "git_push":     result = await gitPush(args as unknown as Parameters<typeof gitPush>[0]); break;
      case "git_checkout": result = await gitCheckout(args as unknown as Parameters<typeof gitCheckout>[0]); break;
      case "git_stash":      result = await gitStash(args as unknown as Parameters<typeof gitStash>[0]); break;
      case "git_stash_list": result = await gitStashList(args as unknown as Parameters<typeof gitStashList>[0]); break;
      case "git_stash_pop":  result = await gitStashPop(args as unknown as Parameters<typeof gitStashPop>[0]); break;
      case "git_stash_drop": result = await gitStashDrop(args as unknown as Parameters<typeof gitStashDrop>[0]); break;

      // PR introspection
      case "pr_list":   result = await prList(args as unknown as Parameters<typeof prList>[0]); break;
      case "pr_view":   result = await prView(args as unknown as Parameters<typeof prView>[0]); break;
      case "pr_diff":   result = await prDiff(args as unknown as Parameters<typeof prDiff>[0]); break;
      case "pr_checks": result = await prChecks(args as unknown as Parameters<typeof prChecks>[0]); break;

      // PR review / comment
      case "pr_review":            result = await prReview(args as unknown as Parameters<typeof prReview>[0]); break;
      case "pr_comment":           result = await prComment(args as unknown as Parameters<typeof prComment>[0]); break;
      case "pr_review_dismiss":    result = await prReviewDismiss(args as unknown as Parameters<typeof prReviewDismiss>[0]); break;
      case "pr_request_reviewers": result = await prRequestReviewers(args as unknown as Parameters<typeof prRequestReviewers>[0]); break;

      // PR merge / lifecycle
      case "pr_merge":  result = await prMerge(args as unknown as Parameters<typeof prMerge>[0]); break;
      case "pr_ready":  result = await prReady(args as unknown as Parameters<typeof prReady>[0]); break;
      case "pr_close":  result = await prClose(args as unknown as Parameters<typeof prClose>[0]); break;
      case "pr_reopen": result = await prReopen(args as unknown as Parameters<typeof prReopen>[0]); break;
      case "pr_create": result = await prCreate(args as unknown as Parameters<typeof prCreate>[0]); break;

      // gh
      case "gh_auth_status": result = await ghAuthStatus(args as unknown as Parameters<typeof ghAuthStatus>[0]); break;

      // UI
      case "ui_open":   result = await uiOpen(args as unknown as Parameters<typeof uiOpen>[0]); break;

      default:
        return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }], isError: true };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("tool_error", { tool: name, error: msg });
    return { content: [{ type: "text" as const, text: msg }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Register the MCP server so the workspace helper can call roots/list,
  // then warm the cache. Failures are silently ignored (host may not
  // implement roots) — discovery falls back to .git walk-up from cwd.
  registerServerForWorkspace(server);
  void discoverWorkspaceRoot().then((ws) => {
    logger.info("workspace_resolved", { workspace: ws });
  });

  // Start the embedded UI HTTP server unless disabled.
  // Set UNTANGLE_UI=0 to opt out.
  const uiEnabled = process.env.UNTANGLE_UI !== "0";
  if (uiEnabled) {
    try {
      const ui = await startUiServer({ logUrl: true });
      registerUiServer({ url: ui.url, port: ui.port, token: ui.token, staticRoot: ui.staticRoot });
      const shutdown = async (): Promise<void> => {
        flushPendingState();           // sync — must run before process exit
        await ui.stop().catch(() => {});
      };
      process.on("SIGINT",  () => { void shutdown().then(() => process.exit(0)); });
      process.on("SIGTERM", () => { void shutdown().then(() => process.exit(0)); });
      process.on("beforeExit", () => flushPendingState());
      transport.onclose = () => { void shutdown(); };
    } catch (err) {
      logger.warn("ui_server_failed_to_start", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  logger.info("server_started", { transport: "stdio", ui: uiEnabled });
}

main().catch((err) => {
  logger.error("server_fatal", { error: String(err) });
  process.exit(1);
});
