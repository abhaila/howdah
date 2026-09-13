---
id: implementation.implement
version: 1
tags: [implement-ticket]
provenance: ported from Orbital implement-ticket
---
Discover and use relevant installed skills for implementation and verification.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

Implementation plan:

{{ context.implementation_plan }}

Implement the planned change in the prepared worktree. Follow applicable repository instructions and preserve unrelated work.

Satisfy every requirement in the work scope and goal. If the code reveals an error in the plan, make the necessary adjustment within that scope and explain it.

Run the relevant checks. Record what each check establishes and any failures or verification gaps. Create or update local commits using the repository’s conventions.

This step may change repository files, run checks and create local commits. Later steps own publication. The caller owns any tracker updates.

Return `implementation_summary` with the changes, verification evidence, deviations from the plan and any unmet requirements.
