/**
 * HOW-68 — which sides a route uses, and that its caption never sits on a card. The graph in
 * the ticket's capture (triage-bug, arranged left to right) is the fixture.
 */
import { describe, expect, test } from "bun:test";
import { captionPoint, captionSize, cardFromHandle, edgeSides, placeCaptions, routeAround, wireHits, wireRoute, type Box, type Side } from "./routing";

const card = (x: number, y: number): Box => ({ x, y, width: 220, height: 72 });

describe("edgeSides", () => {
  test("a step to the right is reached right → left; one below, bottom → top", () => {
    expect(edgeSides(card(40, 160), card(400, 60))).toEqual({ source: "right", target: "left" });
    expect(edgeSides(card(40, 160), card(400, 320))).toEqual({ source: "right", target: "left" });
    expect(edgeSides(card(0, 0), card(0, 140))).toEqual({ source: "bottom", target: "top" });
    // below and a little to one side is still "below": the cards overlap side to side
    expect(edgeSides(card(0, 0), card(120, 140))).toEqual({ source: "bottom", target: "top" });
  });
  test("a loop back up a column goes round the left, not through the cards between", () => {
    expect(edgeSides(card(0, 420), card(0, 140))).toEqual({ source: "left", target: "left" });
  });
  test("two steps joined both ways along a row do not share one wire", () => {
    const fix = card(400, 60), review = card(760, 60);
    expect(edgeSides(fix, review, { reverse: true })).toEqual({ source: "right", target: "left" });
    expect(edgeSides(review, fix, { reverse: true })).toEqual({ source: "bottom", target: "bottom" });
    // with nothing coming the other way, straight back is the short and readable route
    expect(edgeSides(review, fix)).toEqual({ source: "left", target: "right" });
  });
  test("a route from a step to itself leaves and re-enters on different sides", () => {
    expect(edgeSides(card(0, 0), card(0, 0), { self: true })).toEqual({ source: "right", target: "top" });
  });
});

describe("captionPoint", () => {
  const hit = (p: { x: number; y: number }, s: { width: number; height: number }, c: Box) =>
    p.x - s.width / 2 < c.x + c.width && p.x + s.width / 2 > c.x && p.y - s.height / 2 < c.y + c.height && p.y + s.height / 2 > c.y;
  test("a midpoint already in the gap is left alone", () => {
    const size = captionSize("Otherwise");
    expect(captionPoint({ x: 330, y: 100 }, size, [card(0, 60), card(400, 60)], true)).toEqual({ x: 330, y: 100 });
  });
  test("a caption wider than the gap moves off both cards, across the wire", () => {
    const size = captionSize("review_verdict == 'reject'");
    const cards = [card(400, 60), card(760, 60)];
    const mid = { x: 690, y: 96 }; // the 140px gap between them cannot hold a 228px caption
    const at = captionPoint(mid, size, cards, true);
    expect(at.x).toBe(mid.x);
    expect(at.y).not.toBe(mid.y);
    for (const c of cards) expect(hit(at, size, c)).toBe(false);
  });
  test("it settles beside the wire, not a card's height away, when a diagonal step is shorter", () => {
    // the capture's own case: reproduce (left, lower) → fix (right, higher), a 140px gap and a 170px caption
    const size = captionSize("reproduced == 'yes'");
    const cards = [card(408, 399), card(768, 298)];
    const mid = { x: 698, y: 370 };
    const at = captionPoint(mid, size, cards, true);
    for (const c of cards) expect(hit(at, size, c)).toBe(false);
    expect(Math.hypot(at.x - mid.x, at.y - mid.y)).toBeLessThan(48);
  });
});

test("cardFromHandle rebuilds the card a handle sits on", () => {
  expect(cardFromHandle({ x: 260, y: 196 }, "right", 220, 72)).toEqual({ x: 40, y: 160, width: 220, height: 72 });
  expect(cardFromHandle({ x: 150, y: 160 }, "top", 220, 72)).toEqual({ x: 40, y: 160, width: 220, height: 72 });
});

// The confirming review's finding: a step added from the palette landed under the Finish card,
// and the route to it, wired from the panel, was drawn THROUGH that card.
describe("a wire goes round a card that is not its own", () => {
  const mid = (b: Box, side: Side) =>
    side === "top" ? { x: b.x + 110, y: b.y } : side === "bottom" ? { x: b.x + 110, y: b.y + b.height } : side === "left" ? { x: b.x, y: b.y + 36 } : { x: b.x + 220, y: b.y + 36 };
  const drawn = (from: Box, to: Box, others: Box[], opts = {}) => {
    const sides = routeAround(from, to, others, opts);
    return { sides, wire: wireRoute(mid(from, sides.source), sides.source, mid(to, sides.target), sides.target, [from, to, ...others]) };
  };

  test("with nothing in the way the pair is edgeSides' own, and the curve is React Flow's bezier", () => {
    const a = card(0, 0), b = card(0, 200);
    expect(routeAround(a, b, [card(600, 0)])).toEqual(edgeSides(a, b));
    const w = wireRoute({ x: 110, y: 72 }, "bottom", { x: 110, y: 200 }, "top");
    expect(w.path).toBe("M110,72 C110,136 110,136 110,200");
    expect(w.mid).toEqual({ x: 110, y: 136 });
  });

  test("the capture: work above, Finish between, the new step below — the route takes a lane beside the Finish", () => {
    const work = card(130, 320), done = card(190, 490), review = card(160, 685);
    // the straight route is through the Finish card
    const straight = edgeSides(work, review);
    expect(wireHits(wireRoute(mid(work, straight.source), straight.source, mid(review, straight.target), straight.target), [done])).toBe(1);
    const { sides, wire } = drawn(work, review, [done]);
    expect(sides.source).toBe(sides.target);
    expect(wireHits(wire, [done])).toBe(0);
    // ...and the loop back up, which used to be a line up the cards' own left edges
    const back = drawn(review, work, [done], { reverse: true });
    expect(wireHits(back.wire, [done])).toBe(0);
  });

  test("a card standing between two steps in a row is passed above or below", () => {
    const a = card(0, 100), wall = card(300, 100), b = card(600, 100);
    const { sides, wire } = drawn(a, b, [wall]);
    expect(["top", "bottom"]).toContain(sides.source);
    expect(wireHits(wire, [wall])).toBe(0);
  });

  test("a lane clears every card in the stretch it passes, and two lanes on one side are two lines", () => {
    const a = card(0, 0), b = card(0, 600), wide = card(60, 300);
    const one = wireRoute({ x: 220, y: 36 }, "right", { x: 220, y: 636 }, "right", [a, b, wide], 0);
    const two = wireRoute({ x: 220, y: 36 }, "right", { x: 220, y: 636 }, "right", [a, b, wide], 1);
    expect(wireHits(one, [wide])).toBe(0);
    const laneX = (w: { samples: Array<{ x: number }> }) => Math.max(...w.samples.map((p) => p.x));
    expect(laneX(one)).toBeGreaterThan(wide.x + wide.width + 8);
    expect(laneX(two)).toBeGreaterThan(laneX(one));
    expect(one.mid).not.toEqual(two.mid); // their captions are apart along the lane as well
  });

  test("a five-step graph wired every way: no wire through any card it does not join", () => {
    // a column with a Finish in it, a step beside, a step below — every ordered pair is a route
    const cards = [card(40, 40), card(40, 208), card(308, 40), card(308, 376), card(576, 208)];
    for (let i = 0; i < cards.length; i++) for (let j = 0; j < cards.length; j++) {
      if (i === j) continue;
      const others = cards.filter((_, k) => k !== i && k !== j);
      const { wire, sides } = drawn(cards[i]!, cards[j]!, others);
      expect(wireHits(wire, others), `${i}→${j} ${JSON.stringify(sides)}`).toBe(0);
    }
  });

  test("a caption is kept off EVERY card, not only the route's own two", () => {
    const size = captionSize("verdict == 'reject'");
    const third = card(200, 200);
    const p = captionPoint({ x: 310, y: 236 }, size, [card(0, 0), card(0, 600), third], false);
    const hit = p.x - size.width / 2 < third.x + third.width && p.x + size.width / 2 > third.x && p.y - size.height / 2 < third.y + third.height && p.y + size.height / 2 > third.y;
    expect(hit).toBe(false);
  });
});

describe("captions are placed together, so no two share a spot", () => {
  const boxOf = (p: { x: number; y: number }, s: { width: number; height: number }): Box => ({ x: p.x - s.width / 2, y: p.y - s.height / 2, width: s.width, height: s.height });
  const overlap = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

  test("three routes whose middles coincide get three places, each clear of the cards", () => {
    const cards = [card(0, 0), card(0, 300)];
    const size = captionSize("goal == ''");
    const routes = [0, 1, 2].map(() => ({ mid: { x: 110, y: 186 }, size, sideways: false }));
    const at = placeCaptions(routes, cards);
    expect(at[0]).toEqual({ x: 110, y: 186 }); // the first keeps its wire's middle
    const boxes = at.map((p) => boxOf(p, size));
    boxes.forEach((a, i) => {
      boxes.slice(i + 1).forEach((b) => expect(overlap(a, b)).toBe(false));
      for (const c of cards) expect(overlap(a, c)).toBe(false);
    });
  });
});
