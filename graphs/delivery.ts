/**
 * The shared delivery half (system-map 1c, "Shared delivery") — publish → probe → repairs →
 * complete / cleanup — built ONCE and used by both implement-ticket and implement-slice, so
 * the loop bounds, repair routing and cleanup semantics cannot drift between them.
 *
 *   delivery.publish → probe_pr ─┬─ MERGED ─▶ complete_ticket → cleanup_merged ─┬─ clean ─▶ complete
 *        ▲                       │                                               └────────▶ cleanup_pending
 *        │                       ├─ CLOSED ─▶ cleanup_closed ─┬─ clean ─▶ closed
 *        │                       │                            └────────▶ cleanup_pending
 *        │                       ├─ CONFLICTS / CI_FAILED / CHANGES_REQUIRED ─▶ resolve_conflicts / fix_ci / address_reviews
 *        │                       └─ (fallback) wait 5m ─▶ probe_pr                     │
 *        │                                                                             ▼
 *        └──────── pass ── review_repairs ⇄ revise_repairs (reject)        [verifyAfterRepair: false]
 *
 * verifyAfterRepair: true (implement-slice) — every code-changing repair is re-verified against
 * the APPROVED design before anything is reviewed or published (outside voice #7):
 *
 *   resolve_conflicts / fix_ci / address_reviews / revise_repairs
 *        └─▶ delivery.reextract (map:reextract) → delivery.drift (map:drift --since delivery.publish)
 *                 ├─ new drift problems (PROBLEM_OUTCOMES, engine/slice-map.ts) ─▶ revise_repairs
 *                 └─ (fallback) ─▶ review_repairs ─┬─ pass ─▶ publish
 *                                                  └─ reject ─▶ revise_repairs
 *
 *   - "New" = not already a problem when publish last started, so a repair is judged on what IT
 *     broke. The drift → revise_repairs loop is bounded by revise_repairs' maxVisits (3): a
 *     repair that keeps breaking the design parks for the operator instead of publishing.
 *   - The repair and review nodes read `slice.ghosts` and `slice.drift` (slice.* prompts), so
 *     fixes respect the approved design and the reviewer sees the drift.
 *
 * Loop bounds (system-map 0.3), both variants: revise_repairs ≤ 3 (repair review keeps
 * rejecting), publish ≤ 5 (repairs → publish → probe keeps failing). The probe_pr ⇄ wait poll is
 * deliberately unbounded except by maxSteps: it waits on a human reviewer.
 *
 * The builder returns nodes + edges; the caller wires its own `… → delivery.publish` edge
 * (DELIVERY_ENTRY) and must write, on every path to it, the keys delivery reads: goal, work,
 * review_verdict, review_findings (revise_repairs reads the last verdict) and — verified —
 * slice.ghosts, slice.drift and map.base.
 */
import type { EdgeDef, NodeDef, OutputSpec } from "../core/graph";
import type { BaseSnapshot } from "../engine/slice-decision";
import type { MapAfter, SliceDrift } from "../engine/slice-map";
import type { GhostSet } from "../map/ghosts";

export type PrState = "OPEN" | "MERGED" | "CLOSED" | "CONFLICTS" | "CI_FAILED" | "CHANGES_REQUIRED";

/** The keys the delivery half reads or writes. */
export interface DeliveryCtx {
  goal: string;
  work: string;
  review_verdict: "pass" | "reject";
  review_findings: unknown;
  publication_summary: string;
  repair_summary: string;
  completion_summary: string;
  "pr.state": PrState;
  "worktree.clean": boolean;
}

/** verifyAfterRepair: the slice keys the re-verification reads and writes. */
export interface VerifiedDeliveryCtx extends DeliveryCtx {
  "map.base": BaseSnapshot;
  "map.after": MapAfter;
  "slice.ghosts": GhostSet;
  /** `[]` until the first map:drift (map:extract seeds it) */
  "slice.drift": SliceDrift | [];
}

export interface DeliveryParts<C extends object> {
  nodes: Record<string, NodeDef<C>>;
  edges: EdgeDef<C>[];
}

/** Where a graph hands over to delivery. */
export const DELIVERY_ENTRY = "delivery.publish";

/** The new problems of a drift value (none before the first map:drift). */
export function newDriftProblems(drift: SliceDrift | []): string[] {
  return Array.isArray(drift) ? [] : drift.new_problems;
}

const sticky = { scope: "sticky" } as const satisfies OutputSpec;
const cleared = { scope: "cleared" } as const satisfies OutputSpec;
const perVisit = { scope: "per-visit" } as const satisfies OutputSpec;

/** The unverified delivery half — exactly what implement-ticket always ran. */
function plainDelivery(): DeliveryParts<DeliveryCtx> {
  return {
    nodes: {
      "delivery.publish": {
        kind: "agent",
        prompt: "delivery.publish", // v2 — the accepted reviser revision
        reads: ["goal", "work"],
        writes: { publication_summary: sticky },
        class: "delivery",
        maxVisits: 5, // system-map 0.3: bounds repairs → review_repairs → publish → probe_pr
      },
      // no maxVisits: probe_pr ⇄ wait polls on a human reviewer (system-map 0.3)
      "delivery.probe_pr": { kind: "command", run: "probe:pr", writes: { "pr.state": perVisit }, class: "delivery" },
      "delivery.address_reviews": {
        kind: "agent",
        prompt: "delivery.address_reviews",
        reads: ["goal", "work", "publication_summary"],
        writes: { repair_summary: sticky },
        class: "delivery",
      },
      "delivery.fix_ci": {
        kind: "agent",
        prompt: "delivery.fix_ci",
        reads: ["goal", "work", "publication_summary"],
        writes: { repair_summary: sticky },
        class: "delivery",
      },
      "delivery.resolve_conflicts": {
        kind: "agent",
        prompt: "delivery.resolve_conflicts",
        reads: ["goal", "work", "publication_summary"],
        writes: { repair_summary: sticky },
        class: "delivery",
      },
      "delivery.review_repairs": {
        kind: "agent",
        prompt: "delivery.review_repairs",
        reads: ["goal", "work", "publication_summary", "repair_summary"],
        writes: { review_verdict: cleared, review_findings: cleared },
        class: "delivery",
      },
      "delivery.revise_repairs": {
        kind: "agent",
        prompt: "delivery.revise_repairs",
        reads: ["goal", "work", "publication_summary", "repair_summary", "review_verdict", "review_findings"],
        writes: { repair_summary: sticky },
        class: "delivery",
        maxVisits: 3, // system-map 0.3: bounds review_repairs ⇄ revise_repairs
      },
      "delivery.wait": { kind: "wait", duration: "5m", class: "delivery" },

      complete_ticket: {
        kind: "agent",
        prompt: "complete_ticket",
        reads: ["goal", "work", "publication_summary"],
        writes: { completion_summary: sticky },
      },
      cleanup_merged: { kind: "worktree", action: "remove", writes: { "worktree.clean": perVisit } },
      cleanup_closed: { kind: "worktree", action: "remove", writes: { "worktree.clean": perVisit } },

      complete: { kind: "terminal", outcome: "success" },
      closed: { kind: "terminal", outcome: "aborted" },
      cleanup_pending: { kind: "terminal", outcome: "failed", label: "Worktree retained to preserve local work" },
    },
    edges: [
      { from: "delivery.publish", to: "delivery.probe_pr" },
      {
        from: "delivery.probe_pr",
        to: "complete_ticket",
        condition: { reads: ["pr.state"], test: (v) => v["pr.state"] === "MERGED", label: "pr.state == 'MERGED'" },
        weight: 6,
      },
      {
        from: "delivery.probe_pr",
        to: "cleanup_closed",
        condition: { reads: ["pr.state"], test: (v) => v["pr.state"] === "CLOSED", label: "pr.state == 'CLOSED'" },
        weight: 5,
      },
      {
        from: "delivery.probe_pr",
        to: "delivery.resolve_conflicts",
        condition: { reads: ["pr.state"], test: (v) => v["pr.state"] === "CONFLICTS", label: "pr.state == 'CONFLICTS'" },
        weight: 4,
      },
      {
        from: "delivery.probe_pr",
        to: "delivery.fix_ci",
        condition: { reads: ["pr.state"], test: (v) => v["pr.state"] === "CI_FAILED", label: "pr.state == 'CI_FAILED'" },
        weight: 3,
      },
      {
        from: "delivery.probe_pr",
        to: "delivery.address_reviews",
        condition: { reads: ["pr.state"], test: (v) => v["pr.state"] === "CHANGES_REQUIRED", label: "pr.state == 'CHANGES_REQUIRED'" },
        weight: 2,
      },
      { from: "delivery.probe_pr", to: "delivery.wait" },

      { from: "delivery.address_reviews", to: "delivery.review_repairs" },
      { from: "delivery.fix_ci", to: "delivery.review_repairs" },
      { from: "delivery.resolve_conflicts", to: "delivery.review_repairs" },
      {
        from: "delivery.review_repairs",
        to: "delivery.revise_repairs",
        condition: { reads: ["review_verdict"], test: (v) => v.review_verdict === "reject", label: "review_verdict == 'reject'" },
        weight: 2,
      },
      {
        from: "delivery.review_repairs",
        to: "delivery.publish",
        condition: { reads: ["review_verdict"], test: (v) => v.review_verdict === "pass", label: "review_verdict == 'pass'" },
        weight: 1,
      },
      { from: "delivery.revise_repairs", to: "delivery.review_repairs" },
      { from: "delivery.wait", to: "delivery.probe_pr" },

      { from: "complete_ticket", to: "cleanup_merged" },
      {
        from: "cleanup_merged",
        to: "complete",
        condition: { reads: ["worktree.clean"], test: (v) => v["worktree.clean"], label: "worktree.clean == true" },
        weight: 1,
      },
      { from: "cleanup_merged", to: "cleanup_pending" },
      {
        from: "cleanup_closed",
        to: "closed",
        condition: { reads: ["worktree.clean"], test: (v) => v["worktree.clean"], label: "worktree.clean == true" },
        weight: 1,
      },
      { from: "cleanup_closed", to: "cleanup_pending" },
    ],
  };
}

/** The nodes whose agent changes code during delivery — each is re-verified when asked. */
export const CODE_CHANGING_REPAIRS = ["delivery.resolve_conflicts", "delivery.fix_ci", "delivery.address_reviews", "delivery.revise_repairs"] as const;

const REEXTRACT = "delivery.reextract";
const DRIFT = "delivery.drift";

/** The delivery half with re-verification after every code-changing repair. */
function verifiedDelivery(): DeliveryParts<VerifiedDeliveryCtx> {
  const plain = plainDelivery() as DeliveryParts<VerifiedDeliveryCtx>;
  const design = ["slice.ghosts", "slice.drift"] as const;
  const repairReads = ["goal", "work", "publication_summary", ...design] as const;
  const nodes: Record<string, NodeDef<VerifiedDeliveryCtx>> = {
    ...plain.nodes,
    "delivery.address_reviews": { kind: "agent", prompt: "slice.address_reviews", reads: [...repairReads], writes: { repair_summary: sticky }, class: "delivery" },
    "delivery.fix_ci": { kind: "agent", prompt: "slice.fix_ci", reads: [...repairReads], writes: { repair_summary: sticky }, class: "delivery" },
    "delivery.resolve_conflicts": { kind: "agent", prompt: "slice.resolve_conflicts", reads: [...repairReads], writes: { repair_summary: sticky }, class: "delivery" },
    "delivery.review_repairs": {
      kind: "agent",
      prompt: "slice.review_repairs",
      reads: ["goal", "work", "publication_summary", "repair_summary", ...design],
      writes: { review_verdict: cleared, review_findings: cleared },
      class: "delivery",
    },
    "delivery.revise_repairs": {
      kind: "agent",
      prompt: "slice.revise_repairs",
      reads: ["goal", "work", "publication_summary", "repair_summary", "review_verdict", "review_findings", ...design],
      writes: { repair_summary: sticky },
      class: "delivery",
      maxVisits: 3, // system-map 0.3 — also bounds drift → revise_repairs (a repair that keeps breaking the design)
    },
    [REEXTRACT]: { kind: "command", run: "map:reextract", reads: ["map.base"], writes: { "map.after": perVisit }, class: "delivery" },
    [DRIFT]: {
      kind: "command",
      run: "map:drift --since delivery.publish",
      reads: ["slice.ghosts", "map.base", "map.after"],
      writes: { "slice.drift": perVisit },
      class: "delivery",
    },
  };
  const rerouted = new Set<string>(CODE_CHANGING_REPAIRS);
  const edges: EdgeDef<VerifiedDeliveryCtx>[] = [
    // every code-changing repair goes through the map before anyone reviews it
    ...plain.edges.filter((e) => !rerouted.has(e.from)),
    ...CODE_CHANGING_REPAIRS.map((from) => ({ from, to: REEXTRACT })),
    { from: REEXTRACT, to: DRIFT },
    {
      from: DRIFT,
      to: "delivery.revise_repairs",
      condition: {
        reads: ["slice.drift"],
        test: (v) => newDriftProblems(v["slice.drift"]).length > 0,
        label: "slice.drift has new problems (missing / changed-unexpectedly / still-present / unchanged)",
      },
      weight: 1,
    },
    { from: DRIFT, to: "delivery.review_repairs" },
  ];
  return { nodes, edges };
}

/**
 * The delivery half. `verifyAfterRepair: false` is implement-ticket's delivery, unchanged;
 * `true` re-extracts and computes drift after every code-changing repair (implement-slice).
 */
export function deliveryGraph(opts: { verifyAfterRepair: false }): DeliveryParts<DeliveryCtx>;
export function deliveryGraph(opts: { verifyAfterRepair: true }): DeliveryParts<VerifiedDeliveryCtx>;
export function deliveryGraph(opts: { verifyAfterRepair: boolean }): DeliveryParts<DeliveryCtx> | DeliveryParts<VerifiedDeliveryCtx> {
  return opts.verifyAfterRepair ? verifiedDelivery() : plainDelivery();
}
