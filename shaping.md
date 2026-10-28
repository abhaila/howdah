---
shaping: true
---

# Howdah — Shaping

> Renamed from "harness" (T13, done 2026-09-13): harness.io is a $5.5B AI software-delivery
> company in this category. Repo dir, gstack slug and docs now say howdah; the CLI will be
> born as `howdah`.

One harness for all four kinds of my work, with feedback-driven prompt improvement as the
centrepiece.

## Context

Decided 2026-09-12: **build our own**, not a layer on Orbital. The driver is ownership —
Orbital is UNLICENSED on a private registry, so every one of the fifteen items in the
feedback doc is something to ask someone else for.

Research inputs in `research/`: [orbital-spec.md](./research/orbital-spec.md) (functional
spec + six findings), [orbital-feedback.md](./research/orbital-feedback.md) (the feedback
doc, grouped), `research/graphs/` (four real DOT exports + the one-prompt diff),
`research/screens/` (six UI captures).

🟡 **Eng-reviewed 2026-09-12** (`/plan-eng-review`): Shape A selected and built whole per
the user's scope decision; 9 findings + 10 outside-voice items resolved; Shape A rewritten
below with every decision folded in. Review report at the end of this file.

**Design principle, set before any shape:** build the differentiator first against Orbital's
data, then grow the engine underneath it. 12,114 real events and four real graphs are already
available to develop against, so the prompt loop can be useful before the engine runs a single
node. Agent Deck died spending its budget on commodity before reaching its differentiator.

---

## Requirements (R)

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | One harness that runs all four kinds of my work — write documents, research, write code, review code — as graphs I author and keep improving | Core goal |
| R1 | Every prompt is an addressable object with its own history. Improving one prompt must not require forking a whole graph | Must-have |
| R2 | 🟡 Feedback attaches to a specific prompt at a specific run and visit, and **drafts a revision I accept or reject via a diff** — nothing changes behaviour until I look | Core goal |
| **R3** | **See what the agent is doing** | Must-have |
| R3.1 | The rendered prompt for every turn is visible, together with the context values it read | Must-have |
| R3.2 | Streaming output is coalesced into readable messages, not one row per delta | Must-have |
| R3.3 | When a step needs me, I find out without watching the UI | Must-have |
| R3.4 | Per-turn model, provider, effort, token spend and cost are recorded and visible | Must-have |
| R3.5 | Git state is visible at a glance: what is uncommitted, committed, pushed | Must-have |
| R4 | Recorded state is reconciled against observable reality, never trusted over it — branch, PR, worktree | Must-have |
| R5 | Non-code work is first-class: a workflow can run with no repo, no worktree and no PR, and finish on judgement rather than a machine fact | Must-have |
| R6 | I can change any part of it myself, at any time, without asking anyone | Core goal |
| R7 | Runs survive a restart, and long-running work can be left and come back to | Must-have |
| **R8** | **Fits my working environment** | |
| R8.1 | Maintainable solo on a toolchain already installed (node 25 / bun 1.3; no cargo, no go) | Must-have |
| R8.2 | Open a run's worktree in my IDE in one action | Nice-to-have |
| R8.3 | Reach the tools my work actually lives in: Slack, Notion, Drive, Linear | Nice-to-have |

### Where each requirement comes from

| R | Evidence |
|---|----------|
| R0 | Stated: "I want to write documents, I want to do research, I want to write code, and I want to review code" |
| R1 | `implement-ticket-areeb` is a 20KB fork of `implement-ticket` differing by exactly one node's prompt |
| R2 | Stated: "the graph created and all the prompts should have a hook to review the prompt based on feedback to improve it" |
| R3.1 | "Context tab in steps never shows anything" — it shows what a step *wrote*, never what it *read*. `PromptRendered` events carry the full prompt and are not surfaced |
| R3.2 | "The turn delta in the debug steps is noisy and cuts the text across many lines" — observed: 9 consecutive `TurnDelta` rows, no payload |
| R3.3 | "I just lose the agent for like 1hr 2hr" — observed: `delivery.address_reviews` sat in *Needs you* for 4h 10m after the harness crashed |
| R3.4 | "Doesn't tell you when its out of tokens - doesn't offer to change model" — observed `Model —`, `Provider —`, `Cost —` against 177.1k tokens |
| R3.5 | "Some sense of where commits are e.g. whats not committed, committed, pushed" |
| R4 | Branch-drift: requested branch name honoured by the agent, never written back to the record, so PR lookup, review fetch and cleanup all fail |
| R5 | Three of four work kinds have no PR. Orbital's `FolderKind` already allows `Plain{}`, so this is possible, just unserved by its graphs |
| R6 | Stated: "plan our own version of this that I can improve on all the time". Orbital is UNLICENSED on a private registry |
| R7 | 18h 25m run observed, parked at `delivery.wait@25` |
| R8.1 | Carried from the Agent Deck spikes: node 25 and bun 1.3 installed, no cargo, no go |
| R8.2 | "Being able to set up your IDE command to be able to open the worktree with a single button" |
| R8.3 | "Would be nice to have customised tools like Slack, Notion or Drive" |

### Deliberately not requirements yet

- **"How is the data stored? Will it save it locally?"** — a question, not a requirement. Answer it in the shape.
- **"What is the difference between goal and input.work"** — a symptom of R3.1. If you can see what a prompt read, the distinction becomes self-evident. Not a separate requirement.
- **Model dropdowns** — an instance of R3.4, not its own requirement.
- **"Clean up pending always fails"** — an instance of R4.

---

## CURRENT: Orbital plus manual graph forks

| Part | Mechanism |
|------|-----------|
| CUR1 | Workflows are DOT files in `.orbital/`; prompts live inline as node attributes |
| CUR2 | Improving one prompt means cloning the whole graph (`implement-ticket-areeb`, 20KB, one prompt changed) |
| CUR3 | Feedback lives nowhere. No record of why a prompt was changed or whether it helped |
| CUR4 | `PromptRendered` is captured in the event stream and never surfaced |
| CUR5 | Context tab shows what a step wrote, never what it read |
| CUR6 | Branch recorded at worktree creation, never reconciled; PR lookup, review fetch and cleanup fail downstream |
| CUR7 | Code work only in practice; `FolderKind.Plain` exists but no graph uses it |
| CUR8 | Closed source, private registry. Nothing above is fixable by me |

---

## A: Prompt registry with an engine grown underneath — **SELECTED, as reviewed**

Prompts are the primary object. Whole-build (user decision at the review scope gate), with
the reviser script as the first artifact — which restores differentiator-first ordering
*inside* the whole build.

| Part | Mechanism | Flag |
|------|-----------|:----:|
| **A0** | 🟡 **Graph definition (was unspecified)** | |
| A0.1 | 🟡 Graphs are TypeScript-native objects; `bun` type-checks them — no DOT/TOML parser, no custom validator. A small `toDot()` exporter provides graphviz rendering (D2) | |
| A0.2 | 🟡 Node types at v1: agent, command, wait, terminal, **worktree** (pulled forward — concurrent code runs need isolation, D11). Fan-out/join: v1 built (HOW-73) as the `parallel` node — read-only branches only | |
| A0.3 | 🟡 Strict typed context: every node declares typed outputs; reads are compile-checked; every-path-has-a-writer proven by the type system (D3). Visit-scoping is explicit per output: sticky, cleared, or per-visit — loop freshness is never ambiguous (OV-4) | |
| **A1** | **Prompt store** | |
| A1.1 | One file per prompt, `prompts/<id>.md`, front-matter `{id, version, tags}`, body is the template. Git is the version history | |
| A1.2 | 🟡 Generated `PromptId` union type from the prompts dir; node `prompt` fields typed with it — unknown ids and inline text are compile errors with IDE autocomplete. No separate linter (D6) | |
| **A2** | **Feedback capture** | |
| A2.1 | `feedback/<prompt-id>.jsonl`: `{run, node, visit, at, note, verdict, rendered_hash}` | |
| A2.2 | 🟡 Feedback is enterable via CLI against a run+turn (`harness feedback <run> <node>@<visit>`), so the rendered instance is always attached | |
| **A3** | **Reviser** | |
| A3.1 | 🟡 **Script first** (D5): GEPA-method reflective revision — inputs are the prompt, its feedback, rendered instances and PromptOutcome records; output is a proposed revision as a diff. Graduates to a built-in graph once the engine runs. First build task, runnable against Orbital's existing event stream | |
| A3.2 | 🟡 Proposals carry `base_version`; accept refuses on a stale base and offers a re-draft (D7). Accept also **re-validates the revised template's variables against every consuming node's declared context** — a revision cannot introduce an undeclared read (OV-3) | |
| A3.3 | 🟡 Accept-gate evals: the delivery.publish ground-truth case now; per-prompt eval cases authored lazily at first feedback, gating all later revisions (D8) | |
| A3.4 | 🟡 Outcome **attribution** (OV-8): interventions (steering, manual edits, infra failures) are recorded with provenance; only eligible outcomes feed the reviser, so a human rescue is never scored against the prompt | |
| **A4** | **Runner** | |
| A4.1 | 🟡 Own engine over the three SDKs; `settingSources` pinned. Adapter seam and normalized event type lifted from agent-deck/spike-findings.md; a **capability matrix** per SDK (resume, permissions, cancellation, usage) declares unsupported behaviour explicitly (OV-7) | |
| A4.2 | 🟡 Exactly-once side effects (OV-1): durable node-attempt ids, completion checkpoints written before and after side-effecting steps, ambiguous executions reconciled by probe (did the PR appear?) before any retry | |
| A4.3 | 🟡 Runs **pin** their graph snapshot and prompt versions at start (OV-2); accepted revisions apply to new runs only | |
| **A5** | **Event log** | |
| A5.1 | Append-only JSONL per run. `PromptRendered{node, prompt, context_read}` per turn | |
| A5.2 | 🟡 **Durable incremental chunks**, coalesced in the view, with an explicit turn-finalized event (D10). A crash preserves everything up to the moment of death; tool-call ordering inside a turn is kept | |
| A5.3 | 🟡 `PromptOutcome{rendered_hash, node, visit, verdict_downstream, terminal_outcome, error}` written by the engine as routing happens; late outcomes (PR merged days later) join by follow-up write (D4) | |
| **A6** | **Reconciler** | |
| A6.1 | 🟡 Git probes on every node (local, free); forge probes only before nodes whose declared context reads include forge facts (D9) — identical freshness at the point of use, fraction of the API calls | |
| A6.2 | No cached branch name is ever read. The probe is the only source | |
| A6.3 | 🟡 **Intended vs observed** (OV-5): the run records which branch/PR it *owns* alongside what it *observes*; disagreement is surfaced, not auto-resolved. "No PR" and "forge unreachable" are distinct states | |
| **A7** | **Attention** | |
| A7.1 | A step needing input raises an OS notification and a Slack DM, not only a UI state | |
| A7.2 | 🟡 A **watchdog outside the harness process** (launchd interval job) checks a heartbeat file and pending-attention records — the harness dying is itself an attention event (OV-10). Pending attention is durable and re-raised on restart | |
| **A8** | **Non-code work** | |
| A8.1 | Folder kind `Plain`; graphs with no worktree, no PR probe, terminating on an agent verdict | |
| A8.2 | Document and research graphs authored against a notes folder | |
| **A9** | 🟡 **Viewer: local shadcn web app** (D13 → REVERSED at design review 2026-09-12) | |
| A9.1 | 🟡 Bun server + React + shadcn, serving the run view over the same on-disk files/JSONL (storage unchanged). Carried from mockup rounds: the step timeline as a first-class element; line-level tool detail collapsed by default, expandable on tap | |
| A9.2 | 🟡 Thin CLI survives for scripting only (`harness reply`, `harness runs --json`); notification click-through opens the web view. The CLI is no longer a designed surface | |
| A9.3 | 🟡 History: D13 originally chose CLI + files with the web UI behind a trigger. Reversed after two rounds of terminal mockups were rejected ("far too much like the terminal... slick modern UI that uses shadcn"). Decision made with renderings in hand | |
| A9.4 | 🟡 **Operator Cockpit Upgrade** — Effort: L. Risk: Medium. Make the UI the primary control surface: graph templates/editor, run recovery panel, native artifact/document review, terminal spawn from a run/worktree, and stronger chat-to-run steering. Pros: directly addresses the operator pain and turns Howdah from an engine into a product. Cons: larger surface area and careful UX decisions needed so the cockpit stays legible under long-running, failing, or multi-run work. Implementation plan: `plans/operator-cockpit-upgrade.md` | ⚠️ |

## B: Engine first, DOT-compatible, prompts inline

Rebuild Orbital's model properly, then add the prompt loop.

| Part | Mechanism | Flag |
|------|-----------|:----:|
| B1 | DOT parser and static validator, Orbital-compatible subset so existing graphs import | |
| B2 | Full runner: agent, command, worktree, fan-out/join, wait, terminal | ⚠️ |
| B3 | **SQLite-backed run store** as the primary persistence/query/control plane, following Orbital's durable-db direction: `runs`, `events`, `node_attempts`, `attention`, `artifacts`, `worktrees`, `controls`, and `runner_heartbeats` are queryable without replaying every file | |
| B3.1 | Append-only semantics stay intact: every meaningful change is still an event, and per-run JSONL remains available as export/audit/recovery while the UI and operator actions read indexed SQLite state | |
| B3.2 | Event log and web UI covering R3.1-R3.5 are built on the SQLite index first, so run lists, graph status, attention, cost/model history, probes, and resume state are visible without custom replay in every endpoint | |
| B4 | Prompts inline in DOT node attributes, as Orbital does | |
| B5 | Prompt improvement added later as tooling over the DOT files | ⚠️ |
| B6 | Reconciler and attention as in A6/A7 | |

## D: Coexist — Orbital keeps code work, the new harness takes the rest

| Part | Mechanism | Flag |
|------|-----------|:----:|
| D1 | Orbital continues running `implement-ticket` and `review-teammate-pr` untouched | |
| D2 | New harness owns document and research workflows from day one (A1, A4, A5, A8) | |
| D3 | Prompt store and feedback capture as A1-A3, covering the new graphs | |
| D4 | For code work, feedback is read out of Orbital's event stream over `GET /api/runs/:id/events` and revisions written back via `/graphs/:name/draft` + `/validate` + `/import` | ⚠️ |
| D5 | Code work migrates to the new runner once it handles worktrees and fan-out | |

---

## Fit Check

| Req | Requirement | Status | A | B | D |
|-----|-------------|--------|---|---|---|
| R0 | One harness that runs all four kinds of my work as graphs I author and keep improving | Core goal | ✅ | ✅ | ❌ |
| R1 | Every prompt is an addressable object with its own history; improving one must not require forking a whole graph | Must-have | ✅ | ❌ | ✅ |
| R2 | Feedback attaches to a specific prompt at a run and visit, and drafts a revision I accept or reject via a diff | Core goal | 🟡 ✅ | ❌ | ❌ |
| R3 | See what the agent is doing (rendered prompt + context read, coalesced output, attention, cost, git state) | Must-have | ✅ | ✅ | ❌ |
| R4 | Recorded state is reconciled against observable reality, never trusted over it | Must-have | ✅ | ✅ | ❌ |
| R5 | Non-code work is first-class: no repo, no worktree, no PR, finishes on judgement | Must-have | ✅ | ✅ | ✅ |
| R6 | I can change any part of it myself, at any time, without asking anyone | Core goal | ✅ | ✅ | ❌ |
| R7 | Runs survive a restart; long work can be left and come back to | Must-have | ✅ | ✅ | ✅ |
| R8 | Fits my working environment (solo-maintainable on node/bun, IDE open, Slack/Notion/Drive/Linear) | Must-have | ✅ | ✅ | ✅ |

**Notes:**
- 🟡 **R2 flipped to ✅ for A at eng review:** the reviser mechanism is now concrete — GEPA-method reflective revision (ICLR 2026, published and benchmarked), defined inputs (prompt + feedback + rendered instances + PromptOutcome), a diff-based accept flow with a stale-base guard, and a scoreable ground-truth eval (the hand-edited `implement-ticket-areeb` fork). The eval is the first build task; a failed eval reopens this row.
- **B fails R1:** prompts inline in DOT reproduces the fork-per-tweak problem that R1 exists to kill. B5 proposes tooling over it later, which is unresolved.
- **D fails R0, R3, R4 and R6:** code work stays on Orbital, so for the largest share of the work nothing improves — the same unsurfaced prompts, the same branch drift, the same inability to fix it. D4 also depends on a closed pre-1.0 API.
- **A and B both pass everything else.** A's remaining risk is A4.2 (own engine, deferred node types); B's is B2 (full engine up front) plus the SQLite migration boundary. The database choice improves B's operator trust story, but it must preserve append-only event semantics rather than becoming mutable status rows with no audit trail.

🟡 **Selected: A**, as reviewed. The ground-truth eval (first task) is the escape hatch: if
GEPA-method revisions don't approach the quality of your hand edit, the reviser design
reopens before the engine work is affected.

---

## Open

- 🟡 None blocking. The ground-truth eval result (T1) is the one finding that could reopen
  a decision (R2's mechanism). Fan-out/join and the web UI are deferred with named triggers.

---

# Eng Review (2026-09-12)

Run via `/plan-eng-review`. Scope decision: **build Shape A whole** (user override of a
staged-build recommendation). 9 findings across four sections plus 10 outside-voice items;
every decision folded into Shape A above (marked 🟡, with D/OV references).

## Decisions

| # | Decision |
|---|----------|
| D1 | Build Shape A whole; no gated stages (user, at the complexity gate) |
| D2 | Graphs are TypeScript-native; the type-checker is the validator |
| D3 | Strict typed context: declared outputs, compile-checked reads, path coverage proven statically |
| D4 | Engine-written `PromptOutcome` events join each rendered prompt to downstream results |
| D5 | Reviser ships as a script first (GEPA method), graduates to a graph; adapter seam reused from Agent Deck findings |
| D6 | Generated `PromptId` union type replaces the linter |
| D7 | Proposals carry `base_version`; stale accepts refused with a re-draft offer |
| D8 | Reviser eval: ground-truth case now, per-prompt eval cases lazily at first feedback |
| D9 | Reconciler: git probes always; forge probes only before declared readers |
| D10 | (Outside voice, accepted) Durable chunked event writes, coalescing in the view |
| D11 | (Outside voice, accepted) Worktree node pulled into v1 |
| D12 | (Outside voice, accepted) Eight additive gaps folded: exactly-once side effects, run pinning, template-read validation on accept, visit-scoping, intended-vs-observed identity, SDK capability matrix, outcome attribution, watchdog attention |
| D13 | Viewer is CLI + files at v1; web UI deferred behind a named trigger |

## What already exists

| Thing | Status | Used |
|-------|--------|------|
| Orbital event stream (12,114 events, live REST API) | Running | Reviser dev data + T1 eval input |
| `implement-ticket-areeb` hand-edited prompt | On disk | Ground truth for the reviser eval |
| Agent Deck spike findings (SDK wire shapes, `--permission-prompt-tool stdio`, normalized event design, chunk-boundary bug) | agent-deck/spike-findings.md | Adapter seam, capability matrix input, CRITICAL test case |
| GEPA (ICLR 2026) + DSPy docs | Published | Reviser method — borrowed, not imported |
| promptfoo (MIT, local, YAML-in-git) | Available | Candidate runner for lazy per-prompt evals |
| Four Orbital DOT graphs | research/graphs/ | Ported by hand to TS graphs (one-time) |
| `bun test` | Built in | The test runner; no framework install |

## NOT in scope (v1)

- **Fan-out/join node** — v1 built (HOW-73), read-only branches only; writing branches with their own worktrees are the follow-up.
- 🟡 ~~Web UI deferred~~ — REVERSED at design review: the shadcn web app IS the v1 surface. What is dropped instead: the CLI as a designed surface (it remains as thin scripting verbs).
- **Orbital import/compat** — graphs are ported by hand once; no DOT parser exists to maintain.
- **Slack/Notion/Drive as agent tools (R8.3)** — nice-to-have; agents reach them via existing MCP/skills, not harness-native integrations.
- **Multi-user anything** — solo tool by requirement (R6/R8.1).

## Failure modes

| Codepath | Failure | Test? | Handling? | Silent? |
|----------|---------|:-----:|:---------:|:-------:|
| SDK stream parse | Event split across chunk boundary → permanent hang | fixture replay + fuzz (CRITICAL, carried from Agent Deck) | bounded reads | No, once tested |
| Side-effecting node | Crash after `gh pr create`, before record → duplicate PR on resume | planned | attempt ids + probe-before-retry (A4.2) | No |
| Accept flow | Stale base applied over hand edit | planned | refuse + re-draft (A3.2) | No |
| Reviser evidence | Human rescue scored against the prompt → harmful revision | eval | attribution eligibility (A3.4) | No |
| Attention | Harness dies before notifying → hours of silence | E2E | external watchdog + durable pending records (A7.2) | No |
| Reconciler | Forge outage read as "no PR" → wrongful cleanup | planned | distinct states (A6.3) | No |

**Critical gaps: 0** — every identified failure mode has both a planned test and planned handling.

## Worktree parallelization strategy

| Step | Modules touched | Depends on |
|------|-----------------|------------|
| T1 reviser script + eval | reviser/ | — (uses Orbital data) |
| T2 context model | core/ | — |
| T3 graph schema + node types | core/, graphs/ | T2 |
| T4 PromptId codegen | prompts/, core/ | T3 |
| T5 prompt store + proposals | prompts/ | T2 |
| T6 event log | log/ | T2 |
| T7 adapters + capability matrix | adapter/ | T6 |
| T8 engine assembly (exactly-once, pinning) | engine/ | T3, T6, T7 |
| T9 reconciler | engine/ | T8 |
| T10 attention + watchdog | engine/, watchdog/ | T6 |
| T11 web app (Howdah UI) | web/ | T6 |
| T12 doc/research graphs | graphs/ | T3 |

```
Lane A: T1                    (independent — start immediately, it is the escape hatch)
Lane B: T2 → T3 → T4          (core/, sequential)
Lane C: T5                    (prompts/, after T2)
Lane D: T6 → T7               (log/ then adapter/)
Lane E: T8 → T9               (engine/, after B and D converge)
Lane F: T10, T11 (web/), T12  (parallel after their deps; independent modules)
```

Launch A, B, D in parallel. C joins after T2. E is the convergence point — everything
before it can run in separate worktrees; E itself is sequential. Conflict flag: T8-T10
all touch engine/ — keep Lane E single-worktree.

## Implementation Tasks
Synthesized from this review's findings. Each derives from a specific finding above.

- [x] **T1 (P1, human: ~2d / CC: ~2h)** — reviser — GEPA-method reviser script + ground-truth eval ✅ 2026-09-13: 15/15 (see reviser/eval/), proposal pending human accept
  - Surfaced by: Architecture D5 + Step 0 search check + D8
  - Files: reviser/revise.ts, reviser/eval/delivery-publish.case.ts
  - Verify: proposal for the stock delivery.publish prompt + PR-structure feedback scored against the hand-written fork; you would accept the diff
- [x] **T2 (P1, human: ~1d / CC: ~1h)** — core — Typed context model with visit-scoping semantics ✅ 2026-09-13: core/context.ts + core/validate.ts, 20 tests, tsc clean
  - Surfaced by: Architecture D3 + OV-4
  - Files: core/context.ts
  - Verify: reading an unwritten key and an undeclared output are compile errors; sticky/cleared/per-visit covered by tests
- [x] **T3 (P1, human: ~2d / CC: ~2h)** — core/graphs — TS graph schema; agent, command, wait, terminal, worktree nodes ✅ 2026-09-13: all three Orbital graphs ported + validate clean; 17 prompts extracted, 11 shared across graphs
  - Surfaced by: Architecture D2 + D11
  - Files: core/graph.ts, graphs/*.ts
  - Verify: the four Orbital graphs port and type-check; a bad edge condition fails compile
- [x] **T4 (P2, human: ~1h / CC: ~10min)** — prompts — PromptId codegen ✅ 2026-09-13: closed union of 18 ids; unknown ids are compile errors; --check mode for CI
  - Surfaced by: Code quality D6
  - Files: prompts/codegen.ts
  - Verify: unknown id and inline prompt text are compile errors; add/rename/delete regenerates
- [x] **T5 (P1, human: ~1d / CC: ~1h)** — prompts — Store + proposals with base_version and template-read validation ✅ 2026-09-13: prompts/store.ts + proposals.ts, D7 stale-base + OV-3 template-read guards, 13 tests
  - Surfaced by: Code quality D7 + OV-3
  - Files: prompts/store.ts, prompts/proposal.ts
  - Verify: stale accept refused; a revision introducing an undeclared template variable is rejected at accept
- [x] **T6 (P1, human: ~2d / CC: ~2h)** — log — Chunked durable event log: PromptRendered{context_read}, PromptOutcome + attribution, turn-finalized ✅ 2026-09-13: log/: fsync-per-append chunks, view-time coalescing, outcome joins on rendered_hash, SIGKILL test
  - Surfaced by: D4, D10, OV-8
  - Files: log/events.ts, log/write.ts, log/coalesce.ts
  - Verify: kill mid-turn preserves chunks; coalesced view identical to Orbital-style message; outcome joins on rendered_hash
- [x] **T7 (P1, human: ~3d / CC: ~3h)** — adapter — Three SDK adapters over the Agent Deck seam + capability matrix + CRITICAL chunk tests ✅ 2026-09-13: adapter/: claude+codex+opencode mappers, byte-oriented chunk-safe parser, replay+fuzz tests, capability matrix
  - Surfaced by: A4.1 + OV-7 + carried Agent Deck finding
  - Files: adapter/{claude,codex,opencode}.ts, adapter/capabilities.ts, test/fixtures/*.jsonl
  - Verify: fixture replay at varied byte offsets yields identical events; fuzz target never crashes or hangs; matrix documents unsupported behaviour per SDK
- [x] **T8 (P1, human: ~3d / CC: ~3h)** — engine — Assembly: routing, max_visits, exactly-once side effects, run pinning, resume-by-replay ✅ 2026-09-13: engine/run.ts: routing, maxVisits, claim/done exactly-once + probe-on-resume, prompt pinning, resume-by-replay
  - Surfaced by: A4.2/A4.3 + OV-1/OV-2 + R7
  - Files: engine/*.ts
  - Verify: kill during a side-effecting node → resume probes, does not duplicate the PR; parked run keeps its pinned prompt versions
- [x] **T9 (P2, human: ~1d / CC: ~1h)** — engine — Reconciler: git-always/forge-on-readers, intended-vs-observed ✅ 2026-09-13: engine/reconcile.ts: git-always/forge-on-readers, intended-vs-observed, unreachable != no-PR, real-git tests
  - Surfaced by: Performance D9 + OV-5
  - Files: engine/reconcile.ts
  - Verify: branch renamed mid-run test passes; forge outage is not read as "no PR"
- [x] **T10 (P2, human: ~1d / CC: ~1h)** — watchdog — OS + Slack attention, heartbeat watchdog, durable pending records ✅ 2026-09-13: engine/attention.ts + watchdog/check.ts (launchd plist): durable-first records, kill -9 still rings
  - Surfaced by: A7 + OV-10
  - Files: engine/attention.ts, watchdog/check.ts (launchd interval)
  - Verify: kill -9 the harness with attention pending → notification still arrives
- [x] **T11 (P1, human: ~1-2wk / CC: ~2-3d)** — web — 🟡 Local shadcn web app: run list, run view (timeline element + coalesced thread + tap-in tool detail + needs-you action card with reply), prompt/proposal diff view ✅ 2026-09-13: web/: Bun server (API+SSE+reply round-trip) + React app, Howdah tokens dark+light, 10 tests
  - Surfaced by: Design review D5 (D13 reversed on mockup evidence)
  - Files: web/ (Bun server, React, shadcn), cli/main.ts (thin scripting verbs only)
  - Verify: every R3 sub-requirement answerable in the web view against a real run log; reply round-trips from the needs-you card
- [x] **T12 (P2, human: ~1d / CC: ~1h)** — graphs — Document + research graphs on Plain folders ✅ 2026-09-13: graphs/write-doc.ts + research.ts + 8 prompts, no-repo engine run proven
  - Surfaced by: A8 / R5
  - Files: graphs/write-doc.ts, graphs/research.ts
  - Verify: a run completes with no git repo present, terminating on agent verdict

---

## Design (reviewed 2026-09-13, /plan-design-review)

Initial design completeness 3/10 → **9/10** after seven passes, two outside voices
(Codex + independent Claude read), five naming rounds, and four mockup rounds.
Everything below was decided interactively; nothing is a default.

### Identity — Howdah

**The product is named Howdah** — the supervision seat atop the elephant. You, seated above
an enormously capable creature, watching, steering when needed. Chosen over five rounds after
collision checks killed Lumos (lumos.com, identity SaaS), Patronus (Patronus AI), Portkey
(portkey.ai), Accio (Alibaba), Golem (golem.ai + crypto), Auriga (auriga.com), Owlery
(owlery.ai), Marauder (ESP32 pentest tool) — **and Harness itself: harness.io is a $5.5B AI
software-delivery company in this exact category.** The rename is forced, not aesthetic.
Verified shortlist runners-up, recorded: Sancho, Thestral, Sais/Syce, Dak, Harkara, Ishmael.
Caution note: revisit any word-mark before public use.

- **Mark:** 🟡 the one-line elephant (logo B, user-picked from three concepts after rejecting the
  first busy mark): a single unbroken stroke forming the head, a square howdah notch above, an
  amber dot for the eye. The amber eye is the favicon's attention pixel; the trunk supplies the
  needs-attention gesture. Asset: designs/howdah-logo-20260913/logo-B-oneline.png (reference).
- **Favicon animates on needs-attention** — the trunk-raise. The tab is the real attention
  surface when the window is unfocused.
- **Signature attention chime:** ONE two-note sound meaning "an agent is waiting" (mutable in
  settings). Sound carries meaning (R3.3), never ceremony. No launch sound, no splash — a
  local app boots in ~400ms and fake delay is the cardinal sin. The animated mark appears
  only on real waits (first connect, large log parse) and the empty state.
- **Theme toggle:** dark + light from one token set. Default: system.

### Typography & tokens

- 🟡 **Special Gothic (display/headings) + JetBrains Mono (ids/costs/diffs/data)** —
  CHANGED 2026-09-13 from Space Grotesk: user picked Special Gothic (Google Fonts) after a
  Prateek Kuhad tour-poster reference (Neue Haas-genre neo-grotesque); decided from a
  five-face specimen render (web/public/fonts-preview.html). Single weight 400 →
  font-synthesis disabled, hierarchy via size + tracking. Original decision kept for
  history: Space Grotesk + JetBrains Mono, with
  JetBrains Mono doubling as the body face for dense rows and Space Grotesk for headings and
  prose. User-picked from six rendered specimens across two rounds (over Geist — the P4-1
  pick made blind — and over mono-first and editorial-serif directions). Both free (Google
  Fonts), variable. Discipline note: Space Grotesk's quirk lives in headings; data stays mono.
- shadcn CSS variables as the single token source; both themes derive from it.
  🟡 PALETTE CHANGED 2026-09-13 (user-picked from Pigment, screenshot decision):
  SINBAD #94CBC8 = primary actions · LAVENDER PURPLE #9675A8 = activity/running ·
  sand-gold #E0CD84 = attention (kept: the pair has no warm color and attention must
  outrank; never on buttons). Waiting/paused → neutral slate to avoid lavender collision.
  Exact hexes on dark, deepened derivations on light. Favicon eye sand-gold.
  (History: amber attention → peacock/lapis trio → this pair, all same day.) Status palette + the two motion tokens
  (`--ease-out-strong: cubic-bezier(0.19,1,0.22,1)`; durations 120/200/350ms) live as variables.
- Browser surfaces themed: selection, focus rings, scrollbars.

### Navigation & screens (8)

Slim left sidebar — mark, then Runs (needs-input badge count), Prompts, Proposals, Settings —
collapsing to icons < 900px; cmd-K palette over everything. Screens: (1) Runs list —
needs-input first with wait timers, then running, then terminal; (2) Run view (below);
(3) Prompt library — versions, attached feedback, outcomes per prompt (R1's object, visible);
(4) Proposal review — diff, evidence, eval result, accept/reject, stale-base re-draft;
(5) Settings — IDE command, Slack, theme, chime, notification prefs; (6) Start-run form
(user choice, in v1) — graph picker, typed `inputs=` rendered as a real form, folder,
harness; (7) Non-code run view — inspector's Git section replaced by **Outputs**: files
written, rendered-markdown preview, verdict; (8) cmd-K palette.

### Run view (the approved direction, refined)

Split view. **Status enum has one renderer and needs-input outranks failed:**
queued / running / needs-input / waiting / failed-recoverable / failed-terminal / done /
harness-dead. When blocked: **full-width pinned amber banner under the header with a live,
color-stepped elapsed-wait timer** ("Waiting on you — 4h 12m"), autoscroll on load, sticky
ask card. The wait timer also lives on the timeline row, the runs list, and in notification
text — it is the product's most load-bearing number.

- **Thread (left):** agent prose; tool-call clusters collapsed into single muted rows
  ("⚒ 12 tool calls · 2m 04s"), expandable; every turn carries **"Prompt & context"** —
  the rendered prompt, prompt version, and context values read (R3.1's home) — and an
  **"Add feedback"** affordance pre-filled with run/node/visit/rendered_hash (R2's loop,
  finally in its own UI). Operator rows cyan; failures red.
- **Structured asks:** the needs-input card renders by ask type — approve/deny buttons
  (mapped from `can_use_tool` + `permission_suggestions`), choice chips, or free-text.
  The final render's improvement is adopted: multiple pending asks render as a checklist,
  each with View-context. Reply lifecycle: sending → delivered → card collapses into an
  operator row (the motion moment) → timeline flips within seconds; failed sends offer
  retry; already-answered renders resolved with input disabled.
- **Inspector (right): one continuous panel, not cards** (Codex hard-rejection accepted;
  the reply card stays a card — it IS the interaction). Sections: TIMELINE (vertical,
  duration bars, `node@visit` revisits grouped — never a linear lie), GIT (operational
  state: uncommitted count, unpushed count, PR + state, "probed Ns ago"; intended-vs-
  observed disagreement surfaced; "no PR" ≠ "forge unreachable"), USAGE (run cost + tokens,
  then **per-harness allowance rows — Claude Code and Codex remaining quota with reset
  time and freshness; exhausted / unreachable / unavailable are distinct; never invented
  estimates; exhausted raises an attention event**).
- **Header:** goal, the one status badge, muted meta, **Open in IntelliJ/VS Code**
  (configured editor; hidden for Plain runs w/o folder, disabled+tooltip for cleaned
  worktrees, unconfigured routes to Settings).

### State matrix (all specified, v1)

Loading skeletons; first-launch empty ("no runs yet — `howdah run <graph>`"); stream
disconnect shows a **STALE indicator** (frozen-but-live-looking is the silent failure);
harness-dead banner naming `howdah up`; allowance three-way states; reply lifecycle;
timeline loop rendering; zero-state per screen.

### Journey (notification → resolution)

Notification carries the wait duration and deep-links `run/:id#needs-input` with the ask
control focused. **The viewer process is supervised separately from the engine** so the
click never lands on connection-refused; if the harness IS down, the watchdog notification
says so and names the fix. Confirmation arc: answer → morph → badge flips → you leave.

### Motion brief (via /motion-brief — the binding spec)

| Surface | Verdict | Spec |
|---|---|---|
| SSE thread rows | Near-cut | opacity fade 120ms, NO translate, scroll-anchored |
| Timeline progress | Subtle | linear width tween; completion 200ms color crossfade |
| **Needs-attention** | **Authored moment 1** | card scale 0.98→1 + fade, 350ms ease-out-strong; ONE amber pulse then steady; favicon trunk-raise; chime |
| Tool row expand | Standard | height + chevron 200ms, interruptible (retargets, never restarts) |
| Run-list dots | Cut | 200ms color crossfade only, no loops |
| Theme switch | Cut | 150ms color crossfade (user chose boring over view-transition wipe) |
| **Reply send** | **Authored moment 2** | press scale → reply morphs into operator row (layoutId) → card exits → badge crossfades; ~400ms |
| Proposal accept | Modest | crossfade + collapse, P3 |

Global: `prefers-reduced-motion` keeps opacity/color, drops travel; transform/opacity only
on frequent paths; exits shorter than entries. Implementation refs: the animate /
motion-react / css-animations / animation-performance / animation-accessibility skills.

### Responsive & accessibility

Beside-the-IDE widths are the primary narrow case: inspector → tabs < 1100px, sidebar →
icons < 900px. Keyboard: j/k runs, r focuses reply, e expands, cmd-K, visible themed focus
rings. Needs-input announced via ARIA live region. 4.5:1 on all status colors incl.
amber-on-dark. 44px targets.

### Approved Mockups

| Screen | Mockup Path | Direction | Notes |
|---|---|---|---|
| Run view (baseline, user-approved 4/5) | ~/.gstack/projects/howdah/designs/cli-run-view-20260912/round3/variant-C.png | Split view, dark | Pre-review; rail still carded |
| Run view (final reference) | ~/.gstack/projects/howdah/designs/cli-run-view-20260912/final/howdah-run-view.png | Howdah identity, structured asks | One-shot regen post-review. Deltas vs spec: pinned wait-timer banner and allowance rows not in render — **the written spec wins**; its needs-input-as-checklist improvement is adopted. Its clip-art mark is superseded by logo B |
| Logo (approved) | ~/.gstack/projects/howdah/designs/howdah-logo-20260913/logo-B-oneline.png | One-line elephant, amber eye | User-picked over canopy and letterform-H concepts |
| Type (approved) | ~/.gstack/projects/howdah/designs/howdah-fonts-20260913/round2/fonts-A-spacegrotesk.png | Space Grotesk + JetBrains Mono | User-picked from 6 specimens/2 rounds; render's HUD decoration is NOT part of the direction — type only |

### Pass scores

| Pass | Initial → Final |
|---|---|
| 1 Info Arch | 3 → 9 |
| 2 States | 2 → 9 |
| 3 Journey | 3 → 9 |
| 4 AI Slop | 5 → 9 |
| 5 Design System | 4 → 8 (DESIGN.md generated post-v1) |
| 6 Responsive/A11y | 2 → 9 |
| 7 Decisions | all resolved (name, nav, start-run, identity, motion) |

### Design-derived task updates

- **T11 (P1) is now:** Howdah web app — 8 screens above, state matrix, structured asks,
  inspector panel, identity package, motion spec. Verify: every R3 sub-requirement + every
  state row demonstrable against a real run log; reply round-trips from an ask card.
- **T13 (P1, new):** Rename harness → Howdah: repo dir, CLI binary name (`howdah`),
  docs, gstack project slug. Forced by the harness.io collision.
- **T14 (P2, new):** Identity assets — vectorize the one-line elephant mark (static + trunk-raise
  favicon frames, amber-eye pixel), attention chime, Space Grotesk + JetBrains Mono packaging,
  token file. ✅ 2026-09-13: web/public/ — logo.svg, favicon + 2 raise frames, tokens.css, chime.wav.
- T6 gains: allowance/rate-limit events captured per harness (claude `rate_limit_event`,
  codex `account/rateLimits/updated` — both already observed in spike-findings.md).
- T10 gains: notification text carries wait duration + deep link; viewer supervised
  separately from engine.

## Build Phase 2 — Orbital-core parity (planned 2026-09-13)

Phase 1 (T1-T14) built the spine: typed graphs, prompt store + reviser loop, durable log,
adapters, engine with exactly-once + pinning, reconciler, attention, viewer v0. Phase 2
closes the gap to Orbital's observed core (research/orbital-spec.md) and autoresearcherUI:
REAL executors on your subscriptions, repos/worktrees/PRs, per-node agent config, graph
authoring + visualization, and the remaining screens.

### Gap map (user asks 2026-09-13 → tasks)

| Ask | Task |
|---|---|
| (a) create new graphs for kinds of work | T20 (+ T15 start-run form) |
| (b) connect GitHub repos for work | T15 + T18 |
| (c) per-node prompt/skills/model/effort | T17 |
| (d) PRs created, with links | T18 |
| (e) link to IntelliJ | T19 |
| (f) connect codex/claude subscriptions | T16 |

### Tasks

- [x] **T15 (P1, human: ~2d / CC: ~2h)** — config — Workspaces + run launcher ✅ 2026-09-13: config.json workspaces, howdah run/reply/graphs CLI, start-run form, run-started carries cwd
  - `~/.howdah/config.json`: repos (path, defaultBranch, setupScript) + Plain folders;
    `howdah run <graph> --repo <name> -i k=v` CLI; web start-run form (screen 6: graph
    picker, typed inputs as a real form, folder, harness override); run-started event
    gains `cwd` + `folder_kind`.
  - Verify: start a run from the web form against a registered repo; run-started carries cwd.
- [x] **T16 (P1, human: ~1wk / CC: ~4h)** — engine — REAL executors + `howdah up` + doctor (THE keystone) ✅ 2026-09-13: REAL claude+codex executors on subscription auth, permission round-trip browser→wire, howdah up + doctor; live write-doc run $0.13
  - `engine/executors/claude.ts`: spawn the logged-in `claude` CLI (Max subscription, no API
    key) with the T7 claudeArgs; stdout → JsonlChunkParser → mapClaudeEvent → chunk events;
    permission_request → structured ask (attention + reply card maps to control_response);
    rate_limit_event → allowance rows. `engine/executors/codex.ts`: `codex app-server`
    child, thread/start per run with cwd, notifications → events, approvals → asks,
    account/rateLimits/updated → allowance. `howdah up`: supervisor owning executors,
    resume-on-boot, heartbeat for the watchdog. `howdah doctor`: CLI presence/version/auth,
    capability-matrix assertions, allowance probe.
  - Verify: a real write-doc run end-to-end on the claude subscription; permission
    round-trip answered from the web reply card; codex run reaches turn/completed.
- [x] **T17 (P2, human: ~2d / CC: ~2h)** — core+adapter+web — Per-node agent config ✅ 2026-09-13: per-node model/effort/skills/permissionMode/maxTurns, run→node→graph resolution, model+cost per turn recorded
  - NodeDef agent gains `model`, `effort`, `skills[]`, `permissionMode`, `maxTurns`
    (harness already exists). Resolution order = run override → node → graph default
    (Orbital semantics). Adapters pass model/effort flags; skills asserted present by
    doctor (claude loads them via settingSources — proven in spikes). Model/effort/harness
    recorded on prompt-rendered + turn-finalized — fixes Orbital gap #6 ("Model —, Cost —").
  - Verify: two nodes in one graph run on different models; per-turn model + cost visible in UI.
- [x] **T18 (P1, human: ~4d / CC: ~3h)** — engine+web — Worktrees, commands, PRs with links ✅ 2026-09-13: worktree + command executors, probe:pr via gh, reconciled events, GIT rail + PR links + identity block
  - Worktree executor: `git worktree add -b howdah/<run>` under `~/.howdah/worktrees/`,
    setup script, remove + branch cleanup with clean/failed facts. Command executor:
    `bash -c`, 10min default timeout, final-JSON-line facts (Orbital parity); `probe:pr`
    routes through the T9 reconciler. New `reconciled` event (git + forge observation);
    run claims intended branch/PR at publish.
  - Web: GIT rail goes real — branch, uncommitted/unpushed, **PR link + state chip**,
    "probed Ns ago", intended-vs-observed disagreement banner; identity block (repo,
    branch, worktree, run id) and per-run pull-requests list (Orbital Overview parity).
  - Verify: implement-ticket against a scratch GitHub repo produces a PR whose link
    renders in the run view; disagreement banner fires on a mid-run branch rename.
- [x] **T19 (P2, human: ~1d / CC: ~1h)** — web — Settings + IDE deep link ✅ 2026-09-13: settings screen, POST /api/open-ide, header button with hidden/disabled/route-to-settings rules
  - Settings screen (5): editor command, Slack webhook, theme, chime, notification prefs →
    config.json. POST /api/open-ide spawns `idea <path>` (IntelliJ first). Header button
    per design: hidden for Plain runs without a folder, disabled + tooltip for cleaned
    worktrees, unconfigured routes to Settings.
  - Verify: button opens IntelliJ at the run's worktree.
- [x] **T20 (P2, human: ~3d / CC: ~3h)** — cli+web — Graph authoring + visualization ✅ 2026-09-13: howdah new-graph scaffolder (validated-or-rolled-back), Graphs screen + live DAG tab; quick-task example live at $0.04
  - `howdah new-graph`: scaffolder by kind (code / doc / research / custom) writing
    graphs/<name>.ts from a template + prompt stubs; gate stays tsc + validate — the
    TS-native decision stands, no visual editor in v1 (authoring UI = scaffold + your IDE).
    **Superseded by HOW-22.** There is now a visual editor, and the reason this line gave
    for not having one — "a visual editor to drift out of sync" — is answered rather than
    overruled: the FILE is still the only artifact and `validate()` is still the only judge.
    What changed is what a graph file may contain. A built graph is a `GraphSpec` literal
    plus one `buildGraph()` call (`core/graph-spec.ts`), so the builder re-opens the spec
    that was written instead of reverse-engineering one out of TypeScript, and a file the
    builder cannot read back turns the builder off for that graph and says so. The
    scaffolder, `howdah new-graph` and the source editor all stay for hand-written graphs.
  - Web: Graphs screen (list + SVG DAG render, class lanes); run view gains a Graph tab
    with current node + visit counts highlighted (Orbital / autoresearcherUI parity).
  - Verify: scaffold a new graph, launch it from the form, watch it advance on the Graph tab.
- [x] **T21 (P1, human: ~3d / CC: ~2h)** — web — Prompt library + proposal review screens ✅ 2026-09-15: Prompts + Proposals screens, run-view Add feedback, rendered-instance reconstruction (R3.1 completed); 38 new tests, loop driven end-to-end in a browser
  - Prompts screen (3): versions from git, consuming graphs, joined outcomes, attached
    feedback. Proposals screen (4): diff, evidence, eval score, accept/reject wired to
    store.accept (D7 stale-base + OV-3 guards), stale-base → re-draft affordance. Run view
    "Add feedback" writes reviser-format jsonl pre-filled with run/node/visit/rendered_hash.
  - Verify: feedback from a run → reviser proposal → accept in UI → next run pins v+1.
  - Built: `prompts/library.ts` (read model over prompts/ + git + feedback/ + run logs),
    `core/template.ts` (ONE render implementation shared by engine, store and library),
    `listProposals`/`viewProposal`/`stampEval` in prompts/proposals.ts, 8 API routes,
    two screens + the per-turn feedback card.
  - 🟡 **R3.1 gap found and closed:** `prompt-rendered` records the hash and context, never
    the rendered TEXT, so "the rendered prompt is visible" was only half true and feedback
    pointed at an instance nobody could read. `reconstructRender()` rebuilds it from the
    run's pinned template + context_read (+ operator-jump suffix) and **re-hashes to prove
    it**; a mismatch renders as UNVERIFIED rather than as fact. Chosen over storing the text
    per turn (multi-KB × every visit × fsync-per-append) and verified against logs the real
    engine wrote.
  - 🟡 Two bugs found by dogfooding, both fixed: `stale` was computed for accepted proposals
    (meaningless — an accept is what moves the prompt past its own base); the sidebar's
    pending count went stale after an accept, which is exactly the live-looking lie the
    state matrix forbids.
  - 🟡 `proposals.ts` CLI accepted against a hand-maintained list of 3 graphs, so the OV-3
    undeclared-read guard silently skipped every prompt used only by write-doc, research or
    quick-task. Now validates against the whole GRAPHS registry.
  - Not built: the reviser itself still runs from the CLI; the UI's re-draft button spawns
    it detached (it spends tokens) and the screen polls for the new proposal.
- [x] **T22 (P2, human: ~2d / CC: ~1.5h)** — engine+web — Steering + run controls ✅ 2026-09-13: control.json boundary pause/abort, operator-jump w/ prompt-injected instructions + read precheck, UI controls + Graph-tab jump
  - "Message the agent" box on running runs (claude: queued next-turn injection; codex:
    turn/steer). Controls: pause / resume / retry (new visit) / abort, as API + UI,
    executed by `howdah up`.
  - Verify: a steering message lands in the next turn and renders as an operator row.

### Order

```
T15 ──▶ T16 ──▶ T18 ──▶ (real code work end-to-end: repo → worktree → PR link)
                 ├────▶ T17
                 └────▶ T22
T21 (independent — store + logs exist)     T19, T20 (after T15)
```

T16 is the convergence point: (f) unlocks (b,c,d) being real rather than seeded. Suggested
first slice: T15+T16 together — after them, a real claude-subscription run is visible in the
viewer end to end, which is the moment Howdah replaces Orbital for one workflow.

## Build Phase 3 — use-driven (opened 2026-09-15)

Five items raised after living with the built thing. Two shipped immediately; three are
tasks below. Ordered **T25 → T24 → T23**: the design work covers T24's new surfaces, so the
run view gets built once inside a system that has been agreed, and T23 is UI-independent.

- [x] **P3-a — worktrees grouped by repo** ✅ 2026-09-15: `$HOWDAH_HOME/repos/<repo>/worktrees/<runId>`
  - The registered workspace name, not the directory basename: two clones of different orgs'
    `api` would otherwise share one folder. Unregistered `--dir` runs fall back to basename.
  - No migration: `worktree.json` holds an absolute path, so existing worktrees keep working
    and clean up from wherever they are. Only new ones use the new shape.
- [x] **P3-b — the boot jingle belongs to a load, not to navigation** ✅ 2026-09-15
  - The sidebar mark replayed the splash (and `boot.wav`) on click, so going back to Runs by
    clicking the logo re-played it. The mark is now a plain home link. The attention chime is
    a different sound and is untouched.

- [ ] **T23 (P1) — engine — Harness failover on allowance exhaustion**
  - Today `allowance{state:"exhausted"}` is recorded and rendered and **acted on by nothing**.
    The CLI exits non-zero, the executor throws, and the run parks with `executor threw: …` —
    so running out of tokens is indistinguishable from a crash, which is the R3.3 failure the
    watchdog exists to prevent.
  - Decision (user, 2026-09-15): **auto-failover and say so.** On exhausted, switch to the
    next harness, re-attempt the node, write a `harness-fallback` event, and raise a
    non-blocking notification. Park only when every harness is exhausted, naming the earliest
    `resets_at`. Rejected: park-and-ask (an overnight run sits dead), silent failover (a run
    finishing on a weaker model without saying so).
  - Leans on what exists: `prompt-rendered` already records harness/model/effort per turn, so
    the record stays honest; `resolveAgentConfig` already drops a model belonging to the other
    harness; node re-attempt is already first-class. Fallback order belongs in AgentConfig,
    resolved by the same five-layer precedence.
  - Verify: exhaust claude mid-run (fake the event), watch the node re-attempt on codex, the
    thread show the switch, and the run finish.

- [x] **T24 (P1) — web — Run view: steps by node, detail tab, full context, chat** ✅ 2026-09-16: Steps (Inngest split + waiting split), Thread transcript, Logs, Context, read-only Chat — all five surfaces shipped
  - (a) thread grouped into node steps rather than a flat turn stream; (b) detailed logs
    behind a tab; (c) a full-context view — every key, current value, writer, visit, scope;
    (d) chat about the run.
  - (c) needs no new event type: `node-finished.writes` carries every published value, so
    current context and its provenance are derivable from the log like everything else.
  - Decision (user, 2026-09-15): chat is **read-only Q&A** — an agent seeded with the run's
    context, thread and rendered prompts that answers "why did it do that?" and cannot edit
    files or move the run. Rejected: merging it with T22 steering, and a full agent session on
    the worktree (a second agent mutating a worktree the run is still using).
  - Sequenced after T25 so it is built inside the agreed design.
  - Designed 2026-09-16, five surfaces on real run data (24 real steps, the real context keys
    and scopes from this file's graph): https://claude.ai/artifact/DGdpDEVNbPmUdxiwcCH641
  - Anchor pattern (user, 2026-09-16): **Inngest's split Steps layout** — timeline left,
    selected step's detail right, approval card inside that panel rather than floating over
    the list. The waiting step's bar splits into agent-working vs waiting-on-you, which is
    derivable from `attention-raised` → `attention-resolved` inside an attempt: no new event.
  - Thread: Laminar's transcript — one row per event with time · tokens · cost; row types are
    told apart by icon shape, never hue, so amber keeps meaning only "needs you".
  - Logs: Logfire's dense list under a level/type filter bar; every type from log/events.ts.
  - Context: run-level table (key · value · scope · writer · at) with write history and
    read-by. No tool surveyed has this; Orbital's was per-step and usually empty (CUR5).
  - Chat: LangSmith Polly's pattern — answers cite the steps they came from.
  - Borrowing: Trigger.dev and Laminar are Apache-2.0 (keep LICENSE/NOTICE with any copied
    code); Langfuse is MIT outside its `ee/` dirs. Look-only: Inngest (SSPL), Phoenix
    (Elastic 2.0), Logfire and LangSmith (closed).
  - Delivered as 13 single-commit stories (docs/plans/2026-09-16-00001-stories-run-view.md,
    kept out of the repo per the commit convention). Highlights worth remembering:
    - The waiting split needed NO new event: it is the overlap of attention-raised →
      attention-resolved with the attempt's own interval, clamped so a run parked AFTER a
      step failed is not charged to that step. On the seeded 16h run: 15h 42m of it was a
      human not looking. That number is R3.3 made visible.
    - An unresolved ask keeps the Steps axis measuring to now, or the waiting bar freezes at
      the moment the ask was raised and hours of waiting render as nothing.
    - deriveLogRows switches exhaustively over the event union with a `never` fallthrough, so
      a new event type fails the build rather than rendering a blank row.
    - Context lists declared-but-unwritten keys, which is precisely what Orbital's per-step
      tab could not do (CUR5 closed).
    - Chat is read-only and honours HOWDAH_STUB; citations are whitelisted against this run's
      own steps and rendered as text, because model output is untrusted input.

- [ ] **T25 (P1) — design — Full design consultation**
  - Trigger: "I dont like the design." That is the system, not spacing, so this re-opens the
    Design section's decisions (palette, type, layout, motion) rather than QA-ing them.
  - Decision (user, 2026-09-15): `/design-consultation` — research, a complete proposed
    system, font and colour previews to choose from. Rejected: a designer's-eye QA pass
    (polishes a system that is not landing) and a variant shotgun.
  - Brief must include T24's new surfaces so they are designed, not retrofitted.
  - Decision (user, 2026-09-15): **A + B**. A's restraint with the two things variant B proved:
    26px rows and an amber rule on the row that needs you, plus a node column wide enough for
    `implementation.plan_review`. B's structural elephant glyphs are dropped: illegible at 12px.
    C lost because its green "done" bars pull the eye off the waiting row. Compared as three
    artboards on real run data: https://claude.ai/artifact/DGdpDEVNbPmUdxiwcCH641
  - Font note: the canvas used Instrument Sans (General Sans cannot load there). It shares a
    font host with JetBrains Mono, so it is a candidate to keep; settle it in DESIGN.md.
  - Remaining: reference research for T24's surfaces, then DESIGN.md.

- [x] **HOW-23 (P1) — graphs — One feature, many graphs: `plan-feature`** ✅ 2026-09-23
  - Trigger: "The current slice node is not helpful. So the intention with it was maybe better
    as a skill." The `implement-slice` ceremony asks the operator to review identity keys
    before any code exists; what they actually want to decide about a large, multi-repo feature
    is which vertical slices it breaks into. So the unit of work moves from one graph to MANY:
    plan once, approve the decomposition, raise a Linear ticket per slice, and launch an
    independent `implement-ticket` run per ticket — one small PR each.
  - Decision (user, from the ticket): **multi-graph fan-out**, not a richer single graph. A
    slice that is its own run gets its own worktree, branch, PR, park and reply — every
    facility the harness already has — instead of a parallelism the engine would have had to
    grow. `plan-feature` reuses `implement-slice`'s proven approval shape (map.extract →
    propose → approve, with stale detection and redesign) and changes only the payload and the
    ending.
  - "Maybe better as a skill" is honoured in the PROMPT, not the graph: `plan.propose` opens
    with the installed-skills line, so a shaping/decomposition skill does the work. Declaring
    `skills:` on the node was rejected — `doctor` asserts declared skills exist, so it would
    fail on a machine that lacks them.
  - Rejected, deliberately, and each is a follow-up rather than a gap:
    - **The parent supervising its children** (wave-gating a dependent slice on its
      prerequisite's merge). It would turn a run that finishes in minutes into one that lives
      for days, and the failure modes are all new. `depends_on` orders the launches and is
      recorded in the ticket body as prose instead.
    - **Retiring `implement-slice` in the same change.** It drags in `map/ghosts.ts`,
      `map/drift.ts`, `cli/metrics.ts`'s slice-vs-ticket comparison and the ghost half of the
      approval card. Nothing in HOW-23 depends on that decision; make it once the new workflow
      has proved out.
    - **Cross-repo map extraction.** `map/` is single-project by design (cross-project
      resolution is SCIP, slice 2). The map grounds the primary repo; slices in other
      registered workspaces are planned from the brief, and the prompt says so.
  - Two rules carry weight beyond well-formedness. The slice ID GRAMMAR, because the id becomes
    part of the child run id and its git branch — identity, not a label. And the CAP of 8
    slices, because approving a plan launches every slice at once: it is a review and a bill,
    and a bigger feature is asked for as a smaller first tranche rather than refused.
  - The fan-out is exactly-once three guards deep (precheck before any spawn, deterministic
    child ids, `effects.claim`/`done`) because a half-launched fan-out costs duplicate PRs and
    a second harness allowance. See CLAUDE.md's multi-graph fan-out invariant.
  - Review correction (2026-09-23). The precheck now covers the NODE'S OWN DECLARATION as well
    as the plan: `declaredWrites` throws on a key the built-in cannot publish and it ran after
    the spawn loop, so a node declaring anything but `launched` started every child and only
    then parked — and every retry threw again, so it could never succeed. And `runs:launch`
    joined `core/graph-spec.ts`'s `COMMAND_BUILTINS`, which it had never been added to, so the
    HOW-22 builder can offer it and refuses the same declaration in the browser. That table now
    carries a built-in's READS as well as its writes, because this is the one built-in that
    reads context by name and a command step has no reads control to fix it with; a test pins
    that every built-in the command executor dispatches has a row.

- [x] **HOW-24 (P1) — web — A full canvas graph creator** ✅ 2026-09-23
  - Trigger: "The current workflow / graph creator is very confusing and the current UI doesn't
    work. Can we have a full UI creator. We should use this example project and re-use same
    approach — github.com/nobruf/shadcn-next-workflows."
  - The confusion was STRUCTURAL, and the code said where it came from. The HOW-22 wizard split
    ONE step across three panes — its identity in Steps, the values it passes in Fields, what
    happens after it in Branching — and then had to keep re-uniting them. The picture beside the
    rail could only be READ. And the thing an operator actually wants to say, "this step, then
    that one", was a `<select>` row under the fourth tab, per step, whose default was "pause and
    ask me". So the fix is not wording: the picture becomes the editor.
  - Decision (from the ticket): **`@xyflow/react` v12**, which is what the named reference
    project is built on. Its whole tree is zustand + classcat + d3-{drag,zoom,selection,
    interpolate} — no Radix, so `web/app/css-contract.test.ts`'s no-Radix gate is untouched.
    This is the viewer's first framework dependency and it contradicts CLAUDE.md's "No framework
    beyond React + Tailwind"; that line is amended there with the reason rather than quietly
    broken. Hand-rolling drag-to-connect, hit-testing, marquee select and pan/zoom on
    `graph-dag.tsx`'s SVG was the alternative: several hundred lines of newly-owned interaction
    code, and not "the same approach" the ticket asked for.
  - Decision: **a step's position lives in the SPEC** (`NodeSpec.position`, additive, optional,
    so `SPEC_VERSION` stays 1). A canvas whose steps spring back to an auto-layout on reload is
    not a canvas. A sidecar file keyed by graph name was rejected on the repo's own rule — it
    would split the artifact in two and break `buildGraph`'s exact round trip. `compileNode`
    drops it, so the engine sees the identical `Graph`; `core/graph-spec.test.ts` pins that.
  - Nothing below the presentation layer changed meaning. `PUT /api/graphs/:name/builder` takes
    the same `{spec, prompts, intent}`, `graphs/builder.ts` runs the same `specProblems()` over
    the spec it is about to write, and `graphs/builder.test.ts`'s "the browser's verdict and the
    server's gate cannot disagree" passes unmodified — which is the strongest single signal that
    this was a presentation change.
  - `SpecProblem.where` was NOT re-spelled for the new regions. Its four values are named in ~40
    messages in `core/graph-spec.ts` and consumed by `graphs/builder.ts`; changing core for a
    presentation reason is the wrong trade. The UI maps instead, in one line: a problem that
    names a step is drawn on that step, and one that names none belongs to the graph.
  - Two rules the canvas had to be held to, because it is a NEW creation path and it was a
    creation path forgetting one that produced HOW-22's finding 3. A drawn wire is born able to
    fire (`seedPredicate`, shared with "Add a condition"), and appending it keeps row order —
    which is priority — meaning what the operator saw.
  - Nothing became mouse-only (HOW-16 P2 made the builder keyboard-operable and a canvas must
    not quietly give that back). Every palette item is a `Button` that is also `draggable`;
    every step's routes can be set from its panel without drawing a wire; the way INTO a step is
    a real control on its card, not the card itself; and the caption on a wire is a `Button`,
    because a hairline is not a click target.
  - Deviations from the plan, each for a reason found in the building: no minimap (it covers a
    corner of a five-to-ten-step graph, which is every graph this builds), the canvas gets its
    own layout PITCH (its cards are taller and a condition is printed in the gap, not beside
    it), and `css-contract.test.ts` gained a BEHAVIOURAL exemption list for React Flow's
    `nodrag` / `nopan` — names a library reads in JavaScript, which the vendor sheet
    deliberately gives no rules.
  - **Found in review — three library facts that cost real time to find once, so they are
    written down.** (1) A controlled `nodes` prop DISCARDS every node change unless
    `onNodesChange` is supplied: `triggerNodeChanges` applies changes only when
    `hasDefaultNodes`, so the first cut's card did not follow the pointer (it jumped at
    mouse-up, because `onNodeDragStop` is handed the DRAG ITEM's position rather than the
    store's) and React Flow's arrow-key nudge moved nothing at all. Fixed by supplying the
    handler and keeping the in-flight positions in a local overlay — the DRAFT still changes
    exactly once per gesture, which was the property the omission looked like it was
    protecting. (2) `deleteKeyCode` defaults to `'Backspace'`, bound on `document`, and
    `isInputDOMNode` exempts INPUT/SELECT/TEXTAREA and `contenteditable` — NOT a `BUTTON`,
    which is the documented keyboard way into a step. Tab, Enter, Backspace destroyed a step
    and its prompt body with no confirmation and no undo. The key is off (`deleteKeyCode={null}`)
    and removal is a named control that says what goes and asks first when the text cannot be
    got back. (3) A placement promised in UI copy has to be a placement the code makes: the
    palette said "drop it in the middle" and the click path passed no position at all, so the
    reducer put the step below everything — off-screen on any graph taller than the pane.
    `useCanvasCentre()` now goes through the same `screenToFlowPosition` a drop uses, and
    `freeSpotNear()` steps aside from what is already there.
  - **Found in the second review — two facts about editing a list by INDEX, neither of them
    about React Flow.** (1) AN INDEX-ADDRESSED SELECTION HAS TO BE DROPPED BY WHATEVER RENUMBERS
    THE LIST. `remove-edge` filters by index, so every later edge slides down one; the shell's
    "a selection that no longer exists is a panel to close" only fires for the LAST edge, so
    removing any other left the route panel open and silently retargeted to the route that took
    that index — and a second press destroyed it. The cure is the callback the step form already
    had (`onRemoved` → `onSelect(null)`), not a smarter guard: it closes in the same render, and
    the panel that did the removing is the one place that knows it happened. (2) A PANEL THAT
    REBUILDS A COLLECTION WHOLESALE MUST RENDER EVERYTHING IT WILL WRITE BACK. `StepRoutes`
    emits a step's whole outgoing list through `set-branching`, but drew only the FIRST
    unconditional route; a second one — legal to make, and reported by `specProblems` on that
    very step — was deleted by the next edit, and the message about it pointed at a row that was
    not on screen. Rendering one "Otherwise" row per unconditional route makes preservation fall
    out of the rendering instead of being a second rule to remember, and makes core's refusal
    actionable where it is printed.

- [x] **HOW-25 (P1) — engine + web — A harness question reaches a human: the Chat pane** ✅ 2026-09-23
  - Trigger (from the ticket): "With skills that have user ask questions, nothing works. We
    don't follow the normal chat flow." A graph whose prompt leans on an ask-the-user skill
    FROZE: the run showed `running`, the viewer's stale-run banner counted the minutes, and
    nothing ever rang.
  - Root cause, three failures stacked. (1) `AskUserQuestion` arrives as a `can_use_tool`
    request the executor treated as an ordinary permission, so the park read "AskUserQuestion
    needs permission" and the questions stayed in the payload. (2) `web/app/run/ask.tsx`
    rendered `ask.reason` and a text box and NEVER rendered `ask.ask`, so the question, its
    options and their descriptions were on disk and not on screen. (3) `executors/reply.ts`
    `isAllowReply` collapsed the reply to allow/deny, so "Option B" reached the model as
    `permission denied: Option B`. Each alone is bad; together they are "nothing works".
  - **The transport was probed, not assumed, and the plan's primary guess was wrong.** The CLI
    does carry a dialog channel (`request_user_dialog`, kinds declared with
    `supportedDialogKinds` on an `initialize` control_request, `getPendingUserDialogRequests`,
    park deadlines, the lot) and the plan was written against it. Against claude 2.1.278 under
    `-p`, declaring `ask_user_question` and having the declaration ACKNOWLEDGED still routed
    the question through `can_use_tool` with `requires_user_interaction: true` — the dialog
    channel belongs to the CLI's cloud host (`headlessCloudClient`), not to us. So the
    plan's own named fallback became the design, no `initialize` frame is sent, and no
    speculative dialog code was written against a path that cannot be tested here. The real
    turn is pinned in `adapter/fixtures/claude-ask-user-question.jsonl`.
  - The answer channel is narrow and that is load-bearing: the permission response schema is
    `{behavior:"allow", updatedInput?}` or `{behavior:"deny", message}` with NO result field.
    Answering `allow` runs the tool with nobody to ask and returns "The user did not answer the
    questions." — the same freeze in a different disguise. So the operator's choice travels in
    the deny `message`, worded with the CLI's OWN answered-question sentence so the model reads
    a familiar tool result. Both halves were probed live before a line was written.
  - Issue 2 in the plan (a park deadline vs a human who takes hours) largely dissolved with the
    transport: the deadline machinery belongs to the dialog channel, and the permission channel
    showed no deadline when probed. `askTimeoutMs` exists, unset by default, so the guard is
    real and testable and a future CLI that DOES expire a question parks with a reason instead
    of answering into a closed door.
  - The AI SDK suggestion in the ticket was checked and DECLINED on evidence:
    `@shadcn/helpers`' `createChat()` is a mock ChatTransport for demos, not a UI kit, and the
    chat components live in AI Elements, which pulls Radix (banned here) plus a markdown stack,
    and `useChat` wants a UI-message-stream endpoint an append-only log is not. What was worth
    taking is the MESSAGE-PARTS shape, and `log/coalesce.ts` `TurnPart` already was it. Shape
    adopted, dependency declined, zero new packages.
  - Chat became the DEFAULT tab: the thing that needs interacting with is the question, and the
    question lives in the conversation. Steps/Context/Logs/Graph are untouched.
  - A latent hang was fixed on the way past: the permission poll loop watched only the log, so
    a CLI that died mid-ask spun for ever. `awaitOperator` is now the one wait for both kinds
    of ask and ends in exactly one of an answer, a dead harness, or a configured ceiling.
  - Deliberately out: steering (an existing planned slice with its own event type); codex and
    cursor question parity (DECLARED `user_questions: "no"` in `adapter/capabilities.ts` rather
    than papered over — a graph that needs asking should pin `harness: "claude"`); the other
    dialog kinds (`plan_approval`, `refusal_fallback_prompt`) — declaring a kind we cannot draw
    is worse than declaring none.

- [x] **HOW-12 (P1) — engine + graphs — Behavioural evidence before review: `verify:run`** ✅ 2026-10-08
  - The finding: implement-slice concluded on structural evidence only. Drift is tree-sitter
    over source, so a `verified` ghost proves the code PARSES as designed — and the first
    behavioural signal was CI on the PR, after `delivery.publish`. That is the map's own
    "never present a guess as fact" rule, broken one layer up.
  - Option A shipped: a `verify:run` command built-in runs the repo workspace's
    `verifyCommand` in the worktree and publishes `verify.result` (`core/verify.ts`):
    `pass` / `fail` / `not-checked`, with exit code, timing, a bounded output tail, the commit
    (+ dirty) it ran against, and the final JSON line as `facts`. implement-slice runs it
    between `map.drift` and `implementation.local_review`, whose prompt (v2) makes `fail`
    blocking and forbids reading `not-checked` as a pass.
  - `fail` SUCCEEDS the attempt — evidence goes to the reviewer, it does not park. And an
    unconfigured workspace is `not-checked`, not a park, or every implement-slice run would
    stop until HOW-15's environment contract (which may subsume `verifyCommand`) exists.
  - Deliberately out, each its own follow-up: **Option B, the real target** — a runtime-evidence
    tier joined to each ghost, so a ghost reaches `verified` only with structural AND
    behavioural proof and drift reports the two independently (touches `log/events.ts`,
    `map/drift.ts`, `map/ghosts.ts`, `web/derive.ts`; needs its own shaping pass). Also out:
    re-verifying after delivery repairs, verify in implement-ticket, and any viewer change
    (context writes already render generically).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | ISSUES_FOUND | eng outside voice: 10 items folded; design outside voice: hard-rejection + litmus fails, all resolved |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAN (PLAN) | 9 issues, 0 critical gaps, 13 decisions — one (D13 viewer) superseded at design review |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAN (FULL) | score 3/10 → 9/10; 20+ decisions incl. rename to Howdah, motion brief, 8-screen spec |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** Ran twice. Eng pass: 10 findings (2 tensions accepted, 8 folded). Design pass: hard-rejected the carded rail (accepted → continuous inspector), failed litmus on brand/anchor/state-contradiction (all resolved: Howdah identity, needs-input-owns-hierarchy, canonical status enum).
- **CROSS-MODEL:** Codex and the independent Claude read converged on every critical design finding — needs-input below the fold, missing wait timer, status contradiction, missing allowance spec, missing screens/nav. The design review also formally reversed eng-review D13 (CLI-first) on mockup evidence, and the naming rounds discovered harness.io ($5.5B, same category), forcing the rename the review would otherwise have missed.
- **VERDICT:** ENG + DESIGN CLEARED — ready to implement. Build order: T1 (reviser ground-truth eval — still the escape hatch) alongside T13 (rename), then lanes as tabled.

NO UNRESOLVED DECISIONS
