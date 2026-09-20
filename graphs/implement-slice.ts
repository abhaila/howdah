/**
 * implement-slice — design a vertical slice on the code-derived map, get it approved, build it,
 * and verify the code against the approved design (system-map sprint (c), slice 1).
 *
 * create_worktree → map.extract → slice.propose (read-only) → slice.approve ─┬─ approved ──▶ [requires gate] implementation.implement ◀────┐
 *                       ▲                ▲                                   ├─ feedback ─┐                  │                              │
 *                       │                └───────────────────────────────────┼────────────┘                  ▼                              │
 *                       ├──────────────────── stale ─────────────────────────┘                   map.reextract → map.drift                  │
 *                       │                                                                                        │                          │
 *                       └── redesign <run> <msg> (any time)          delivery (shared) ◀── pass ── implementation.local_review ── reject ──┘
 *                                                                         │ repairs (fix_ci / address_reviews / resolve_conflicts)
 *                                                                         └──▶ delivery.reextract → delivery.drift ─┬─ new problems ─▶ revise_repairs
 *                                                                                                                    └─▶ review_repairs ─┬─ pass ─▶ publish
 *                                                                                                                                        └─ reject ─▶ revise_repairs
 *                                                   revise_repairs ──▶ delivery.reextract_revision → delivery.drift_revision ─┬─ new problems ─▶ revise_repairs
 *                                                                                                                             └─▶ publish
 *
 * | Node                        | Kind                                  | Reads                                          | Writes (scope)                                     |
 * |-----------------------------|---------------------------------------|------------------------------------------------|----------------------------------------------------|
 * | map.extract                 | command `map:extract`, maxVisits 5    | goal, work (+ pending redesign messages)       | map.base, map.neighbourhood (sticky); slice.drift = [] (per-visit); review_findings = null (cleared); slice.feedback is ENGINE-OWNED here (D22) |
 * | slice.propose               | agent, readOnly (plan mode, enforced) | goal, work, map.base, map.neighbourhood, slice.feedback | slice.ghosts (per-visit) — a GhostSet, validated by validateProposal |
 * | slice.approve               | approval                              | slice.ghosts, map.base                         | slice.approval (per-visit), slice.feedback (sticky) |
 * | implementation.implement    | agent, maxVisits 3, requires approval | goal, work, slice.ghosts, slice.approval, slice.drift, review_findings | implementation_summary (sticky) |
 * | map.reextract               | command `map:reextract`               | map.base                                       | map.after (per-visit)                              |
 * | map.drift                   | command `map:drift`                   | slice.ghosts, map.base, map.after              | slice.drift (per-visit)                            |
 * | implementation.local_review | agent                                 | goal, work, slice.ghosts, implementation_summary, slice.drift | review_verdict, review_findings (cleared) |
 *
 * Why the map nodes are ids with dots (`map.extract`) while their built-ins are `map:extract`:
 * the node id is the graph's name for the step (like `delivery.probe_pr` running `probe:pr`).
 *
 * - No maxVisits on slice.propose: every redraw follows a human decision event.
 * - map.extract's maxVisits 5 parks a base that keeps moving (stale → re-extract loops).
 * - The reject loop re-enters implement (≤ 3) — the requires gate exempts those re-entries,
 *   because implement's own changes are what the approval authorised.
 * - validateProposal: the GhostSet validator (map/ghosts.ts) against the snapshot the proposal
 *   was drawn on (runs/<id>/maps/<map.base.manifest_hash>.json, assembled from the object store
 *   its map-extracted event recorded — engine/slice-map.ts loadSnapshot), plus a refusal of
 *   expected_files git ignores (never extracted, so never verifiable). A refusal parks the run
 *   attempt-failed with the errors, and the proposer's retry is TOLD them: the engine logs the
 *   refusal on node-finished and renders it into the next attempt (core/template.ts suffix v3).
 * - Delivery is the shared deliveryGraph({ verifyAfterRepair: true }) (graphs/delivery.ts).
 */
import { defineGraph, type ProposalRun } from "../core/graph";
import { DELIVERY_ENTRY, deliveryGraph, type VerifiedDeliveryCtx } from "./delivery";
import type { ApprovalDecision, FeedbackItem } from "../engine/slice-decision";
import { readBase } from "../engine/slice-decision";
import { ignoredExpectedFiles, loadSnapshot } from "../engine/slice-map";
import { validateGhostSet } from "../map/ghosts";

export interface ImplementSliceCtx extends VerifiedDeliveryCtx {
  "map.neighbourhood": string;
  "slice.feedback": FeedbackItem[];
  "slice.approval": ApprovalDecision;
  implementation_summary: string;
}

const sticky = { scope: "sticky" } as const;
const cleared = { scope: "cleared" } as const;
const perVisit = { scope: "per-visit" } as const;

const delivery = deliveryGraph({ verifyAfterRepair: true });

/**
 * The GhostSet check behind validateProposal: ids against the base the proposal was drawn on,
 * then expected_files git would never let the map extract. Returns the refusal text, or null.
 */
export function validateSliceProposal(proposal: unknown, run: ProposalRun): string | null {
  let base;
  try {
    base = loadSnapshot(run.dir, readBase(run.base, "map.base").manifest_hash ?? "");
  } catch (err) {
    return `cannot check the ghost set: the base snapshot is unreadable (${err instanceof Error ? err.message : String(err)})`;
  }
  const checked = validateGhostSet(proposal, base);
  if (!checked.ok) return checked.errors.join("\n");
  if (run.cwd) {
    const ignored = ignoredExpectedFiles(run.cwd, checked.ghosts);
    if (ignored.length)
      return ignored
        .map((f) => `expected_file ${JSON.stringify(f)} is ignored by git, so the map never extracts it and the ghost could never be verified — put the entity in a tracked source file`)
        .join("\n");
  }
  return null;
}

export const implementSlice = defineGraph<ImplementSliceCtx>({
  name: "implement-slice",
  // as implement-ticket: Claude runs in auto mode, Codex in its full-access sandbox;
  // slice.propose is read-only regardless (plan, and codex's read-only sandbox)
  defaults: { permissionMode: "auto" },
  description: "Design a vertical slice on the code map, get it approved, build it and verify it against the design",
  entry: "create_worktree",
  inputs: ["goal", "work"],
  validateProposal: (proposal, _approval, run) => validateSliceProposal(proposal, run),
  nodes: {
    create_worktree: { kind: "worktree", action: "create" },

    "map.extract": {
      kind: "command",
      run: "map:extract",
      reads: ["goal", "work"],
      writes: {
        "map.base": sticky,
        "map.neighbourhood": sticky,
        "slice.drift": perVisit,
        review_findings: cleared,
      },
      maxVisits: 5,
      class: "map",
    },
    "slice.propose": {
      kind: "agent",
      prompt: "slice.propose",
      readOnly: true,
      reads: ["goal", "work", "map.base", "map.neighbourhood", "slice.feedback"],
      writes: { "slice.ghosts": perVisit },
      class: "slice",
    },
    "slice.approve": {
      kind: "approval",
      proposal: "slice.ghosts",
      base: "map.base",
      decision: "slice.approval",
      feedback: "slice.feedback",
      redesignTo: "map.extract",
      class: "slice",
    },
    "implementation.implement": {
      kind: "agent",
      prompt: "slice.implement",
      requires: { approvalOf: "slice.approve" },
      reads: ["goal", "work", "slice.ghosts", "slice.approval", "slice.drift", "review_findings"],
      writes: { implementation_summary: sticky },
      maxVisits: 3,
      class: "implementation",
    },
    "map.reextract": { kind: "command", run: "map:reextract", reads: ["map.base"], writes: { "map.after": perVisit }, class: "map" },
    "map.drift": {
      kind: "command",
      run: "map:drift",
      reads: ["slice.ghosts", "map.base", "map.after"],
      writes: { "slice.drift": perVisit },
      class: "map",
    },
    "implementation.local_review": {
      kind: "agent",
      prompt: "slice.local_review",
      reads: ["goal", "work", "slice.ghosts", "implementation_summary", "slice.drift"],
      writes: { review_verdict: cleared, review_findings: cleared },
      class: "implementation",
    },

    ...delivery.nodes,
  },
  edges: [
    { from: "create_worktree", to: "map.extract" },
    { from: "map.extract", to: "slice.propose" },
    { from: "slice.propose", to: "slice.approve" },
    {
      from: "slice.approve",
      to: "implementation.implement",
      condition: { reads: ["slice.approval"], test: (v) => v["slice.approval"].outcome === "approved", label: "slice.approval == 'approved'" },
      weight: 3,
    },
    {
      from: "slice.approve",
      to: "slice.propose",
      condition: { reads: ["slice.approval"], test: (v) => v["slice.approval"].outcome === "feedback", label: "slice.approval == 'feedback'" },
      weight: 2,
    },
    {
      from: "slice.approve",
      to: "map.extract",
      condition: { reads: ["slice.approval"], test: (v) => v["slice.approval"].outcome === "stale", label: "slice.approval == 'stale'" },
      weight: 1,
    },
    { from: "implementation.implement", to: "map.reextract" },
    { from: "map.reextract", to: "map.drift" },
    { from: "map.drift", to: "implementation.local_review" },
    {
      from: "implementation.local_review",
      to: "implementation.implement",
      condition: { reads: ["review_verdict"], test: (v) => v.review_verdict === "reject", label: "review_verdict == 'reject'" },
      weight: 2,
    },
    {
      from: "implementation.local_review",
      to: DELIVERY_ENTRY,
      condition: { reads: ["review_verdict"], test: (v) => v.review_verdict === "pass", label: "review_verdict == 'pass'" },
      weight: 1,
    },

    ...delivery.edges,
  ],
});
