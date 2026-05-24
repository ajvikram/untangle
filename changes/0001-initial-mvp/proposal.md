# Change 0001 — Initial MVP

## Why

We have no shipping code. The specs are written, the constitution is set. This change establishes v0 and v1 — enough working code to demo decomposition end-to-end against a fixture diff, then enough to ship as an MCP server.

## What changes

**v0 (proof-of-life):**
- `analyze_diff` returns a real `ConcernGraph` from a fixture diff.
- `propose_split` returns a valid `SplitProposal` (dry-run only).
- No actual git mutation.

**v1 (MVP, shippable):**
- `score_review_effort` runs the Circuit Breaker with a heuristic-based scorer.
- `apply_split` materializes synthesized branches locally; PR creation gated behind `dryRun: false`.
- `summarize_slice` produces reviewer-ready PR bodies.
- MCP server exposes all five tools.
- npm-installable; works inside Claude Code via `mcpServers` config.

## Out of scope for this change

- `route_reviewers` (deferred to v2, spec already drafted).
- gh-stack backend (deferred until access lands).
- Sapling / Graphite backends.
- OpenSpec / Spec-Kit linkage in `summarize_slice`.
- Rust rewrite.
- Fine-tuned 14B SLM.

## Success criteria

1. Running the MCP server inside Claude Code, asking it to "decompose this branch" on a real 50-file AI-generated diff produces a stacked proposal in under 60 seconds.
2. The Circuit Breaker correctly rejects a trivial 1-line typo fix.
3. All acceptance tests pass.
4. All safety-contract tests pass.
5. Published to npm under `untangle@0.1.0`.

## Non-goals (worth saying out loud)

- Not aiming for SOTA concern detection in v1. A reasonable heuristic + Claude Sonnet is enough.
- Not building a UI. CLI + MCP only.
- Not handling monorepos with complex CODEOWNERS in v1.
