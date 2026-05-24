# untangle

> MCP-native PR decomposer for AI-generated diffs. Splits tangled commits into reviewable stacked PRs.

**Status:** 100% Complete — Implementation built and fully verified with test suite.

## Why

Median PR review time is up 441% in 2026 because AI coding agents produce diffs faster than humans can review them. Existing splitters (`pr-splitter`, Graphite, gh-stack) require humans to drive the split. `untangle` runs *inside the agent loop* via MCP, decomposing tangled diffs into a stacked PR series automatically — but only when decomposition is actually worth doing.

## What it does

Six core MCP tools and one unified orchestrator tool that decompose, score, route, and apply PR splits:

| Tool | Purpose |
|---|---|
| `score_review_effort` | Circuit-Breaker pre-check — skip trivial PRs |
| `analyze_diff` | Parse diff into a concern graph |
| `propose_split` | Generate an ordered stack proposal |
| `apply_split` | Materialize stacked commits/PRs (atomic, reversible) |
| `summarize_slice` | Generate PR body for each slice |
| `route_reviewers` *(v2)* | CODEOWNERS + blame routing |
| `decompose` *(v2)* | Unified orchestrator (runs all tools end-to-end) |

See [`specs/`](./specs/) for the contract.

## Install & Build

```bash
npm install
npm run build
```

## Register MCP Server

To use this server with your AI agent (Claude Code, Cursor, Antigravity, etc.), add it to your client's configuration file (e.g., `~/.config/Claude/claude_desktop_config.json` or `~/.gemini/antigravity/mcp_config.json`):

```json
{
  "mcpServers": {
    "untangle": {
      "command": "node",
      "args": ["/Users/ajaysingh/Ajay/ideas/untangle/dist/mcp.js"]
    }
  }
}
```

---

## How to Use

### 1. In Your AI Agent Chat (Natural Language Prompts)

Once registered, you do not need to run manual Git commands. You can simply prompt the agent in your chat window:

*   **To inspect how the tool plans to divide your work (Dry Run):**
    > *"Analyze my current branch changes using untangle and show me the split proposal."*
*   **To automatically stack commits, push branches, and create draft PRs:**
    > *"Decompose this branch with untangle and create the draft PRs."*
*   **To route reviewer recommendations:**
    > *"Recommend reviewers for the proposed slices of my branch changes."*

### 2. In Your Terminal (CLI)

You can also run `untangle` directly from your shell:

*   **Dry Run (inspect the plan):**
    ```bash
    node dist/cli.js decompose --repo . --dry-run
    ```
*   **Apply (stack commits, push branches, open draft PRs, assign reviewers):**
    ```bash
    node dist/cli.js decompose --repo .
    ```

---

## Design principles

See [`CONSTITUTION.md`](./CONSTITUTION.md). The short version:

1. **Spec-first.** Specs in `specs/` are the contract. Code conforms to them.
2. **Test-first.** Tests in `tests/` are written before implementation.
3. **Circuit Breaker.** Never decompose PRs that don't need it (~28% trivially merge).
4. **Concerns cap.** Max 3 concerns per slice. Past that, classification accuracy degrades (per arxiv 2601.21298).
5. **Reversible.** `apply_split` is atomic. On failure, the original branch is untouched.
6. **Vendor neutral.** MCP-first. Works with Claude Code, Cursor, Codex, Devin.

## Acknowledgments

Built on research from:

- "Detecting Multiple Semantic Concerns in Tangled Code Commits" (arxiv 2601.21298)
- "Early-Stage Prediction of Review Effort in AI-Generated Pull Requests" (MSR 2026 Mining Challenge, arxiv 2601.00753)

## License

MIT

