---
id: slice._design
version: 1
tags: [implement-slice, partial]
provenance: system-map 1c review — the approved-design block every slice repair prompt includes ({{> slice._design }}); a partial, never run on its own
---
## The approved design

The operator approved this ghost set before implementation. Every id is an identity key of the code-derived map; `expected_file` is where each entity lives. A repair must keep the code matching it: `add` / `modify` ghosts stay implemented, `keep` ghosts stay unchanged and where they are, `remove` ghosts stay gone.

{{ context.slice.ghosts }}

## Drift at the last check

The map is re-extracted after every repair and compared with the design, before anything is reviewed or published. The problem outcomes are `missing` (an add ghost, or a modify/keep ghost, not where the design puts it), `changed-unexpectedly` (a keep ghost that changed), `still-present` (a remove ghost still there) and `unchanged` (a modify ghost whose code did not change). `new_problems` are the problems the published code did not already have — a repair that causes one is routed back for revision. `not-checked` items could not be judged by the map; when the snapshot has uncommitted changes (`dirty`, stamp "… + uncommitted changes") nothing is `verified` until it is committed.

{{ context.slice.drift }}
