import { expect, test } from "bun:test";
import { clamp, mean, sum } from "./stats";

test("sum and mean", () => {
  expect(sum([])).toBe(0);
  expect(sum([1, 2, 3])).toBe(6);
  expect(mean([1, 2, 3, 4])).toBe(2.5);
  expect(() => mean([])).toThrow(RangeError);
});

test("clamp leaves a value inside the range alone", () => {
  expect(clamp(5, 0, 10)).toBe(5);
});

test("clamp limits to either bound, inclusive", () => {
  expect(clamp(-3, 0, 10)).toBe(0);
  expect(clamp(42, 0, 10)).toBe(10);
  expect(clamp(0, 0, 10)).toBe(0);
  expect(clamp(10, 0, 10)).toBe(10);
});

test("clamp with a single-point range", () => {
  expect(clamp(7, 3, 3)).toBe(3);
});

test("clamp works with negative and fractional bounds", () => {
  expect(clamp(-0.5, -1.5, -1)).toBe(-1);
  expect(clamp(-2, -1.5, -1)).toBe(-1.5);
});

test("clamp refuses an empty range", () => {
  expect(() => clamp(1, 5, 2)).toThrow(RangeError);
});
