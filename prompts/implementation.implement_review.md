---
id: implementation.implement_review
version: 1
tags: [implement-ticket]
provenance: ported from Orbital implement-ticket
---
Discover and use relevant installed skills for implementation and verification.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

Revised implementation plan:

{{ context.implementation_plan }}

Previous implementation summary:

{{ context.implementation_summary }}

Review verdict:

{{ context.review_verdict }}

Review findings:

{{ context.review_findings | dump }}

Inspect the current changes and applicable repository instructions. Apply the revised plan and address every blocking finding. Preserve correct work and remove changes the plan identifies as outside scope.

Verify each correction and run the relevant checks for the complete change. Close all remaining defects, unmet requirements or verification gaps in the work scope and the plan. Address all required changes from the plan and review. Create or update local commits using the repository’s conventions.

This step may change repository files, run checks and create local commits. Later steps own local review and publication. The caller owns any tracker updates.

Return an updated `implementation_summary` describing the complete current change, the correction and verification for each finding, and anything still unresolved.
