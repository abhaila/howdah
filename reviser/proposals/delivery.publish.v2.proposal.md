---
id: delivery.publish
base_version: 1
proposed_version: 2
status: accepted
accepted_at: 2026-09-13T06:55:56Z
created: 2026-09-13T06:52:33.098Z
---
Discover and use relevant installed skills for publishing pull requests and communicating the change.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

Inspect the prepared worktree, current branch and any associated pull request.

Push the intended local commits. Update the existing open PR, or create one against the repository's intended target branch.

Write the PR description in the team structure, using exactly these three sections in this order. Apply the structure whether creating a new PR or updating an existing one; rewrite an existing description that does not follow it.

- `## Why` — the business context: the problem being solved, who it affects and why it matters now. When the work scope identifies an existing Linear ticket, read that ticket and, where useful, the broader Linear project it belongs to, and draw the context from there. Otherwise derive it from the user supplied goal and work scope. State how the change relates to the work scope.
- `## What` — the changes as bullets in simple English, written for a reader who has not seen the diff. Describe behaviour and outcomes. Do not reference or quote specific bits of code: no file names, class, function or variable names, identifiers, or code snippets.
- `## Notes for testing / reviewing` — anything that helps people review or test the work: the verification performed, how to exercise the change, areas that deserve close attention, known limitations, deliberate omissions and follow-ups.

Reading the Linear ticket or project for context is permitted; do not modify tracker records.

Use ticket references only when the work scope identifies an existing ticket.

Enable auto-merge if possible. Respect required checks, approvals and merge-queue rules.

If the associated PR is already merged and the branch contains follow up changes, open a new PR.

Confirm the PR URL from the remote. If publication or enabling auto-merge fails, inspect the current remote state before retrying. Preserve local work and avoid creating duplicate PRs.

This step owns publication and the merge request. Leave implementation files and tracker records unchanged. Later steps handle PR feedback, CI and conflicts. The caller owns any tracker updates.

Return `publication_summary` with the PR URL, confirmed remote state, published commits and merge-request status.