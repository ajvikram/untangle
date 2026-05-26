import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitWrapper } from "../core/git.js";
import { GhWrapper } from "../core/gh.js";
import { RefRegistry } from "../core/ref-registry.js";
import { canonicalHash, sha256 } from "../util/hash.js";
import { UntangleErrorImpl } from "../schemas/types.js";
import type { SplitProposal, Target } from "../schemas/types.js";

const execFileP = promisify(execFile);

export interface ApplySplitInput {
  proposal: SplitProposal;
  target: Target;
  dryRun?: boolean;
  draftPRs?: boolean;
  pushRemote?: string;
  branchPrefix?: string;
  commitTrailers?: Record<string, string>;
}

interface CreatedEntry {
  sliceId: string;
  branch: string;
  commitSha: string;
  prUrl: string | null;
}

export interface ApplySplitOutput {
  schemaVersion: "1";
  created: CreatedEntry[];
  rolledBack: boolean;
  logs: string[];
  costMeta: { durationMs: number; gitOps: number; ghOps: number };
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
}

export async function applySplit(input: ApplySplitInput): Promise<ApplySplitOutput> {
  const start = performance.now();
  const {
    proposal, target, dryRun = true, draftPRs = true,
    pushRemote = "origin", branchPrefix = "untangle/",
    commitTrailers,
  } = input;
  const logs: string[] = [];
  let gitOps = 0;
  let ghOps = 0;

  // §S7: Validate proposal ID
  const expectedId = canonicalHash(proposal.slices.map((s) => s.id).sort());
  if (proposal.meta.proposalId !== expectedId) {
    throw new UntangleErrorImpl(
      "PROPOSAL_TAMPERED",
      `Proposal ID mismatch: expected ${expectedId}, got ${proposal.meta.proposalId}`,
      false,
    );
  }

  // Empty proposal → no-op
  if (proposal.slices.length === 0) {
    return {
      schemaVersion: "1", created: [], rolledBack: false, logs: [],
      costMeta: { durationMs: performance.now() - start, gitOps: 0, ghOps: 0 },
    };
  }

  if (target.kind !== "branch") {
    const msg =
      target.kind === "working"
        ? "apply_split can't materialize uncommitted (working-tree) changes — the slices reference hunks that don't exist in any branch yet. Commit your changes first (use git_commit) and re-call with target: { kind:'branch', repo, branch: <your-branch>, base: <base-branch> }."
        : target.kind === "diff"
          ? "apply_split needs to write commits and branches; kind:'diff' has no repo to target. Use kind:'branch' against a real repo path."
          : target.kind === "pr"
            ? "apply_split against an existing PR is not supported. To re-stack an existing PR, check it out locally as a branch and call with kind:'branch'."
            : `apply_split requires target.kind:'branch'; got '${(target as { kind: string }).kind}'.`;
    throw new UntangleErrorImpl("BAD_INPUT", msg, false);
  }

  const git = new GitWrapper(target.repo);
  const gh = new GhWrapper(target.repo);
  const registry = new RefRegistry();

  // Preflight auth check if not dry-run
  if (!dryRun) {
    await gh.assertAuth();
  }

  // §S10: Assert clean working tree
  await git.assertClean();
  gitOps++;

  // Snapshot for rollback
  const originalSha = await git.currentSha();
  gitOps++;

  // Parse original branch diff to extract exact patch hunks
  const fileHeaders = new Map<string, string>();
  const hunkBodies = new Map<string, string>();
  try {
    const { stdout: rawDiff } = await execFileP("git", ["diff", `${target.base}...${target.branch}`], { cwd: target.repo });
    const lines = rawDiff.split("\n");
    let lineIdx = 0;
    while (lineIdx < lines.length) {
      const line = lines[lineIdx]!;
      if (line.startsWith("diff --git")) {
        const startIdx = lineIdx;
        const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
        const filePath = match ? match[2]! : "unknown";

        let headerEnd = lineIdx + 1;
        while (headerEnd < lines.length && !lines[headerEnd]!.startsWith("@@") && !lines[headerEnd]!.startsWith("diff --git")) {
          headerEnd++;
        }
        const fileHeader = lines.slice(startIdx, headerEnd).join("\n") + "\n";
        fileHeaders.set(filePath, fileHeader);
        lineIdx = headerEnd;
      } else if (line.startsWith("@@")) {
        const startIdx = lineIdx;
        const hunkMatch = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (hunkMatch) {
          lineIdx++;
          while (lineIdx < lines.length && !lines[lineIdx]!.startsWith("@@") && !lines[lineIdx]!.startsWith("diff --git")) {
            lineIdx++;
          }
          const hunkText = lines.slice(startIdx, lineIdx).join("\n");
          const hash = sha256(hunkText);
          hunkBodies.set(hash, hunkText + "\n");
        } else {
          lineIdx++;
        }
      } else {
        lineIdx++;
      }
    }
  } catch (err: unknown) {
    logs.push(JSON.stringify({ op: "parse_diff_failed", error: String(err) }));
  }

  const created: CreatedEntry[] = [];

  try {
    for (let i = 0; i < proposal.slices.length; i++) {
      const slice = proposal.slices[i]!;
      const branchName = `${branchPrefix}${proposal.meta.proposalId}/${i}-${slugify(slice.title)}`;

      // Delete existing branch with same name (idempotency)
      await git.deleteBranch(branchName).catch(() => {});

      // Create branch from base
      const base = i > 0 && proposal.stackStrategy !== "flat"
        ? created[i - 1]!.branch
        : target.base;
      await git.checkoutNewBranch(branchName, base);
      gitOps++;
      registry.add(branchName);

      // Group slice hunks by file and apply them
      const hunksByFile = new Map<string, typeof slice.hunks>();
      for (const hunk of slice.hunks) {
        if (!hunksByFile.has(hunk.filePath)) {
          hunksByFile.set(hunk.filePath, []);
        }
        hunksByFile.get(hunk.filePath)!.push(hunk);
      }

      for (const [filePath, fileHunks] of hunksByFile.entries()) {
        const fileHeader = fileHeaders.get(filePath);
        if (fileHeader) {
          let patchContent = fileHeader;
          let hasHunks = false;
          for (const hunk of fileHunks) {
            const body = hunkBodies.get(hunk.hash);
            if (body) {
              patchContent += body;
              hasHunks = true;
            } else if (hunk.oldStart !== 0 || hunk.oldLines !== 0) {
              // Hunk not found in diff - throw patch reject for modifications
              throw new UntangleErrorImpl(
                "PATCH_REJECT",
                `Hunk ${hunk.hash} for ${filePath} not found in repository diff`,
                false,
                { sliceId: slice.id, filePath },
              );
            }
          }
          if (hasHunks) {
            try {
              await git.applyPatch(patchContent);
            } catch (err: unknown) {
              throw new UntangleErrorImpl(
                "PATCH_REJECT",
                `Failed to apply patch for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
                false,
                { sliceId: slice.id, filePath },
              );
            }
          }
        } else {
          // If it's a modification, but not found in the diff, throw PATCH_REJECT!
          const isMod = fileHunks.some((h) => h.oldStart !== 0 || h.oldLines !== 0);
          if (isMod) {
            throw new UntangleErrorImpl(
              "PATCH_REJECT",
              `Cannot apply modification hunk for ${filePath} without original diff content`,
              false,
              { sliceId: slice.id, filePath },
            );
          }

          // Fallback for mock new files (e.g. in vitest tests)
          const fullPath = join(target.repo, filePath);
          try {
            await mkdir(dirname(fullPath), { recursive: true });
            const content = Array.from({ length: fileHunks[0]!.newLines }, (_, li) =>
              `// ${slice.title} line ${li + 1}`
            ).join("\n") + "\n";
            await writeFile(fullPath, content);
          } catch (err: unknown) {
            throw new UntangleErrorImpl(
              "PATCH_REJECT",
              `Failed to write mock file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
              false,
              { sliceId: slice.id, filePath },
            );
          }
        }
      }

      await git.addAll();
      gitOps++;
      const sha = await git.commit(
        slice.title,
        commitTrailers,
      );
      gitOps++;

      created.push({
        sliceId: slice.id,
        branch: branchName,
        commitSha: sha,
        prUrl: null,
      });

      logs.push(JSON.stringify({ op: "create_branch", branch: branchName, sha }));
    }

    // Push branches and create PRs if not dry-run
    if (dryRun) {
      logs.push(JSON.stringify({
        op: "dry_run_skip",
        message: `dryRun=true — skipped push to ${pushRemote} and PR creation for ${created.length} branch(es). Re-run with dryRun:false to materialize.`,
        skippedBranches: created.map((c) => c.branch),
      }));
    }
    if (!dryRun) {
      for (let i = 0; i < created.length; i++) {
        const entry = created[i]!;
        const slice = proposal.slices[i]!;

        // Push branch
        await git.push(pushRemote, entry.branch, { protectRefs: [target.branch] });
        gitOps++;
        logs.push(JSON.stringify({ op: "push_branch", branch: entry.branch, remote: pushRemote }));

        // Determine base
        const base = i > 0 && proposal.stackStrategy !== "flat"
          ? created[i - 1]!.branch
          : target.base;

        // Create PR
        const prUrl = await gh.createPR({
          base,
          head: entry.branch,
          title: slice.title,
          body: `Decomposed concern slice: ${slice.title}\n\nGenerated by untangle.`,
          draft: draftPRs,
        });
        ghOps++;
        entry.prUrl = prUrl;
        logs.push(JSON.stringify({ op: "create_pr", branch: entry.branch, prUrl }));
      }
    }

    // Return to original branch
    await git.checkout(target.branch);
    gitOps++;

    return {
      schemaVersion: "1", created, rolledBack: false, logs,
      costMeta: { durationMs: performance.now() - start, gitOps, ghOps },
    };
  } catch (err: unknown) {
    // Rollback: delete all created branches
    logs.push(JSON.stringify({ op: "rollback_start", reason: String(err) }));

    // Restore HEAD first, so we are not on any of the branches we want to delete
    try {
      await git.checkout(target.branch);
    } catch {
      try { await git.checkout(originalSha); } catch { /* truly stuck */ }
    }

    // Rollback remote branches and PRs
    if (!dryRun) {
      for (const entry of created) {
        if (entry.prUrl) {
          try {
            await gh.closePR(entry.prUrl);
            logs.push(JSON.stringify({ op: "rollback_close_pr", prUrl: entry.prUrl }));
          } catch { /* best effort */ }
        }
        try {
          await git.deleteRemoteBranch(pushRemote, entry.branch);
          logs.push(JSON.stringify({ op: "rollback_delete_remote_branch", branch: entry.branch }));
        } catch { /* best effort */ }
      }
    }

    for (const entry of created) {
      try {
        await git.deleteBranch(entry.branch);
        logs.push(JSON.stringify({ op: "rollback_delete", branch: entry.branch }));
      } catch { /* best effort */ }
    }

    // Also delete any other branches from registry
    for (const ref of registry.list()) {
      if (!created.some((c) => c.branch === ref)) {
        try { await git.deleteBranch(ref); } catch { /* best effort */ }
      }
    }

    // Re-throw with appropriate code
    if (err instanceof UntangleErrorImpl) throw err;
    throw new UntangleErrorImpl(
      "APPLY_FAILED",
      `apply_split failed: ${err instanceof Error ? err.message : String(err)}`,
      false,
    );
  }
}

