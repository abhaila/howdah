# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | `Status:` value in our tracker | Meaning                                  |
| -------------------------- | ------------------------------ | ---------------------------------------- |
| `needs-triage`             | `needs-triage`                 | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`                   | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`              | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`              | Requires human implementation            |
| `wontfix`                  | the **Canceled** state          | Will not be actioned                     |

This repo tracks issues in **Linear** (see `issue-tracker.md`). `needs-triage`,
`ready-for-agent` and `ready-for-human` are Linear **labels**; `wontfix` maps to the
**Canceled** state, which the Howdah team already uses heavily. Applying a label means
`save_issue` with the label, or a state change for `wontfix`.

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding
string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.
