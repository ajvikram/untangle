# 01 — Common Types

All tool inputs and outputs reference these types. Defined here, validated by Zod schemas at runtime, exported as TypeScript types at compile time.

## `Target`

What every tool operates on. Discriminated union — exactly one shape.

```typescript
type Target =
  | { kind: "branch"; repo: string; branch: string; base: string }
  | { kind: "diff"; content: string; baseRef?: string }
  | { kind: "pr"; repo: string; number: number };
```

- `branch`: local or remote branch. `repo` is `owner/name` or a local path. `base` is the merge-base ref (e.g. `main`).
- `diff`: raw unified diff. `baseRef` optional for context lookups.
- `pr`: existing GitHub pull request.

**Invariant:** at most one `Target` per tool invocation.

## `ConcernKind`

Closed enum. Used for routing and slice composition.

```typescript
type ConcernKind =
  | "feature" | "refactor" | "fix" | "test"
  | "docs" | "config" | "deps" | "style" | "chore";
```

Definitions:

| Kind | Meaning |
|---|---|
| `feature` | New capability visible to a consumer of this code. |
| `refactor` | Behavior-preserving structural change. |
| `fix` | Behavior-changing correction of a defect. |
| `test` | New or modified test code only. |
| `docs` | Documentation, comments, README, JSDoc/TSDoc. |
| `config` | Build, lint, CI, env, package manifests. |
| `deps` | Dependency manifest changes (lockfiles included). |
| `style` | Whitespace, formatting, lint-driven, no semantic delta. |
| `chore` | Repo housekeeping that fits none of the above. |

## `HunkRef`

A reference into the source diff.

```typescript
type HunkRef = {
  filePath: string;
  oldStart: number;   // 1-indexed
  oldLines: number;
  newStart: number;   // 1-indexed
  newLines: number;
  hash: string;       // sha256 of the hunk text, for idempotency
};
```

## `Concern`

A single, atomic unit of intent extracted from the diff.

```typescript
type Concern = {
  id: string;                     // stable: sha256(sorted(hunks.hash))
  kind: ConcernKind;
  summary: string;                // one line, imperative ("add", "rename", "remove")
  hunks: HunkRef[];               // all hunks belonging to this concern
  dependsOn: string[];            // concern IDs this depends on
  confidence: number;             // 0..1, from LLM
  riskHints: {
    touchesPublicAPI: boolean;
    touchesConfig: boolean;
    touchesSecurity: boolean;
  };
};
```

**Invariant:** `dependsOn` forms a DAG (no cycles). Enforced in `analyze_diff` postprocessing.

## `ConcernGraph`

The full output of `analyze_diff`.

```typescript
type ConcernGraph = {
  concerns: Concern[];
  dag: Array<[string, string]>;   // edges (from, to) — `from` depends on `to`
  meta: {
    hunkCount: number;
    fileCount: number;
    loc: number;                  // added + removed
    languagesDetected: string[];
  };
};
```

## `Slice`

A group of concerns destined for a single commit/PR.

```typescript
type Slice = {
  id: string;
  title: string;                  // PR title, imperative, ≤72 chars
  concernIds: string[];           // ≤ 3
  hunks: HunkRef[];               // union of hunks across concerns
  parentSliceId?: string;         // for stacking; undefined = base
  effortScore: number;            // 0..1, Circuit-Breaker output
  kindMix: Partial<Record<ConcernKind, number>>; // % of LoC by kind
};
```

**Invariants:**
- `concernIds.length` ≤ 3 (constitution §4).
- If `parentSliceId` is set, that slice must precede this one in the proposal's `slices` array.
- `hunks` are non-overlapping with sibling slices' hunks.

## `SplitProposal`

What `propose_split` returns and `apply_split` consumes.

```typescript
type SplitProposal = {
  slices: Slice[];                          // topologically ordered
  stackStrategy: "gh-stack" | "sapling" | "graphite" | "flat";
  rejected: boolean;                        // Circuit Breaker veto
  rejectionReason?: string;
  meta: {
    originalLoC: number;
    sliceCount: number;
    proposalId: string;                     // sha256 of canonical slice IDs
  };
};
```

**Invariant:** if `rejected`, `slices` is empty and `rejectionReason` is present.

## Error shape

All tools return JSON-RPC errors with a structured `data` payload:

```typescript
type UntangleError = {
  code: string;                   // e.g. "GIT_DIRTY", "LLM_QUOTA", "DAG_CYCLE"
  message: string;                // human-readable
  recoverable: boolean;
  details?: Record<string, unknown>;
};
```

## Versioning

Types are versioned via a top-level `schemaVersion: "1"` field on every tool output. Breaking changes increment the integer; consumers pin via the `schemaVersion` they understand.
