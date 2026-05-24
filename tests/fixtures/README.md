# Test fixtures

Real diff samples used by acceptance tests. Each fixture has:

- `*.diff` — the raw unified diff
- `*.expected.json` — the expected concern graph (truth set)
- `*.meta.json` — optional metadata (commit messages, language, source)

## Conventions

- File names describe the shape: `trivial-typo.diff`, `feature-with-refactor.diff`, `migration-only.diff`.
- One fixture per characteristic case in the acceptance specs.
- Fixtures should be small enough to review by eye but realistic in shape.

## Required fixtures for v1

| Fixture | Purpose | Used by |
|---|---|---|
| `trivial-typo.diff` | 1-file, 1-line typo fix | Circuit Breaker rejection |
| `feature-only.diff` | Single feature, single concern | Single-slice happy path |
| `feature-with-refactor.diff` | Mixed feature + opportunistic refactor | 2-slice decomposition |
| `feature-refactor-test.diff` | Three concerns | 3-slice decomposition |
| `mass-rename.diff` | 10k LoC pure rename | Hard case for risk scorer |
| `migration-only.diff` | Schema migration | Always high risk |
| `lockfile-only.diff` | Pure dependency bump | Circuit Breaker low score |
| `auth-touched.diff` | Small diff touching `**/auth/*` | Risk bias up |
| `cycle.diff` | Crafted to produce a DAG cycle | Error path |
| `binary-mixed.diff` | Binary + text changes | Edge handling |

## How to add a fixture

1. Drop the raw diff in this folder.
2. Hand-write the `.expected.json` per the schema in `specs/01-common-types.md`.
3. Add a test case referencing it in the appropriate `tests/acceptance/*.test.ts`.
4. Run `npm test`. The test should fail initially (red), then go green once the implementation handles the case.

## Where these come from

For v1 we will hand-curate fixtures from public AI-agent PRs (Claude Code session exports, Devin runs). For v2, derive automatically from the AIDev dataset (33,707 agent-authored PRs from MSR 2026).
