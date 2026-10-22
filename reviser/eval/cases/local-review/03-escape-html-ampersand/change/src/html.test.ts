import { expect, test } from "bun:test";
import { element, escapeHtml } from "./html";

test("element wraps its body", () => {
  expect(element("p", "hi")).toBe("<p>hi</p>");
});

test("escapeHtml neutralises markup", () => {
  expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("escapeHtml escapes both quotes", () => {
  expect(escapeHtml(`say "hi" and 'bye'`)).toBe("say &quot;hi&quot; and &#39;bye&#39;");
});

test("escapeHtml leaves plain text alone", () => {
  expect(escapeHtml("hello world")).toBe("hello world");
});
