# An agent's environment (HOW-55) — spike result and policy

## The spike (2026-10-12, claude 2.1.296, haiku, an empty git repo)

The same headless prompt was sent twice, once with no flag and once with
`--setting-sources project,local`:

|                                  | default (user settings load) | `project,local` |
|----------------------------------|------------------------------|-----------------|
| SessionStart hooks run           | 5, before `init`, 4 injecting `additionalContext` | 0 |
| plugins in `init`                | 7                            | 3 (built-ins)   |
| skills in `init`                 | 143                          | 19              |
| user CLAUDE.md seen by the model | yes                          | no              |
| claude.ai MCP connectors         | listed                       | listed (account-level, not settings) |
| auth                             | works                        | works (keychain, not settings) |
| cost                             | $0.086                       | $0.035          |

Captures: `adapter/fixtures/claude-init-user-settings.jsonl` (hooks + init, with the
injected text, connector names and MCP tool names elided) and `claude-init-project-local.jsonl`.

## Policy

- Agents load project settings only by default. A workspace opts in with
  `howdah workspace user-settings <name> on`, and the opt-in is read on every attempt.
- Every attempt records `agent-environment` either way. That covers what `init` reported, the
  startup hooks and the context they injected (sha256 plus bounded text), and the hashes of the
  settings and CLAUDE.md files the harness could read. A run recorded before HOW-55 shows
  "not recorded".
- codex and cursor have no switch, so the files they read regardless (`core/harnesses.ts`
  `userConfig`) are hashed.
- A node that names a skill the session did not load is refused, with a reason that points at
  the opt-in. The skill is never silently dropped.
- `howdah doctor` lists the user hooks an opted-in workspace would inherit, or counts the ones
  that stay out.

Not closed by the flag: account-level MCP connectors, and the per-project auto-memory directory
(`init.memory_paths`). Both are recorded rather than controlled.
