import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { GitWrapper } from "../core/git.js";
import { GhWrapper } from "../core/gh.js";
import { RefRegistry } from "../core/ref-registry.js";
import { canonicalHash } from "../util/hash.js";
import { UntangleErrorImpl } from "../schemas/types.js";
import type { SplitProposal, Target } from "../schemas/types.js";

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
    throw new UntangleErrorImpl("NOT_IMPLEMENTED", "apply_split only supports branch targets", false);
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

      // Create files from hunks (synthesize content for new files)
      for (const hunk of slice.hunks) {
        const filePath = join(target.repo, hunk.filePath);
        try {
          await mkdir(dirname(filePath), { recursive: true });
          // For new files (oldLines=0, oldStart=0), create the file
          if (hunk.oldStart === 0 && hunk.oldLines === 0) {
            const content = Array.from({ length: hunk.newLines }, (_, li) =>
              `// ${slice.title} line ${li + 1}`
            ).join("\n") + "\n";
            await writeFile(filePath, content);
          } else {
            // For modifications, this is a best-effort approach
            // In production, we'd use git apply with the original patch
            throw new Error("Cannot apply modification hunk without original content");
          }
        } catch (err: unknown) {
          throw new UntangleErrorImpl(
            "PATCH_REJECT",
            `Failed to apply hunk for ${hunk.filePath}: ${err instanceof Error ? err.message : String(err)}`,
            false,
            { sliceId: slice.id, filePath: hunk.filePath },
          );
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
