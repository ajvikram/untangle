#!/usr/bin/env node
/**
 * CLI entry point — thin wrapper over tools for ad-hoc use.
 */

import { parseArgs } from "node:util";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import { scoreReviewEffort } from "./tools/score-review-effort.js";
import { analyzeDiff } from "./tools/analyze-diff.js";
import { proposeSplit } from "./tools/propose-split.js";
import { applySplit } from "./tools/apply-split.js";
import { routeReviewers } from "./tools/route-reviewers.js";
import { decompose } from "./tools/decompose.js";
import { logger } from "./util/logger.js";
import type { Target } from "./schemas/types.js";

const USAGE = `untangle — MCP-native PR decomposer

Usage:
  untangle score     [--repo path] [--branch name] [--base main]
  untangle analyze   [--repo path] [--branch name] [--base main]
  untangle propose   [--graph json-file]
  untangle apply     [--proposal json-file] [--repo path] [--dry-run]
  untangle route     [--proposal json-file] [--repo path] [--policy name] [--exclude users]
  untangle decompose [--repo path] [--branch name] [--base base] [--dry-run] [--policy name] [--exclude users]
  untangle mcp       (start MCP server — use untangle-mcp instead)
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    process.exit(0);
  }

  try {
    switch (command) {
      case "score": {
        const { values } = parseArgs({
          args: args.slice(1),
          options: {
            repo: { type: "string", default: "." },
            branch: { type: "string", default: "HEAD" },
            base: { type: "string", default: "main" },
            policy: { type: "string", default: "balanced" },
          },
        });
        const target: Target = {
          kind: "branch",
          repo: values.repo!,
          branch: values.branch!,
          base: values.base!,
        };
        const result = await scoreReviewEffort({
          target,
          policy: values.policy as "conservative" | "balanced" | "aggressive",
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "analyze": {
        const { values } = parseArgs({
          args: args.slice(1),
          options: {
            repo: { type: "string", default: "." },
            branch: { type: "string", default: "HEAD" },
            base: { type: "string", default: "main" },
          },
        });
        const target: Target = {
          kind: "branch",
          repo: values.repo!,
          branch: values.branch!,
          base: values.base!,
        };
        const result = await analyzeDiff({ target });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "route": {
        const { values } = parseArgs({
          args: args.slice(1),
          options: {
            proposal: { type: "string" },
            repo: { type: "string", default: "." },
            policy: { type: "string", default: "blame-weighted" },
            exclude: { type: "string", default: "" },
          },
        });
        if (!values.proposal) {
          throw new Error("Missing --proposal JSON file argument");
        }
        const proposalContent = fs.readFileSync(values.proposal, "utf8");
        const proposal = JSON.parse(proposalContent);
        const excludeUsers = values.exclude ? values.exclude.split(",").map(u => u.trim()) : [];
        const result = await routeReviewers({
          proposal,
          repo: values.repo!,
          policy: values.policy as any,
          excludeUsers,
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "propose": {
        const { values } = parseArgs({
          args: args.slice(1),
          options: {
            graph: { type: "string" },
          },
        });
        if (!values.graph) {
          throw new Error("Missing --graph JSON file argument");
        }
        const graphContent = fs.readFileSync(values.graph, "utf8");
        const graph = JSON.parse(graphContent);
        const result = await proposeSplit({ graph });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "apply": {
        const { values } = parseArgs({
          args: args.slice(1),
          options: {
            proposal: { type: "string" },
            repo: { type: "string", default: "." },
            "dry-run": { type: "boolean", default: false },
          },
        });
        if (!values.proposal) {
          throw new Error("Missing --proposal JSON file argument");
        }
        const proposalContent = fs.readFileSync(values.proposal, "utf8");
        const proposal = JSON.parse(proposalContent);
        
        // Resolve current git branch and repo details
        const repoPath = fs.realpathSync(values.repo!);
        const currentBranch = execSync("git branch --show-current", { cwd: repoPath }).toString().trim() || "main";
        
        const result = await applySplit({
          proposal,
          target: {
            kind: "branch",
            repo: repoPath,
            branch: currentBranch,
            base: "main", // default base branch
          },
          dryRun: values["dry-run"],
          draftPRs: true,
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "decompose": {
        const { values } = parseArgs({
          args: args.slice(1),
          options: {
            repo: { type: "string", default: "." },
            branch: { type: "string" },
            base: { type: "string", default: "main" },
            "dry-run": { type: "boolean", default: false },
            policy: { type: "string", default: "blame-weighted" },
            exclude: { type: "string", default: "" },
          },
        });
        const repoPath = fs.realpathSync(values.repo!);
        const currentBranch = values.branch || execSync("git branch --show-current", { cwd: repoPath }).toString().trim() || "main";
        const excludeUsers = values.exclude ? values.exclude.split(",").map(u => u.trim()) : [];
        
        const result = await decompose({
          target: {
            kind: "branch",
            repo: repoPath,
            branch: currentBranch,
            base: values.base!,
          },
          dryRun: values["dry-run"],
          draftPRs: true,
          policy: values.policy as any,
          excludeUsers,
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      default:
        console.error(`Unknown command: ${command}`);
        console.log(USAGE);
        process.exit(1);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("cli_error", { command, error: msg });
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}

main();
