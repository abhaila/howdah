---
id: implementation._verify_aware
version: 1
tags: [implement-ticket, implement-slice, partial, experiment]
provenance: HOW-44 variant B — tell a build agent the harness verifies after it, so it stops re-running the full suite once its last edit is done (the harness-design study's ~30% cost cut for strong models). Rendered only when the workspace has a verify command; a partial, never run on its own
---
{{#if context.worktree.verify_command}}
## Verification happens after you

The harness runs `{{ context.worktree.verify_command }}` in this worktree after you finish and gives its result to the reviewer. Run only the focused checks you need while working; do not re-run the full suite once your last edit is done.
{{/if}}
