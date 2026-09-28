import { describe, expect, test } from "bun:test";
import { locateOutputs, splitOutputs } from "./outputs";

describe("locateOutputs (shared by the engine and the viewer, HOW-29)", () => {
  test("finds the LAST object and balances braces inside strings", () => {
    const text = 'quoting {"outputs": {"a": 1}} then\n{"outputs": {"a": "a } b {"}}';
    const span = locateOutputs(text)!;
    expect(JSON.parse(text.slice(span.start, span.end!))).toEqual({ outputs: { a: "a } b {" } });
  });

  test("unterminated is reported as such, not as absent", () => {
    expect(locateOutputs('x {"outputs": {"a": "b')).toEqual({ start: 2, end: null });
    expect(locateOutputs("no contract here")).toBeNull();
  });
});

describe("splitOutputs", () => {
  test("lifts the object out of the prose", () => {
    const s = splitOutputs('Summary.\n\n{"outputs": {"plan": "# P\\n\\n- a"}}');
    expect(s.before.trim()).toBe("Summary.");
    expect(s.outputs).toEqual({ plan: "# P\n\n- a" });
    expect(s.after).toBe("");
  });

  test("a fenced contract leaves no stray fence behind", () => {
    const s = splitOutputs('Summary.\n```json\n{"outputs": {"a": 1}}\n```\n');
    expect(s.before.trim()).toBe("Summary.");
    expect(s.after.trim()).toBe("");
  });

  test("invalid JSON is left in the text rather than hidden", () => {
    const text = 'Summary.\n{"outputs": {"a": nope}}';
    expect(splitOutputs(text)).toEqual({ before: text, outputs: null, after: "", pending: false });
  });

  test("a streaming object is pending", () => {
    const s = splitOutputs('Summary.\n{"outputs": {"a": "hal');
    expect(s.pending).toBe(true);
    expect(s.before.trim()).toBe("Summary.");
  });
});
