/**
 * ONE layered-BFS layout, for the two surfaces that draw the same graph (HOW-24).
 *
 * `layout()` was inside graph-dag.tsx, where it placed the boxes of the read-only picture the
 * run view and the tuner show. HOW-24's canvas has to place the same boxes — a graph opened in
 * the builder and the same graph watched while it runs must not be two different shapes — so
 * the function moved here rather than being copied. Two layouts that drift would be a picture
 * that lies about which one you are looking at.
 *
 * The PLACEMENT — which layer a step is in and where in it — is the shared part, and it is what
 * makes the two pictures the same picture. The PITCH is not: the SVG prints a route's condition
 * beside the wire and the canvas prints it ON the wire, in the gap between two cards, so the
 * canvas needs a taller one. It is a parameter rather than a second function.
 *
 * `autoLayout()` is the canvas's half. A graph built before HOW-24 carries no positions at
 * all, and a pile of boxes at the origin is not an arrangement — so the first open lays it
 * out, and the next save writes those positions into the spec. A step that ALREADY has a
 * position is never moved: the arrangement is the operator's, and this only fills the gaps.
 *
 * `nextFreePosition()` and `freeSpotNear()` are the two answers to "where does a step with no
 * dropped point go". The first is for "we have no idea what is on screen" — below everything,
 * covering nothing. The second is for "the middle of the view, unless a card is already
 * there", which is what a palette CLICK means (review finding 3).
 */
import { specFlowEdges, type GraphSpec, type NodeSpec, type Point } from "../../../core/graph-spec";

/** How far apart the boxes go. `stagger` shifts every other layer sideways, so a long chain
 *  does not read as one straight column. */
export interface Pitch {
  x: number;
  y: number;
  stagger: number;
  origin: number;
}

/** the read-only picture's own numbers — its boxes are 180x52 and its captions sit beside the wire */
const SVG_PITCH: Pitch = { x: 210, y: 92, stagger: 60, origin: 40 };
/** the canvas: wider, taller cards (220px since HOW-68, so their text reads at 12-13px), and a
 *  condition printed IN the gap rather than beside it — two stacked 28px captions fit between
 *  two rows. The read-only picture's pitch above is untouched. */
const CANVAS_PITCH: Pitch = { x: 264, y: 168, stagger: 60, origin: 40 };

/** Where the first box goes; also where an unplaceable one lands. */
const ORIGIN: Point = { x: SVG_PITCH.origin, y: SVG_PITCH.origin };

/** The least a shape has to be to be placed: an entry, some nodes, and what leads where. */
export interface Placeable {
  entry: string;
  nodes: Array<{ id: string }>;
  edges: Array<{ from: string; to: string }>;
}

export function layout(shape: Placeable, pitch: Pitch = SVG_PITCH): Map<string, Point> {
  // BFS layers from entry; unreached nodes go in a trailing layer
  const depth = new Map<string, number>([[shape.entry, 0]]);
  const queue = [shape.entry];
  while (queue.length) {
    const n = queue.shift()!;
    for (const e of shape.edges) {
      if (e.from === n && !depth.has(e.to)) {
        depth.set(e.to, (depth.get(n) ?? 0) + 1);
        queue.push(e.to);
      }
    }
  }
  for (const n of shape.nodes) if (!depth.has(n.id)) depth.set(n.id, (Math.max(0, ...depth.values()) + 1));

  const layers = new Map<number, string[]>();
  for (const n of shape.nodes) {
    const d = depth.get(n.id)!;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d)!.push(n.id);
  }
  const pos = new Map<string, Point>();
  for (const [d, ids] of layers) {
    ids.forEach((id, i) => pos.set(id, { x: pitch.origin + i * pitch.x + (d % 2) * pitch.stagger, y: pitch.origin + d * pitch.y }));
  }
  return pos;
}

/** The spec with a position filled in for every step that has none, and nothing else touched. */
export function autoLayout(spec: GraphSpec): GraphSpec {
  if (spec.nodes.every((n) => n.position)) return spec;
  // HOW-73: a parallel step's branches and join are placed through its fork/join edges
  const pos = layout({ ...spec, edges: specFlowEdges(spec) }, CANVAS_PITCH);
  return { ...spec, nodes: spec.nodes.map((n) => (n.position ? n : { ...n, position: pos.get(n.id) ?? ORIGIN })) };
}

/** How big a card is on the canvas, for the two things that have to reason about overlap.
 *  The width is the canvas card's (builder/canvas.tsx NODE_WIDTH); the height is a rough one,
 *  because a titled step has an id line and React Flow measures what it renders. */
const CARD: Point = { x: 220, y: 72 };
/** The room two cards need between them: beside each other, a gutter; one above the other, a
 *  wire with its caption ("Otherwise", `goal is set`) — a caption is drawn IN that gap, so a
 *  card dropped closer than this ends up wearing its neighbour's caption. Both stay under the
 *  canvas pitch, so cards laid out by `autoLayout` never count as crowding each other. */
const ROOM: Point = { x: CARD.x + 24, y: CARD.y + 64 };
/** How far a crowded-out step steps aside: just past the room, so one already-placed step can
 *  rule out at most ONE candidate in a row or a column — which is what makes the search below
 *  end on a free spot rather than merely end. */
const ASIDE: Point = { x: ROOM.x + 4, y: ROOM.y + 4 };

/**
 * `at`, unless a step is already sitting there, close enough to share a wire's caption, or the
 * spot is ON A WIRE — then the nearest clear spot around it.
 *
 * Two palette clicks in a row must not stack two cards on the same pixel, which is the failure
 * mode "always the centre" has; and "half a card away" was not enough either: three steps added
 * from the keyboard landed 8px apart, each under the caption of the wire above it. Deliberately
 * NOT used by the DROP path: a drop is where the operator put it, and moving it is a lie about
 * a direct-manipulation gesture.
 *
 * D21: it no longer settles for "close but visible". It used to take `reach` — how far the
 * view extended — and, in a small pane with nothing clear on screen, stepped aside by less than
 * a card, which is how a third step ended up on a wire and its caption. The canvas now PANS to
 * the new step (builder/canvas.tsx `revealShift`), so the only question here is "where is it
 * clear", and a wire is an obstacle like a card is: pass `edges` and a spot whose card would
 * sit on the line between two wired steps, or on the caption at its middle, is not clear.
 *
 * `undefined` in, `undefined` out — there is no spot near nowhere. Candidates are a grid around
 * `at`, spaced just past the room a card needs, nearest first; if a crowded draft rules out
 * every one, the spot below everything is clear by construction.
 */
export function freeSpotNear(nodes: NodeSpec[], at: Point | undefined, opts: { edges?: ReadonlyArray<{ from: string; to: string }> } = {}): Point | undefined {
  if (!at) return undefined;
  const placed = nodes.map((n) => n.position).filter((p): p is Point => !!p);
  const where = new Map(nodes.flatMap((n) => (n.position ? [[n.id, n.position] as const] : [])));
  // a wire, as the straight line between the two cards' centres — the drawn curve leaves by the
  // facing sides and stays inside the margin below — and its caption at the middle
  const wires = (opts.edges ?? []).flatMap((e) => {
    const a = where.get(e.from), b = where.get(e.to);
    if (!a || !b || e.from === e.to) return [];
    return [{ a: { x: a.x + CARD.x / 2, y: a.y + CARD.y / 2 }, b: { x: b.x + CARD.x / 2, y: b.y + CARD.y / 2 } }];
  });
  const onWire = (p: Point) => wires.some(({ a, b }) => {
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return segmentHitsBox(a, b, { x: p.x - WIRE_MARGIN, y: p.y - WIRE_MARGIN, w: CARD.x + WIRE_MARGIN * 2, h: CARD.y + WIRE_MARGIN * 2 })
      || (mid.x > p.x - CAPTION.x && mid.x < p.x + CARD.x + CAPTION.x && mid.y > p.y - CAPTION.y && mid.y < p.y + CARD.y + CAPTION.y);
  });
  const clear = (p: Point) => !placed.some((q) => Math.abs(q.x - p.x) < ROOM.x && Math.abs(q.y - p.y) < ROOM.y) && !onWire(p);
  if (clear(at)) return at;
  // A grid of spots around `at`, nearest first; a tie goes below, then above (a graph reads
  // downwards), then to either side.
  const span = Math.min(8, placed.length + wires.length + 1);
  const around: Array<{ p: Point; order: number }> = [];
  for (let i = -span; i <= span; i++) for (let j = -span; j <= span; j++) {
    if (i === 0 && j === 0) continue;
    const order = i === 0 ? (j > 0 ? 0 : 1) : j === 0 ? (i > 0 ? 2 : 3) : 4;
    around.push({ p: { x: at.x + i * ASIDE.x, y: at.y + j * ASIDE.y }, order });
  }
  const far = (p: Point) => Math.hypot(p.x - at.x, p.y - at.y);
  const free = around.sort((a, b) => far(a.p) - far(b.p) || a.order - b.order).map((c) => c.p).find(clear);
  // below everything: no card and no wire reaches there
  return free ?? { x: at.x, y: Math.max(at.y, ...placed.map((q) => q.y)) + ASIDE.y };
}

/** how close to a wire's line a card may come before it reads as sitting on it */
const WIRE_MARGIN = 12;
/** half a caption's box ("Otherwise", `goal is set`), which is drawn centred on the wire's middle */
const CAPTION: Point = { x: 64, y: 14 };

/** Does the segment a→b touch the box? Liang–Barsky clipping; pure. */
export function segmentHitsBox(a: Point, b: Point, box: { x: number; y: number; w: number; h: number }): boolean {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - box.x], [dx, box.x + box.w - a.x], [-dy, a.y - box.y], [dy, box.y + box.h - a.y]] as const) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

/** Where a step with no position of its own goes — below everything, so nothing is covered. */
export function nextFreePosition(nodes: NodeSpec[]): Point {
  const placed = nodes.map((n) => n.position).filter((p): p is Point => !!p);
  return placed.length ? { x: CANVAS_PITCH.origin, y: Math.max(...placed.map((p) => p.y)) + CANVAS_PITCH.y } : ORIGIN;
}
