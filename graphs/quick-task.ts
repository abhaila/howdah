/**
 * quick-task — scaffolded by `howdah new-graph --kind custom`. The smallest legal graph:
 * one agent, one terminal. Grow it node by node; validate() gates every shape.
 */
import { defineGraph } from "../core/graph";

export interface QuickTaskCtx {
  goal: string;
  summary: string;
}

export const quickTask = defineGraph<QuickTaskCtx>({
  name: "quick-task",
  // agents act without tool-permission prompts; real questions still raise asks
  defaults: { permissionMode: "auto" },
  description: "TODO: one line on what this graph does",
  entry: "quick-task.work",
  inputs: ["goal"],
  nodes: {
    "quick-task.work": {
      kind: "agent",
      prompt: "quick-task.work",
      reads: ["goal"],
      writes: { summary: { scope: "sticky" } },
    },
    done: { kind: "terminal", outcome: "success" },
  },
  edges: [{ from: "quick-task.work", to: "done" }],
});
