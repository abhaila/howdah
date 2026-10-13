---
id: plan.tickets
version: 2
tags: [plan-feature]
provenance: HOW-23 — raise one ticket per approved slice, through the tracker's own workflow; v2 records depends_on with its until, now enforced (HOW-57)
---
Discover and use relevant installed skills for creating and organising tickets.

The operator has APPROVED the slice plan below. Raise one ticket per slice, so that each slice can be picked up as an independent piece of work with its own pull request.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

## The approved plan

{{ context.plan.slices }}

## The approval

{{ context.plan.approval }}

## What to do

Create one ticket per slice in the approved plan, using the tracker's own workflow — the same tracker the work scope above came from, in the same team and project unless the scope says otherwise.

For each slice:

- **Title**: the slice's `title`.
- **Body**: the slice's `work`, then how a human verifies it (`verify`), then the slice's place in the feature — name the feature and, when `depends_on` is non-empty, say which other slices it waits for, how far each must get (its `until`: published, merged or package) and that each of them has its own ticket. The run that builds the slice enforces `depends_on` itself — it waits before it starts — so the ticket records it for the people who review it.
- Leave the ticket in the tracker's normal starting state. Do not assign, estimate or schedule it unless the work scope asks for that.

**Do not create a duplicate.** Search the project for an existing ticket with the same title before creating one. If a slice already has a ticket — because this step ran before, or because the operator raised it by hand — REUSE it: return its identifier and url, and update its body only if it does not yet describe the approved slice. Creating a second ticket for one slice is worse than creating none, because the next step launches a run against every ticket it is given.

Raise ONLY the tickets for the approved slices. Leave parent, sibling and unrelated tickets unchanged, and leave repository files, commits, branches and pull requests unchanged — this step touches the tracker and nothing else.

If the tracker cannot be reached, or you have no way to create a ticket in it, stop and say so rather than inventing an identifier: an identifier that does not exist becomes a run against a ticket nobody can read.

Return `tickets` as ONE JSON object, with exactly one entry per slice in the approved plan:

```
{
  "tickets": [{
    "slice_id": <the slice's id, exactly as the plan has it>,
    "identifier": <the tracker's identifier, e.g. "HOW-31">,
    "url": <the ticket's url>,
    "title": <the ticket's title>
  }]
}
```

Every slice id must appear exactly once, and every entry must name a slice from the approved plan. The next step launches one run per entry, and it refuses to launch anything at all unless the two sides match.
