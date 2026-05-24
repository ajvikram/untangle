# 06 — Tool: `summarize_slice`

## Purpose

Generate a reviewer-ready PR body for a single slice. Optionally link to OpenSpec / Spec-Kit deltas if the project uses them.

## Input

```typescript
{
  slice: Slice;
  graph: ConcernGraph;
  specSource?: "openspec" | "spec-kit" | "none";  // default "none"
  specPath?: string;                              // root of specs (when specSource set)
  style?: "concise" | "detailed";                 // default "concise"
  model?: string;                                 // default "claude-sonnet-4.7"
}
```

## Output

```typescript
{
  schemaVersion: "1";
  title: string;                                  // ≤ 72 chars, imperative
  body: string;                                   // markdown
  specDeltaRefs: string[];                        // paths or change IDs
  costMeta: {
    llmCalls: number;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  };
}
```

## Behavior

1. **Build prompt** from:
   - The slice's concerns (titles, kinds, hunks summary).
   - The slice's `kindMix` and `effortScore`.
   - Cross-references to other slices in the same stack (if `slice.parentSliceId`).
   - Spec deltas, when `specSource ≠ "none"`: scan `specPath` for matching changes.
2. **Call LLM** with a tight system prompt:
   - Title: imperative voice, no "this PR" language, ≤ 72 chars.
   - Body sections: `## Summary`, `## Changes`, `## Notes for reviewers`, (optional) `## Spec links`.
   - Style controls verbosity.
3. **Validate output** against schema. Retry once on malformed.
4. **Return** title + body + spec refs.

## Preconditions

- `slice` is valid (concerns exist in `graph`, hunks resolve).
- LLM credentials configured.

## Postconditions

- `title.length ≤ 72`.
- `body` contains at minimum `## Summary` and `## Changes` headings.
- `specDeltaRefs` paths exist on disk when `specSource ≠ "none"`.

## Edge cases

| Case | Behavior |
|---|---|
| Slice with 1 concern of kind `style` | Title prefixed with `style:`, body minimal. |
| Slice with `parentSliceId` set | Body includes "Builds on #<parent-pr-or-branch>" line. |
| Spec source set but no matching delta found | `specDeltaRefs: []`, warning emitted, no error. |
| LLM returns title > 72 chars | Retry once with explicit length constraint. If still over, truncate at word boundary. |

## Acceptance criteria

(See `tests/acceptance/summarize-slice.test.ts`.)

1. Single-concern feature slice → title starts with imperative verb, body has all required sections.
2. Stacked slice with `parentSliceId` → body references parent.
3. `specSource: "openspec"` with matching change folder → `specDeltaRefs` populated.
4. Title length always ≤ 72 chars across 100 fixture slices.
5. Same input produces consistent output structure (sections present) across runs even when text varies.
