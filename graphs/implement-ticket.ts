/**
 * implement-ticket — ported from Orbital's DOT export (research/graphs/orb-implement-ticket.txt).
 *
 * The port collapses Orbital's fork problem: `implement-ticket-areeb` existed only to change
 * one prompt. Here the graph references `delivery.publish` by id and gets whatever version
 * the prompt store holds — currently v2, the first accepted reviser proposal.
 *
 *   create_worktree → plan → implement → local_review ─┬─reject─▶ plan_review → implement_review ─┐
 *            ▲                              ▲          └─pass───▶ publish → probe_pr ─┬─ MERGED ─▶ complete_ticket → cleanup_merged ─▶ complete
 *            │                              └──────────────────────────────┘(loop)    ├─ CLOSED ─▶ cleanup_closed ─▶ closed
 *                                                                                     ├─ CONFLICTS/CI/CHANGES ─▶ repairs → review_repairs ─┬─pass─▶ publish
 *                                                                                     │                                      └─reject─▶ revise ─▶ publish
 *                                                                                     └─ (fallback) wait 5m ─▶ probe_pr
 *
 * The delivery half (publish → probe_pr → repairs → complete / cleanup) is the shared
 * `deliveryGraph({ verifyAfterRepair: false })` in graphs/delivery.ts (system-map 1c) — the
 * same nodes, edges and bounds this graph always had; implement-slice uses it with `true`.
 *
 * Loop bounds (system-map 0.3): every agent-driven loop parks for the operator instead of
 * spinning to maxSteps — plan_review ≤ 3 (local review keeps rejecting), revise_repairs ≤ 3
 * (repair review keeps rejecting, across repair cycles), publish ≤ 5 (repairs → publish →
 * probe keeps failing).
 * The probe_pr ⇄ wait poll is deliberately unbounded except by maxSteps: it waits on a
 * human reviewer, and time passing is not a failure. `howdah jump` resets these budgets.
 */
import { defineGraph } from "../core/graph";
import { deliveryGraph, type DeliveryCtx } from "./delivery";

export type { PrState } from "./delivery";

export interface ImplementTicketCtx extends DeliveryCtx {
  /** agent outputs (the delivery keys — review, publication, repairs, pr.state — come from DeliveryCtx) */
  implementation_plan: string;
  implementation_summary: string;
}

const sticky = { scope: "sticky" } as const;
const cleared = { scope: "cleared" } as const;

/** system-map 1c: the shared delivery half, unverified — exactly what this graph always ran */
const delivery = deliveryGraph({ verifyAfterRepair: false });

export const implementTicket = defineGraph<ImplementTicketCtx>({
  name: "implement-ticket",
  // Claude runs in auto mode by default; Codex uses full-access sandboxing in its executor.
  defaults: { permissionMode: "auto" },
  description: "Deliver one ticket through reviewed implementation and a merged PR",
  entry: "create_worktree",
  inputs: ["goal", "work"],
  nodes: {
    create_worktree: { kind: "worktree", action: "create" },

    "implementation.plan": {
      kind: "agent",
      prompt: "implementation.plan",
      reads: ["goal", "work"],
      writes: { implementation_plan: sticky },
      class: "implementation",
    },
    "implementation.implement": {
      kind: "agent",
      prompt: "implementation.implement",
      reads: ["goal", "work", "implementation_plan"],
      writes: { implementation_summary: sticky },
      class: "implementation",
    },
    "implementation.local_review": {
      kind: "agent",
      prompt: "implementation.local_review",
      reads: ["goal", "work", "implementation_plan", "implementation_summary"],
      writes: { review_verdict: cleared, review_findings: cleared },
      class: "implementation",
    },
    "implementation.plan_review": {
      kind: "agent",
      prompt: "implementation.plan_review",
      reads: ["goal", "work", "implementation_plan", "implementation_summary", "review_verdict", "review_findings"],
      writes: { implementation_plan: sticky },
      class: "implementation",
      maxVisits: 3, // system-map 0.3: bounds local_review → plan_review → implement_review
    },
    "implementation.implement_review": {
      kind: "agent",
      prompt: "implementation.implement_review",
      reads: ["goal", "work", "implementation_plan", "implementation_summary", "review_verdict", "review_findings"],
      writes: { implementation_summary: sticky },
      class: "implementation",
    },

    ...delivery.nodes,
  },
  edges: [
    { from: "create_worktree", to: "implementation.plan" },
    { from: "implementation.plan", to: "implementation.implement" },
    { from: "implementation.implement", to: "implementation.local_review" },
    {
      from: "implementation.local_review",
      to: "implementation.plan_review",
      condition: { reads: ["review_verdict"], test: (v) => v.review_verdict === "reject", label: "review_verdict == 'reject'" },
      weight: 2,
    },
    {
      from: "implementation.local_review",
      to: "delivery.publish",
      condition: { reads: ["review_verdict"], test: (v) => v.review_verdict === "pass", label: "review_verdict == 'pass'" },
      weight: 1,
    },
    { from: "implementation.plan_review", to: "implementation.implement_review" },
    { from: "implementation.implement_review", to: "implementation.local_review" },

    ...delivery.edges,
  ],
});
