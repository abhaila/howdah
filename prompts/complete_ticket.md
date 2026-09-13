---
id: complete_ticket
version: 1
tags: [implement-ticket]
provenance: ported from Orbital implement-ticket
---
Discover and use relevant installed skills for completing tickets and communicating delivery results.

User supplied goal:

{{ inputs.goal }}

Ticket:

{{ context.work }}

Publication summary:

{{ context.publication_summary }}

Confirm from the remote that the PR delivering this work has merged. Verify that the merged change satisfies the ticket and goal. Identify any ticket-related changes that remain unpublished before marking the work complete.

Mark the supplied ticket done using its tracker’s workflow.

If the ticket is already complete, verify the recorded delivery evidence and avoid duplicate updates. Leave parent, sibling and unrelated tickets unchanged.

This step may update the supplied ticket's completion record. Leave repository files, commits, branches and pull requests unchanged.

Return `completion_summary` with the ticket’s confirmed status, merged PR link and delivery evidence.

A follow-up step cleans up the worktree.
