# 07 — Tool: `route_reviewers` *(v2, deferred)*

## Status

**Deferred to v2.** Specified now to lock the contract; implementation comes after v1 ships.

## Purpose

Map each slice in a `SplitProposal` to suggested reviewers using CODEOWNERS, git blame, and concern kind. Returns assignments with rationale.

## Input

```typescript
{
  proposal: SplitProposal;
  repo: string;                        // local path or owner/name
  policy?: "codeowners-strict" | "blame-weighted" | "expertise-graph";  // default "blame-weighted"
  maxReviewersPerSlice?: number;       // default 2
  excludeUsers?: string[];             // e.g. [the diff author]
}
```

## Output

```typescript
{
  schemaVersion: "1";
  assignments: Array<{
    sliceId: string;
    reviewers: Array<{
      login: string;
      reason: string;                  // e.g. "CODEOWNERS owner of 3/5 files"
      weight: number;                  // 0..1, suggestion strength
    }>;
  }>;
  unassigned: string[];                // slice IDs with no plausible reviewer
}
```

## Behavior (v2)

1. **Parse CODEOWNERS** at `repo` root and `.github/`.
2. **Compute blame attribution** for each hunk in the proposal (parallelized).
3. **Score candidates** per policy:
   - `codeowners-strict`: only CODEOWNERS entries; if none, slice is unassigned.
   - `blame-weighted`: weighted blend of CODEOWNERS (weight 0.6) + blame (weight 0.4).
   - `expertise-graph`: future — build a graph from historical reviews of similar concern kinds. Out of scope until v3.
4. **Filter** `excludeUsers`.
5. **Cap** at `maxReviewersPerSlice` per slice.
6. **Return** assignments + unassigned slices.

## Acceptance criteria (v2)

1. Slice touching only files owned by `@team-foo` returns `team-foo` with weight 1.0 (codeowners-strict).
2. Diff author is never assigned to review their own slice.
3. Slice touching un-owned files in `codeowners-strict` policy lands in `unassigned`.
4. `blame-weighted` returns a different set than `codeowners-strict` on a fixture with both signals.

## Why deferred

- The MVP value is decomposition. Routing is a multiplier, not a foundation.
- Blame analysis is slow on large repos; needs caching to be usable.
- CODEOWNERS coverage varies wildly across projects; quality of routing is hard to validate.

Land v1 first. Revisit when we have a real user pipeline.
