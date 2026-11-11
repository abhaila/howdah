# Howdah viewer — baseline inventory (HOW-68)

Taken from the working tree at `/home/user/howdah`, served from a private copy, against the
seeded home in `home/`. Screenshots are in `shots/` (one line per file in `shots/SHOTS.md`);
raw measurements are in `shots/audit.json`, summarised in `shots/audit-summary.md`.
Paths below are relative to `web/app/` unless they start with another top-level directory.

Every defect says how it was established:
**[measured]** = computed in the page or by a probe script; **[seen]** = read off a screenshot;
**[code]** = read in the source, not exercised.

---

## 1. Routes and panes

The router is a chain of regexes in `main.tsx:97-112`, rendered at `main.tsx:186-196`. There is
no route table and no 404: any path that matches nothing renders the Runs list.

| Route | Screen | Component file(s) |
|---|---|---|
| (shell) | nav, theme toggle, splash, toasts | `main.tsx`, `brand.tsx`, `components/ui/toast.tsx`, `components/ui/panel.tsx`, `lib/panel.ts` |
| `/` | Runs list ("the board": Needs you / Running / Recently finished / Older) | `screens/runs.tsx`, `lib/board.ts`, `status.tsx`, `components/ui/row.tsx`; read model `web/board.ts` |
| `/attention` | Needs you inbox + "Ready for you" | `screens/attention.tsx`; read model `engine/attention-inbox.ts`, `web/draft.ts` |
| `/new` | Start a run | `screens/start-run.tsx` |
| `/graphs` | Graph catalog, shape, tuning table, source editor | `screens/graphs.tsx`, `graph-dag.tsx`, `lib/layout.ts`, `components/ui/table.tsx` |
| `/graphs/new`, `/graphs/:name/build`, `/graphs/new?fromRun=<id>` | Graph builder | `screens/graph-builder.tsx`, `builder/canvas.tsx`, `builder/node-card.tsx`, `builder/edge.tsx`, `builder/palette.tsx`, `builder/properties.tsx`, `builder/step-form.tsx`, `builder/branching.tsx`, `builder/fields.tsx`, `builder/problem.tsx`, `lib/spec-draft.ts` |
| `/prompts`, `/prompts/:id` | Prompt library, prompt detail | `screens/prompts.tsx` |
| `/proposals`, `/proposals/:file` | Revision proposals, accept / reject / re-draft | `screens/proposals.tsx` |
| `/settings` | Settings + workspaces | `screens/settings.tsx` |
| `/run/:id` | Run detail (below) | `run/view.tsx` |
| `/runs/:id/draft` | Draft review | `screens/draft-review.tsx`, `run/draft.tsx`, `graph-dag.tsx` |

Run detail (`run/view.tsx`): header (name, status, graph, tabs, controls `view.tsx:60-340`),
the standing-ask banner, one tab body, and the inspector rail.

| Tab (label → value, `view.tsx:652-659`) | File(s) |
|---|---|
| Plan → `plan` | `run/plan.tsx`, `run/acceptance.tsx`, `components/ui/markdown.tsx` |
| Build → `chat` (default) | `run/chat.tsx`, `run/activity.tsx`, `run/ask.tsx` (AskCard / AskQuestionCard / EffectCard / NoReplyCard), `run/document.tsx`, `run/evidence.tsx`, `run/draft.tsx` (draft card), `run/progress.tsx`, `components/ui/message-scroller.tsx`, `components/ui/questionnaire.tsx` |
| Report → `report` | `run/report.tsx` (an iframe on `/api/runs/:id/report`; the page is `core/run-report.ts` + `web/report.ts`) |
| Steps → `steps` | `run/steps.tsx` (list + detail; scope Step / Run; sub-tabs Activity, Ask, Prompt & context, Output) with `run/activity.tsx`, `run/prompt-context.tsx`, `run/ask.tsx`, `run/document.tsx`; for approval runs the sub-tabs Approval / Drift / Map come from `slice.tsx` |
| Context → `context` | `run/context.tsx`, `run/document.tsx` |
| Logs → `logs` | `run/logs.tsx` |
| Graph → `graph` | `graph-dag.tsx` |
| Inspector rail | `run/view.tsx:740-860` (Identity, Persistence, Git, Pull requests, Child runs, Timeline, Pinned prompts), `run/usage.tsx`, `run/progress.tsx`, `run/acceptance.tsx` |

Dialogs (all on `components/ui/dialog.tsx`, a native `<dialog>`): abort/pause confirm
`run/view.tsx:156`, document reader `run/document.tsx:119`, screenshot `run/evidence.tsx:48`,
approve + send-feedback `slice.tsx:437,446`, remove step `builder/step-form.tsx:555`, remove
field `builder/fields.tsx:193`, remove workspace `screens/settings.tsx:244`, reject proposal
`screens/proposals.tsx:131`.

---

## 2. Primitives — `web/app/components/ui/`

| File | What it is |
|---|---|
| `badge.tsx` | `Badge`: static pill (status / scope / event-type variants), cva on tokens |
| `button.tsx` | `Button` on `@base-ui/react`; variants default / outline / ghost / destructive / destructive-outline / link, sizes sm / default / icon |
| `card.tsx` | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent` — form and decision surfaces only |
| `checkbox.tsx` | `Checkbox label=`: a real `<input type=checkbox>`, box drawn with `appearance-none` (16×16) |
| `chip.tsx` | `Chip`: the interactive pill (log filters, citations, scope switcher) |
| `dialog.tsx` | `Dialog` and `AlertDialog` on native `<dialog>.showModal()`; backdrop click wired by hand |
| `empty-state.tsx` | `EmptyState`: "nothing here" (never "loading") |
| `input.tsx` | `Input` on `@base-ui/react/input`; mono by default |
| `label.tsx` | `Label`: a wrapping `<label>`, uppercase 11px |
| `markdown.tsx` | `Markdown` + `parseMarkdown`: hand-written renderer for agent prose and documents |
| `message-scroller.tsx` | shadcn `message-scroller` (on `@shadcn/react`): the chat transcript viewport, "Top"/"Latest" |
| `panel.tsx` | `PanelResizer` (`role=separator`, 9px lane) and `PanelToggle` (17×17 show/hide button) |
| `questionnaire.tsx` | shadcn `questionnaire`, verbatim: one-question-at-a-time card with numbered options |
| `row.tsx` | `Row`: the one list-row surface (hover / selected / needs-input); `<a>` or `<button>` |
| `select.tsx` | `Select`: a styled native `<select>` |
| `separator.tsx` | `Separator` on `@base-ui/react/separator` |
| `skeleton.tsx` | `Skeleton`, `LoadingBlock` |
| `table.tsx` | `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell` |
| `tabs.tsx` | `Tabs` (underline) and `PanelTabs` (segmented), both `items={[…]}`, on `@base-ui/react/tabs` |
| `textarea.tsx` | `Textarea` (also the graph source editor, by className) |
| `toast.tsx` | `ToastProvider`, `useToast`, `Toaster` — hand-written, bottom of the screen |
| `tooltip.tsx` | `Tooltip content=` on `@base-ui/react/tooltip`; own `role=tooltip` + `aria-describedby` while open |

---

## 3. Defects observed

### 3.1 Layout: clipped and unreachable regions

1. **Logs tab is unreadable at the default layout (1440×900).** `.log-summary` gets a computed
   width of **0px** with `white-space: pre-wrap`, so each summary wraps one character per line:
   168 rows, row heights min 128px / median 945px / max 3412px, list scroll height 201,612px.
   Four events fit on screen; the summary text is invisible and the event-type chip is cut
   ("prompt-outcor"). The list column is 386px, the detail 420px. **[measured]** `probes/probe6.mjs`;
   `dark-run-done-logs.png`, `dark-run-needs-input-prose-logs.png`.
2. **At 1024×700 the ask cannot be reached on a parked run.** The centre column
   (`div.thread-col`) is `overflow: hidden` with client 479×700 and scroll 598×1009: the banner
   takes ~270px, the transcript viewport has no height at all, and the suggestion cards and
   the composer are below the fold with nothing that scrolls to them. On the question run the
   transcript viewport is **32px** tall; on the finished run 142px. **[measured]**
   `dark-run-needs-input-prose-build-chat-1024x700.png`, `dark-run-needs-input-long-id-name-build-chat-1024x700.png`,
   `dark-run-needs-input-question-build-chat-1024x700.png`.
3. **At 1024×700 the centre column is also clipped sideways on every run tab** (client 479,
   scroll 598; 119px cut, no horizontal scroll). The tab strip ends at "L…" — Logs and Graph
   are not reachable by pointer. **[measured]** every `dark-run-*-1024x700.png`, e.g.
   `dark-run-done-steps-1024x700.png`.
4. **At 1024×700 the Steps list collapses to 8px.** Step rows measure 8×26px; the detail pane
   takes the rest. Same for the Logs list and the Context list. **[measured]**
   `dark-run-done-steps-1024x700.png`, `dark-run-done-logs-1024x700.png`, `dark-run-done-context-1024x700.png`.
5. **The transcript gets a minority of the screen even at 1440×900.** Header + tabs + banner
   above, suggestion cards + composer + hint below, all fixed. Transcript viewport height:
   392px (finished run), 344px (most parked runs), 240px (the long prose ask), **184px** (long
   name + long ask), 243px (live run). The ask card — the control the run is waiting on — sits
   inside that viewport and must be scrolled within it. **[measured]**
   `dark-run-needs-input-prose-build-chat.png`, `dark-run-needs-input-long-id-name-build-chat.png`,
   `dark-run-needs-input-question-card.png`.
6. **The long ask is printed twice.** The whole reason is repeated in the sticky banner (6
   lines) and again in the card below it. The banner's wait time wraps to two lines ("2h /
   53m"). **[seen]** `dark-run-needs-input-prose-build-chat.png`.
7. **Steps list: the last column is clipped by the splitter** at default widths (durations read
   "8m 2", "2m 5", the orange wait column "21."). **[seen]** `dark-run-done-steps-default.png`,
   `dark-run-implement-slice-awaiting-approval-steps-approve-approval.png`.
8. **Needs-you inbox rows overlap.** The "needs you" badge wraps to two lines inside a 26px
   row and "waiting 19h 0m" wraps and prints over the next row. A long run id takes the row:
   the reason is cut to "output contract …" while the id shows 100 characters. **[seen]**
   `dark-attention-inbox.png`.
9. **Settings → Workspaces: paths run out of the card** and under the remove button, while the
   workspace NAME is cut to "acm…" / "n…". **[seen]** `light-settings.png`, `dark-settings.png`.
10. **Graph builder at 1024×700: the canvas is 106px wide** (`div.react-flow` client 106×587);
    the cards are fitted into it and a step's "Edit" control measures 52×9px. **[measured]**
    `dark-builder-existing-graph-panel-1024x700.png`.
11. **Graph builder at 1440: with five steps the fitted canvas text is unreadable** (card
    labels render at roughly 5px). **[seen]** `dark-builder-existing-step-selected.png`.
12. **"Open run folder" wraps to a second header row** at 1440 with the inspector open; a live
    run's five controls take a full row of their own. **[seen]** `dark-run-done-build-chat.png`, `dark-run-live-build-chat.png`.
13. **A 56px band at the bottom of every run tab is unused** (content stops at y≈844 of 900). **[seen]** `dark-run-done-plan.png`.
14. **No 404.** An unknown path renders the Runs list (`main.tsx:114`). **[code]** An unknown run id
    shows only skeleton bars, flush against the nav with no padding, for the first 10s
    (`OPEN_GRACE_MS`, `run/view.tsx:347`) before any message. **[seen]** at 1.2s: `dark-run-unknown-id.png`.

### 3.2 Truncation with no way to read the value

Counted over all audited screens (`audit-summary.md`, "TRUNCATED WITHOUT title/tooltip"). The
audit cannot see a Base UI tooltip that is closed, so each row below was checked in the source.

| Element | Where | Is the full value available? |
|---|---|---|
| `span.tl-node` (inspector Timeline, e.g. "implementation.plan…") | every run, 455 hits | **No** — plain span, `run/view.tsx:831`. Only by opening Steps. |
| `h1` run name | long-name run | No tooltip (`view.tsx:646`); the full name does wrap in the inspector's `name` row. |
| `span.run-goal` reason in the inbox | `/attention` | No — open the run. `screens/attention.tsx:69` |
| `span.run-goal` workspace name | `/settings` | **No** — and the path beside it overflows (3.1.9). |
| `span.run-goal` run name in the list | `/` | No tooltip; open the run. |
| `span.chat-eyebrow` "9 steps · 12 tool c…" | 1024 wide | No. |
| `a.pr-link` child run id | parent run inspector | No — it is a link to that run. |
| `span.ctx-value`, `span.ctx-writer`, `span.log-node`, `span.act-tool-sum` | Context / Logs / tool rows | Yes, by selecting or expanding the row. |
| `span.path` (inspector paths) | every run | Yes — `Tooltip` (`view.tsx:343`), hover only: the span is not focusable. |
| `span.gb-node-sub`, `span.gr-id` | builder card, approval rows | Yes — `Tooltip`. |

Evidence: `dark-run-needs-input-long-id-name-build-chat.png`, `dark-attention-inbox.png`,
`dark-run-plan-feature-parent-with-children-inspector-children.png`, `light-settings.png`.

### 3.3 Dialogs

All nine dialog kinds that could be opened close on Escape and hold focus inside
(`shots/dialogs.json`): remove step, remove workspace, reject proposal, document reader,
screenshot, abort confirm, approve (plan-feature and implement-slice), send feedback. **[measured]**
No dialog failed. Not opened: remove field (`builder/fields.tsx:193`). The
implement-slice "Send feedback" button is disabled in the seeded round (no comment pinned on it).

### 3.4 Type

- **Two families, interleaved on every screen.** Instrument Sans and JetBrains Mono, loaded from
  `fonts.googleapis.com` (`web/public/index.html:8-10`; no local copy, so offline falls back to
  Helvetica/Arial and the system mono). Across the 108 audited dark screens: **13,609** text
  elements compute to JetBrains Mono and **7,562** to Instrument Sans. Mono carries: nav badges,
  every badge/chip, step/timeline/log rows, the whole inspector (keys and values), timestamps,
  durations, costs' neighbours, input text and placeholders, `kv` tables, the graph DAG. Sans
  carries: headings, run names, prose, button and tab labels, banners. The same row usually
  mixes both (Runs list: name in sans, "waiting 19h 1m" and step in mono, "19h 01m ago" and cost
  in sans). **[measured]** per-screen counts under "PER SCREEN" in `audit-summary.md`; `dark-runs-list.png`.
- The Report tab is a third look: its iframe page carries its own all-mono type and a fixed
  beige palette, in both themes. **[seen]** `dark-run-done-report.png`.
- **Ten font sizes between 9px and 17px**: 9, 10, 11, 11.5, 12, 13, 13.5, 14, 16, 17 — exactly the
  ten steps of the token scale (`web/public/tokens.css:46-55`), three of them half a pixel
  apart from a neighbour. A single run screen uses 8–9 of them. By element count (dark, 1440):
  12px 6,699 · 11px 2,994 · 10px 1,221 · 11.5px 778 · 13px 711 · 13.5px 466 · 16px 355 · 14px 228
  · 9px 48 · 17px 23. So about 87% of text elements are 12px or smaller. **[measured]**

### 3.5 Hit areas under 24px **[measured]**

| Control | Size | Evidence |
|---|---|---|
| Panel show/hide toggle (`PanelToggle`: sidebar, inspector, steps/logs/context detail) | 14×14 – 17×17 | every screen; `dark-defect-inspector-toggle-under-resizer.png` |
| Back arrow `a.topbar-back` | 13×21 | every run screen |
| Workspace remove "×" | 14–16 × 24 | `dark-settings.png` |
| Checkbox input | 16×16 (label is clickable too) | `dark-builder-existing-step-selected.png` |
| Steps scope `Step` / `Run` | 44×23, 40×23 | `dark-run-done-steps-default.png` |
| Step sub-tab `Ask` | 21×25 | same |
| Log filter chips | 30–56 × 23 | `dark-run-done-logs.png` |
| Inline links (`a.pr-link`, `a.linkish`, report Open / Download) | 13–21px tall | `dark-run-done-report.png` |

Also: **the inspector toggle is partly covered by the resizer.** The 17px toggle sits in a 9px
lane; while the pointer is over the lane the divider's hover rule widens and takes the pointer
across the middle of the button (4 of 6 sample points hit the separator). A Playwright click on
its centre is refused with "pane-resize intercepts pointer events". The toggle is also
`opacity: 0` until the run view is hovered. **[measured]** `probes/probe3.mjs`.

### 3.6 Keyboard focus **[measured]** (40 Tab presses per screen, 27 screens)

Most controls show a 2px outline. Without outline or box-shadow when focused:

- **Graph-builder canvas nodes** (`div.react-flow__node`): a focus stop with no indicator; the
  "Edit" button inside it does have a ring. `dark-focus-builder-canvas-node.png`.
- **Pane resizers** (`.pane-resize:focus-visible { outline: none }`, `howdah.css:655`): the only
  change is the 1px rule becoming 3px and lighter. `dark-focus-pane-resizer-inspector.png`.
- Run-graph DAG nodes report no outline but do get a stroke (`howdah.css:480`) — not a defect.
- The chat composer textarea has no outline of its own; its wrapper gets a thin border. `dark-focus-chat-composer-textarea.png`.
- On the finished run, Tab moves focus to tool rows that are outside the visible transcript
  viewport (focus goes off-screen; the scroller does not always follow). `dark-run-done-build-chat.png`.
- Tab order on a run starts with the logo, seven nav links, the theme and sidebar buttons, the back arrow and the tab strip before any content; there is no skip link. **[code]**

### 3.7 Contrast (WCAG AA, 4.5:1 for these sizes) **[measured]**

| Pair | Ratio | Where |
|---|---|---|
| dark `#605f5b` on `#0b0c0d` (the "faint" text) | 3.06 | 945 elements on 93 screens, all 10–12px: visit suffixes, chat eyebrows, timestamps, "ago" times |
| dark `#605f5b` on `#141517` / `#1b1d1f` / `#221c12` | 2.86 / 2.64 / 2.65 | step durations, plan counters, the disabled "Launch run", durations on the amber needs-input row |
| dark `#d9553f` on `#1b1d1f` (failed/reject badge) | 4.28 | 11px badges |
| dark `#d9553f` on `#241513` (failed banner) | 4.47 | banner text |
| light `#8c8a85` on `#f7f6f3` | 3.19 | 479 elements on 35 screens |
| light `#8c8a85` on `#f6ead6` / `#eeede9` / `#ffffff` | 2.89 / 2.94 / 3.45 | same roles |
| light `#afafad` on `#ffffff` (disabled "Add") | 2.21 | builder |

Evidence: `dark-run-done-steps-default.png`, `dark-runs-list.png`, `light-runs-list.png`,
`light-run-done-steps-default.png`. Backgrounds with images/gradients were skipped.

### 3.8 Other things that look broken or cramped **[seen]** unless marked

- An approval run's default (Build) view offers no way to approve: the card says "A reply can't
  move this run" and prints CLI commands. The Approve / Send feedback / pin controls are in
  Steps → the approval step → "Approval" sub-tab. `dark-run-plan-feature-awaiting-approval-build-chat.png`
  vs `dark-run-plan-feature-awaiting-approval-steps-approve-approval.png`.
- The Steps timeline lists an approval visit twice ("plan.approve@1 — failed", then
  "plan.approve@1 — succeeded"). `dark-run-plan-feature-awaiting-approval-steps-approve-approval.png`.
- The Report tab rearranges the header (tabs move right, inspector collapses) and shows a light
  beige page inside the dark theme. `dark-run-done-report.png`.
- The acceptance card in the inspector repeats "judged by implementation.criteria@1" and three
  chips per row in a 295px column; five criteria take ~670px. `dark-run-needs-input-long-id-name-build-chat.png`.
- Runs list at 1024: each row becomes two lines with the status on its own and a large gap. `dark-runs-list-1024x700.png`.
- Graphs: edge labels overlap each other on the DAG ("review_verdict == 'reject'" over
  "review_verdict == 'pass'"). `dark-graphs-implement-ticket-selected.png`.
- Settings shows the raw `gh` failure in red under the repo search when `gh` is not logged in. `dark-settings.png`.
- The console logs one failed request (HTTP 502) on `/proposals` in this sandbox — an outbound request through the proxy, not investigated.

---

## 4. The "needs you" sound and the notification, as built today

### In the browser — `chime.wav`

- `web/app/lib/hooks.ts:44-58` `useAttentionSurfaces(needsInput)`: while `needsInput` is true it
  swaps the favicon between two frames every 900ms, and on a false→true change of its argument
  it runs `new Audio("/chime.wav").play()` (`hooks.ts:53`).
- Called from three screens: Runs list `screens/runs.tsx:115` (any run needs input), inbox
  `screens/attention.tsx:49` (any item), run view `run/view.tsx:602` (this run needs input).
- The file is `web/public/chime.wav`: 0.70s, 16-bit mono 44.1kHz.
- **It plays on navigation, not on a new ask.** `prev` is a `useRef` initialised to the first
  value, and each screen mounts with no data (`false`), then loads (`true`). So every visit to
  Runs, Needs you, or a parked run rings while anything is waiting. **[measured]**
  `probes/chime-probe.mjs`: 7 plays in 8 navigations with no new ask (load `/` → 1, Needs you →
  2, Runs → 3, Settings → 3, Runs → 4, Needs you → 5, open a parked run → 6, back → 7).
- **The Settings checkbox does nothing.** "Attention chime" (`screens/settings.tsx:223`) is saved
  to `config.json` by `web/server.ts:667`, and `chime` is read nowhere else (the only other
  mention is the type, `config/config.ts:89`). **[measured]** after `PUT /api/settings {chime:false}`
  and a reload the chime still played.
- The viewer never uses the browser Notifications API (no `Notification` reference under `web/app`). **[code]**

### Outside the browser — the OS notification

- `engine/attention.ts:58-67` `notifierArgv`: if `terminal-notifier` is on PATH,
  `terminal-notifier -title … -message … -open <url> -sound Glass`; otherwise
  `osascript -e 'display notification "<body> — <url>" with title "…" sound name "Glass"'`.
  `osNotifier` (`attention.ts:69-71`) spawns it synchronously. The file's own comment
  (`attention.ts:47-56`) says what the fallback does: the banner is posted **as Script Editor**,
  clicking it opens Script Editor, and the URL is only text in the body. `terminal-notifier` is
  not a dependency and is not installed by anything in the repo. So on a default machine the
  notification is the script one, with the macOS "Glass" sound — a second sound besides `chime.wav`.
- Who raises: the CLI when a run parks (`cli/main.ts:225-232`), the claude and codex executors
  for a mid-turn ask (`engine/executors/claude.ts:231-237`, `codex.ts:220-224`), the runner-lock
  path (`engine/control.ts:145-149`), and the watchdog.
- `AttentionCenter.raise` (`attention.ts:142-161`) writes `$HOWDAH_HOME/attention/<id>.json`
  first, then notifies unless the same id rang within `NOTIFY_COOLDOWN_MS` = 10 min (`attention.ts:95`).
  `notify` (`attention.ts:175-199`) sends one banner per record, or one "Howdah needs you — N
  runs" banner linking `/attention` for several.
- **Re-rings.** `watchdog/check.ts` runs every 60s under launchd (`watchdog/howdah-watchdog.plist`,
  `StartInterval 60`) and re-notifies every pending record older than `reNotifyAfterMs` = 30 min
  (`check.ts:66`, `:97-100`), for as long as the run stays parked. It also raises "harness
  process N is dead" when the heartbeat is stale for 120s (`check.ts:65-82`).
- **Deep links may point at the wrong port.** `cli/main.ts:230` and the watchdog entry
  (`check.ts:106-111`) build the `AttentionCenter` without `viewerBase`, so their links use
  `DEFAULT_VIEWER_BASE` = `http://localhost:4711` (`attention.ts:98`) whatever `HOWDAH_PORT` or
  `config.viewerBase` say; only the executors pass it (`engine/executors/index.ts:114-115`). **[code]**
- **Slack is not wired.** `slackNotifier` exists (`attention.ts:73-79`) and Settings has a
  "Slack webhook (attention DMs)" field, but nothing constructs it: every `AttentionCenter` is
  built with `[osNotifier]` only. **[code]**
- On Linux (this sandbox) `osNotifier` spawns `osascript`, which does not exist; the seed
  therefore passes no notifiers.

---

## 5. Seeded states, and what was not produced

Produced (see `seed-report.txt`): 28 runs — needs-input ×11 (prose/acceptance-unmet,
replyable attempt-failed with a 100-char id and 150-char name, AskUserQuestion, ambiguous
effect, max-visits, harness-unauthenticated, stuck, context-exhausted, plan-feature and
implement-slice awaiting approval, a parked child), harness-dead ×2, running ×1 (live),
waiting ×1 (paused), done ×10, failed-terminal ×3 (failed, aborted, a local-graph run);
a plan-feature parent with three children; two draft-graph runs (one ready, one saved as the
local graph `reviewed-task`); a local graph built through the builder route (`triage-bug`) and
a broken one (`half-edited`); four workspaces; feedback on three real turns; one pending
proposal beside the repo's own decided ones.

Not produced:
- a run using a `parallel` step (no built-in graph has one);
- operator steer / soft-stop events and their transcript states (the live run shows the controls only);
- the Drift pane of implement-slice (needs a real post-implementation re-extraction);
- a stacked run genuinely waiting in `runs:await` (the stacked child's dependency facts are stubbed);
- a gated `requiresAcceptance` graph with the Waive control enabled (the seeded park is the
  ungated one, so the card correctly offers "Retry this step" instead);
- permission asks, `mcp-elicitation`, `turn-timeout`, `tools-unsupported`, `no-progress`, `repair-stalled`, `stale-base` parks;
- `queued` and `failed-recoverable` statuses; allowance (exhausted / unreachable) rows; cursor/opencode turns;
- the watchdog's "harness died" record and the runner-lock record in the inbox;
- the GitHub repo picker with results (`gh` is not authenticated here; the error state is captured).
