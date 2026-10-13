HOW-44 experiment, variant D (B and C together): one change against the stock prompt, as the harness-design study varied one component at a time.

- What changes: the prompt includes `implementation._plan_first`, `implementation._verify_aware` before the instructions. `fork: true` because the include set changes.
- Hypothesis (HOW-32): for strong models a persistent plan cuts about 30% of cost at about the same accuracy, almost entirely by removing redundant verification after the last edit; telling the agent that `verify:run` runs the suite after it targets the same waste directly.
- Accept only if the A/B harness (`bun reviser/eval/ab.ts`, implement-ticket case set) shows success not significantly worse AND median cost lower, AND the trajectory profile confirms the mechanism (fewer verify calls after the last edit). A cost drop with no change in that profile is noise or something else.
- If plan-first regresses (more turns — frontier CLIs already plan), the paper's weak-model result explains it and C should not ship.
- Accepting it is gated: `implementation.implement` is also run by improve-codebase, which has no verify:run and does not declare `worktree.verify_command`, so the store's undeclared-read guard refuses this proposal until improve-codebase verifies too (or the prompt is forked). That refusal is correct — the sentence would be false there.
