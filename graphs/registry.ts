/**
 * The one place that answers "what graphs can this machine run". Built-ins (`graphs/index.ts`,
 * compile-checked and validated at import) plus the operator's own from `$HOWDAH_HOME`
 * (`graphs/local.ts`, validated at load).
 *
 * Built-ins win a name collision, and the shadowed local graph is reported as a problem
 * rather than dropped: a local `write-doc` that silently never ran would be a mystery, and
 * silently REPLACING a built-in would be worse — a run named `write-doc` has to mean the same
 * thing tomorrow.
 *
 * Async because local graphs are dynamically imported. Callers that only need built-ins
 * (prompt library, proposals) keep using GRAPHS directly and stay synchronous.
 */
import { buildGraph, specOf } from "../core/graph-spec";
import { STACKED_GRAPH, STACKED_GRAPH_LAUNCHED_BY, stackedGraphName } from "../core/stack";
import type { Graph } from "../core/graph";
import { stackedFrom } from "./implement-stacked";
import { GRAPHS } from "./index";
import { loadLocalGraphs, type LocalGraphProblem } from "./local";

export type GraphSource = "builtin" | "local";

export interface CatalogEntry {
  name: string;
  description: string;
  inputs: string[];
  /** a graph only another graph starts (its inputs name runs only that parent knows): New run hides it */
  launched_by?: string;
  /** a graph with a worktree node needs a repo; everything else runs on a plain folder */
  kind: "repo" | "plain";
  source: GraphSource;
  /**
   * HOW-22: can the graph builder re-open this one? True only for a LOCAL graph that still
   * carries the spec it was built from. A hand-written graph — or a builder graph someone
   * has since hand-edited past recognition — is `false`, and the UI offers the source
   * editor and says why. The builder never guesses a spec back out of TypeScript.
   */
  builder: boolean;
  /** HOW-68: how many steps the graph has — the Graphs list says it beside the name */
  steps: number;
}

export interface Registry {
  graphs: Record<string, Graph<any>>;
  source: Record<string, GraphSource>;
  /** local graphs that do not load, with why — surfaced, never silently missing */
  problems: LocalGraphProblem[];
  /** a derived stacked graph → the local graph it stacks (`runs:launch`'s `child_graph`) */
  stackedOf?: Record<string, string>;
}

export async function loadRegistry(home: string, repoRoot: string): Promise<Registry> {
  const { graphs: local, problems } = await loadLocalGraphs(home, repoRoot);
  const graphs: Record<string, Graph<any>> = { ...GRAPHS };
  const source: Record<string, GraphSource> = Object.fromEntries(Object.keys(GRAPHS).map((n) => [n, "builtin" as const]));

  for (const [name, g] of Object.entries(local)) {
    if (name in GRAPHS) {
      problems.push({ name, error: `a built-in graph is already called "${name}" — rename your local one` });
      continue;
    }
    graphs[name] = g;
    source[name] = "local";
  }

  // every local graph shaped like implement-ticket also runs stacked, as implement-stacked
  // does for implement-ticket; one that cannot be stacked is not a problem, it is just not
  // a child graph (stackedFrom throws on a missing step)
  const stackedOf: Record<string, string> = {};
  for (const [name, g] of Object.entries(local)) {
    const spec = source[name] === "local" ? specOf(g) : null;
    if (!spec) continue;
    let stacked: Graph<any>;
    try {
      stacked = buildGraph({ ...stackedFrom(spec), name: stackedGraphName(name), description: `${spec.description ?? name}, stacked on the slices it depends on` });
    } catch {
      continue;
    }
    const stackedName = stackedGraphName(name);
    if (stackedName in graphs) {
      problems.push({ name: stackedName, error: `"${name}" can run stacked, but a graph is already called "${stackedName}" — rename one` });
      continue;
    }
    graphs[stackedName] = stacked;
    source[stackedName] = "local";
    stackedOf[stackedName] = name;
  }
  return { graphs, source, problems, stackedOf };
}

export function catalogOf(reg: Registry): CatalogEntry[] {
  return Object.values(reg.graphs)
    .map((g) => ({
      name: g.def.name,
      description: g.def.description ?? "",
      inputs: [...g.def.inputs],
      kind: Object.values(g.def.nodes).some((n) => n.kind === "worktree") ? ("repo" as const) : ("plain" as const),
      source: reg.source[g.def.name] ?? ("builtin" as const),
      // a derived stacked graph has no file of its own for the builder to re-open
      builder: reg.source[g.def.name] === "local" && !(g.def.name in (reg.stackedOf ?? {})) && specOf(g) !== null,
      steps: Object.keys(g.def.nodes).length,
      // a BUILT-IN only: a local graph that happens to share the name never gets here (registry)
      ...((g.def.name === STACKED_GRAPH && reg.source[g.def.name] === "builtin") || g.def.name in (reg.stackedOf ?? {})
        ? { launched_by: STACKED_GRAPH_LAUNCHED_BY } : {}),
    }))
    .sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source === "builtin" ? -1 : 1));
}
