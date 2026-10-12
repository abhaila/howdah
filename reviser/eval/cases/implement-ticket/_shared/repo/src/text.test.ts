import { expect, test } from "bun:test";
import { titleCase, wordCount } from "./text";

test("titleCase", () => expect(titleCase("hello there")).toBe("Hello There"));
test("wordCount on a plain sentence", () => expect(wordCount("one two three")).toBe(3));
