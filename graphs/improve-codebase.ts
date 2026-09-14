/**
 * improve-codebase — ported from Orbital. The perpetual loop: discover a worthwhile
 * improvement, deliver it through the same reviewed pipeline as implement-ticket, clean up,
 * discover again. Shares 11 prompts with implement-ticket by id — including the accepted
 * delivery.publish v2 — which is R1 working as designed: one prompt, many graphs.
 *
 *   discover ─┬─candidate─▶ create_worktree → [implementation/delivery pipeline] → cleanup ─┬─clean─▶ discover
 *             └─idle──────▶ idle_wait 30m ─▶ discover                                       └─else──▶ cleanup_wait 5m ⇄ cleanup
 *
 * No terminal nodes: this graph runs until stopped. `work` is not an input here — discover
 * writes it each cycle.
 */
import { defineGraph } from "../core/graph";
import type { PrState } from "./implement-ticket";

export interface ImproveCodebaseCtx {
  goal: string;
  discovery: "candidate" | "idle";
  work: string;
  implementation_plan: string;
  implementation_summary: string;
  review_verdict: "pass" | "reject";
  review_findings: unknown;
  publication_summary: string;
  repair_summary: string;
  "pr.state": PrState;
  "worktree.clean": boolean;
  outcome: "removed" | "failed";
}

const sticky = { scope: "sticky" } as const;
const cleared = { scope: "cleared" } as const;
const perVisit = { scope: "per-visit" } as const;

export const improveCodebase = defineGraph<ImproveCodebaseCtx>({
  name: "improve-codebase",
  // full autonomy in the worktree: "auto" still routes Bash to the ask card (observed);
  // bypassPermissions is the mode that actually does not ask
  defaults: { permissionMode: "bypassPermissions" },
  description: "Continuously discover and deliver one worthwhile codebase improvement at a time",
  entry: "discover",
  inputs: ["goal"],
  nodes: {
    discover: {
      kind: "agent",
      prompt: "discover",
      reads: ["goal"],
      writes: { discovery: perVisit, work: sticky },
    },
    idle_wait: { kind: "wait", duration: "30m" },
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
      prompt: "delivery.publish", // v2, shared with implement-ticket
      reads: ["goal", "work"],
      writes: { publication_summary: sticky },
      class: "delivery",
    },
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
    },
    "delivery.wait": { kind: "wait", duration: "5m", class: "delivery" },

    cleanup: { kind: "worktree", action: "remove", writes: { "worktree.clean": perVisit, outcome: perVisit } },
    cleanup_wait: { kind: "wait", duration: "5m" },
  },
  edges: [
    {
      from: "discover",
      to: "create_worktree",
      condition: { reads: ["discovery"], test: (v) => v.discovery === "candidate", label: "discovery == 'candidate'" },
      weight: 2,
    },
    {
      from: "discover",
      to: "idle_wait",
      condition: { reads: ["discovery"], test: (v) => v.discovery === "idle", label: "discovery == 'idle'" },
      weight: 1,
    },
    { from: "idle_wait", to: "discover" },

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
      to: "cleanup",
      condition: { reads: ["pr.state"], test: (v) => v["pr.state"] === "MERGED", label: "pr.state == 'MERGED'" },
      weight: 6,
    },
    {
      from: "delivery.probe_pr",
      to: "cleanup",
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

    {
      from: "cleanup",
      to: "cleanup_wait",
      condition: { reads: ["outcome"], test: (v) => v.outcome === "failed", label: "outcome == 'failed'" },
      weight: 2,
    },
    {
      from: "cleanup",
      to: "discover",
      condition: { reads: ["worktree.clean"], test: (v) => v["worktree.clean"], label: "worktree.clean == true" },
      weight: 1,
    },
    { from: "cleanup", to: "cleanup_wait" },
    { from: "cleanup_wait", to: "cleanup" },
  ],
});
