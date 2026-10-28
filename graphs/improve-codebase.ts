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
 *
 * B1 (HOW-31, docs/designs/graph-drafting.md): written as a `GraphSpec` literal compiled by
 * `buildGraph`, so the graph carries its own spec. Two differences from the hand-written
 * form, both checked and both behaviour-preserving:
 *
 * WEIGHTS ARE OFFSET, ORDER IS NOT. probe_pr's five conditions were 6..2 by hand and compile
 * to 5..1. `engine/run.ts:708` picks the highest-weight PASSING condition, so only the
 * ranking matters; `graphs/spec-shape.ts` compares rank for exactly this reason.
 *
 * `worktree.clean == true` IS NOW STRICT. The hand-written test was `(v) => v["worktree.clean"]`,
 * truthy; the `is-true` predicate is `=== true`. Every write site in
 * `engine/executors/worktree.ts` (:75, :81, :87, :93) publishes a literal boolean, so the two
 * cannot disagree on any value the engine produces. Where they would differ — a malformed
 * non-boolean — strict is the better answer: the run parks rather than routing on a value
 * nothing declared. Pinned in `graphs/spec-equivalence.test.ts`.
 */
import { buildGraph, type GraphSpec } from "../core/graph-spec";
import type { PrState } from "./implement-ticket";
import type { ReviewItem } from "../core/review-activity";

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
  /** HOW-70: new review activity on the PR(s), handed to address_reviews */
  "pr.review_activity": ReviewItem[];
  "worktree.clean": boolean;
  outcome: "removed" | "failed";
}

const impl = "implementation";
const deliv = "delivery";

export const spec: GraphSpec = {
  version: 1,
  name: "improve-codebase",
  description: "Continuously discover and deliver one worthwhile codebase improvement at a time",
  // Claude runs in auto mode by default; Codex uses full-access sandboxing in its executor.
  defaults: { permissionMode: "auto" },
  entry: "discover",
  inputs: ["goal"],
  fields: [
    { key: "goal", kind: "text", scope: "sticky" },
    { key: "discovery", kind: "choice", scope: "per-visit", choices: ["candidate", "idle"] },
    { key: "work", kind: "text", scope: "sticky" },
    { key: "implementation_plan", kind: "text", scope: "sticky" },
    { key: "implementation_summary", kind: "text", scope: "sticky" },
    { key: "review_verdict", kind: "choice", scope: "cleared", choices: ["pass", "reject"] },
    { key: "review_findings", kind: "json", scope: "cleared" },
    { key: "publication_summary", kind: "text", scope: "sticky" },
    { key: "repair_summary", kind: "text", scope: "sticky" },
    {
      key: "pr.state",
      kind: "choice",
      scope: "per-visit",
      choices: ["OPEN", "MERGED", "CLOSED", "CONFLICTS", "CI_FAILED", "CHANGES_REQUIRED"],
    },
    // HOW-70: the review items probe_pr found newer than the last address_reviews, for that step
    { key: "pr.review_activity", kind: "json", scope: "per-visit" },
    { key: "worktree.clean", kind: "boolean", scope: "per-visit" },
    { key: "outcome", kind: "choice", scope: "per-visit", choices: ["removed", "failed"] },
  ],
  nodes: [
    { id: "discover", kind: "agent", prompt: "discover", reads: ["goal"], writes: ["discovery", "work"] },
    { id: "idle_wait", kind: "wait", duration: "30m" },
    { id: "create_worktree", kind: "worktree", action: "create", writes: [] },

    { id: "implementation.plan", kind: "agent", prompt: "implementation.plan", reads: ["goal", "work"], writes: ["implementation_plan"], class: impl },
    { id: "implementation.implement", kind: "agent", prompt: "implementation.implement", reads: ["goal", "work", "implementation_plan"], writes: ["implementation_summary"], class: impl },
    { id: "implementation.local_review", kind: "agent", prompt: "implementation.local_review", reads: ["goal", "work", "implementation_plan", "implementation_summary"], writes: ["review_verdict", "review_findings"], readOnly: true, class: impl },
    // HOW-54: plans, never edits — so a visit that changes no file is not a stalled loop
    { id: "implementation.plan_review", kind: "agent", prompt: "implementation.plan_review", reads: ["goal", "work", "implementation_plan", "implementation_summary", "review_verdict", "review_findings"], writes: ["implementation_plan"], changesFiles: false, class: impl },
    { id: "implementation.implement_review", kind: "agent", prompt: "implementation.implement_review", reads: ["goal", "work", "implementation_plan", "implementation_summary", "review_verdict", "review_findings"], writes: ["implementation_summary"], class: impl },

    // v2, shared with implement-ticket
    { id: "delivery.publish", kind: "agent", prompt: "delivery.publish", reads: ["goal", "work"], writes: ["publication_summary"], changesFiles: false, class: deliv },
    // HOW-70: also publishes the review activity newer than the last address_reviews (core/review-activity.ts)
    { id: "delivery.probe_pr", kind: "command", run: "probe:pr", reads: ["publication_summary"], writes: ["pr.state", "pr.review_activity"], class: deliv },
    { id: "delivery.address_reviews", kind: "agent", prompt: "delivery.address_reviews", reads: ["goal", "work", "publication_summary", "review_verdict", "review_findings", "pr.review_activity"], writes: ["repair_summary"], class: deliv },
    { id: "delivery.fix_ci", kind: "agent", prompt: "delivery.fix_ci", reads: ["goal", "work", "publication_summary", "review_verdict", "review_findings"], writes: ["repair_summary"], class: deliv },
    { id: "delivery.resolve_conflicts", kind: "agent", prompt: "delivery.resolve_conflicts", reads: ["goal", "work", "publication_summary"], writes: ["repair_summary"], class: deliv },
    // HOW-53: the review nodes are read-only — a reviewer that can edit can pass its own fix
    // it judges the repairs' own diff, not the whole branch again (core/graph.ts reviewsWorkOf)
    { id: "delivery.review_repairs", kind: "agent", prompt: "delivery.review_repairs", reads: ["goal", "work", "publication_summary", "repair_summary"], writes: ["review_verdict", "review_findings"], readOnly: true, reviewsWorkOf: ["delivery.resolve_conflicts", "delivery.fix_ci", "delivery.address_reviews", "delivery.revise_repairs"], class: deliv },
    { id: "delivery.revise_repairs", kind: "agent", prompt: "delivery.revise_repairs", reads: ["goal", "work", "publication_summary", "repair_summary", "review_verdict", "review_findings"], writes: ["repair_summary"], class: deliv },
    { id: "delivery.wait", kind: "wait", duration: "5m", class: deliv },

    { id: "cleanup", kind: "worktree", action: "remove", writes: ["worktree.clean", "outcome"] },
    { id: "cleanup_wait", kind: "wait", duration: "5m" },
  ],
  edges: [
    { from: "discover", to: "create_worktree", when: { op: "equals", key: "discovery", value: "candidate" } },
    { from: "discover", to: "idle_wait", when: { op: "equals", key: "discovery", value: "idle" } },
    { from: "idle_wait", to: "discover" },

    { from: "create_worktree", to: "implementation.plan" },
    { from: "implementation.plan", to: "implementation.implement" },
    { from: "implementation.implement", to: "implementation.local_review" },
    { from: "implementation.local_review", to: "implementation.plan_review", when: { op: "equals", key: "review_verdict", value: "reject" } },
    { from: "implementation.local_review", to: "delivery.publish", when: { op: "equals", key: "review_verdict", value: "pass" } },
    { from: "implementation.plan_review", to: "implementation.implement_review" },
    { from: "implementation.implement_review", to: "implementation.local_review" },

    { from: "delivery.publish", to: "delivery.probe_pr" },
    { from: "delivery.probe_pr", to: "cleanup", when: { op: "equals", key: "pr.state", value: "MERGED" } },
    { from: "delivery.probe_pr", to: "cleanup", when: { op: "equals", key: "pr.state", value: "CLOSED" } },
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

    { from: "cleanup", to: "cleanup_wait", when: { op: "equals", key: "outcome", value: "failed" } },
    { from: "cleanup", to: "discover", when: { op: "is-true", key: "worktree.clean" } },
    { from: "cleanup", to: "cleanup_wait" },
    { from: "cleanup_wait", to: "cleanup" },
  ],
};

export const improveCodebase = buildGraph(spec);
