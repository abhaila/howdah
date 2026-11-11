# Design overhaul (HOW-68): the plan and the loop

Status: **proposal, waiting on three decisions** (see "Open decisions"). Nothing in `DESIGN.md`
or `tokens.css` changes until they are answered; `DESIGN.md` is then rewritten from this file
and wins over it.

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
- **Colour:** neutral ground, amber for waiting-on-you only, one red for failure, one quiet
  teal for running and focus. Light and dark are equals. Every text token clears 4.5:1.
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

## Open decisions

1. **Typeface:** Atkinson Hyperlegible Next + Mono (recommended) or IBM Plex Sans + Mono.
2. **Details as a drawer** (recommended): closed below 1280px, toggled with ⌘I, closed with Esc.
3. **Asks rewritten for people** (recommended): a short summary per park kind, the engine's
   message one click away. Touches copy for about twenty park kinds.

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
| Anywhere | ⌘K palette · `?` shortcuts · `G` then `R` `N` `G` `P` `S` go to a screen · `C` new run · `[` sidebar |
| Lists | `J` `K` or arrows · Enter open · `/` filter |
| A run | `1`–`7` tabs · ⌘I details · `R` reply · `A` jump to the ask · `E` expand tool calls · `O` open in IDE |
| Layers | Esc closes the topmost |

Single-key shortcuts are ignored while a text field has focus and can be turned off in
Settings (WCAG 2.1.4).

## Phases

**0. Audit** — done. 351 captures, inventory, defect list.

**1. Agree the vision** — the artifact above. Blocked on the three open decisions.

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

**4. Close-out:** delete dead CSS, update `CLAUDE.md`'s web section, final full capture.

## The loop

For each checklist row: **implement → capture → check → record**.

```bash
export HOWDAH_VISUAL_OUT=/tmp/howdah-visual
bash tools/visual/serve.sh stop
bun tools/visual/seed.ts                  # demo home: 28 runs across every status (~10s)
bash tools/visual/serve.sh                # viewer on :4799, served from a private repo copy
node tools/visual/shoot.mjs <substring>   # captures + in-page audits for matching screens
bun test web/app && bun node_modules/typescript/lib/tsc.js --noEmit
```

A row passes when all of these hold:
- every minimum standard's check is green for that surface;
- the capture has been looked at in both themes at 1440×900 and at 1024×700;
- it matches `DESIGN.md` (tokens only, primitives only, no new one-off CSS);
- the affected tests pass.

A row that fails goes round again. The loop ends when every row passes in one full capture.

## Checklist

Status: ☐ not started · ◐ in progress · ☑ passes.

### Foundations
| | Item |
|---|---|
| ☑ | Sound: off by default, setting honoured, only for news (viewer and OS) |
| ☐ | `PRODUCT.md`, `DESIGN.md` |
| ☐ | Tokens, type scale, bundled fonts, contrast test |
| ☐ | Primitives: Menu, Popover, CommandPalette, Drawer, Kbd, Truncate, Toolbar, KeyValue, ScrollPane |
| ☐ | Existing primitives: targets ≥24px, focus ring everywhere, states complete |
| ☐ | Shell: rail, palette, shortcuts, `?` sheet, 404 |
| ☐ | Scroll contract |
| ☐ | Native notifications |
| ☐ | Component gallery route |

### Surfaces
| | Surface | Known defects to clear (audit §) |
|---|---|---|
| ☐ | Run: header, tabs, actions | wrapped actions row, 13px back arrow, clipped tab strip (3.1.3, 3.1.12, 3.5) |
| ☐ | Run: Build (transcript, ask cards, composer) | banner duplicates card, 240px transcript, unreachable at 1024 (3.1.2, 3.1.5, 3.1.6) |
| ☐ | Run: ask cards (prose, question, effect, no-reply, approval) | approval hidden under Steps (3.8) |
| ☐ | Run: Details drawer (inspector) | mono everywhere, truncated timeline, 17px toggle under the resizer (3.2, 3.5) |
| ☐ | Run: Plan | unused bottom band (3.1.13) |
| ☐ | Run: Report | fixed beige all-mono page in both themes (3.4) |
| ☐ | Run: Steps + step detail | clipped duration column, 8px list at 1024, 23px scope toggle (3.1.4, 3.1.7) |
| ☐ | Run: Context | 8px list at 1024 |
| ☐ | Run: Logs | 0px summary column (3.1.1) |
| ☐ | Run: Graph | 9px edge labels |
| ☐ | Runs list | tinted rows, three type styles per row, no reason shown |
| ☐ | Needs you | overlapping rows, id crowds out the reason (3.1.8) |
| ☐ | New run | |
| ☐ | Graphs list and source editor | |
| ☐ | Graph builder | 106px canvas at 1024, 5px card text, focus-less nodes (3.1.10, 3.1.11, 3.6) |
| ☐ | Prompts and prompt detail | |
| ☐ | Proposals | unexplained 502 in the console |
| ☐ | Draft review | |
| ☐ | Settings | paths overflow the card, names cut to "acm…" (3.1.9) |
| ☐ | Dialogs, toasts, tooltips | |
| ☐ | Empty, loading, error and unknown-id states | skeleton flush to the rail, no 404 (3.1.14) |

States the seed does not produce yet, to add before their surfaces are judged: a `parallel`
step, steer and soft-stop events, the Drift pane, a stacked run in `runs:await`, a gated
acceptance park, permission asks, and the `mcp-elicitation`, `turn-timeout`, `no-progress`
and `repair-stalled` parks.
