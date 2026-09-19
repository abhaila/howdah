# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Howdah is a single-user harness that runs *graphs* of agent work (write documents, do
research, write code, review code) against locally-installed `claude` / `codex` CLIs on
subscription auth — plus a feedback-driven loop that proposes prompt revisions a human
accepts or rejects. `shaping.md` is the authoritative design document: requirements (R*),
shape parts (A*), decisions (D*/OV-*), and the task list (T1–T22). Source comments
reference those IDs — when a comment says "OV-1" or "T18", `shaping.md` explains why.

Runtime: **Bun** (TypeScript, ESM, no build step for server/CLI code). No framework beyond
React + Tailwind for the viewer.

## Commands

```bash
bun install                      # required on a fresh clone (node_modules/ is gitignored)
bun test                         # whole suite (209 tests, ~9s) — bun:test, no extra runner
bun test engine/engine.test.ts   # one file
bun test -t "resume"             # one test by name
bun run check                    # tsc --noEmit + prompt-id codegen staleness gate
bun prompts/codegen.ts           # regenerate core/prompt-ids.ts after adding/removing a prompt
bun run web                      # bundle the React app and serve the viewer on :4711
bun run watchdog                 # one watchdog tick (normally driven by launchd)
```

`bun run check` shells out to `bunx tsc`, which runs under **node**, and TypeScript 7 needs
node ≥ 20. This machine has node 16 first on PATH, so the script fails with
`ERR_UNKNOWN_FILE_EXTENSION` until you do one of:

```bash
PATH="$HOME/.nvm/versions/node/v25.8.2/bin:$PATH" bun run check   # what shaping.md assumes
bun node_modules/typescript/lib/tsc.js --noEmit                   # typecheck only, via bun
```

CLI (there is no installed `howdah` binary — invoke the entrypoint):

```bash
bun cli/main.ts run <graph> -i goal=... -i work=... --workspace <name> [--model/--harness/--effort/...]
bun cli/main.ts runs | graphs | doctor
bun cli/main.ts reply <run-id> <text>        # answers the current ask, resumes if the runner died
bun cli/main.ts resume|pause|abort <run-id>
bun cli/main.ts jump <run-id> <node> [msg]   # move a dead run to a node, injecting an instruction
bun cli/main.ts up                           # supervisor: heartbeat + resume dead runs
bun cli/main.ts workspace add|add-github|remove|list
bun cli/main.ts new-graph <name> --kind doc|research|code|custom
bun reviser/revise.ts <prompt-id>            # GEPA-style revision proposal → reviser/proposals/
bun prompts/proposals.ts accept|reject <path> [reason]   # same guards the UI uses
bun reviser/eval/delivery-publish.eval.ts --score-only --stamp   # stamp an eval score onto the proposal
```

Env: `HOWDAH_HOME` (state root, default `~/.howdah`), `HOWDAH_STUB=1` (executors park
instead of spawning real agents — how tests and dry runs avoid spending tokens),
`HOWDAH_MODEL` (run-level model default).

## Architecture

Data flow for one run:

```
graphs/<name>.ts  ──▶ Engine (engine/run.ts) ──▶ executor per node kind ──▶ claude/codex CLI
       │                    │                         │
   core/graph.ts       ContextStore              adapter/ (JSONL → AgentEvent)
   core/validate.ts    (core/context.ts)              │
                            └──────────▶ EventLog (log/) ── run.jsonl ──▶ web/derive.ts ──▶ React viewer
```

State lives on disk only — no database. `$HOWDAH_HOME/{config.json, tuning.json,
heartbeat.json, attention/, repos/<repo>/worktrees/<run-id>/, runs/<run-id>/}`; a run dir holds `run.jsonl`
(append-only event log), `prompts/` (prompts pinned at start), `worktree.json`,
`control.json`, `runner.pid`.

### The load-bearing invariants

Break one of these and the design stops working, so check them before changing these files:

- **The log is the only storage.** `log/write.ts` fsyncs every append; readers tolerate one
  torn final line. Everything else — run status, thread, timeline, usage, context — is
  *derived* (`engine/replay.ts` for the engine, `web/derive.ts` + `log/coalesce.ts` for the
  UI). Never add a mutable sidecar record of something the log already implies; add an event
  type to `log/events.ts` instead. Events are never edited or deleted — late facts (a PR
  merged days later) arrive as follow-up events joined on `rendered_hash`.
- **Graphs are TypeScript, and the compiler is half the validator.** `defineGraph<Ctx>()`
  makes context keys, edge-condition reads, and prompt ids compile-checked. The other half is
  `Graph.validate()` + `core/validate.ts`: a forward MUST-analysis proving every read has a
  writer on *every* path from entry. `graphs/index.ts` validates every registered graph at
  import time, so a broken graph fails the registry rather than a run.
- **Prompt ids are generated, not typed by hand.** `prompts/<id>.md` (front-matter `id` must
  equal the filename) → `bun prompts/codegen.ts` → the `PromptId` union in
  `core/prompt-ids.ts`. Inline prompt text in a graph is a compile error by design.
- **The rendered prompt text is never stored — it is reconstructed and proven.**
  `prompt-rendered` carries `rendered_hash` + `context_read`, not the text.
  `reconstructRender()` (`prompts/library.ts`) rebuilds it from the run's pinned template
  and re-hashes to confirm; a mismatch is surfaced as UNVERIFIED, never shown as fact. This
  only holds because `core/template.ts` is the single render implementation — engine, prompt
  store and library all go through it. Change the substitution rules there, not in a copy.
- **Runs pin their prompts at start.** `Engine.pinPrompts()` copies each consumed prompt into
  the run dir and renders only from there; accepted revisions affect new runs only.
- **Context writes publish on success.** `ContextStore` buffers writes during an attempt and
  publishes on `endAttempt("succeeded")`. Scope is declared per output and decides what a
  re-visit does: `sticky` (old value stays visible), `cleared` (veiled during the attempt,
  restored if it fails), `per-visit` (permanently invalidated when the writer re-enters).
  Undeclared writes and reads of unreadable keys throw — a throw here means an engine bug,
  because the validator proved the graph cannot cause it.
- **Side effects are exactly-once.** Executors wrap effects in `effects.claim()/done()`,
  which writes intent before and proof after. Intent without proof is *ambiguous*; `resume()`
  probes it and **parks rather than guesses** when the probe says `unknown`.
- **Observed reality beats recorded state.** `engine/reconcile.ts` probes git before every
  node and the forge only before nodes that declare forge reads. No cached branch name is
  ever read. Intended-vs-observed disagreement is logged as a fact and surfaced, never
  auto-resolved; "no PR" and "forge unreachable" are distinct outcomes.
- **Nothing dead-ends silently.** A failed attempt, an exhausted condition set, `maxVisits`,
  or an ambiguous effect all *park* the run with a reason (`attention-raised`) and wait for a
  human. Parking is normal control flow, not an error path.
- **Attention is durable before it is delivered.** `engine/attention.ts` writes the record,
  then notifies; `watchdog/check.ts` runs outside the process (launchd, 60s) so `kill -9`
  with an ask pending still rings, and a stale heartbeat is itself an attention event.
- **Agent config resolves in one place.** `Engine.resolveAgentConfig`: run override → UI node
  tuning (`tuning.json`) → TS node setting → UI graph tuning → TS graph default. It also
  drops a model that clearly belongs to the other harness, because model names are
  harness-specific and a leaked one is an API 400.

### Module map

| Path | Role |
|---|---|
| `core/` | graph schema (`graph.ts`), path validator (`validate.ts`), context store, template/render contract (`template.ts`), generated `prompt-ids.ts` |
| `graphs/` | the runnable graphs + `index.ts` registry; `implement-ticket`, `improve-codebase`, `review-teammate-pr`, `write-doc`, `research`, `quick-task` |
| `prompts/` | one `.md` per prompt (front-matter `id`/`version`), codegen, `store.ts` (load/list/accept with stale-base + undeclared-read guards), `proposals.ts` (lifecycle + review view), `library.ts` (read model: consumers, feedback, outcome join, render reconstruction) |
| `log/` | event union (`events.ts`), durable JSONL writer, view-time `coalesce.ts` |
| `adapter/` | pure harness → `AgentEvent` mappers (`claude.ts`, `codex.ts`, `opencode.ts`), chunk-safe `parse.ts`, `capabilities.ts` matrix |
| `engine/` | `run.ts` (loop, routing, pinning, effects, attribution), `replay.ts`, `reconcile.ts`, `attention.ts`, `control.ts`, `executors/` |
| `cli/` | `main.ts` verbs, `new-graph.ts` scaffolder |
| `config/` | `config.json` workspaces + settings, `tuning.json` overlay, GitHub repo registration |
| `web/` | Bun server (read model + reply/launch/control writes, SSE), `derive.ts` read model, React app in `app/` |
| `reviser/` | GEPA-method revision script, eval case, generated proposals |
| `watchdog/` | out-of-process heartbeat/attention checker + launchd plist |
| `research/` | Orbital spec, feedback doc, DOT exports, UI captures — the inputs this design was built from |

### Node kinds and executors

`agent` (prompt through a harness), `command` (`bash -c`, facts from the final JSON line of
stdout, or the built-in `probe:pr`), `worktree` (`create`/`remove` under
`$HOWDAH_HOME/repos/<repo>/worktrees/` on a `howdah/<run-id>` branch, grouped by the
registered workspace name; a dirty worktree refuses to die),
`wait`, `terminal`. `engine/executors/index.ts` maps kind → implementation;
`liveExecutors()` dispatches `agent` on the resolved harness, `stubExecutors()` throws with
the gap named. Every executor resolves its cwd through `effectiveCwd()` so a run "moves
into" its worktree without the engine mutating state.

Agent nodes get an **outputs contract** appended to the rendered prompt
(`executors/outputs.ts`): the final line must be `{"outputs": {...}}` with exactly the
node's declared writes. Generated from the graph declaration — don't hand-write it in a
prompt.

Routing: highest-weight passing condition wins; an unconditional edge is the weight-0
fallback; no matching edge parks the run (Orbital semantics), so exhaustive conditional sets
with no fallback are legal.

### Web app

`web/server.ts` is a read model over the same run logs plus a few writes (reply, launch,
pause/abort/resume/jump, open-in-IDE, settings, tuning, feedback, proposal accept/reject).
`ServerOpts.repoRoot` overrides where `prompts/`, `feedback/` and `reviser/proposals/` are
read and written — tests must pass a temp root, or accepting a proposal mutates the repo. It never owns an engine loop —
launching spawns `cli/main.ts` detached. Live updates are SSE polling the log file. The
React app is bundled by `buildApp()` at server start into `web/public/app.{js,css}`
(gitignored); static responses are deliberately `no-cache`, since a stale cached bundle once
served an entire old UI.

UI conventions worth preserving: one canonical `RunStatus` enum with one renderer, and
**needs-input outranks failed** — a parked run waiting on a human is never shown as merely
failed. Design tokens (palette, typography, motion) live in `web/public/tokens.css` +
`app/globals.css` and are decided in `shaping.md`'s Design section; `ui.tsx` is shadcn
patterns mapped onto those tokens, with native `<select>` instead of a Radix dependency.

## Conventions

- Tests sit next to their subject (`engine/run.ts` → `engine/engine.test.ts`), use
  `bun:test`, and write into `mkdtempSync` dirs with `HOWDAH_HOME` pointed at them. Real
  agent spawns are avoided two ways: `HOWDAH_STUB=1`, or the `engine/executors/fake-claude.ts`
  binary that speaks the real stream-json wire protocol for executor tests.
  `adapter/fixtures/*.jsonl` are captured real turns — the chunk-boundary replay tests over
  them pin a bug that manifested as a permanent hang, so keep them.
- `tsconfig.json` is strict with `noUncheckedIndexedAccess`; the codebase leans on it
  (`m[1] !== undefined` checks rather than `!`), so keep new code checking indexed access.
- File-header comments explain *why* with shaping IDs. Match that when adding a module —
  they are the design's index, not decoration.
- Adding a harness = one mapper in `adapter/` + a `capabilities.ts` entry; nothing downstream
  of `AgentEvent` should need to change.
- Every task in `shaping.md` (T1–T22) is now built. The remaining known gap is that the
  reviser only runs from the CLI; the UI's re-draft button spawns it detached because it
  spends tokens. `HOWDAH_STUB=1` short-circuits that spawn, which is how the route is tested.

## Importable config from another agent

An OpenAI Codex config exists at `~/.codex/config.toml`. If you want its MCP servers,
commands, or instructions brought into Claude Code, reply `/import` to scan and list what's
importable, then `/import --yes=<digest>` (the scan output names the digest) to apply the
user-level items.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
