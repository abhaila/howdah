---
id: ticket.acceptance
version: 1
tags: [implement-ticket]
provenance: HOW-51 — opens the default-FAIL acceptance contract, after the plan and before any code is written
---
You are opening the acceptance contract for this ticket. You do not build or judge anything: you write down what "done" must mean, so a later reviewer can only call it done with evidence.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

Implementation plan:

{{ context.implementation_plan }}

Write the criteria as a JSON array. Each criterion is one checkable statement about the finished change:

- If the work scope has acceptance checkboxes (`- [ ] …`), make one criterion per checkbox, with its wording kept as close to the ticket's as a single sentence allows, and `"source": "ticket"`. Do not add criteria the ticket does not ask for, and do not drop or merge any.
- If it has none, propose three to seven criteria from the plan that a reviewer could check with evidence — a test that passes, a command and its output, or a screenshot of a changed screen — and give each `"source": "plan"`, so nobody mistakes them for the ticket's.
- A criterion that only a human can judge ("feels right", "reads well") stays in the list as written. It will need an operator's waiver; never reword it into something it is not.

Every criterion starts FAILING: `"passes": false` and `"evidence": null`, always. Only the reviewer flips one, and only on evidence. A list where anything already passes is refused.

Give each a short stable id (`ac-1`, `ac-2`, …). Each row is:

{"id": "ac-1", "text": "…", "source": "ticket", "passes": false, "evidence": null}

This step is read-only. Leave files, commits, branches, pull requests and tracker records unchanged.
