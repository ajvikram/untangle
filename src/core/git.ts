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

  /** Get staged (index vs HEAD) diff. */
  async diffStaged(): Promise<string> {
    return this.git(["diff", "--cached"]);
  }

  /** Get unstaged (working tree vs index) diff. */
  async diffUnstaged(): Promise<string> {
    return this.git(["diff"]);
  }

  /** Diff a specific path(s) — combines with mode for cached/working/HEAD selection. */
  async diffPaths(paths: string[], mode: "working" | "staged" | "head" = "working"): Promise<string> {
    const args = ["diff"];
    if (mode === "staged") args.push("--cached");
    else if (mode === "head") args.push("HEAD");
    if (paths.length > 0) args.push("--", ...paths);
    return this.git(args);
  }

  /** Current branch name (empty string if detached HEAD). */
  async currentBranch(): Promise<string> {
    try {
      return await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
    } catch {
      return "";
    }
  }

  /** Working-tree status as a structured object. */
  async status(): Promise<{
    branch: string;
    ahead: number;
    behind: number;
    staged: string[];
    modified: string[];
    untracked: string[];
    conflicted: string[];
    clean: boolean;
  }> {
    const raw = await this.git(["status", "--porcelain=v2", "--branch"]);
    const lines = raw.split("\n");
    let branch = "";
    let ahead = 0;
    let behind = 0;
    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];
    const conflicted: string[] = [];
    for (const line of lines) {
      if (line.startsWith("# branch.head")) {
        branch = line.substring("# branch.head ".length).trim();
      } else if (line.startsWith("# branch.ab")) {
        const m = line.match(/\+(\d+)\s+-(\d+)/);
        if (m) {
          ahead = parseInt(m[1]!, 10);
          behind = parseInt(m[2]!, 10);
        }
      } else if (line.startsWith("? ")) {
        untracked.push(line.substring(2).trim());
      } else if (line.startsWith("u ")) {
        // unmerged: "u <xy> ... <path>"
        const parts = line.split(" ");
        const p = parts[parts.length - 1];
        if (p) conflicted.push(p);
      } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
        // changed entry: "1 XY ... <path>" or "2 XY ... <orig> <path>"
        const parts = line.split(" ");
        const xy = parts[1] ?? "..";
        const x = xy[0];
        const y = xy[1];
        const p = parts[parts.length - 1];
        if (!p) continue;
        if (x && x !== "." && x !== "?") staged.push(p);
        if (y && y !== "." && y !== "?") modified.push(p);
      }
    }
    return {
      branch,
      ahead,
      behind,
      staged,
      modified,
      untracked,
      conflicted,
      clean: staged.length === 0 && modified.length === 0 && untracked.length === 0 && conflicted.length === 0,
    };
  }

  /** Get commit log entries. */
  async log(opts: {
    maxCount?: number;
    range?: string;
    paths?: string[];
    includeStat?: boolean;
  } = {}): Promise<Array<{
    sha: string;
    author: string;
    email: string;
    date: string;
    subject: string;
    body?: string;
  }>> {
    const fmt = ["%H", "%an", "%ae", "%aI", "%s", "%b"].join("%x1f");
    const args = ["log", `--max-count=${opts.maxCount ?? 20}`, `--pretty=format:${fmt}%x1e`];
    if (opts.range) args.push(opts.range);
    if (opts.paths && opts.paths.length > 0) args.push("--", ...opts.paths);
    const raw = await this.git(args);
    if (!raw) return [];
    return raw
      .split("\x1e")
      .map((rec) => rec.trim())
      .filter((rec) => rec.length > 0)
      .map((rec) => {
        const [sha, author, email, date, subject, body] = rec.split("\x1f");
        return {
          sha: sha ?? "",
          author: author ?? "",
          email: email ?? "",
          date: date ?? "",
          subject: subject ?? "",
          body: body ? body : undefined,
        };
      });
  }

  /** Show a commit (or other ref) with optional diff/stat. */
  async show(ref: string, opts: { stat?: boolean; nameOnly?: boolean; format?: "full" | "patch" } = {}): Promise<string> {
    const args = ["show"];
    if (opts.nameOnly) args.push("--name-only");
    else if (opts.stat) args.push("--stat");
    if (opts.format === "patch") args.push("--patch");
    args.push(ref);
    return this.git(args);
  }

  /** Stage specific paths (use addAll for everything). */
  async addPaths(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.git(["add", "--", ...paths]);
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

  /** List all branches (optionally including remote-tracking refs). */
  async listAllBranches(opts: { remote?: boolean } = {}): Promise<Array<{ name: string; current: boolean; remote: boolean }>> {
    const args = ["branch", "--list"];
    if (opts.remote) args.push("--all");
    try {
      const output = await this.git(args);
      return output
        .split("\n")
        .map((line) => {
          const current = line.startsWith("*");
          const cleaned = line.replace(/^\*?\s+/, "").trim();
          if (!cleaned || cleaned.startsWith("(HEAD detached")) return null;
          const isRemote = cleaned.startsWith("remotes/");
          return {
            name: isRemote ? cleaned.replace(/^remotes\//, "") : cleaned,
            current,
            remote: isRemote,
          };
        })
        .filter((b): b is { name: string; current: boolean; remote: boolean } => b !== null);
    } catch {
      return [];
    }
  }

  /** List stashes. */
  async stashList(): Promise<Array<{ ref: string; subject: string; date: string }>> {
    try {
      const out = await this.git(["stash", "list", "--format=%gd%x09%aI%x09%s"]);
      if (!out) return [];
      return out.split("\n").map((line) => {
        const [ref, date, subject] = line.split("\t");
        return { ref: ref ?? "", date: date ?? "", subject: subject ?? "" };
      });
    } catch {
      return [];
    }
  }

  /** Push a stash. Returns the created ref (e.g. "stash@{0}"). */
  async stashPush(opts: { message?: string; includeUntracked?: boolean; keepIndex?: boolean } = {}): Promise<string> {
    const args = ["stash", "push"];
    if (opts.includeUntracked) args.push("--include-untracked");
    if (opts.keepIndex) args.push("--keep-index");
    if (opts.message) args.push("-m", opts.message);
    await this.git(args);
    // Resolve the ref of the stash we just created
    const list = await this.stashList();
    return list[0]?.ref ?? "stash@{0}";
  }

  /** Pop a stash. */
  async stashPop(ref?: string): Promise<void> {
    const args = ["stash", "pop"];
    if (ref) args.push(ref);
    await this.git(args);
  }

  /** Apply (but don't pop) a stash. */
  async stashApply(ref?: string): Promise<void> {
    const args = ["stash", "apply"];
    if (ref) args.push(ref);
    await this.git(args);
  }

  /** Drop a stash. */
  async stashDrop(ref?: string): Promise<void> {
    const args = ["stash", "drop"];
    if (ref) args.push(ref);
    await this.git(args);
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
