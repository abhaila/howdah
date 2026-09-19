import { describe, expect, test } from "bun:test";
import { canonicalJson, proposalHash } from "./proposal";
import { renderedHash } from "./template";

describe("proposalHash (system-map D15)", () => {
  test("key order never changes the hash, at any depth", () => {
    const a = { ops: [{ id: "x", kind: "add", meta: { b: 1, a: 2 } }], title: "t" };
    const b = { title: "t", ops: [{ meta: { a: 2, b: 1 }, kind: "add", id: "x" }] };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(proposalHash(a)).toBe(proposalHash(b));
  });

  test("array order and values do change it", () => {
    expect(proposalHash([1, 2])).not.toBe(proposalHash([2, 1]));
    expect(proposalHash({ a: 1 })).not.toBe(proposalHash({ a: 2 }));
  });

  test("a value and its JSON round-trip hash the same (undefined members vanish like JSON)", () => {
    const v = { a: 1, gone: undefined, when: new Date("2026-09-19T10:00:00Z"), list: [{ z: 1, y: undefined }] };
    expect(proposalHash(v)).toBe(proposalHash(JSON.parse(JSON.stringify(v))));
  });

  test("the hash function IS renderedHash over the canonical JSON", () => {
    expect(proposalHash({ b: 1, a: [true, null] })).toBe(renderedHash('{"a":[true,null],"b":1}'));
    expect(proposalHash("plain")).toBe(renderedHash('"plain"'));
    expect(proposalHash(undefined)).toBe(renderedHash("null"));
  });
});
