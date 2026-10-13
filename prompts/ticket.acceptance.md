---
id: ticket.acceptance
version: 2
tags: [implement-ticket]
provenance: HOW-51 — opens the default-FAIL acceptance contract, after the plan and before any code is written. v2 (HOW-59) says what this run can prove, and every row names how it will be checked
---
You are opening the acceptance contract for this ticket. You do not build or judge anything: you write down what "done" must mean, so a later reviewer can only call it done with evidence.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

Implementation plan:

{{ context.implementation_plan }}

## What this run can prove

The reviewer who checks these is READ-ONLY and runs before anything is published. It can cite only three kinds of evidence:
{{#if context.worktree.verify_command}}
- **tests**: the harness runs `{{ context.worktree.verify_command }}` in the worktree after the build, and the reviewer sees whether it passed.
{{/if}}
{{#if context.worktree.preview_paths}}
- **screenshot**: the harness starts the workspace preview and captures these paths: {{ context.worktree.preview_paths }}.
{{/if}}
- **command**: a read-only command it runs itself, such as `git diff`, `git log`, `grep` or reading a file. It cannot build, run tests, start servers, install anything or reach the network.

If no test command is named above, nothing will run the tests in this run, so no criterion can be proved by tests. If no screenshot paths are named, no screen will be captured.

## The criteria

Write the criteria as a JSON array. Each criterion is one checkable statement about the finished change:

- If the work scope has acceptance checkboxes (`- [ ] …`), make one criterion per checkbox, with its wording kept as close to the ticket's as a single sentence allows, and `"source": "ticket"`. Do not add criteria the ticket does not ask for, and do not drop or merge any.
- If it has none, propose three to seven criteria from the plan that a reviewer could check with evidence — a test that passes, a command and its output, or a screenshot of a changed screen — and give each `"source": "plan"`, so nobody mistakes them for the ticket's.
- A criterion that only a human can judge ("feels right", "reads well") stays in the list as written. It will need an operator's waiver; never reword it into something it is not.

Give every criterion a `"check"` saying how it will be checked, and choose honestly from what this run can prove:

- `"tests"`: only when a test command is named above.
- `"screenshot"`: only when screenshot paths are named above, and the criterion is about what a screen shows.
- `"command"`: a read-only command whose output settles it (the code says so, a file exists, a pattern is gone).
- `"human"`: only a person can judge it.
- `"after-publish"`: it is about pull requests, CI, reviewers, merges or deploys. It cannot be true before publication, so it does not hold publication; the delivery steps check it.

Prefer criteria a read-only reviewer can settle in this run. When a ticket checkbox needs evidence this run cannot produce, keep it, and give it the check it really needs; the operator settles it.

Every criterion starts FAILING: `"passes": false` and `"evidence": null`, always. Only the reviewer flips one, and only on evidence. A list where anything already passes is refused.

Give each a short stable id (`ac-1`, `ac-2`, …). Each row is:

{"id": "ac-1", "text": "…", "source": "ticket", "check": "command", "passes": false, "evidence": null}

This step is read-only. Leave files, commits, branches, pull requests and tracker records unchanged.
