# 04 — Tool: `propose_split`

## Purpose

Given a `ConcernGraph`, plan a stack of `Slice`s. Read-only: never modifies git state. The output is a contract for `apply_split`.

## Input

```typescript
{
  graph: ConcernGraph;
  maxConcernsPerSlice?: number;        // default 3 (constitution §4)
  maxLocPerSlice?: number;             // default 400
  stackStrategy?: "gh-stack" | "sapling" | "graphite" | "flat";  // default "flat"
  preserveOrder?: string[];            // concern IDs that must lead the stack
  riskScore?: number;                  // from score_review_effort
  riskThreshold?: number;              // default 0.5
}
```

## Output

```typescript
{
  schemaVersion: "1";
  proposal: SplitProposal;
}
```

## Behavior

1. **Circuit Breaker check.** If `riskScore !== undefined && riskScore < riskThreshold`, return `proposal: { rejected: true, rejectionReason, slices: [] }`. No further processing.
2. **Build slice candidates** by partitioning the concern DAG:
   - Start with concerns having no `dependsOn`. Each becomes a candidate slice.
   - Greedily merge dependent concerns into their dependency's slice when the merge fits within `maxConcernsPerSlice` AND `maxLocPerSlice`.
   - If `preserveOrder` is set, those concerns lead in their listed order (each in its own slice unless natural merge applies).
3. **Topologically sort** slices by inherited DAG edges.
4. **Assign parent links** for stack strategies that require them (`gh-stack`, `sapling`, `graphite`).
5. **Generate titles** for each slice using a deterministic template: `"{verb} {primary-summary}"` (no LLM call in v0; LLM-polished titles come from `summarize_slice`).
6. **Compute `effortScore`** per slice using the same Circuit Breaker logic, scoped to the slice's hunks.
7. **Return** the proposal.

## Preconditions

- `graph` is valid (DAG, no orphan hunks).
- `maxConcernsPerSlice` ≥ 1.
- `maxLocPerSlice` ≥ 50.

## Postconditions

- `slices` is topologically sorted: for every i < j, slice[j] does not appear in slice[i]'s ancestor chain.
- `slices[k].concernIds.length ≤ maxConcernsPerSlice` for all k.
- `slices[k]` total LoC ≤ `maxLocPerSlice` for all k EXCEPT when a single concern exceeds the limit (in which case that concern becomes its own slice with a warning).
- Every concern in `graph.concerns` appears in exactly one slice.
- If `rejected`, `slices` is empty.

## Edge cases

| Case | Behavior |
|---|---|
| Single-concern graph | Returns one slice. No decomposition needed but no rejection either. |
| All concerns mutually independent | Each becomes its own slice; flat stack regardless of strategy. |
| One mega-concern (>maxLocPerSlice) | Becomes its own slice, warning emitted. We do not split within a concern. |
| 20+ concerns | Hard cap on slice count: default 8 slices. Excess concerns merge into the closest topological neighbor. |
| `preserveOrder` references unknown concern ID | Error `code: "UNKNOWN_CONCERN"`. |
| `stackStrategy: "flat"` | `parentSliceId` is undefined for all slices. |

## Acceptance criteria

(See `tests/acceptance/propose-split.test.ts`.)

1. 3-concern independent graph → 3 slices, no parent links (flat).
2. 3-concern linear-dependency graph → 3 slices, each `parentSliceId` = previous slice id (when strategy ≠ flat).
3. `riskScore: 0.2`, threshold 0.5 → rejected proposal, empty slices, reason populated.
4. `maxConcernsPerSlice: 1` → every concern in its own slice.
5. Concern of 500 LoC with `maxLocPerSlice: 400` → its own slice + warning.
6. Same graph + same params produces identical proposal IDs (determinism).

## Decisions worth flagging in review

- **Default `stackStrategy: "flat"`** even though stacked PRs are the differentiator. Reason: gh-stack is in preview, Sapling needs install, Graphite needs auth. Flat works for everyone; stacked is opt-in.
- **No LLM in this tool.** Title generation is template-based. The LLM-quality polish happens in `summarize_slice`. Keeps this tool deterministic and fast.
- **Hard cap on slice count.** 8 slices is the ceiling; if you have more concerns, the planner merges. Better to ship a "good enough" decomposition than an unreviewable 15-slice stack.
