# 00 — Architecture Overview

## Problem

AI coding agents (Claude Code, Cursor, Devin, Codex, Copilot Workspace) generate diffs faster than humans can review them. Median PR review time is up 441% in 2026 (DEV.to, MSR 2026 data). Diffs commonly entangle multiple concerns — a feature + opportunistic refactor + config drift + new tests — making them too conceptually large for thorough review. Existing splitters require humans to drive the split; that's the bottleneck.

## Solution

An MCP server that runs inside the agent loop. Six tools that:

1. Decide whether decomposition is even worth doing (Circuit Breaker).
2. Parse the diff into a concern graph.
3. Propose a topologically ordered stack of slices.
4. Materialize that stack as stacked commits/PRs (gh-stack / Sapling / Graphite / flat).
5. Generate reviewer-ready PR bodies for each slice.
6. (v2) Route reviewers per slice using CODEOWNERS + git blame.

## Architecture

```
┌──────────────── MCP Client (Claude Code, Cursor, Codex, Devin) ────────────────┐
│                                                                                │
│   user: "decompose my current branch"                                          │
│                                                                                │
└──────────────────────────────────┬─────────────────────────────────────────────┘
                                   │ JSON-RPC
                                   ▼
┌─── untangle (MCP server) ──────────────────────────────────────────────────────┐
│                                                                                │
│   ┌─ score_review_effort ─┐  static signals → gradient boosted classifier     │
│   │  Circuit Breaker      │  AUC 0.957 on MSR 2026 dataset                    │
│   └───────────┬───────────┘                                                    │
│               │ shouldDecompose: true                                          │
│               ▼                                                                │
│   ┌─ analyze_diff ─┐       tree-sitter parse → LLM concern classifier         │
│   │  Concern graph │       commit msgs as signal (+44% accuracy)              │
│   └───────┬────────┘                                                           │
│           ▼                                                                    │
│   ┌─ propose_split ─┐      topo sort under (≤3 concerns/slice, ≤400 LoC/slice)│
│   │  Stack proposal │                                                          │
│   └───────┬─────────┘                                                          │
│           ▼                                                                    │
│   ┌─ apply_split ─┐        atomic git+gh, synthesized branches, rollback safe │
│   │  Stacked PRs  │                                                            │
│   └───────────────┘                                                            │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                          git + gh CLI + gh-stack
```

## Staging

| Version | Scope | Ship target |
|---|---|---|
| **v0** | `analyze_diff`, `propose_split` (dry-run) | Local demo |
| **v1** | + `score_review_effort`, `apply_split`, `summarize_slice` | npm + MCP registry |
| **v2** | + `route_reviewers`, gh-stack, OpenSpec linkage | Anthropic MCP Hub |
| **v3** | Rust rewrite, GitHub App, fine-tuned 14B SLM | Conference / standardization |

## Tech choices and rationale

| Choice | Rationale |
|---|---|
| **TypeScript (v0-v2)** | MCP SDK maturity, fast iteration, distribution via npm. Matches pr-splitter audience. |
| **Rust (v3)** | Single-binary, performance, aligns with author's edge. Premature for MVP. |
| **tree-sitter** | Language-aware parsing, used by SemanticDiff. Polyglot support for free. |
| **Claude Sonnet (default LLM)** | Best concern classification quality at moderate cost. Provider-pluggable. |
| **simple-git + gh CLI** | Don't reinvent git. Shell out to battle-tested tools. |
| **Vitest** | Modern, fast, TypeScript-native test runner. |
| **Zod** | Runtime validation matches our spec-first ethos. |

## Non-goals

- Not a code-review *quality* tool (CodeRabbit, Greptile, Ellipsis own that).
- Not a source-control replacement (Sapling, Jujutsu own that).
- Not a stacked-PR primitive provider (gh-stack, Graphite own that — we *consume* them).
- Not language-specific. The concern model is language-agnostic; tree-sitter grammars are pluggable.

## Open architectural questions

1. **In-memory vector store vs persistent.** v0 uses in-memory only. Persistence helps cache concern detection across runs but adds complexity.
2. **Concern detection batch size.** Smaller batches = better accuracy, more LLM calls. Default: per-file hunks.
3. **Whether to fine-tune.** v0-v2 use frontier models. v3 may fine-tune a 14B SLM (per arxiv 2601.21298 — competitive with frontier on single-concern commits, dramatically cheaper).
