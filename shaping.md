w---
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
| A0.2 | 🟡 Node types at v1: agent, command, wait, terminal, **worktree** (pulled forward — concurrent code runs need isolation, D11). Fan-out/join stays deferred | |
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

## B: Engine first, DOT-compatible, prompts inline

Rebuild Orbital's model properly, then add the prompt loop.

| Part | Mechanism | Flag |
|------|-----------|:----:|
| B1 | DOT parser and static validator, Orbital-compatible subset so existing graphs import | |
| B2 | Full runner: agent, command, worktree, fan-out/join, wait, terminal | ⚠️ |
| B3 | Event log and web UI covering R3.1-R3.5 | |
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
- **A and B both pass everything else.** A's remaining risk is A4.2 (own engine, deferred node types); B's is B2 (full engine up front).

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

- **Fan-out/join node** — no current workflow uses parallel branches; add when one does.
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

- 🟡 **Space Grotesk (display/headings) + JetBrains Mono (ids/costs/diffs/data)**, with
  JetBrains Mono doubling as the body face for dense rows and Space Grotesk for headings and
  prose. User-picked from six rendered specimens across two rounds (over Geist — the P4-1
  pick made blind — and over mono-first and editorial-serif directions). Both free (Google
  Fonts), variable. Discipline note: Space Grotesk's quirk lives in headings; data stays mono.
- shadcn CSS variables as the single token source; both themes derive from it. Amber = the
  only loud color, reserved for attention. Status palette + the two motion tokens
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
