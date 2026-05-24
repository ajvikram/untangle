# Constitution

Design principles that override convenience. When in doubt, follow these.

---

## 1. Spec-first (SDD)

Every tool has a spec in `specs/` before any code exists. Specs define inputs, outputs, behavior, edge cases, and acceptance criteria. Code conforms to specs; not the other way around. Drift between code and spec is a bug.

**Rationale:** Without a spec, "done" is undefined. Specs let humans review intent, agents generate against a contract, and tests verify conformance.

## 2. Test-first (TDD)

For every spec, acceptance tests exist before implementation. Tests must be red (failing) before turning green. Refactor only when green.

**Rationale:** Tests written after code encode what the code happens to do, not what it should do.

## 3. The Circuit Breaker is non-negotiable

`score_review_effort` runs before `propose_split` in every agent-loop integration. PRs predicted under the effort threshold are returned unmodified with `shouldDecompose: false`. Decomposing trivial PRs is the fastest way to lose user trust.

**Rationale:** 28.3% of agent-authored PRs merge almost instantly (MSR 2026). Decomposing them is pure noise.

## 4. Concerns cap

A slice contains at most 3 concerns. Past 3, multi-label concern classification accuracy degrades materially (per arxiv 2601.21298). The `propose_split` planner enforces this hard cap.

**Rationale:** Research-derived empirical limit. Honor it.

## 5. Reversibility

`apply_split` is atomic. If any step fails — bad rebase, push rejection, network drop — every git ref it created is rolled back. The original branch is never modified in place; we work on synthesized branches and only fast-forward when the entire stack succeeds.

**Rationale:** Trust is broken by one lost commit.

## 6. Vendor neutrality

The MCP interface is the canonical surface. Direct CLI use is supported but secondary. The tool must work identically across Claude Code, Cursor, Codex, Devin, and any future MCP client.

**Rationale:** If we couple to one vendor, we die when that vendor builds it native.

## 7. Cheap predictions, expensive thoughts

Static-signal classifiers (gradient-boosted on patch size, file count, config edits) handle risk scoring. LLM calls are reserved for genuinely semantic work (concern classification, slice summarization). Never use an LLM where a regressor or a parser suffices.

**Rationale:** MSR 2026 hit AUC 0.957 with three integer features. Don't pay $0.10 per call for the same answer.

## 8. Credentials never travel

User code is sent to LLMs only when the user explicitly opts in per-call. Credentials (GitHub tokens, API keys) are stored in OS keychain, never in process memory longer than a single call, never logged, never sent to the LLM.

**Rationale:** Single biggest reason teams refuse to install agent tooling.

## 9. Observable by default

Every tool emits structured logs (JSON, single-line) with: tool name, target identifier, duration, token cost, decision rationale. Logs route to stderr to keep MCP stdout clean.

**Rationale:** Silent agent tools are unfixable agent tools.

## 10. Distribution is a feature

MCP registry submission is part of the definition of done for v1. So is a working demo recording. Code without distribution is a script.

**Rationale:** The MCP ecosystem rewards the first three tools in each category. Be one of them.

---

## Tradeoffs we accept

- **Slower iteration** (specs + tests before code). Net positive once we have two contributors.
- **More files** (specs + tests + code, three artifacts per feature). Net positive when an LLM is generating implementations and needs constraints.
- **Higher initial token cost** (spec writing, test writing). Net negative for solo dev; net positive when we onboard the next collaborator or come back in 3 months.

## Tradeoffs we reject

- "We'll write the spec after we know what works." No — that's documentation, not specification.
- "Tests slow us down." Untestable code slows us down more.
- "Just add the LLM call here, it's easier." LLM calls have a unit cost; regressors don't.
