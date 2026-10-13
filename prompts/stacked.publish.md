---
id: stacked.publish
version: 1
tags: [delivery, pr, stacked]
provenance: HOW-57 (G3b) — delivery.publish, included unchanged, plus the rules for a PR stacked on another slice's PR
---
{{> delivery.publish }}

## This change is stacked on another slice

This run belongs to a larger feature whose slices are built by separate runs, each with its own branch and PR.
{{#if context.deps.base}}
Its branch is stacked on `{{ context.deps.base }}` — another slice's branch, which has its own PR. Create or update this run's PR with `{{ context.deps.base }}` as its BASE branch, not the repository's default branch, so reviewers see only this slice's commits. Do not push, rebase or edit `{{ context.deps.base }}`; it belongs to the other run.
{{/if}}
If this run's branch is no longer stacked on another slice's branch (its base already merged and this branch was replayed onto the default branch), target the repository's default branch.

These pull requests belong to the slices this one depends on. They are NOT this run's, so never list them in `publication_summary`:

{{ context.deps.prs }}

`publication_summary` MUST be an object, even for a single PR: list this run's own PR URLs in `pr_urls` (base of this run's own stack first) and name the tip as `primary_pr_url`. A prose summary is refused, because the next steps would not be able to tell this run's PR from the PRs it is stacked on.
