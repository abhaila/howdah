import { expect, test } from "bun:test";
import { chunk } from "./list";

test("chunk splits into groups", () => {
  expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  expect(chunk([], 3)).toEqual([]);
});

test("chunk refuses a size below one", () => {
  expect(() => chunk([1], 0)).toThrow(RangeError);
});
