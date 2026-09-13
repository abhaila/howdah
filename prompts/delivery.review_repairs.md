---
id: delivery.review_repairs
version: 1
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

Review the complete current branch change against the work scope, goal and applicable repository instructions. Inspect the diff against the current target branch, including uncommitted changes, affected code and relevant tests.

Verify the corrections and verification claims in the repair summary against the code and available evidence.

Reject unmet requirements, correctness or security defects, violations of mandatory repository rules, missing verification of required behaviour and changes outside the work scope. Treat preferences as non-blocking unless repository instructions require them.

This step is read-only. Leave files, commits, branches, pull requests and tracker records unchanged.

Return `review_verdict` as `reject` when blocking findings remain, otherwise `pass`. Return `review_findings` as an array of blocking findings, each with `requirement`, `evidence` and `correction`. A pass returns an empty array.

Follow-up steps address rejected findings or publish the reviewed changes, then continue monitoring the PR.
