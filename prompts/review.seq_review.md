---
id: review.seq_review
version: 1
tags: [review-teammate-pr]
provenance: ported from Orbital review-teammate-pr
---
Discover and use relevant installed skills for reviewing pull requests against this repository's own engineering standards — prefer the repository's own review skill (e.g. `seq-review`) if installed, falling back to the generic `/review` skill or applicable repository instructions otherwise.

PR context:

{{ context.pr_context }}

Run that review against the PR's diff: correctness bugs, violations of mandatory repository rules (architecture, testing conventions, comment style, error handling), and simplification or efficiency opportunities. Only evaluate lines the PR changed.

Classify every finding's severity as one color:
- 🔴 correctness/security defect or a violation of a mandatory repository rule
- 🟠 a real but non-blocking quality issue
- 🟢 a minor nit or suggestion

This step is strictly read-only with respect to the PR: even if the invoked skill is capable of posting inline PR comments, do not let it — capture findings only, do not post anything to GitHub.

Return `seq_review_findings` as a list of objects, each with file, line, severity color, rule or principle, and a one-line description. Return an empty list if there are none — do not omit the output.
