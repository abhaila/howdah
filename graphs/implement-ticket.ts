/**
 * implement-ticket — ported from Orbital's DOT export (research/graphs/orb-implement-ticket.txt).
 *
 * The port collapses Orbital's fork problem: `implement-ticket-areeb` existed only to change
 * one prompt. Here the graph references `delivery.publish` by id and gets whatever version
 * the prompt store holds — currently v2, the first accepted reviser proposal.
 *
 *   create_worktree → plan → implement → verify.run → local_review ─┬─reject─▶ plan_review → implement_review ─┐
 *            ▲                                ▲                     └─pass───▶ publish → probe_pr ─┬─ MERGED ─▶ complete_ticket → cleanup_merged ─▶ complete
 *            │                                └────────────────────────────────────────────────────┘(loop)    ├─ CLOSED ─▶ cleanup_closed ─▶ closed
 *                                                                                      ├─ CONFLICTS/CI/CHANGES ─▶ repairs → review_repairs ─┬─pass─▶ publish
 *                                                                                      │                                      └─reject─▶ revise ─▶ publish
 *                                                                                      └─ (fallback) wait 5m ─▶ probe_pr
 *
 * Loop bounds (system-map 0.3): every agent-driven loop parks for the operator instead of
 * spinning to maxSteps — plan_review ≤ 3 (local review keeps rejecting), revise_repairs ≤ 3
 * (repair review keeps rejecting, across repair cycles), publish ≤ 5 (repairs → publish →
 * probe keeps failing).
 * The probe_pr ⇄ wait poll is deliberately unbounded except by maxSteps: it waits on a
 * human reviewer, and time passing is not a failure. `howdah jump` resets these budgets.
 *
 * B1 (HOW-31, docs/designs/graph-drafting.md): written as a `GraphSpec` literal compiled by
 * `buildGraph`, so the graph carries its own spec and the builder can open it. The compiled
 * `Graph` is identical, pinned against the pre-conversion snapshot by
 * `graphs/spec-equivalence.test.ts`.
 *
 * THE DELIVERY HALF IS INLINED, and that is the cost of the conversion. It used to come from
 * `deliveryGraph({ verifyAfterRepair: false })` in `graphs/delivery.ts`, shared with
 * implement-slice. A `GraphSpec` is literal data with no call in it, so these nine nodes and
 * fourteen edges are now written out here. `graphs/delivery.ts` stays: implement-slice still
 * builds from it, and `improve-codebase` already carried its own copy of the same shape.
 * Operator decision, 2026-10-11: accept the duplication rather than add codegen.
 *
 * HOW-40: `verify.run` runs the workspace's verifyCommand after every implementation pass —
 * the first one and every implement_review repair — so local_review judges behavioural
 * evidence (`verify.result`, read through the shared `review._verify_result` partial) rather
 * than only the agent's own claims about which checks it ran. A failing suite still SUCCEEDS
 * the node (core/verify.ts): a red result is evidence for the reviewer, not a park. This is a
 * behaviour change, not a conversion, so `fixtures/pre-spec-shapes.json`'s implement-ticket
 * entry was updated on purpose (see spec-equivalence.test.ts).
 *
 * `worktree.clean` IS NOW STRICT, as in improve-codebase: the hand-written edges tested
 * truthiness, `is-true` tests `=== true`. Every write site in `engine/executors/worktree.ts`
 * publishes a literal boolean, so they cannot disagree on a value the engine produces.
 */
import { buildGraph, type GraphSpec } from "../core/graph-spec";
import type { PrState } from "./delivery";
import type { VerifyResult } from "../core/verify";

export type { PrState };

export interface ImplementTicketCtx {
  goal: string;
  work: string;
  implementation_plan: string;
  implementation_summary: string;
  review_verdict: "pass" | "reject";
  review_findings: unknown;
  publication_summary: string;
  repair_summary: string;
  completion_summary: string;
  "pr.state": PrState;
  "worktree.clean": boolean;
  "verify.result": VerifyResult;
  /** HOW-44: the workspace's verify command ("" when none), published by create_worktree */
  "worktree.verify_command": string;
}

const impl = "implementation";
const deliv = "delivery";

export const spec: GraphSpec = {
  version: 1,
  name: "implement-ticket",
  description: "Deliver one ticket through reviewed implementation and a merged PR",
  // Claude runs in auto mode by default; Codex uses full-access sandboxing in its executor.
  defaults: { permissionMode: "auto" },
  entry: "create_worktree",
  inputs: ["goal", "work"],
  fields: [
    { key: "goal", kind: "text", scope: "sticky" },
    { key: "work", kind: "text", scope: "sticky" },
    { key: "implementation_plan", kind: "text", scope: "sticky" },
    { key: "implementation_summary", kind: "text", scope: "sticky" },
    { key: "review_verdict", kind: "choice", scope: "cleared", choices: ["pass", "reject"] },
    { key: "review_findings", kind: "json", scope: "cleared" },
    { key: "publication_summary", kind: "text", scope: "sticky" },
    { key: "repair_summary", kind: "text", scope: "sticky" },
    { key: "completion_summary", kind: "text", scope: "sticky" },
    {
      key: "pr.state",
      kind: "choice",
      scope: "per-visit",
      choices: ["OPEN", "MERGED", "CLOSED", "CONFLICTS", "CI_FAILED", "CHANGES_REQUIRED"],
    },
    { key: "worktree.clean", kind: "boolean", scope: "per-visit" },
    { key: "verify.result", kind: "json", scope: "per-visit" },
    { key: "worktree.verify_command", kind: "text", scope: "sticky" },
  ],
  nodes: [
    // HOW-44: publishes the verify command so the build prompt can say the harness verifies after it
    { id: "create_worktree", kind: "worktree", action: "create", writes: ["worktree.verify_command"] },

    { id: "implementation.plan", kind: "agent", prompt: "implementation.plan", reads: ["goal", "work"], writes: ["implementation_plan"], class: impl },
    { id: "implementation.implement", kind: "agent", prompt: "implementation.implement", reads: ["goal", "work", "implementation_plan", "worktree.verify_command"], writes: ["implementation_summary"], class: impl },
    // HOW-40: the workspace's verifyCommand, run in the worktree (`not-checked` with a reason when none)
    { id: "verify.run", kind: "command", run: "verify:run", reads: [], writes: ["verify.result"], class: impl },
    { id: "implementation.local_review", kind: "agent", prompt: "implementation.local_review", reads: ["goal", "work", "implementation_plan", "implementation_summary", "verify.result"], writes: ["review_verdict", "review_findings"], class: impl },
    // bounds local_review → plan_review → implement_review
    { id: "implementation.plan_review", kind: "agent", prompt: "implementation.plan_review", reads: ["goal", "work", "implementation_plan", "implementation_summary", "review_verdict", "review_findings"], writes: ["implementation_plan"], maxVisits: 3, class: impl },
    { id: "implementation.implement_review", kind: "agent", prompt: "implementation.implement_review", reads: ["goal", "work", "implementation_plan", "implementation_summary", "review_verdict", "review_findings"], writes: ["implementation_summary"], class: impl },

    // ---- the delivery half, inlined from deliveryGraph({ verifyAfterRepair: false }) ----
    { id: "delivery.publish", kind: "agent", prompt: "delivery.publish", reads: ["goal", "work"], writes: ["publication_summary"], maxVisits: 5, class: deliv },
    { id: "delivery.probe_pr", kind: "command", run: "probe:pr", reads: ["publication_summary"], writes: ["pr.state"], class: deliv },
    { id: "delivery.address_reviews", kind: "agent", prompt: "delivery.address_reviews", reads: ["goal", "work", "publication_summary", "review_verdict", "review_findings"], writes: ["repair_summary"], class: deliv },
    { id: "delivery.fix_ci", kind: "agent", prompt: "delivery.fix_ci", reads: ["goal", "work", "publication_summary", "review_verdict", "review_findings"], writes: ["repair_summary"], class: deliv },
    { id: "delivery.resolve_conflicts", kind: "agent", prompt: "delivery.resolve_conflicts", reads: ["goal", "work", "publication_summary"], writes: ["repair_summary"], class: deliv },
    { id: "delivery.review_repairs", kind: "agent", prompt: "delivery.review_repairs", reads: ["goal", "work", "publication_summary", "repair_summary"], writes: ["review_verdict", "review_findings"], class: deliv },
    { id: "delivery.revise_repairs", kind: "agent", prompt: "delivery.revise_repairs", reads: ["goal", "work", "publication_summary", "repair_summary", "review_verdict", "review_findings"], writes: ["repair_summary"], maxVisits: 3, class: deliv },
    { id: "delivery.wait", kind: "wait", duration: "5m", class: deliv },

    { id: "complete_ticket", kind: "agent", prompt: "complete_ticket", reads: ["goal", "work", "publication_summary"], writes: ["completion_summary"] },
    { id: "cleanup_merged", kind: "worktree", action: "remove", writes: ["worktree.clean"] },
    { id: "cleanup_closed", kind: "worktree", action: "remove", writes: ["worktree.clean"] },
    { id: "complete", kind: "terminal", outcome: "success" },
    { id: "closed", kind: "terminal", outcome: "aborted" },
    { id: "cleanup_pending", kind: "terminal", outcome: "failed", label: "Worktree retained to preserve local work" },
  ],
  edges: [
    { from: "create_worktree", to: "implementation.plan" },
    { from: "implementation.plan", to: "implementation.implement" },
    { from: "implementation.implement", to: "verify.run" },
    { from: "verify.run", to: "implementation.local_review" },
    { from: "implementation.local_review", to: "implementation.plan_review", when: { op: "equals", key: "review_verdict", value: "reject" } },
    { from: "implementation.local_review", to: "delivery.publish", when: { op: "equals", key: "review_verdict", value: "pass" } },
    { from: "implementation.plan_review", to: "implementation.implement_review" },
    { from: "implementation.implement_review", to: "verify.run" },

    { from: "delivery.publish", to: "delivery.probe_pr" },
    { from: "delivery.probe_pr", to: "complete_ticket", when: { op: "equals", key: "pr.state", value: "MERGED" } },
    { from: "delivery.probe_pr", to: "cleanup_closed", when: { op: "equals", key: "pr.state", value: "CLOSED" } },
    { from: "delivery.probe_pr", to: "delivery.resolve_conflicts", when: { op: "equals", key: "pr.state", value: "CONFLICTS" } },
    { from: "delivery.probe_pr", to: "delivery.address_reviews", when: { op: "equals", key: "pr.state", value: "CHANGES_REQUIRED" } },
    { from: "delivery.probe_pr", to: "delivery.fix_ci", when: { op: "equals", key: "pr.state", value: "CI_FAILED" } },
    { from: "delivery.probe_pr", to: "delivery.wait" },

    { from: "delivery.address_reviews", to: "delivery.review_repairs" },
    { from: "delivery.fix_ci", to: "delivery.review_repairs" },
    { from: "delivery.resolve_conflicts", to: "delivery.review_repairs" },
    { from: "delivery.review_repairs", to: "delivery.revise_repairs", when: { op: "equals", key: "review_verdict", value: "reject" } },
    { from: "delivery.review_repairs", to: "delivery.publish", when: { op: "equals", key: "review_verdict", value: "pass" } },
    { from: "delivery.revise_repairs", to: "delivery.publish" },
    { from: "delivery.wait", to: "delivery.probe_pr" },

    { from: "complete_ticket", to: "cleanup_merged" },
    { from: "cleanup_merged", to: "complete", when: { op: "is-true", key: "worktree.clean" } },
    { from: "cleanup_merged", to: "cleanup_pending" },
    { from: "cleanup_closed", to: "closed", when: { op: "is-true", key: "worktree.clean" } },
    { from: "cleanup_closed", to: "cleanup_pending" },
  ],
};

export const implementTicket = buildGraph(spec);
