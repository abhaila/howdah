/**
 * HOW-68: the "a run needs you" sound is for news, and only when asked for.
 *
 * It used to ring on navigation — every screen mounted with no data, then loaded, and the
 * false→true flip was read as a new ask — and the setting that should have muted it was never
 * read. `decideRing` is the whole decision, so it is pinned here without a DOM.
 */
import { describe, expect, test } from "bun:test";
import { decideRing } from "@/lib/attention-sound";

describe("decideRing", () => {
  test("the first sight of a session seeds what is known and stays silent", () => {
    expect(decideRing(null, { waiting: ["a", "b"], cleared: "others" }, true)).toEqual({ ring: false, seen: ["a", "b"] });
  });

  test("a run already known to be waiting is not news — navigation rings nothing", () => {
    expect(decideRing(["a", "b"], { waiting: ["a", "b"], cleared: "others" }, true).ring).toBe(false);
    expect(decideRing(["a", "b"], { waiting: ["a"], cleared: [] }, true).ring).toBe(false); // a run's own page
  });

  test("a run that starts waiting rings once", () => {
    const first = decideRing(["a"], { waiting: ["a", "c"], cleared: "others" }, true);
    expect(first).toEqual({ ring: true, seen: ["a", "c"] });
    expect(decideRing(first.seen, { waiting: ["a", "c"], cleared: "others" }, true).ring).toBe(false);
  });

  test("the setting is honoured: off means silent, and the ask is still remembered", () => {
    expect(decideRing([], { waiting: ["a"], cleared: "others" }, false)).toEqual({ ring: false, seen: ["a"] });
  });

  test("a run that was answered and asks again is news again", () => {
    const answered = decideRing(["a", "b"], { waiting: ["b"], cleared: "others" }, true);
    expect(answered.seen).toEqual(["b"]);
    expect(decideRing(answered.seen, { waiting: ["a", "b"], cleared: "others" }, true).ring).toBe(true);
  });

  test("a run's own page clears only that run", () => {
    expect(decideRing(["a", "b"], { waiting: [], cleared: ["a"] }, true).seen).toEqual(["b"]);
    expect(decideRing(["b"], { waiting: ["a"], cleared: [] }, true)).toEqual({ ring: true, seen: ["b", "a"] });
  });
});
