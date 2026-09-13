---
id: review.uncle_bob
version: 1
tags: [review-teammate-pr]
provenance: ported from Orbital review-teammate-pr
---
Discover and use relevant installed skills for code review and communicating findings.

PR context:

{{ context.pr_context }}

Review the diff in the spirit of Robert C. Martin's Clean Code: single responsibility, function and class size, meaningful and pronounceable names, absence of duplication, appropriate abstraction levels, dependency direction, comments that explain why rather than what, and the boy-scout rule for code the PR already touches.

Only evaluate lines the PR actually changed or added — do not flag pre-existing code the PR left untouched.

Classify every finding's severity as one color:
- 🔴 a clean-code violation serious enough to actively mislead future maintainers or hide a defect
- 🟠 a real violation worth fixing but not urgent
- 🟢 a minor stylistic nit

This step is strictly read-only with respect to the PR: never post an inline comment, a PR review, or any GitHub comment.

Return `uncle_bob_findings` as a list of objects, each with file, line, severity color, principle violated, and a one-line description. Return an empty list if there are none — do not omit the output.
