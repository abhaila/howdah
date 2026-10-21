/**
 * draft-graph (HOW-56 T5; decisions 1A, 6A, E) — Howdah drafts a graph from a plain-language
 * request. `graphs:catalog` publishes what a drafter may use, then one read-only agent writes
 * `graph.draft` = { spec, prompts, based_on, notes }.
 *
 * The draft is published only if it would SAVE: the outputs check (engine/executors/outputs.ts
 * graphDraftProblem → core/graph-spec.ts checkGraphDraft) runs the builder's own verdict over it,
 * against the catalog this step READ — which is why `graph.draft` reads `graphs.catalog` and a
 * step that does not is refused closed (E). The first refusal is the executor's one repair turn;
 * a second fails the attempt and the run parks quoting every problem, and a reply re-runs the
 * step as a fresh visit. No loop of its own.
 *
 * `base` is not an input: run inputs are all required, so the agent declares `based_on` itself
 * and the prompt tells it to honour a base the intent names. There is no worktree step, so the
 * graph runs on a plain folder; the drafter only reads.
 */
import { buildGraph, type GraphSpec } from "../core/graph-spec";

export const spec: GraphSpec = {
  version: 1,
  name: "draft-graph",
  description: "Draft a new graph from a plain-language request, checked as if it were being saved",
  entry: "graphs.catalog",
  inputs: ["intent"],
  fields: [
    { key: "intent", kind: "text", scope: "sticky" },
    { key: "graphs.catalog", kind: "json", scope: "sticky" },
    { key: "graph.draft", kind: "json", scope: "sticky" },
  ],
  nodes: [
    { id: "graphs.catalog", kind: "command", run: "graphs:catalog", reads: [], writes: ["graphs.catalog"] },
    { id: "graph.draft", kind: "agent", prompt: "graph.draft", reads: ["graphs.catalog", "intent"], writes: ["graph.draft"], readOnly: true },
    { id: "done", kind: "terminal", outcome: "success" },
  ],
  edges: [
    { from: "graphs.catalog", to: "graph.draft" },
    { from: "graph.draft", to: "done" },
  ],
};

export const draftGraph = buildGraph(spec);
