# DESIGN.md

The design system for Howdah's viewer. `web/public/tokens.css` holds the values; this file
holds the rules that decide them. When the two disagree, this file is wrong and should be
corrected — but a value that contradicts a rule here is a bug.

Decided 2026-09-15/16 (shaping.md T25), after the first system was rejected: it read as a
generic admin dashboard, its palette never reached the screen, it was too sparse for an
operator console, and its identity appeared only on the splash.

## The one rule

**Colour is the alarm, not a taxonomy.**

Howdah has exactly one event that justifies interrupting a human: an agent is waiting for you
(R3.3). Every ops dashboard spends its colour channel on categorisation — green done, blue
running, purple queued, everywhere, all the time — and in doing so burns the only signal that
matters. So:

- `--attention` (`#F2A93B`) is the only saturated colour in the system, and it means
  *an agent is waiting for you*. Nothing else may use it.
- `--status-done` is neutral grey **on purpose**. Done is the boring case.
- Failure gets a red because a failed attempt is genuinely a second thing a human must judge;
  running gets a quiet slate-cyan; everything else is greyscale.
- If a new state wants a colour, the answer is almost always no. Give it a glyph.

The test: open a run that needs nothing. If any saturated colour appears, the system is broken.

## Status is a shape before it is a colour

Every status renders as an inline SVG glyph — check, cross, alert triangle, half-circle —
and the glyph alone must be enough. Colour is the second channel, never the only one. This
keeps the UI legible under colour-blindness, in greyscale, and in a screenshot pasted into an
issue. Verified: amber and the failure red stay separable under deuteranopia (worst-pair ΔE
13.5 against a target of 8).

Never use emoji or dingbats (`✓`, `▲`) as status glyphs. They render differently per platform
and cannot be recoloured.

## Asking the operator something

A park is one card, and the card is the ask — not a label beside a text box. Whatever the run
is waiting on renders as itself: a question shows its header, its sentence, and every option
with the description the asking tool wrote, single- or multi-select exactly as declared, plus a
free-text box because "neither, do this instead" is a real answer (HOW-25). An ambiguous side
effect shows its two verdicts with their consequences spelled out, because they are not
symmetric. A prose park shows a reply box.

Three rules hold across all of them, and they are why the cards share one shell:

- **The park sits in the conversation**, at the foot of the transcript, where the operator is
  already reading. It is not a tab to go and find.
- **A refusal is shown verbatim.** A server that says which verb WOULD work has said something
  useful; collapsing it into "failed" throws that away.
- **One authored motion moment**, the needs-you entrance, and its mirror on the way out
  (sending → delivered → collapsing). Nothing else animates.

No new token was needed: the card reuses `--attention-border`, the type scale and the two
motion tokens. A question's header is the same uppercase micro-label the rail sections use,
so a question reads as part of the same system rather than as a new kind of surface.

## Chrome

Density comes from removing chrome, not from shrinking text.

- **Rows are rows.** No `background + border + radius` per row. A hairline (`--border`) and
  spacing separate them. The selected or waiting row is marked by an inset rule, not a box.
- Row height 26px in dense lists (steps, logs, context, prompts, runs).
- `--radius` is 8px, `--radius-sm` 6px, `--radius-xs` 4px, and `--radius-card` 12px for the
  composer and suggestion cards only (HOW-30, softened from 3px/2px). Soft corners on the boxes
  that exist; still no box per row.
- Panels are separated by a 1px `--border` and a change of ground, never by a shadow.

## Layout

- Left rail 184px: the mark, navigation, a pending count where one exists.
- Centre: the content, with its own header, the attention banner, and tabs.
- Right: either the run's facts (268px) or a detail panel for the selected thing (420–468px).
- The detail panel is **one component with a slot**, reused by Steps, Logs and Context. A
  second copy of it is a bug.

## Type

- **Instrument Sans** — UI and prose. It has real weights, so hierarchy comes from weight and
  size rather than from size alone. The previous display face shipped a single weight and
  explicitly renounced faux bold, which is the direct cause of "nothing leads" in the old UI.
- **JetBrains Mono** — anything machine-shaped: node ids, run ids, hashes, durations, costs,
  token counts, diffs, raw JSON. Tabular numerals on anything that changes in place.
- Both load from Google Fonts, one request, in `web/public/index.html`.
- General Sans was the first choice and is a valid substitute; it is not on Google Fonts, so
  it would need self-hosting. Instrument Sans is the shipped decision.

## Spacing

4px base. Dense lists use 26px rows with 10px gaps; sections breathe at 16/24px. Panel padding
is 14–18px. The instrument reads as a panel, not a poster.

## Motion

Unchanged from the approved brief and deliberately minimal.

- `--ease-out-strong: cubic-bezier(0.19, 1, 0.22, 1)`, durations 120/200/350ms.
- Exactly one authored moment: the needs-you entrance (card scale 0.98→1 with a fade, one
  amber pulse, then steady) plus the favicon trunk-raise and the chime.
- Ready for you (HOW-67): a finished, unsaved, undiscarded draft is listed under Needs you in
  a quiet tier — neutral glyph, muted count, no amber, no pulse, no chime, no favicon raise.
  Amber is reserved for a run that cannot proceed without you; a draft can wait.
- The load splash is silent, and belongs to an actual load, never to navigation.
- Everything else is a crossfade. `prefers-reduced-motion` keeps opacity and colour, drops
  travel — the tokens already collapse to 0ms.

## Identity

The one-line elephant with the amber eye is the mark, used in the rail and the favicon, whose
trunk-raise frames are the needs-you state. It was tested as a per-row status glyph and
**failed**: at 12px, done and needs-you were indistinguishable curls. Identity lives at mark
size; status lives in the glyph set.

## Reference

The approved screens — Steps, Thread, Logs, Context, Chat, drawn on real run data — are the
canvas at https://claude.ai/artifact/DGdpDEVNbPmUdxiwcCH641 (page 1). Page 2 keeps the three
direction sketches, with A+B marked as chosen.

Patterns were taken deliberately, from research recorded in shaping.md T24: Inngest's split
Steps layout, Laminar's transcript rows, Logfire's dense event list with a filter bar above,
and LangSmith's Polly for read-only chat. The Context view has no precedent in the tools
surveyed; it is ours.
