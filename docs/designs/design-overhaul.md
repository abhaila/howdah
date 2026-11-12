# Design overhaul (HOW-68): the plan and the loop

Status: **agreed 2026-11-12; three iterations of the loop have run (see "Loop log").** `DESIGN.md` is now the authority and wins
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
| A run | `1`–`7` tabs · ⌘I details · `R` reply · `A` jump to the ask · `/` ask about the run, or search on Logs · `E` expand tool calls · `O` open in IDE · `.` more |
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
| ◐ | Native notifications — ONE notification per ask: an open viewer whose browser permission is granted beats `POST /api/viewer/presence` every 20s, the server writes `$HOWDAH_HOME/viewer.json`, and the engine's OS notifier stands down while that is under 45s old; the shell (not only Runs / Needs you / a run) observes asks, so a viewer left on any screen announces them. **Verified:** the ring/skip decision, the presence file, the watchdog ringing through the OS when the viewer never beat again, the deep link's port, the route and its guards, and the beat itself — by unit and route tests (`engine/attention.test.ts`, `web/web.test.ts`, `web/app/focus.test.tsx`, `web/app/notify.test.ts`); that a notification's deep link (`/run/:id#needs-input`) lands focus on the control — in Chromium, for all five card kinds. **Not verified:** a real browser notification on screen (headless Chromium blocks the permission; the posting half runs against a fake `Notification`); the OS banner itself, through either `terminal-notifier` or `osascript` — this sandbox is Linux and has neither, so only the argv and the decision to spawn are tested; the new sound was measured from its bytes and never heard |
| ☑ | Component gallery route (`/dev/components`; harness step `components-gallery`) |

### Surfaces
Every row below was judged on the final capture of iteration 3 (584 captures, 281 audited
screens, gate PASS) and looked at in dark and light at 1440×900 and in dark at 1024×700 (the
run view also at 1024×640).

| | Surface | What was cleared (audit §), and what was looked at |
|---|---|---|
| ☑ | Run: header, tabs, actions | one row at every width, 24px back control, tab strip with key hints (3.1.3, 3.1.12, 3.5); a 100-character run id and name at 1024 |
| ☑ | Run: Build (transcript, ask cards, composer) | the ask is said once — no banner, and no `[failed: …]` line above the card that says it; the transcript is the body; answerable at 1024×640 with the drawer open or shut (3.1.2, 3.1.5, 3.1.6); steers (delivered and pending) and the steer composer on a live turn; a stacked run waiting on its dependency |
| ☑ | Run: ask cards | prose, question, ambiguous effect, no-reply (Retry, and routing parks with the way to the Graph tab), approval in the conversation (3.8), permission (the command, Allow / Deny), MCP elicitation, soft stop, gated acceptance with Waive; turn-timeout, no-progress, repair-stalled, stale-base, context-exhausted, stuck, harness-unauthenticated |
| ☑ | Run: Details drawer (inspector) | sans labels, values wrap and paths break at `/`, timeline rows open their step (3.2, 3.5) |
| ☑ | Run: Plan | one scroller around a 720px column (3.1.13) |
| ☑ | Run: Report | follows the theme; a frame around the self-contained page (3.4). The page inside the frame is `core/run-report.ts`'s and is not measured by the in-page audit (it is an iframe) |
| ☑ | Run: Steps + step detail | grid rows, fixed numeric columns, the detail replaces the list under 1100px and a step picked elsewhere lands on it (3.1.4, 3.1.7); a `parallel` group; two attempts of one visit as two rows; the Drift pane; an UNVERIFIED prompt |
| ☑ | Run: Context | a real list at 1024; what was given at launch reads "you, at launch" |
| ☑ | Run: Logs | summary column never 0px (3.1.1); the fetch-error state |
| ☑ | Run: Graph | 12px edge labels; the fork/join wires of a parallel step |
| ☑ | Runs list | rows, one sentence per row from `parkSummary`, every status including queued and failed-recoverable; the empty state |
| ☑ | Needs you | name, sentence, step, wait — one row each (3.1.8); the wait is a number, not "waiting …" 21 times; the empty state |
| ☑ | New run | with and without workspaces |
| ☑ | Graphs list and source editor | built-in and local graphs, a broken local graph, the tuning table |
| ☑ | Graph builder | canvas at 100% by default, 12–13px cards, ringed nodes (3.1.10, 3.1.11, 3.6); wires side to side on a left-to-right graph with captions off the cards; a parallel step is drawn and opened (it is not editable yet, by design) |
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
  not already name it. Graph boxes print the part of an id that tells steps apart
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
