import { expect, test } from "bun:test";
import { mean, median, sum } from "./stats";

test("sum and mean", () => {
  expect(sum([])).toBe(0);
  expect(sum([1, 2, 3])).toBe(6);
  expect(mean([1, 2, 3, 4])).toBe(2.5);
  expect(() => mean([])).toThrow(RangeError);
});

test("median of an odd-length list", () => {
  expect(median([1, 2, 3])).toBe(2);
  expect(median([1, 3, 5, 7, 9])).toBe(5);
  expect(median([42])).toBe(42);
});

test("median of an even-length list", () => {
  expect(median([1, 2, 3, 4])).toBe(3);
});

test("median refuses an empty list", () => {
  expect(() => median([])).toThrow(RangeError);
});
