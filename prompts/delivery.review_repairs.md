---
id: delivery.review_repairs
version: 2
tags: [implement-ticket]
provenance: ported from Orbital implement-ticket
---
Discover and use relevant installed skills for code review and communicating findings.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

Publication summary:

{{ context.publication_summary }}

Repair summary:

{{ context.repair_summary }}

Review the repair against the work scope, goal and applicable repository instructions. A repair-scope briefing below names the commit the repair started from: judge the diff from that commit, including uncommitted changes, the affected code and relevant tests — the branch up to that commit was reviewed and published already and is context, not the subject. If no such briefing is given, judge the complete current branch change against its target branch.

Verify the corrections and verification claims in the repair summary against the code and available evidence.

Reject unmet requirements, correctness or security defects, violations of mandatory repository rules, missing verification of required behaviour and changes outside the work scope. Treat preferences as non-blocking unless repository instructions require them.

This step is read-only. Leave files, commits, branches, pull requests and tracker records unchanged.

Return `review_verdict` as `reject` when blocking findings remain, otherwise `pass`. Return `review_findings` as an array of blocking findings, each with `requirement`, `evidence` and `correction`. A pass returns an empty array.

Follow-up steps address rejected findings or publish the reviewed changes, then continue monitoring the PR.
