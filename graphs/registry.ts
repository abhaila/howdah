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
import type { Graph } from "../core/graph";
import { GRAPHS } from "./index";
import { loadLocalGraphs, type LocalGraphProblem } from "./local";

export type GraphSource = "builtin" | "local";

export interface CatalogEntry {
  name: string;
  description: string;
  inputs: string[];
  /** a graph with a worktree node needs a repo; everything else runs on a plain folder */
  kind: "repo" | "plain";
  source: GraphSource;
}

export interface Registry {
  graphs: Record<string, Graph<any>>;
  source: Record<string, GraphSource>;
  /** local graphs that do not load, with why — surfaced, never silently missing */
  problems: LocalGraphProblem[];
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
  return { graphs, source, problems };
}

export function catalogOf(reg: Registry): CatalogEntry[] {
  return Object.values(reg.graphs)
    .map((g) => ({
      name: g.def.name,
      description: g.def.description ?? "",
      inputs: [...g.def.inputs],
      kind: Object.values(g.def.nodes).some((n) => n.kind === "worktree") ? ("repo" as const) : ("plain" as const),
      source: reg.source[g.def.name] ?? ("builtin" as const),
    }))
    .sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source === "builtin" ? -1 : 1));
}
