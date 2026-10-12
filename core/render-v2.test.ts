/**
 * HOW-37: render rules v2 — an oversized context value is clipped head and tail around a stub
 * that says where the whole of it is, and `| dump` means something. Pinned here: the boundary
 * (N-1, N, N+1), surrogate pairs at the cut, the not-valid-JSON note, the filter grammar, and
 * that v1 — every pre-HOW-37 render — is byte-for-byte unchanged.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_CONTEXT_CAP, RENDER_VERSION, TemplateError, elide, renderTemplate, templateFilterProblems } from "./template";

const v2 = (cap: number, extra: object = {}) => ({ version: 2, cap, sourceOf: (k: string) => `the output of producer@3 (${k})`, ...extra });
const render = (body: string, values: Record<string, unknown>, rules?: Parameters<typeof renderTemplate>[2]) =>
  renderTemplate(body, (k) => values[k], rules);

describe("the cap, at its boundary", () => {
  const N = 100;
  test("N-1 and N render whole; N+1 is elided", () => {
    for (const len of [N - 1, N]) {
      const r = render("{{ context.x }}", { x: "a".repeat(len) }, v2(N));
      expect(r.text).toBe("a".repeat(len));
      expect(r.elided).toEqual({});
    }
    const over = render("{{ context.x }}", { x: "a".repeat(N + 1) }, v2(N));
    expect(over.text).toContain("[context.x elided: 101 chars, 1 lines");
    expect(over.text.startsWith("a".repeat(50))).toBe(true);
    expect(over.text.endsWith("a".repeat(50))).toBe(true);
    expect(over.elided).toEqual({ x: "the output of producer@3 (x)" });
  });

  test("the stub names where the whole value is, and how to get it back", () => {
    const { text } = render("{{ context.x }}", { x: "z\n".repeat(500) }, v2(100));
    expect(text).toContain("501 lines");
    expect(text).toContain("The full value is the output of producer@3 (x) — re-read or re-run its source to get it again.");
  });

  test("the stored value is never touched: `read` holds it in full", () => {
    const value = { findings: "f".repeat(5000) };
    const r = render("{{ context.x }}", { x: value }, v2(100));
    expect(r.read.x).toBe(value);
  });

  test("an exempt key (the run's own inputs) is never elided", () => {
    const r = render("{{ inputs.work }}", { work: "w".repeat(500) }, v2(100, { exempt: new Set(["work"]) }));
    expect(r.text).toBe("w".repeat(500));
  });
});

describe("multi-byte text at the cut point", () => {
  test("a surrogate pair (emoji) straddling either cut is never split", () => {
    // head ends at 50: put an emoji at 49..50; tail starts at len-50: put one there too
    const s = "a".repeat(49) + "🐘" + "b".repeat(200) + "🐘" + "c".repeat(48);
    const { text } = render("{{ context.x }}", { x: s }, v2(100));
    // no lone surrogate anywhere: encoding round-trips exactly
    expect(new TextDecoder().decode(new TextEncoder().encode(text))).toBe(text);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  test("CJK and accented text clip on a character boundary", () => {
    const s = "日本語のテキスト".repeat(40) + "naïve café";
    const { text } = render("{{ context.x }}", { x: s }, v2(64));
    expect(text.slice(0, 32)).toBe(s.slice(0, 32));
  });
});

describe("JSON values", () => {
  test("a JSON value is clipped AFTER stringify, and the stub says the result is not valid JSON", () => {
    const { text } = render("{{ context.f | dump }}", { f: [{ evidence: "e".repeat(300) }] }, v2(100));
    expect(text.startsWith('[{"evidence":"')).toBe(true);
    expect(text).toContain("NOT valid JSON");
    expect(() => JSON.parse(text)).toThrow();
  });

  test("a plain string gets no JSON note", () => {
    const { text } = render("{{ context.s }}", { s: "s".repeat(300) }, v2(100));
    expect(text).not.toContain("JSON");
  });
});

describe("`| dump` has one meaning (v2), and an unknown filter is an error", () => {
  test("dump is compact JSON — for a string too, which is how it differs from no filter", () => {
    expect(render("{{ context.s | dump }}", { s: "hi" }, v2(1000)).text).toBe('"hi"');
    expect(render("{{ context.s }}", { s: "hi" }, v2(1000)).text).toBe("hi");
    expect(render("{{ context.o | dump }}", { o: { a: [1] } }, v2(1000)).text).toBe('{"a":[1]}');
    expect(render("{{ context.o }}", { o: { a: [1] } }, v2(1000)).text).toBe('{"a":[1]}');
  });

  test("an unknown filter is a validation error with a message, and a v2 render refuses it", () => {
    expect(templateFilterProblems("x {{ context.a | dump }} {{ context.b | upper }}")).toEqual([
      '`{{ context.b | upper }}` uses the filter "upper", which does nothing — the only filter is `dump` (the value as JSON)',
    ]);
    expect(() => render("{{ context.b | upper }}", { b: "x" }, v2(10))).toThrow(TemplateError);
  });
});

describe("v1 is untouched (every pre-HOW-37 render)", () => {
  test("no cap, filters ignored, strings raw — byte-for-byte what it always was", () => {
    const big = "x".repeat(DEFAULT_CONTEXT_CAP * 2);
    expect(render("{{ context.s | dump }}|{{ context.b }}", { s: "hi", b: big }).text).toBe(`hi|${big}`);
    expect(render("{{ context.s | anything }}", { s: "hi" }).text).toBe("hi");
  });

  test("the current version is 2, and elide() alone is deterministic", () => {
    expect(RENDER_VERSION).toBe(2);
    expect(elide("k", "abcdefghij", 4, { json: false })).toBe(elide("k", "abcdefghij", 4, { json: false }));
  });
});
