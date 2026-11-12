/**
 * The read-only graph's layout: a real layered (Sugiyama) placement, from `@dagrejs/dagre`
 * (HOW-68, the operator's first hands-on feedback: "the graphs are not so neat").
 *
 * WHAT IT REPLACED. `lib/layout.ts` `layout()` is a layered BFS: a step's layer is its distance
 * from the entry and its place in the layer is the order the graph file declares it in. Nothing
 * in it looks at an edge after the layers are made, so wires crossed wherever declaration order
 * disagreed with the shape, a loop back was a fixed curve round the left that ran THROUGH any
 * card standing there, and a route's condition was printed at a guessed point beside its wire.
 * implement-ticket (25 steps, five review → repair loops) was unreadable. That function stays
 * exactly as it is for the BUILDER, which only uses it to seed positions the operator then owns.
 *
 * WHY A DEPENDENCY, and why this one (the test CLAUDE.md applies to `@xyflow/react` and
 * `@shadcn/react`): it buys a part that is expensive to own and cheap to borrow — crossing
 * minimisation, coordinate assignment and edge routing through the gaps, three algorithms each a
 * paper long. Its whole dependency tree is ONE package, `@dagrejs/graphlib`, the graph structure
 * it lays out; both are pure JavaScript with no DOM. And it is confined to THIS FILE: the picture
 * (`graph-dag.tsx`) is handed plain boxes and points and never sees the library.
 *
 * `elkjs` was measured against it with the project's own build and refused: it lays out a little
 * better, and it is 1.5 MB minified (456 KB gzipped) against dagre's 49 KB (17 KB), runs in a
 * worker or blocks, and is asynchronous — so the picture would paint empty and then jump. dagre
 * is synchronous and lays out the largest built-in (30 steps, 40 edges) in a few milliseconds.
 *
 * Three things this file decides rather than the library:
 *
 *   THE ENTRY IS AT THE TOP, AND A LOOP IS THE EDGE THAT GOES BACK. dagre breaks cycles with a
 *   depth-first search over nodes in INSERTION order, so the entry is inserted first and every
 *   other step in the order a walk from it reaches them. The edge it reverses is then the one
 *   that returns to a step the run has already been through — review → repair goes down, the way
 *   back to the review curves up — rather than whichever edge a greedy pass happened to pick.
 *
 *   A CONDITION HAS ROOM. Each labelled edge is given its caption's box, which dagre places in a
 *   rank of its own between the two cards. So a caption never sits on a card or on another
 *   caption by construction, instead of being nudged off them afterwards.
 *
 *   THE PICTURE NEVER ASSERTS (CLAUDE.md, HOW-22). A draft is laid out too, and a draft is being
 *   typed: an edge naming a step that does not exist is SKIPPED (its slot in `edges` is `null`),
 *   never dereferenced, and an empty shape is an empty layout.
 *
 *   EVERY SIDEWAYS RUN HAS A LANE OF ITS OWN (the final pass). All sideways travel happens in
 *   the gaps between ranks, and a busy gap — the one above a row of Finish steps, or under a
 *   probe with six routes — carried a dozen wires at three shared heights, so two wires that
 *   merely passed each other read as one wire that forked. Each bend in a gap now runs at its
 *   own height, ordered so two wires heading the same way do not cross (the one that starts
 *   furthest back runs nearest the rank it is going to), and a gap with more lanes than it has
 *   room for is OPENED: every rank below moves down by what is missing. The wire is drawn square
 *   with rounded corners, so a lane reads as a lane.
 *
 * Pure, synchronous, node-free and DOM-free.
 */
import dagre from "@dagrejs/dagre";

export interface Point { x: number; y: number }
export interface Box { x: number; y: number; width: number; height: number }

export interface LayoutNode { id: string; width: number; height: number }
export interface LayoutEdge {
  from: string;
  to: string;
  /** the caption's box, when the edge carries one */
  label?: { width: number; height: number };
}

export interface LaidEdge {
  /** the wire, from the source card's border to the target's, through the gaps between cards */
  points: Point[];
  /** the caption's CENTRE */
  label?: Point;
  /**
   * the height of each sideways run, one per bend (a pair of consecutive points whose x
   * differs), in order: its LANE in the gap between two ranks. Absent: the middle of the gap.
   */
  lanes?: number[];
  /** it returns to a step at or above the one it leaves: a loop */
  back: boolean;
  /** a step routed to itself */
  self: boolean;
}

export interface DagLayout {
  /** top-left corners, as React Flow positions a node */
  nodes: Map<string, Box>;
  /** index-aligned with the edges passed in; `null` where an endpoint does not exist */
  edges: Array<LaidEdge | null>;
  width: number;
  height: number;
}

/** the air between two cards in a rank, between two wires, and between two ranks */
const SPACING = { nodesep: 36, edgesep: 20, ranksep: 64, margin: 24 } as const;

/** how far a wire runs straight off a card before it may bend, so no bend touches a card's edge */
const STUB = 10;
/** half a caption's height: the band a wire crosses straight where a rank holds only captions */
const LABEL_HALF = 14;
/** the air between two lanes in a gap, and between a lane and the rank on either side of it */
const LANE = 10;
/** two points this close in x are one straight run: a 2px jog is a kink, not a route */
const STRAIGHT = 3;

/** the order a walk from the entry reaches the steps in; anything unreached keeps its place after */
function reachOrder(entry: string, ids: readonly string[], edges: ReadonlyArray<{ from: string; to: string }>): string[] {
  const known = new Set(ids);
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (start: string) => {
    if (!known.has(start) || seen.has(start)) return;
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const at = queue.shift()!;
      order.push(at);
      for (const e of edges) {
        if (e.from !== at || !known.has(e.to) || seen.has(e.to)) continue;
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  };
  visit(entry);
  for (const id of ids) visit(id);
  return order;
}

export function dagLayout(entry: string, nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): DagLayout {
  const out: DagLayout = { nodes: new Map(), edges: edges.map(() => null), width: 0, height: 0 };
  if (nodes.length === 0) return out;
  const size = new Map(nodes.map((n) => [n.id, n]));
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: "TB", nodesep: SPACING.nodesep, edgesep: SPACING.edgesep, ranksep: SPACING.ranksep, marginx: SPACING.margin, marginy: SPACING.margin });
  g.setDefaultEdgeLabel(() => ({}));
  // A step nothing leads to or from (a draft's REMOVED step, a step not wired up yet) is not part
  // of the flow, and dagre would stand it beside the entry — off the edge of a narrow pane, which
  // is exactly where a removed step must not be. Those are set down in a row UNDER the graph.
  const wired = new Set<string>([entry]);
  for (const e of edges) if (size.has(e.from) && size.has(e.to)) { wired.add(e.from); wired.add(e.to); }
  const loose = nodes.filter((n) => !wired.has(n.id));
  // ...unless nothing is wired at all: then there is no graph to put them under
  const flowing = loose.length === nodes.length ? nodes : nodes.filter((n) => wired.has(n.id));
  const apart = loose.length === nodes.length ? [] : loose;
  const inFlow = new Set(flowing.map((n) => n.id));
  for (const id of reachOrder(entry, flowing.map((n) => n.id), edges)) {
    const n = size.get(id);
    if (n) g.setNode(id, { width: n.width, height: n.height });
  }
  edges.forEach((e, i) => {
    // an edge to or from a step that is not there has nothing to be drawn between (see header)
    if (!size.has(e.from) || !size.has(e.to)) return;
    g.setEdge(e.from, e.to, e.label ? { width: e.label.width, height: e.label.height, labelpos: "c" } : {}, `e${i}`);
  });
  dagre.layout(g);

  for (const n of nodes) {
    if (!inFlow.has(n.id)) continue;
    const at = g.node(n.id) as { x?: number; y?: number } | undefined;
    if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
    // dagre answers centres; a card is positioned by its corner
    out.nodes.set(n.id, { x: Math.round(at.x! - n.width / 2), y: Math.round(at.y! - n.height / 2), width: n.width, height: n.height });
  }
  // a rank's band: from the top of its tallest card to the bottom of it (cards in a rank share a centre)
  const bands = new Map<number, { top: number; bottom: number }>();
  for (const box of out.nodes.values()) {
    const mid = Math.round(box.y + box.height / 2);
    const band = bands.get(mid);
    bands.set(mid, { top: Math.min(band?.top ?? Infinity, box.y - STUB), bottom: Math.max(band?.bottom ?? -Infinity, box.y + box.height + STUB) });
  }
  const bandAt = (y: number, half: number) => {
    for (const [mid, band] of bands) if (Math.abs(mid - y) <= 2) return band;
    return { top: y - half, bottom: y + half };
  };
  const raw = edges.map((e, i) => {
    const a = out.nodes.get(e.from), b = out.nodes.get(e.to);
    if (!a || !b || !g.hasEdge(e.from, e.to, `e${i}`)) return null;
    const laid = g.edge(e.from, e.to, `e${i}`) as { points?: Point[]; x?: number; y?: number } | undefined;
    const points = (laid?.points ?? []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (points.length < 2) return null;
    const label = e.label && Number.isFinite(laid?.x) && Number.isFinite(laid?.y) ? { x: laid!.x!, y: laid!.y! } : undefined;
    return { a, b, points, label, self: e.from === e.to, back: e.from !== e.to && b.y <= a.y };
  });
  // PORTS. dagre aims every wire at a card's CENTRE and cuts it at the border, so a wire to a
  // step far to one side left through the card's flank and ran across its neighbour. Here a wire
  // leaves by the bottom edge and arrives at the top (a loop back: the other way round), and the
  // wires sharing an edge of a card are spread along it in the order of where they are going.
  const ports = new Map<string, Array<{ edge: number; toward: number }>>();
  const want = (key: string, edge: number, toward: number) => { const list = ports.get(key); if (list) list.push({ edge, toward }); else ports.set(key, [{ edge, toward }]); };
  raw.forEach((r, i) => {
    if (!r || r.self) return;
    const e = edges[i]!;
    const inner = r.points.slice(1, -1);
    want(`${e.from}\u0000${r.back ? "top" : "bottom"}`, i, (inner[0] ?? r.points.at(-1)!).x);
    want(`${e.to}\u0000${r.back ? "bottom" : "top"}`, i, (inner.at(-1) ?? r.points[0]!).x);
  });
  const portX = new Map<string, number>();
  for (const [key, list] of ports) {
    const box = out.nodes.get(key.split("\u0000")[0]!)!;
    list.sort((p, q) => p.toward - q.toward);
    // within the middle of the edge, so a wire never meets a rounded corner
    const span = Math.min(box.width - 48, (list.length - 1) * 28);
    list.forEach((p, n) => portX.set(`${key}\u0000${p.edge}`, box.x + box.width / 2 + (list.length === 1 ? 0 : -span / 2 + (span * n) / (list.length - 1))));
  }
  raw.forEach((r, i) => {
    if (!r) return;
    if (r.self) { out.edges[i] = { points: r.points, ...(r.label ? { label: r.label } : {}), back: false, self: true }; return; }
    const e = edges[i]!;
    const [leave, arrive] = r.back ? (["top", "bottom"] as const) : (["bottom", "top"] as const);
    const sx = portX.get(`${e.from}\u0000${leave}\u0000${i}`) ?? r.a.x + r.a.width / 2;
    const tx = portX.get(`${e.to}\u0000${arrive}\u0000${i}`) ?? r.b.x + r.b.width / 2;
    const from = bandAt(r.a.y + r.a.height / 2, 0), to = bandAt(r.b.y + r.b.height / 2, 0);
    const points: Point[] = r.back
      ? [{ x: sx, y: r.a.y }, { x: sx, y: from.top }]
      : [{ x: sx, y: r.a.y + r.a.height }, { x: sx, y: from.bottom }];
    // every rank a wire passes is crossed STRAIGHT, top to bottom of that rank's tallest card,
    // in the lane dagre kept clear for it; all sideways travel happens in the gaps between ranks
    for (const p of r.points.slice(1, -1)) {
      const band = bandAt(p.y, LABEL_HALF);
      points.push({ x: p.x, y: r.back ? band.bottom : band.top }, { x: p.x, y: r.back ? band.top : band.bottom });
    }
    points.push(r.back ? { x: tx, y: to.bottom } : { x: tx, y: to.top }, r.back ? { x: tx, y: r.b.y + r.b.height } : { x: tx, y: r.b.y });
    out.edges[i] = { points, ...(r.label ? { label: r.label } : {}), back: r.back, self: false };
  });
  const graph = g.graph() as { width?: number; height?: number };
  out.width = Number.isFinite(graph.width) ? graph.width! : 0;
  out.height = Number.isFinite(graph.height) ? graph.height! : 0;
  assignLanes(out);
  // the loose steps: left to right under the graph, wrapping at its width
  let x = SPACING.margin, y = out.height - SPACING.margin + SPACING.ranksep, row = 0;
  for (const n of apart) {
    if (x > SPACING.margin && x + n.width > Math.max(out.width - SPACING.margin, SPACING.margin + n.width)) { x = SPACING.margin; y += row + SPACING.nodesep; row = 0; }
    out.nodes.set(n.id, { x, y, width: n.width, height: n.height });
    x += n.width + SPACING.nodesep;
    row = Math.max(row, n.height);
    out.width = Math.max(out.width, x - SPACING.nodesep + SPACING.margin);
    out.height = Math.max(out.height, y + n.height + SPACING.margin);
  }
  return out;
}

/**
 * Give every sideways run its own lane, and open a gap that has more lanes than room (see the
 * header). Mutates `out`: the lanes are written on the edges, and where a gap is opened every
 * card, wire point and caption below it moves down.
 */
function assignLanes(out: DagLayout): void {
  interface Bend { edge: number; top: number; bottom: number; xTop: number; xBottom: number }
  const bends: Bend[] = [];
  out.edges.forEach((e, i) => {
    if (!e || e.self) return;
    for (let k = 1; k < e.points.length; k++) {
      const a = e.points[k - 1]!, b = e.points[k]!;
      if (Math.abs(a.x - b.x) < STRAIGHT || Math.abs(a.y - b.y) < 0.5) continue;
      const [hi, lo] = a.y < b.y ? [a, b] : [b, a];
      bends.push({ edge: i, top: hi.y, bottom: lo.y, xTop: hi.x, xBottom: lo.x });
    }
  });
  if (bends.length === 0) return;
  // a gap is the stretch between one rank's band and the next: the bends that start at one height
  const gaps = new Map<number, Bend[]>();
  for (const b of bends) { const key = Math.round(b.top); const list = gaps.get(key); if (list) list.push(b); else gaps.set(key, [b]); }
  // top to bottom, lane by lane: wires heading LEFT first, the one starting furthest left on top;
  // then wires heading RIGHT, the one starting furthest right on top. Two wires heading the same
  // way whose spans overlap then never cross: the later starter turns before it reaches the other.
  const order = (list: Bend[]) => [...list].sort((p, q) => {
    const pl = p.xBottom < p.xTop, ql = q.xBottom < q.xTop;
    if (pl !== ql) return pl ? -1 : 1;
    return pl ? p.xTop - q.xTop || p.xBottom - q.xBottom : q.xTop - p.xTop || q.xBottom - p.xBottom;
  });
  // how much each gap has to open, top to bottom
  const opened: Array<{ at: number; by: number }> = [];
  const ordered = new Map<number, Bend[]>();
  for (const [key, list] of [...gaps].sort((p, q) => p[0] - q[0])) {
    const sorted = order(list);
    ordered.set(key, sorted);
    const room = Math.min(...list.map((b) => b.bottom)) - key;
    const need = (sorted.length + 1) * LANE;
    if (need > room) opened.push({ at: key, by: Math.ceil(need - room) });
  }
  // everything strictly below a gap's top moves down by what that gap (and those above it) opened
  const shift = (y: number) => y + opened.reduce((sum, o) => (y > o.at + 0.5 ? sum + o.by : sum), 0);
  const laneOf = new Map<Bend, number>();
  for (const [key, sorted] of ordered) {
    const top = shift(key), bottom = shift(Math.min(...sorted.map((b) => b.bottom)));
    sorted.forEach((b, n) => laneOf.set(b, top + ((bottom - top) * (n + 1)) / (sorted.length + 1)));
  }
  const byEdge = new Map<number, number[]>();
  for (const b of bends) { const list = byEdge.get(b.edge); const y = laneOf.get(b)!; if (list) list.push(y); else byEdge.set(b.edge, [y]); }
  if (opened.length > 0) {
    for (const box of out.nodes.values()) box.y = Math.round(shift(box.y + box.height / 2) - box.height / 2);
    for (const e of out.edges) {
      if (!e) continue;
      // a card's own two points move with the card; a point in a gap moves with the rank below it
      e.points = e.points.map((p) => ({ x: p.x, y: shift(p.y) }));
      if (e.label) e.label = { x: e.label.x, y: shift(e.label.y) };
    }
    out.height += opened.reduce((sum, o) => sum + o.by, 0);
  }
  out.edges.forEach((e, i) => { const lanes = byEdge.get(i); if (e && lanes) e.lanes = lanes; });
}

/** how round a wire's corners are */
const CORNER = 8;

/**
 * The wire, as an SVG path. Where two consecutive points share an x it is a straight run (a rank
 * being crossed, or the stub off a card); where they do not it is one sideways run at the lane
 * `assignLanes` gave it — down, across, down, with rounded corners — so a wire always meets a
 * card, a caption and the lane beside a card head-on, and two wires in one gap are two lines.
 *
 * A step routed to itself is the exception: dagre draws that as a small loop beside the card,
 * and it is passed through as the smooth curve (a uniform B-spline) dagre's own renderers use.
 */
export function wirePath(edge: Pick<LaidEdge, "points" | "self" | "back" | "lanes">): string {
  const r = (n: number) => Math.round(n * 10) / 10;
  const pts = edge.points;
  const first = pts[0];
  if (!first) return "";
  let d = `M${r(first.x)},${r(first.y)}`;
  if (edge.self && pts.length > 2) {
    let x0 = first.x, y0 = first.y, x1 = first.x, y1 = first.y;
    const seg = (x: number, y: number) => {
      d += `C${r((2 * x0 + x1) / 3)},${r((2 * y0 + y1) / 3)} ${r((x0 + 2 * x1) / 3)},${r((y0 + 2 * y1) / 3)} ${r((x0 + 4 * x1 + x) / 6)},${r((y0 + 4 * y1 + y) / 6)}`;
    };
    pts.forEach((p, i) => {
      if (i === 0) return;
      if (i === 1) { x1 = p.x; y1 = p.y; d += `L${r((5 * x0 + x1) / 6)},${r((5 * y0 + y1) / 6)}`; return; }
      seg(p.x, p.y);
      x0 = x1; y0 = y1; x1 = p.x; y1 = p.y;
    });
    seg(x1, y1);
    return `${d}L${r(x1)},${r(y1)}`;
  }
  let bend = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    if (Math.abs(a.x - b.x) < STRAIGHT || Math.abs(a.y - b.y) < 0.5) { d += `L${r(b.x)},${r(b.y)}`; continue; }
    // the lane this bend was given; the middle of the gap for a layout that assigned none
    const lane = edge.lanes?.[bend++] ?? (a.y + b.y) / 2;
    const dy = Math.sign(b.y - a.y), dx = Math.sign(b.x - a.x);
    const k = Math.max(0, Math.min(CORNER, Math.abs(b.x - a.x) / 2, Math.abs(lane - a.y), Math.abs(b.y - lane)));
    d += `L${r(a.x)},${r(lane - dy * k)}Q${r(a.x)},${r(lane)} ${r(a.x + dx * k)},${r(lane)}`
      + `L${r(b.x - dx * k)},${r(lane)}Q${r(b.x)},${r(lane)} ${r(b.x)},${r(lane + dy * k)}L${r(b.x)},${r(b.y)}`;
  }
  return d;
}
