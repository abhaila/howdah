---
id: stacked.resolve_restack
version: 1
tags: [delivery, stacked]
provenance: HOW-57 (decision A, G4) — the one restack step an executor cannot finish alone: a conflict, handed over with the exact --onto command
---
Discover and use relevant installed skills for resolving rebase conflicts and verifying the resulting change.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

Publication summary:

{{ context.publication_summary }}

This run's branch is stacked on another slice's branch. That base changed — it moved, or it was merged into the default branch — and replaying this branch onto it conflicted, so the automatic restack stopped and put the worktree back as it was.

Replay it with exactly this command, from the worktree, after `git fetch origin`:

```
{{ context.restack.conflict }}
```

Use this command, and not a plain rebase onto the target branch: the range it replays is only this run's own commits, which is what keeps the base's commits (or, after a squash merge, their duplicates) out of this branch.

Resolve each conflict by understanding both sides. Keep the required behaviour of the work scope and the base's changes. Continue the rebase until it completes, run the relevant checks, then push this run's branch with `git push --force-with-lease`. Push only this run's branch; never push or edit the base's branch.

If the replay no longer conflicts, finish it and report that without introducing unnecessary changes.

This step may fetch, rebase, resolve conflicts, run checks, commit and push this run's branch. Later steps review and publish the change. The caller owns any tracker updates.

Return `repair_summary` with the command you ran, the conflicts you resolved and how, the resulting head, verification evidence and anything still unresolved.
