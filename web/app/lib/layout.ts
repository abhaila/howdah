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
/** the canvas: taller cards, and a condition printed IN the gap rather than beside it */
const CANVAS_PITCH: Pitch = { x: 240, y: 150, stagger: 60, origin: 40 };

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
 *  The width is the shared box width; the height is a rough one, because a card grows with an
 *  entry marker and a problem count and React Flow measures what it renders. */
const CARD: Point = { x: 180, y: 64 };
/** How far a crowded-out step steps aside. The y is a whole card, so one already-placed step
 *  can rule out at most ONE candidate — which is what makes the search below terminate with a
 *  free spot rather than merely terminate. */
const CASCADE: Point = { x: 48, y: 72 };

/**
 * `at`, unless a step is already sitting there — then the next clear spot down-and-right.
 *
 * Two palette clicks in a row must not stack two cards on the same pixel, which is the failure
 * mode "always the centre" has. Deliberately NOT used by the DROP path: a drop is where the
 * operator put it, and moving it is a lie about a direct-manipulation gesture.
 *
 * `undefined` in, `undefined` out — there is no spot near nowhere.
 */
export function freeSpotNear(nodes: NodeSpec[], at: Point | undefined): Point | undefined {
  if (!at) return undefined;
  const placed = nodes.map((n) => n.position).filter((p): p is Point => !!p);
  const clear = (p: Point) =>
    !placed.some((q) => Math.abs(q.x - p.x) < CARD.x / 2 && Math.abs(q.y - p.y) < CARD.y / 2);
  let spot = at;
  for (let i = 1; i <= placed.length && !clear(spot); i++)
    spot = { x: at.x + i * CASCADE.x, y: at.y + i * CASCADE.y };
  return spot;
}

/** Where a step with no position of its own goes — below everything, so nothing is covered. */
export function nextFreePosition(nodes: NodeSpec[]): Point {
  const placed = nodes.map((n) => n.position).filter((p): p is Point => !!p);
  return placed.length ? { x: CANVAS_PITCH.origin, y: Math.max(...placed.map((p) => p.y)) + CANVAS_PITCH.y } : ORIGIN;
}
