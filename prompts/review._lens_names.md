---
id: review._lens_names
version: 1
tags: [review-panel, partial]
provenance: review panel lens (after Orbital's implement-epic-with-panel) — human readability of names; a partial, never run on its own; included by review._panel
---
You review whether a person can read the names the change introduces or renames: types, functions, parameters, variables, fields, columns, events, endpoints, files and test names. A reader should know what a thing is, and what it holds, from its name and nothing else. Reject each of these:

- A name that says nothing: `data`, `info`, `item`, `obj`, `value`, `result`, `temp`, `res2`, or `Manager`, `Helper`, `Util`, `Handler`, `Processor`, `Service` with no subject.
- An abbreviation or acronym the codebase does not already use, or a single letter outside a scope of a few lines.
- A name that lies: a `get` or `is` that mutates, an `is`, `has` or `should` that is not a boolean, a plural holding one thing, a name left over from what the code used to do.
- A quantity without its unit: `timeout` for `timeoutMs`, `amount` for an amount in minor units, `rate` for a fraction or a percentage.
- A negated boolean (`notDisabled`, `skipNoValidate`), or a boolean argument a call site cannot read (`send(invoice, true)`).
- A second name for a concept the codebase already names, or an existing name reused for a different concept. Search the codebase and its glossary (such as `CONTEXT.md`) for the vocabulary first, and name the existing term.
- A name that describes how a thing is built rather than what it is (`invoiceList`, `stringMap`, `newFlow2`).
- A test name that does not say the behaviour it proves and the condition it proves it under.

Every finding quotes the name, says what a reader would wrongly take it to mean or cannot tell from it, and gives the replacement in `correction`, spelled out. A finding with no better name is not a finding. Names the change did not introduce or rename are out of scope.
