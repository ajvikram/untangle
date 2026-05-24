#!/usr/bin/env node
/**
 * MCP server entry point for untangle.
 * Exposes 5 tools via the Model Context Protocol.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { scoreReviewEffort } from "./tools/score-review-effort.js";
import { analyzeDiff } from "./tools/analyze-diff.js";
import { proposeSplit } from "./tools/propose-split.js";
import { applySplit } from "./tools/apply-split.js";
import { summarizeSlice } from "./tools/summarize-slice.js";
import { routeReviewers } from "./tools/route-reviewers.js";
import { decompose } from "./tools/decompose.js";
import { registerMcpServer } from "./llm/client.js";
import { logger } from "./util/logger.js";

const server = new Server(
  { name: "untangle", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

registerMcpServer(server);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
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
      description: "Materialize a SplitProposal as git commits and branches (atomic, reversible).",
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
          policy: { type: "string", enum: ["codeowners-strict", "blame-weighted", "expertise-graph"], description: "Routing policy" },
          maxReviewersPerSlice: { type: "number", description: "Maximum reviewers suggested per slice" },
          excludeUsers: { type: "array", items: { type: "string" }, description: "User logins to exclude from suggestions" },
        },
        required: ["proposal", "repo"],
      },
    },
    {
      name: "decompose",
      description: "Decompose changes end-to-end: analyze, propose slices, find reviewers, and materialize stacked branches/PRs.",
      inputSchema: {
        type: "object" as const,
        properties: {
          target: { type: "object", description: "Target branch details (repo, branch, base)" },
          dryRun: { type: "boolean", description: "Simulate and create branches locally only, do not push to remote or create PRs" },
          draftPRs: { type: "boolean", description: "Create pull requests as draft (default: true)" },
          pushRemote: { type: "string", description: "Git remote name (default: origin)" },
          policy: { type: "string", enum: ["codeowners-strict", "blame-weighted", "expertise-graph"], description: "Reviewer assignment routing policy" },
          excludeUsers: { type: "array", items: { type: "string" }, description: "Exclude specific reviewer usernames" },
        },
        required: ["target"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result: unknown;
    switch (name) {
      case "score_review_effort":
        result = await scoreReviewEffort(args as unknown as Parameters<typeof scoreReviewEffort>[0]);
        break;
      case "analyze_diff":
        result = await analyzeDiff(args as unknown as Parameters<typeof analyzeDiff>[0]);
        break;
      case "propose_split":
        result = await proposeSplit(args as unknown as Parameters<typeof proposeSplit>[0]);
        break;
      case "apply_split":
        result = await applySplit(args as unknown as Parameters<typeof applySplit>[0]);
        break;
      case "summarize_slice":
        result = await summarizeSlice(args as unknown as Parameters<typeof summarizeSlice>[0]);
        break;
      case "route_reviewers":
        result = await routeReviewers(args as unknown as Parameters<typeof routeReviewers>[0]);
        break;
      case "decompose":
        result = await decompose(args as unknown as Parameters<typeof decompose>[0]);
        break;
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
  logger.info("server_started", { transport: "stdio" });
}

main().catch((err) => {
  logger.error("server_fatal", { error: String(err) });
  process.exit(1);
});
