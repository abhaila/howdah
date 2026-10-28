/**
 * HOW-73 test fixture: a fork/join graph, NOT registered in the catalog (no built-in graph
 * changes). Three read-only reviewers run at once over one build, then the run joins.
 *
 *   build (command) → fan (parallel: review_security | review_tests | review_ux) → join
 *
 * `parallelReview()` joins straight to a terminal. `parallelReviewRouted()` joins to a command
 * step whose conditional edges read two branches' verdicts — routing on the merged context.
 * Each comes hand-written (defineGraph) and as a GraphSpec, so the spec round trip is pinned
 * against the hand-written graph (graphs/spec-shape.ts shapeOf).
 *
 * The prompt ids are existing ones, chosen only because PromptId is a generated union; the
 * engine tests pin bodies of their own from a temp prompts dir.
 */
import { defineGraph, type NodeDef } from "../../core/graph";
import type { GraphSpec } from "../../core/graph-spec";

export interface ParallelCtx {
  goal: string;
  summary: string;
  security: "pass" | "reject";
  tests: "pass" | "reject";
  ux: "pass" | "reject";
  decision: string;
}

/** the three prompt ids the reviewers use, and a body for each that reads goal + summary */
export const PARALLEL_PROMPTS = {
  "implementation.local_review": "Review security of {{ context.summary }} for {{ context.goal }}.\n",
  "doc.review": "Review tests of {{ context.summary }} for {{ context.goal }}.\n",
  "implementation.plan_review": "Review UX of {{ context.summary }} for {{ context.goal }}.\n",
} as const;

/** fresh objects per graph: a test that tunes one graph's node must not reach the next graph */
const reviewers = (): Record<"review_security" | "review_tests" | "review_ux", NodeDef<ParallelCtx>> => ({
  review_security: { kind: "agent", prompt: "implementation.local_review", reads: ["goal", "summary"], writes: { security: { scope: "cleared" } }, readOnly: true },
  review_tests: { kind: "agent", prompt: "doc.review", reads: ["goal", "summary"], writes: { tests: { scope: "cleared" } }, readOnly: true },
  review_ux: { kind: "agent", prompt: "implementation.plan_review", reads: ["goal", "summary"], writes: { ux: { scope: "cleared" } }, readOnly: true },
});

export function parallelReview(opts: { concurrency?: number } = {}) {
  return defineGraph<ParallelCtx>({
    name: "parallel-review",
    entry: "build",
    inputs: ["goal"],
    nodes: {
      build: { kind: "command", run: "make build", reads: ["goal"], writes: { summary: { scope: "sticky" } } },
      fan: { kind: "parallel", branches: ["review_security", "review_tests", "review_ux"], join: "done", ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}) },
      ...reviewers(),
      done: { kind: "terminal", outcome: "success" },
    },
    edges: [{ from: "build", to: "fan" }],
  });
}

export function parallelReviewRouted() {
  return defineGraph<ParallelCtx>({
    name: "parallel-review-routed",
    entry: "build",
    inputs: ["goal"],
    nodes: {
      build: { kind: "command", run: "make build", reads: ["goal"], writes: { summary: { scope: "sticky" } } },
      fan: { kind: "parallel", branches: ["review_security", "review_tests", "review_ux"], join: "decide" },
      ...reviewers(),
      decide: { kind: "command", run: "true", reads: ["security", "tests", "ux"], writes: { decision: { scope: "per-visit" } }, changesFiles: false },
      done: { kind: "terminal", outcome: "success" },
      rejected: { kind: "terminal", outcome: "failed" },
    },
    edges: [
      { from: "build", to: "fan" },
      { from: "decide", to: "rejected", condition: { reads: ["security"], test: (v) => v.security === "reject", label: "security == 'reject'" }, weight: 2 },
      { from: "decide", to: "rejected", condition: { reads: ["tests"], test: (v) => v.tests === "reject", label: "tests == 'reject'" }, weight: 1 },
      { from: "decide", to: "done" },
    ],
  });
}

const fields: GraphSpec["fields"] = [
  { key: "goal", kind: "text", scope: "sticky" },
  { key: "summary", kind: "text", scope: "sticky" },
  { key: "security", kind: "choice", choices: ["pass", "reject"], scope: "cleared" },
  { key: "tests", kind: "choice", choices: ["pass", "reject"], scope: "cleared" },
  { key: "ux", kind: "choice", choices: ["pass", "reject"], scope: "cleared" },
  { key: "decision", kind: "text", scope: "per-visit" },
];

const reviewerSpecs: GraphSpec["nodes"] = [
  { id: "review_security", kind: "agent", prompt: "implementation.local_review", reads: ["goal", "summary"], writes: ["security"], readOnly: true },
  { id: "review_tests", kind: "agent", prompt: "doc.review", reads: ["goal", "summary"], writes: ["tests"], readOnly: true },
  { id: "review_ux", kind: "agent", prompt: "implementation.plan_review", reads: ["goal", "summary"], writes: ["ux"], readOnly: true },
];

export const PARALLEL_REVIEW_SPEC: GraphSpec = {
  version: 1,
  name: "parallel-review",
  description: "",
  fields,
  inputs: ["goal"],
  entry: "build",
  nodes: [
    { id: "build", kind: "command", run: "make build", reads: ["goal"], writes: ["summary"] },
    { id: "fan", kind: "parallel", branches: ["review_security", "review_tests", "review_ux"], join: "done" },
    ...reviewerSpecs,
    { id: "done", kind: "terminal", outcome: "success" },
  ],
  edges: [{ from: "build", to: "fan" }],
};

export const PARALLEL_REVIEW_ROUTED_SPEC: GraphSpec = {
  version: 1,
  name: "parallel-review-routed",
  description: "",
  fields,
  inputs: ["goal"],
  entry: "build",
  nodes: [
    { id: "build", kind: "command", run: "make build", reads: ["goal"], writes: ["summary"] },
    { id: "fan", kind: "parallel", branches: ["review_security", "review_tests", "review_ux"], join: "decide" },
    ...reviewerSpecs,
    { id: "decide", kind: "command", run: "true", reads: ["security", "tests", "ux"], writes: ["decision"], changesFiles: false },
    { id: "done", kind: "terminal", outcome: "success" },
    { id: "rejected", kind: "terminal", outcome: "failed" },
  ],
  edges: [
    { from: "build", to: "fan" },
    { from: "decide", to: "rejected", when: { key: "security", op: "equals", value: "reject" } },
    { from: "decide", to: "rejected", when: { key: "tests", op: "equals", value: "reject" } },
    { from: "decide", to: "done" },
  ],
};
