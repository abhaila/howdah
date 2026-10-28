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
React + Tailwind for the viewer, with THREE deliberate exceptions. The first two are admitted
on the same test — each buys a part that is expensive to own and cheap to borrow, its whole
dependency tree is small enough to name in a sentence, and it is confined to the files that
need it. The third, `@base-ui/react`, is the primitive layer's foundation and is a larger
commitment made on purpose; see the components section below for what moved onto it, what
deliberately did not, and why.

`@xyflow/react` (HOW-24) draws the graph builder's canvas. It is the library the ticket named
by reference, and it buys drag-to-connect with a live preview wire, edge hit-testing, pan/zoom
and marquee select. Its whole dependency tree is zustand, classcat and four d3 modules. It is
used ONLY under `web/app/builder/`, and its stylesheet is imported from `main.tsx` and never
pasted into the three hand-written sheets (see the CSS contract below).

`@shadcn/react` (HOW-27) is the headless half of `components/ui/message-scroller.tsx` and
`components/ui/questionnaire.tsx`, which make the run's Chat pane read like an agentic chat —
a transcript that holds the reader's position through streaming output, and a harness question
asked one at a time with the options numbered. It is 20KB across three files with **zero
runtime dependencies** and `react` as its only peer: the `base`, `radix` and `aria` flavours of
`questionnaire.tsx` are byte-identical apart from the button import, which is the proof that
the primitive under them is not a primitives library. Neither of the two imports
`@base-ui/react` even now that it is installed — they need nothing from it. Both were pulled with `shadcn add` and are kept verbatim but for a documented
deviation each (message-scroller substitutes four `scrollbar-*` utilities and `inset-s-*` that
the vendored shadcn layer does not carry, and retargets two `Button` defaults onto howdah's own
variant vocabulary). `components.json` therefore names a `base-*` style, and `cn` comes with
them: `web/app/lib/utils.ts` keeps clsx+tailwind-merge for the twenty older primitives, and
consolidating onto `cn` belongs with the rest of that migration.

`web/app/vendor/shadcn-tailwind.css` is shadcn's own Tailwind layer (`@utility`,
`@custom-variant`) that those two are written against — vendored rather than depended on,
because the package carrying it is the shadcn CLI: 310 packages for 16KB of CSS. It is
`@import`ed from `globals.css` because Tailwind has to process it, and it is deliberately NOT
in `css-contract.test.ts`'s scan list, for the same reason React Flow's sheet is not.

## Commands

```bash
bun install                      # required on a fresh clone (node_modules/ is gitignored)
bun test                         # whole suite (~2700 tests, ~10 min under load) — bun:test, happy-dom preloaded via bunfig.toml
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
bun cli/main.ts run <graph> -i goal=... -i work=... --workspace <name> [--name <text>] [--parent <run-id>] [--model/--harness/--effort/...]
                                             # --name: display label only (HOW-18); the run id stays identity
                                             # --parent: which run launched this one (HOW-23); lineage only
bun cli/main.ts setup                        # create $HOWDAH_HOME's layout (config.json, runs/, repos/, attention/)
bun cli/main.ts runs | graphs | doctor
bun cli/main.ts reply <run-id> <text>        # answers the current ask, resumes if the runner died
bun cli/main.ts resolve-effect <run-id> <effect> happened|not-happened [--node <n>]
                                             # HOW-3: attest to an ambiguous side effect, then resume
bun cli/main.ts resume|pause|abort <run-id>  # pause/abort also interrupt a PROVEN live runner mid-turn
bun cli/main.ts steer <run-id> <text>        # HOW-47: say something to a live agent; lands at its next tool call
bun cli/main.ts stop <run-id>                # HOW-48: soft pause — the agent stops at its next tool call
bun cli/main.ts waive <run-id> <criterion> <reason>   # HOW-51: accept an unmet acceptance criterion, on the record
bun cli/main.ts waive <run-id> --unprovable <reason> # HOW-59: waive every criterion this run cannot prove, at once
bun cli/main.ts jump <run-id> <node> [msg]   # move a dead run to a node, injecting an instruction
bun cli/main.ts up                           # supervisor: heartbeat + resume dead runs
bun cli/main.ts workspace add|add-github|remove|list|verify|preview|user-settings|package-check
                                             # preview <name> "<cmd>" --paths /,/x [--ready-when "<js>"] (HOW-52)
                                             # package-check <name> "<cmd>": exits 0 once this repo's package is out (HOW-57)
                                             # user-settings <name> on|off: agents load YOUR hooks/plugins/CLAUDE.md (HOW-55)
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
bun reviser/eval/ab.ts --cases reviser/eval/cases/implement-ticket --a <variant> --b <variant> [--stamp <proposal>]
                                             # HOW-42 paired A/B: a variant is a prompt/proposal file or a JSON
                                             # agent-config overlay; HOWDAH_STUB=1 is a token-free dry run
```

Env: `HOWDAH_HOME` (state root, default `~/.howdah`), `HOWDAH_STUB=1` (executors park
instead of spawning real agents — how tests and dry runs avoid spending tokens),
`HOWDAH_MODEL` (run-level model default), `HOWDAH_HARNESS` (run-level harness default, beats
config.json `defaultHarness`), `HOWDAH_PORT` (viewer port, default 4711).

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
- **The built-ins are migrating from `defineGraph` to a `GraphSpec` (HOW-31 B1,
  `docs/designs/graph-drafting.md`).** `implement-ticket`, `improve-codebase`,
  `review-teammate-pr`, `quick-task`, `write-doc` and `research` are now a `GraphSpec` literal
  compiled by `buildGraph`, so each carries its own spec and the builder can open it;
  `implement-slice` and `plan-feature` are still hand-written `defineGraph<Ctx>()`. A
  conversion is safe only if the compiled `Graph` is indistinguishable from the hand-written
  one: `graphs/spec-shape.ts` `shapeOf()` reduces a graph to everything the engine can
  observe, and `graphs/spec-equivalence.test.ts` pins it against
  `graphs/fixtures/pre-spec-shapes.json`, a snapshot taken BEFORE conversion. Do not
  regenerate that fixture to make a conversion pass — a diff there is the conversion changing
  behaviour.
- **A built graph is still a file; the spec is what is inside it (HOW-22, HOW-24).** The graph
  builder (`/graphs/new`, `/graphs/:name/build`) is now the primary authoring path, and it
  changes nothing downstream: it writes an ordinary local `.ts` whose body is a `GraphSpec`
  literal plus one `buildGraph()` call (`core/graph-spec.ts`), which `graphs/local.ts`
  imports, validates and gates exactly as before. `buildGraph` hangs the spec back on
  `GraphDef.spec` for an EXACT round trip — the builder never guesses a spec out of
  TypeScript, so a file it cannot re-parse reads as `builder: false` and is offered the
  source editor instead. There is ONE verdict, not two: `graphs/builder.ts` runs the same
  `specProblems()` the browser runs, over the spec it is about to write and BEFORE it writes
  anything, so "Ready to save" and a 422 cannot disagree and a refusal is phrased in the
  operator's words rather than `validate()`'s. The server stays stronger only where it must
  (a prompt id shadowing one of the repo's own; the real `loadLocalGraph` import). ONE verdict
  at TWO severities (HOW-26): `specProblems()` also returns `advice` — a graph that will load
  and run but is probably not what was meant (an unbounded loop, a field nothing reads, a
  Finish step nothing reaches) — and only the `blocking` half can refuse a save, so
  `graphs/builder.ts` filters through `isBlocking` and the canvas keeps advice off the picture.
  Two properties make the compiler unnecessary rather than bypassed:
  nothing is typed free-hand (keys come from the field registry, predicates are data, prompt
  ids are generated from step ids), and `core/graph-spec.ts` is NODE-FREE, so
  `buildGraph(draft).validate()` runs in the browser on every keystroke and `specProblems()`
  rewrites each `Violation` into the operator's words, attributed to the step AND the
  `ProblemPane` that fixes it. HOW-24 replaced the five-pane wizard with a CANVAS and kept that
  vocabulary untouched — `where` is named in ~40 messages in core/ and read by
  `graphs/builder.ts`, so re-spelling it for new UI regions would be editing core for a
  presentation reason. `web/app/builder/properties.tsx` maps instead, in one line: a problem
  that NAMES a step is drawn on that step's card and listed against it; one that names none
  belongs to the graph. An agent step's `reads` is never declared: it is derived from the prompt
  body with `templateReads()` — in the browser (`web/app/lib/spec-draft.ts`) and again on the
  server (`graphs/builder.ts`), which is the authority. So renaming a field rewrites the
  reference in the body (`renameTemplateRef`, still the one regex in `core/template-refs.ts`,
  so prose and a longer key that merely starts the same are untouched), and REMOVING a field
  a body still names is reported rather than papered over by editing the step's reads behind
  the text. What a step may declare it PRODUCES is data too (`emittableWrites`): the worktree
  and command executors publish a fixed set, the draft reducer normalises to it on every step
  edit, and `specProblems` refuses a declaration that could never be published — a
  `worktree.clean` on a "make" step is a `ContextError` at run time, not a style question.
  The verdict also covers whether the graph can DO anything, which is what "Ready to save"
  means: the starting step may not be a Finish step (refused in `core/graph.ts` `validate()`
  too, so a hand-edited module cannot load as a no-op graph, and the reducer's `pickEntry`
  never produces one), no step may be unreachable (builder-only, reported LAST so it never
  buries the dead end that caused it), and an operand must be able to MATCH its field —
  `unmatchableOperand` is `coerceOperand` read backwards, so `flag == ''` on a yes/no field is
  refused wherever it arrives from and the form seeds through the same rule. One fact a spec
  cannot carry is whether its NAME is free, so a save DECLARES `intent: "create" | "update"`:
  a create landing on an existing graph is a 409 before any write, and `nameTakenProblem` is
  the single place that sentence is written, fed the catalog in the browser and this one
  file's existence on the server. A GRAPH WRITES ONLY ITS OWN PROMPTS: every local prompt
  lives in one directory, so the `<graph>.<step>` prefix is the only thing keeping two graphs'
  instructions apart — `specProblems` refuses a step filed under another graph's id and
  `graphs/builder.ts` refuses the same id again at the write, since a create naming one
  rewrote that graph's prompt and returned ok. Two steps of ONE graph may still share a body,
  which is what a prefix rule permits and exact equality would not.
  Two consequences of the builder drawing and editing a draft rather than a finished graph.
  THE PICTURE NEVER ASSERTS: it draws a half-built shape, so an edge whose endpoint does not
  exist is SKIPPED rather than dereferenced — a run's shape is server-derived and consistent, a
  draft's is being typed ("go to [pick a step]"), and `web/app` has no error boundary, so one
  `!` took the wizard and the unsaved draft down with it. (`GraphDag` still reads that way for
  the run view and the tuner; React Flow simply does not draw an edge whose endpoint it cannot
  find.) What is missing is reported in words by the verdict, on the step that owns it. AND A BOX IS CONTROLLED BY
  MEANING, NOT BY SPELLING: the spec stores typed data on purpose (`3`, not `"3"`;
  `["pass","warn"]`, not `"pass, warn"`), so a control fed straight back from it destroys every
  intermediate keystroke the coercion trims. `useTypedText` (`web/app/lib/hooks.ts`) keeps what
  was typed while it still MEANS what the draft holds and follows the draft the moment it does
  not — which is why `3.5`, `-1` and a second comma-separated value are typeable at all.
- **The canvas is a view of the draft; the draft is the only truth (HOW-24).** The builder is a
  React Flow canvas (`web/app/builder/canvas.tsx`) with a palette on the left and a panel on the
  right that shows whatever is selected — a step, a route, or the graph. `specToFlow()` is a
  PURE function from the draft, and React Flow's own store is never asked what the graph is.
  Every gesture dispatches an EXISTING `spec-draft.ts` action, because each one carries a
  coupled rule a new creation path would otherwise have to remember — and it was a creation path
  forgetting one that produced HOW-22's finding 3. So a WIRE IS BORN ABLE TO FIRE: `add-edge`
  makes the first route out of a step its unconditional "Otherwise" and every later one a
  condition seeded through `seedPredicate()`, the same function "Add a condition" calls, and it
  APPENDS — which is what keeps row order, and therefore weight, meaning what the operator saw.
  A drag commits `move-node` on drag END, never per frame, so one drag is one draft change
  rather than sixty `draftProblems()` runs a second — but that only works because
  `onNodesChange` IS supplied: React Flow's `triggerNodeChanges` applies a change only when it
  owns the nodes, so a controlled `nodes` with no handler discards every one of them and the
  card never follows the pointer at all. `canvas.tsx` keeps the frames of a drag in a local
  overlay and lets only the settled change reach the draft. AND THERE IS NO DELETE KEY:
  `deleteKeyCode` defaults to Backspace bound on `document`, and its input exemption covers
  form controls but not the `Button` that is the way into a step, so destroying a step — which
  takes its prompt body with it, with no undo — is a named control in the panel that says what
  goes, and asks first when the text cannot be got back. An edge has no identity of its own, so the
  canvas addresses one by its INDEX in `spec.edges`, and that needs TWO things, not one. The two
  edit paths are never on screen together (a step's whole routes list is `set-branching`, which
  may renumber; a single selected edge is `update-edge`, which cannot). AND WHATEVER RENUMBERS
  THE LIST DROPS THE SELECTION ITSELF: `remove-edge` slides every later edge down one — an index
  list has no other way to shrink — so the edge panel calls `onRemoved`, the same callback the
  step form already had, and the shell closes it. Without that the panel stayed open, silently
  retargeted to the route that slid into that index, and a second press destroyed a route nobody
  selected. The shell's own "a selection that no longer exists is a panel to close" still runs,
  but it only ever catches the LAST edge. A PANEL THAT REBUILDS A COLLECTION MUST DRAW ALL OF IT:
  `set-branching` substitutes a step's whole outgoing list, so `StepRoutes` renders one
  "Otherwise" row per unconditional route rather than one row full stop. A second "Otherwise" is
  legal to MAKE (two wires from one step on a fields-less draft, or "Make this the 'Otherwise'"
  twice) and `specProblems` refuses it in the operator's words on that step — and the panel that
  printed the refusal was deleting the row it was about on the next edit.
  A step's PLACE is part of the artifact (`NodeSpec.position`): a canvas whose boxes spring back
  on reload is not a canvas, and a sidecar keyed by graph name would split the artifact in two
  and break the round trip. `parseNode` accepts only two finite numbers (NaN serialises to
  `null`, and a spec that cannot round-trip through JSON is not a spec) and `compileNode` drops
  it, so the engine sees the identical `Graph` — pinned in `core/graph-spec.test.ts`.
  `web/app/lib/layout.ts` holds the ONE layered-BFS placement, shared with `graph-dag.tsx` so
  the builder and the run view do not draw one graph two ways; only the PITCH differs, because
  the canvas prints a condition IN the gap between two cards rather than beside the wire.
  NOTHING BECAME MOUSE-ONLY (HOW-16 P2 is not given back): every palette item is a `Button` that
  is also `draggable`, every step's routes can be set from its panel without drawing a wire, the
  way into a step is a real control on its card rather than the card itself, a wire's
  caption is a `Button` — a hairline is not a click target — and a step is MOVED without a
  mouse: Tab to its control, Enter to select it, then the arrow keys (Shift for 4x). React Flow's stylesheet is imported
  from `main.tsx` and NEVER pasted into `tokens.css`/`howdah.css`/`globals.css`: those three are
  scanned in both directions by `app/css-contract.test.ts`, and a few hundred unconsumed vendor
  rules would fail "every rule has a consumer" instantly. The canvas is themed by setting React
  Flow's own custom properties from tokens, under `.gb-canvas`.
- **Prompt ids are generated, not typed by hand.** `prompts/<id>.md` (front-matter `id` must
  equal the filename) → `bun prompts/codegen.ts` → the `PromptId` union in
  `core/prompt-ids.ts`. Inline prompt text in a graph is a compile error by design.
- **Render rules are versioned like suffixes (HOW-37).** `prompt-rendered.render_version`
  (absent = v1) picks the substitution rules; v2 elides a value over `contextCap` (default
  64000, from real logs) around a stub naming its producer, gives `| dump` one meaning, refuses
  unknown filters, and adds the one `{{#if context.key}}` block (HOW-44). The cap applies to
  rendered text only — stored values and edge conditions see the whole value. Never change v1.
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
  auto-resolved; "no PR" and "forge unreachable" are distinct outcomes. A CHECK HAS FAILED ONLY
  WHEN ITS LATEST RUN SAYS SO (`checksFailed`, engine/executors/worktree.ts): a force-push
  leaves each check's superseded run CANCELLED beside the new run still in progress, and read
  flat that was `CI_FAILED` ninety seconds after a publish — fix_ci on a verdict CI had not
  given, seven times on one run. Rows group by name, a pending run means no verdict, the newest
  run decides, and a cancelled run is waited on like a reviewer, never repaired. AN UNREACHABLE
  FORGE ON A READ IS RETRIED, NOT ASKED (HOW-69): `probe:pr` throws a typed
  `ForgeUnreachableError` (engine/executors/git.ts; "no PR" stays a null answer), and the engine
  re-runs that node after 30s, 2m and 5m (`FORGE_RETRY_BACKOFF_MS`), logging `forge-retried`
  each time and counting the budget from the log, before it parks `executor-threw` as before.
  The operator's pause or abort wins at once. `runs:await` needs none of this — it already waits.
  A REVIEW COMMENT IS A REVIEW (HOW-70): the operator opens every Howdah PR and so can never
  request changes on it, so `probe:pr` also reads reviews, PR comments and unresolved threads
  (one `gh api graphql`) and routes CHANGES_REQUIRED on any newer than the last address_reviews
  start — a cutoff read from the log, never stored (`core/review-activity.ts`). Howdah's own
  replies end with `REVIEW_REPLY_MARKER` (the address_reviews prompt says so) and bots never
  count; a failed read is `ForgeUnreachableError`, never "no new activity".
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
- **Context exhaustion is a park, not a hop (HOW-14).** A turn whose context window filled
  fails `context-exhausted`, decided by the ADAPTER from the harness's own signal (claude's
  `Prompt is too long` result, codex's `contextWindowExceeded`) and flagged on `turn_end`, so
  no executor re-reads error text. It never takes the allowance fallback — another harness
  does not make the window bigger — and that is guarded twice: explicitly in the failure
  branch, and in `priorLimitFailureHarnesses`, because the hop's evidence is a regex
  (`RATE_LIMIT_TEXT`, `engine/executors/harness-failure.ts`) over the attempt's transcript,
  and an agent writing rate-limiting code says "rate limit". The wording written for this case
  is pinned against that same regex. The node's next attempt is rendered with a re-entry
  briefing (suffix v4: orient with git, continue rather than restart, commit as you go; v5 adds
  the HOW-36 handoff — files, commands, last intent — derived by `engine/handoff.ts`),
  derived from the log and logged as `reentry_after_visit`, so a resume in a fresh process
  briefs it identically and reconstruction stays VERIFIED. HOW-43: the engine itself continues
  once (`contextRetries`, default 1, logged as `context-continued`) before it parks, unless the
  operator paused, an effect is ambiguous, or the retry made no progress. A mid-turn compaction is only a
  transcript line. A FAILED codex `turn/completed` is a turn error now — it used to read as
  success and blame the model with "output contract violation". Cursor and opencode have no
  verified signal and keep degrading to `attempt-failed` with the CLI's own words.
- **A harness question reaches a human, or the run says why it did not (HOW-25).** An
  `AskUserQuestion` is NOT a permission: it arrives as a `can_use_tool` carrying
  `requires_user_interaction`, and the CLI's response schema (`allow` + `updatedInput`, or
  `deny` + `message`) has no result field, so the operator's choice travels in the deny
  `message` — answering `allow` runs the tool with nobody to ask and silently returns "The
  user did not answer the questions." `core/ask.ts` is the ONE place that payload is read and
  an answer is written back; it is node-free because the browser draws the card from it, and
  every parser returns `null` instead of throwing, so a harness that changes shape degrades to
  the free-text reply rather than crashing a run or a render. The question goes INTO the park,
  so the banner, the notification and the attention inbox quote what is being asked instead of
  "AskUserQuestion needs permission". Answering is mid-turn on the same session: the agent
  carries on rather than restarting the node. And nothing waits in silence — `awaitOperator`
  (engine/executors/claude.ts) is the single wait behind both kinds of mid-turn ask and ends
  in exactly one of an answer, a harness that exited underneath it, or a configured ceiling.
  The wire shapes are pinned in `adapter/fixtures/claude-ask-user-question.jsonl` and probed
  against claude 2.1.278; the CLI's own `request_user_dialog` channel is NOT used, because
  under `-p` it belongs to its cloud host and declaring a kind we cannot draw is worse than
  declaring none. CODEX: every server→client request is answered or the turn hangs. The
  app-server has ten request kinds (0.162.1 schema) and the executor answered two; a run sat
  ten hours inside `mcpServer/elicitation/request` (the ChatGPT Linear connector asking to be
  reconnected — `adapter/fixtures/codex-elicitation.jsonl` is the capture) with a transcript
  that showed nothing, because only commandExecution/fileChange items were drawn. Now
  `adapter/codex.ts` maps EVERY item with an id to a tool call (mcpToolCall, the code-mode
  `exec`, webSearch…), so the transcript and the HOW-38 stuck detector see them; a
  `request_user_input` question is the same `user-question` park and card, answered in codex's
  own shape (schema-derived, pinned by `fake-codex.ts`); a `url` elicitation parks
  `mcp-elicitation` quoting the message and the link (any non-refusal = accept, a refusal =
  decline, a `form` mode is declined at once with a note); `item/permissions/requestApproval`
  answers with the profile GRANTED, not a `{decision}`; and any kind the adapter does not model
  is refused on the wire with a JSON-RPC error naming it. Replies go back under the id's wire
  TYPE (a numeric string becomes the number again). A park the harness dies under, or that
  outlives `askTimeoutMs`, fails the attempt with that reason. AND ONE CONNECTION CARRIES MANY
  THREADS: codex's `multi_agent` feature (stable, on in 0.162.1) lets the model `spawn_agent`
  sub-threads whose notifications arrive on the same stdio connection under their own
  `threadId`, so the executor keys everything on the thread it opened — a sub-agent's
  `turn/completed` never ends the attempt's turn, its deltas are never the attempt's text, and
  its finished report is a tagged note in the transcript, never the final message the outputs
  contract is read from (`FAKE_CODEX_SUBAGENT` pins it). A three-reviewer turn used to end on
  the first reviewer's report and fail the contract with three reports interleaved word by word.
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
- **Every per-harness fact lives in `core/harnesses.ts`.** Binary, login verb, auth probe,
  model family, skill hint, forced permission mode, effort levels (HOW-33: an effort a harness
  cannot take is reported inert, never dropped), tool flags (HOW-41: a restriction the harness
  cannot honour parks `tools-unsupported`), edit hooks (HOW-39), and whether doctor treats it as `core` /
  `optional` / `internal` — one record per harness (claude, codex, cursor, opencode). It used
  to be a `harness === "codex" ? … : …` ternary repeated in six files, and the one a new
  harness slipped past was silent: it would have inherited claude's skill hint, so the logged
  `skills` would describe a prompt that was never sent. The module is node-free and
  dependency-free because the browser bundle imports it (the viewer's harness picker).
- **Agent config resolves in one place.** `resolveAgentConfig` (`engine/run.ts`, also what
  the viewer's graph API shows) over `core/graph.ts` resolveAgentConfigLayers: chain
  fallback → run override → UI node tuning (`tuning.json`) → TS node setting → UI graph
  tuning → TS graph default → config.json `defaultHarness` (`HOWDAH_HARNESS` beats it for one
  run). The model is the first one that fits the resolved harness (model names are
  harness-specific and a leaked one is an API 400, and cursor is the one harness that
  genuinely serves other providers' models); a harness's own permission mode wins where it
  declares one — Claude always runs in `auto`, Codex in a full-access sandbox, cursor with
  `--force`. `readOnly: true` is applied last and beats everything, the fallback included:
  `plan` for Claude, a read-only sandbox for Codex, no auto-approve flag for cursor.
- **A parent launches children exactly-once; it never supervises them (HOW-23).** The
  `runs:launch` built-in fans a `plan-feature` decomposition out into one run per approved
  slice — ALL at once — and then the parent FINISHES. A child is an ordinary independent run
  — own worktree, own branch, own PR, own park — and `run-spawned` + `run-started.parent` are
  lineage, not control: nothing routes on them and no cached status of a child is ever stored,
  because the child's own log is the authority on what it did. Launching is the most expensive
  side effect in the system, so it is guarded three deep: NOTHING is spawned until the plan
  re-validates, every slice, ticket and workspace lines up, AND THE NODE'S OWN DECLARATION
  CHECKS OUT — the step reads `plan.slices` + `tickets` (the built-in names them; extra reads
  are legal) and publishes `launched` and nothing else, both refused in `precheck()` before the
  first spawn, because `declaredWrites` throws after the loop and a half-launched fan-out is
  duplicate PRs and a second allowance. Both halves are in `core/graph-spec.ts`'s
  `COMMAND_BUILTINS` too, so the HOW-22 builder gates a step on them while it is being typed;
  `core/` cannot import an executor, so `graphs/builder.test.ts` pins the repetition and fails
  if any built-in the command executor dispatches is missing from the table. Child ids are
  deterministic (`<parent>--<slice id>`,
  which is why `graphs/slice-plan.ts` makes the slice id a path-safe slug) so a re-attempt sees
  the run dir and skips; and `effects.claim`/`done` wraps each spawn, so a death between them
  parks for `resolve-effect` rather than guessing. One argv builder (`core/launch-args.ts`)
  serves both this and the viewer's launch route — they are the only two things that start
  runs, and a flag added to one must not be missing from the other.
- **Nothing watches a turn burn silently (HOW-38).** `engine/executors/stuck.ts` hashes every
  tool call's FULL arguments before the 400-char clip; 5 identical calls warn
  (`stuck-warning`), 8 identical FAILING calls park `stuck`; `turnTimeoutMs` parks
  `turn-timeout`. Both kill the harness's process group and never hop harnesses.
- **Usage never turns unknown into zero (HOW-34).** `log/usage.ts` is the one rollup (per
  node@visit and run): absent figures are unknown, an unpriced harness makes cost `partial`,
  claude's cumulative `total_cost_usd` is recorded per turn, and the outputs repair is turn 2.
  `log/trajectory.ts` derives each visit's behavioural profile by rule (HOW-35).
- **A harness fallback is a new visit, rendered for the harness that runs it.** When a
  harness's allowance is exhausted (or the attempt reads as rate-limited) the engine retries
  the node on the next harness in the fallback chain (claude → codex → cursor by default,
  reorderable in config.json) as a fresh visit — not charged to `maxVisits` — so its
  `prompt-rendered` carries the harness that ran and that harness's skill hint, and
  reconstructs VERIFIED. The chain is an ORDER, not a successor map: it skips a harness this
  run has already spent, so "claude is out and so is codex" lands on cursor instead of
  parking.

- **An agent's environment is chosen and recorded (HOW-55).** `rendered_hash` proves the
  prompt; the rest of an agent's input is its settings. Claude agents run with
  `--setting-sources project,local` unless their workspace opts in (`workspace user-settings`),
  so the operator's user-level hooks, plugins and CLAUDE.md stay out by default. Every agent
  attempt appends `agent-environment`: the sources, the hooks that ran before `init` and the
  context they injected (hashed), skills, plugins, MCP servers, and hashes of the settings and
  CLAUDE.md files it could read (engine/executors/agent-env.ts). codex and cursor have no switch,
  so their `userConfig` is hashed instead. A node naming a skill the session did not load is
  refused with a reason.
- **A running turn is reachable without killing it (HOW-47, HOW-48).** A steer or a soft stop is
  a log event (engine/steer.ts, one precheck for route and CLI). The claude executor writes it
  to stdin only while a tool call is in flight, proves delivery by the CLI's
  `--replay-user-messages` echo, and carries an undelivered steer into the next render (suffix
  v6). A turn that ends after a delivered stop is `paused-by-operator`, never a contract
  violation; its last words brief the next visit (suffix v7). docs/designs/steer.md has the spike.
- **"Done" is a contract, not prose (HOW-51).** `acceptance` rows start failing; only a READ-ONLY
  node may write them (validate), a flip must cite evidence real in this run (outputs check,
  core/acceptance.ts), and `requiresAcceptance` holds delivery until every live row passes or an
  operator waives it with a decision event (`acceptance-waived`). HOW-59: every row also says how it is checked
  (`check`: tests | screenshot | command | human | after-publish), chosen from what the run CAN
  produce (`worktree.verify_command`, `worktree.preview_paths`); `after-publish` rows never hold
  publication, a row this run cannot prove (`unprovable()`) is never a reason for the evaluator
  to reject, and the gate names those rows so one `waive --unprovable` settles them.
- **Reviewers are read-only, and the harness enforces it (HOW-53).** Plan mode does NOT refuse an
  Edit — it asks the permission-prompt tool. On a plan-mode node the claude executor refuses every
  permission request itself and never asks the operator (adapter/fixtures/claude-plan-mode-*.jsonl).
- **The harness gathers its own evidence (HOW-40, HOW-52).** `verify:run` runs the tests and
  `evidence:screenshot` captures the workspace preview into the run dir (never the worktree) over
  CDP; neither passes silently — no contract or no browser is `not-checked` with a reason.
- **A review of repairs judges the repairs, not the branch again.** `reviewsWorkOf` on an agent
  node (core/graph.ts) names the steps whose work it reviews; the engine derives from the log the
  commit the EARLIEST of those steps started from since the review last judged
  (engine/repair-scope.ts, the `reconciled` probe before that step's `node-started`) and briefs
  the reviewer with suffix v9 to judge `<that commit>..HEAD`, logged as `repair_scope` so
  reconstruction words it the same. delivery.review_repairs declares the four code-changing
  repairs. Before this it re-judged the whole stack against main and found a new repository
  rule to reject on every visit, each about code an earlier repair had written, and the CI fix
  sat unpushed behind the loop for a day.
- **A loop that changes nothing parks (HOW-54).** Progress-checked steps (on a cycle, not
  readOnly, not `changesFiles: false`) record `node-finished.tree`, the worktree's content tree
  id; a visit whose tree equals its previous visit's parks `no-progress`.
- **The child waits; the parent still never supervises (HOW-57).** A slice's `depends_on` is
  `[{ slice, until: published | merged | package }]` (a bare id means `merged`; at most one
  `published`, same workspace — it is the stack base). A slice with dependencies is launched as
  `implement-stacked` (`stackedFrom(implement-ticket)`, a pure spec transform pinned by a drift
  test) with a `deps` input, and its own first step, `runs:await`, reads each dependency's LOG
  (`<parent>--<slice>`): a missing dir is "not yet" only while the parent logged `run-spawned`
  for it, a parked dependency is still waited on, and only a non-success END (failed, aborted,
  PR closed) parks the dependent. Waits are not steps (`maxSteps` counts every other node) and a
  wait may `backoff` while its predecessor reports nothing new — derived from the log.
- **Every worktree branches from what origin has (HOW-57).** `create` fetches and starts from
  `deps.base` (at `deps.base_tip`) or `origin/<default>`, records the base, its sha and local
  HEAD, says "your local main is N commits ahead; not used", and with no remote or a failed
  fetch uses HEAD AS BEFORE and says why (regression-tested). It used to branch from whatever
  the operator's clone had checked out.
- **A restack is an exactly-once effect, and an approved PR is not re-pushed because its base
  moved (HOW-57).** `git:restack` replays `<recorded tip>..HEAD` with `rebase --onto` (the
  recorded tip is the latest `base-restacked`, else the worktree's base — an event, because an
  agent cannot write one), pushes this run's branch only, `--force-with-lease`, and retargets
  the PR. A base that MERGED always restacks onto the default branch; one that MOVED restacks
  only while this PR is unapproved (`deps.restack`, the one routing fact, outranks CONFLICTS).
  A conflict aborts and hands the exact `--onto` command to `stacked.resolve_restack`; a
  teammate's commit on the branch parks rather than being overwritten. Every agent step of a
  stacked run carries the STACKED briefing (suffix v8, `stacked_on` logged): judge only
  `<tip>..HEAD`. A stacked publish must name its own PRs as an object, and probe:pr ignores
  `deps.prs`, or the run would finish when its BASE merged.

- **A draft is a proposal; Save is the approval (HOW-56, HOW-65).** A `draft-graph` run
  (`graphs/draft-graph.ts`) publishes `graph.draft = { spec, prompts, based_on, notes }` and
  writes nothing else. What a draft may contain is narrower than what the builder allows: only
  EXACT command built-ins and never `runs:launch`, no approval step, its base's `defaults`, no
  per-step `config`, and a copy of a read-only step stays read-only (`draftRuleProblems`). It is
  checked in the outputs check by `checkGraphDraft` — `specProblems`' blocking half plus those
  rules plus `nameTakenProblem`, the SAME verdict Save runs — so a published draft is one that
  would save, and a draft refused twice parks quoting every problem. A body may be
  `{ copyOf: <prompt id> }`; it is materialised AT SAVE by `materialiseBodies`, includes
  expanded exactly as at pin time, so what was reviewed is what a run pins. PROVENANCE IS THE
  SERVER'S: `spec.drafted = { run, draftHash[, edited] }` is written only by `web/draft.ts` —
  the card's Save builds it from the run log, and the builder PUT ignores any `drafted` a client
  sends (it derives one from `fromRun`, keeps the file's own on an update, else strips it);
  `edited: true` marks any save that went through the canvas, because `draftHashOf` ignores
  positions on purpose. Whether a run's draft is SAVED is derived — the local graph whose
  `drafted.run` is that run — and never stored on the run, so a reload or a second tab cannot
  offer Save twice. The card, the review page and the builder's `?fromRun=` all read ONE diff,
  `core/draft-diff.ts`, computed on the server; it matches steps to the base by exact id, the
  rule `draftRuleProblems` uses, so `grantsNewWrite` (which turns the card's Save into "Review
  and save") covers every `permission` advice by construction.

### Module map

| Path | Role |
|---|---|
| `core/` | graph schema (`graph.ts`), path validator (`validate.ts`), context store, template/render contract (`template.ts`) + its node-free reference grammar (`template-refs.ts`), the graph-as-data model the builder writes (`graph-spec.ts`), the harness table (`harnesses.ts`), the ask-the-human model (`ask.ts`, HOW-25), the stacked-slice contract (`stack.ts`, HOW-57: the `deps` input and the two built-ins' keys), the drafter's catalog (`catalog.ts`) and a draft's diff against its base (`draft-diff.ts`, HOW-65), generated `prompt-ids.ts` |
| `graphs/` | the runnable graphs + `index.ts` registry, `local.ts` (the operator's own, from `$HOWDAH_HOME`), `registry.ts` (merged catalog), `typecheck.ts` (tsc gate), `builder.ts` (HOW-22: renders a GraphSpec into a module and saves it transactionally over the graph AND its prompts); `implement-ticket`, `implement-slice` (design on the map → approve → build → drift), `plan-feature` (HOW-23: decompose → approve → ticket each → launch a run each) with its pure `slice-plan.ts` contract, `implement-stacked` (HOW-57: `stackedFrom(implement-ticket)` for a slice with dependencies), `improve-codebase`, `review-teammate-pr`, `write-doc`, `research`, `quick-task`; `delivery.ts` shared publish/repair half |
| `map/` | the code-derived system map (syntactic tier): tree-sitter extraction (`extract.ts`, `facts.ts`, `adapters.ts` + `queries/`), content-addressed store, `assemble.ts` (identity keys, MountResolver), `ghosts.ts` (GhostSet validator), `drift.ts`, `neighbourhood.ts` |
| `prompts/` | one `.md` per prompt (front-matter `id`/`version`), codegen, `store.ts` (load/list/accept with stale-base + undeclared-read guards), `proposals.ts` (lifecycle + review view), `library.ts` (read model: consumers, feedback, outcome join, render reconstruction) |
| `log/` | event union (`events.ts`), durable JSONL writer, view-time `coalesce.ts` |
| `adapter/` | pure harness → `AgentEvent` mappers (`claude.ts`, `codex.ts`, `cursor.ts`, `opencode.ts`), chunk-safe `parse.ts`, `capabilities.ts` matrix |
| `engine/` | `run.ts` (loop, routing, pinning, effects, attribution), `replay.ts`, `reconcile.ts` (git probes + worktree fingerprint), `attention.ts`, `control.ts` (replies, decisions, runner lock), `slice-decision.ts`, `slice-map.ts`, `executors/` (HOW-57 adds `await.ts` `runs:await`, `restack.ts` `git:restack` and the leaf `git.ts`) |
| `cli/` | `main.ts` verbs, `new-graph.ts` scaffolder (writes into `$HOWDAH_HOME`) |
| `config/` | `config.json` workspaces + settings, `tuning.json` overlay, GitHub repo registration |
| `web/` | Bun server (read model + reply/launch/control writes, SSE), `derive.ts` read model, `draft.ts` (HOW-65: a draft-graph run's draft, its Save, and the builder's provenance rule), React app in `app/`: `main.tsx` is the shell/nav/router only, screens in `app/screens/` (HOW-65 adds `draft-review.tsx`, `/runs/:id/draft`), run-detail panes in `app/run/` (`draft.tsx` is the draft card and the list the review page shares; Chat is the default: `run/chat.tsx` folds the run into one conversation and carries the standing ask inline, HOW-25; HOW-27 made it ONE scrolling transcript with the composer permanently at its foot — the Transcript/Ask tab split is gone, not moved, and the composer asks the read-only route and never replies to the agent, because one box that silently changes target on whether the run is parked is a box that sends the wrong one), builder in `app/builder/` (HOW-24: `canvas.tsx` + `node-card.tsx` + `edge.tsx` + `palette.tsx` + `properties.tsx`, with `step-form.tsx`/`branching.tsx`/`fields.tsx` as the panel bodies), primitives in `app/components/ui/`, helpers in `app/lib/` |
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
`map:drift` (`engine/executors/map.ts`), `runs:launch` (`engine/executors/launch.ts`),
`runs:await` and `git:restack` (HOW-57, `engine/executors/await.ts` / `restack.ts`) and
`verify:run` (HOW-12, `engine/executors/verify.ts`), which runs the repo workspace's
`verifyCommand` (config.json; `workspace add … --verify "<cmd>"` / `workspace verify <name>
<cmd>`) in the worktree and publishes `verify.result` — `pass`, `fail` (the attempt still
SUCCEEDS: a red suite is evidence for the reviewer, not a park) or `not-checked` with a reason,
never a silent pass. implement-slice runs it between `map.drift` and the local review. General
commands and verify share one spawn (`engine/executors/shell.ts`), which kills the script's
whole process group on timeout.

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
failed. Which card a park gets is decided by the ask's OWN kind where the cards are drawn
(`run/ask.tsx` StandingAsk): a question gets `AskQuestionCard`, an ambiguous effect gets
`EffectCard`, a park the reply route would REFUSE gets `NoReplyCard` (HOW-69: no composer, the
route's refusal verbatim, and "Retry this step" — the run's resume — where that is the remedy),
and everything else is answered in prose by `AskCard`. Whether a reply would be refused is
`RunDetail.ask_reply`, computed on the server by `replyVerdict` (engine/control.ts) — the same
function `decideReply` runs, over the same graph registry the route uses — never re-derived in
the browser. All four keep the same
contract — the sending → delivered → collapsing motion moment, a refusal shown VERBATIM rather
than collapsed into "failed", and `id="needs-input"` so a notification's deep link lands on the
control. Design tokens (palette, type scale, motion) live in `web/public/tokens.css` +
`app/globals.css` and are decided in `DESIGN.md` (which wins over tokens.css when they
disagree; it supersedes `shaping.md`'s Design section, see T25); tokens.css is the ONLY
place a hex or a `font-size: Npx` may appear. The components are shadcn patterns vendored and
rewritten onto those tokens — one file each under `app/components/ui/`, wired to `shadcn add`
by the root `components.json` (style `base-vega`) and the `@/*` path in `tsconfig.json`.

**ONE primitives library, and three controls that stay on the platform** (HOW-27). The layer
used to be hand-written under a `No Radix, ever` rule. It now sits on `@base-ui/react`, which
is what base-vega's components are built on — `button`, `badge`, `input`, `separator`, `tabs`
and `tooltip` moved, and `tabs` gained the roving tabindex it never had by hand. Radix is still
refused, and so is a SECOND primitives library: `css-contract.test.ts` asserts that no
`@radix-ui/`, `@headlessui/` or `@ariakit/` package is installed.

`Select`, `Dialog` and `Checkbox` deliberately did NOT move, and the same test asserts each one
still says why in its own header. The original reason ("no Radix") expired when Base UI
arrived; the reason they stay is the one that never depended on it — the platform's version is
better. A native `<select>` is keyboard-, screen-reader- and touch-correct on every platform
in 28 lines where base-vega's listbox is 198; `showModal()` gets the focus trap, the inert
background, `::backdrop` and Esc in the top layer with no portal or z-index; and a real
`<input type="checkbox">` keeps Space, form participation and `indeterminate` and does not
change `onChange(e)` into `onCheckedChange(checked)` at every call site. `Tooltip` is the
instructive middle: it took Base UI's collision-aware POSITIONING (the hand-written popup was
`left: 0; top: 100%` and overflowed in the inspector rail, which is exactly where it is used)
but kept its own `role="tooltip"`, id and `aria-describedby`, because the primitive ships none
of the three and HOW-16 P1.4 existed to gain them.

The APIs are Howdah's, not base-vega's: `PanelTabs items={[…]}`, `Tooltip content=`,
`Checkbox label=`, `Dialog open/onClose`. Adopting the registry's compositional spellings would
have rewritten ~73 call sites to say the same thing in three components each. Every interactive element goes through a primitive — a raw `<button>`, `<input>`,
`<select>`, `<textarea>` or `<label>` outside `components/ui/` is a test failure, and so is a
class emitted with no rule, a rule with no consumer, or a `title=` used as a tooltip
(`app/css-contract.test.ts`, `app/components/components.test.tsx`). Those two files exist
because the seam between the component layer and hand-CSS shipped two invisible defects
(`.tab.on` matching nothing, `.chip` with modifiers but no base rule) that nothing else could
see: TypeScript does not read CSS, and a missing rule renders as plain text. A class may be
exempt from "every emitted class has a rule" in exactly three lists, each of which has to say
what feeds it: `COMPOSED_PREFIXES`/`COMPOSED_NAMES` (a name built at run time from data, so the
scan cannot see the value) and `BEHAVIOURAL` (HOW-24 — a name a LIBRARY reads in JavaScript:
React Flow's `nodrag`/`nopan` are its interaction opt-outs and its own sheet deliberately gives
them no rules, so listing them is honest where an empty rule would be a lie).

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
- Adding a harness = one entry in `core/harnesses.ts` + one mapper in `adapter/` + a
  `capabilities.ts` entry + an executor in `engine/executors/` wired into `liveExecutors`;
  nothing downstream of `AgentEvent`, and no UI literal, should need to change.
- Cursor's adapter and executor are written against the DOCUMENTED `cursor-agent`
  stream-json envelope, not a captured one — cursor-agent is not installed on this machine,
  `capabilities.ts` marks its entries `untested`, and `engine/executors/fake-cursor.ts`
  speaks the same documented shapes. Capture a real turn into `adapter/fixtures/` and pin it
  the day the CLI is available.
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

### Disambiguation (mattpocock-skills, installed 2026-09-26)

Most of that plugin's skills are `disable-model-invocation: true` — `to-spec`, `to-tickets`,
`implement`, `triage`, `wayfinder` and `improve-codebase-architecture` fire ONLY when typed
by name, so they never win a routing decision on their own. The rules below are for the ones
that CAN auto-fire, plus the two places where typing the wrong name writes to the wrong home.

**Reviewing a diff — three skills, split by the question being asked:**
- "Is this code correct?" (bugs in the diff) → `/code-review`, the built-in. It is the only
  one with effort levels, `--fix` and `--comment`.
- "Does this match the ticket it came from?" → `mattpocock-skills:code-review`. Two axes,
  Standards and Spec, in parallel sub-agents. It needs an originating ticket to check
  against, so it is worth reaching for only when the work started from a `.scratch/` ticket.
- "Is this ready to land?" (pre-landing gate) → `/review` (gstack), which stays the default
  for the routing line above.

**A bug — `/investigate` (gstack) stays the default.** `mattpocock-skills:diagnosing-bugs`
also auto-fires on "debug this" / "it's throwing"; prefer `/investigate` unless the user names
the other. `abstack:debugging` is the Kotlin-side one and does not apply to this repo.

**Writing a spec — the two are complementary, not rivals:**
- From a vague standing start, with an interview → `/spec` (gstack), five phases.
- From a design conversation that already happened → `mattpocock-skills:to-spec`, which
  explicitly does NOT interview and publishes straight to `.scratch/` (see Agent skills below).

**Breaking work into tickets → `mattpocock-skills:to-tickets`**, now that a tracker is
configured: it writes tracer-bullet slices with blocking edges into `.scratch/`.
`abstack:writing-user-stories` writes user stories with acceptance criteria and no tracker
home — use it only when the user asks for stories by name.

**No competitor, safe to route to:** `tdd`, `prototype`, `research`, `domain-modeling`,
`codebase-design`, `resolving-merge-conflicts`, `wizard`, `grilling`, `writing-for-agents`
(the last auto-fires whenever this file or a skill is edited, which is intended).

`/health` (gstack, a quality dashboard) and `improve-codebase-architecture` (deepening
opportunities as an HTML report) answer different questions; neither replaces the other.

## Agent skills

### Issue tracker

Issues live in **Linear**, team Howdah, as `HOW-<n>`, reached through the Linear MCP tools.
`shaping.md` and `TODOS.md` are design and backlog, not the tracker. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, mapped to Linear issue states and labels. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. Neither exists yet; they are
created lazily by `/domain-modeling`. See `docs/agents/domain.md`.
