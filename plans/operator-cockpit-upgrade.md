# Operator Cockpit Upgrade

Generated: 2026-09-17
Status: Draft
Source: `shaping.md` A9.4

## Goal

Make the web UI the primary control surface for operating Howdah runs. The cockpit should let an operator understand what is happening, recover a stuck run, steer the next attempt, inspect artifacts, open a terminal in the right folder, and tune or create graphs without falling back to ad hoc CLI commands.

This is a product upgrade, not just a UI pass. The current web app is already the best read model over `run.jsonl`; the cockpit turns it into the place where operator intent is captured and replayable.

## Current State

- The run view is centralized in `web/app/main.tsx`.
- The server API is centralized in `web/server.ts`.
- Run state is derived from append-only logs in `web/derive.ts`.
- Pause, resume, abort, jump, reply, open IDE, and open run folder already exist as API actions.
- Graph metadata and tuning are exposed via `/api/graphs/:name` and `/api/graphs/:name/tuning`.
- Per-graph and per-node model tuning already lives in `$HOWDAH_HOME/tuning.json`.
- Chat is read-only today: it answers questions about the run digest but cannot steer the run.
- Persistence is currently file-backed, with the later SQLite plan captured under `shaping.md` B3.

## Non-Goals

- Do not replace the TS graph source of truth in the first cockpit slice.
- Do not build a browser-embedded shell before there is a safe local terminal session model.
- Do not make chat silently mutate a running turn. Steering should be explicit and logged.
- Do not hide the append-only run record behind mutable UI state.

## Architecture

The cockpit should introduce explicit operator-intent records rather than making UI state magical.

New event concepts:

- `operator-note`: human annotation attached to the run, node, or artifact.
- `operator-steer`: instruction intended for the next agent turn or a selected future node.
- `artifact-recorded`: a file, diff, PR, document, markdown report, or generated artifact discovered for review.
- `terminal-opened`: a terminal was spawned for the run/worktree, with cwd and command metadata.

The engine should consume `operator-steer` at node boundaries, similar to `operator-jump`, and inject it through the same prompt suffix path that already preserves jump instructions. If a steering message is attached to a specific node, only that node consumes it. If it is run-level, the next agent node consumes it once.

SQLite can later become the indexed/queryable home for these records. The first implementation can append to `run.jsonl` and derive the cockpit state from the log, preserving today’s storage model.

## Implementation Slices

### Slice 1: Recovery Cockpit

Effort: M. Risk: Low-Medium.

Build a fixed right-side recovery panel that makes the run’s liveness and next action obvious.

Features:

- Runner state: alive, dead, paused, parked, stale-running, finished.
- Supervisor state: heartbeat seen or missing.
- Recovery actions: resume, pause, abort, retry failed step, jump to selectable node, copy exact CLI command.
- Evidence: last event time, active node, run dir, worktree path, log path, current control file state.
- Empty states that say why a control is disabled.

Server work:

- Add `GET /api/runs/:id/recovery`.
- Factor existing persistence/liveness logic out of the detail route.
- Include `control`, `last_event_age_ms`, `active_node`, `runner_pid`, `supervisor_seen`, and suggested actions.

UI work:

- Replace scattered banners plus persistence rail with a single `RecoveryPanel`.
- Keep existing banners for high-signal global state, but make the panel the source of operational truth.

Tests:

- Web tests for dead runner, paused run, needs-input run, failed-recoverable run.
- UI smoke check that disabled actions show a reason.

### Slice 2: Steering Chat

Effort: M. Risk: Medium.

Split Chat into two modes: Ask and Steer.

Features:

- Ask remains read-only and cited.
- Steer writes an explicit operator instruction.
- Steering target options: next agent node, selected graph node, or current failed node retry.
- Submitted steering appears in Thread and Logs as an operator row.
- Resume/retry action can be paired with steering in one UI flow.

Server work:

- Add `POST /api/runs/:id/steer`.
- Validate target node against the graph.
- Append `operator-steer`.
- If requested, clear pause/control and spawn resume.

Engine work:

- Extend replay state to collect unconsumed steering messages.
- Inject matching steering into the next rendered prompt.
- Mark steering consumed with a follow-up event or deterministic replay rule.

Tests:

- Engine test: steer next node, resume, prompt includes instruction once.
- Engine test: targeted steer only applies to matching node.
- Web test: steer endpoint rejects unknown node and terminal node targets.

### Slice 3: Graph Templates And Model Bulk Edit

Effort: M-L. Risk: Medium.

Make graph creation and model-level changes easy without editing TS by hand.

Features:

- Graph templates screen with code, doc, research, review, and custom starts.
- New graph form calls existing scaffolder behavior through the server.
- Model matrix for a graph: rows are nodes, columns are harness, model, effort, permission mode, max turns.
- Bulk operations:
  - Set all planning nodes to best model.
  - Set all delivery nodes to cheaper model.
  - Switch graph default harness.
  - Clear node overrides.
- Diff preview before saving tuning.

Server work:

- Add `POST /api/graphs` wrapping `newGraph`.
- Add `POST /api/graphs/:name/tuning/bulk`.
- Keep structural editing out of scope for this slice.

UI work:

- Promote existing Graph tab tuning controls into a dedicated Graphs cockpit page.
- Show effective config and override source per node.

Tests:

- Existing tuning tests expanded for bulk updates.
- New graph endpoint test with `HOWDAH_STUB` or temp repo root.

### Slice 4: Artifact And Document Review

Effort: L. Risk: Medium.

Give every run a native review surface for the work it produced.

Features:

- Artifact rail: changed files, markdown reports, docs, PR links, diffs, screenshots, logs.
- Markdown viewer for generated docs and reports.
- Diff viewer for git changes.
- PR/comment review panel that shows what was addressed and what remains.
- Feedback buttons that attach notes to prompt/run/node/artifact.

Server work:

- Add `GET /api/runs/:id/artifacts`.
- Derive artifacts from context writes, worktree git status, PR observations, and known output paths.
- Add `GET /api/runs/:id/artifacts/:artifactId`.
- Keep file reads constrained to the run directory or worktree path.

UI work:

- Add an `Artifacts` tab.
- Add artifact cards in the right rail when relevant to the selected step.

Tests:

- Path traversal rejection.
- Markdown artifact render route.
- Diff artifact for a temp git repo.

### Slice 5: Terminal Spawn

Effort: M. Risk: Medium.

Open a terminal in the run worktree or run folder from the UI.

First implementation:

- macOS: spawn Terminal.app or the configured terminal command in the selected cwd.
- Linux: try `$TERMINAL`, then common terminals.
- No browser-embedded pty yet.

Server work:

- Add terminal command config to `config.json`.
- Add `POST /api/runs/:id/open-terminal`.
- Resolve target cwd as worktree path first, then effective cwd, then run dir.
- Append `terminal-opened`.

UI work:

- Add `Open terminal` beside `Open IDE` and `Open run folder`.
- Show exact cwd in the action tooltip or recovery panel.

Tests:

- Config validation.
- Endpoint resolves cwd correctly without actually launching in tests.

### Slice 6: Structural Graph Editor

Effort: L-XL. Risk: High.

This is the last slice because TS-native graphs are powerful but awkward to edit visually.

Recommended path:

- Start with graph drafts in a JSON intermediate format.
- Generate TS graph files from the draft.
- Validate generated graph using the existing graph validator.
- Keep hand-edited TS graphs supported.

Features:

- Add/remove nodes.
- Edit edges and conditions.
- Edit reads/writes and output scopes.
- Prompt selection per agent node.
- Compile/validate before saving.
- Save as new graph first; in-place graph mutation later.

Tests:

- JSON draft to TS generation.
- Invalid graph errors surfaced inline.
- Existing hand-authored graphs remain loadable.

## First Shippable Milestone

Ship Slices 1, 2, and the bulk-model-edit part of Slice 3.

Why this order:

- Recovery solves today’s operational pain.
- Steering fixes the “chat does not actually help me control the run” failure.
- Bulk tuning solves the Claude/Codex model mismatch and cost-level workflow pain without waiting for full structural graph editing.

Definition of done:

- A stuck run can be diagnosed and resumed from the UI without a CLI command.
- A run can be steered from Chat and the instruction is visible in Thread/Logs.
- A graph’s planning nodes and delivery nodes can be bulk retuned from the UI.
- All operator actions leave append-only evidence in the run log.

## Risks

- The UI can become too wide and busy. Mitigation: fixed cockpit panels, progressive detail, one primary action per run state.
- Steering can become ambiguous. Mitigation: every steering action has a target and appears as a logged operator event.
- Structural graph editing can fight the TS graph source of truth. Mitigation: defer arbitrary structural editing until a generated draft format exists.
- Terminal spawn can become a security footgun. Mitigation: local-only server, constrained cwd, no arbitrary command execution in v1.
- JSONL derivation will get slower as cockpit records grow. Mitigation: keep event shapes index-friendly now, then move to SQLite read models later.

## Implementation Tasks

- [ ] **T1 (P1, human: ~1d / CC: ~45min)** — recovery — Extract run liveness into a recovery read model and endpoint.
  - Files: `web/server.ts`, `web/derive.ts`, `web/web.test.ts`
  - Verify: `bun test web/web.test.ts`

- [ ] **T2 (P1, human: ~1d / CC: ~1h)** — recovery UI — Replace scattered operational status with a fixed `RecoveryPanel`.
  - Files: `web/app/main.tsx`, `web/public/howdah.css`
  - Verify: manual UI check on running, paused, failed, and harness-dead runs.

- [ ] **T3 (P1, human: ~1d / CC: ~1h)** — steering — Add `operator-steer` event, endpoint, replay handling, and prompt injection.
  - Files: `log/events.ts`, `engine/replay.ts`, `engine/run.ts`, `web/server.ts`, `engine/engine.test.ts`, `web/web.test.ts`
  - Verify: steering applies once to the intended agent node.

- [ ] **T4 (P2, human: ~1d / CC: ~1h)** — chat UI — Split Chat into Ask and Steer modes with explicit target selection.
  - Files: `web/app/main.tsx`, `web/public/howdah.css`
  - Verify: steer, resume, and logged operator row visible in one flow.

- [ ] **T5 (P2, human: ~1d / CC: ~1h)** — graph tuning — Add bulk model-level tuning operations.
  - Files: `config/tuning.ts`, `web/server.ts`, `web/app/main.tsx`, `web/web.test.ts`
  - Verify: planning and delivery nodes can be retuned independently.

- [ ] **T6 (P3, human: ~1d / CC: ~1h)** — terminal — Add configured terminal spawn from run/worktree.
  - Files: `config/config.ts`, `web/server.ts`, `web/app/main.tsx`, `web/web.test.ts`
  - Verify: endpoint resolves cwd and appends `terminal-opened`.

- [ ] **T7 (P3, human: ~2d / CC: ~2h)** — artifacts — Add artifact discovery and a native artifact review tab.
  - Files: `web/server.ts`, `web/app/main.tsx`, `web/public/howdah.css`, `web/web.test.ts`
  - Verify: markdown, diff, and PR artifacts render from a temp run/worktree.
