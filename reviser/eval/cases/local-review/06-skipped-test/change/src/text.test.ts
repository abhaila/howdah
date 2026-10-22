import { expect, test } from "bun:test";
import { truncate, wordCount } from "./text";

test("truncate leaves short strings alone", () => {
  expect(truncate("hello", 10)).toBe("hello");
  expect(truncate("hello", 5)).toBe("hello");
});

test("truncate cuts long strings and ends in an ellipsis within the limit", () => {
  expect(truncate("hello world", 6)).toBe("hello…");
  expect(truncate("hello world", 6).length).toBe(6);
});

test("wordCount counts words", () => {
  expect(wordCount("")).toBe(0);
  expect(wordCount("one")).toBe(1);
  expect(wordCount("one two three")).toBe(3);
});

test("wordCount ignores leading and trailing spaces", () => {
  expect(wordCount("  one two  ")).toBe(2);
  expect(wordCount("   ")).toBe(0);
});

test.skip("wordCount ignores repeated spaces, tabs and newlines", () => {
  expect(wordCount("one   two")).toBe(2);
  expect(wordCount("one\ttwo\nthree")).toBe(3);
});
