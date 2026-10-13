/** HOW-42: the statistics, against known values. */
import { describe, expect, test } from "bun:test";
import { MIN_DISCORDANT, benjaminiHochberg, enoughDiscordant, mcnemarExact, median } from "./stats";

describe("exact two-sided McNemar", () => {
  test("no discordant pairs: p = 1", () => expect(mcnemarExact(0, 0)).toBe(1));
  test("all discordant one way: (0, 10) = 2 · 0.5^10", () => {
    expect(mcnemarExact(0, 10)).toBeCloseTo(2 * 0.5 ** 10, 12);
    expect(mcnemarExact(10, 0)).toBeCloseTo(2 * 0.5 ** 10, 12);
  });
  test("a balanced split: (5, 5) = 1", () => expect(mcnemarExact(5, 5)).toBe(1));
  test("a textbook value: (2, 8) — P(X ≤ 2 | n=10) = 56/1024, doubled", () => expect(mcnemarExact(2, 8)).toBeCloseTo((2 * 56) / 1024, 12));
  test("large n stays a probability", () => {
    const p = mcnemarExact(400, 600);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1e-9);
  });
  test("power: 5 one-way discordant pairs cannot reach 0.05, 6 can", () => {
    expect(mcnemarExact(0, 5)).toBeGreaterThan(0.05);
    expect(mcnemarExact(0, 6)).toBeLessThan(0.05);
    expect(MIN_DISCORDANT).toBe(6);
    expect(enoughDiscordant(5)).toBe(false);
    expect(enoughDiscordant(6)).toBe(true);
  });
});

describe("Benjamini–Hochberg", () => {
  test("the worked example: p = [0.01, 0.04, 0.03, 0.005] → [0.02, 0.04, 0.04, 0.02]", () => {
    // ranked 0.005, 0.01, 0.03, 0.04 → ×4/1, ×4/2, ×4/3, ×4/4 = 0.02, 0.02, 0.04, 0.04 (monotone)
    const adj = benjaminiHochberg([0.01, 0.04, 0.03, 0.005]);
    [0.02, 0.04, 0.04, 0.02].forEach((v, i) => expect(adj[i]).toBeCloseTo(v, 12));
  });
  test("monotone: a larger raw p never gets a smaller adjusted one, and nothing exceeds 1", () => {
    const adj = benjaminiHochberg([0.04, 0.045, 0.9]);
    expect(adj[0]).toBeCloseTo(0.0675, 12);
    expect(adj[1]).toBeCloseTo(0.0675, 12);
    expect(adj[2]).toBe(0.9);
    expect(benjaminiHochberg([0.6, 0.7])).toEqual([0.7, 0.7]);
  });
  test("one comparison is unchanged", () => expect(benjaminiHochberg([0.03])).toEqual([0.03]));
});

test("median", () => {
  expect(median([])).toBeNull();
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 2, 3])).toBe(2.5);
});
