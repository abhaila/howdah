# DESIGN.md

The design system for Howdah's viewer. `web/public/tokens.css` holds the values; this file
holds the rules that decide them. A value that contradicts a rule here is a bug.

Decided 2026-11-12 (HOW-68), replacing the T25 system. That system had the right central rule
and lost it in execution: the ask was shouted three times, two typefaces alternated inside
every row across ten sizes, the part the operator came to read got the smallest box, and at
1024px wide a parked run could not be answered at all. The audit behind every number here is
`docs/designs/design-overhaul-audit.md`; `PRODUCT.md` says who this is for.

## The five rules

1. **The alarm is said once.** Amber marks the single place the operator acts.
2. **One scroller per pane.** Every region either fits or scrolls, down to 1024×640.
3. **One voice.** One sans for everything read; mono only for what you would paste.
4. **Keyboard first.** Every action has a key, printed beside it; `?` lists them all.
5. **Nothing is cut without a way to read it.** Wrap where there is room; otherwise the full
   value shows on hover and on focus.

## Colour

Indigo: blue-tinted neutrals and one accent.

- **Amber (`--attention`) means a run is waiting on you. Nothing else may use it.** It
  appears as a status glyph, the nav count, and the one ask card. It is never a row tint, a
  banner that repeats the card, or a decorative highlight. Test: open a run that needs
  nothing; if amber appears, the screen is wrong.
- **Indigo (`--primary`) is what you press and where you are:** the primary button, the
  selected tab's rule, the focus ring, a running step's glyph, links. One primary button per
  view. It is a cool hue on purpose, so it cannot be read as the alarm.
- **Red (`--status-failed-*`)** is a failed attempt or a destructive action.
- Everything else is neutral. `--status-done` has no hue: done is the boring case.
- Light and dark are equals. Every colour is one `light-dark()` pair in `tokens.css`, and
  `web/app/tokens.test.ts` proves each text token clears 4.5:1 on each ground in both.
- Three grounds: `--bg` (the page), `--bg-raised` (a held object: card, input, menu, selected
  row), `--bg-inset` (the rail, code, wells). A hex appears only in `tokens.css`.

## Status is a shape before it is a colour

Every status is an inline SVG glyph — triangle waiting on you, half-disc running, ring
waiting on something else, cross failed, check done — and the glyph alone must be enough.
Colour is the second channel. Never emoji or dingbats.

## Type

- **DM Sans** for everything read: headings, names, prose, labels, buttons, tables.
- **DM Mono** only for what you would paste or match exactly: run and node ids, paths,
  branches, commands, hashes, code, diffs, raw JSON. A label is never mono. A number that is
  read (a duration, a cost, a count) is sans with `tabular-nums`.
- Six sizes: 12 timestamps and ids · 13 controls and rows · 14 body and transcript prose ·
  16 run name and screen heading · 20 section heading · 28 page title. **Nothing below 12.**
- Three weights: 400, 500 for names and selected things, 600 for headings and the primary
  action. Hierarchy comes from weight and these steps, not from uppercase or letter-spacing:
  **no uppercase micro-labels.** A section label is 12px/600 in `--fg-muted`.
- Prose measure 65–75ch (the transcript column is 720px). Line height 1.5 for prose, 1.4 in
  rows.
- Fonts are bundled in `web/public/fonts/`. Nothing is fetched from another origin.

## Layout and scrolling

- **Shell:** a rail on the left (176px, collapsible to icons) and `main`. The shell is the
  viewport: `height: 100dvh`, and it never scrolls.
- **A screen is a column: header (fixed) → body (scrolls).** Exactly one element in each pane
  has `overflow-y: auto`, and it is the pane's body. `overflow: hidden` is for clipping
  corners, never for layout: a layout rule that hides overflow hides content.
- Split views (list + detail) give each side its own scroller and a minimum width; below
  1100px the detail replaces the list instead of squeezing it.
- **A run:** header (back, name, status, actions) · tabs · body. The transcript is the body
  and gets all remaining height. **Details is a drawer** on the right (320px): closed by
  default below 1280px, toggled with `⌘I`, closed with `Esc`, remembered.
- Secondary actions go behind one **More** menu. A header is one row at every supported width.
- Supported: 1024×640 and up. Below 1100px the rail collapses to icons by itself.

## Chrome

Density comes from removing chrome, not from shrinking text.

- **Rows are rows.** A hairline and spacing separate them; no box per row. Row height 36px in
  lists you act on, 28px in dense read-only lists (logs, context).
- The selected row is `--bg-raised` with a 1px `--border-strong` outline. Never a coloured
  side stripe: no `border-left` wider than 1px anywhere.
- Radius: 8 controls and cards, 6 small controls and rows, 4 chips, 12 the composer only.
- Panels are separated by a 1px `--border` and a change of ground, not by a shadow. Only
  things that float (menu, popover, tooltip, toast, dialog, palette) cast a shadow.
- No nested cards.

## Asking the operator something

A park is one card, and the card is the ask.

- **It sits in the conversation**, at the foot of the transcript, once. The run header
  carries one line of status ("Waiting on you · 2h 53m") that scrolls the card into view. No
  banner repeats the card.
- **It is written for a person:** a one-sentence summary derived from the park's kind, then
  the items in question, then the actions. The engine's own message is unchanged and one
  click away ("Full message").
- **Whatever the run is waiting on renders as itself:** a question shows its options, an
  ambiguous effect shows its two verdicts with their consequences, an approval shows what is
  being approved, a prose park shows a reply box.
- **A refusal is shown verbatim.**
- It keeps `id="needs-input"`, and the sending → delivered → collapsing moment.

## Components

One layer, on `@base-ui/react`, in `web/app/components/ui/`. Appearance lives in primitives;
`howdah.css` holds layout only. Every interactive element goes through a primitive.

- Every control has: default, hover, focus-visible, active, disabled, and loading where it
  can wait.
- **Targets:** 24px minimum, 32px for primary controls. A small glyph gets its hit area from
  padding, not from a bigger glyph.
- **Focus:** a 2px `--ring` outline, 2px offset, on everything focusable, including canvas
  nodes and splitters.
- **Truncate** is the only way to ellipsize. It exposes the full value in a tooltip on hover
  and on focus. Raw `text-overflow: ellipsis` in CSS is a test failure.
- **Kbd** prints a key. A control with a shortcut shows it.
- **Menu, Popover, Tooltip** open from their trigger. **Dialog** is for an interruption that
  must be answered; a detail view is a panel or the drawer, not a modal.
- `Select`, `Dialog` and `Checkbox` stay on the platform elements (see `CLAUDE.md`).
- Empty states say what will appear and how to make the first one. Loading is a skeleton in
  the shape of the content.

## Keyboard

| Scope | Keys |
|---|---|
| Anywhere | `⌘K` command palette · `?` shortcuts · `G` then `R` `N` `G` `P` `S` go to a screen · `C` new run · `[` rail |
| Lists | `J` `K` or arrows move · `Enter` open · `/` filter |
| A run | `1`–`7` tabs · `⌘I` details · `R` reply · `A` jump to the ask · `E` expand tool calls · `O` open in IDE |
| Layers | `Esc` closes the topmost: menu, dialog, detail panel, drawer |

Single-key shortcuts are ignored while a text field has focus and can be turned off in
Settings (WCAG 2.1.4). `lib/shortcuts.ts` is the one registry; the `?` sheet and the palette
are rendered from it, so a shortcut cannot exist without being listed.

## Motion

From the animations.dev course. Motion states a change; it never decorates.

- **Nothing keyboard-triggered animates. Nothing seen dozens of times a day animates:** tab
  switches, list selection, the palette, the drawer on `⌘I`. Selection is instant.
- Press: `scale(0.97)`, 120ms. Hover: colour only, `ease`, 120ms. No hover lift or scale.
- Menus, popovers and tooltips enter from `scale(0.97)` + opacity at their trigger
  (`transform-origin: var(--transform-origin)`), 150ms on `--ease-out-strong`; exits are
  shorter and plain.
- Dialogs and toasts: 180ms, opacity plus 6px of travel. Never from `scale(0)`. Never
  `ease-in`.
- **One authored moment:** the ask card arriving (opacity, 6px rise, `scale(0.985)` → 1,
  320ms). It plays once per ask, never on navigation.
- No looping animation except a spinner on something actually loading. No pulse. No splash.
- Only `transform` and `opacity` animate. `prefers-reduced-motion` keeps fades and drops
  travel.

## Notifications and sound

- The viewer posts a real browser notification for a run that newly starts waiting: its name,
  what it is asking, and a click that opens it. Permission is asked from Settings, never on
  load.
- The OS path (`engine/attention.ts`) exists for when no viewer is open.
- Sound is off by default, one setting governs every sound, and it plays only for news.

## Identity

The one-line elephant is the mark, in the rail and the favicon, whose trunk-raise frames are
the needs-you state. Identity lives at mark size; status lives in the glyph set.

## Do not

- Amber for anything but waiting-on-you; a second accent hue; gradients; glass.
- A coloured side stripe; a box per row; a card inside a card; a shadow on a panel.
- Uppercase labels; text under 12px; mono for labels or prose.
- `overflow: hidden` as layout; an ellipsis without `Truncate`.
- A control under 24px; a focus stop with no ring; a `title=` as a tooltip.
- A modal for something that is not an interruption.
- Motion on a keyboard action; a looping pulse; `ease-in`; `scale(0)`.
