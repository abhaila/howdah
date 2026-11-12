/**
 * HOW-68: the "a run needs you" sound is for news, and only when asked for.
 *
 * It used to ring on navigation — every screen mounted with no data, then loaded, and the
 * false→true flip was read as a new ask — and the setting that should have muted it was never
 * read. `decideRing` is the whole decision, so it is pinned here without a DOM.
 */
import { describe, expect, test } from "bun:test";
import { decideNews, decideRing } from "@/lib/attention-sound";

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

/**
 * HOW-68: the same decision drives the browser notification, which needs to know WHICH runs
 * are new (it names each one). `decideRing` is `decideNews` plus the sound setting, so the two
 * surfaces cannot disagree about what counts as news.
 */
describe("decideNews", () => {
  test("names the runs that newly started waiting, and only those", () => {
    expect(decideNews(["a"], { waiting: ["a", "c", "d"], cleared: "others" })).toEqual({ fresh: ["c", "d"], seen: ["a", "c", "d"] });
  });

  test("the first sight of a session is not news, whatever is standing", () => {
    expect(decideNews(null, { waiting: ["a", "b"], cleared: "others" })).toEqual({ fresh: [], seen: ["a", "b"] });
  });

  test("a run already seen is never fresh again until a screen says it stopped waiting", () => {
    expect(decideNews(["a"], { waiting: ["a"], cleared: [] }).fresh).toEqual([]);
    const answered = decideNews(["a"], { waiting: [], cleared: ["a"] });
    expect(decideNews(answered.seen, { waiting: ["a"], cleared: [] }).fresh).toEqual(["a"]);
  });

  test("the notes a screen passes along do not change what is news", () => {
    const info = { a: { name: "A", body: "x" }, b: { name: "B", body: "y" } };
    expect(decideNews(["a"], { waiting: ["a", "b"], cleared: "others", info })).toEqual(decideNews(["a"], { waiting: ["a", "b"], cleared: "others" }));
  });

  test("decideRing agrees with it: a ring exactly when something is fresh and the sound is on", () => {
    for (const o of [{ waiting: ["a"], cleared: "others" as const }, { waiting: ["a", "b"], cleared: "others" as const }]) {
      const news = decideNews(["a"], o);
      expect(decideRing(["a"], o, true)).toEqual({ ring: news.fresh.length > 0, seen: news.seen });
      expect(decideRing(["a"], o, false).ring).toBe(false);
    }
  });
});
