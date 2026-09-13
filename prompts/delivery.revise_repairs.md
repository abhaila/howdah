---
id: delivery.revise_repairs
version: 1
tags: [implement-ticket]
provenance: ported from Orbital implement-ticket
---
Discover and use relevant installed skills for implementation and verification.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

Publication summary:

{{ context.publication_summary }}

Previous repair summary:

{{ context.repair_summary }}

Review verdict:

{{ context.review_verdict }}

Review findings:

{{ context.review_findings | dump }}

Inspect the current changes and applicable repository instructions. Address every blocking finding. Preserve correct work and remove changes identified as outside the work scope.

Verify each correction and run the relevant checks for the complete change. Satisfy the work scope and goal, including the required PR repairs. Create or update local commits using the repository’s conventions.

This step may change repository files, run checks and create local commits. Leave the PR and tracker records unchanged.

Return an updated `repair_summary` describing the complete repair, the correction and verification for each finding, and anything still unresolved.

Follow-up steps review the changes again, publish them after a passing review, and continue monitoring the PR.
