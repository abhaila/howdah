---
id: implementation.implement
base_version: 1
proposed_version: 2
status: accepted
accepted_at: 2026-10-13T13:04:25.763Z
created: 2026-10-12T00:00:00.000Z
fork: true
experiment: HOW-44 variant C (plan-first)
eval_score: DRY RUN (HOWDAH_STUB, no agent ran) — A 0/0 vs B 0/0 passed · cost A — vs B —
eval_verdict: dry run only; run the real A/B before deciding — not enough cases to tell — 0 discordant pairs; an exact test needs at least 6 before any split could reach p < 0.05
eval_report: reviser/proposals/implementation.implement.v2.c-plan-first.ab-report.json
---
Discover and use relevant installed skills for implementation and verification.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

Implementation plan:

{{ context.implementation_plan }}

{{> implementation._plan_first }}

Implement the planned change in the prepared worktree. Follow applicable repository instructions and preserve unrelated work.

Satisfy every requirement in the work scope and goal. If the code reveals an error in the plan, make the necessary adjustment within that scope and explain it.

Run the relevant checks. Record what each check establishes and any failures or verification gaps. Create or update local commits using the repository’s conventions.

This step may change repository files, run checks and create local commits. Later steps own publication. The caller owns any tracker updates.

Return `implementation_summary` with the changes, verification evidence, deviations from the plan and any unmet requirements.
