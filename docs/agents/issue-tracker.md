# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.

## How this relates to `shaping.md` and `TODOS.md`

`shaping.md` is the authoritative design document (requirements `R*`, shape parts `A*`,
decisions `D*`/`OV-*`, tasks `T1`–`T22`, and the `HOW-*` tickets). `TODOS.md` holds standing
backlog items that are not in flight. Neither is an issue tracker.

`.scratch/` is where ONE piece of work in flight gets specced and broken into tickets. A
ticket may cite a shaping ID in its body (`HOW-24`, `T18`) and should, when one applies — but
it never replaces one, and `shaping.md` is never edited to record ticket state. Do not migrate
`TODOS.md` into `.scratch/`: an item moves there when it is picked up, and the `TODOS.md`
entry is deleted in the same change that ships it.

`.scratch/` is deliberately NOT gitignored. Issues are versioned with the code they describe,
the same way `shaping.md` is.
