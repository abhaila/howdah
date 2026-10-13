import { expect, test } from "bun:test";
import { slugify } from "./text";

test("oracle: slugify", () => {
  expect(slugify("Hello, World!")).toBe("hello-world");
  expect(slugify("  Already--hyphenated  ")).toBe("already-hyphenated");
  expect(slugify("Ünïcode 123")).toBe("n-code-123");
  expect(slugify("---")).toBe("");
});
