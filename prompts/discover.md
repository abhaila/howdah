---
id: discover
version: 1
tags: [improve-codebase]
provenance: ported from Orbital improve-codebase
---
Discover and use relevant installed skills for assessing and improving this codebase.

User supplied goal:

{{ inputs.goal }}

Read applicable repository instructions and inspect the code and tests. Focus on any area named by the goal; otherwise consider the whole codebase, including code that has not changed recently.

Select one worthwhile improvement supported by concrete evidence and a verifiable outcome. Check relevant tickets, pull requests and previous attempts to avoid duplicating work or repeating a rejected proposal without new evidence.

Return `discovery` as `candidate` when an improvement is selected. Set `work` to a self-contained description of the affected area, observed problem, evidence, proposed change, scope boundaries and acceptance criteria. This becomes the work scope used by planning, implementation, review and PR delivery.

Return `discovery` as `idle` when no worthwhile candidate is found. Set `work` to a brief account of the areas examined and why no candidate was selected. The idle path waits thirty minutes and searches again; it does not enter implementation.

This step investigates and proposes only. Leave repository files, branches, pull requests and tracker records unchanged. Do not create a ticket for the candidate.

Later steps create a worktree, plan and implement the selected improvement, review it and manage PR delivery. After cleanup, this workflow searches for the next improvement.
