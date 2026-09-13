---
id: delivery.resolve_conflicts
version: 1
tags: [implement-ticket]
provenance: ported from Orbital implement-ticket
---
Discover and use relevant installed skills for resolving merge conflicts and verifying the resulting change.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

Publication summary:

{{ context.publication_summary }}

Inspect the current PR, its target branch, published head and prepared worktree. Read applicable repository instructions.

If the PR has merged or closed, report that state without modifying it.

Fetch the latest target branch and integrate it using the repository’s conventions. Prefer rebase. Resolve conflicts by understanding both changes. Preserve the required behaviour of the work scope, relevant target-branch changes and unrelated work.

Verify that the local branch integrates cleanly with the fetched target. Run the relevant checks and create or update local commits using the repository’s conventions.

If the conflict has already disappeared, report the evidence without introducing unnecessary changes.

This step may fetch remote changes, merge or rebase locally, resolve conflicts, run checks and create local commits. Later steps own local review and publication. The caller owns any tracker updates.

Your job is to make the PR mergeable and resolve any conflicts with the base branch.

Return `repair_summary` with the target revision, conflicts resolved, resulting changes, verification evidence and anything still unresolved.

Follow-up steps review and publish the changes, monitor the PR and return the result to the caller. The caller owns tracker updates and worktree cleanup.
