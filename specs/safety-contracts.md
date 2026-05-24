# Safety Contracts (Anti-Specs)

What `untangle` must **never** do, regardless of input. These are runtime-enforced invariants, not aspirations.

Every contract here has a corresponding test in `tests/acceptance/safety-contracts.test.ts`. If you remove or weaken a contract, you must update the spec, the test, and the constitution.

---

## §S1. Never delete unmerged work

`apply_split` must never delete a branch or ref it did not create in the current invocation. Pre-existing branches under `untangle/*` from prior runs are *replaced* via `--force-with-lease`, never blindly deleted.

**Enforcement:** All ref deletions go through a `RefRegistry` that tracks created-in-this-call. Deletions outside the registry throw `code: "REF_NOT_OWNED"`.

## §S2. Never force-push to the original branch

The branch named in `target` is read-only for the duration of `apply_split`. Even on rollback. Even on the user's explicit request — the user can do that themselves with `git`.

**Enforcement:** A pre-push hook in our git wrapper rejects pushes whose refspec matches `target.branch`.

## §S3. Never push without `--force-with-lease`

All pushes use `--force-with-lease`. We never `--force` raw. This prevents stomping on third-party commits when, e.g., a teammate pushed to an `untangle/*` branch in parallel.

**Enforcement:** The git wrapper has a single push entry point. `--force` without `--lease` is a compile error.

## §S4. Never send credentials to an LLM

GitHub tokens, npm tokens, env vars, `.env` files, and content of `~/.config/gh/` are filtered out of any LLM call. The filter runs *before* tokenization, not after.

**Enforcement:** The LLM client wraps prompts in a redactor (regex + path heuristics). The redactor has its own test suite. Failure to redact is a security bug.

## §S5. Never make an LLM call from `score_review_effort`

The Circuit Breaker is fast-path. An LLM call here defeats the purpose. Any code path in `score_review_effort` that imports the LLM client fails the lint rule.

**Enforcement:** Custom ESLint rule + module-boundary check in the build.

## §S6. Never produce more than `maxSlices` slices

Default 8. Configurable up to 16, never higher. A 20-slice stack is unreviewable; we'd rather merge concerns than overwhelm.

**Enforcement:** `propose_split` validates after planning; throws `code: "TOO_MANY_SLICES"` if exceeded.

## §S7. Never accept a `SplitProposal` from outside

`apply_split` only accepts proposals whose `meta.proposalId` matches `sha256(canonical(slices))`. This prevents an attacker (or a confused agent) from handing us a proposal that doesn't match its slices.

**Enforcement:** ID validation in `apply_split` preflight. Mismatch → `code: "PROPOSAL_TAMPERED"`.

## §S8. Never log credentials or full diffs

Logs go to stderr in single-line JSON. They include: tool name, target identifier (sha-prefix only), duration, decision rationale. They never include: file content, prompts, LLM responses, tokens, env vars.

**Enforcement:** Centralized logger with a redaction allowlist; raw `console.log` is banned in `src/`.

## §S9. Never block on the network on the hot path

`score_review_effort` and `analyze_diff` use git operations and (for `analyze_diff`) LLM calls — both can be slow. They must support timeouts, must return partial results when sensible, and must never hang indefinitely.

**Enforcement:** Every external call is wrapped in `withTimeout(promise, ms)`. Default timeout 30s; configurable per tool.

## §S10. Never assume the working tree is clean unless asserted

Every tool that reads git state calls `assertWorkingTreeClean()` first or accepts the dirtiness explicitly via `target.kind === "diff"`. Implicit assumptions about working state cause subtle bugs and lost work.

**Enforcement:** Pre-flight assertion in each tool's entry function.

---

## Test mapping

| Contract | Test |
|---|---|
| §S1 | `safety-contracts.test.ts::ref-registry-rejects-unowned-deletion` |
| §S2 | `safety-contracts.test.ts::push-rejects-original-branch` |
| §S3 | `safety-contracts.test.ts::push-uses-force-with-lease` |
| §S4 | `safety-contracts.test.ts::llm-redactor-filters-credentials` |
| §S5 | `safety-contracts.test.ts::score-effort-never-imports-llm` |
| §S6 | `safety-contracts.test.ts::propose-rejects-too-many-slices` |
| §S7 | `safety-contracts.test.ts::apply-rejects-tampered-proposal` |
| §S8 | `safety-contracts.test.ts::logger-redacts-sensitive-fields` |
| §S9 | `safety-contracts.test.ts::external-calls-have-timeouts` |
| §S10 | `safety-contracts.test.ts::tools-assert-clean-working-tree` |
