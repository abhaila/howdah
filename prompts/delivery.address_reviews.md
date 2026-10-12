---
id: delivery.address_reviews
version: 2
tags: [implement-ticket]
provenance: ported from Orbital implement-ticket
---
Discover and use relevant installed skills for addressing pull request feedback, verification and communicating with reviewers.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

Publication summary:

{{ context.publication_summary }}

Previous delivery review verdict:

{{ context.review_verdict }}

Previous delivery review findings:

{{ context.review_findings | dump }}

Inspect the current PR, its published head, review decisions and unresolved threads. Read the affected code and applicable repository instructions.

If the publication summary lists more than one PR, the change was published as a stack: inspect the review decisions and unresolved threads on every PR in it, and address each one that has feedback. Work through the stack from its base upward, since a correction in a lower branch must be carried up through every branch built on it using the repository’s conventions. Wherever this step says “the PR”, apply it to each PR in the stack.

Address feedback within the work scope and goal. Make the required local changes, verify them and create or update local commits using the repository’s conventions. Preserve unrelated work.

If the previous delivery review verdict is `reject`, treat every previous review finding as still blocking unless you verify it is already corrected in the current published head. Do not return a no-op or thread-only summary while any previous finding remains unaddressed. Repair those findings, reply only with evidence, and keep unresolved blockers visible in `repair_summary`.

For feedback already satisfied by the published change, reply with supporting evidence and resolve the thread. For feedback requiring a new local change, keep the thread unresolved until that correction is published and verified. Check existing replies before posting to avoid duplicates.

Explain with evidence when a requested change is unnecessary or outside scope.

If the PR has merged or closed, report that state without modifying it.

This step may change repository files, run checks, create local commits, reply to reviews and resolve addressed threads. Later steps own local review and publication. The caller owns any tracker updates.

Return `repair_summary` with the feedback addressed, changes, verification evidence, published corrections confirmed, and threads awaiting publication or further resolution. Include an explicit disposition for each previous delivery review finding: fixed with evidence, already satisfied with evidence, or still unresolved.
