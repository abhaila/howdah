Discover and use relevant installed skills for publishing pull requests and communicating the change.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

Inspect the prepared worktree, current branch and any associated pull request.

Push the intended local commits. Update the existing open PR, or create one against the repository’s intended target branch. Describe the complete change, its relationship to the work scope and the verification performed.

Use ticket references only when the work scope identifies an existing ticket.

For the PR, follow this structure:

Why: This should include business context usually available in linear ticket or from broader linear project context

What: The changes that are made and here write them in bullets with simple english with no references or quotes to specific bits of code

Notes for testing / reviewing: Anything in particular that we want to call out to help folks with reviewing or testing the work

Enable auto-merge if possible. Respect required checks, approvals and merge-queue rules.

If the associated PR is already merged and the branch contains follow up changes, open a new PR.

Confirm the PR URL from the remote. If publication or enabling auto-merge fails, inspect the current remote state before retrying. Preserve local work and avoid creating duplicate PRs.{{ context.internal.visits.delivery.publish }}

This step owns publication and the merge request. Leave implementation files and tracker records unchanged. Later steps handle PR feedback, CI and conflicts. The caller owns any tracker updates.

Return `publication_summary` with the PR URL, confirmed remote state, published commits and merge-request status.
