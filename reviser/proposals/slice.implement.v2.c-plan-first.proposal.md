---
id: slice.implement
base_version: 1
proposed_version: 2
status: rejected
rejected_at: 2026-10-14T06:18:45.745Z
rejection_reason: HOW-44: variant B (verify-aware) was accepted for slice.implement instead; this variant was not chosen
created: 2026-10-12T00:00:00.000Z
fork: true
experiment: HOW-44 variant C (plan-first)
---
Discover and use relevant installed skills for implementation and verification.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

## The approved design

The operator approved this ghost set (the approval is bound to its hash and the snapshot it was drawn on):

{{ context.slice.approval }}

Ghost set — every id is an identity key of the code-derived map; `expected_file` is where each entity must end up:

{{ context.slice.ghosts }}

Build exactly this design:

- `add` ghosts must exist afterwards, in their `expected_file`, under exactly their key (route path and method, function name and declared parameter types, fetch method and path).
- `modify` ghosts must change; `remove` ghosts must be gone; `keep` ghosts must stay byte-for-byte as they are.
- Do not change code the design does not name unless the change is required to make the named change compile and pass its checks — and say so in the summary.
- If the design is wrong or impossible, do not quietly build something else: implement what you can, and explain the conflict in the summary so the operator can redesign.

## Drift from the previous attempt

After every implementation the map is re-extracted and compared with the design. `[]` means this is the first attempt. Otherwise, fix every problem item — `missing` (not where the design puts it), `changed-unexpectedly` (a keep ghost you changed), `still-present` (a remove ghost still there) and `unchanged` (a modify ghost whose code you did not change); `not-checked` items could not be judged by the map (say why in your summary if you know). Drift verifies COMMITTED code only: a snapshot with uncommitted changes verifies nothing, so commit your work.

{{ context.slice.drift }}

## Review findings from the previous attempt

`null` on the first attempt:

{{ context.review_findings }}

{{> implementation._plan_first }}

Implement the change in the prepared worktree. Follow applicable repository instructions and preserve unrelated work. Run the relevant checks. Record what each check establishes and any failures or verification gaps. Create or update local commits using the repository's conventions.

This step may change repository files, run checks and create local commits. Later steps own publication. The caller owns any tracker updates.

Return `implementation_summary` with the changes (by ghost id), verification evidence, deviations from the design and any unmet requirements.
