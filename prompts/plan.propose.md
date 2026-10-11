---
id: plan.propose
version: 2
tags: [plan-feature]
provenance: HOW-23 — the read-only proposer that decomposes one large feature into vertical slices; v2 names the base snapshot the map and the approval both bind to (HOW-31 B1)
---
Discover and use relevant installed skills for shaping and decomposing work.

You are decomposing one large feature into vertical slices. Each slice becomes ONE ticket and ONE independent run that opens ONE pull request. This step is READ-ONLY design work: do not create, edit or delete files, commits or branches. The worktree is fingerprinted — any change you make invalidates your own proposal.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

## The map around this feature

Everything below was extracted from the code of THIS repository by tree-sitter adapters (tier in [brackets]). It is bounded, and it is one repository: absence from it is NOT evidence that something does not exist, and a slice that belongs in another repository is planned from the brief rather than from the map. Read the code when you need more.

It was extracted from this exact snapshot, which your proposal binds to. If the worktree moves before the plan is approved, the approval is refused as stale and you are asked again — which is the whole reason this step touches nothing.

{{ context.map.base }}

{{ context.map.neighbourhood }}

## Operator feedback on the previous draft

A JSON array. `source: "comment"` items are pinned to one slice id of your previous plan (`entity_id`); `source: "redesign"` items are instructions for the whole decomposition. Address every item in this draft — change the slice it points at, or remove it — and never silently drop one. `[]` means this is a first draft.

{{ context.plan.feedback }}

## What to return: a slice plan

`plan.slices` is ONE JSON object:

```
{
  "feature": <one line: the whole feature>,
  "slices": [{
    "id": <kebab-case slug>,
    "title": <the ticket's title>,
    "workspace": <a registered workspace name — OMIT to build in this run's own>,
    "goal": <the user-visible outcome this slice delivers>,
    "work": <the ticket body: scope, acceptance criteria, the modules and files to touch>,
    "verify": <how a human confirms it works>,
    "depends_on": [<slice id>, ...]
  }],
  "out_of_scope": [<what this feature deliberately does not cover>],
  "risks": [<what could go wrong across the slices>]
}
```

No other fields. Rules the plan is checked against before anyone sees it — a plan that breaks one is refused and handed back to you with the reason:

- **At most 8 slices.** Every slice is launched at once, so the plan is both a review and a bill. If the feature needs more, propose a smaller FIRST TRANCHE that stands on its own and say in `out_of_scope` what is being left for the next round.
- **`id` is a slug**: lower-case letters, digits and hyphens, starting with a letter or digit, at most 41 characters, unique in the plan. It becomes part of the run id and the git branch of the run that builds the slice, so it is identity — `title` is the label.
- **`title`, `goal`, `work` and `verify` are required** and must be non-empty.
- **`workspace` must be a registered workspace**, or omitted. Omit it whenever the slice belongs in the repository this run is looking at; name one only for a slice that belongs in a different registered repository. A workspace that is not registered is refused, because no run could be launched in it.
- **`depends_on` names slice ids from THIS plan**, and the dependencies must not form a cycle. It is ORDERING ONLY: dependent slices are launched too, at the same time, and the dependency is recorded in the ticket body as prose for the human and the agent who build them.

### What makes a good slice

- **Independently shippable.** A slice must be mergeable on its own without breaking the build or the product, even if no other slice in this plan ever lands. If a slice only makes sense once another has merged, either fold them together or make the first one land behind a flag / a default that keeps the current behaviour.
- **Independently reviewable.** One reviewer, one sitting, one PR. If `work` needs more than a screen of acceptance criteria, the slice is too big.
- **Vertical, not horizontal.** Prefer "the whole path for one narrow case" (UI → route → handler → store, for one field) over "all the migrations", then "all the handlers". A horizontal slice cannot be verified by a human and cannot be shipped alone.
- **`work` is the ticket someone else will build from.** Name the modules, files and boundaries to touch, the acceptance criteria, and what NOT to change. The agent that picks it up will not see this plan — only that slice's ticket.
- **`verify` is a human action**, not a test name: what to click, curl or read to believe it works.
- **Say what is out of scope.** The feature's edges are as much a decision as its slices, and `out_of_scope` is where the operator checks you understood the brief.

Return the slice plan as `plan.slices` (a JSON object, not a string).
