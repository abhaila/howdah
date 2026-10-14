/**
 * implement-stacked — HOW-57 (decision 3B, 5A + G3): implement-ticket for a slice that DEPENDS
 * on other slices of the same plan. `runs:launch` starts it for every slice with a non-empty
 * `depends_on`; a slice with none still runs implement-ticket, whose shape does not change.
 *
 * It is not a second hand-written graph. `stackedFrom(implementTicketSpec)` is a PURE transform
 * of implement-ticket's spec, so a change there arrives here too — and the drift test
 * (graphs/implement-stacked.test.ts) asserts that every implement-ticket NODE is present and
 * every implement-ticket EDGE is present or named in REWIRED_EDGES, which is itself checked to
 * name only edges that exist. What the transform does:
 *
 *   deps.await (runs:await) ⇄ deps.wait (5m → 15m → 30m while nothing changes; waits are not
 *       steps, G5) — the new ENTRY; on `deps.ready` it goes on to create_worktree.
 *   create_worktree reads `deps.base` / `deps.base_tip`: the branch starts at the stack base's
 *       published tip, else at origin/<default> (decision C).
 *   every agent step is briefed STACKED by the engine (suffix v8, G8) from those two keys.
 *   delivery.publish runs `stacked.publish` (G3b): delivery.publish, included unchanged, plus
 *       "target deps.base" and "an object summary of your own PRs only" (G2, checked).
 *   publish → deps.probe (runs:await, probe mode) → probe_pr, and the delivery wait comes back
 *       through deps.probe too: before every PR probe the base is re-read.
 *   probe_pr's FIRST route is `deps.restack` → delivery.restack (git:restack) — above
 *       CONFLICTS (G4), because resolve_conflicts would rebase onto the target, which is wrong
 *       after a squash merge. A restack conflict goes to delivery.resolve_restack with the exact
 *       --onto command; a clean restack waits for the next probe.
 *   probe_pr ignores every PR in `deps.prs` (G2) and publishes `pr.approved` (decision B).
 *
 * The child waits; the parent never supervises (HOW-23's invariant): nothing here reports back
 * to the run that launched it, and a dependency that fails parks THIS run, naming it.
 */
import { buildGraph, type EdgeSpec, type FieldSpec, type GraphSpec, type NodeSpec } from "../core/graph-spec";
import { AWAIT_BUILTIN, AWAIT_PRODUCES, AWAIT_PROBE_PRODUCES, RESTACK_BUILTIN, RESTACK_PRODUCES, STACKED_GRAPH } from "../core/stack";
import { spec as implementTicketSpec } from "./implement-ticket";

/** An edge by what the drift test compares: its endpoints and its condition's label. */
export interface EdgeRef {
  from: string;
  to: string;
}

/**
 * implement-ticket's edges that implement-stacked deliberately does NOT carry verbatim, each
 * replaced by a route through a new step. Named, so a change to implement-ticket that drops or
 * reroutes an edge fails the drift test instead of silently diverging.
 */
export const REWIRED_EDGES: readonly EdgeRef[] = [
  // publish → deps.probe → probe_pr: the base is re-read before the first PR probe too
  { from: "delivery.publish", to: "delivery.probe_pr" },
  // wait → deps.probe → probe_pr: …and before every later one
  { from: "delivery.wait", to: "delivery.probe_pr" },
];

const STACK_FIELDS: FieldSpec[] = [
  { key: "deps", kind: "text", scope: "sticky", description: "the slices this one waits for, as JSON: [{ slice, until, run_id, workspace }]" },
  { key: "deps.ready", kind: "boolean", scope: "per-visit" },
  { key: "deps.waiting", kind: "text", scope: "per-visit", description: "what this run is waiting on, in words" },
  { key: "deps.base", kind: "text", scope: "sticky", description: "the branch this run is stacked on (\"\" when it is not)" },
  { key: "deps.base_tip", kind: "text", scope: "sticky", description: "the commit this run's work starts after" },
  { key: "deps.prs", kind: "json", scope: "sticky", description: "every PR of the slices this one depends on — never this run's" },
  { key: "deps.base_moved", kind: "boolean", scope: "per-visit" },
  { key: "deps.base_merged", kind: "boolean", scope: "per-visit" },
  { key: "deps.restack", kind: "boolean", scope: "per-visit", description: "the base merged, or moved while this PR is unapproved" },
  { key: "pr.approved", kind: "boolean", scope: "per-visit" },
  { key: "restack.conflict", kind: "text", scope: "per-visit", description: "the exact git rebase --onto command, when a restack conflicted" },
];

const DELIVERY = "delivery";

/** The node `id` of `spec`, or a throw naming what the transform expected to find. */
function nodeOf(spec: GraphSpec, id: string): NodeSpec {
  const n = spec.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`stackedFrom: ${spec.name} has no "${id}" step to stack onto`);
  return n;
}

const sameEdge = (a: EdgeRef) => (b: EdgeRef) => a.from === b.from && a.to === b.to;

/**
 * implement-ticket, stacked. Pure: the argument is not modified, and the same spec always gives
 * the same graph.
 */
export function stackedFrom(base: GraphSpec): GraphSpec {
  const entry = base.entry;
  for (const id of [entry, "delivery.publish", "delivery.probe_pr", "delivery.wait", "delivery.review_repairs"]) nodeOf(base, id);

  const nodes: NodeSpec[] = base.nodes.map((n): NodeSpec => {
    if (n.id === entry && n.kind === "worktree") return { ...n, reads: ["deps.base", "deps.base_tip"] };
    if (n.id === "delivery.publish" && n.kind === "agent")
      return { ...n, prompt: "stacked.publish", reads: [...n.reads, "deps.base", "deps.prs"] };
    if (n.id === "delivery.probe_pr" && n.kind === "command")
      return { ...n, reads: [...n.reads, "deps.prs"], writes: [...n.writes, "pr.approved"] };
    return { ...n };
  });
  nodes.unshift(
    { id: "deps.await", kind: "command", run: AWAIT_BUILTIN, reads: ["deps"], writes: [...AWAIT_PRODUCES], class: "deps" },
    // the await poll: 5m, then longer while nothing changes — and never charged to maxSteps
    { id: "deps.wait", kind: "wait", duration: "5m", backoff: ["15m", "30m"], class: "deps" },
  );
  nodes.push(
    { id: "deps.probe", kind: "command", run: AWAIT_BUILTIN, reads: ["deps", "deps.base", "publication_summary"], writes: [...AWAIT_PROBE_PRODUCES], class: DELIVERY },
    {
      id: "delivery.restack", kind: "command", run: RESTACK_BUILTIN,
      reads: ["deps.base", "deps.base_merged", "pr.approved", "publication_summary"], writes: [...RESTACK_PRODUCES], class: DELIVERY,
    },
    // bounded like revise_repairs: a restack that keeps conflicting parks for the operator
    {
      id: "delivery.resolve_restack", kind: "agent", prompt: "stacked.resolve_restack",
      reads: ["goal", "work", "publication_summary", "restack.conflict"], writes: ["repair_summary"], maxVisits: 3, class: DELIVERY,
    },
  );

  const edges: EdgeSpec[] = [
    { from: "deps.await", to: entry, when: { op: "is-true", key: "deps.ready" } },
    { from: "deps.await", to: "deps.wait" },
    { from: "deps.wait", to: "deps.await" },
  ];
  for (const e of base.edges) {
    if (REWIRED_EDGES.some(sameEdge(e))) continue;
    // G4: the restack route is probe_pr's FIRST conditional edge, so it outweighs every repair
    if (e.from === "delivery.probe_pr" && !edges.some((x) => x.from === "delivery.probe_pr"))
      edges.push({ from: "delivery.probe_pr", to: "delivery.restack", when: { op: "is-true", key: "deps.restack" } });
    edges.push({ ...e });
  }
  edges.push(
    { from: "delivery.publish", to: "deps.probe" },
    { from: "delivery.wait", to: "deps.probe" },
    { from: "deps.probe", to: "delivery.probe_pr" },
    { from: "delivery.restack", to: "delivery.resolve_restack", when: { op: "is-not-empty", key: "restack.conflict" } },
    { from: "delivery.restack", to: "delivery.wait" },
    { from: "delivery.resolve_restack", to: "delivery.review_repairs" },
  );

  return {
    ...base,
    name: STACKED_GRAPH,
    description: "Deliver one ticket stacked on the slices it depends on: wait for them, branch from the base, restack as it moves",
    entry: "deps.await",
    inputs: [...base.inputs, "deps"],
    fields: [...base.fields, ...STACK_FIELDS],
    nodes,
    edges,
  };
}

export const spec: GraphSpec = stackedFrom(implementTicketSpec);

export const implementStacked = buildGraph(spec);
