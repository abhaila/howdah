import { expect, test } from "bun:test";
import { chunk, paginate } from "./list";

test("chunk splits into groups", () => {
  expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  expect(chunk([], 3)).toEqual([]);
});

test("chunk refuses a size below one", () => {
  expect(() => chunk([1], 0)).toThrow(RangeError);
});

const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

test("paginate returns one page", () => {
  expect(paginate(ten, 1, 3)).toEqual([4, 5, 6]);
  expect(paginate(ten, 2, 3)).toEqual([7, 8, 9]);
});

test("paginate past the end is empty", () => {
  expect(paginate(ten, 5, 3)).toEqual([]);
});

test("paginate refuses a page or size below one", () => {
  expect(() => paginate(ten, 0, 3)).toThrow(RangeError);
  expect(() => paginate(ten, 1, 0)).toThrow(RangeError);
});
