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

Previous delivery review verdict:

{{ context.review_verdict }}

Previous delivery review findings:

{{ context.review_findings | dump }}

Inspect the current PR, published head and failing checks. Read their logs, affected code and applicable repository instructions. Confirm the failures belong to the current published change.

Identify the cause of each failure. Use focused local checks where possible and compare against the target branch when needed to distinguish defects in this change from existing failures or external problems.

Correct failures within the work scope and goal. Preserve unrelated work. Rerun a failed remote check when the evidence supports a transient failure; do not rerun checks repeatedly without investigating.

If the previous delivery review verdict is `reject`, treat every previous review finding as still blocking unless you verify it is already corrected in the current published head. Do not return a no-op or CI-only summary while any previous finding remains unaddressed. If CI is green but review findings remain, repair the findings or clearly list them as unresolved blockers in `repair_summary`.

Verify the corrections and create or update local commits using the repository’s conventions.

If the PR has merged or closed, report that state without modifying it.

This step may change repository files, run checks, rerun remote CI and create local commits. Later steps own local review and publication. The caller owns any tracker updates.

You need to get the PR into a state where required CI checks are green.

Return `repair_summary` with the failed checks, diagnosis, corrections, verification results and anything still unresolved. Include an explicit disposition for each previous delivery review finding: fixed with evidence, already satisfied with evidence, or still unresolved.
