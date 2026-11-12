/**
 * HOW-68: contrast is a test, not a comment.
 *
 * The old faint text was 3.06:1 in dark and 3.19:1 in light, on 93 screens, under a file
 * header that said every value cleared 4.5:1. tokens.css is the only place a colour is
 * decided, and every colour is one `light-dark()` pair, so the whole question can be answered
 * here without a browser: each text token, on each ground it is drawn on, in both themes.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "../public/tokens.css"), "utf8");

function pair(name: string): [string, string] {
  const m = css.match(new RegExp(`--${name}:\\s*light-dark\\(#([0-9A-Fa-f]{6}),\\s*#([0-9A-Fa-f]{6})\\)`));
  if (!m || m[1] === undefined || m[2] === undefined) throw new Error(`--${name} is not a light-dark() pair of hex colours`);
  return [m[1], m[2]];
}
function luminance(hex: string): number {
  const ch = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** text token → the grounds it is drawn on */
const TEXT: Array<[string, string[]]> = [
  ["fg", ["bg", "bg-raised", "bg-inset"]],
  ["fg-muted", ["bg", "bg-raised", "bg-inset"]],
  ["fg-faint", ["bg", "bg-raised", "bg-inset"]],
  ["primary", ["bg", "bg-raised"]],
  ["primary-fg", ["primary", "primary-hover"]],
  ["attention", ["bg", "bg-raised"]],
  ["attention-fg", ["attention-bg"]],
  ["on-attention", ["attention"]],
  ["status-running", ["bg", "bg-raised"]],
  ["status-waiting", ["bg", "bg-raised"]],
  ["status-queued", ["bg", "bg-raised"]],
  ["status-done", ["bg", "bg-raised"]],
  ["status-failed-recoverable", ["bg", "bg-raised"]],
  ["status-failed-terminal", ["bg", "bg-raised"]],
  ["on-alarm", ["status-failed-recoverable"]],
  ["diff-add", ["bg", "bg-raised"]],
  ["diff-del", ["bg", "bg-raised"]],
  ["scope-cleared", ["bg", "bg-raised"]],
];

describe("tokens.css contrast (WCAG 2.2 AA)", () => {
  for (const [text, grounds] of TEXT) {
    for (const ground of grounds) {
      test(`--${text} on --${ground} is at least 4.5:1 in both themes`, () => {
        const t = pair(text);
        const g = pair(ground);
        expect(contrast(t[0], g[0]), "light").toBeGreaterThanOrEqual(4.5);
        expect(contrast(t[1], g[1]), "dark").toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  test("control boundaries and the focus ring are at least 3:1 against the ground", () => {
    for (const ground of ["bg", "bg-raised"]) {
      const g = pair(ground);
      const ring = pair("ring");
      expect(contrast(ring[0], g[0])).toBeGreaterThanOrEqual(3);
      expect(contrast(ring[1], g[1])).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("tokens.css type", () => {
  test("six sizes, and nothing below 12px", () => {
    const sizes = [...css.matchAll(/--type-[\w]+:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
    expect(Math.min(...sizes)).toBe(12);
    expect([...new Set(sizes)].sort((a, b) => a - b)).toEqual([12, 13, 14, 16, 20, 28]);
  });

  test("fonts are bundled: no stylesheet or font is fetched from another origin", () => {
    expect(css).not.toMatch(/https?:\/\//);
    const html = readFileSync(join(import.meta.dir, "../public/index.html"), "utf8");
    expect(html).not.toContain("fonts.googleapis.com");
  });
});
