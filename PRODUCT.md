# Product

Howdah is a single-user harness that runs graphs of agent work — write a document, do
research, write and review code — against locally installed `claude` / `codex` CLIs, with a
feedback loop that proposes prompt revisions a human accepts or rejects. This file is the
product context design work reads first; `DESIGN.md` is the visual system built on it.

## Platform

A local web app (the viewer) served on `127.0.0.1` by `bun run web`, used in a desktop
browser on macOS. Not a phone app and not hosted. Supported window: 1024×640 and up.

## Stack

Bun, TypeScript, React 19, Tailwind 4, `@base-ui/react` primitives, `@xyflow/react` for the
graph canvas (the builder, and the read-only picture laid out by `@dagrejs/dagre`). Tokens in `web/public/tokens.css`; components in
`web/app/components/ui/`.

## Users

One operator: a software engineer running several agent runs at once, usually with the
viewer open beside an IDE and a terminal, glancing at it between other work. Fluent with
keyboards, command palettes and developer tools. They built or configured the graphs they run.

## Product purpose

Let one person supervise many long agent runs without watching them. The viewer answers
three questions, in this order: does anything need me, what is it asking, and what did it do.

## Operating context

- The operator is interrupted, not browsing. A visit is usually seconds long: read the ask,
  answer it, leave.
- Runs last minutes to days. Most of the time nothing needs attention.
- Content is long and machine-shaped: transcripts, tool output, JSON, diffs, paths, ids.
- It runs all day in a side window, in light or dark, often narrower than a full screen.

## Product principles

1. **One event justifies interrupting the operator: a run is waiting on them.** Everything
   else stays quiet.
2. **Say what is being asked, in the operator's words,** where they are already reading.
3. **Never present a guess as a fact, and never dead-end silently.** A refusal is shown
   verbatim; unknown stays unknown.
4. **The reading is the product.** The transcript, the ask and the evidence get the space;
   chrome gets what is left.
5. **Keyboard first.** Anything done many times a day has a key.

## Accessibility & inclusion

WCAG 2.2 AA is the floor, enforced by tests: 4.5:1 text contrast in both themes, 24px minimum
targets, a visible focus ring on every focus stop, full keyboard operation, no information
carried by colour alone (status is a shape first), reduced motion honoured, single-key
shortcuts that can be turned off, and no sound unless the operator asks for it.

## Brand commitments

The name is a howdah — the seat from which a mahout directs something much larger. The mark
is a one-line elephant. The tone is plain and exact: a tool that tells the truth about what
its agents did.
