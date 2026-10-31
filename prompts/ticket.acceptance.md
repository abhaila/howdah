---
id: ticket.acceptance
version: 3
tags: [implement-ticket]
provenance: HOW-51 — opens the default-FAIL acceptance contract, after the plan and before any code is written. v2 (HOW-59) says what this run can prove, and every row names how it will be checked. v3 (HOW-72) — the operator reads these in the PR, so at most five, each one sentence about behaviour the ticket asks for, no test-suite-green and no process rows
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

Write the criteria as a JSON array. A person reads them: any criterion this run does not prove is listed in the pull request description as "Not proven by this run". So write few, and write them plainly.

- Write at most five criteria.
- Each criterion is one sentence about behaviour the ticket asks for, in the ticket's own terms: what a user or caller of the change can now do or observe. Do not name files, functions or other code, and do not describe how the change is built.
- Never write a criterion that the test suite, typecheck, build or lint is green. The harness runs the tests and reports that itself.
- Never write a process step: committing, pushing, opening or updating a pull request, running a command, or updating a ticket. Those are how the work gets done, not what it must achieve.
- If the work scope has acceptance checkboxes (`- [ ] …`), take the criteria from them, keeping the ticket's wording as close as one sentence allows, with `"source": "ticket"`. Leave out a checkbox that is only a test-suite or process step. When more than five remain, combine closely related ones into one sentence; never drop one the ticket asks for.
- If it has none, propose up to five criteria from the ticket and the plan that a reviewer could check with evidence, and give each `"source": "plan"`, so nobody mistakes them for the ticket's.
- A criterion that only a human can judge ("feels right", "reads well") stays in the list as written, with the check `"human"`. It is disclosed as not proven; never reword it into something it is not.

Give every criterion a `"check"` saying how it will be checked, and choose honestly from what this run can prove:

- `"tests"`: only when a test command is named above.
- `"screenshot"`: only when screenshot paths are named above, and the criterion is about what a screen shows.
- `"command"`: a read-only command whose output settles it (the code says so, a file exists, a pattern is gone).
- `"human"`: only a person can judge it.
- `"after-publish"`: it is about pull requests, CI, reviewers, merges or deploys. It cannot be true before publication, so it does not hold publication; the delivery steps check it.

Prefer criteria a read-only reviewer can settle in this run. When a ticket checkbox needs evidence this run cannot produce, keep it, and give it the check it really needs; it is disclosed as not proven.

Every criterion starts FAILING: `"passes": false` and `"evidence": null`, always. Only the reviewer flips one, and only on evidence. A list where anything already passes is refused.

Give each a short stable id (`ac-1`, `ac-2`, …). Each row is:

{"id": "ac-1", "text": "…", "source": "ticket", "check": "command", "passes": false, "evidence": null}

This step is read-only. Leave files, commits, branches, pull requests and tracker records unchanged.
