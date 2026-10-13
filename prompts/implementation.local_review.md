---
id: implementation.local_review
version: 2
tags: [implement-ticket]
provenance: ported from Orbital implement-ticket; v2 (HOW-40) includes review._verify_result, the behavioural verdict from verify.run
---
Discover and use relevant installed skills for code review and communicating findings.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

Implementation plan:

{{ context.implementation_plan }}

Implementation summary:

{{ context.implementation_summary }}

{{> review._verify_result }}

Review the current change against the work scope, goal, plan and applicable repository instructions. Inspect the complete branch diff against its target, including uncommitted changes, affected code and relevant tests.

Review only requirements and defects that can be verified through automated checks or code inspection. For each rejection, identify the requirement, concrete evidence, required correction and machine-checkable completion condition.

Use the work scope, plan and summary as context. Verify their claims against the code and available evidence.

Reject unmet requirements, correctness or security defects, violations of mandatory repository rules, missing verification of required behaviour and changes made which are outside the work scope. Treat preferences as non-blocking unless repository instructions require them.

Human reviews, manual acceptance, visual approval and user sign-off are non-blocking. Report them as outstanding without requiring their completion to pass.

Compare each finding with previous reviews and attempted corrections. If the same finding returns without new evidence or a materially different actionable correction, recognise that the review is looping. Do not reject again for that finding. Report the unresolved concern and explain why another repair pass would not advance it

For each blocking finding, identify the requirement or defect, supporting evidence and the correction needed.

This step is read-only. Leave files, commits, branches, pull requests and tracker records unchanged.

Return review_verdict as reject only when actionable, machine-checkable blocking findings remain. Otherwise return pass. Keep outstanding human or manual checks and concerns excluded. Return `review_findings` as an array containing those findings, or an empty array when the review passes.
