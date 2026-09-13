---
id: review.sonarqube
version: 1
tags: [review-teammate-pr]
provenance: ported from Orbital review-teammate-pr
---
Discover and use relevant installed skills for running static analysis and communicating findings.

PR context:

{{ context.pr_context }}

Ensure the local SonarQube service is running (start it if needed, e.g. `docker compose up -d sequence-local-sonarqube`, and wait for it to report ready) and run a scan of the checked-out worktree against it.

Filter results to issues on lines actually touched by this PR's diff — do not report pre-existing issues in code the PR did not change.

Classify every finding's severity as one color:
- 🔴 blocker or critical (bugs, vulnerabilities, correctness)
- 🟠 major (code smells with real maintainability impact)
- 🟢 minor or info

This step is strictly read-only with respect to the PR: never post an inline comment, a PR review, or any GitHub comment, regardless of what the SonarQube integration supports.

Return `sonarqube_findings` as a list of objects, each with file, line, severity color, rule, and a one-line description. Return an empty list if there are none — do not omit the output.
