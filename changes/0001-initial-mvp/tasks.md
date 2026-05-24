# Change 0001 — Tasks

TDD ordering. Each task lands a failing test before code, then minimal code to pass.

## Phase A — Foundations (no tools yet)

- [ ] **A1.** Zod schemas for all types in `specs/01-common-types.md` (`src/schemas/types.ts`).
- [ ] **A2.** Unit tests for schema parsing happy/sad paths.
- [ ] **A3.** `src/util/logger.ts` — structured JSON logger to stderr, redaction allowlist.
- [ ] **A4.** `src/util/timeout.ts` — `withTimeout` helper.
- [ ] **A5.** `src/util/hash.ts` — stable sha256 helpers for IDs.
- [ ] **A6.** `src/core/diff-parser.ts` — unified diff → `HunkRef[]` (no LLM).
- [ ] **A7.** Unit tests for diff parser (rename, binary, large hunks).

## Phase B — Pure-logic core

- [ ] **B1.** `tests/unit/concern-graph.test.ts` — DAG build, cycle detection, stable IDs (FAILING).
- [ ] **B2.** `src/core/concern-graph.ts` — make B1 green.
- [ ] **B3.** `tests/unit/risk-scorer.test.ts` — heuristic scorer on fixture signals (FAILING).
- [ ] **B4.** `src/core/risk-scorer.ts` — `HeuristicScorer` implementation. Make B3 green.
- [ ] **B5.** `tests/unit/slice-builder.test.ts` — slice planning, DAG topo sort, hard caps (FAILING).
- [ ] **B6.** `src/core/slice-builder.ts` — make B5 green.

## Phase C — Tool 1 & Tool 2 (read-only)

- [ ] **C1.** `tests/acceptance/score-review-effort.test.ts` — Circuit Breaker happy/sad on fixtures (FAILING).
- [ ] **C2.** `src/tools/score-review-effort.ts` — make C1 green. Implements §S5 (no LLM).
- [ ] **C3.** `tests/acceptance/analyze-diff.test.ts` — concern graph on fixtures (FAILING). Mock LLM.
- [ ] **C4.** `src/llm/redactor.ts` — credential filter + tests (§S4).
- [ ] **C5.** `src/llm/client.ts` — provider-agnostic LLM client with redaction.
- [ ] **C6.** `src/tools/analyze-diff.ts` — make C3 green using mocked LLM.

## Phase D — Tool 3 & Tool 5 (composition)

- [ ] **D1.** `tests/acceptance/propose-split.test.ts` (FAILING).
- [ ] **D2.** `src/tools/propose-split.ts` — make D1 green.
- [ ] **D3.** `tests/acceptance/summarize-slice.test.ts` (FAILING).
- [ ] **D4.** `src/tools/summarize-slice.ts` — make D3 green.

## Phase E — Tool 4 (mutation)

- [ ] **E1.** `src/core/ref-registry.ts` — tracks refs created in current call (§S1).
- [ ] **E2.** `src/core/git.ts` — simple-git wrapper with force-with-lease guard (§S2, §S3).
- [ ] **E3.** `src/core/gh.ts` — gh CLI wrapper with auth check.
- [ ] **E4.** `tests/acceptance/apply-split.test.ts` — dry-run, rollback, idempotency (FAILING).
- [ ] **E5.** `src/tools/apply-split.ts` — make E4 green.

## Phase F — Safety contracts

- [ ] **F1.** `tests/acceptance/safety-contracts.test.ts` — one test per §S1-§S10 (FAILING).
- [ ] **F2.** Iterate on tools and util layers until F1 fully green.

## Phase G — MCP server

- [ ] **G1.** `src/mcp.ts` — MCP server exposing all 5 tools via `@modelcontextprotocol/sdk`.
- [ ] **G2.** Integration test: spawn the server, call each tool over stdio, validate responses.

## Phase H — CLI + distribution

- [ ] **H1.** `src/cli.ts` — thin CLI wrapping tools for ad-hoc use.
- [ ] **H2.** README install/usage finalized.
- [ ] **H3.** Demo recording.
- [ ] **H4.** `npm publish` as `untangle@0.1.0`.
- [ ] **H5.** MCP registry submission.

## Definition of done for this change

- All acceptance tests green.
- All safety-contract tests green.
- Coverage ≥ 80% on `src/core/`.
- `npm publish --dry-run` succeeds.
- README has install + Claude Code config snippet.
- One real demo recording exists.

## Time estimate

Tight estimate, single-developer:
- Phase A-B: 3 days
- Phase C-D: 4 days
- Phase E: 3 days
- Phase F: 1 day
- Phase G-H: 2 days

Total: ~13 working days. Tag `v0.1.0` and ship.
