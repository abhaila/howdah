/**
 * `graphs:catalog` (HOW-56 T4, decision 2A) — the command built-in that publishes WHAT A
 * DRAFTER MAY USE: node kinds, field kinds, command built-ins, every builder-readable graph
 * spec with its prompt ids (not bodies), the taken graph names, and any local graph that
 * failed to load with its reason.
 *
 * Sibling of `verify:run` and `evidence:screenshot`: an in-process built-in dispatched by the
 * command executor beside `probe:pr`, not a shell command. A shell command ignores the node's
 * reads, streams all stdout as chunks and cannot append typed events — a cataloguing step
 * needs to publish a structured JSON value, so it goes in-process.
 *
 * Everything is derived from the live tables: node kinds from `NODE_KINDS`, field kinds from
 * the parser's `FIELD_KINDS`, command built-ins from `COMMAND_BUILTINS`, graphs from
 * `loadRegistry` (built-ins + local). A new command built-in appears here automatically; a
 * local graph that would not load appears under `broken` with the reason the launcher shows.
 *
 * Output is deterministic: entries are sorted, prompt ids are sorted, taken names are sorted,
 * broken entries are sorted. Two runs over the same registry publish the same value.
 *
 * Over-cap handling: if the serialised value would overflow the per-step context cap
 * (`agentConfig.contextCap`, falling back to `GRAPHS_CATALOG_DEFAULT_CAP = 64000`), the
 * LARGEST graph specs are dropped one by one until the result fits, and each dropped name
 * goes into `omitted` with a sentence saying what was left out. Never silently truncated —
 * the drafter must know what it is NOT being told.
 *
 * Refused BEFORE the registry is loaded: a node declaring a write other than
 * `graphs.catalog`, or a step whose `run` carries arguments.
 */
import type { AttemptResult, Executor } from "../run";
import { declaredWrites } from "./map";
import {
  GRAPHS_CATALOG_BUILTIN,
  GRAPHS_CATALOG_DEFAULT_CAP,
  GRAPHS_CATALOG_KEY,
  GRAPHS_CATALOG_PRODUCES,
  type CatalogBrokenEntry,
  type CatalogGraphEntry,
  type GraphsCatalog,
} from "../../core/catalog";
import { COMMAND_BUILTINS, FIELD_KINDS, NODE_KINDS, specOf } from "../../core/graph-spec";
import type { Registry } from "../../graphs/registry";
import { loadRegistry } from "../../graphs/registry";

export { GRAPHS_CATALOG_BUILTIN, GRAPHS_CATALOG_PRODUCES } from "../../core/catalog";

export function isGraphsCatalogBuiltin(run: string): boolean {
  return run.trim().split(/\s+/)[0] === GRAPHS_CATALOG_BUILTIN;
}

export interface GraphsCatalogBuiltinOpts {
  /**
   * The registry provider. Injected (cli/main.ts reads $HOWDAH_HOME and the repo root), so the
   * engine stays free of config loading — the same seam as the verify, evidence and launch
   * built-ins. Omitting it fails every attempt with a reason, never a silent empty catalog.
   */
  registry?: () => Promise<Registry>;
  /**
   * Context cap in bytes of serialised JSON (default `GRAPHS_CATALOG_DEFAULT_CAP = 64000`).
   * The engine passes `agentConfig.contextCap` of the step that will CONSUME the value; this
   * is a floor, so an unset or absurdly-small cap falls back to the default.
   */
  contextCap?: number;
}

export function graphsCatalogBuiltinExecutor(opts: GraphsCatalogBuiltinOpts = {}): Executor {
  return async (args) => {
    const { def, nodeId, visit, log } = args;
    if (def.kind !== "command") throw new Error("graphs:catalog built-in on a non-command node");
    const extra = def.run.trim().split(/\s+/).slice(1);
    const producible = GRAPHS_CATALOG_PRODUCES as readonly string[];
    const unproducible = Object.keys(def.writes ?? {}).filter((k) => !producible.includes(k));
    let index = 0;
    const chunk = (kind: "tool_call" | "tool_result" | "text", content: string) =>
      log.append({ type: "chunk", node: nodeId, visit, turn: 1, index: index++, kind, content });
    const failed = (reason: string): AttemptResult => {
      chunk("tool_result", `failed: ${reason}`);
      return { status: "failed", writes: {}, reason };
    };
    if (extra.length)
      return failed(`${GRAPHS_CATALOG_BUILTIN} takes no arguments (got "${extra.join(" ")}") — it reads the live registry`);
    if (unproducible.length)
      return failed(`${GRAPHS_CATALOG_BUILTIN} cannot produce ${unproducible.join(", ")} — it publishes only ${producible.join(", ")}. Nothing was run.`);
    if (!opts.registry)
      return failed(`${GRAPHS_CATALOG_BUILTIN} has no registry to list — this installation did not wire one.`);

    chunk("tool_call", GRAPHS_CATALOG_BUILTIN);
    let registry: Registry;
    try {
      registry = await opts.registry();
    } catch (err) {
      return failed(`${GRAPHS_CATALOG_BUILTIN}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const catalog = computeCatalog(registry, opts.contextCap ?? GRAPHS_CATALOG_DEFAULT_CAP);
    const summary = `${catalog.graphs.length} graph${catalog.graphs.length === 1 ? "" : "s"}, ${catalog.commandBuiltins.length} command built-in${catalog.commandBuiltins.length === 1 ? "" : "s"}` +
      (catalog.broken.length ? `, ${catalog.broken.length} broken` : "") +
      (catalog.omitted?.length ? `, ${catalog.omitted.length} omitted to fit the cap` : "");
    chunk("tool_result", summary);
    return {
      status: "succeeded",
      writes: declaredWrites(GRAPHS_CATALOG_BUILTIN, def, { [GRAPHS_CATALOG_KEY]: catalog }),
    };
  };
}

/**
 * The pure half: a registry → the published catalog, trimmed to `cap` bytes. Exported for the
 * builder's palette and for the executor's unit tests — nothing in it touches the filesystem
 * or the clock, so it is safe to call in both.
 */
export function computeCatalog(registry: Registry, cap: number): GraphsCatalog {
  const graphs = Object.values(registry.graphs)
    .map((g): CatalogGraphEntry | null => {
      const spec = specOf(g);
      if (!spec) return null; // not builder-readable — appears in takenNames only
      const promptIds = [...new Set(spec.nodes.flatMap((n) => (n.kind === "agent" ? [n.prompt] : [])))].sort();
      return { name: spec.name, spec, promptIds };
    })
    .filter((e): e is CatalogGraphEntry => e !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  const takenNames = [
    ...Object.keys(registry.graphs),
    ...registry.problems.map((p) => p.name),
  ].sort((a, b) => a.localeCompare(b));

  const broken: CatalogBrokenEntry[] = registry.problems
    .map((p) => ({ name: p.name, reason: p.error }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // `runs:launch` is excluded here (draftRuleProblems refuses it, so offering it would
  // mislead the drafter about the shape it can propose). Other built-ins — graphs:catalog
  // itself included — are listed verbatim with their contracts.
  const commandBuiltins = COMMAND_BUILTINS
    .filter((b) => b.run !== "runs:launch")
    .map((b) => ({ run: b.run, label: b.label, produces: [...b.produces] as readonly string[], ...(b.reads ? { reads: [...b.reads] as readonly string[] } : {}) }))
    .sort((a, b) => a.run.localeCompare(b.run));

  // the FLOOR cap: a cap of 0 or a negative/NaN means "default", never "publish nothing"
  const limit = Number.isFinite(cap) && cap > 0 ? cap : GRAPHS_CATALOG_DEFAULT_CAP;
  const base: GraphsCatalog = {
    nodeKinds: [...NODE_KINDS].sort(),
    fieldKinds: [...FIELD_KINDS].sort(),
    commandBuiltins,
    graphs,
    takenNames,
    broken,
  };
  return trimToCap(base, limit);
}

/**
 * Drop the largest graph specs one by one until the serialised catalog fits under `cap`,
 * recording each dropped name in `omitted`. The order is deterministic: ties on size break
 * on name, so two runs over the same registry omit the same graphs. The non-graph fields
 * stay untouched — a drafter without them is a drafter that cannot propose at all.
 *
 * If the catalog is still over cap after dropping every graph, `omitted` lists them all and
 * the drafter sees an empty `graphs` list with the reason — the operator will see the same
 * sentence in `broken` and knows the installation is misconfigured. Never silently truncated.
 */
function trimToCap(catalog: GraphsCatalog, cap: number): GraphsCatalog {
  if (byteLength(catalog) <= cap) return catalog;
  const omitted: string[] = [];
  // sort LARGEST first; ties by name so two equal-sized specs drop in a deterministic order
  const bySizeDesc = [...catalog.graphs]
    .map((g) => ({ g, size: byteLength(g) }))
    .sort((a, b) => (b.size - a.size) || a.g.name.localeCompare(b.g.name));
  let remaining = [...bySizeDesc];
  let next: GraphsCatalog = catalog;
  while (byteLength(next) > cap && remaining.length) {
    const dropped = remaining[0]!;
    omitted.push(dropped.g.name);
    remaining = remaining.slice(1);
    const keep = new Set(remaining.map((r) => r.g.name));
    next = { ...catalog, graphs: catalog.graphs.filter((g) => keep.has(g.name)), omitted: [...omitted].sort((a, b) => a.localeCompare(b)) };
  }
  return next;
}

function byteLength(value: unknown): number {
  // UTF-8 byte length rather than character count: contextCap is bytes (core/template.ts),
  // and a two-byte character counts for two in that cap.
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
