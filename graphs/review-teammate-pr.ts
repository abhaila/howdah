/**
 * review-teammate-pr — ported from Orbital. Linear pipeline, three read-only review lenses:
 *
 *   create_worktree → pull_pr → sonarqube → uncle_bob → seq_review → compile report → complete
 *
 * B1 (HOW-31, docs/designs/graph-drafting.md): written as a `GraphSpec` literal compiled by
 * `buildGraph`, so the graph carries its own spec. The compiled `Graph` is identical, pinned
 * against the pre-conversion snapshot by `graphs/spec-equivalence.test.ts`. Freshness moved
 * from per-node-per-key to once per field; no key in any built-in is written at two scopes.
 *
 * `goal` is an input no step reads. It stays declared because the launch form offers it and
 * dropping it would change what a run is started with, which is not what a conversion does.
 */
import { buildGraph, type GraphSpec } from "../core/graph-spec";

export interface ReviewTeammatePrCtx {
  goal: string;
  pull_request: string;
  pr_context: string;
  sonarqube_findings: unknown;
  uncle_bob_findings: unknown;
  seq_review_findings: unknown;
  report_path: string;
  finding_counts: unknown;
}

export const spec: GraphSpec = {
  version: 1,
  name: "review-teammate-pr",
  description:
    "Pull a teammate's PR into a local worktree and run three read-only reviews in sequence, then compile every finding into one color-coded local report",
  // Claude runs in auto mode by default; Codex uses full-access sandboxing in its executor.
  defaults: { permissionMode: "auto" },
  entry: "create_worktree",
  inputs: ["goal", "pull_request"],
  fields: [
    { key: "goal", kind: "text", scope: "sticky" },
    { key: "pull_request", kind: "text", scope: "sticky" },
    { key: "pr_context", kind: "text", scope: "sticky" },
    { key: "sonarqube_findings", kind: "json", scope: "sticky" },
    { key: "uncle_bob_findings", kind: "json", scope: "sticky" },
    { key: "seq_review_findings", kind: "json", scope: "sticky" },
    { key: "report_path", kind: "text", scope: "sticky" },
    { key: "finding_counts", kind: "json", scope: "sticky" },
  ],
  nodes: [
    { id: "create_worktree", kind: "worktree", action: "create", writes: [] },
    { id: "checkout.pull_pr", kind: "agent", prompt: "checkout.pull_pr", reads: ["pull_request"], writes: ["pr_context"] },
    { id: "review.sonarqube", kind: "agent", prompt: "review.sonarqube", reads: ["pr_context"], writes: ["sonarqube_findings"] },
    { id: "review.uncle_bob", kind: "agent", prompt: "review.uncle_bob", reads: ["pr_context"], writes: ["uncle_bob_findings"] },
    { id: "review.seq_review", kind: "agent", prompt: "review.seq_review", reads: ["pr_context"], writes: ["seq_review_findings"] },
    {
      id: "report.compile",
      kind: "agent",
      prompt: "report.compile",
      reads: ["pr_context", "sonarqube_findings", "uncle_bob_findings", "seq_review_findings"],
      writes: ["report_path", "finding_counts"],
    },
    { id: "complete", kind: "terminal", outcome: "success" },
  ],
  edges: [
    { from: "create_worktree", to: "checkout.pull_pr" },
    { from: "checkout.pull_pr", to: "review.sonarqube" },
    { from: "review.sonarqube", to: "review.uncle_bob" },
    { from: "review.uncle_bob", to: "review.seq_review" },
    { from: "review.seq_review", to: "report.compile" },
    { from: "report.compile", to: "complete" },
  ],
};

export const reviewTeammatePr = buildGraph(spec);
