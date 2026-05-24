# 05 — Tool: `apply_split`

## Purpose

Materialize a `SplitProposal` as actual git commits and (optionally) GitHub pull requests. The only tool in `untangle` that mutates state. Must be atomic and reversible.

## Input

```typescript
{
  proposal: SplitProposal;
  target: Target;
  dryRun?: boolean;                    // default true on first call
  draftPRs?: boolean;                  // default true
  pushRemote?: string;                 // default "origin"
  branchPrefix?: string;               // default "untangle/"
  commitTrailers?: Record<string, string>;  // injected into every commit
}
```

## Output

```typescript
{
  schemaVersion: "1";
  created: Array<{
    sliceId: string;
    branch: string;
    commitSha: string;
    prUrl: string | null;              // null when dryRun or no remote push
  }>;
  rolledBack: boolean;
  logs: string[];                      // structured log lines (JSON, single-line each)
  costMeta: {
    durationMs: number;
    gitOps: number;
    ghOps: number;
  };
}
```

## Behavior

1. **Preflight.** Verify:
   - Working tree is clean (`git status` empty).
   - All slice hunks resolve to current file state (no merge conflicts mid-flight).
   - `gh` CLI is authenticated (skipped when `dryRun: true` and no PRs created).
2. **Snapshot.** Record the current HEAD ref and any existing untangle/* branches. This is the rollback point.
3. **Build stack on synthesized branches:**
   - For each slice in proposal order:
     - Check out a new branch `{branchPrefix}{proposalId}/{sliceIndex}-{slugifiedTitle}` from `target.base` (or previous slice when stacking).
     - Apply only the slice's hunks via `git apply` from a synthesized patch.
     - Commit with `slice.title` as subject, slice summary as body, and injected `commitTrailers`.
     - Record `commitSha`.
4. **Optionally push and create PRs** when `dryRun: false`:
   - Push each branch with `--force-with-lease`.
   - Create PR via `gh pr create` (draft if `draftPRs`).
   - For stacked strategies: set the PR base to the previous slice's branch.
5. **On any failure:**
   - Rollback: delete all created branches locally. Delete remote branches we pushed. Close PRs we opened. Restore HEAD to snapshot.
   - Set `rolledBack: true`, populate `logs` with failure details, return error.
6. **On success:** the original branch is untouched. Caller can fast-forward / replace manually.

## Preconditions

- Working tree clean.
- `proposal.rejected === false`.
- `gh` CLI installed and authenticated when `dryRun: false`.
- Network access for push/PR creation when `dryRun: false`.

## Postconditions

- **Atomic.** Either all branches/PRs were created OR none were (`rolledBack: true`).
- **Non-destructive.** The original branch ref is byte-identical before and after.
- **Idempotent for the same proposal ID:** re-running with the same proposal and existing branches updates rather than duplicates (via branch name = proposal ID hash).

## Edge cases

| Case | Behavior |
|---|---|
| `dryRun: true` | Build branches locally, do not push, do not create PRs. Return commitShas. |
| Working tree dirty | Error `code: "GIT_DIRTY"` before any mutation. |
| `gh` not authenticated, `dryRun: false` | Error `code: "GH_AUTH"` during preflight (no mutation). |
| Patch apply fails mid-stack | Rollback all prior branches. Return error `code: "PATCH_REJECT"` with the failing slice ID. |
| Remote already has a branch with our name | Error unless `--force-with-lease` is safe (no third-party commits). Otherwise rollback. |
| Network failure after some PRs created | Rollback PRs we opened; remote branches we pushed are deleted; report rolledBack. |

## Acceptance criteria

(See `tests/acceptance/apply-split.test.ts`.)

1. `dryRun: true` on a valid 3-slice proposal → 3 commits on synthesized branches, no PRs, no remote push.
2. Mid-stack patch failure → all branches deleted, original HEAD intact, `rolledBack: true`.
3. Empty proposal → no-op, no error.
4. Idempotency: same proposal applied twice produces same branch names and no duplicate PRs.
5. Branches use the prefix `untangle/`.
6. Working tree dirty → error before any git op runs.

## Safety contracts (also see `specs/safety-contracts.md`)

- **Never** force-push to the original branch.
- **Never** delete a branch we did not create in this invocation.
- **Never** push without `--force-with-lease`.
- **Never** commit without a trailer that identifies untangle as the author tool.
- **Always** rollback synthesized state before returning an error.
- **Always** log every git/gh operation to stderr in single-line JSON.
