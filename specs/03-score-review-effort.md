# 03 — Tool: `score_review_effort`

## Purpose

The Circuit Breaker. Predict review effort from cheap static signals. If predicted effort is low, return `shouldDecompose: false` so the agent loop short-circuits — no decomposition, no LLM cost, no annoying split of a trivial PR.

This is the most-called tool in the system. It must be fast and never make an LLM call.

## Input

```typescript
{
  target: Target;
  threshold?: number;                  // 0..1, default 0.5
  policy?: "conservative" | "balanced" | "aggressive";  // default "balanced"
}
```

`policy` is shorthand for threshold:
- `conservative` → threshold 0.7 (only decompose clearly heavy PRs)
- `balanced` → threshold 0.5
- `aggressive` → threshold 0.3 (decompose almost everything non-trivial)

## Output

```typescript
{
  schemaVersion: "1";
  score: number;                       // 0..1, predicted effort
  shouldDecompose: boolean;            // score >= threshold
  reason: string;                      // why this decision
  signals: {
    patchSize: number;                 // LoC added + removed
    filesTouched: number;
    configEdits: number;
    highRiskFiles: string[];           // paths matching risk heuristics
    estimatedConcerns: number;         // cheap heuristic, no LLM
  };
  costMeta: {
    durationMs: number;
  };
}
```

## Behavior

1. **Resolve target** to a unified diff (same logic as `analyze_diff`).
2. **Extract signals** via pure string and path parsing — never tree-sitter, never LLM:
   - `patchSize` = added + removed lines.
   - `filesTouched` = unique file count.
   - `configEdits` = count of files matching `*.{yml,yaml,toml,json,ini,env,Dockerfile,Makefile}` or in `.github/`, `ci/`, `infra/`.
   - `highRiskFiles` = files matching known-sensitive patterns (auth, security, payments, schema, migration).
   - `estimatedConcerns` = unique top-level directories touched + 1 per high-risk file.
3. **Predict score** via the embedded classifier (gradient-boosted model, AUC 0.957 target per MSR 2026).
4. **Compare** against threshold. Return decision with reason.

## Preconditions

- Target resolves to a diff.
- The classifier model file exists in `dist/models/` (bundled).

## Postconditions

- `score ∈ [0, 1]`.
- `shouldDecompose === (score >= threshold)`.
- No LLM calls made.
- `durationMs < 500` for diffs up to 10k LoC.

## Edge cases

| Case | Behavior |
|---|---|
| Empty diff | `score: 0`, `shouldDecompose: false`, reason `"empty diff"`. |
| Lockfile-only change | `score: 0.1`, `shouldDecompose: false`. |
| Single 1-line fix | `score: 0.05`, `shouldDecompose: false`. |
| Mass rename (10k LoC, 1 concern) | High `patchSize` but classifier features should weigh "trivial-shape" patterns down. Calibration matters; see acceptance criteria. |
| High-risk file (auth, payments) | Bias up; even small diffs touching these score ≥ 0.5. |
| Migration file | Bias up; schema changes deserve isolation. |

## Acceptance criteria

(See `tests/acceptance/score-review-effort.test.ts`.)

1. Trivial typo fix (1-file, 1-line) → `shouldDecompose: false`.
2. Mixed 50-file feature+refactor+test PR → `shouldDecompose: true`.
3. Empty diff → `score: 0`, no error.
4. Lockfile-only change → `shouldDecompose: false`.
5. Touching `**/auth/*` with even a small diff → `shouldDecompose: true`.
6. Same input invoked twice produces identical scores (deterministic).
7. p99 latency ≤ 500ms for 10k-LoC diffs.

## Model

v0/v1: A small embedded model trained on a public PR dataset (we'll start with a hand-crafted heuristic that approximates the MSR 2026 results: weighted sum of normalized signals, sigmoid-squashed).

v2: Train against the AIDev dataset (33,707 agent-authored PRs from MSR 2026) and target AUC ≥ 0.95 under temporal evaluation.

The classifier is intentionally separable from the rest of the system. Swappable behind a `RiskScorer` interface; the embedded heuristic is the default.
