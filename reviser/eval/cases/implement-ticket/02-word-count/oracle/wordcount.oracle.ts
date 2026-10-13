import { expect, test } from "bun:test";
import { wordCount } from "./text";

test("oracle: wordCount", () => {
  expect(wordCount("")).toBe(0);
  expect(wordCount("   ")).toBe(0);
  expect(wordCount("one  two\tthree\nfour")).toBe(4);
  expect(wordCount(" padded ")).toBe(1);
});
