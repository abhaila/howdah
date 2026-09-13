---
id: implementation.plan_review
version: 1
tags: [implement-ticket]
provenance: ported from Orbital implement-ticket
---
Discover and use relevant installed skills for planning and communicating the plan.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

Previous implementation plan:

{{ context.implementation_plan }}

Implementation summary:

{{ context.implementation_summary }}

Review verdict:

{{ context.review_verdict }}

Review findings:

{{ context.review_findings | dump }}

Read the work scope, applicable repository instructions and current changes. Investigate each blocking finding against the code and available evidence.

Revise the implementation plan to address every blocking finding. Specify each correction and how it will be verified. Preserve work that already satisfies the requirements and identify any changes that must be removed or revised.

Keep the revised plan complete enough for implementation. Cover the work scope and goal without adding unrelated work. State assumptions and material risks.

Return the revised plan as `implementation_plan`. Leave repository files and tracker records unchanged.

Later steps will implement and publish the changes. The caller owns any tracker updates.
