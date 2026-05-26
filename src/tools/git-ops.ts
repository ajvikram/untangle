/**
 * Git operation tools — thin handlers over GitWrapper exposed as MCP tools.
 * All mutation tools accept dryRun and protectRefs for §S2/§S3 safety.
 */

import { GitWrapper } from "../core/git.js";
import { UntangleErrorImpl } from "../schemas/types.js";
import { logger } from "../util/logger.js";

const DEFAULT_PROTECTED_REFS = ["main", "master", "develop", "production", "release"];

/**
 * Resolve the protected-refs list:
 *   - undefined → defaults
 *   - explicit array (including []) → use exactly that
 * This lets callers opt out (protectRefs:[]) without naming a magic value.
 */
function resolveProtectedRefs(input: string[] | undefined): string[] {
  return input === undefined ? DEFAULT_PROTECTED_REFS : input;
}

function isProtectedRef(branch: string, input: string[] | undefined): boolean {
  return resolveProtectedRefs(input).includes(branch);
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

export interface GitStatusInput { repo?: string }
export async function gitStatus(input: GitStatusInput = {}): Promise<{ schemaVersion: "1"; status: Awaited<ReturnType<GitWrapper["status"]>> }> {
  const git = new GitWrapper(input.repo ?? ".");
  const status = await git.status();
  return { schemaVersion: "1", status };
}

export interface GitDiffInput {
  repo?: string;
  mode?: "working" | "staged" | "head" | "range";
  base?: string;
  head?: string;
  paths?: string[];
}
export async function gitDiff(input: GitDiffInput = {}): Promise<{ schemaVersion: "1"; diff: string; mode: string }> {
  const git = new GitWrapper(input.repo ?? ".");
  const mode = input.mode ?? "head";
  if (mode === "range") {
    if (!input.base || !input.head) {
      throw new UntangleErrorImpl("BAD_INPUT", "mode=range requires base and head", false);
    }
    const diff = await git.diff(input.base, input.head);
    return { schemaVersion: "1", diff, mode };
  }
  if (input.paths && input.paths.length > 0) {
    const diff = await git.diffPaths(
      input.paths,
      mode === "staged" ? "staged" : mode === "head" ? "head" : "working",
    );
    return { schemaVersion: "1", diff, mode };
  }
  if (mode === "staged") return { schemaVersion: "1", diff: await git.diffStaged(), mode };
  if (mode === "working") return { schemaVersion: "1", diff: await git.diffUnstaged(), mode };
  return { schemaVersion: "1", diff: await git.diffHead(), mode };
}

export interface GitLogInput {
  repo?: string;
  maxCount?: number;
  range?: string;
  paths?: string[];
}
export async function gitLog(input: GitLogInput = {}): Promise<{ schemaVersion: "1"; commits: Awaited<ReturnType<GitWrapper["log"]>> }> {
  const git = new GitWrapper(input.repo ?? ".");
  const commits = await git.log({ maxCount: input.maxCount, range: input.range, paths: input.paths });
  return { schemaVersion: "1", commits };
}

export interface GitShowInput {
  repo?: string;
  ref: string;
  stat?: boolean;
  nameOnly?: boolean;
  format?: "full" | "patch";
}
export async function gitShow(input: GitShowInput): Promise<{ schemaVersion: "1"; content: string }> {
  const git = new GitWrapper(input.repo ?? ".");
  const content = await git.show(input.ref, { stat: input.stat, nameOnly: input.nameOnly, format: input.format });
  return { schemaVersion: "1", content };
}

export interface GitBranchInput {
  repo?: string;
  includeRemote?: boolean;
}
export async function gitBranch(input: GitBranchInput = {}): Promise<{
  schemaVersion: "1";
  current: string;
  branches: Array<{ name: string; current: boolean; remote: boolean }>;
}> {
  const git = new GitWrapper(input.repo ?? ".");
  const [current, branches] = await Promise.all([
    git.currentBranch(),
    git.listAllBranches({ remote: input.includeRemote }),
  ]);
  return { schemaVersion: "1", current, branches };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface GitCommitInput {
  repo?: string;
  message: string;
  paths?: string[];
  addAll?: boolean;
  trailers?: Record<string, string>;
  dryRun?: boolean;
}
export async function gitCommit(input: GitCommitInput): Promise<{
  schemaVersion: "1";
  sha: string | null;
  dryRun: boolean;
  staged: string[];
}> {
  if (!input.message || input.message.trim().length === 0) {
    throw new UntangleErrorImpl("BAD_INPUT", "commit message is required", false);
  }
  const git = new GitWrapper(input.repo ?? ".");
  if (input.dryRun) {
    const status = await git.status();
    return {
      schemaVersion: "1",
      sha: null,
      dryRun: true,
      staged: input.addAll ? [...status.staged, ...status.modified] : input.paths ?? status.staged,
    };
  }
  if (input.addAll) await git.addAll();
  else if (input.paths && input.paths.length > 0) await git.addPaths(input.paths);
  const sha = await git.commit(input.message, input.trailers);
  logger.info("git_commit_tool", { sha });
  return { schemaVersion: "1", sha, dryRun: false, staged: input.paths ?? [] };
}

export interface GitPushInput {
  repo?: string;
  remote?: string;
  branch?: string;
  protectRefs?: string[];
  dryRun?: boolean;
}
export async function gitPush(input: GitPushInput = {}): Promise<{
  schemaVersion: "1";
  pushed: boolean;
  branch: string;
  remote: string;
  dryRun: boolean;
}> {
  const git = new GitWrapper(input.repo ?? ".");
  const remote = input.remote ?? "origin";
  const branch = input.branch ?? (await git.currentBranch());
  if (!branch) throw new UntangleErrorImpl("BAD_INPUT", "no current branch; specify branch", false);
  if (isProtectedRef(branch, input.protectRefs)) {
    throw new UntangleErrorImpl(
      "REF_PROTECTED",
      `Refusing to push to protected ref '${branch}'. Pass protectRefs:[] to override or push manually.`,
      false,
      { branch, defaults: DEFAULT_PROTECTED_REFS },
    );
  }
  if (input.dryRun) {
    return { schemaVersion: "1", pushed: false, branch, remote, dryRun: true };
  }
  await git.push(remote, branch, { protectRefs: resolveProtectedRefs(input.protectRefs) });
  return { schemaVersion: "1", pushed: true, branch, remote, dryRun: false };
}

export interface GitCheckoutInput {
  repo?: string;
  ref: string;
  createBranch?: boolean;
  from?: string;
  dryRun?: boolean;
}
export async function gitCheckout(input: GitCheckoutInput): Promise<{
  schemaVersion: "1";
  ref: string;
  created: boolean;
  dryRun: boolean;
}> {
  const git = new GitWrapper(input.repo ?? ".");
  if (input.dryRun) {
    return { schemaVersion: "1", ref: input.ref, created: !!input.createBranch, dryRun: true };
  }
  if (input.createBranch) {
    await git.checkoutNewBranch(input.ref, input.from ?? "HEAD");
    return { schemaVersion: "1", ref: input.ref, created: true, dryRun: false };
  }
  await git.checkout(input.ref);
  return { schemaVersion: "1", ref: input.ref, created: false, dryRun: false };
}

// ---------------------------------------------------------------------------
// Stash
// ---------------------------------------------------------------------------

export interface GitStashListInput { repo?: string }
export async function gitStashList(input: GitStashListInput = {}): Promise<{
  schemaVersion: "1";
  stashes: Awaited<ReturnType<GitWrapper["stashList"]>>;
}> {
  const git = new GitWrapper(input.repo ?? ".");
  return { schemaVersion: "1", stashes: await git.stashList() };
}

export interface GitStashInput {
  repo?: string;
  message?: string;
  includeUntracked?: boolean;
  keepIndex?: boolean;
}
export async function gitStash(input: GitStashInput = {}): Promise<{
  schemaVersion: "1";
  ref: string;
}> {
  const git = new GitWrapper(input.repo ?? ".");
  const ref = await git.stashPush({
    message: input.message,
    includeUntracked: input.includeUntracked,
    keepIndex: input.keepIndex,
  });
  logger.info("git_stash_tool", { ref });
  return { schemaVersion: "1", ref };
}

export interface GitStashPopInput {
  repo?: string;
  ref?: string;
  apply?: boolean; // if true, apply but don't drop
}
export async function gitStashPop(input: GitStashPopInput = {}): Promise<{
  schemaVersion: "1";
  popped: boolean;
  ref?: string;
}> {
  const git = new GitWrapper(input.repo ?? ".");
  if (input.apply) {
    await git.stashApply(input.ref);
    return { schemaVersion: "1", popped: false, ref: input.ref };
  }
  await git.stashPop(input.ref);
  return { schemaVersion: "1", popped: true, ref: input.ref };
}

export interface GitStashDropInput { repo?: string; ref?: string }
export async function gitStashDrop(input: GitStashDropInput = {}): Promise<{ schemaVersion: "1"; ref?: string }> {
  const git = new GitWrapper(input.repo ?? ".");
  await git.stashDrop(input.ref);
  return { schemaVersion: "1", ref: input.ref };
}
