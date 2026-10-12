---
id: ticket.local_review
version: 2
tags: [implement-ticket]
provenance: HOW-52 — implementation.local_review (v2, with HOW-40's review._verify_result) for implement-ticket, which now hands the reviewer screenshot evidence of the changed screens; improve-codebase keeps implementation.local_review unchanged. v2 (HOW-51) adds the default-FAIL acceptance contract the reviewer flips on evidence
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

Screenshot evidence, captured by the harness from this worktree's own preview (it is the harness's record, not the builder's account):

{{ context.evidence.items }}

When `outcome` is `captured`, open every item's `abs_path` with the Read tool before you judge anything the change shows on screen. Each item says which path and URL it shows and how many console errors the page logged; `console_abs_path` holds them verbatim. Judge the screens yourself — do not take the implementation summary's word for what they show. A page that logged console errors is a finding unless you have verified the errors predate this change.

When the change alters what a screen shows and the evidence is `failed` or `not-checked`, or a screen you need is missing or unreadable, that requirement is unverified: reject it as missing evidence, naming the screen and the reason given. A UI change cannot pass on code inspection alone.

Review the current change against the work scope, goal, plan and applicable repository instructions. Inspect the complete branch diff against its target, including uncommitted changes, affected code and relevant tests.

Review only requirements and defects that can be verified through automated checks or code inspection. For each rejection, identify the requirement, concrete evidence, required correction and machine-checkable completion condition.

Use the work scope, plan and summary as context. Verify their claims against the code and available evidence.

Reject unmet requirements, correctness or security defects, violations of mandatory repository rules, missing verification of required behaviour and changes made which are outside the work scope. Treat preferences as non-blocking unless repository instructions require them.

Human reviews, manual acceptance, visual approval and user sign-off are non-blocking. Report them as outstanding without requiring their completion to pass.

Compare each finding with previous reviews and attempted corrections. If the same finding returns without new evidence or a materially different actionable correction, recognise that the review is looping. Do not reject again for that finding. Report the unresolved concern and explain why another repair pass would not advance it

For each blocking finding, identify the requirement or defect, supporting evidence and the correction needed.

This step is read-only. Leave files, commits, branches, pull requests and tracker records unchanged.

## The acceptance contract

Every criterion below started failing, and stays failing until YOU have evidence it is met:

{{ context.acceptance }}

Return the whole list again as `acceptance`, with every row it already has — same ids, same text. For each live criterion you have checked:

- Set `"passes": true` only with evidence that is real in this run, as one of:
  - `{"kind": "verify.result", "note": "…which tests cover it…"}` — only when the verify outcome above is `pass`;
  - `{"kind": "screenshot", "file": "evidence/…png", "note": "…what it shows…"}` — the `file` of a screenshot listed above, which you opened;
  - `{"kind": "command", "command": "…", "output": "…"}` — a read-only command you ran and the output that convinced you.
- Leave `"passes": false` and `"evidence": null` for anything you could not verify. Plausibility is not correctness: the implementation summary's claim that something works is not evidence.
- A criterion only a human can judge stays false — the operator will waive it.
- If the plan changed and a criterion no longer applies, set `"superseded": true` on it and add its replacement as a new row with a new id. Never delete or reword a row.

A flip without real evidence is refused and you will be asked again.

Return review_verdict as reject only when actionable, machine-checkable blocking findings remain. Otherwise return pass. Keep outstanding human or manual checks and concerns excluded. Return `review_findings` as an array containing those findings, or an empty array when the review passes.
