---
id: graph.draft
version: 2
---
You are drafting a Howdah graph — a workflow of steps an operator will review in the builder and
save. You do not save anything and you change no files: your whole job is one draft, returned as
the output below. The operator asked for:

{{ context.intent }}

## What you can draw from

This is the catalog of what a drafted graph may use, read from this installation just now — the
node kinds, the field kinds, the command built-ins (with what each produces and reads), every
existing graph's spec with its prompt ids, the names already taken, and any graph that would not
load:

{{ context.graphs.catalog | dump }}

If the catalog has an `omitted` list, those graphs exist but their specs were left out to fit;
their names are still taken.

## Start from a graph when one is close

Most requests are "like X, but …". When one is, set `based_on` to that graph's name (it must be
one of the catalog's `graphs[].name`) and start from its spec: keep its steps, fields and routes,
and change only what the request asks for. If the request names a graph to start from, use that
one. Set `based_on` to null only when nothing in the catalog is close.

## The draft

Return `graph.draft` as an object with exactly these four keys:

- `spec` — a GraphSpec, shaped like the catalog's specs: `version` (1), `name`, `description`,
  `fields`, `inputs`, `entry`, `nodes`, `edges`.
- `prompts` — one entry per prompt id a step names: either the instructions written out as text,
  or `{ "copyOf": "<a prompt id from the catalog>" }` to reuse an existing prompt's instructions
  unchanged. Copy whenever a step does what an existing step already does; write text only for
  what is new. No entry that no step names.
- `based_on` — the catalog graph name you started from, or null.
- `notes` — two or three sentences for the reviewer: what you changed from the base and why.

Rules the draft is checked against — a draft that breaks one is refused and you will be asked to
fix it:

1. `name` is NEW: kebab-case, and not in the catalog's `takenNames`.
2. Every agent step's `prompt` is `<name>.<step id>` — a graph owns only the prompts filed under
   its own name, even when the body is a copy of another graph's prompt.
3. A step's `reads` are the context keys its instructions reference, written as a
   double-brace reference to `context.` followed by the field key, plus `acceptance` on any step
   with `requiresAcceptance: true` (the publish gate reads it, not the text). A step whose prompt
   is a copy keeps the base step's `reads` unchanged — they may include keys the text does not
   name. Never drop a read that a refusal did not name. Do not use `{{> … }}` includes in text
   you write; write the text out instead.
4. Every key a step reads or writes, and every launch input, is declared in `fields` with a kind
   from the catalog's `fieldKinds` and a scope (`sticky`, `cleared` or `per-visit`). Every key a
   step reads must be written on every path to it, or be a launch input.
5. A command step's `run` is EXACTLY one of the catalog's `commandBuiltins[].run`, with nothing
   after it, and its `writes` are only what that built-in produces. No shell commands.
6. No approval steps, no `runs:launch`, and no per-step `config`. `defaults` are the base's,
   unchanged — or absent when `based_on` is null.
7. A step that copies a read-only step's prompt is `readOnly: true` too. Make any new step that
   only needs to look `readOnly: true`.
8. Every step is reachable from `entry`, the entry is not a Finish (`terminal`) step, every
   non-terminal step has a way onward, and a step has at most one unconditional ("otherwise")
   edge. Conditions use the predicate vocabulary the catalog's specs use.

Do not use tools to save or write the graph. Reading files to understand a prompt you are
considering copying is fine.
