import { expect, test } from "bun:test";
import { mean, sum } from "./stats";

test("sum and mean", () => {
  expect(sum([])).toBe(0);
  expect(sum([1, 2, 3])).toBe(6);
  expect(mean([1, 2, 3, 4])).toBe(2.5);
  expect(() => mean([])).toThrow(RangeError);
});
