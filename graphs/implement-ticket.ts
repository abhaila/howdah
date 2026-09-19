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
 * Loop bounds (system-map 0.3): every agent-driven loop parks for the operator instead of
 * spinning to maxSteps — plan_review ≤ 3 (local review keeps rejecting), revise_repairs ≤ 3
 * (repair review keeps rejecting, across repair cycles), publish ≤ 5 (repairs → publish →
 * probe keeps failing).
 * The probe_pr ⇄ wait poll is deliberately unbounded except by maxSteps: it waits on a
 * human reviewer, and time passing is not a failure. `howdah jump` resets these budgets.
 */
import { defineGraph } from "../core/graph";

export type PrState = "OPEN" | "MERGED" | "CLOSED" | "CONFLICTS" | "CI_FAILED" | "CHANGES_REQUIRED";

export interface ImplementTicketCtx {
  /** run inputs */
  goal: string;
  work: string;
  /** agent outputs */
  implementation_plan: string;
  implementation_summary: string;
  review_verdict: "pass" | "reject";
  review_findings: unknown;
  publication_summary: string;
  repair_summary: string;
  completion_summary: string;
  /** machine facts */
  "pr.state": PrState;
  "worktree.clean": boolean;
}

const sticky = { scope: "sticky" } as const;
const cleared = { scope: "cleared" } as const;
const perVisit = { scope: "per-visit" } as const;

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

    "delivery.publish": {
      kind: "agent",
      prompt: "delivery.publish", // v2 — the accepted reviser revision
      reads: ["goal", "work"],
      writes: { publication_summary: sticky },
      class: "delivery",
      maxVisits: 5, // system-map 0.3: bounds repairs → review_repairs → publish → probe_pr
    },
    // no maxVisits: probe_pr ⇄ wait polls on a human reviewer (system-map 0.3)
    "delivery.probe_pr": { kind: "command", run: "probe:pr", reads: ["publication_summary"], writes: { "pr.state": perVisit }, class: "delivery" },
    "delivery.address_reviews": {
      kind: "agent",
      prompt: "delivery.address_reviews",
      reads: ["goal", "work", "publication_summary", "review_verdict", "review_findings"],
      writes: { repair_summary: sticky },
      class: "delivery",
    },
    "delivery.fix_ci": {
      kind: "agent",
      prompt: "delivery.fix_ci",
      reads: ["goal", "work", "publication_summary", "review_verdict", "review_findings"],
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
      maxVisits: 3, // system-map 0.3: bounds repeated repair-review rejects (revise → publish → probe)
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
      to: "delivery.address_reviews",
      condition: { reads: ["pr.state"], test: (v) => v["pr.state"] === "CHANGES_REQUIRED", label: "pr.state == 'CHANGES_REQUIRED'" },
      weight: 3,
    },
    {
      from: "delivery.probe_pr",
      to: "delivery.fix_ci",
      condition: { reads: ["pr.state"], test: (v) => v["pr.state"] === "CI_FAILED", label: "pr.state == 'CI_FAILED'" },
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
    { from: "delivery.revise_repairs", to: "delivery.publish" },
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
});
