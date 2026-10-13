/**
 * Every-path-has-a-writer validation (shaping A0.3, from Orbital's strongest engine idea).
 *
 * For every node N and every key k that N reads, EVERY path entry → N must pass through
 * the writer of k (publishing on success) before reaching N. If any writer-free path
 * exists, the graph is rejected before a run starts — a context read can then only fail
 * at runtime through an engine bug, never a graph bug.
 *
 * Method: forward MUST-analysis to a fixpoint.
 *
 *          in(entry)  = declared run inputs
 *          in(N)      = ⋂ out(P) over predecessors P     (⊤ = all keys, before first pass)
 *          out(N)     = in(N) ∪ writes(N)
 *
 *   The intersection makes it a MUST analysis: a key survives only if it is written on
 *   every incoming path. Cycles converge because sets only shrink from ⊤.
 *
 *   Node kinds do not matter here: every node — including an `approval` node, whose reads
 *   are its proposal + base keys and whose writes are its decision + feedback keys — is
 *   projected to reads/writes by Graph.toShape() (core/graph.ts nodeReads/nodeWrites).
 *
 *   Note on scopes: this proves a writer EXISTS on every path. Scope freshness (veiled /
 *   invalidated values inside loops) is a runtime property of ContextStore — a `per-visit`
 *   read inside a loop can still fail legally; declare such reads with that in mind.
 */

export interface GraphShape {
  entry: string;
  /** run inputs: available at entry (shaping: `inputs="work,notes?"` — required ones only) */
  inputs: string[];
  nodes: Record<string, { reads: string[]; writes: string[] }>;
  /** condition reads are evaluated AFTER `from` completes: checked against out(from) */
  edges: Array<{ from: string; to: string; reads?: string[] }>;
}

export interface Violation {
  node: string;
  key: string;
  /** one writer-free path from entry to the reading node, for the error message */
  witness: string[];
}

export function validateGraph(g: GraphShape): Violation[] {
  const ids = Object.keys(g.nodes);
  const idSet = new Set(ids);
  if (!idSet.has(g.entry)) throw new Error(`entry node not in graph: ${g.entry}`);
  for (const e of g.edges) {
    if (!idSet.has(e.from)) throw new Error(`edge from unknown node: ${e.from}`);
    if (!idSet.has(e.to)) throw new Error(`edge to unknown node: ${e.to}`);
  }

  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of g.edges) preds.get(e.to)!.push(e.from);

  const allKeys = new Set<string>(g.inputs);
  for (const n of Object.values(g.nodes)) for (const w of n.writes) allKeys.add(w);

  // ⊤-initialised MUST analysis
  const TOP = new Set(allKeys);
  const out = new Map<string, Set<string>>(ids.map((id) => [id, new Set(TOP)]));
  const inSets = new Map<string, Set<string>>();

  let changed = true;
  while (changed) {
    changed = false;
    for (const id of ids) {
      const ps = preds.get(id)!;
      let inSet: Set<string>;
      if (id === g.entry) {
        inSet = new Set(g.inputs);
      } else if (ps.length === 0) {
        inSet = new Set(); // unreachable-from-entry gets ⊥; reads there will be flagged
      } else {
        inSet = new Set(out.get(ps[0]!)!);
        for (const p of ps.slice(1)) {
          const po = out.get(p)!;
          for (const k of inSet) if (!po.has(k)) inSet.delete(k);
        }
      }
      inSets.set(id, inSet);
      const newOut = new Set(inSet);
      for (const w of g.nodes[id]!.writes) newOut.add(w);
      const oldOut = out.get(id)!;
      if (newOut.size !== oldOut.size || [...newOut].some((k) => !oldOut.has(k))) {
        out.set(id, newOut);
        changed = true;
      }
    }
  }

  const violations: Violation[] = [];
  for (const id of ids) {
    const available = inSets.get(id) ?? new Set();
    for (const key of g.nodes[id]!.reads) {
      if (!available.has(key)) {
        violations.push({ node: id, key, witness: witnessPath(g, id, key) });
      }
    }
  }
  // edge-condition reads: evaluated at from's exit, so out(from) is the availability set
  for (const e of g.edges) {
    for (const key of e.reads ?? []) {
      if (!out.get(e.from)!.has(key)) {
        violations.push({ node: `${e.from} → ${e.to} (condition)`, key, witness: witnessPath(g, e.from, key) });
      }
    }
  }
  return violations;
}

/** BFS from entry to `target` avoiding writers of `key` — the path that proves the hole. */
function witnessPath(g: GraphShape, target: string, key: string): string[] {
  if (g.inputs.includes(key)) return []; // shouldn't happen: inputs are always available
  const writers = new Set(Object.entries(g.nodes).filter(([, n]) => n.writes.includes(key)).map(([id]) => id));
  const queue: string[][] = [[g.entry]];
  const seen = new Set([g.entry]);
  while (queue.length) {
    const path = queue.shift()!;
    const last = path[path.length - 1]!;
    if (last === target) return path;
    // a path through a writer would satisfy the read; witness must avoid writers
    if (writers.has(last)) continue;
    for (const e of g.edges) {
      if (e.from === last && !seen.has(e.to)) {
        seen.add(e.to);
        queue.push([...path, e.to]);
      }
    }
  }
  return [];
}

export function formatViolations(vs: Violation[]): string {
  return vs
    .map(
      (v) =>
        `node "${v.node}" reads "${v.key}" but no writer covers every path` +
        (v.witness.length ? ` — writer-free path: ${v.witness.join(" → ")}` : ""),
    )
    .join("\n");
}

/**
 * HOW-54: the nodes that sit on a CYCLE — a strongly connected component of more than one node,
 * or a node with an edge to itself. Tarjan's algorithm, iterative so a long graph cannot blow
 * the stack. Computed from the shape alone (no conditions are evaluated), so it is the set of
 * nodes a run COULD revisit: the only place "this visit changed nothing" can mean a stalled loop.
 */
export function cycleNodes(g: Pick<GraphShape, "nodes" | "edges">): Set<string> {
  const ids = Object.keys(g.nodes);
  const succ = new Map<string, string[]>(ids.map((id) => [id, []]));
  const selfLoop = new Set<string>();
  for (const e of g.edges) {
    succ.get(e.from)?.push(e.to);
    if (e.from === e.to) selfLoop.add(e.from);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out = new Set<string>(selfLoop);
  let next = 0;
  for (const root of ids) {
    if (index.has(root)) continue;
    // each frame: the node and how many of its successors have been visited
    const work: Array<{ v: string; i: number }> = [{ v: root, i: 0 }];
    index.set(root, next); low.set(root, next); next++;
    stack.push(root); onStack.add(root);
    while (work.length) {
      const frame = work.at(-1)!;
      const ws = succ.get(frame.v) ?? [];
      if (frame.i < ws.length) {
        const w = ws[frame.i++]!;
        if (!index.has(w)) {
          index.set(w, next); low.set(w, next); next++;
          stack.push(w); onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!));
        continue;
      }
      work.pop();
      const parent = work.at(-1);
      if (parent) low.set(parent.v, Math.min(low.get(parent.v)!, low.get(frame.v)!));
      if (low.get(frame.v) === index.get(frame.v)) {
        const scc: string[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
          if (w === frame.v) break;
        }
        if (scc.length > 1) for (const w of scc) out.add(w);
      }
    }
  }
  return out;
}
