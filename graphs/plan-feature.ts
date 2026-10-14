/**
 * plan-feature — HOW-23: take one large, multi-repo/multi-module feature, decompose it into
 * vertical slices, get the DECOMPOSITION approved, raise a ticket per slice, and launch an
 * independent `implement-ticket` run for each. One graph becomes many runs, each with its own
 * worktree, branch and pull request.
 *
 *   create_worktree → map.extract → plan.propose (read-only) → plan.approve ─┬─ approved ─▶ [requires gate] tickets.create → runs.launch → cleanup ─┬─ clean ─▶ launched
 *                          ▲             ▲                                   ├─ feedback ─┘                                                          └─────────▶ cleanup_pending
 *                          │             └───────────────────────────────────┤
 *                          ├──────────────── stale ────────────────────────────┘                    N × `bun cli/main.ts run implement-ticket` (detached)
 *                          └── redesign <run> <msg> (any time)                                           └─▶ each: own worktree + branch + PR + ticket closure
 *
 * | Node             | Kind                                   | Reads                                                   | Writes (scope)                                  |
 * |------------------|----------------------------------------|---------------------------------------------------------|-------------------------------------------------|
 * | create_worktree  | worktree `create`                      | —                                                       | —                                               |
 * | map.extract      | command `map:extract`, maxVisits 5     | goal, work (+ pending redesign messages)                | map.base, map.neighbourhood (sticky); plan.feedback is ENGINE-OWNED here (D22) |
 * | plan.propose     | agent, readOnly (plan mode, enforced)  | goal, work, map.base, map.neighbourhood, plan.feedback  | plan.slices (per-visit) — a SlicePlan, validated by validateProposal |
 * | plan.approve     | approval                               | plan.slices, map.base                                   | plan.approval (per-visit), plan.feedback (sticky) |
 * | tickets.create   | agent, maxVisits 2, requires approval  | goal, work, plan.slices, plan.approval                  | tickets (sticky)                                |
 * | runs.launch      | command `runs:launch`, maxVisits 3     | plan.slices, tickets                                    | launched (sticky)                               |
 * | cleanup          | worktree `remove`                      | —                                                       | worktree.clean (per-visit)                      |
 *
 * It is `implement-slice`'s proven shape with a different proposal and a different ending, and
 * the differences are the ticket:
 *
 * - THE PROPOSAL IS A PLAN, NOT A GHOST SET. What the operator actually wants to decide before
 *   anything is built is "are these the right slices", not "are these the right identity keys".
 *   Everything downstream of `proposalHash` is payload-agnostic already (the approval executor,
 *   engine/slice-decision.ts, the CLI verbs and the routes), so approve / comment +
 *   send-feedback / redesign all work here unchanged.
 * - MAP.EXTRACT STAYS, for three reasons and none of them is the ghost set. The approval node's
 *   `base` must hold a BaseSnapshot and `map:extract` is its only producer; the neighbourhood
 *   grounds the decomposition in the real code of the repo this run is looking at; and stale
 *   detection (the tree moved under the plan) comes free with it. It is ONE repository —
 *   map/ is single-project by design — so slices in other registered workspaces are planned
 *   from the brief and the prompt says so.
 * - "MAYBE BETTER AS A SKILL" IS HONOURED IN THE PROMPT, NOT THE GRAPH. `plan.propose` opens
 *   with the repo's standard installed-skills line, so a shaping or decomposition skill does the
 *   work instead of a graph-encoded ceremony. The node deliberately does NOT declare `skills:`:
 *   `doctor` asserts declared skills exist, and hard-coding them would fail on a machine that
 *   does not have them.
 * - THE RUN ENDS AT THE LAUNCH. `runs.launch` starts N detached runs and this run finishes; it
 *   never waits on a child. `depends_on` is a gate the CHILD keeps (HOW-57): a dependent slice
 *   is launched as `implement-stacked`, which waits for its dependencies itself.
 *
 * Loop bounds, each one a park for the operator rather than a spin:
 * - no maxVisits on plan.propose — every redraw follows a human decision event;
 * - map.extract ≤ 5 parks a base that keeps moving (stale → re-extract loops);
 * - tickets.create ≤ 2, because its side effect is on someone else's tracker: the prompt's
 *   search-then-reuse guard handles a legitimate re-visit, and a third try means something is
 *   wrong that another attempt will not fix;
 * - runs.launch ≤ 3 — the launcher is idempotent by child run id, so a retry is cheap, but a
 *   third failure is a refusal it will keep making.
 */
import { defineGraph, type ProposalRun } from "../core/graph";
import { join } from "node:path";
import { howdahHome, loadConfig, workspaceNameFor } from "../config/config";
import { readLog } from "../log/write";
import type { ApprovalDecision, BaseSnapshot, FeedbackItem } from "../engine/slice-decision";
import { validateSlicePlan, type LaunchResult, type SlicePlan, type SliceTicket } from "./slice-plan";

export interface PlanFeatureCtx {
  goal: string;
  work: string;
  "map.base": BaseSnapshot;
  "map.neighbourhood": string;
  "plan.slices": SlicePlan;
  "plan.feedback": FeedbackItem[];
  "plan.approval": ApprovalDecision;
  tickets: { tickets: SliceTicket[] };
  launched: LaunchResult;
  "worktree.clean": boolean;
}

const sticky = { scope: "sticky" } as const;
const perVisit = { scope: "per-visit" } as const;

/**
 * The slice-plan check behind validateProposal. The registered workspaces are read HERE rather
 * than passed in because a plan is only approvable if it is LAUNCHABLE: a slice naming a
 * workspace nobody registered could never become a run, and the whole point of the gate is that
 * what the operator approves is what gets built. (`graphs/local.ts` already reads
 * $HOWDAH_HOME, so a graph touching config is in keeping.)
 */
export function validatePlanProposal(proposal: unknown, run?: ProposalRun): string | null {
  const config = loadConfig(howdahHome());
  const checked = validateSlicePlan(proposal, { knownWorkspaces: Object.keys(config.repos), parentWorkspace: parentWorkspaceOf(config, run) });
  return checked.ok ? null : checked.errors.join("\n");
}

/**
 * HOW-57: the workspace this planning run was launched in — what a slice with no `workspace`
 * builds in — so a stack base can be checked to be in the same repo as its dependent. Read from
 * the run's own `run-started` (its cwd is the registered workspace path; the run then works in
 * a worktree of it). Unknown is null, never a guess.
 */
function parentWorkspaceOf(config: ReturnType<typeof loadConfig>, run: ProposalRun | undefined): string | null {
  if (!run) return null;
  const started = readLog(join(run.dir, "run.jsonl")).find((e) => e.type === "run-started");
  return started?.type === "run-started" && started.cwd ? workspaceNameFor(config, started.cwd) : null;
}

export const planFeature = defineGraph<PlanFeatureCtx>({
  name: "plan-feature",
  // as implement-slice: Claude runs in auto mode, Codex in its full-access sandbox;
  // plan.propose is read-only regardless (plan, and codex's read-only sandbox)
  defaults: { permissionMode: "auto" },
  description: "Deliver one feature across repos: plan it into BE/FE slices, approve the plan, then each slice runs implement-ticket — stacked or waiting on the ones before it — and is merged one by one",
  entry: "create_worktree",
  inputs: ["goal", "work"],
  validateProposal: (proposal, _approval, run) => validatePlanProposal(proposal, run),
  nodes: {
    create_worktree: { kind: "worktree", action: "create" },

    "map.extract": {
      kind: "command",
      run: "map:extract",
      reads: ["goal", "work"],
      writes: { "map.base": sticky, "map.neighbourhood": sticky },
      maxVisits: 5,
      class: "map",
    },
    "plan.propose": {
      kind: "agent",
      prompt: "plan.propose",
      readOnly: true,
      reads: ["goal", "work", "map.base", "map.neighbourhood", "plan.feedback"],
      writes: { "plan.slices": perVisit },
      class: "plan",
    },
    "plan.approve": {
      kind: "approval",
      proposal: "plan.slices",
      base: "map.base",
      decision: "plan.approval",
      feedback: "plan.feedback",
      redesignTo: "map.extract",
      class: "plan",
    },
    "tickets.create": {
      kind: "agent",
      prompt: "plan.tickets",
      requires: { approvalOf: "plan.approve" },
      reads: ["goal", "work", "plan.slices", "plan.approval"],
      writes: { tickets: sticky },
      maxVisits: 2,
      class: "tickets",
    },
    "runs.launch": {
      kind: "command",
      run: "runs:launch",
      reads: ["plan.slices", "tickets"],
      writes: { launched: sticky },
      maxVisits: 3,
      class: "tickets",
    },

    cleanup: { kind: "worktree", action: "remove", writes: { "worktree.clean": perVisit }, class: "cleanup" },
    launched: { kind: "terminal", outcome: "success" },
    cleanup_pending: { kind: "terminal", outcome: "failed", label: "Worktree retained to preserve local work" },
  },
  edges: [
    { from: "create_worktree", to: "map.extract" },
    { from: "map.extract", to: "plan.propose" },
    { from: "plan.propose", to: "plan.approve" },
    {
      from: "plan.approve",
      to: "tickets.create",
      condition: { reads: ["plan.approval"], test: (v) => v["plan.approval"].outcome === "approved", label: "plan.approval == 'approved'" },
      weight: 3,
    },
    {
      from: "plan.approve",
      to: "plan.propose",
      condition: { reads: ["plan.approval"], test: (v) => v["plan.approval"].outcome === "feedback", label: "plan.approval == 'feedback'" },
      weight: 2,
    },
    {
      from: "plan.approve",
      to: "map.extract",
      condition: { reads: ["plan.approval"], test: (v) => v["plan.approval"].outcome === "stale", label: "plan.approval == 'stale'" },
      weight: 1,
    },
    { from: "tickets.create", to: "runs.launch" },
    { from: "runs.launch", to: "cleanup" },
    // the planning worktree is scratch — every child makes its own, so a clean removal is the
    // success ending and a dirty one keeps the folder for the operator rather than deleting work
    {
      from: "cleanup",
      to: "launched",
      condition: { reads: ["worktree.clean"], test: (v) => v["worktree.clean"] === true, label: "worktree.clean" },
      weight: 1,
    },
    { from: "cleanup", to: "cleanup_pending" },
  ],
});
