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

### HOW-31 phase 2: the draft diff on the canvas, and "make this run reusable"

**What:**
- Draw a draft's diff against `based_on` on the builder canvas: steps added, removed and
  changed, plus what a removal cascaded into.
- A control on a finished run that launches `draft-graph`, seeded with that run's graph and its
  operator replies and jumps.

**Why:** Phase 1 shows the diff as a list. The CEO plan's goal is reviewing a change where it
happens, and drafting from a run is the lowest-effort way in, with no prose to compose.

**Context:**
- Plan: `docs/designs/graph-drafting-eng-plan.md` (decisions A and B; phase 2 section).
- Builds on phase 1's minimal diff list and `copyOf` prompt references.
- Do this only after phase 1 drafts have been used for real.

**Effort:** M
**Priority:** P2
**Depends on:** HOW-31 phase 1


## Engine (graphs)

### Named proposal validators, then convert implement-slice and plan-feature to GraphSpec

**What:**
- Add a `PROPOSAL_VALIDATORS` table, in the style of `COMMAND_BUILTINS`, so an approval step
  NAMES its validator (`slice-plan`, `ghost-set`) instead of the graph carrying a function.
- Then convert the last two built-ins.

**Why:** This finishes the CEO plan's B1. The builder can then open those two graphs, and
drafts can diff against them.

**Context:**
- `validateProposal` is a graph-level function (`graphs/plan-feature.ts:96`), and a
  `GraphSpec` is JSON with no slot for one. That is why these two graphs were skipped.
- `graphs/fixtures/pre-spec-shapes.json` must NOT be regenerated. A diff there means the
  conversion changed behaviour.

**Effort:** M
**Priority:** P3
**Depends on:** nothing. Only needed once something diffs against these graphs.

### Seed graph drafts from run history

**What:** Give the drafter a summary of how the operator's past runs went: which steps parked,
what the replies said, and which graphs were reused.

**Why:** The CEO plan's target is the draft you would have drawn yourself (item 2,
sequenced last by D7).

**Context:**
- 14 runs over 2 graph shapes is a thin corpus.
- Measure with the drafter eval (`reviser/eval/cases/graph-draft/`, plan decision 8A) before
  trusting it.

**Effort:** M
**Priority:** P3
**Depends on:** HOW-31 phase 1 shipped, and the drafter eval baseline


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
