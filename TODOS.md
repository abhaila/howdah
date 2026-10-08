# TODOS

## Engine

### Resolve an ambiguous side effect from the CLI and web

**What:** A `resolve-effect <run> <effect> happened|not-happened` verb for runs parked with code
`ambiguous-effect`.

**Why:** After Sprint 0.2 (docs/designs/system-map.md), `reply` refuses these parks with "resolve the
effect first", but no command does that. The only exits today are hand-editing `run.jsonl` or
aborting, which breaks "nothing dead-ends silently".

**Context:**
- The resume probe lives at `engine/run.ts:168-170`. When it returns `unknown`, the run parks
  ("ambiguous side effect … probe could not decide").
- The verb would append an additive `side-effect-resolved {effect, verdict, by: "operator"}` event:
  - `happened` → replay treats it like `side-effect-done`;
  - `not-happened` → the retry claims the effect again.
- It must go through the shared reply module and the Sprint 0.5 locked `appendIf`, with one
  resolution per ambiguous intent.
- It is an audit trail of a human attesting to external state (for example, "yes, the PR was
  published").

**Effort:** S
**Priority:** P2
**Depends on:** Sprint 0.2 (park codes), Sprint 0.5 (locked append)

## Web

### Howdah reads Linear (the single pane)

**What:** Linear issues listed in the Howdah pane; start a run from a ticket; the PR body
closes it on merge.

**Why:** HOW-31 asks for "a simple todo" inside Howdah. That is the wrong shape. 31 issues
already live in Linear with a working MCP connection, and a second store would drift from it
within a week. The job is seeing your work in one place, not storing it twice.

**Context:**
- Deferred out of the 2026-10-08 CEO review (`~/.gstack/projects/abhaila-howdah/ceo-plans/2026-10-08-graph-drafting.md`, proposal 6).
- Separate plan from graph drafting; bundling them makes one plan into two.
- `docs/agents/issue-tracker.md` currently points the mattpocock skills at local `.scratch/`
  markdown. That was written without checking Linear and is wrong; re-point it as part of this.

**Effort:** M
**Priority:** P2
**Depends on:** nothing


## Map

### Garbage-collect the map object store

**What:** A `bun cli/main.ts gc` verb that deletes `$HOWDAH_HOME/maps/objects/*` entries no run
manifest references.

**Why:** Slice 1 (eng review D14/D23) stores per-file syntax facts immutably and shares them across
runs. Objects from deleted runs, and from files edited many times, accumulate with no way to reclaim
the space.

**Context:**
- Mark-and-sweep:
  - mark every object hash referenced by `runs/*/maps/*.json` manifests;
  - sweep the rest;
  - skip objects newer than an hour, so an in-flight `map:extract` is never swept.
- Report the bytes freed.
- Build it once real sizes are measurable (after a few Sequence runs), so the retention policy is
  based on data.

**Effort:** S
**Priority:** P3
**Depends on:** slice 1b (object store + manifests)

## Completed
