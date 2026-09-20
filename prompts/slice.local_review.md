---
id: slice.local_review
version: 1
tags: [implement-slice]
provenance: system-map 1c — implementation.local_review, judged against the approved ghost set and its drift
---
Discover and use relevant installed skills for code review and communicating findings.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

## The approved design

{{ context.slice.ghosts }}

## Drift: the design vs the code, computed from the map

Deterministic — computed by re-extracting the map after the implementation, not by an agent. Outcomes: `verified` (the code matches the ghost), `missing` (an add ghost provably not in its expected file, or a modify/keep ghost that is gone), `unchanged` (a modify ghost whose code did not change), `changed-unexpectedly` (a keep ghost that changed), `still-present` (a remove ghost still there), `unexpected` (a change the design does not name), `partial` (a trace only partly observed), `not-checked` (the map could not judge — never evidence either way). `stamp` names the snapshot every `verified` refers to; a `dirty` snapshot ("… + uncommitted changes") verifies nothing, because nothing uncommitted can be published as verified.

{{ context.slice.drift }}

## Implementation summary

{{ context.implementation_summary }}

Review the current change against the approved design, the work scope, goal and applicable repository instructions. Inspect the complete branch diff against its target, including uncommitted changes, affected code and relevant tests.

- Reject every `missing`, `changed-unexpectedly`, `still-present` and `unchanged` drift item unless the summary gives a concrete reason the map is wrong about it and you have verified that reason in the code.
- A `dirty` drift means the implementation is not committed: reject until it is.
- Treat `unexpected` items as scope questions: reject changes outside the work scope; accept ones required to make the design compile and pass its checks.
- `not-checked` items are gaps in the map, not defects: check those parts of the design by reading the code.

Review only requirements and defects that can be verified through automated checks or code inspection. Reject unmet requirements, correctness or security defects, violations of mandatory repository rules and missing verification of required behaviour. Treat preferences as non-blocking unless repository instructions require them. Human reviews, manual acceptance and visual approval are non-blocking.

Compare each finding with previous reviews. If the same finding returns without new evidence or a materially different correction, the review is looping: do not reject again for it; report it as unresolved.

This step is read-only. Leave files, commits, branches, pull requests and tracker records unchanged.

Return `review_verdict` as `reject` only when actionable, machine-checkable blocking findings remain; otherwise `pass`. Return `review_findings` as an array of blocking findings, each with `requirement` (a ghost id or requirement), `evidence` and `correction` — an empty array when the review passes.
