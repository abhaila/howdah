/**
 * B1 (HOW-31, docs/designs/graph-drafting.md): the built-ins are being rewritten as
 * `GraphSpec` literals compiled by `buildGraph`, so that every graph in the catalog carries a
 * spec. Until they do, a proposal has nothing to diff against and `graphs/builder.ts` refuses
 * to infer a spec out of TypeScript by design.
 *
 * A conversion is safe only if the compiled `Graph` is INDISTINGUISHABLE from the hand-written
 * one. `shapeOf` is everything about a compiled graph the engine can observe, as plain data,
 * so a conversion can be pinned against a snapshot taken BEFORE it happened
 * (`fixtures/pre-spec-shapes.json`). Pure and node-free so a capture script and the test can
 * both use it; the assertions live in `spec-equivalence.test.ts`.
 */
import type { Graph } from "../core/graph";

export function shapeOf(g: Graph<any>) {
  const d = g.def;
  return {
    name: d.name,
    description: d.description,
    defaults: d.defaults,
    entry: d.entry,
    inputs: [...d.inputs].sort(),
    nodes: Object.fromEntries(
      Object.entries(d.nodes)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, n]) => [
          id,
          // NodeDef is a union and an approval node has no `writes`, so reach for it only
          // where it exists rather than widening the node type.
          //
          // ABSENT AND EMPTY ARE THE SAME NODE. `defineGraph` lets a node omit `writes`
          // entirely (a worktree step that publishes nothing); `compileNode` always emits one,
          // possibly `{}`. `core/graph.ts:213` Graph.writesOf returns `{}` for both and
          // `engine/run.ts:549` reads `def.writes ?? {}`, so the engine cannot tell them
          // apart. Normalising here keeps a conversion from failing on a difference that does
          // not exist; it widens what counts as equal and nothing else.
          { ...n, writes: Object.fromEntries(Object.entries(("writes" in n && n.writes) || {}).sort(([a], [b]) => a.localeCompare(b))) },
        ]),
    ),
    // WEIGHT IS NOT OBSERVABLE; ORDER IS. `engine/run.ts:708` picks the passing condition
    // with the highest weight (`(e.weight ?? 0) > bestWeight`), so only the ranking among a
    // node's conditional edges matters, not the numbers. `compileEdges` derives weights as
    // `count - i`, which can offset a hand-written set (improve-codebase's probe_pr is 6..2
    // by hand and 5..1 compiled) while routing identically. Comparing RANK keeps the test
    // sensitive to reordering, which does change routing, without failing on an offset that
    // cannot. `beatsFallback` is kept separately because rank alone would not notice a
    // conditional dropping to weight 0, where the unconditional fallback would tie it.
    edges: rankEdges(d.edges),
  };
}

function rankEdges(edges: Graph<any>["def"]["edges"]) {
  const order = new Map<string, number[]>();
  edges.forEach((e, i) => {
    if (!e.condition) return;
    const list = order.get(e.from) ?? [];
    list.push(i);
    order.set(e.from, list);
  });
  // highest weight first; ties keep declaration order, exactly as the `>` in run.ts does
  for (const [from, idxs] of order)
    order.set(from, [...idxs].sort((a, b) => (edges[b]?.weight ?? 0) - (edges[a]?.weight ?? 0) || a - b));
  return edges.map((e, i) => ({
    from: e.from,
    to: e.to,
    label: e.condition?.label,
    reads: e.condition ? [...e.condition.reads].sort() : undefined,
    rank: e.condition ? (order.get(e.from)?.indexOf(i) ?? -1) : undefined,
    beatsFallback: e.condition ? (e.weight ?? 0) > 0 : undefined,
  }));
}

/**
 * The context values an edge condition could be asked about: every key any condition reads,
 * crossed with the literals the labels mention plus the shapes a missing or wrong-typed value
 * takes. A condition agreeing on all of them cannot route differently — which is the part a
 * structural comparison cannot see, because the old form is an arbitrary `test` function and
 * the new one is `compilePredicate` over a `Predicate`.
 */
export function probeValues(...graphs: Array<Graph<any>>): Array<Record<string, unknown>> {
  const keys = new Set<string>();
  const literals = new Set<unknown>([undefined, null, "", 0, false, true, [], {}, "unmatched-value"]);
  for (const g of graphs)
    for (const e of g.def.edges) {
      if (!e.condition) continue;
      for (const k of e.condition.reads) keys.add(k);
      for (const m of (e.condition.label ?? "").matchAll(/'([^']*)'/g)) if (m[1] !== undefined) literals.add(m[1]);
    }
  const out: Array<Record<string, unknown>> = [];
  for (const k of keys) for (const v of literals) out.push({ [k]: v });
  out.push(Object.fromEntries([...keys].map((k) => [k, "unmatched-value"])));
  return out;
}
