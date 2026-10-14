---
id: review._panel
version: 1
tags: [review-panel, partial]
provenance: the parallel review panel, after Orbital's implement-epic-with-panel (review fan-out → fan-in → triage). Howdah's engine has no fan-out node (shaping.md defers it), so the fan-out happens inside one read-only turn: one subagent per lens, all started at once, then a triage that is the only judge of what survives. A partial, never run on its own
---
## The review panel

Seven specialist reviewers read this change in parallel, each for one class of defect. You run the panel, then you triage what it finds. The reviewers find; only you decide.

### 1. Fix what the panel reviews

Before you start any reviewer, establish the change under review: the branch's base (the merge base with the branch it will merge into, normally `origin/<default branch>`), the base commit's sha, and the list of changed files including uncommitted and untracked ones. Every reviewer judges the same diff, `<base sha>` to the working tree, and nothing else.

### 2. Start every reviewer at once

Start one subagent per lens below, ALL IN ONE MESSAGE so they run in parallel, with the `general-purpose` agent type. Give each one a prompt made of:

- the lens section below, copied verbatim, under its heading;
- the work scope, copied verbatim;
- the base sha and the changed files from step 1;
- this instruction: "This review is read-only. Do not edit, create or delete files, commits, branches, pull requests or tracker records, and do not run the test suite. Inspect the complete diff from the base sha to the working tree, including uncommitted and untracked files, and read the code around it. Only lines this change adds or alters are in scope; a defect the change only makes reachable counts, with `origin` `introduced`. End with your findings as a JSON array of objects with `lens`, `class`, `file`, `line`, `defect`, `failure`, `correction` and `origin` (`introduced` or `existing`), or an empty array."

Do not paraphrase a lens or summarise the work scope for a reviewer: it judges against the text it is given. Do not review the diff yourself while they run.

If you cannot start subagents, apply each lens yourself, one after another, in a fresh read of the diff per lens, and say in your findings that the panel ran in sequence.

### 3. Triage: the only judge of what survives

When every reviewer has returned, take each finding and check it against the code in the worktree yourself. A reviewer's confidence is not evidence.

- Keep a finding only if the failure it describes can happen, or the code breaks the rule it cites. Re-derive the failure; for a money finding, redo the arithmetic.
- Merge findings that describe the same defect, even across lenses, and keep the clearest failure and correction.
- Drop anything outside the work scope, anything that is only a preference, and anything the code already handles.
- A finding with `origin` `existing`, or whose correction needs code the change does not touch, is not blocking: report it as a follow-up for the operator, not as a reason to reject.
- A reviewer that returned nothing usable, or failed, is a gap: name the lens in your findings. A lens that did not run is never a pass.

The findings that survive triage, with their `lens`, are what your verdict below is built from. A surviving `introduced` finding is a defect in this change.

### The lenses

#### Lens: money

{{> review._lens_money }}

#### Lens: names

{{> review._lens_names }}

#### Lens: simplicity

{{> review._lens_simplicity }}

#### Lens: tests

{{> review._lens_tests }}

#### Lens: lifecycle

{{> review._lens_lifecycle }}

#### Lens: integrations

{{> review._lens_integrations }}

#### Lens: standards

{{> review._lens_standards }}
