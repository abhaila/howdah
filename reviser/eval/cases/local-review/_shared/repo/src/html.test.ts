import { expect, test } from "bun:test";
import { element } from "./html";

test("element wraps its body", () => {
  expect(element("p", "hi")).toBe("<p>hi</p>");
});
