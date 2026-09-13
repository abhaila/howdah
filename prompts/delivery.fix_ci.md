---
id: delivery.fix_ci
version: 1
tags: [implement-ticket]
provenance: ported from Orbital implement-ticket
---
Discover and use relevant installed skills for diagnosing CI failures, implementing corrections and verification.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

Publication summary:

{{ context.publication_summary }}

Inspect the current PR, published head and failing checks. Read their logs, affected code and applicable repository instructions. Confirm the failures belong to the current published change.

Identify the cause of each failure. Use focused local checks where possible and compare against the target branch when needed to distinguish defects in this change from existing failures or external problems.

Correct failures within the work scope and goal. Preserve unrelated work. Rerun a failed remote check when the evidence supports a transient failure; do not rerun checks repeatedly without investigating.

Verify the corrections and create or update local commits using the repository’s conventions.

If the PR has merged or closed, report that state without modifying it.

This step may change repository files, run checks, rerun remote CI and create local commits. Later steps own local review and publication. The caller owns any tracker updates.

You need to get the PR into a state where required CI checks are green.

Return `repair_summary` with the failed checks, diagnosis, corrections, verification results and anything still unresolved.
