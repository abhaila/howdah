---
id: report.compile
version: 1
tags: [review-teammate-pr]
provenance: ported from Orbital review-teammate-pr
---
Discover and use relevant installed skills for communicating review findings.

PR context:

{{ context.pr_context }}

SonarQube findings:

{{ context.sonarqube_findings | dump }}

Uncle Bob findings:

{{ context.uncle_bob_findings | dump }}

Seq review findings:

{{ context.seq_review_findings | dump }}

Merge all three findings lists into one table with columns: Review, File, Line, Severity, Finding. Sort by severity (🔴 first, then 🟠, then 🟢). Do not de-duplicate findings from different reviews that happen to land on the same line — each review's voice stays distinct.

Write the table to a local markdown file in the worktree (do not commit it). Print the complete table in your response so it can be reviewed immediately without opening the file.

Under no circumstances post any of these findings as PR comments, inline review comments, or a GitHub review — this entire flow is local-only and read-only with respect to the PR.

Return `report_path` with the markdown file's path and `finding_counts` with the number of 🔴, 🟠 and 🟢 findings.
