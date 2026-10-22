import { expect, test } from "bun:test";
import { capitalize, truncate, wordCount } from "./text";

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

test("capitalize upper-cases only the first character", () => {
  expect(capitalize("hello world")).toBe("Hello world");
  expect(capitalize("hELLO")).toBe("HELLO");
});

test("capitalize leaves an empty string and a non-letter start alone", () => {
  expect(capitalize("")).toBe("");
  expect(capitalize("1st place")).toBe("1st place");
});

test("capitalize keeps a character outside the BMP whole", () => {
  expect(capitalize("𝒶bc")).toBe("𝒶bc");
  expect(capitalize("éclair")).toBe("Éclair");
});
