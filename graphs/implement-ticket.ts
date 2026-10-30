/**
 * implement-ticket — ported from Orbital's DOT export (research/graphs/orb-implement-ticket.txt).
 *
 * The port collapses Orbital's fork problem: `implement-ticket-areeb` existed only to change
 * one prompt. Here the graph references `delivery.publish` by id and gets whatever version
 * the prompt store holds — currently v2, the first accepted reviser proposal.
 *
 *   create_worktree → plan → criteria → implement → verify.run → evidence → local_review ─┬─reject─▶ plan_review → implement_review ─┐
 *            ▲                                          ▲                                 └─pass───▶ report → publish → probe_pr ─┬─ MERGED ─▶ complete_ticket → cleanup_merged ─▶ complete
 *            │                                          └────────────────────────────────────────────────────────────────┘(loop)    ├─ CLOSED ─▶ cleanup_closed ─▶ closed
 *                                                                                      ├─ CONFLICTS/CI/CHANGES ─▶ repairs → repair_check ─┬─changed─▶ review_repairs ─┬─pass─▶ publish
 *                                                                                      │                                    └─no change─▶ wait 5m      └─reject─▶ revise ─▶ publish
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
 * fourteen edges (HOW-75: ten nodes, sixteen) are now written out here. `graphs/delivery.ts` stays: implement-slice still
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
 * HOW-52: `implementation.evidence` (`evidence:screenshot`) runs after `verify.run`, before
 * EVERY local review — after the first implementation and after each repair — so the reviewer judges the screens of
 * the code it is reviewing. The review uses `ticket.local_review`, a copy of
 * `implementation.local_review` that reads the evidence; improve-codebase shares the original
 * and has no evidence step, so it keeps it unchanged.
 *
 * HOW-51: the default-FAIL acceptance contract. `implementation.criteria` (read-only) opens it
 * from the ticket's checkboxes — or proposes criteria from the plan when there are none — with
 * every row failing; `implementation.local_review` (read-only, HOW-53) is the only node that
 * flips a row, and only on evidence real in this run (engine/executors/outputs.ts checkWrites);
 * `delivery.publish` will not start while a live criterion is unmet and unwaived. HOW-40's
 * `implementation.verify` (verify:run) runs before every review so the contract has the test
 * verdict to cite. The repair-side reviewer (delivery.review_repairs) does not write the contract:
 * its prompt is shared with improve-codebase, and the list it would re-judge was already settled
 * before the first publish, which is where the gate stands.
 *
 * HOW-54: on the two cycles, a step expected to change files (implement_review and
 * revise_repairs) that finishes with the worktree exactly as its previous visit left it parks
 * `no-progress` instead of sending the same code back round the loop. plan_review and publish
 * declare `changesFiles: false` — they plan and push, they do not edit — and the reviewers are
 * read-only, so none of those is ever mistaken for a stall.
 *
 * HOW-75: the three probe-driven repairs (resolve_conflicts, fix_ci, address_reviews) declare
 * `changesFiles: false` too, because changing nothing can be the RIGHT answer — every thread
 * already fixed, one answered and waiting on the reviewer. `delivery.repair_check`
 * (`repair:changed`) follows each: an unchanged repair skips review_repairs and publish and
 * waits for the PR to move; a probe that then asks for the same repair with nothing new on the
 * PR parks `repair-stalled` (core/repair-stall.ts), naming what is outstanding. This is a
 * behaviour change, so `fixtures/pre-spec-shapes.json`'s entry moved on purpose.
 *
 * HOW-78: `implementation.report` (read-only) runs once the local review passes, before publish,
 * and writes `change_map` — what the change is, as data. Howdah renders the run report from it
 * and the log (core/run-report.ts); no harness needs an artifact channel. A behaviour change, so
 * `fixtures/pre-spec-shapes.json`'s entry moved on purpose.
 *
 * `worktree.clean` IS NOW STRICT, as in improve-codebase: the hand-written edges tested
 * truthiness, `is-true` tests `=== true`. Every write site in `engine/executors/worktree.ts`
 * publishes a literal boolean, so they cannot disagree on a value the engine produces.
 */
import { buildGraph, type GraphSpec } from "../core/graph-spec";
import type { PrState } from "./delivery";
import type { ReviewItem } from "../core/review-activity";
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
  /** HOW-70: new review activity on the PR(s), handed to address_reviews */
  "pr.review_activity": ReviewItem[];
  /** HOW-75: did the repair that just ran change the worktree? (repair:changed) */
  "repair.changed": boolean;
  "worktree.clean": boolean;
  "verify.result": VerifyResult;
  /** HOW-44: the workspace's verify command ("" when none), published by create_worktree */
  "worktree.verify_command": string;
  /** HOW-59: the workspace preview's paths ("" when none), published by create_worktree */
  "worktree.preview_paths": string;
  "evidence.items": unknown;
  acceptance: unknown;
  /** HOW-78: what the change is, as data — the run report (core/run-report.ts) draws it */
  change_map: unknown;
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
    // HOW-70: the review items probe_pr found newer than the last address_reviews, for that step
    { key: "pr.review_activity", kind: "json", scope: "per-visit" },
    // HOW-75: whether the repair that just ran changed anything (repair:changed)
    { key: "repair.changed", kind: "boolean", scope: "per-visit" },
    { key: "worktree.clean", kind: "boolean", scope: "per-visit" },
    { key: "verify.result", kind: "json", scope: "per-visit" },
    { key: "worktree.verify_command", kind: "text", scope: "sticky" },
    { key: "worktree.preview_paths", kind: "text", scope: "sticky" },
    // HOW-52: what the reviewer LOOKS at — screenshots of the worktree's preview, per review
    { key: "evidence.items", kind: "json", scope: "per-visit" },
    // HOW-51: the default-FAIL contract — opened by the criteria step, flipped only by the evaluator
    { key: "acceptance", kind: "json", scope: "sticky" },
    // HOW-78: the change map the run report draws, re-written each time the build passes review
    { key: "change_map", kind: "json", scope: "sticky" },
  ],
  nodes: [
    // HOW-44: publishes the verify command so the build prompt can say the harness verifies after it
    { id: "create_worktree", kind: "worktree", action: "create", writes: ["worktree.verify_command", "worktree.preview_paths"] },

    { id: "implementation.plan", kind: "agent", prompt: "implementation.plan", reads: ["goal", "work"], writes: ["implementation_plan"], class: impl },
    // HOW-51: the criteria, from the ticket's checkboxes or proposed from the plan — all failing.
    // Read-only, because only a read-only node may write `acceptance` (core/graph.ts validate).
    { id: "implementation.criteria", kind: "agent", prompt: "ticket.acceptance", reads: ["goal", "work", "implementation_plan", "worktree.verify_command", "worktree.preview_paths"], writes: ["acceptance"], readOnly: true, class: impl },
    { id: "implementation.implement", kind: "agent", prompt: "implementation.implement", reads: ["goal", "work", "implementation_plan", "worktree.verify_command"], writes: ["implementation_summary"], class: impl },
    // HOW-40/HOW-52: the harness's own evidence, gathered before every review — the tests, run
    // in the worktree (`not-checked` with a reason when none), then the screens, captured from
    // the worktree's preview
    { id: "verify.run", kind: "command", run: "verify:run", reads: [], writes: ["verify.result"], class: impl },
    { id: "implementation.evidence", kind: "command", run: "evidence:screenshot", reads: [], writes: ["evidence.items"], class: impl },
    // HOW-51: the evaluator flips criteria on evidence — and so must be read-only (HOW-53)
    { id: "implementation.local_review", kind: "agent", prompt: "ticket.local_review", reads: ["goal", "work", "implementation_plan", "implementation_summary", "verify.result", "evidence.items", "acceptance"], writes: ["review_verdict", "review_findings", "acceptance"], readOnly: true, class: impl },
    // bounds local_review → plan_review → implement_review
    { id: "implementation.plan_review", kind: "agent", prompt: "implementation.plan_review", reads: ["goal", "work", "implementation_plan", "implementation_summary", "review_verdict", "review_findings"], writes: ["implementation_plan"], maxVisits: 3, changesFiles: false, class: impl },
    // HOW-78: map the change for the run report — read-only, after the build passes review and
    // before it is published, so the report describes the code that was judged
    { id: "implementation.report", kind: "agent", prompt: "implementation.report", reads: ["goal", "work", "implementation_plan", "implementation_summary"], writes: ["change_map"], readOnly: true, class: impl },
    { id: "implementation.implement_review", kind: "agent", prompt: "implementation.implement_review", reads: ["goal", "work", "implementation_plan", "implementation_summary", "review_verdict", "review_findings"], writes: ["implementation_summary"], class: impl },

    // ---- the delivery half, inlined from deliveryGraph({ verifyAfterRepair: false }) ----
    // HOW-51: nothing is published while a live criterion is unmet and unwaived
    { id: "delivery.publish", kind: "agent", prompt: "delivery.publish", reads: ["goal", "work", "acceptance"], writes: ["publication_summary"], maxVisits: 5, requiresAcceptance: true, changesFiles: false, class: deliv },
    // HOW-70: also publishes the review activity newer than the last address_reviews (core/review-activity.ts)
    { id: "delivery.probe_pr", kind: "command", run: "probe:pr", reads: ["publication_summary"], writes: ["pr.state", "pr.review_activity"], class: deliv },
    { id: "delivery.address_reviews", kind: "agent", prompt: "delivery.address_reviews", reads: ["goal", "work", "publication_summary", "review_verdict", "review_findings", "pr.review_activity"], writes: ["repair_summary"], changesFiles: false, class: deliv },
    { id: "delivery.fix_ci", kind: "agent", prompt: "delivery.fix_ci", reads: ["goal", "work", "publication_summary", "review_verdict", "review_findings"], writes: ["repair_summary"], changesFiles: false, class: deliv },
    { id: "delivery.resolve_conflicts", kind: "agent", prompt: "delivery.resolve_conflicts", reads: ["goal", "work", "publication_summary"], writes: ["repair_summary"], changesFiles: false, class: deliv },
    // HOW-53: read-only like local_review — a reviewer that can edit can pass its own fix
    // it judges the repairs' own diff, not the whole branch again (core/graph.ts reviewsWorkOf)
    { id: "delivery.review_repairs", kind: "agent", prompt: "delivery.review_repairs", reads: ["goal", "work", "publication_summary", "repair_summary"], writes: ["review_verdict", "review_findings"], readOnly: true, reviewsWorkOf: ["delivery.resolve_conflicts", "delivery.fix_ci", "delivery.address_reviews", "delivery.revise_repairs"], class: deliv },
    { id: "delivery.revise_repairs", kind: "agent", prompt: "delivery.revise_repairs", reads: ["goal", "work", "publication_summary", "repair_summary", "review_verdict", "review_findings"], writes: ["repair_summary"], maxVisits: 3, class: deliv },
    // HOW-75: the three repairs above may rightly change nothing (`changesFiles: false`); this
    // says whether they did, and an unchanged repair waits for the PR instead of review + publish
    { id: "delivery.repair_check", kind: "command", run: "repair:changed", reads: ["repair_summary"], writes: ["repair.changed"], class: deliv },
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
    { from: "implementation.plan", to: "implementation.criteria" },
    { from: "implementation.criteria", to: "implementation.implement" },
    { from: "implementation.implement", to: "verify.run" },
    { from: "verify.run", to: "implementation.evidence" },
    { from: "implementation.evidence", to: "implementation.local_review" },
    { from: "implementation.local_review", to: "implementation.plan_review", when: { op: "equals", key: "review_verdict", value: "reject" } },
    { from: "implementation.local_review", to: "implementation.report", when: { op: "equals", key: "review_verdict", value: "pass" } },
    { from: "implementation.report", to: "delivery.publish" },
    { from: "implementation.plan_review", to: "implementation.implement_review" },
    { from: "implementation.implement_review", to: "verify.run" },

    { from: "delivery.publish", to: "delivery.probe_pr" },
    { from: "delivery.probe_pr", to: "complete_ticket", when: { op: "equals", key: "pr.state", value: "MERGED" } },
    { from: "delivery.probe_pr", to: "cleanup_closed", when: { op: "equals", key: "pr.state", value: "CLOSED" } },
    { from: "delivery.probe_pr", to: "delivery.resolve_conflicts", when: { op: "equals", key: "pr.state", value: "CONFLICTS" } },
    { from: "delivery.probe_pr", to: "delivery.address_reviews", when: { op: "equals", key: "pr.state", value: "CHANGES_REQUIRED" } },
    { from: "delivery.probe_pr", to: "delivery.fix_ci", when: { op: "equals", key: "pr.state", value: "CI_FAILED" } },
    { from: "delivery.probe_pr", to: "delivery.wait" },

    { from: "delivery.address_reviews", to: "delivery.repair_check" },
    { from: "delivery.fix_ci", to: "delivery.repair_check" },
    { from: "delivery.resolve_conflicts", to: "delivery.repair_check" },
    { from: "delivery.repair_check", to: "delivery.wait", when: { op: "is-false", key: "repair.changed" } },
    { from: "delivery.repair_check", to: "delivery.review_repairs" },
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
