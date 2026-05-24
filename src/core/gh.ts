/**
 * gh CLI wrapper — GitHub operations.
 * Wraps the `gh` CLI for PR creation and auth checks.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UntangleErrorImpl } from "../schemas/types.js";
import { logger } from "../util/logger.js";

const execFileP = promisify(execFile);

export class GhWrapper {
  constructor(private readonly cwd: string) {}

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
    const start = Date.now();
    const args = [
      "pr", "create",
      "--base", opts.base,
      "--head", opts.head,
      "--title", opts.title,
      "--body", opts.body,
    ];
    if (opts.draft) args.push("--draft");

    try {
      const { stdout } = await execFileP("gh", args, { cwd: this.cwd });
      const url = stdout.trim();
      logger.info("gh_pr_created", { url, durationMs: Date.now() - start });
      return url;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("gh_pr_create_failed", { error: msg });
      throw new UntangleErrorImpl("GH_PR_FAILED", msg, true);
    }
  }

  /** Close a pull request by URL. */
  async closePR(prUrl: string): Promise<void> {
    try {
      await execFileP("gh", ["pr", "close", prUrl], { cwd: this.cwd });
    } catch {
      // Best-effort cleanup
    }
  }

  /** Get diff for a PR. */
  async prDiff(number: number): Promise<string> {
    const { stdout } = await execFileP("gh", ["pr", "diff", String(number)], {
      cwd: this.cwd,
    });
    return stdout;
  }
}
