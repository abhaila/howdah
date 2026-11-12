/**
 * HOW-68 — one way to write a length of time and one way to write a moment. Each case here is
 * a string that was on screen: "5m 60s" on a step row, "8h 0m" beside "1h 04m", and a proposal
 * dated "11/12/2026, 10:11:37 AM" beside a history row dated "11/12/2026".
 */
import { describe, expect, test } from "bun:test";
import { fmtClock, fmtDay, fmtDur, fmtWait, fmtWhen, graphDescription } from "./format";

describe("fmtDur", () => {
  test("never prints sixty seconds", () => {
    expect(fmtDur(5 * 60_000 + 59_600)).toBe("6m 0s");
    expect(fmtDur(59_960)).toBe("1m 0s");
    expect(fmtDur(59_900)).toBe("59.9s");
    expect(fmtDur(59 * 60_000 + 59_700)).toBe("1h 00m");
  });
  test("the readings it always gave", () => {
    expect(fmtDur(null)).toBe("…");
    expect(fmtDur(900)).toBe("900ms");
    expect(fmtDur(3 * 60_000 + 10_000)).toBe("3m 10s");
    expect(fmtDur(64 * 60_000)).toBe("1h 04m");
  });
});

test("fmtWait writes hours the way fmtDur does", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  expect(fmtWait("2026-11-12T04:00:00Z", now)).toBe("8h 00m");
  expect(fmtWait("2026-11-12T09:08:00Z", now)).toBe("2h 52m");
  expect(fmtWait("2026-11-12T11:40:00Z", now)).toBe("20m");
  expect(fmtWait("2026-11-12T11:59:40Z", now)).toBe("<1m");
});

describe("a moment is written one way", () => {
  const iso = "2026-10-12T10:00:00.000Z";
  test("to the minute, never the second; and an absent or broken one is a dash", () => {
    expect(fmtWhen(iso)).not.toMatch(/:\d\d:\d\d/);
    expect(fmtWhen(iso)).toMatch(/2026/);
    expect(fmtWhen(null)).toBe("—");
    expect(fmtWhen("not a date")).toBe("—");
    expect(fmtDay(iso)).not.toMatch(/:/);
    expect(fmtClock(iso)).not.toMatch(/2026/);
  });
});

test("graphDescription never prints the scaffold's note to the author", () => {
  // `new-graph` writes this line into every graph; the Graphs list and New run printed it
  expect(graphDescription("TODO: one line on what this graph does")).toBeNull();
  expect(graphDescription("  ")).toBeNull();
  expect(graphDescription(undefined)).toBeNull();
  expect(graphDescription("Deliver one ticket through a merged PR")).toBe("Deliver one ticket through a merged PR");
  // a description that merely mentions a to-do is a description
  expect(graphDescription("Sort the TODOs in a file")).toBe("Sort the TODOs in a file");
});
