/**
 * research — the second Plain-folder graph (shaping A8 / R5). No repo, no worktree, no
 * forge. Terminates on the reviewer's verdict; synthesis is capped so a picky reviewer
 * parks the run for the operator instead of burning visits forever.
 *
 *   plan → investigate → synthesize → review ─┬─pass───▶ done
 *                                             └─reject─▶ synthesize   (max 3 visits)
 *
 * B1 (HOW-31, docs/designs/graph-drafting.md): written as a `GraphSpec` literal compiled by
 * `buildGraph`, so the graph carries its own spec. The compiled `Graph` is identical, pinned
 * against a pre-conversion snapshot by `graphs/spec-equivalence.test.ts`. Freshness moved from
 * per-node-per-key to once per field; no key in any built-in is written at two scopes.
 */
import { buildGraph, type GraphSpec } from "../core/graph-spec";

export interface ResearchCtx {
  goal: string;
  research_questions: string;
  findings_summary: string;
  report_summary: string;
  review_verdict: "pass" | "reject";
  review_findings: unknown;
}

export const spec: GraphSpec = {
  version: 1,
  name: "research",
  description: "Plan, investigate, and synthesize a research question into a cited report",
  // Claude runs in auto mode by default; Codex uses full-access sandboxing in its executor.
  defaults: { permissionMode: "auto" },
  entry: "research.plan",
  inputs: ["goal"],
  fields: [
    { key: "goal", kind: "text", scope: "sticky" },
    { key: "research_questions", kind: "text", scope: "sticky" },
    { key: "findings_summary", kind: "text", scope: "sticky" },
    { key: "report_summary", kind: "text", scope: "sticky" },
    { key: "review_verdict", kind: "choice", scope: "cleared", choices: ["pass", "reject"] },
    { key: "review_findings", kind: "json", scope: "cleared" },
  ],
  nodes: [
    { id: "research.plan", kind: "agent", prompt: "research.plan", reads: ["goal"], writes: ["research_questions"] },
    {
      id: "research.investigate",
      kind: "agent",
      prompt: "research.investigate",
      reads: ["goal", "research_questions"],
      writes: ["findings_summary"],
    },
    {
      id: "research.synthesize",
      kind: "agent",
      prompt: "research.synthesize",
      reads: ["goal", "research_questions", "findings_summary"],
      writes: ["report_summary"],
      maxVisits: 3,
    },
    {
      id: "research.review",
      kind: "agent",
      prompt: "research.review",
      reads: ["goal", "report_summary"],
      writes: ["review_verdict", "review_findings"],
    },
    { id: "done", kind: "terminal", outcome: "success", label: "report approved" },
  ],
  edges: [
    { from: "research.plan", to: "research.investigate" },
    { from: "research.investigate", to: "research.synthesize" },
    { from: "research.synthesize", to: "research.review" },
    { from: "research.review", to: "research.synthesize", when: { op: "equals", key: "review_verdict", value: "reject" } },
    { from: "research.review", to: "done", when: { op: "equals", key: "review_verdict", value: "pass" } },
  ],
};

export const research = buildGraph(spec);
