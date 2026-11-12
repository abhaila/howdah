/**
 * Where a wire leaves one card and enters the next, and where its caption sits (HOW-68).
 *
 * Every card had ONE way in (its top) and one way out (its bottom), which is right for the
 * layered top-to-bottom placement `lib/layout.ts` makes and wrong the moment the operator
 * arranges a graph left to right — and a step's PLACE is theirs (`NodeSpec.position`). A route
 * to the step on the right left by the bottom, looped under both cards and came back in over
 * the top, and its caption — printed at the midpoint of that loop — landed on a card.
 *
 * So the sides are chosen per route from where the two cards ARE:
 *
 *   mostly to the right → out of the right side, into the left; mostly below → bottom into top.
 *   A LOOP BACK UP a column goes round its left (left → left), as the read-only picture draws a
 *   back edge (graph-dag.tsx), instead of straight up through the cards between.
 *   A PAIR of steps joined both ways along a row would draw one wire on top of the other, so
 *   the one going back takes the long way under (bottom → bottom).
 *
 * AND A WIRE GOES ROUND A CARD, NOT THROUGH IT (the confirming review's finding). The rules above
 * look at two cards; a hand-arranged graph has others, and a step added from the palette and
 * then wired from the panel drew its route straight through the Finish card between. So the
 * pair is chosen with every OTHER card in view (`routeAround`): the preferred pair if the curve
 * between them is clear, else a LANE — the wire leaves and arrives by the same side and runs
 * down a channel beside everything standing between (`wireRoute` draws it, square with rounded
 * corners). That is also what a loop back up a column now is: two handles on one side used to
 * be joined by a curve with no bulge at all, a line up the cards' own edges.
 *
 * Pure and node-free: `specToFlow` calls it for the draft's positions and the canvas again for
 * the frames of a drag, and `routing.test.ts` pins the rules without a DOM.
 */
import type { Point } from "../../../core/graph-spec";

export type Side = "top" | "right" | "bottom" | "left";
export const SIDES: readonly Side[] = ["top", "right", "bottom", "left"];

export interface Box { x: number; y: number; width: number; height: number }

/** a route counts as sideways only once the cards no longer overlap side to side */
const CLEAR_COLUMN = 0.75;

export function edgeSides(from: Box, to: Box, opts: { self?: boolean; reverse?: boolean } = {}): { source: Side; target: Side } {
  // a step routed back to itself: out of its side, back in over the top
  if (opts.self) return { source: "right", target: "top" };
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  const sideways = Math.abs(dx) > Math.abs(dy) && Math.abs(dx) >= from.width * CLEAR_COLUMN;
  if (sideways) {
    if (dx > 0) return { source: "right", target: "left" };
    // going back along a row: beside the route that came the other way, not on top of it
    return opts.reverse ? { source: "bottom", target: "bottom" } : { source: "left", target: "right" };
  }
  if (dy >= 0) return { source: "bottom", target: "top" };
  return { source: "left", target: "left" };
}

/** how close a wire may come to a card that is not one of its own before it reads as touching it */
const CLEARANCE = 8;
/** how far beside the cards a lane runs, and how far apart two lanes on one side are */
const LANE_OFF = 28;
const LANE_STEP = 14;
/** the radius of a lane's corners */
const CORNER = 10;

const sideMid = (b: Box, side: Side): Point => {
  switch (side) {
    case "top": return { x: b.x + b.width / 2, y: b.y };
    case "bottom": return { x: b.x + b.width / 2, y: b.y + b.height };
    case "left": return { x: b.x, y: b.y + b.height / 2 };
    case "right": return { x: b.x + b.width, y: b.y + b.height / 2 };
  }
};
const inside = (p: Point, b: Box, pad: number) =>
  p.x > b.x - pad && p.x < b.x + b.width + pad && p.y > b.y - pad && p.y < b.y + b.height + pad;

/** React Flow's own bezier control point (`getBezierPath`, curvature 0.25), so the curve tested
 *  here is the curve drawn */
function control(at: Point, side: Side, other: Point): Point {
  const off = (d: number) => (d >= 0 ? 0.5 * d : 0.25 * 25 * Math.sqrt(-d));
  switch (side) {
    case "left": return { x: at.x - off(at.x - other.x), y: at.y };
    case "right": return { x: at.x + off(other.x - at.x), y: at.y };
    case "top": return { x: at.x, y: at.y - off(at.y - other.y) };
    case "bottom": return { x: at.x, y: at.y + off(other.y - at.y) };
  }
}

export interface Wire {
  /** the SVG path */
  path: string;
  /** where its caption belongs before it is kept off the cards */
  mid: Point;
  /** points along it, for asking what it crosses */
  samples: Point[];
  /** a lane's long leg runs up and down (a caption moves sideways off it) or along */
  sideways: boolean;
}

/** the lane's coordinate for a same-side pair: beyond both cards and beyond every card standing
 *  in the stretch the lane has to pass */
function laneAt(side: Side, s: Point, t: Point, cards: readonly Box[], nth: number): number {
  const vertical = side === "left" || side === "right";
  const [lo, hi] = vertical ? [Math.min(s.y, t.y), Math.max(s.y, t.y)] : [Math.min(s.x, t.x), Math.max(s.x, t.x)];
  const between = cards.filter((c) => (vertical ? c.y < hi + CLEARANCE && c.y + c.height > lo - CLEARANCE : c.x < hi + CLEARANCE && c.x + c.width > lo - CLEARANCE));
  const out = LANE_OFF + nth * LANE_STEP;
  switch (side) {
    case "right": return Math.max(s.x, t.x, ...between.map((c) => c.x + c.width)) + out;
    case "left": return Math.min(s.x, t.x, ...between.map((c) => c.x)) - out;
    case "bottom": return Math.max(s.y, t.y, ...between.map((c) => c.y + c.height)) + out;
    case "top": return Math.min(s.y, t.y, ...between.map((c) => c.y)) - out;
  }
}

/**
 * The wire between two handles. Different sides: React Flow's bezier. The SAME side: a lane —
 * out from the source, along a channel clear of `cards`, back in to the target — because two
 * handles on one side joined by a bezier is a line up the cards' own edge. `nth` sets apart
 * lanes that share a side, so two loops round one column are two lines.
 */
export function wireRoute(s: Point, from: Side, t: Point, to: Side, cards: readonly Box[] = [], nth = 0): Wire {
  const r = (n: number) => Math.round(n * 10) / 10;
  if (from !== to) {
    const c1 = control(s, from, t), c2 = control(t, to, s);
    const at = (u: number): Point => {
      const v = 1 - u;
      return { x: v * v * v * s.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u * u * u * t.x, y: v * v * v * s.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u * u * u * t.y };
    };
    const samples = Array.from({ length: 33 }, (_, i) => at(i / 32));
    const sideways = (from === "left" || from === "right") && (to === "left" || to === "right");
    return { path: `M${r(s.x)},${r(s.y)} C${r(c1.x)},${r(c1.y)} ${r(c2.x)},${r(c2.y)} ${r(t.x)},${r(t.y)}`, mid: at(0.5), samples, sideways };
  }
  const vertical = from === "left" || from === "right";
  const lane = laneAt(from, s, t, cards, nth);
  const a: Point = vertical ? { x: lane, y: s.y } : { x: s.x, y: lane };
  const b: Point = vertical ? { x: lane, y: t.y } : { x: t.x, y: lane };
  // a corner is rounded by as much as its two legs allow
  const round = (p: Point, q: Point, n: Point): string => {
    const k = Math.min(CORNER, Math.hypot(q.x - p.x, q.y - p.y) / 2, Math.hypot(n.x - q.x, n.y - q.y) / 2);
    const toward = (m: Point, o: Point): Point => { const d = Math.hypot(o.x - m.x, o.y - m.y) || 1; return { x: m.x + ((o.x - m.x) / d) * k, y: m.y + ((o.y - m.y) / d) * k }; };
    const i = toward(q, p), o = toward(q, n);
    return `L${r(i.x)},${r(i.y)} Q${r(q.x)},${r(q.y)} ${r(o.x)},${r(o.y)}`;
  };
  const path = `M${r(s.x)},${r(s.y)} ${round(s, a, b)} ${round(a, b, t)} L${r(t.x)},${r(t.y)}`;
  const samples: Point[] = [];
  for (const [p, q] of [[s, a], [a, b], [b, t]] as const) for (let i = 0; i <= 12; i++) samples.push({ x: p.x + ((q.x - p.x) * i) / 12, y: p.y + ((q.y - p.y) * i) / 12 });
  // the caption sits on the long leg; lanes sharing a side spread theirs along it
  const along = 0.5 + (nth % 2 === 0 ? 1 : -1) * Math.ceil(nth / 2) * 0.16;
  const f = Math.min(0.85, Math.max(0.15, along));
  return { path, mid: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, samples, sideways: !vertical };
}

/** how many of `cards` the wire passes through or brushes */
export function wireHits(wire: Wire, cards: readonly Box[]): number {
  return cards.filter((c) => wire.samples.some((p) => inside(p, c, CLEARANCE))).length;
}

/**
 * The sides for one route with the OTHER cards in view: `edgeSides`' pair while the curve
 * between them is clear, else the same-side lane that crosses the fewest cards (shortest first
 * among equals). `others` must not hold the route's own two cards.
 */
export function routeAround(from: Box, to: Box, others: readonly Box[], opts: { self?: boolean; reverse?: boolean } = {}): { source: Side; target: Side } {
  const preferred = edgeSides(from, to, opts);
  if (opts.self || others.length === 0) return preferred;
  const wire = (side: { source: Side; target: Side }) => wireRoute(sideMid(from, side.source), side.source, sideMid(to, side.target), side.target, [from, to, ...others]);
  if (preferred.source !== preferred.target && wireHits(wire(preferred), others) === 0) return preferred;
  const length = (w: Wire) => w.samples.reduce((sum, p, i) => (i ? sum + Math.hypot(p.x - w.samples[i - 1]!.x, p.y - w.samples[i - 1]!.y) : 0), 0);
  // the lane on the preferred side first, so a loop back up a column stays on the left when it can
  const lanes = [preferred.source === preferred.target ? preferred.source : null, ...SIDES].filter((x, i, all): x is Side => x !== null && all.indexOf(x) === i);
  let best = preferred, bestHits = Infinity, bestLength = Infinity;
  lanes.forEach((side, i) => {
    const w = wire({ source: side, target: side });
    // its own two cards count as well: a lane that has to cross the card it leaves is no lane
    const hits = wireHits(w, others) + [from, to].filter((c) => w.samples.some((p) => inside(p, c, -2))).length;
    const len = length(w) - (i === 0 && preferred.source === preferred.target ? 1e6 : 0);
    if (hits < bestHits || (hits === bestHits && len < bestLength)) { best = { source: side, target: side }; bestHits = hits; bestLength = len; }
  });
  if (preferred.source !== preferred.target && wireHits(wire(preferred), others) <= bestHits) return preferred;
  return best;
}

const GAP = 6;
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width + GAP && a.x + a.width + GAP > b.x && a.y < b.y + b.height + GAP && a.y + a.height + GAP > b.y;

/**
 * The caption's centre: the wire's midpoint, moved the least distance that clears both cards.
 * It looks outward in rings, ACROSS the wire first (up or down for a sideways route, left or
 * right for a vertical one) and then diagonally and along it — so a caption wider than the gap
 * between two cards settles just off the wire's shoulder rather than a card's height away.
 */
export function captionPoint(mid: Point, size: { width: number; height: number }, cards: readonly Box[], sideways: boolean): Point {
  const box = (p: Point): Box => ({ x: p.x - size.width / 2, y: p.y - size.height / 2, width: size.width, height: size.height });
  const clear = (p: Point) => !cards.some((c) => overlaps(box(p), c));
  if (clear(mid)) return mid;
  const across: Array<[number, number]> = sideways ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]];
  const along: Array<[number, number]> = sideways ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]];
  const dirs: Array<[number, number]> = [...across, [-1, -1], [1, -1], [-1, 1], [1, 1], ...along];
  for (let d = 4; d <= 280; d += 4) {
    for (const [ux, uy] of dirs) {
      const p = { x: mid.x + ux * d, y: mid.y + uy * d };
      if (clear(p)) return p;
    }
  }
  return mid;
}

/**
 * Every caption's centre, for a whole canvas: each kept off every card AND off the captions
 * placed before it. One route's caption cannot know where another's went, and two routes that
 * pass each other printed "Otherwise" on top of `goal == ''`; so they are placed together, in
 * `spec.edges` order, each one an obstacle for the next. Pure.
 */
export function placeCaptions(routes: ReadonlyArray<{ mid: Point; size: { width: number; height: number }; sideways: boolean }>, cards: readonly Box[]): Point[] {
  const taken: Box[] = [];
  return routes.map((r) => {
    const at = captionPoint(r.mid, r.size, [...cards, ...taken], r.sideways);
    taken.push({ x: at.x - r.size.width / 2, y: at.y - r.size.height / 2, width: r.size.width, height: r.size.height });
    return at;
  });
}

/** where a wire meets a card: the middle of that side */
export const sideMiddle = (b: Box, side: Side): Point => sideMid(b, side);

/** how wide a caption will be drawn, near enough to keep it off a card: Button `sm` is 13px text and 10px of padding a side */
export function captionSize(label: string): { width: number; height: number } {
  return { width: Math.min(360, Math.max(48, Math.round(label.length * 7.9) + 22)), height: 28 };
}

/** the card a wire's end belongs to, from where the handle is and which side it is on */
export function cardFromHandle(at: Point, side: Side, width: number, height: number): Box {
  switch (side) {
    case "top": return { x: at.x - width / 2, y: at.y, width, height };
    case "bottom": return { x: at.x - width / 2, y: at.y - height, width, height };
    case "left": return { x: at.x, y: at.y - height / 2, width, height };
    case "right": return { x: at.x - width, y: at.y - height / 2, width, height };
  }
}
