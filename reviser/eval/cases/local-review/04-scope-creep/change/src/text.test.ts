import { expect, test } from "bun:test";
import { titleCase, truncate, wordCount } from "./text";

test("truncate leaves short strings alone", () => {
  expect(truncate("hello", 10)).toBe("hello");
  expect(truncate("hello", 5)).toBe("hello");
});

test("truncate cuts long strings and marks the cut", () => {
  expect(truncate("hello world", 5)).toBe("hello...");
});

test("wordCount counts words", () => {
  expect(wordCount("")).toBe(0);
  expect(wordCount("one")).toBe(1);
  expect(wordCount("one two three")).toBe(3);
});

test("titleCase capitalises every word", () => {
  expect(titleCase("the quick brown fox")).toBe("The Quick Brown Fox");
  expect(titleCase("hELLO wORLD")).toBe("Hello World");
});

test("titleCase keeps empty input and repeated spaces", () => {
  expect(titleCase("")).toBe("");
  expect(titleCase("a  b")).toBe("A  B");
});
