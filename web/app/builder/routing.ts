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
