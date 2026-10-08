/**
 * quick-task — scaffolded by `howdah new-graph --kind custom`. The smallest legal graph:
 * one agent, one terminal. Grow it node by node; validate() gates every shape.
 *
 * B1 (HOW-31, docs/designs/graph-drafting.md): written as a `GraphSpec` literal compiled by
 * `buildGraph`, so the graph carries its own spec. The compiled `Graph` is identical, pinned
 * against a pre-conversion snapshot by `graphs/spec-equivalence.test.ts`. Freshness moved from
 * per-node-per-key to once per field; no key in any built-in is written at two scopes.
 */
import { buildGraph, type GraphSpec } from "../core/graph-spec";

export interface QuickTaskCtx {
  goal: string;
  summary: string;
}

export const spec: GraphSpec = {
  version: 1,
  name: "quick-task",
  description: "TODO: one line on what this graph does",
  // Claude runs in auto mode by default; Codex uses full-access sandboxing in its executor.
  defaults: { permissionMode: "auto" },
  entry: "quick-task.work",
  inputs: ["goal"],
  fields: [
    { key: "goal", kind: "text", scope: "sticky" },
    { key: "summary", kind: "text", scope: "sticky" },
  ],
  nodes: [
    { id: "quick-task.work", kind: "agent", prompt: "quick-task.work", reads: ["goal"], writes: ["summary"] },
    { id: "done", kind: "terminal", outcome: "success" },
  ],
  edges: [{ from: "quick-task.work", to: "done" }],
};

export const quickTask = buildGraph(spec);
