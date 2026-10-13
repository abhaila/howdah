---
id: review._verify_result
version: 1
tags: [implement-ticket, implement-slice, partial]
provenance: HOW-40 — the behavioural-evidence block every implementation reviewer includes ({{> review._verify_result }}); moved verbatim out of slice.local_review v2, plus the not-checked reading; a partial, never run on its own
---
## Behaviour: the workspace's tests, run against this code

Deterministic — `verify.run` ran the workspace's configured test command in the worktree after the implementation, not an agent. It is the only evidence in this review that the code runs. `outcome` is `pass` (exit 0), `fail` (non-zero exit or `timed_out`), or `not-checked` (nothing was run — `reason` says why). `commit` names what it ran against; `dirty` means uncommitted changes were on top of it. `output_tail` is the end of the output; `facts` is the command's final JSON line, when it printed one.

{{ context.verify.result }}

How to read it:

- A `fail` verify outcome is a blocking finding: reject, quoting the failing tests from `output_tail` as the evidence, unless you have verified in the code that every failure predates this change and is outside the work scope — then say so in the finding rather than passing silently.
- A `not-checked` verify outcome is never a pass: the code was not run, so any claim in the summary that tests pass is unverified. Say so explicitly in your findings or summary, with its `reason`, and judge the behaviour by reading the code and its tests. Do not reject for it alone.
- A `pass` verify outcome on a `commit` other than the one under review, or `dirty`, verifies only what it ran against: note it.
