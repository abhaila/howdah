# Design overhaul (HOW-68): the plan and the loop

Status: **agreed 2026-11-12; three iterations of the loop, a sign-off pass, a fix pass, a
confirming review, the operator-feedback work and a final pass have run (see "Loop log").** `DESIGN.md` is now the authority and wins
over this file; this file is the plan, the checklist and the log of the loop.

- Vision and mockups: https://claude.ai/artifact/NktPftzTLnWvLQ7i5nxZ1m
- Audit, with evidence for every claim below: `docs/designs/design-overhaul-audit.md`
- Capture harness: `tools/visual/` (see "The loop")

## Why

The ticket's complaints, each matched to what the audit measured on 28 seeded runs:

| Complaint | Finding |
|---|---|
| Screens not scrollable | At 1024×700 a parked run cannot be answered: the centre column is `overflow: hidden` with the composer below the fold. Run tabs are clipped 119px sideways. Steps, Logs and Context lists collapse to 8px. |
| "I can't read any of the text in the middle" | The transcript gets 240px of a 900px window when a long ask is standing. The ask is printed twice, in a six-line banner and in the card. |
| Text cut off, unreadable on hover | Timeline node names, run names, inbox reasons and workspace names end in an ellipsis with no tooltip. Inspector paths have a tooltip that is hover-only. |
| Escape out of modals | All nine dialogs close on Escape. The side panels (step detail, log detail, inspector) do not. |
| Different fonts in different places | Two families alternate inside almost every row (13.6k mono elements to 7.6k sans). Ten sizes from 9 to 17px; 87% of text is 12px or smaller. The Report tab is a third look. |
| Annoying jingle | The chime rang on navigation: 7 plays in 8 visits with nothing new. The setting to mute it was never read. **Fixed in the first commit of this work.** |
| Script notification | `osascript` posts as Script Editor, plays "Glass", and is not clickable. `terminal-notifier` is used only if it happens to be installed. **Sound removed by default in the first commit; the native path is in Foundations below.** |

Also measured: faint text is 3.06:1 in dark and 3.19:1 in light (AA needs 4.5); the Logs tab
gives its summary column 0px so rows run 900px tall; several controls are under 24px.

## Principles

1. **The alarm is said once.** Amber marks the single place the operator acts. No banner
   repeating the card, no tinted rows. This keeps `DESIGN.md`'s one rule and enforces it harder.
2. **One scroller per pane.** Every region either fits or scrolls, down to 1024×640.
3. **One voice.** One sans family for everything read. Mono only for what would be pasted:
   ids, paths, commands, code.
4. **Keyboard first.** Every action has a key, printed beside it; `?` lists them all.
5. **Nothing is cut without a way to read it.** Wrap where there is room; otherwise the full
   value shows on hover AND focus.

## Decisions already taken

- **Type scale:** six sizes, 12 / 13 / 14 / 16 / 20 / 28. Nothing below 12px. No uppercase
  micro-labels.
- **Fonts are bundled** (woff2 under `web/public/fonts/`), not fetched from Google.
- **Colour:** amber for waiting-on-you only, one red for failure, one accent for what you
  press and where you are. Light and dark are equals. Every text token clears 4.5:1.
- **Status is a shape first**, as today.
- **Motion** (animations.dev lessons): nothing keyboard-triggered or high-frequency animates;
  press scale 0.97; menus and tooltips open from their trigger in 150ms on
  `cubic-bezier(0.19, 1, 0.22, 1)`; the ask arriving is the one authored moment; the pulsing
  dot and the load splash are removed; reduced motion keeps fades and drops travel.
- **Sound** is off by default and only for news.
- **One component layer on Base UI.** `howdah.css` shrinks to layout; appearance lives in
  primitives. New primitives: Menu, Popover, CommandPalette, Drawer, Kbd, Truncate, Toolbar,
  KeyValue, ScrollPane. A gallery route (`/dev/components`) renders every primitive in every
  state and is what the harness shoots.

## Decisions made by the operator

1. **Typeface:** DM Sans + DM Mono, bundled.
2. **Colour:** the Indigo scheme (blue-tinted neutrals, indigo accent, amber alarm).
3. **Details is a drawer:** closed below 1280px, toggled with ⌘I, closed with Esc.
4. **Asks are rewritten for people:** a short summary per park kind, the engine's message
   one click away.

## Minimum standards

Each has a check that fails the build or the loop, so it cannot regress quietly.

| Standard | Rule | Check |
|---|---|---|
| Contrast | WCAG 2.2 AA: 4.5:1 text, 3:1 large text and control boundaries | unit test over `tokens.css`, every text token on every ground, both themes |
| Targets | 24px minimum, 32px for primary controls | harness: measures every control on every screen |
| Focus | 2px ring on every focus stop, canvas nodes and splitters included | harness: Tab through each screen, fail on a stop with no ring |
| Scrolling | no clipped region at 1440×900 or 1024×640 | harness: scroll size against client size on every `overflow: hidden` box |
| Truncation | an ellipsis exposes the full value on hover and focus | one `Truncate` primitive; raw `text-overflow` in CSS fails `css-contract.test.ts` |
| Type | six sizes, two families, nothing under 12px | harness: distinct computed sizes and families per screen |
| Layers | Esc closes the topmost of menu, dialog, detail panel, drawer | component tests |
| Motion | reduced motion drops travel | token test; animation review checklist |
| Slop | no impeccable detector findings in `web/app` or `web/public` | `impeccable detect` in the loop |

## Keyboard map

| Scope | Keys |
|---|---|
| Anywhere | ⌘K palette · `?` shortcuts · `G` then `R` `N` `G` `P` `O` `S` go to a screen · `C` new run · `[` sidebar |
| Lists | `J` `K` or arrows · Enter open · `/` filter |
| A run | `1`–`7` tabs · ⌘I details · `F` focus the pane · `R` reply · `A` jump to the ask · `/` ask about the run, or search on Logs · `E` expand tool calls · `O` open in IDE · `.` more |
| A graph | on a step: arrows, `Home`, `End` · `Enter` selects · on the canvas: arrows pan · `+` `−` zoom · `0` all of it · `Home` the start |
| Forms | ⌘S save · ⌘↵ launch |
| Layers | Esc closes the topmost |

`DESIGN.md` holds the authoritative table; this one is the plan's copy of it.

Single-key shortcuts are ignored while a text field has focus and can be turned off in
Settings (WCAG 2.1.4).

## Phases

**0. Audit** — done. 351 captures, inventory, defect list.

**1. Agree the vision** — done.

**2. Foundations**, in this order, each its own commit:
1. `PRODUCT.md` and the rewritten `DESIGN.md`.
2. Tokens: palette, six-step type scale, bundled fonts, contrast test.
3. Primitives: the new nine, plus hit-area and focus fixes on the existing ones.
4. Shell: rail, command palette, shortcut layer and `?` sheet, 404 route.
5. Scroll contract: `ScrollPane` owns overflow; remove `overflow: hidden` from layout rules.
6. Notifications: Web Notifications from the viewer (permission asked in Settings, click
   opens the run); OS path kept for when no tab is open, with install guidance for
   `terminal-notifier`; one setting decides which.

**3. Surfaces**, worst first. One row each in the checklist below.

**4. Close-out:** delete dead CSS, update `CLAUDE.md`'s web section, final full capture — done in iteration 3.

## The loop

For each checklist row: **implement → capture → check → record**.

```bash
export HOWDAH_VISUAL_OUT=/tmp/howdah-visual
bash tools/visual/serve.sh stop
bun tools/visual/seed.ts                  # demo home: ~45 runs across every status and park kind, plus an EMPTY home (~3s)
bash tools/visual/serve.sh > $HOWDAH_VISUAL_OUT/serve.out 2>&1 < /dev/null
                                          # viewer on :4799 from a private repo copy; the empty home on :4800
node tools/visual/shoot.mjs               # every screen, both themes, 1024×700 and 1024×640 (~17 min); or a substring / STEPS=<regex>
(cd $HOWDAH_VISUAL_OUT && python3 "$OLDPWD/tools/visual/analyze.py")   # the gate: STANDARDS: PASS/FAIL, exit 1 on FAIL
bun test web && bun node_modules/typescript/lib/tsc.js --noEmit
```

**The gate** is the last block `analyze.py` prints. It counts, over every audited screen:
font sizes outside 12/13/14/16/20/28 · faces other than DM Sans / DM Mono · an ellipsis with no
way to read it · targets under 24px · focus stops with no ring · clipped or unreachable content
or a scrolling document · contrast failures on live (non-disabled) text · capture steps that
failed. Every count must be zero. Three things are measured and deliberately not counted, and
the audit says so where it lists them: a visually-hidden label, React Flow's canvas (content
past the pane is reached by panning; a canvas zoomed out by the operator shrinks its targets
as browser zoom would), and text on a disabled control.

A row passes when all of these hold:
- the gate prints PASS for the capture it is judged on;
- the capture has been looked at in both themes at 1440×900 and at 1024×700;
- it matches `DESIGN.md` (tokens only, primitives only, no new one-off CSS);
- the affected tests pass.

A row that fails goes round again. The loop ends when every row passes in one full capture.

What the gate cannot see is checked by three small Playwright scripts kept with the capture
(not in the repo: they are probes, and their findings became tests): **motion** with reduced
motion OFF (the harness forces it on), **keyboard** end to end, and **consistency** across
surfaces. Their results are in the Loop log.

## Checklist

Status: ☐ not started · ◐ in progress · ☑ passes (the gate, and looked at in dark, light and at 1024).

### Foundations
| | Item |
|---|---|
| ☑ | Sound: off by default, setting honoured, only for news (viewer and OS) — the seeded home no longer sets `chime`, so Settings is captured in its default (unchecked) state |
| ☑ | `PRODUCT.md`, `DESIGN.md` |
| ☑ | Tokens, type scale, bundled fonts, contrast test (`web/app/tokens.test.ts`) — now also `--fg-disabled` (≥3:1, <4.5:1) and the diff colours on their own tinted row |
| ☑ | Primitives: Menu, Popover, CommandPalette, Drawer, Kbd, Truncate, Toolbar, KeyValue, ScrollPane (+ SectionLabel, ShortcutSheet) |
| ☑ | Existing primitives: targets ≥24px, focus ring everywhere, states complete. `questionnaire` lost its `dark:` utilities (they followed the OS, not the toggle); `message-scroller`'s pin no longer animates; Button's disabled state is a readable token and loading keeps its colours |
| ☑ | Shell: rail, palette, shortcuts (`lib/shortcuts.ts`), `?` sheet, 404, skip link |
| ☑ | Scroll contract — 0 clipped, unreachable or document-scrolling screens in the final capture, 1024×640 included |
| ◐ | Native notifications — ONE notification per ask, once the operator has confirmed one: an open viewer beats `POST /api/viewer/presence` every 20s with `notify: true` only when the browser's permission is granted AND a test notification was answered "Yes, I saw it" in Settings (`lib/notify.ts` `notifyDelivers`; a browser can report `granted` while the OS shows nothing). The server writes `$HOWDAH_HOME/viewer.json`, and the engine's OS notifier stands down while a `notify: true` beat is under 45s old — until the confirmation both paths ring; the shell (not only Runs / Needs you / a run) observes asks, so a viewer left on any screen announces them. **Verified:** the ring/skip decision, the presence file, the watchdog ringing through the OS when the viewer never beat again, the deep link's port, the route and its guards, and the beat itself — by unit and route tests (`engine/attention.test.ts`, `web/web.test.ts`, `web/app/focus.test.tsx`, `web/app/notify.test.ts`); that a notification's deep link (`/run/:id#needs-input`) lands focus on the control — in Chromium, for all five card kinds. **Not verified:** a real browser notification on screen (headless Chromium blocks the permission; the posting half runs against a fake `Notification`); the OS banner itself, through either `terminal-notifier` or `osascript` — this sandbox is Linux and has neither, so only the argv and the decision to spawn are tested; the new sound was measured from its bytes and never heard |
| ☑ | Component gallery route (`/dev/components`; harness step `components-gallery`) |

### Surfaces
Every row below was judged on the final capture of iteration 3 (584 captures, 281 audited
screens, gate PASS) and looked at in dark and light at 1440×900 and in dark at 1024×700 (the
run view also at 1024×640). The rows the operator-feedback work and the final pass changed were
judged again on the final pass's capture (718 captures, 327 audited screens, gate PASS) — see
the "Final pass" entry for which screens were looked at and which were only measured.

| | Surface | What was cleared (audit §), and what was looked at |
|---|---|---|
| ☑ | Run: header, tabs, actions | one row at every width, 24px back control, tab strip with key hints (3.1.3, 3.1.12, 3.5); a 100-character run id and name at 1024 |
| ☑ | Run: Build (transcript, ask cards, composer) | the ask is said once — no banner, and no `[failed: …]` line above the card that says it; the transcript is the body; answerable at 1024×640 with the drawer open or shut (3.1.2, 3.1.5, 3.1.6); steers (delivered and pending) and the steer composer on a live turn; a stacked run waiting on its dependency |
| ☑ | Run: ask cards | prose, question, ambiguous effect, no-reply (Retry, and routing parks with the way to the Graph tab), approval in the conversation (3.8), permission (the command, Allow / Deny), MCP elicitation, soft stop, gated acceptance with Waive; turn-timeout, no-progress, repair-stalled, stale-base, context-exhausted, stuck, harness-unauthenticated |
| ☑ | Run: Details drawer (inspector) | sans labels, values wrap and paths break at `/`, timeline rows open their step (3.2, 3.5). Since the feedback work: the pull request leads it, a poll is one row, its edge is a separator you drag or arrow (280px to half the room, remembered); a step parked on a question reads "waiting on you", not "running" |
| ☑ | Run: Plan | one scroller around an 880px column (it was 720; a plan is scanned, not read as prose), with the acceptance contract and the answer box beside it once the pane is 1160px wide (3.1.13) |
| ☑ | Run: Report | follows the theme; a frame around the self-contained page (3.4). The page inside the frame is `core/run-report.ts`'s and is not measured by the in-page audit (it is an iframe). Its links open a new tab; `Esc`, `F`, `?` and `1`–`7` typed inside it reach the app, and the pane says what does not |
| ☑ | Run: Steps + step detail | grid rows, fixed numeric columns, the detail replaces the list under 1100px and a step picked elsewhere lands on it (3.1.4, 3.1.7); a `parallel` group; two attempts of one visit as two rows; the Drift pane; an UNVERIFIED prompt; a poll folded to one row that J/K walk over |
| ☑ | Run: Context | a real list at 1024; what was given at launch reads "you, at launch" |
| ☑ | Run: Logs | summary column never 0px (3.1.1); the fetch-error state; the list is windowed (fixed 28px rows) |
| ☑ | Run: Graph | the builder's canvas and card, read-only (React Flow), laid out by dagre with every sideways run in its own lane; pan, zoom, minimap, a tooltip per card; the fork/join wires of a parallel step; a finished run opens on the whole graph when that fits at 70%+ |
| ☑ | Runs list | rows, one sentence per row from `parkSummary`, every status including queued and failed-recoverable; the empty state; a real list per group and ONE tab stop |
| ☑ | Needs you | name, sentence, step, wait — one row each (3.1.8); the wait is a number, not "waiting …" 21 times; the empty state; a real list and ONE tab stop |
| ☑ | New run | with and without workspaces |
| ☑ | Graphs list and source editor | built-in and local graphs, a broken local graph, the tuning table |
| ☑ | Graph builder | canvas at 100% by default, 12–13px cards, ringed nodes (3.1.10, 3.1.11, 3.6); wires side to side on a left-to-right graph with captions off the cards; a wire goes ROUND a card that is not its own (a lane beside it), captions are placed together so none is on a card or on another, and a palette-added step never lands under a Finish step; a parallel step is drawn and opened (it is not editable yet, by design) |
| ☑ | Prompts and prompt detail | |
| ☑ | Proposals | pending, stale and orphaned, each saying what may be done; the empty state is one pane. The "unexplained 502" is `/api/github/repos` on SETTINGS when `gh` is unavailable, and Settings explains it in place |
| ☑ | Draft review | the card and the page share one list; marks are SVG, headings `SectionLabel` |
| ☑ | Settings | paths wrap in the card, names are not cut (3.1.9); sound unchecked by default |
| ☑ | Dialogs, toasts, tooltips | 20 dialogs close on Esc with focus inside, and focus returns to what opened them; menu, palette, `?` sheet, toast and dialog also at 1024 |
| ☑ | Empty, loading, error and unknown-id states | an empty home (no runs, workspaces or proposals) on every screen; 404; a run id that does not exist (3.1.14). Loading skeletons are on screen for under a second and were judged in the gallery, not in place |

### States the demo home produces, and the ones it still cannot

Added in iteration 3 (`tools/visual/seed.ts` section O, `live.ts`), each reached the way a
real run reaches it unless a seam is named in the seed: a `parallel` step (a finished run and
one with a failed branch, on a local graph), a delivered and a pending steer on a live turn, a
delivered soft stop, the Drift pane, a stacked run waiting in `deps.wait` with a live runner, a
gated acceptance park (a local graph with `requiresAcceptance`), a permission ask, an
`mcp-elicitation` ask, parks for `turn-timeout`, `no-progress` (by the engine's own tree
comparison), `repair-stalled` and `stale-base` (by the real gate), a queued and a
failed-recoverable run, an empty home, a stale and an orphaned proposal, an UNVERIFIED prompt
reconstruction, failed evidence, and a Logs fetch error (forced by cutting the route for one
capture step).

Added in the final pass (`seed.ts` section Q): a run that polled its PR fourteen times before it
merged (the fold), a parked run whose PR is known only from `publication_summary` (the probe never
reached the forge), a stacked run with two pull requests of its own in different states, a tool
call the harness failed, one it passed whose output says "0 failed", and one with no verdict at
all (an old log's shape) whose output starts like a failure; and on the `triage-bug` local graph a
step title long enough to wrap past three lines.

Still not produced, so not judged: a real desktop notification (headless Chromium blocks the
permission); a codex `request_user_input` question and any cursor or opencode transcript; the
`tools-unsupported`, `max-steps` and `approval-missing` parks; a harness fallback hop
mid-run; a parallel step with a branch waiting on a question while its siblings stream; the
Settings GitHub picker with `gh` logged in. The quick-task graph's own description is still
the scaffold's "TODO: one line on what this graph does" in `graphs/quick-task.ts`: the string
is part of the shape pinned in `graphs/fixtures/pre-spec-shapes.json`, so it was left alone.
The viewer no longer prints a scaffold placeholder (`graphDescription`, `lib/format.ts`): the
Graphs list says "No description yet." and New run says nothing.

## Loop log

What each iteration did, and what the gate measured at its end.

**Iteration 0 — audit.** 351 captures of the T25 viewer on 28 seeded runs; the defect list in
`design-overhaul-audit.md`. No gate yet. Measured then: ten font sizes from 9 to 17px, 13.6k
mono elements to 7.6k sans, faint text at 3.06:1, a parked run unanswerable at 1024×700.

**Iteration 1 — foundations.** `DESIGN.md`/`PRODUCT.md`, the Indigo tokens and six-step scale,
bundled fonts, the nine new primitives, the shell, the shortcut registry, `parkSummary`.

**Iteration 2 — surfaces.** Four agents redesigned the run view, the screens and the builder
in one tree. Capture: 392 PNGs, 177 audited screens. The gate did not exist yet; applied to
that capture afterwards it reads **FAIL**: 0 sizes off scale, 0 foreign faces, 0 raw
truncation, 0 small targets, 0 unringed stops — but 97 clipped/unreachable (every one a false
positive: `sr-only` labels and React Flow's canvas), 34 contrast failures (disabled and
loading buttons at 2.3–2.8:1, and the diff "+" gutter at 4.45:1) and 6 capture steps that
timed out.

**Iteration 3 — check against the plan.** One pass over the whole viewer as the design
director.
- *Punch list (14):* the engine's `[failed: …]` line is a quiet notice and is not printed
  above the card that says the same thing; the no-reply card reads heading → items → hint →
  action → disclosure; builder wires leave and enter by the sides that face each other and a
  caption never sits on a card; a step chosen in Build or in the Details timeline lands on its
  detail at narrow widths; exactly one `#needs-input` (that it "takes focus" was claimed here and was FALSE in a browser — see the fix pass below); two attempts of one
  visit are two rows with their own identity; the draft card's dingbats are inline SVG and its
  headings `SectionLabel`; transcript prose uses the 720px column; disabled buttons are
  readable and loading ones keep their colours; a path breaks at its slashes; the seeded home
  no longer turns the sound on; `questionnaire` has no `dark:` utilities; the six failing
  capture steps run; the audit's false positives are excluded and it now fails loudly.
- *Seed:* 19 states added (see below), a second viewer over an empty home, two live runs.
- *First full capture of this iteration:* 574 PNGs, 273 audited screens, 0 failed steps.
  **FAIL** on one line — 37 targets under 24px: the captions and cards of a canvas zoomed to
  49% (30; judged by-design and excluded, as browser zoom would be), a 17px "Open linear's
  link" inside a sentence (5; now a 28px outline control, and the last hand-written ellipsis
  went with it) and the new notice's 20px summary (2; now 24px). Every other line 0.
- *Found by looking, and fixed:* a permission ask showed no command (it shows it, with Allow
  and Deny); the gated acceptance park advised a retry that would park again; a routing park
  had no action (it offers the way to the Graph tab); the Context tab said "Not written yet"
  beside the run's own goal (inputs are "you, at launch"); a question's header was drawn under
  its question; "5m 60s" and "8h 0m" (one duration format); dates read three ways (one
  `fmtWhen`); the inbox said "waiting" 21 times under "Waiting on you"; the approval card
  still opened with "Needs you —"; toasts and three empty states started in lower case;
  "UNVERIFIED" was an uppercase label; screen headers were 48 or 49px by whether they held a
  button; an empty state's title was a second `h1`; a 117-character line on Prompts.
- *Motion, reduced motion off:* the ask arrives once (opacity 0 → 1, 6px, scale 0.985 → 1,
  320ms) and never again on a tab switch, in-app navigation or a reload; menu, popover and
  tooltip open from their trigger in 150ms on the strong ease-out; press settles at 0.97 in
  120ms; hover moves nothing; no loop but four spinners on loading buttons. Three things DID
  animate on a key and no longer do: the transcript's scroll pin on a number-key tab switch
  and on `⌘I`, and the `?` sheet (a dialog opened from the keyboard is now instant).
- *Keyboard:* 20 screens tabbed to the wrap — no lost focus, no trap, 0 unringed, 0 off-screen
  stops; every DESIGN.md key does what the `?` sheet says; Esc closes the topmost of sheet over
  drawer. Three failures found and fixed: focus fell to `<body>` when the palette, the `?`
  sheet or any dialog closed (they unmount before the platform can restore it), and Esc on
  "About this home" closed a tooltip nobody had asked for instead of the popover.
- *Consistency (measured on 25 views × 2 themes):* 0 views with more than one primary button,
  0 with amber where nothing waits, 0 uppercase; one section-label style (12px/600 muted);
  screen headers 48px.
- *Final capture:* 584 PNGs, 281 audited screens, 0 failed steps. **PASS**, every line 0.

**Sign-off pass — the app used, not only captured.** One reviewer walked seven journeys with
their own scripts (answer every kind of ask by mouse and by keyboard, read a finished run,
start a run, build a graph, prompts and proposals, settings and empty states) at 1440, 1280
and 1024 wide in both themes. The gate passed before and after; none of what follows is
something the gate measures.
- *Found and fixed:* `A` then a number on a question card switched TAB instead of picking the
  option (the questionnaire hears numbers on its form; `A` focused the card around it) — `A`
  now lands on the active question's first choice and the hint says so; a refused save in the
  builder printed `**title**` and `` `key` `` raw in its banner and toast; `/` did nothing on
  Logs; the `?` sheet opened with its ring on the "Single-key shortcuts" checkbox, one Space
  from switching them off (`showModal()` focuses the first control and React's `autoFocus`
  cannot overrule it — dialogs now honour `data-autofocus`); the waive reason field opened
  unfocused with no Enter or Esc; Runs said "Needs you 24" under a rail badge of 21 (the group
  also holds dead and retryable runs — it now reads "24 · 21 waiting on you, 3 to resume or
  retry"); steps added from the palette by click or key landed 8px apart under each other's
  captions (`freeSpotNear` now leaves room for a caption and stays in view); the inbox's wait
  column hung 40px short of the row's edge; a PR chip read "PR changes_required"; a live row
  read "active 0s ago"; a dozen toasts and one transcript notice started in lower case;
  `decideRing` was pinned by a test and not called by the code; the scaffold's "TODO: one line…"
  description was printed on Graphs and New run.
- *Left, with a recommendation each:* see the hand-off report of this pass (HOW-68) — the OS
  notification still posts through `osascript` when `terminal-notifier` is absent; the sound
  file is the old one; a third step added from the palette in a small pane can still land on a
  wire; focus falls to `<body>` after an ask is answered; core's problem sentences say "in
  Branching" where the panel's section is titled "Goes to".
- *Gate at the end:* 584 PNGs, 281 audited screens, 0 failed steps, **PASS**, every line 0.
  `bun test`: 3192 pass, 5 skip, 3 fail — the three are `chmod`-based tests that cannot fail
  the way they expect when the suite runs as root, and fail the same way without this pass.

**Fix pass — what the sign-off review left open (D18–D26).** One agent, working from the
review's hand-off. Everything below was changed in code and has a test unless it says otherwise;
"in Chromium" means driven with Playwright against the seeded viewer, not captured by the gate.

- *Notifications (D18).* One ask used to be announced twice — the engine's OS banner and the
  open viewer's browser notification — and with no `terminal-notifier` the OS one was the
  "Script Editor" banner. Now the viewer says it is there (`lib/presence.ts` →
  `POST /api/viewer/presence` → `$HOWDAH_HOME/viewer.json`, liveness beside `heartbeat.json`),
  and `osNotifier` skips its banner while a notifying viewer was seen in the last 45s
  (`engine/viewer-presence.ts`). A skipped banner still stamps `notified_at` — the browser's
  notification is the delivery — and records `notified_via: "viewer"`; the watchdog re-opens it
  as soon as the viewer is shown never to have beaten again after the ask, so the OS path rings
  within a tick or two instead of 30 minutes later. Deliberate and documented: a viewer that is
  visible and focused posts nothing and the OS banner is skipped too; and while a notifying
  viewer stays open the 30-minute re-ring is left to it (its standing notification, the count
  and the favicon) — the OS re-ring resumes when the viewer goes. The shell now observes asks
  on every screen (it was Runs, Needs you and a run's own page only). `howdah doctor` and
  Settings both say whether the OS banner is clickable, with `brew install terminal-notifier`
  and a copy button. Deep links from the CLI, the watchdog and the executors follow
  `HOWDAH_PORT`, else the port a viewer last reported, instead of always `:4711`.
- *Sound (D19).* `web/public/chime.wav` is one 160ms 660 Hz tone at −18 dBFS, written by
  `tools/chime.ts` (`--check` compares the committed bytes) and pinned by `web/chime.test.ts`.
  The OS path plays "Tink" instead of "Glass", still only when the setting is on.
- *Focus (D20).* A change of SCREEN moves focus to the new screen's `<h1>` and titles the tab
  ("Runs · Howdah", "<run name> · Howdah"); a selection inside a screen does not. An answered
  ask hands focus to the run header's status line; the outcome is announced by the existing
  polite toast region, reworded ("Reply sent. The run is resuming."). In Chromium: the heading
  shows the ring after `g r` and not after a mouse click on the rail (it follows
  `:focus-visible`, nothing forces it), Tab from the heading goes to the screen's first control,
  and the skip link still targets `#main`.
- *Builder (D21, D24, D25).* A palette-added step is placed clear of every card AND every wire
  and its caption, and the canvas pans — never zooms — by the least that shows it. The panel
  section core's sentences call "Branching" is titled "Branching". The verdict is said once:
  the bar and the panel both read "N problems to fix before saving", Save with something
  blocking lands on that list (focused, scrolled to) with no banner and no toast, and only a
  refusal the browser could not predict adds a row to the list and one toast.
- *Smaller (D22, D23, D26).* Needs you has no step column; the id follows a sentence that does
  not already name it, in a slot the sentence cannot push off the row (the first version of this
  appended it to the sentence, and the gate caught a long sentence cutting it away: 4 unreachable). Graph boxes print the part of an id that tells steps apart
  (`impl….local_review`), the group dimmed. Approve and Send feedback confirm with the primary
  button, not red. A dead run's interrupted step is a cross and the word "interrupted" in
  Details and in Steps, with its clock stopped; the run says it died in the header and one
  notice. `scopeVariant` is removed and `problemsByPane` is used. The transcript has no edge
  fade.
- *Found by using it, not in the review's list — each was wrong in a browser and passed the
  test DOM:*
  - **A notification's deep link never focused anything.** `#needs-input` was stripped from
    the URL on the first render, before the run had loaded; and where it survived, the card's
    `focus()` ran while the transcript was still `visibility: hidden`, which a browser ignores.
    Iteration 3's "exactly one `#needs-input`, and it takes focus" was therefore false. The hash
    is now dropped only once the run is seen to have no ask, and every card kind takes focus
    through `focusWhenVisible` (three of the five never tried).
  - **Save on an unnamed draft said " saved — it is in the catalog and ready to launch".**
    `PUT /api/graphs//builder` matches no route and the server answers it with the app's page
    and a 200. An unnamed draft is no longer sent, and a 2xx that is not the route's own answer
    is not a save. (The server still answers unknown `/api/…` writes with the page; not changed
    here.)
  - **Every answer flashed "Runner died".** A parked run has no runner, so between the answer
    and the resumed runner taking its lock the read model says `harness-dead`; the header and a
    red notice said so to the operator who had just answered. For 4s after a run's last event
    the frame says "Resuming".
  - **"Choose an answer to continue." under an accepted answer**, for the whole collapse of the
    question card (the choices are disabled while sending, and a disabled choice does not
    satisfy `required`).
  - Focus fell to `<body>` after pinning a comment, after a waiver, after cancelling the waive
    field, and after accepting a proposal. Each returns to the control that opened it, or to
    what the screen now says (Reject and Re-draft share the code path and were not driven).
  - A screen that loads in two renders replaced the heading that had just been focused; focus
    is kept on the heading while the screen settles.
  - Text fields, selects and checkboxes had no hover state and a different disabled look
    (50% opacity) from buttons and chips (the `--fg-disabled` token); rows, chips, segment tabs
    and rail items had no pressed state. Fields now hover, press states exist, and disabled is
    one look. Swept in both themes: 90 distinct controls and row types, rest / hover / pressed.
  - `executor threw: EPIPE` instead of "not logged in" when a CLI dies before its prompt is
    written (`engine/executors/claude.ts`); it failed CI once as a lost race. The first write
    is guarded and a deterministic test pins it.
- *Exercised in Chromium, with the engine's executors stubbed (`HOWDAH_STUB=1`):* permission
  Deny, a prose reply by Enter, a two-question ask by keyboard (A, 2, Enter, 1, 3, Enter), an
  effect verdict each way, a single waiver and the "every unprovable" one, a pinned comment
  then Send feedback, Redesign, and proposal Accept. Every request succeeded (200/201/202); the
  cards went idle → sending → collapsing; focus ended on the run's status line (on the notice,
  for the proposal; on the next waivable control, after a single waiver). None of them produced
  a refusal, so "refused verbatim" was NOT seen in a browser in this pass — it is covered by
  the component tests only.
- *Not done, or not verified:* a real desktop notification and the OS banner (see the
  checklist row); the new sound was never heard; the builder's pan was checked at 1024×700
  only, with three added steps on the blank preset, not on a large or zoomed-out graph; the wire test
  in `freeSpotNear` treats a wire as the straight line between two cards, which the drawn curve
  only approximates; `main` is not itself focusable, so the skip link moves the reading
  position and not `document.activeElement` (as before); the hover/pressed sweep reads computed
  styles of one element per kind and does not judge how the states look.
- *Gate at the end of the fix pass:* full re-seed and full capture — 584 PNGs, 281 audited
  screens, 0 failed steps, **PASS**, every line 0 (the first full capture of this pass FAILED on
  one line, the 4 unreachable inbox step ids above). `tsc --noEmit` clean. `bun test`: 3241
  pass, 5 skip, 3 fail — the same three `chmod`-based tests, which cannot fail the way they
  expect when the suite runs as root.

**Confirming review — a second, independent pass over the fix pass's claims.** One reviewer with
their own Playwright scripts against a seeded viewer run with `HOWDAH_STUB=1` (probes and
screenshots are kept with the capture, not in the repo). Only what was checked is claimed, and
each line says how. "In Chromium" means headless Chromium driven by Playwright.

- *Re-verified in Chromium, each with one check (1280×800, dark, unless a size is named):* `A`
  then `2` picks the second option and stays on Build; `/` on Logs lands in the search field; the
  `?` sheet opens on "Done", not on the checkbox, and Esc returns focus to the control it was
  opened from (Runs, Settings, the builder, a run); Runs reads "24 · 21 waiting on you, 3 to
  resume or retry" against a rail badge and an API count of 21; no "PR changes_required",
  "active 0s ago" or scaffold TODO on Runs, Needs you, Graphs, New run; the inbox's wait column
  ends 8px from the edge on all 21 rows and no row names its step twice; `g r` focuses the new
  `h1` with a ring and titles the tab, a rail click focuses it without one, Tab then reaches the
  screen's first control; a `#needs-input` deep link lands focus inside the card for ten runs
  covering every card kind, with exactly one `#needs-input`; the Graph tab prints
  `impl….local_review`; Approve confirms with the primary button; the builder's section is
  "Branching" and a blocked Save lands on the problem list with no toast; a field has a hover
  state and a row a pressed one; answering by keyboard, an effect verdict, Deny, a prose reply,
  Retry, a waiver, a pinned comment then Send feedback, proposal Reject / Re-draft / Accept and a
  draft Save all returned 2xx, none flashed "Runner died" or "Choose an answer to continue", and
  the polite live region said "Answer sent. The agent is carrying on." The answer journeys were
  repeated at 1440 and 1024 wide in light and at 1024 in dark; three of that script's own checks
  (the two refusals and the keyboard question) were only proven at 1280 dark.
- *A refusal, seen verbatim in a browser (the fix pass had not seen one):* a reply to a run that
  had stopped waiting → 409, "nothing awaiting a reply" in the card's alert and the toast; Send
  feedback on a round approved elsewhere (the tab held stale by cutting its reads) → 409, the
  server's whole sentence printed word for word; a create-save onto a name taken behind the
  page's back → 409, "There is already a graph called zz-race-2. Pick another name." in the
  problem list and one toast; a waiver with an empty reason cannot be sent (the button is
  disabled, Enter sends nothing, Esc returns focus to "Waive…").
- *Claims in this log that were wrong or incomplete, as found:*
  - "One `h1` per screen" was false on any run whose transcript holds a document: an agent's
    "# Plan" was a second `h1` (seven run views in the sweep). Markdown headings are drawn one
    level down; the look is unchanged.
  - "A focus-triggered tooltip does not animate" was false for the tooltip a row shows while its
    link has focus: `J` and `K` down the Runs list ran two transitions per key. A forced tooltip
    is instant now.
  - "A caption never sits on a card" and "a palette-added step is placed clear of every wire"
    hold only at the moment of placement. A step added from the palette lands under the Finish
    step, and wiring the first step to it from the panel draws that wire THROUGH the Finish card
    with two captions on it. Not fixed (see "Left").
  - "Empty, loading and error states for everything": the error half was not there on four
    screens (below).
- *Found by driving it, and fixed (each with a test unless it says otherwise):*
  - **A 250–390ms main-thread task every second on a long run, for as long as the tab was open.**
    The frame re-renders on its one-second clock and took the whole transcript with it: measured
    idle, on a FINISHED run with 600 transcript items, 0 DOM mutations per task; 53–85ms per
    second on an ordinary run. Scrolling hitched five times in four seconds. The panes that do
    not read the clock are memoised; idle long tasks are now none and a 120-notch wheel scroll
    through the 63,000px transcript has no frame over 50ms (p95 16.8ms) at all three sizes.
  - Needs you stayed on its skeleton for ever when the server failed; New run opened with an
    empty graph list and "Still needed: a graph"; a run whose read failed with a 500 (or no
    server) ended on "There is no run <id>"; a draft whose read failed with a 500 said "No draft
    to review yet". Each now says it could not load, with a retry, and none claims the thing
    does not exist. Forced with `page.route` (every `/api` GET answering 500, then aborted);
    Runs, Graphs, Prompts, Proposals and Settings already had the state.
  - Focus fell to `<body>` after a draft's Save (the receipt takes it) and after "Remove this
    step" in the builder (the canvas takes it).
  - "Filter the runs" chosen from the palette focused nothing: the command ran while the modal
    dialog still made the page inert. The dialog is closed before a command runs.
  - At 200% browser zoom on a 1280px window the builder's bar pushed Save and More past `main`'s
    edge, where nothing scrolls (WCAG 1.4.4). Under 800px the bar wraps.
  - Forced colours (Windows High Contrast): a filled button had no edge, every tab showed the
    same rule and the rail's current item was indistinguishable. Restated in system colours
    (`globals.css`); no unit test — checked in Chromium's forced-colours emulation in both themes.
  - `components/scroll-shell.tsx` was imported by nothing and kept three rules alive in
    `howdah.css`, one of them an `overflow: hidden`. Deleted.
- *Checked and found sound (how):* 39 screens (every route, seven tabs of a finished run, eight
  empty-home screens) × 1440×900, 1280×800, 1024×640 × both themes — no scrolling document, no
  clipped box, no unnamed control, no positive `tabindex`, one `main`, one named `nav`, one
  selected and one tabbable tab per strip, only the six sizes and two faces, `?` opens and closes
  on every screen. Text-spacing override (line-height 1.5, letter-spacing .12em, word-spacing
  .16em) on the same 39 in both themes at 1280: no clipped box; looked at Runs and a question card.
  200% zoom (a 640×400 viewport at 2×, the same 39 in both themes): no clipped box after the builder fix, the
  reading column scrolls one way. The Report page measured INSIDE its iframe at all three sizes
  and both themes: sizes 12/13/14/16/20, DM Sans and DM Mono, 0 contrast failures, 0 targets
  under 24px, 23 focus stops all ringed, no external request, follows the theme. The long run
  (seed section P: a 6,000-character line, a 220-tenant JSON result, a 300-character unbroken
  token): everything wraps inside the 720px column, nothing spills or clips at any size. A
  continuous resize 1440 → 1024 in 16px steps on a parked run, the builder and Runs: header 48px
  throughout, nothing clipped. With single-key shortcuts off: `g s` and `?` do nothing, `Ctrl K`
  opens and lists "Keyboard shortcuts", all 37 focus stops of a question run are reachable by Tab
  and the question is answerable with Tab, Space and the arrows. Motion with reduced motion off:
  nothing runs on `1`–`7`, `Ctrl I`, `Ctrl K`, `?`, `.`, `J`/`K` or `g n`; no loop at rest on a
  live run; a mouse-opened menu animates opacity and scale only. With it on: nothing runs.
  Every palette command (39, on Runs and on a run) ran without a page error. Settings: every
  field, both checkboxes, both copy buttons, `Ctrl S`, and the values after a reload.
- *Code:* `overflow: hidden` is left on `.shell` (the viewport frame, which never scrolls) and on
  `main` (the containing block that stops a visually-hidden label scrolling the document);
  `css-contract.test.ts` still enforces primitives-only controls, class ↔ rule both ways, no hex
  or `font-size: Npx` outside tokens, an EMPTY raw-ellipsis allowlist, no `dark:` utility and no
  `title=` tooltip. axe-core was NOT run: it is not installed and no dependency was added.
- *Left, with a recommendation each:*
  - A tool call is badged "failed" in red when its OUTPUT matches `/\berror\b|\bfailed\b|…/`:
    "14 tests completed, 0 failed — BUILD SUCCESSFUL" reads as a failure, and a group says
    "3 failed". The log carries the harness's own `is_error`; `log/coalesce.ts` drops it. This
    predates the redesign and changing it changes what old logs show, so it was not touched:
    carry `is_error` through and keep the regex only as "may have failed" when the harness said
    nothing.
  - The builder draws a wire through a card (above). Place a palette-added step beside the
    column it would otherwise extend, or route around cards.
  - The ask card's entrance (`data-arriving`) was never seen in a browser: it only plays for an
    ask seconds old, which the stubbed home cannot produce. Covered by the component test only.
  - The Runs list is 44 links, each its own tab stop, in no list element (`J`/`K` and the skip
    link are the fast paths); a tab strip has no accessible name and no `tabpanel`; the "Latest"
    pill floats over the last visible line of the transcript; focus falls to `<body>` after a
    REFUSED approval and after "Register a local path" opens its form; keys do not reach the app
    while focus is inside the Report's sandboxed frame (Tab leaves it); first paint of the
    600-item run takes ~1.0s with a 500ms task, and switching to its Logs tab a 600–760ms one.
  - Not driven here: a real notification, the sound, a live ask arriving, the builder journey
    at 1024 (the compact palette has no name field, so the script that names a step could not
    run; the gate's captures cover that width).
- *Gate at the end:* full re-seed and full capture — 586 PNGs, 283 audited screens (two more than
  before: the long run, expanded and on Logs, at 1024×700), 0 failed steps, **PASS**, every line
  0. `tsc --noEmit` clean. `bun test`: 3306 pass, 5 skip, 3 fail — the same three `chmod`-based
  tests that cannot fail the way they expect as root. Two other agents were editing the run
  Graph, Plan, the Details drawer, the Report and the notification code in the same tree while
  this ran: the capture was taken part-way through their work and the test run after it, so
  neither number is a verdict on those changes, and none of the checks above was repeated on them.

**Operator feedback — the first hands-on verdict, and the work it started.** Recorded here
because the entries around it refer to it; this pass did not do that work and re-verified it
only as the Final pass says. Three sentences from the operator — "the graphs are not so neat,
not possible to see the full text of the node on hover, and cannot use mouse to move the
canvas" — plus "would like full screen for the plan" and that the pull request was hard to find.
What landed: the read-only graph on React Flow, laid out by `@dagrejs/dagre`
(`graph-dag.tsx`, `lib/dag-layout.ts`); the Plan pane at 880px with a side column; focus on `F`;
a resizable Details drawer that leads with the pull request, and a PR chip in the header; a
poll folded to one row in the Details timeline; the report's and every external link opening a
new tab. Separately the coordinator changed notifications: the viewer claims delivery — and
so silences the OS banner — only after the operator answers "Yes, I saw it" to a test
notification in Settings.

**The fix pass's numbered items (D18–D26).** D1–D17 are NOT recorded: the sign-off review
numbered its findings in a hand-off report that is not in the repository, and its "Found and
fixed" list above is not numbered, so matching one to the other would be a guess. (`D2`, `D5`,
`D7`, `D8`, `D9`, `D15`, `D17` in source comments are HOW-24's and `shaping.md`'s decisions, a
different series.) D18–D26 are as the fix pass and the source comments give them:

| | What | Where it is held |
|---|---|---|
| D18 | One ask, one notification: a notifying viewer beats `viewer.json` and the OS banner stands down; the shell observes asks on every screen; deep links follow the viewer's port | `engine/viewer-presence.ts`, `lib/presence.ts`, `lib/notify.ts`, `engine/attention.test.ts` |
| D19 | The sound is one short soft tone; the OS path plays "Tink", only when the setting is on | `tools/chime.ts`, `web/chime.test.ts` |
| D20 | A change of screen focuses the new `h1` and titles the tab; an answered ask hands focus to the run's status line | `lib/page.ts`, `main.tsx`, `run-frame.test.tsx` |
| D21 | A palette-added step is placed clear of every card and wire; the canvas pans, never zooms, to show it | `lib/layout.ts` `freeSpotNear`, `builder/canvas.tsx` `revealShift` |
| D22 | Needs you has no step column; the id follows a sentence that does not already name it | `screens/attention.tsx` |
| D23 | A graph card prints the part of an id that tells steps apart, the shared group dimmed or dropped | `graph-dag.tsx` `nameOf` |
| D24 | The panel section core's sentences call "Branching" is titled "Branching" | `builder/properties.tsx` |
| D25 | The verdict is said once: bar and panel in the same words, Save lands on the list, one toast only for what the browser could not predict | `builder/properties.tsx`, `graph-builder.test.tsx` |
| D26 | A dead run's interrupted step is a cross and "interrupted" in Details and Steps, clock stopped; the run says it died once | `status.tsx` `stepInterrupted`, `run-frame.test.tsx` |

**Final pass — the open defects closed, then one capture and one browser pass on a settled
tree.** One agent, alone in the tree. "In Chromium" means headless Chromium driven by Playwright
against the seeded viewer; the mutating checks ran against a viewer started with `HOWDAH_STUB=1`.
Scripts and screenshots are kept with the capture, not in the repo. Only what was checked is
claimed.

- *Closed, each with a test:*
  - **A tool call is "failed" on the harness's word.** The log has carried `chunk.is_error`
    since HOW-38 and `log/coalesce.ts` dropped it; the transcript then guessed from the output's
    words. It is carried through (absent stays absent) and `toolOutcome` decides: `true` → the
    red badge; `false` → nothing, whatever the text says; absent → a narrow line-start pattern
    shown as a neutral "may have failed", never red, never counted, never opened for you. On the
    600-item run 7 of 100 groups say "failed" (the ones the harness failed); before, every
    "0 failed — BUILD SUCCESSFUL" group did.
  - **A builder wire goes round a card.** `routing.ts` picks each route's sides with every
    other card in view and falls back to a LANE (out and back by the same side, beside whatever
    stands between); a loop back up a column is a lane too (it was a line up the cards' own
    edges); captions are placed for the whole canvas at once; a palette-added step never lands
    under a Finish step. In Chromium, a five-step graph built only from the palette and the panel
    with every step wired (8 routes), at 1440, 1280 and 1024 wide in both themes, fitted and at
    100%: 0 wires through a card, 0 captions on a card, 0 captions on a caption, 0 cards on a card.
  - Runs and Needs you are real lists with ONE tab stop (roving, `Home`/`End`); every tab strip
    is named and a pane-switching strip's pane is its `tabpanel`; "Latest" sits in the
    transcript's toolbar; a step parked mid-turn on a question reads "waiting on you" in the
    Details timeline; a refused approval and Settings' "Register a local path" no longer drop
    focus to `<body>`; `Esc`, `F`, `?` and `1`–`7` typed inside the Report's frame reach the app
    (the page posts exactly those keys; the pane accepts them only from its own frame), and the
    pane says every other shortcut needs Tab out first.
  - The Steps list folds a poll by the Details timeline's rule (`lib/timeline.ts`); the fold is
    a row J/K walk over. A parallel group is never folded into.
  - The read-only layout gives every sideways run in a gap a lane of its own and opens a gap
    that has more lanes than room; wires are drawn square with rounded corners. A geometry test
    over every built-in graph (`dag-layout.test.ts`) counts cards on cards, captions on cards or
    captions, wires through cards, and two unrelated wires sharing 30px or more: 0, where the
    same count before the change was 4 shared runs (implement-slice, implement-stacked ×2,
    improve-codebase). The cost: the big graphs are 19–29% taller.
  - A finished run's graph opens on the whole graph when that fits at 70% or more, else on its
    last step at 100% with `Home` back to the start — and that last step is no longer drawn as
    the step the run is ON (it carried the running half-disc on a run that had ended).
  - A drag or an arrow on the Details drawer starts from the width on screen when a remembered
    width is clamped on a narrow window (it ignored the first pixels, then jumped).
- *Found by driving it in this pass, and fixed:* the control that toggles focus mode is
  unmounted by the toggle, so pressing it left focus on `<body>` (its counterpart takes it —
  only when the control itself was pressed: the first fix moved focus on every `F`, which raised
  a tooltip over the tab strip); Settings' "Yes / No" answer left focus on `<body>`; `A` then a
  number typed at once could send the number to the tab strip (the jump waited a task even when
  Build was already showing); a graph card's hover colour faded when a keyboard pan carried it
  under a resting pointer — motion on a key; the builder's "Show the whole graph" cut the lanes
  and their captions off (it fitted the cards only); the read-only "show all of it" put the zoom
  controls on the lowest card; and under forced colours a graph's wires kept the theme's own
  stroke, so in the dark theme the routes a run TOOK were near-white on the system's white canvas
  (wires are restated in `CanvasText` / `GrayText`); and at 1024 wide with the drawer open the
  header's PR chip ran under the "More" button (the tooltip's wrapper shrank under a link that
  would not) — found by looking at the final capture, which the gate had passed.
- *Performance, measured (1280×800, three loads each, the 600-item run):* switching to Logs was
  780–810ms with one 620–640ms task; the list is windowed (fixed 28px rows) and it is 345–410ms
  with a 170–205ms task. First paint of the run is 570–680ms with a 230–290ms task before AND
  after: the transcript is one step of 600 beats inside `MessageScroller`, and windowing it was
  not attempted. `content-visibility: auto` on the tool rows was tried and measured WORSE (first
  paint 680–810ms; expanding all 300 tool calls 410ms → 590–650ms) and was removed. The
  confirming review's "~1.0s / 500ms" was a different measurement and was not reproduced here.
- *The browser pass (98 checks; table in the hand-off report, log and screenshots with the
  capture):* at 1440×900, 1280×800 and 1024×640 in both themes — focus mode by key, by button
  and by Esc; the drawer resized by keyboard and by mouse, its width after a reload; the PR
  first in Details and in the header, each opening a new page; a PR known only from the summary
  and a two-PR run; the report's links and the keys typed inside its frame; the graph panned by
  drag, wheel and keys, a tooltip on hover and on focus, a step activated, the minimap, a
  finished run's opening view; all 14 graphs at 100% (nothing on anything); list, tablist,
  tabpanel and separator semantics; the fold; the tool verdicts; the Plan pane. Once per theme:
  the Plan at 2000×950, 200% zoom on Build, Plan, Graph and Steps, forced colours on the graph
  and the drawer, reduced motion on. Once, at 1280 dark: the Settings notification flow (the
  presence beat's body is `{"notify":false}` until "Yes, I saw it", then `{"notify":true}`); a
  stale reply and a stale approval refused verbatim; the question, effect, permission, prose,
  no-reply, waiver and approval cards answered; a keyboard-only walk. All 98 hold on the
  settled tree (92 in the verifying run and 6 after a correction to the check itself — see
  "Gate"). Checks failed on the way: some were this pass's own scripts (a selector, an
  assertion too narrow, a stale-tab hold on the wrong route), the rest were the defects listed
  above. One defect was found by LOOKING at a screenshot of a check that had passed (the
  forced-colours wires): the check asked whether a wire was drawn, not whether it could be seen.
- *Not checked, or not done:* a real desktop notification, the OS banner and the sound (as
  before — the notification flow ran against a stand-in `Notification`); the MCP-elicitation
  and soft-stop cards were not answered in this pass (the elicitation run was used for the stale
  reply); the ask journeys ran at 1280 dark only; the builder was driven on one five-step graph,
  not on a large or zoomed-out one, and a lane is only as clear as its two straight legs — a
  canvas crowded on all four sides can still leave a wire no clear lane (it takes the one that
  crosses fewest); the transcript is not windowed; the Logs list's rows outside the window are
  not found by the browser's find-in-page (its own search finds them); a step title is still
  cut with an ellipsis after three lines on a read-only card (the tooltip has the rest);
  keys other than `Esc`, `F`, `?` and `1`–`7` do not leave the Report's frame; axe-core was not
  run; codex, cursor and opencode transcripts are not seeded, and for codex and cursor a tool
  that did not fail carries no verdict, so their failure-shaped outputs read "may have failed".
- *Looked at, as opposed to measured (about twenty captures, by eye):* the Steps fold closed and
  open, the tool verdicts, the two-PR and summary-only headers and drawers, a finished run's
  graph opened and "show all", the long step title, the builder with a route selected and
  whole, the five-step builder graph wired, forced colours on the graph, the header at 1024,
  "Latest" in the toolbar — in dark and light at 1280 or 1440, in dark at 1024. implement-ticket
  and implement-stacked were looked at whole at 100% after the lane change; the other twelve
  graphs were MEASURED in a browser at 100% (nothing on anything, at three sizes in both
  themes) and by the geometry test, not each looked at. The other ~700 captures were judged by
  the gate only.
- *Gate, on the settled tree (one script, in this order, nothing edited between: `tsc`, the full
  suite, the browser pass, a fresh seed, the full capture, the gate):* `tsc --noEmit` clean.
  `bun test`: 3353 pass, 5 skip, 3 fail — the same three `chmod`-based tests, which cannot fail
  the way they expect when the suite runs as root (`graphs/implement-slice.test.ts` "an
  unfingerprintable worktree…", `graphs/builder.test.ts` "a prompt that cannot be created…",
  the map executor's "an unreadable untracked file…"). Capture: 718 PNGs, 327 audited screens,
  0 failed steps, **PASS**, every line 0. In that same run the browser pass read 92 of 98: the
  six were ONE check at six sizes, a header-overlap assertion added an hour earlier that measured
  a truncated heading by its unclipped text; corrected (the heading's box) and re-run on the same
  tree, 6 of 6. The loop-log and checklist text you are reading were written after that run and
  are the only difference from the tree it judged. Two earlier full captures of this pass are
  not the verdict: the first FAILED on one line (2 failed steps — a capture step that hovered
  "the current step" of a finished run, which this pass had just stopped drawing), and the
  second passed but two app fixes followed it (the forced-colours wires, the PR chip).
