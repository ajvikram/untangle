# Change 0001 — Design

## Module layout

```
src/
├── mcp.ts                     # MCP server entry point
├── cli.ts                     # CLI entry point (thin wrapper over tools)
├── index.ts                   # Programmatic API exports
├── tools/
│   ├── analyze-diff.ts
│   ├── score-review-effort.ts
│   ├── propose-split.ts
│   ├── apply-split.ts
│   └── summarize-slice.ts
├── core/
│   ├── concern-graph.ts       # DAG construction, validation
│   ├── slice-builder.ts       # propose_split's planner
│   ├── risk-scorer.ts         # heuristic Circuit Breaker
│   ├── diff-parser.ts         # unified diff → hunks
│   ├── git.ts                 # simple-git wrapper + safety rails
│   ├── gh.ts                  # gh CLI wrapper
│   └── ref-registry.ts        # tracks refs created in current call
├── llm/
│   ├── client.ts              # provider-agnostic LLM client
│   ├── redactor.ts            # credential filter (§S4)
│   └── prompts.ts             # prompt templates
├── schemas/
│   └── types.ts               # Zod schemas + inferred TS types
└── util/
    ├── logger.ts              # structured logger (§S8)
    ├── timeout.ts             # withTimeout helper (§S9)
    └── hash.ts                # sha256 helpers for stable IDs
```

## Data flow (happy path)

```
MCP client                  untangle MCP server                Backends
    │                              │                              │
    │  analyze_diff(target)        │                              │
    ├─────────────────────────────►│                              │
    │                              │  git diff base...branch      │
    │                              ├─────────────────────────────►│ git
    │                              │◄─ raw unified diff ──────────┤
    │                              │                              │
    │                              │  tree-sitter parse           │
    │                              │  batch hunks → LLM           │
    │                              ├─────────────────────────────►│ Claude
    │                              │◄─ concerns ──────────────────┤
    │                              │  build DAG, validate         │
    │                              │                              │
    │◄─ ConcernGraph ──────────────┤                              │
    │                              │                              │
    │  score_review_effort(target) │                              │
    ├─────────────────────────────►│                              │
    │                              │  static signals → scorer     │
    │◄─ score, shouldDecompose ────┤                              │
    │                              │                              │
    │  propose_split(graph)        │                              │
    ├─────────────────────────────►│                              │
    │                              │  slice planner               │
    │◄─ SplitProposal ─────────────┤                              │
    │                              │                              │
    │  apply_split(proposal,       │                              │
    │              dryRun=false)   │                              │
    ├─────────────────────────────►│                              │
    │                              │  preflight (S1-S3, S10)      │
    │                              │  for each slice:             │
    │                              │    checkout new branch       │
    │                              │    apply hunks               │
    │                              │    commit                    │
    │                              │  push (force-with-lease)     │
    │                              │  gh pr create                │
    │                              ├─────────────────────────────►│ git+gh
    │◄─ created[], rolledBack ─────┤                              │
```

## Key technical decisions

### Schema-first types

Every type in `specs/01-common-types.md` becomes a Zod schema. TypeScript types are *inferred* from the schema (`z.infer<typeof X>`). This way runtime validation and compile-time types never drift.

```typescript
// src/schemas/types.ts
import { z } from "zod";

export const TargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), repo: z.string(), branch: z.string(), base: z.string() }),
  z.object({ kind: z.literal("diff"), content: z.string(), baseRef: z.string().optional() }),
  z.object({ kind: z.literal("pr"), repo: z.string(), number: z.number() }),
]);
export type Target = z.infer<typeof TargetSchema>;
```

### Heuristic risk scorer (v1)

Hand-tuned weighted-sum + sigmoid. Approximates MSR 2026 results. Swappable behind a `RiskScorer` interface:

```typescript
interface RiskScorer {
  score(signals: RiskSignals): number;  // 0..1
}
```

v1 ships `HeuristicScorer`. v2 swaps in `GBMScorer` trained on AIDev.

### Stable concern IDs

Concern IDs are `sha256(sorted(hunks.map(h => h.hash)))` truncated to 12 hex chars. This guarantees:
- Same hunks → same ID (idempotency for re-runs).
- Independent of LLM output text (which varies).

### Atomic apply via synthesized branches

We never modify the input branch. Every slice lands on a fresh branch named `untangle/{proposalId}/{index}-{slug}`. On failure, we delete those branches and the original is byte-identical.

### LLM call shape

One LLM call classifies up to 40 hunks. Prompt structure:

```
System: You classify code change hunks into concerns. Output JSON.
User: <hunks as compact representation> + <commit messages if available>
Schema: { concerns: [{ summary, kind, hunkIndices, dependsOn, confidence, risk }] }
```

JSON-mode + Zod validation. Retry once on schema mismatch.

## Test strategy

| Layer | Where | Style |
|---|---|---|
| **Acceptance** | `tests/acceptance/*.test.ts` | Test MCP tool inputs/outputs end-to-end. Fixture-based. May call real LLMs gated by env var; otherwise mocked. |
| **Unit** | `tests/unit/*.test.ts` | Pure logic — concern-graph, slice-builder, risk-scorer. No I/O, no LLM. |
| **Safety** | `tests/acceptance/safety-contracts.test.ts` | One test per §S1-§S10. Must always pass. |

Tests are written before implementation. The full suite is initially red. Implementation work brings it green.

## Open design questions to revisit

- **Caching of LLM responses.** Could save 50% on re-runs of the same diff. Adds disk state. Punt to v2.
- **Streaming responses from `apply_split`.** Long operation; user wants progress. Punt to v2 — for v1, JSON logs to stderr are enough.
- **Worktree-based application.** Could apply slices in a worktree, avoiding any risk to the user's checkout. Cleaner safety story; more complex implementation. Punt to v2.
