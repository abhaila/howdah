---
id: implementation.plan
version: 1
tags: [implement-ticket]
provenance: ported from Orbital implement-ticket
---
Discover and use relevant installed skills for planning and communicating the plan.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

Read the supplied work scope, relevant linked context and applicable repository instructions. Inspect the affected code and tests. For ticket-based work, read the identified ticket.

Plan the changes needed to satisfy the work scope. Use the goal to guide decisions without expanding that scope. Choose the smallest implementation that meets every requirement.

Explain the required behaviour, affected components, implementation order and how each acceptance criterion will be verified. Ground decisions in the inspected code.

Return the plan as `implementation_plan`. Leave repository files and tracker records unchanged.

Later steps will implement and publish the changes.
