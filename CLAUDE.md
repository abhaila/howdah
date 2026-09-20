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
bun test                         # whole suite (1143 tests, ~3 min) — bun:test, happy-dom preloaded via bunfig.toml
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
bun cli/main.ts setup                        # create $HOWDAH_HOME's layout (config.json, runs/, repos/, attention/)
bun cli/main.ts runs | graphs | doctor
bun cli/main.ts reply <run-id> <text>        # answers the current ask, resumes if the runner died
bun cli/main.ts resolve-effect <run-id> <effect> happened|not-happened [--node <n>]
                                             # HOW-3: attest to an ambiguous side effect, then resume
bun cli/main.ts resume|pause|abort <run-id>  # pause/abort also interrupt a PROVEN live runner mid-turn
bun cli/main.ts jump <run-id> <node> [msg]   # move a dead run to a node, injecting an instruction
bun cli/main.ts up                           # supervisor: heartbeat + resume dead runs
bun cli/main.ts workspace add|add-github|remove|list
bun cli/main.ts new-graph <name> --kind doc|research|code|custom   # writes to $HOWDAH_HOME/graphs
bun cli/main.ts resume <run-id> --force      # break a runner lock whose holder is NOT this run's runner
bun cli/main.ts approve|send-feedback <run-id> [--proposal <id>]      # decide the current slice round
bun cli/main.ts comment <run-id> [--proposal <id>] <entity-id> <text> # pin a comment on a ghost
bun cli/main.ts redesign <run-id> <msg>      # re-extract and re-propose; msg also seeds the map
bun cli/main.ts map <dir> [--json]           # extract a system map standalone (map/cli.ts)
bun cli/main.ts metrics [--json]             # implement-slice vs implement-ticket value metrics
bun reviser/revise.ts <prompt-id>            # GEPA-style revision proposal → reviser/proposals/
bun reviser/revise.ts <_partial> --evidence-from <includer>      # partials need an includer's evidence
bun prompts/proposals.ts accept|reject <path> [reason]   # same guards the UI uses
bun reviser/eval/delivery-publish.eval.ts --score-only --stamp   # stamp an eval score onto the proposal
bun reviser/eval/slice-propose.eval.ts --score-only              # proposer eval (spends tokens; no baseline yet)
```

Env: `HOWDAH_HOME` (state root, default `~/.howdah`), `HOWDAH_STUB=1` (executors park
instead of spawning real agents — how tests and dry runs avoid spending tokens),
`HOWDAH_MODEL` (run-level model default), `HOWDAH_PORT` (viewer port, default 4711).

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
- **An operator's own graphs live in `$HOWDAH_HOME`, not in this repo.** `graphs/local.ts`
  scans `$HOWDAH_HOME/graphs/*.ts`, imports each and validates it; `graphs/registry.ts` merges
  them after the built-ins, which win a name collision. Two deliberate differences from the
  built-in registry. A broken local graph stops ITSELF — excluded from the catalog and
  reported with a reason — because one half-edited file must not brick the launcher for every
  other graph. And the compiler half of the validator does not reach it (it is outside the
  tsconfig `include`), so the loader checks the property `PromptId` was protecting — that
  every agent node names a prompt file that exists — and `graphs/typecheck.ts` runs the real
  tsc pass on demand. Local prompt ids are cast through one documented helper in the scaffold,
  since the generated union is built from this repo's `prompts/`. Loading imports a COPY in a
  FRESH temp dir: Bun's module cache ignores a `?v=` query and also caches a directory's
  listing, so neither re-importing the path nor a new sibling file picks up an edit. That is
  why a local graph cannot use a relative import.
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
  `{{> id }}` includes are expanded at pin time, so the pinned file is the text that is hashed
  and reconstructed; `run-started.pinned_includes` records every included prompt's version,
  and the library, proposals (stale-base) and reviser are include-aware.
- **Context writes publish on success.** `ContextStore` buffers writes during an attempt and
  publishes on `endAttempt("succeeded")`. Scope is declared per output and decides what a
  re-visit does: `sticky` (old value stays visible), `cleared` (veiled during the attempt,
  restored if it fails), `per-visit` (permanently invalidated when the writer re-enters).
  Undeclared writes and reads of unreadable keys throw — a throw here means an engine bug,
  because the validator proved the graph cannot cause it.
- **Side effects are exactly-once.** Executors wrap effects in `effects.claim()/done()`,
  which writes intent before and proof after. Intent without proof is *ambiguous*; `resume()`
  probes it and **parks rather than guesses** when the probe says `unknown`. The human is the
  probe of last resort: `resolve-effect <run> <effect> happened|not-happened` (CLI, and
  `POST /api/runs/:id/effects`) appends an additive `side-effect-resolved`, which replay
  honours both ways — `happened` counts exactly as a `side-effect-done`, `not-happened` clears
  the intent so the retry claims and runs it again. The attestation alone answers the park
  (`ReplayedState.answeredPark`), so `howdah up` resumes even if the spawned resume died. One
  resolution per ambiguous intent: it is decided and appended under the log lock, a repeat of
  the same verdict is idempotent, and the opposite verdict is refused naming the first.
- **Observed reality beats recorded state.** `engine/reconcile.ts` probes git before every
  node and the forge only before nodes that declare forge reads. No cached branch name is
  ever read. Intended-vs-observed disagreement is logged as a fact and surfaced, never
  auto-resolved; "no PR" and "forge unreachable" are distinct outcomes.
- **Nothing dead-ends silently.** A failed attempt, an exhausted condition set, `maxVisits`,
  or an ambiguous effect all *park* the run with a reason (`attention-raised`) and wait for a
  human. Parking is normal control flow, not an error path.
- **A harness that never started is not the agent's fault.** Agent executors read the CLI's
  own exit code: a process that died without speaking the protocol is classified by
  `engine/executors/harness-failure.ts`, not passed to the outputs check, or a logged-out CLI
  would be reported as the model violating its contract. Auth failures park as
  `harness-unauthenticated` and carry the CLI's stderr tail into the log, because the fix is a
  human logging in (`claude -p` has no TTY to do it through) and the run has to say so.
  `doctor` asks each harness `auth status` / `login status` — being on PATH is not being
  logged in.
- **Attention is durable before it is delivered.** `engine/attention.ts` writes the record,
  then notifies; `watchdog/check.ts` runs outside the process (launchd, 60s) so `kill -9`
  with an ask pending still rings, and a stale heartbeat is itself an attention event.
- **Human gates read decision events, never `attention-resolved`.** `resume()` auto-resolves
  every standing park, so an approval that trusted `attention-resolved` would let any resume
  through. `engine/slice-decision.ts` is the only place that answers "what is the current
  proposal round, and what was decided" — the approval executor, the `requires` gate, replay
  and the routes all call it. Decisions are round-keyed (`proposal_id`), idempotent and
  appended with `EventLog.appendIf` under the log lock.
- **Visit numbers are identity; budgets are floors.** `${node}#${visit}` attempt ids,
  side-effect attempt ids and the viewer's `node@visit` rows rely on visits only climbing.
  A `reset_budgets` operator-jump sets per-node floors; `maxVisits` counts above the floor.
- **One writer at a time, one runner per run.** Log appends take an O_EXCL lockfile and read
  the tail seq from the file (`log/write.ts`, `log/lockfile.ts`); `runner.pid` is an
  identity lock (`<pid> <start>`), broken only when the holder is provably dead or reused,
  and pause/abort signal only a proven runner (`engine/control.ts` interruptRunner). Nothing
  reads `runner.pid` as a bare PID.
- **The map never presents a guess as fact.** `map/` is the syntactic tier: every entity and
  edge carries its tier and file:line evidence; duplicate identity keys are ambiguous and
  never verify; route mounts resolve only through a unique, same-project Kotlin reference
  (MountResolver rules U1–U16); anything unproven is `unresolved` / `not-checked` with a
  reason. Drift (`map/drift.ts`) says `verified` only with proof and `missing` only after a
  fully covered search with no near match; snapshots from different extractor versions or
  uncommitted changes are never judged. Cross-project resolution is left to SCIP (slice 2).
- **Agent config resolves in one place.** `resolveAgentConfig` (`engine/run.ts`, also what
  the viewer's graph API shows) over `core/graph.ts` resolveAgentConfigLayers: Claude→Codex
  fallback → run override → UI node tuning (`tuning.json`) → TS node setting → UI graph
  tuning → TS graph default. The model is the first one that fits the resolved harness (model
  names are harness-specific and a leaked one is an API 400); Claude always runs in `auto`
  permission mode, Codex in a full-access sandbox. `readOnly: true` is applied last and beats
  everything, the fallback included: `plan` for Claude, a read-only sandbox for Codex.
- **A harness fallback is a new visit, rendered for the harness that runs it.** When Claude's
  allowance is exhausted (or the attempt reads as rate-limited) the engine retries the node on
  Codex as a fresh visit — not charged to `maxVisits` — so its `prompt-rendered` carries the
  Codex harness and no skill hint, and reconstructs VERIFIED.

### Module map

| Path | Role |
|---|---|
| `core/` | graph schema (`graph.ts`), path validator (`validate.ts`), context store, template/render contract (`template.ts`), generated `prompt-ids.ts` |
| `graphs/` | the runnable graphs + `index.ts` registry, `local.ts` (the operator's own, from `$HOWDAH_HOME`), `registry.ts` (merged catalog), `typecheck.ts` (tsc gate); `implement-ticket`, `implement-slice` (design on the map → approve → build → drift), `improve-codebase`, `review-teammate-pr`, `write-doc`, `research`, `quick-task`; `delivery.ts` shared publish/repair half |
| `map/` | the code-derived system map (syntactic tier): tree-sitter extraction (`extract.ts`, `facts.ts`, `adapters.ts` + `queries/`), content-addressed store, `assemble.ts` (identity keys, MountResolver), `ghosts.ts` (GhostSet validator), `drift.ts`, `neighbourhood.ts` |
| `prompts/` | one `.md` per prompt (front-matter `id`/`version`), codegen, `store.ts` (load/list/accept with stale-base + undeclared-read guards), `proposals.ts` (lifecycle + review view), `library.ts` (read model: consumers, feedback, outcome join, render reconstruction) |
| `log/` | event union (`events.ts`), durable JSONL writer, view-time `coalesce.ts` |
| `adapter/` | pure harness → `AgentEvent` mappers (`claude.ts`, `codex.ts`, `opencode.ts`), chunk-safe `parse.ts`, `capabilities.ts` matrix |
| `engine/` | `run.ts` (loop, routing, pinning, effects, attribution), `replay.ts`, `reconcile.ts` (git probes + worktree fingerprint), `attention.ts`, `control.ts` (replies, decisions, runner lock), `slice-decision.ts`, `slice-map.ts`, `executors/` |
| `cli/` | `main.ts` verbs, `new-graph.ts` scaffolder (writes into `$HOWDAH_HOME`) |
| `config/` | `config.json` workspaces + settings, `tuning.json` overlay, GitHub repo registration |
| `web/` | Bun server (read model + reply/launch/control writes, SSE), `derive.ts` read model, React app in `app/`: `main.tsx` is the shell/nav/router only, screens in `app/screens/`, run-detail panes in `app/run/`, primitives in `app/components/ui/`, helpers in `app/lib/` |
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

Agent nodes get an **outputs contract** on the rendered prompt: the final line must be
`{"outputs": {...}}` with exactly the node's declared writes. It is generated from the graph
declaration and assembled with every other suffix (jump, reply, refusal, skill hint) in
`core/template.ts` *before* hashing, by versioned builders (`SUFFIX_VERSION`) — executors
send the prompt unchanged. Don't hand-write it in a prompt. If the final message still lacks
the contract, the claude and codex executors ask ONCE more on the same session/thread
(`executors/outputs.ts` buildRepairInstruction, same keys); that follow-up turn is outside
`rendered_hash` by design — the hash covers the first turn.

`approval` nodes (slice 1a) park `awaiting-approval` without consuming a visit and resolve
from decision events; agent nodes may declare `requires: { approvalOf }` (a pre-start gate
that also re-checks the live worktree fingerprint) and `readOnly: true` (plan mode that no
override can raise). Command built-ins beside `probe:pr`: `map:extract`, `map:reextract`,
`map:drift` (`engine/executors/map.ts`).

Routing: highest-weight passing condition wins; an unconditional edge is the weight-0
fallback; no matching edge parks the run (Orbital semantics), so exhaustive conditional sets
with no fallback are legal.

### Web app

`web/server.ts` is a read model over the same run logs plus a few writes (reply, launch,
pause/abort/resume/jump, open-in-IDE, open-run-folder, settings, tuning, feedback, proposal
accept/reject, slice comments/approval/redesign). Jump is spawned detached (it resumes the
run), so the route refuses in-process first with the CLI's own precheck (`jumpRefusal`). It binds 127.0.0.1 and `guardRequest()` runs before every
route: a foreign Host is refused (DNS rebinding), a foreign Origin on a write is refused
(CSRF), and a write body must be JSON.
`ServerOpts.repoRoot` overrides where `prompts/`, `feedback/` and `reviser/proposals/` are
read and written — tests must pass a temp root, or accepting a proposal mutates the repo. It never owns an engine loop —
launching spawns `cli/main.ts` detached. Live updates are SSE polling the log file. The
React app is bundled by `buildApp()` at server start into `web/public/app.{js,css}`
(gitignored); static responses are deliberately `no-cache`, since a stale cached bundle once
served an entire old UI.

UI conventions worth preserving: one canonical `RunStatus` enum with one renderer, and
**needs-input outranks failed** — a parked run waiting on a human is never shown as merely
failed. Design tokens (palette, type scale, motion) live in `web/public/tokens.css` +
`app/globals.css` and are decided in `shaping.md`'s Design section; tokens.css is the ONLY
place a hex or a `font-size: Npx` may appear. The components are shadcn patterns vendored and
rewritten onto those tokens — one file each under `app/components/ui/`, wired to `shadcn add`
by the root `components.json` and the `@/*` path in `tsconfig.json`. **No Radix**, ever:
`Select` is a styled native `<select>`, `Dialog` is the native `<dialog>`, and anything that
cannot be had without Radix is hand-written in the `cva` + `cn` pattern with its file header
saying so. Every interactive element goes through a primitive — a raw `<button>`, `<input>`,
`<select>`, `<textarea>` or `<label>` outside `components/ui/` is a test failure, and so is a
class emitted with no rule, a rule with no consumer, or a `title=` used as a tooltip
(`app/css-contract.test.ts`, `app/components/components.test.tsx`). Those two files exist
because the seam between the component layer and hand-CSS shipped two invisible defects
(`.tab.on` matching nothing, `.chip` with modifiers but no base rule) that nothing else could
see: TypeScript does not read CSS, and a missing rule renders as plain text.

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
