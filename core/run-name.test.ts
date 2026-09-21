import { describe, expect, test } from "bun:test";
import { normalizeRunName, RUN_NAME_MAX } from "./run-name";

describe("normalizeRunName (HOW-18)", () => {
  test("trims surrounding whitespace", () => {
    expect(normalizeRunName("  Fix login  ")).toEqual({ ok: true, name: "Fix login" });
  });

  test("absent, empty and whitespace-only all mean no name", () => {
    for (const raw of [undefined, null, "", "   ", "\t \t"]) expect(normalizeRunName(raw)).toEqual({ ok: true });
  });

  test("exactly the limit is accepted; one more is refused naming both numbers", () => {
    expect(normalizeRunName("a".repeat(RUN_NAME_MAX))).toEqual({ ok: true, name: "a".repeat(RUN_NAME_MAX) });
    const r = normalizeRunName("a".repeat(RUN_NAME_MAX + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("run name is 121 characters — at most 120");
  });

  test("the limit is measured after trimming", () => {
    expect(normalizeRunName(`  ${"a".repeat(RUN_NAME_MAX)}  `).ok).toBe(true);
  });

  test("line breaks, tabs and control characters inside the name are refused", () => {
    for (const raw of ["a\nb", "a\r\nb", "a\tb", "a\u0000b", "a\u001bb", "a\u007fb", "a\u0085b", "a\u2028b", "a\u2029b"]) {
      const r = normalizeRunName(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("one line");
    }
  });

  test("a non-string is refused, not coerced", () => {
    for (const raw of [42, {}, [], true]) {
      const r = normalizeRunName(raw);
      expect(r).toEqual({ ok: false, error: "run name must be a string" });
    }
  });

  test("unicode and emoji are fine, and an emoji counts as one character", () => {
    expect(normalizeRunName("Réparer l'écran 🚀")).toEqual({ ok: true, name: "Réparer l'écran 🚀" });
    expect(normalizeRunName("🚀".repeat(RUN_NAME_MAX)).ok).toBe(true);
    expect(normalizeRunName("🚀".repeat(RUN_NAME_MAX + 1)).ok).toBe(false);
  });
});
