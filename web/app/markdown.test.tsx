/**
 * The markdown subset agents write (HOW-29), and the rule that model output never becomes
 * markup: a link is an anchor only for http(s)/mailto, and HTML in the text stays text.
 */
import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Markdown, inline, parseMarkdown } from "@/components/ui/markdown";

function html(text: string): HTMLElement {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(<Markdown text={text} />));
  return host;
}

describe("parseMarkdown", () => {
  test("headings, paragraphs, rules and fenced code", () => {
    const b = parseMarkdown("# Title\n\nsome text\nmore\n\n---\n\n```ts\nconst a = `x`;\n\n# not a heading\n```");
    expect(b.map((x) => x.t)).toEqual(["heading", "p", "hr", "code"]);
    expect(b[3]).toEqual({ t: "code", lang: "ts", v: "const a = `x`;\n\n# not a heading" });
  });

  test("a list nests by indentation, including the loose two-space bullet under `1.`", () => {
    const b = parseMarkdown("1. first\n  - child a\n  - child b\n2. second\n\n3. third");
    expect(b).toHaveLength(1);
    const list = b[0] as Extract<(typeof b)[number], { t: "list" }>;
    expect(list.ordered).toBe(true);
    expect(list.items).toHaveLength(3);
    expect(list.items[0]![1]!.t).toBe("list");
  });

  test("a numbered list keeps its start", () => {
    const b = parseMarkdown("4. four\n5. five");
    expect(b[0]).toMatchObject({ t: "list", start: 4 });
  });

  test("pipe tables", () => {
    const b = parseMarkdown("| a | b |\n|---|:-:|\n| 1 | 2 |");
    expect(b[0]).toMatchObject({ t: "table", align: [null, "center"] });
  });

  test("a heading interrupts a paragraph without a blank line", () => {
    expect(parseMarkdown("text\n## Head").map((x) => x.t)).toEqual(["p", "heading"]);
  });
});

describe("inline", () => {
  test("bold, italic and code", () => {
    expect(inline("**b** and *i* and `c`")).toEqual([
      { t: "strong", c: [{ t: "text", v: "b" }] },
      { t: "text", v: " and " },
      { t: "em", c: [{ t: "text", v: "i" }] },
      { t: "text", v: " and " },
      { t: "code", v: "c" },
    ]);
  });

  test("snake_case_names and arithmetic are not emphasis", () => {
    expect(inline("snake_case_name")).toEqual([{ t: "text", v: "snake_case_name" }]);
    expect(inline("2 * 3 * 4")).toEqual([{ t: "text", v: "2 * 3 * 4" }]);
  });

  test("a link is an anchor only for a safe scheme", () => {
    expect(inline("[x](https://a.b)")[0]).toMatchObject({ t: "link", href: "https://a.b" });
    expect(inline("[x](javascript:alert(1))")[0]!.t).toBe("text");
  });
});

describe("Markdown", () => {
  test("HTML in model output stays text", () => {
    const el = html("<img src=x onerror=alert(1)> **bold**");
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(el.querySelector("strong")!.textContent).toBe("bold");
  });

  test("a javascript: link never becomes an anchor", () => {
    const el = html("[click](javascript:alert(1))");
    expect(el.querySelector("a")).toBeNull();
  });
});
