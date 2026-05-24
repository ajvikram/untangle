# 02 — Tool: `analyze_diff`

## Purpose

Parse a diff (or branch, or PR) into a `ConcernGraph`. This is the foundational read-only tool; everything else consumes its output.

## Input

```typescript
{
  target: Target;
  languages?: string[] | "auto";       // default "auto"
  includeCommitMessages?: boolean;     // default true (44% accuracy boost)
  model?: string;                      // default "claude-sonnet-4.7"
  maxHunksPerCall?: number;            // default 40 (LLM batching)
}
```

## Output

```typescript
{
  schemaVersion: "1";
  graph: ConcernGraph;
  warnings: string[];                  // non-fatal issues (binary files, etc.)
  costMeta: {
    llmCalls: number;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  };
}
```

## Behavior

1. **Resolve target** → produce a normalized unified diff.
   - `branch`: `git diff <base>...<branch>`.
   - `pr`: `gh pr diff <number>` and fetch commit messages.
   - `diff`: use as-is.
2. **Parse hunks** with tree-sitter for each detected language. Fall back to plain hunk parsing for unsupported languages (record in `warnings`).
3. **Batch hunks** into groups of ≤ `maxHunksPerCall`.
4. **Classify concerns** per batch via the configured LLM. Include commit messages when `includeCommitMessages` is true.
5. **Merge concerns** across batches when their summaries embed within a similarity threshold.
6. **Build DAG** of dependencies (concern A depends on concern B if B's hunks touch symbols A references).
7. **Validate DAG** is acyclic. On cycle, error with `code: "DAG_CYCLE"` and the cycle's concern IDs.
8. **Return** the `ConcernGraph` with `costMeta`.

## Preconditions

- `target` resolves to a non-empty diff.
- The working tree is clean (`git status` empty), OR `target.kind === "diff"`.
- LLM credentials configured.

## Postconditions

- `graph.concerns.length` ≥ 1 if the diff has at least one non-style hunk.
- `graph.dag` is a valid DAG over `concerns.map(c => c.id)`.
- Sum of `hunks` across concerns equals the input hunk count (no hunk dropped).

## Edge cases

| Case | Behavior |
|---|---|
| Empty diff | Returns `{ concerns: [], dag: [], meta: {…0} }`, no error. |
| Binary-only changes | Concerns of kind `chore`, hunks marked binary, warning emitted. |
| LLM call fails mid-batch | Retry once with backoff. On second failure, return partial graph + warning. |
| File renames | Both old and new paths captured in `HunkRef.filePath` (newer path); a renamed-then-edited file becomes a single concern with kind `refactor`. |
| Generated files (lockfiles, snapshots) | Detected via path heuristics + size; bucketed into a single `deps`/`chore` concern, not LLM-classified. |
| Diff larger than `maxDiffSize` (default 100k LoC) | Reject with `code: "DIFF_TOO_LARGE"`. |

## Acceptance criteria

(See `tests/acceptance/analyze-diff.test.ts`.)

1. Given a known 3-concern fixture (feature + refactor + test), returns exactly 3 concerns with correct kinds.
2. Given a 50-hunk diff, completes in ≤ 2 LLM calls.
3. Given a diff with circular references, returns `DAG_CYCLE` error.
4. Given an empty diff, returns empty graph without error.
5. Same input invoked twice produces identical `concern.id` values (stability).
6. Commit message inclusion changes at least one concern's `kind` or `summary` on the fixture (proves the signal is wired).

## Failure modes worth flagging

- **Concern bleed:** the LLM may assign one logical concern to multiple IDs across batches. Mitigation: the merge step in (5). Track merge rate as a quality metric.
- **Hidden coupling:** static analysis cannot detect runtime coupling. We over-conservatively add `dependsOn` edges; humans can prune at the propose-split stage.
- **Commit-message manipulation:** an adversarial commit message can steer classification. v1 trusts the user's own messages; this is documented, not mitigated.
