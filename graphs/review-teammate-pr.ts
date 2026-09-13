/**
 * review-teammate-pr — ported from Orbital. Linear pipeline, three read-only review lenses:
 *
 *   create_worktree → pull_pr → sonarqube → uncle_bob → seq_review → compile report → complete
 */
import { defineGraph } from "../core/graph";

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

const sticky = { scope: "sticky" } as const;

export const reviewTeammatePr = defineGraph<ReviewTeammatePrCtx>({
  name: "review-teammate-pr",
  description:
    "Pull a teammate's PR into a local worktree and run three read-only reviews in sequence, then compile every finding into one color-coded local report",
  entry: "create_worktree",
  inputs: ["goal", "pull_request"],
  nodes: {
    create_worktree: { kind: "worktree", action: "create" },
    "checkout.pull_pr": {
      kind: "agent",
      prompt: "checkout.pull_pr",
      reads: ["pull_request"],
      writes: { pr_context: sticky },
    },
    "review.sonarqube": {
      kind: "agent",
      prompt: "review.sonarqube",
      reads: ["pr_context"],
      writes: { sonarqube_findings: sticky },
    },
    "review.uncle_bob": {
      kind: "agent",
      prompt: "review.uncle_bob",
      reads: ["pr_context"],
      writes: { uncle_bob_findings: sticky },
    },
    "review.seq_review": {
      kind: "agent",
      prompt: "review.seq_review",
      reads: ["pr_context"],
      writes: { seq_review_findings: sticky },
    },
    "report.compile": {
      kind: "agent",
      prompt: "report.compile",
      reads: ["pr_context", "sonarqube_findings", "uncle_bob_findings", "seq_review_findings"],
      writes: { report_path: sticky, finding_counts: sticky },
    },
    complete: { kind: "terminal", outcome: "success" },
  },
  edges: [
    { from: "create_worktree", to: "checkout.pull_pr" },
    { from: "checkout.pull_pr", to: "review.sonarqube" },
    { from: "review.sonarqube", to: "review.uncle_bob" },
    { from: "review.uncle_bob", to: "review.seq_review" },
    { from: "review.seq_review", to: "report.compile" },
    { from: "report.compile", to: "complete" },
  ],
});
