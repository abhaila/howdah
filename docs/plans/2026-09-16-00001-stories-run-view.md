# User Stories Plan

## Project Overview

Howdah is a single-user harness that runs graphs of agent work against the local `claude` and
`codex` CLIs. Its one justified interruption is "an agent is waiting for you" (R3.3), and its
differentiator is a feedback loop that improves prompts (R2).

This plan delivers **T24 — the run view** and the remainder of **T25 — the design system**,
against the approved designs: https://claude.ai/artifact/DGdpDEVNbPmUdxiwcCH641

The user is one person: the operator, watching agents from a window beside their IDE.

**Settled before this plan** (do not re-litigate in stories):

- Direction **A + B**: dark, chrome-free, 26px rows, amber rule on the waiting row.
- **Colour is the alarm, not a taxonomy.** `#F2A93B` is reserved for "needs you". Row types
  are told apart by icon shape. `done` gets no colour at all.
- **Steps uses Inngest's split layout** (user, 2026-09-16): timeline left, selected step's
  detail right, approval card inside that panel.
- **Chat is read-only** (user, 2026-09-15): it answers questions about a run and can neither
  reply to the agent nor move the run.

**Invariants every story must respect** (CLAUDE.md):

- The log is the only storage. New screens derive from `run.jsonl`; no sidecar state.
- If a screen needs a fact the log lacks, add an event type to `log/events.ts` — never a
  mutable record.
- `needs-input` outranks `failed` in the one canonical status renderer.
- Tests sit next to their subject and use `bun:test`.

## Story Mapping Overview

| Epic | Stories | Delivers |
|---|---|---|
| 1. The system | 1–2 | The app stops looking like an admin dashboard |
| 2. Steps (anchor) | 3–5 | The run reads as steps; the wait is visible; the ask has a home |
| 3. Thread | 6 | The transcript stops being a wall of deltas |
| 4. Logs | 7–8 | Every event, filterable, with its raw form |
| 5. Context | 9–10 | The run-level context view nothing else has |
| 6. Chat | 11–13 | Ask why, instead of scrolling |

Order matters once: **1 before everything visual**, and **3 before 4/5** because the Steps
detail panel is the shell the Logs and Context detail panels reuse.

---

## Epic 1: The system

### [x] **Ticket: The run view reads as an instrument, not a dashboard**

**As an** operator watching agents from a window beside my IDE
**I want** the app to be dark, quiet and dense
**So that** when something turns amber I know without reading that it is me it wants

**Context**: The current palette assigns teal to actions and lavender to activity, but those
colours reach the screen so rarely that the app spends its life as grey-on-near-white. Colour
spent on categorisation is colour unavailable for the alarm.

**Description**: Replace the token set with the A+B system and write `DESIGN.md` as its
source of truth, in the same commit, so the rules and the values cannot drift apart.

**Implementation Requirements**:
- `web/public/tokens.css`: dark-first ground `#0B0C0D`, raised `#141517`, inset `#1B1D1F`,
  hairline `#232527`, strong `#303336`, text `#E8E6E1`, muted `#9A9892`, faint `#605F5B`.
- Status: `needs-input` `#F2A93B`, `running` `#7FA0A8`, failure `#D9553F`, `done` no hue.
- Type: Instrument Sans (UI and prose) + JetBrains Mono (ids, durations, costs, diffs);
  update the Google Fonts link in `web/public/index.html`.
- `web/app/globals.css`: the shadcn `@theme` mapping follows the new tokens.
- `DESIGN.md` at the repo root: the alarm rule, the icon-shape rule, the type pairing, the
  4px spacing base, and the motion tokens carried over unchanged.

**Acceptance Criteria**:
- [x] Given a run that needs nothing, when I open it, then no saturated colour appears anywhere on screen
- [x] Given a run that needs me, when I open it, then amber appears only on the banner, the waiting row, the wait timer and the nav badge
- [x] Given a completed step, when I look at its row, then its status carries no hue
- [x] Given the light theme, when I switch to it, then every status colour still clears 4.5:1 against its background
- [x] Accessibility: amber and the failure red remain distinguishable under deuteranopia (icon shape carries status independently of hue)
- [x] `DESIGN.md` states the alarm rule in one sentence a future session cannot misread

**Definition of Done** (Single Commit):
- [x] Feature complete in one atomic commit
- [x] All code, tests, and documentation included
- [x] Unit tests written and passing
- [x] Integration tests passing for the specific increment
- [x] Manual testing complete for the delivered feature
- [x] Security review passed (n/a — CSS and docs only)
- [x] Performance impact assessed (no new requests; one font family swapped)
- [x] Documentation updated within the same commit (`DESIGN.md`, CLAUDE.md design pointer)
- [x] Ready for independent deployment
- [x] Metrics configured and wired in — for this local tool that means the verify step is
      recorded in `shaping.md` T25, not analytics

**Dependencies**:
- None. This is the base every later story is judged against.

**Risks**:
- Instrument Sans is a substitute for General Sans, which cannot load in the design canvas.
  Mitigation: both are on the same font host as JetBrains Mono; settle it in `DESIGN.md` and
  note the alternative so a later change is one line.
- A palette change touches every screen at once. Mitigation: tokens only, no component edits,
  so a revert is a single file.

**Notes**: The canvas artboards are the reference render. Lift the hex values from them rather
than re-deriving.

**Effort Estimate**: S (3–4 hours)

---

### [x] **Ticket: Lists stop being a stack of cards**

**As an** operator scanning 27 prompts or a long run list
**I want** rows that are rows
**So that** I can see the whole list without scrolling past identical rectangles

**Context**: Every list row carries `background + 1px border + radius`. That is the generic
shadcn shape and the single biggest reason the app reads as a dashboard. Linear's density
comes from deleting chrome, not shrinking text.

**Description**: Remove the card treatment from list rows across Runs, Prompts, Proposals and
Graphs; separate rows with a hairline and spacing; tighten row height to 26px.

**Implementation Requirements**:
- `web/public/howdah.css`: `.run-row` loses its background, border and radius; gains a
  bottom hairline and a 26px height.
- Hover and selected states come from `--bg-raised` and an inset left rule, not a border.
- `.library-layout` and `.graphs-layout` keep their split but lose the boxed feel.
- No changes to `main.tsx` markup — this must be a stylesheet-only change to stay revertible.

**Acceptance Criteria**:
- [x] Given the Prompts screen with 27 prompts, when it loads at 900px height, then at least 24 rows are visible without scrolling
- [x] Given a run row I hover, when the pointer enters, then the row raises without a border appearing
- [x] Given the runs list with a needs-input run, when it renders, then that row is marked by an amber rule rather than a coloured card
- [x] Performance: no layout thrash — row height is fixed, not content-derived
- [x] Accessibility: focus rings remain visible on the new backgrounds

**Definition of Done** (Single Commit):
- [x] Feature complete in one atomic commit
- [x] All code, tests, and documentation included
- [x] Unit tests written and passing (existing web tests still green)
- [x] Integration tests passing for the specific increment
- [x] Manual testing complete for the delivered feature
- [x] Security review passed (n/a)
- [x] Performance impact assessed
- [x] Documentation updated within the same commit (`DESIGN.md` density section)
- [x] Ready for independent deployment
- [x] Metrics configured and wired in — rows-visible-per-screen recorded in the verify note

**Dependencies**:
- [x] Story 1 (tokens), for the hairline and raised values

**Risks**:
- Density can overshoot into unreadable. Mitigation: 26px was chosen against a real render in
  the canvas, not in the abstract.

**Notes**: Keep the Graphs screen on its existing split; only the row treatment changes.

**Effort Estimate**: XS (2 hours)

---

## Epic 2: Steps — the anchor

### [x] **Ticket: A run reads as a list of steps with a time bar**

**As an** operator opening an 18-hour run
**I want** every node visit as one row with a bar showing when it happened
**So that** I can see the shape of the run without reading the thread

**Context**: The current Thread is a flat turn stream; the timeline lives in the rail as a
handful of rows. Orbital's Steps tab is what the operator actually missed.

**Description**: Add a Steps tab to the run view, rendering one row per `node@visit` with a
status glyph, node name, time-proportional duration bar and duration.

**Implementation Requirements**:
- `web/derive.ts`: extend `deriveTimeline` rows with `offset_ms` and `run_span_ms` so a bar
  can be positioned without the UI recomputing the run window.
- `web/app/main.tsx`: a `Steps` tab, default for repo runs; rows at 26px.
- Status glyphs as inline SVG (check, cross, alert triangle, half-circle), never dingbats.
- Bars carry a 3px minimum width so a 0.9s step is still visible.

**Acceptance Criteria**:
- [x] Given a run with 24 node visits, when I open Steps, then all 24 rows render with bars positioned proportionally across the run's span
- [x] Given a step lasting 0.9s in a 13-hour run, when it renders, then its bar is still visible
- [x] Given a failed attempt, when it renders, then its glyph is the failure cross and its bar is the failure red
- [x] Given a run still in flight, when the last node is running, then its row shows the running glyph
- [x] Given a plain (non-repo) run, when I open it, then Steps still renders — no git assumptions
- [x] Performance: derivation stays O(events); no per-row scan of the whole log

**Definition of Done** (Single Commit):
- [x] Feature complete in one atomic commit
- [x] All code, tests, and documentation included
- [x] Unit tests written and passing (`web/web.test.ts`: offsets, spans, min-width case)
- [x] Integration tests passing for the specific increment
- [x] Manual testing complete for the delivered feature
- [x] Security review passed (n/a — read model)
- [x] Performance impact assessed
- [x] Documentation updated within the same commit
- [x] Ready for independent deployment
- [x] Metrics configured and wired in — steps-visible-per-screen in the verify note

**Dependencies**:
- [x] Story 1 (tokens) for the status values

**Risks**:
- A 13-hour run with 8 wait loops squashes the interesting steps into the first 5%.
  Mitigation: bars are proportional but rows are uniform, so the list stays scannable; zoom
  is explicitly out of scope for this story.

**Notes**: Reuse `deriveTimeline`'s existing revisit grouping; do not introduce a second
notion of "step".

**Effort Estimate**: S (3–4 hours)

---

### [x] **Ticket: The waiting step shows how much of it was me**

**As an** operator who left a run overnight
**I want** the waiting step's bar split into agent time and my time
**So that** I can see at a glance that four hours of a five-hour step was me not looking

**Context**: R3.3's evidence is a step that sat in *Needs you* for 4h 10m. Today that reads as
one long bar, indistinguishable from slow work.

**Description**: Split a step's bar into the time the agent worked and the time it spent
waiting on a human, derived from the attention events inside the attempt.

**Implementation Requirements**:
- `web/derive.ts`: for each timeline row, pair `attention-raised` with the following
  `attention-resolved` within the same `node@visit` and emit `waiting_ms`.
- An unresolved ask means waiting continues to now — the row's waiting segment is open-ended.
- The bar renders the working segment in the hairline-strong grey and the waiting segment in
  amber; the step detail repeats the split as two labelled rows.
- No new event type: both events already exist in `log/events.ts`.

**Acceptance Criteria**:
- [x] Given a step that raised an ask and had it answered, when it renders, then the bar shows working then waiting, and the two sum to the step duration
- [x] Given a step waiting right now, when it renders, then the waiting segment extends to the current time and the row is the amber one
- [x] Given a step that never raised an ask, when it renders, then the bar has a single segment and no amber
- [x] Given two asks in one attempt, when it renders, then both waiting periods are counted
- [x] Performance: the pairing is a single pass over the run's events

**Definition of Done** (Single Commit):
- [x] Feature complete in one atomic commit
- [x] All code, tests, and documentation included
- [x] Unit tests written and passing (resolved, unresolved, none, two-asks cases)
- [x] Integration tests passing for the specific increment
- [x] Manual testing complete for the delivered feature
- [x] Security review passed (n/a)
- [x] Performance impact assessed
- [x] Documentation updated within the same commit
- [x] Ready for independent deployment
- [x] Metrics configured and wired in — this story *is* the metric: waiting time becomes visible

**Dependencies**:
- [x] Story 3 (Steps rows and bars)

**Risks**:
- A crashed runner leaves an ask unresolved forever, so waiting grows without bound.
  Mitigation: that is the true state and the watchdog already raises it; do not cap it.

**Notes**: This is the single most valuable pixel in the product. Treat the derivation as
load-bearing and test it accordingly.

**Effort Estimate**: S (3 hours)

---

### [x] **Ticket: Selecting a step opens its detail beside the list**

**As an** operator looking at a step that needs permission
**I want** its detail and the approval buttons in a panel next to the list
**So that** I can answer without losing my place in the run

**Context**: Today the ask card floats in the thread. Inngest's split — timeline left, detail
right — is the pattern the user picked as the anchor.

**Description**: Add a right-hand detail panel to the Steps tab with a Step/Run toggle and
tabs (Ask, Prompt & context, Output, Tools). Move the existing `AskCard` into the Ask tab.

**Implementation Requirements**:
- `web/app/main.tsx`: selection state on the Steps list; the detail panel is a sibling column.
- Default selection is the step that needs attention, else the latest step.
- The Ask tab renders the existing structured ask (approve / approve-for-run / deny / reply);
  reply posting keeps using `POST /api/runs/:id/reply` unchanged.
- Prompt & context reuses the existing reconstruction endpoint; no new API.
- The Run toggle shows the identity, git, usage and allowance facts currently in the rail.

**Acceptance Criteria**:
- [x] Given a run needing permission, when I open it, then the waiting step is selected and its ask is showing
- [x] Given I select a completed step, when the panel updates, then it shows that step's prompt, output and tool counts
- [x] Given I answer an ask from the panel, when the reply is accepted, then the run moves and the panel follows the new state
- [x] Given a step with no ask, when I open its Ask tab, then it says so rather than rendering an empty card
- [x] Accessibility: the reply control is reachable by keyboard from the list without a mouse
- [x] Performance: selecting a step does no network request beyond the render reconstruction

**Definition of Done** (Single Commit):
- [x] Feature complete in one atomic commit
- [x] All code, tests, and documentation included
- [x] Unit tests written and passing
- [x] Integration tests passing for the specific increment (reply still round-trips)
- [x] Manual testing complete for the delivered feature
- [x] Security review passed — the panel must not widen what a reply can do
- [x] Performance impact assessed
- [x] Documentation updated within the same commit
- [x] Ready for independent deployment
- [x] Metrics configured and wired in — clicks from open-run to answered-ask recorded in verify

**Dependencies**:
- [x] Story 3 (Steps list)
- [x] Story 4 (the split, for the timing breakdown in the panel header)

**Risks**:
- Moving the ask out of the thread could make it easier to miss. Mitigation: the pinned amber
  banner stays exactly where it is; the panel is an addition, not a replacement.

**Notes**: This panel shell is reused by Logs (story 8) and Context (story 10). Build it as a
component with a slot, not three copies.

**Effort Estimate**: S (4 hours)

---

## Epic 3: Thread

### [x] **Ticket: The thread reads as a transcript**

**As an** operator catching up on what an agent did
**I want** one row per thing that happened, with its time, tokens and cost
**So that** I can skim a long turn instead of reading a wall of streamed text

**Context**: R3.2 came from "the turn delta is noisy and cuts the text across many lines".
Laminar's transcript is the proven shape for this exact content.

**Description**: Re-render the Thread tab as transcript rows: an icon by type, the name, a
one-line summary and right-aligned chips.

**Implementation Requirements**:
- `web/app/main.tsx`: replace the flat turn rendering with rows derived from the existing
  `coalesce()` output plus `turn-finalized` usage.
- Types: prompt sent, model turn, tool call, tool failure, operator row.
- Icons are inline SVG, distinguished by shape; colour stays neutral except failure.
- Chips: duration, tokens (with cached count where present), cost.
- A sticky `node@visit` header groups rows.

**Acceptance Criteria**:
- [x] Given a turn with 12 tool calls, when it renders, then each is one row and none is truncated mid-word
- [x] Given a turn with cached tokens, when it renders, then the cached count is shown distinctly from the total
- [x] Given a failed tool call, when it renders, then its icon is the failure shape and its row carries the error text
- [x] Given an operator instruction, when it renders, then it is attributed to me, not the agent
- [x] Given an unfinalised turn (process died mid-turn), when it renders, then it is marked interrupted
- [x] Accessibility: row type is conveyed by icon and text, never colour alone

**Definition of Done** (Single Commit):
- [x] Feature complete in one atomic commit
- [x] All code, tests, and documentation included
- [x] Unit tests written and passing
- [x] Integration tests passing for the specific increment
- [x] Manual testing complete for the delivered feature
- [x] Security review passed (n/a — render only)
- [x] Performance impact assessed — a 1,000-event run must not re-coalesce per row
- [x] Documentation updated within the same commit
- [x] Ready for independent deployment
- [x] Metrics configured and wired in — rows per screen and time-to-find-the-failure in verify

**Dependencies**:
- [x] Story 1 (tokens)

**Risks**:
- Cost per row depends on `turn-finalized.usage`, which some harnesses omit. Mitigation: show
  the chip only when the number exists; never invent an estimate (capability matrix rule).

**Notes**: The existing "Prompt & context" and "Add feedback" affordances must survive the
re-render; they are T21's loop and are already tested.

**Effort Estimate**: S (4 hours)

---

## Epic 4: Logs

### [x] **Ticket: Every event, filtered**

**As an** operator debugging why a run took a branch
**I want** the raw event stream with type filters and search
**So that** I can find the one `edge-taken` or `reconciled` that explains it

**Context**: The log holds everything and the UI surfaces almost none of it. Logfire's dense
list with a filter bar above is the proven shape.

**Description**: Add a Logs tab listing every event with timestamp, `node@visit`, type pill,
message and duration, above a filter bar with search and type chips.

**Implementation Requirements**:
- `web/derive.ts`: a `deriveLogRows` that flattens `LoggedEvent` into display rows with a
  one-line summary per type; every type in `log/events.ts` must be handled explicitly.
- Filters: all / agent / tool / engine / operator / attention, plus a text search.
- Attention rows are the only coloured ones.
- Rows are 26px, timestamps and ids in mono.

**Acceptance Criteria**:
- [x] Given a run with 1,184 events, when I open Logs, then rows render without freezing the tab
- [x] Given I filter to attention, when the list updates, then only attention-raised and attention-resolved rows remain
- [x] Given I search for a node name, when the list updates, then only that node's events remain
- [x] Given a new event type is added to `log/events.ts`, when the type is not handled, then the build fails rather than rendering a blank row
- [x] Performance: filtering 1,000+ rows stays under one frame

**Definition of Done** (Single Commit):
- [x] Feature complete in one atomic commit
- [x] All code, tests, and documentation included
- [x] Unit tests written and passing (one assertion per event type)
- [x] Integration tests passing for the specific increment
- [x] Manual testing complete for the delivered feature
- [x] Security review passed (n/a)
- [x] Performance impact assessed
- [x] Documentation updated within the same commit
- [x] Ready for independent deployment
- [x] Metrics configured and wired in — time-to-find a known event recorded in verify

**Dependencies**:
- [x] Story 1 (tokens)

**Risks**:
- An exhaustive switch over the event union is the point, not an inconvenience: it is what
  makes a new event type visible. Mitigation: use a `never` check so `tsc` enforces it.

**Notes**: Do not paginate yet. Runs are local and bounded; add windowing only if a real run
makes it slow.

**Effort Estimate**: S (3–4 hours)

---

### [x] **Ticket: An event opens with its ids and raw form**

**As an** operator who found the suspicious event
**I want** its ids and exact JSON
**So that** I can correlate it with the file on disk or paste it into an issue

**Description**: Selecting a log row opens the shared detail panel with id pills (seq,
timestamp, `node@visit`, attempt) and Details / Raw event tabs.

**Implementation Requirements**:
- Reuse the detail panel component from story 5.
- Raw tab renders the stored event verbatim, pretty-printed, selectable.
- Details tab renders the type's meaningful fields (for attention: tool, waiting, notified).

**Acceptance Criteria**:
- [x] Given I select an event, when the panel opens, then its `seq` matches the line in `run.jsonl`
- [x] Given the raw tab, when I read it, then the JSON is byte-faithful to the stored event
- [x] Given an event with a `rendered_hash`, when I open it, then the hash is shown and is copyable
- [x] Accessibility: the raw block is reachable and selectable by keyboard

**Definition of Done** (Single Commit):
- [x] Feature complete in one atomic commit
- [x] All code, tests, and documentation included
- [x] Unit tests written and passing
- [x] Integration tests passing for the specific increment
- [x] Manual testing complete for the delivered feature
- [x] Security review passed (n/a — the log is already local and user-owned)
- [x] Performance impact assessed
- [x] Documentation updated within the same commit
- [x] Ready for independent deployment
- [x] Metrics configured and wired in — verify note only

**Dependencies**:
- [x] Story 5 (panel shell), Story 7 (log rows)

**Risks**:
- None material.

**Effort Estimate**: XS (2 hours)

---

## Epic 5: Context

### [x] **Ticket: The run's whole context, in one table**

**As an** operator wondering what the agent actually knows
**I want** every context key with its value, scope and writer
**So that** I can answer "where did that come from" without reading the graph source

**Context**: CUR5 — Orbital's context tab was per-step and usually said "this step wrote
nothing to the context". Nothing surveyed in the research does this at run level. This is
Howdah's own surface.

**Description**: Add a Context tab: a table of key, current value, scope, writer and time,
including keys not yet written.

**Implementation Requirements**:
- `web/derive.ts`: a `deriveContextTable` folding `node-finished.writes` in log order, with
  scopes and declared writers read from the run's graph via `graph.declarations()`.
- Keys with no write yet are listed as not-written-yet with their declared writer.
- Scope renders as a neutral pill: sticky / cleared / per-visit.
- Values truncate to one line in the table.

**Acceptance Criteria**:
- [x] Given the implement-ticket graph, when I open Context, then all 11 declared keys are listed, written or not
- [x] Given a key written twice, when I read it, then the value shown is the latest published one
- [x] Given a `cleared` key whose writer is mid-attempt, when I read it, then it shows as veiled rather than as its stale value
- [x] Given a failed attempt that wrote values, when I read the table, then those values do not appear (publish-on-success)
- [x] Given a run with no writes yet, when I open Context, then the table lists every key as not written

**Definition of Done** (Single Commit):
- [x] Feature complete in one atomic commit
- [x] All code, tests, and documentation included
- [x] Unit tests written and passing (twice-written, veiled, failed-attempt, empty cases)
- [x] Integration tests passing for the specific increment
- [x] Manual testing complete for the delivered feature
- [x] Security review passed (n/a)
- [x] Performance impact assessed
- [x] Documentation updated within the same commit
- [x] Ready for independent deployment
- [x] Metrics configured and wired in — CUR5 is closed when this ships; note it in shaping.md

**Dependencies**:
- [x] Story 1 (tokens)

**Risks**:
- Scope semantics are subtle and already encoded once in `ContextStore`. Mitigation: derive
  from the same declarations rather than re-implementing the rules, and test the veiled case
  explicitly.

**Notes**: This is the story most likely to be judged against Orbital. Get the not-yet-written
rows right — their absence is exactly what made the old tab useless.

**Effort Estimate**: S (4 hours)

---

### [x] **Ticket: A context key shows who wrote it and who read it**

**As an** operator reading a plan the agent is working from
**I want** the full value, its write history and which prompts consumed it
**So that** I can tell whether a bad output came from a bad input

**Description**: Selecting a key opens the detail panel with the full value, a write history
and the list of prompts that read it.

**Implementation Requirements**:
- Reuse the panel shell from story 5.
- Write history from `node-finished.writes` occurrences, marking first write and replacements.
- Read-by from `prompt-rendered.context_read` keys across the run.
- A one-line explainer of what the key's scope means on re-entry.

**Acceptance Criteria**:
- [x] Given `implementation_plan`, when I select it, then both writers appear in order with the later one marked as replacing
- [x] Given a key read by four prompts, when I select it, then all four are listed and none is clipped off the panel
- [x] Given a key never read, when I select it, then it says so rather than showing an empty list
- [x] Given a long value, when I select it, then the panel scrolls rather than overflowing

**Definition of Done** (Single Commit):
- [x] Feature complete in one atomic commit
- [x] All code, tests, and documentation included
- [x] Unit tests written and passing
- [x] Integration tests passing for the specific increment
- [x] Manual testing complete for the delivered feature
- [x] Security review passed (n/a)
- [x] Performance impact assessed
- [x] Documentation updated within the same commit
- [x] Ready for independent deployment
- [x] Metrics configured and wired in — verify note only

**Dependencies**:
- [x] Story 5 (panel shell), Story 9 (context table)

**Risks**:
- Chips that cannot wrap clip at the panel edge. Mitigation: this bug was already found and
  fixed in the mockups; use flex-wrap with a gap, not inline spans.

**Effort Estimate**: XS–S (2–3 hours)

---

## Epic 6: Chat

### [x] **Ticket: Ask why, and get an answer about this run**

**As an** operator returning to a run that has been waiting for hours
**I want** to ask what it is waiting for in plain English
**So that** I get an answer without scrolling a thousand events

**Context**: LangSmith's Polly is the precedent: ask about one execution rather than reading
it. The decision (2026-09-15) is read-only — it can neither reply to the agent nor move the run.

**Description**: A chat panel on the run view, backed by a new endpoint that asks the local
`claude` CLI a question with a digest of this run as context, and returns one answer.

**Implementation Requirements**:
- `web/server.ts`: `POST /api/runs/:id/ask` taking `{question}` and returning `{answer}`.
- A pure `runDigest(events, graph)` builder: status, steps with durations and outcomes, the
  current ask, context keys, recent transcript lines, rendered prompt ids and versions.
- The endpoint spawns `claude -p` with `--permission-mode plan` and no tools, in a temp cwd,
  so it cannot touch the worktree.
- `HOWDAH_STUB=1` short-circuits the spawn, as with every other token-spending path.
- The panel renders the question, the answer, and a read-only badge.

**Acceptance Criteria**:
- [x] Given a parked run, when I ask what it is waiting for, then the answer names the node and the tool it needs permission for
- [x] Given `HOWDAH_STUB=1`, when I ask anything, then no agent is spawned and the route is still testable
- [x] Given the endpoint, when it runs, then it cannot write to the run's worktree or append to `run.jsonl`
- [x] Given a question about a run that does not exist, when I ask, then the API answers 404
- [x] Security: the digest never includes credentials from the environment, only run events
- [x] Performance: the digest is bounded — a 10,000-event run does not send the whole log

**Definition of Done** (Single Commit):
- [x] Feature complete in one atomic commit
- [x] All code, tests, and documentation included
- [x] Unit tests written and passing (digest shape, bounding, stub path, 404)
- [x] Integration tests passing for the specific increment
- [x] Manual testing complete for the delivered feature
- [x] Security review passed — read-only is the whole decision; assert it in a test
- [x] Performance impact assessed
- [x] Documentation updated within the same commit (CLAUDE.md: new route, token cost)
- [x] Ready for independent deployment
- [x] Metrics configured and wired in — cost per question recorded from the CLI's usage

**Dependencies**:
- [x] Story 3 (steps derivation feeds the digest)
- [x] Story 9 (context derivation feeds the digest)

**Risks**:
- A chat that spends tokens silently. Mitigation: the panel states it costs a call, and the
  answer shows its cost, exactly as turns do.
- Digest drift: an answer is only as good as the digest. Mitigation: build it from the same
  derivations the screens use, so one fix improves both.

**Notes**: Streaming is deliberately out of scope for this story. One question, one answer.

**Effort Estimate**: S (4 hours)

---

### [x] **Ticket: Answers cite the steps they came from**

**As an** operator reading an answer
**I want** each claim to point at the step it came from
**So that** I can check it rather than trust it

**Description**: Render `node@visit` references in answers as chips that select that step.

**Implementation Requirements**:
- Ask the model for references in a fixed form; parse them out of the answer text.
- Unknown references render as plain text, never as a broken link.
- Clicking a chip switches to Steps and selects that step.

**Acceptance Criteria**:
- [x] Given an answer citing `implementation.implement@1`, when I click the chip, then Steps opens with that step selected
- [x] Given an answer citing a node that is not in this run, when it renders, then it stays plain text
- [x] Given an answer with no citations, when it renders, then nothing is fabricated
- [x] Accessibility: chips are buttons, reachable by keyboard

**Definition of Done** (Single Commit):
- [x] Feature complete in one atomic commit
- [x] All code, tests, and documentation included
- [x] Unit tests written and passing (parser: valid, unknown, none)
- [x] Integration tests passing for the specific increment
- [x] Manual testing complete for the delivered feature
- [x] Security review passed — parsing model output must not render HTML
- [x] Performance impact assessed
- [x] Documentation updated within the same commit
- [x] Ready for independent deployment
- [x] Metrics configured and wired in — verify note only

**Dependencies**:
- [x] Story 11 (chat), Story 5 (step selection)

**Risks**:
- Model output is untrusted input. Mitigation: parse to a whitelist of known `node@visit`
  values from this run; render as text, never as markup.

**Effort Estimate**: XS (2 hours)

---

### [x] **Ticket: Suggested questions for a run I have just opened**

**As an** operator who does not know what to ask
**I want** three questions offered based on this run's state
**So that** the panel is useful on the first click

**Description**: Offer up to three state-derived suggestions: waiting → "What is it waiting
for?"; a failed attempt → "Why did X fail?"; a replaced context key → "What changed in the plan?".

**Implementation Requirements**:
- Suggestions derive from existing data (ask present, failed attempts, multi-writer keys).
- No suggestion is shown when its condition does not hold.
- Clicking one sends it as the question.

**Acceptance Criteria**:
- [x] Given a parked run, when I open the panel, then "What is it waiting for?" is offered
- [x] Given a run with a failed attempt, when I open the panel, then a question naming that node is offered
- [x] Given a clean finished run, when I open the panel, then no irrelevant suggestions appear
- [x] Performance: suggestions derive from data already loaded; no extra request

**Definition of Done** (Single Commit):
- [x] Feature complete in one atomic commit
- [x] All code, tests, and documentation included
- [x] Unit tests written and passing (each condition, and the empty case)
- [x] Integration tests passing for the specific increment
- [x] Manual testing complete for the delivered feature
- [x] Security review passed (n/a)
- [x] Performance impact assessed
- [x] Documentation updated within the same commit
- [x] Ready for independent deployment
- [x] Metrics configured and wired in — first-click rate noted in verify

**Dependencies**:
- [x] Story 11 (chat)

**Risks**:
- Suggestions that are always the same become furniture. Mitigation: each is conditional.

**Effort Estimate**: XS (2 hours)

---

## Backlog Prioritisation

**Must Have (sprint 1):**
- Story 1 — instrument palette, type and `DESIGN.md` (unblocks judgement of everything else)
- Story 3 — Steps rows with time bars
- Story 4 — the waiting split (the product's most load-bearing number)
- Story 5 — step detail panel with the ask inside it

**Should Have (sprint 2):**
- Story 2 — chrome removal on lists
- Story 6 — Thread transcript
- Story 9 — Context table (closes CUR5)
- Story 7 — Logs list

**Could Have (sprint 3):**
- Story 8 — event detail
- Story 10 — context key detail
- Story 11 — ask about this run
- Story 12 — citations
- Story 13 — suggested questions

**Won't Have (this plan):**
- T23 harness failover on allowance exhaustion — real, agreed, and independent of these
  screens; it ships on its own.
- Streaming chat answers, chat history across runs, and multi-run search.
- Zoom or windowing on the Steps timeline until a real run proves it slow.
- Fan-out/join graph rendering (still out of scope per shaping.md).

## Technical Considerations

- **Derivations first.** Stories 3, 4, 7, 9 all add functions to `web/derive.ts`. That file is
  pure and already well tested; keep it that way so the chat digest (story 11) can reuse them.
- **One panel, three users.** The detail panel in story 5 is the shell for stories 8 and 10.
  Build it with a slot on the first use, or the third copy will drift.
- **Exhaustive event handling.** Story 7 should use a `never` check over the event union so a
  new event type fails the build rather than rendering blank.
- **No new storage.** Every story here derives from `run.jsonl`. If a story seems to need a
  sidecar, that is a signal to add an event type instead.
- **Token spending is explicit.** Only story 11 spends tokens, and it honours `HOWDAH_STUB`.
- **Borrowed code carries its licence.** Trigger.dev and Laminar are Apache-2.0: keep
  LICENSE/NOTICE beside anything copied. Inngest (SSPL) and Phoenix (Elastic 2.0) are
  reference-only — read them, do not paste them.

## Success Metrics

This is a single-user local tool, so the honest measures are observational, recorded in the
verify line of each `shaping.md` task rather than in an analytics pipeline:

- **Time to notice a waiting run.** Baseline: 4h 10m, observed in Orbital. Target: the wait is
  legible the moment the window is glanced at.
- **Steps visible without scrolling.** Baseline: ~4 timeline rows. Target: 24.
- **Clicks from opening a run to answering its ask.** Target: one.
- **"Where did that value come from?"** Baseline: read the graph source. Target: one click in
  Context.
- **Questions answered without scrolling the log.** Target: the three suggested questions all
  return a correct answer on a real run.
- **Nothing regressed:** `bun test` stays green and `bun run check` stays clean on every
  commit, and T21's feedback loop still round-trips from a turn to an accepted proposal.
