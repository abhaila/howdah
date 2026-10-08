# Issue tracker: Linear

Issues for this repo live in **Linear**, team **Howdah**, as `HOW-<n>`. Use the Linear MCP
tools (`mcp__claude_ai_Linear__*`); there is no CLI.

Corrected 2026-10-08. This file previously described local markdown under `.scratch/`, written
after seeing zero GitHub issues and inferring that work lived in `shaping.md` / `TODOS.md`.
That inference was wrong: `HOW-16`…`HOW-31` in `CLAUDE.md` and in every commit message are
Linear ids. There is no `.scratch/` directory and nothing should create one.

## Conventions

- **Read an issue**: `get_issue` with `id: "HOW-31"`. Pass `includeRelations: true` when
  blocking edges matter.
- **List**: `list_issues` with `team: "Howdah"`. `fields` trims the payload; `query` searches
  title and description.
- **Create**: `save_issue` with `team: "Howdah"`. Most issues belong to the `-1 to 0` project.
- **Comment**: `save_comment` with `issueId`.
- **Close**: `save_issue` with the Done state. `list_issue_statuses` names them.
- **Images in a description** arrive as `<linear-image>` with a **signed URL that expires in
  about five minutes**. Download it immediately or it is gone, and the sentence around it is
  often incomplete without the picture.
- **Branch names** come from the issue: `gitBranchName`, e.g.
  `areebbhaila/how-31-the-graphs-are-too-complicated-to-create-by-hand`. Note that this repo
  commits straight to `main` unless a PR is asked for, so the branch name is usually unused.

## When a skill says "publish to the issue tracker"

Create a Linear issue on team Howdah.

## When a skill says "fetch the relevant ticket"

`get_issue` with the `HOW-<n>` identifier.

## How this relates to `shaping.md`, `TODOS.md` and `docs/designs/`

`shaping.md` is the authoritative design document (`R*`, `A*`, `D*`/`OV-*`, `T1`–`T22`).
`TODOS.md` holds standing backlog items not in flight. `docs/designs/` holds per-feature
design and CEO-review docs. None of these is the tracker: Linear is.

A Linear issue may cite a shaping id, and a design doc should name the issue it serves.
`shaping.md` is never edited to record ticket state.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a Linear issue; **child tickets** are sub-issues of it.

- **Map**: an issue holding the Notes / Decisions-so-far / Fog body.
- **Child ticket**: an issue with `parentId` set to the map's id. `list_issues` with
  `parentId` lists the frontier.
- **Blocking**: Linear relations. `get_issue` with `includeRelations: true` returns
  `blocks` / `blockedBy`.
- **Claim**: assign to `me`.
- **Resolve**: `save_comment` with the answer, move to Done, then append a pointer to the
  map's Decisions-so-far.
