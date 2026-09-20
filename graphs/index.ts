/**
 * Graph registry — the launcher's menu (T15). Every runnable graph is exported here;
 * `howdah new-graph` (T20) appends to this file. Each entry is validated at import time,
 * so a broken graph fails the registry, not a run.
 */
import type { Graph } from "../core/graph";
import { implementTicket } from "./implement-ticket";
import { implementSlice } from "./implement-slice";
import { improveCodebase } from "./improve-codebase";
import { reviewTeammatePr } from "./review-teammate-pr";
import { writeDoc } from "./write-doc";
import { research } from "./research";
import { quickTask } from "./quick-task";

export const GRAPHS: Record<string, Graph<any>> = {
  [implementTicket.def.name]: implementTicket,
  [implementSlice.def.name]: implementSlice,
  [improveCodebase.def.name]: improveCodebase,
  [reviewTeammatePr.def.name]: reviewTeammatePr,
  [writeDoc.def.name]: writeDoc,
  [research.def.name]: research,
  [quickTask.def.name]: quickTask,
};

for (const g of Object.values(GRAPHS)) g.validateOrThrow();

/** what the start-run form needs to render */
export function graphCatalog(): Array<{ name: string; description: string; inputs: string[]; kind: "repo" | "plain" }> {
  return Object.values(GRAPHS).map((g) => ({
    name: g.def.name,
    description: g.def.description ?? "",
    inputs: [...g.def.inputs],
    // a graph with a worktree node needs a repo; everything else runs on a plain folder
    kind: Object.values(g.def.nodes).some((n) => n.kind === "worktree") ? "repo" : "plain",
  }));
}
