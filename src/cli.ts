#!/usr/bin/env node
/**
 * CLI entry point — thin wrapper over tools for ad-hoc use.
 */

import { parseArgs } from "node:util";
import { scoreReviewEffort } from "./tools/score-review-effort.js";
import { analyzeDiff } from "./tools/analyze-diff.js";
import { logger } from "./util/logger.js";
import type { Target } from "./schemas/types.js";

const USAGE = `untangle — MCP-native PR decomposer

Usage:
  untangle score    [--repo path] [--branch name] [--base main]
  untangle analyze  [--repo path] [--branch name] [--base main]
  untangle propose  [--graph json-file]
  untangle apply    [--proposal json-file] [--repo path] [--dry-run]
  untangle mcp      (start MCP server — use untangle-mcp instead)
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
