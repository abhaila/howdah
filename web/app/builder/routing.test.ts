/**
 * HOW-68 — which sides a route uses, and that its caption never sits on a card. The graph in
 * the ticket's capture (triage-bug, arranged left to right) is the fixture.
 */
import { describe, expect, test } from "bun:test";
import { captionPoint, captionSize, cardFromHandle, edgeSides, type Box } from "./routing";

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
