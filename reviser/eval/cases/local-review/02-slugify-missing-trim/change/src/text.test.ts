import { expect, test } from "bun:test";
import { slugify, truncate, wordCount } from "./text";

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

test("slugify lower-cases and hyphenates", () => {
  expect(slugify("Hello World")).toBe("hello-world");
  expect(slugify("Rust and TypeScript")).toBe("rust-and-typescript");
});

test("slugify collapses runs of separators", () => {
  expect(slugify("a  --  b")).toBe("a-b");
});
