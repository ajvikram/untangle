/**
 * Git wrapper with safety rails.
 * §S2: never force-push to the original branch.
 * §S3: never push without --force-with-lease.
 * §S10: assert clean working tree before ops.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UntangleErrorImpl } from "../schemas/types.js";
import { logger } from "../util/logger.js";

const execFileP = promisify(execFile);

export class GitWrapper {
  constructor(private readonly cwd: string) {}

  /** Execute a git command and return stdout. */
  private async git(args: string[]): Promise<string> {
    const start = Date.now();
    try {
      const { stdout } = await execFileP("git", args, { cwd: this.cwd });
      logger.info("git_op", { args: args.slice(0, 3), durationMs: Date.now() - start });
      return stdout.trim();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("git_op_failed", { args: args.slice(0, 3), error: msg });
      throw err;
    }
  }

  /** Assert the working tree is clean. Throws GIT_DIRTY if not. */
  async assertClean(): Promise<void> {
    const status = await this.git(["status", "--porcelain"]);
    if (status.length > 0) {
      throw new UntangleErrorImpl(
        "GIT_DIRTY",
        "Working tree is not clean — commit or stash changes first",
        false,
        { files: status.split("\n").slice(0, 10) },
      );
    }
  }

  /** Get current HEAD sha. */
  async currentSha(): Promise<string> {
    return this.git(["rev-parse", "HEAD"]);
  }

  /** Get diff between two refs. */
  async diff(base: string, head: string): Promise<string> {
    return this.git(["diff", `${base}...${head}`]);
  }

  /** Get diff of current working tree against HEAD. */
  async diffHead(): Promise<string> {
    return this.git(["diff", "HEAD"]);
  }

  /** Create and checkout a new branch from a base. */
  async checkoutNewBranch(name: string, from: string): Promise<void> {
    await this.git(["checkout", "-B", name, from]);
  }

  /** Checkout an existing ref. */
  async checkout(ref: string): Promise<void> {
    await this.git(["checkout", ref]);
  }

  /** Stage all changes. */
  async addAll(): Promise<void> {
    await this.git(["add", "-A"]);
  }

  /** Commit with message and optional trailers. */
  async commit(
    message: string,
    trailers?: Record<string, string>,
  ): Promise<string> {
    const args = ["commit", "-m", message, "--allow-empty"];
    if (trailers) {
      for (const [key, value] of Object.entries(trailers)) {
        args.push("--trailer", `${key}: ${value}`);
      }
    }
    // Always add untangle identification trailer
    args.push("--trailer", "Generated-by: untangle");
    await this.git(args);
    return this.currentSha();
  }

  /**
   * Push a branch to a remote with --force-with-lease.
   * §S2: rejects pushes to protected refs.
   * §S3: always uses --force-with-lease.
   */
  async push(
    remote: string,
    branch: string,
    opts: { protectRefs?: string[] } = {},
  ): Promise<void> {
    // §S2: never push to the original branch
    if (opts.protectRefs?.includes(branch)) {
      throw new UntangleErrorImpl(
        "REF_PROTECTED",
        `Refusing to push to protected ref '${branch}'`,
        false,
        { branch },
      );
    }
    // §S3: always --force-with-lease
    await this.git(["push", "--force-with-lease", remote, branch]);
  }

  /** Delete a local branch. */
  async deleteBranch(name: string): Promise<void> {
    try {
      await this.git(["branch", "-D", name]);
    } catch {
      // Branch may already be deleted
    }
  }

  /** Delete a remote branch. */
  async deleteRemoteBranch(remote: string, name: string): Promise<void> {
    try {
      await this.git(["push", remote, "--delete", name]);
    } catch {
      // Remote branch may not exist
    }
  }

  /** List local branches matching a pattern. */
  async listBranches(pattern: string): Promise<string[]> {
    try {
      const output = await this.git(["branch", "--list", pattern]);
      return output
        .split("\n")
        .map((b) => b.replace(/^\*?\s+/, "").trim())
        .filter((b) => b.length > 0);
    } catch {
      return [];
    }
  }

  /** Apply a patch from a string. */
  async applyPatch(patch: string): Promise<void> {
    try {
      const { execFile: execFileSync } = await import("node:child_process");
      await new Promise<void>((resolve, reject) => {
        const child = execFileSync("git", ["apply", "--3way", "--"], {
          cwd: this.cwd,
        });
        child.stdin?.write(patch);
        child.stdin?.end();
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`git apply exited with code ${code}`));
        });
        child.on("error", reject);
      });
    } catch (err: unknown) {
      throw new UntangleErrorImpl(
        "PATCH_REJECT",
        `Failed to apply patch: ${err instanceof Error ? err.message : String(err)}`,
        false,
      );
    }
  }
}
