---
id: checkout.pull_pr
version: 1
tags: [review-teammate-pr]
provenance: ported from Orbital review-teammate-pr
---
Discover and use relevant installed skills for checking out pull requests.

Pull request to review:

{{ inputs.pull_request }}

In the freshly created worktree, fetch and check out the supplied pull request's branch. Identify its base/target branch and the exact head commit under review.

Compute the diff against the target branch: changed files, added/removed lines, and the PR's own title, description and author. Do not modify the branch, push anything, or comment on the PR.

This step only prepares the worktree and gathers context. It must not run any review, start any service, or write any report.

Return `pr_context` with the PR metadata, target branch, head commit and the full list of changed files with their diff hunks. Later steps use this as the shared scope for all reviews — no review may flag anything outside these changed lines.
