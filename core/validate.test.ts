import { describe, expect, test } from "bun:test";
import { validateGraph, formatViolations, type GraphShape } from "./validate";

/**
 * Shapes mirror the real Orbital-derived workflow:
 *
 *   entry(plan) → implement → review ─┬─(pass)──▶ publish → probe ─┬──▶ done
 *                     ▲               └─(reject)──▶ plan_review ────┘
 *                     └──────────────────────────────┘ (loop)
 */
const good: GraphShape = {
  entry: "plan",
  inputs: ["work"],
  nodes: {
    plan: { reads: ["work"], writes: ["plan_out"] },
    implement: { reads: ["work", "plan_out"], writes: ["impl_out"] },
    review: { reads: ["impl_out"], writes: ["review_verdict"] },
    plan_review: { reads: ["review_verdict", "plan_out"], writes: ["plan_out"] },
    publish: { reads: ["work", "impl_out"], writes: ["publication_summary"] },
    probe: { reads: ["publication_summary"], writes: ["pr.state"] },
    done: { reads: ["pr.state", "publication_summary"], writes: [] },
  },
  edges: [
    { from: "plan", to: "implement" },
    { from: "implement", to: "review" },
    { from: "review", to: "publish" },
    { from: "review", to: "plan_review" },
    { from: "plan_review", to: "implement" },
    { from: "publish", to: "probe" },
    { from: "probe", to: "done" },
  ],
};

describe("every-path-has-a-writer (A0.3)", () => {
  test("the realistic loop graph validates clean", () => {
    expect(validateGraph(good)).toEqual([]);
  });

  test("a read with no writer on one branch is caught, with a witness path", () => {
    const g: GraphShape = structuredClone(good);
    // publish now also reads review notes that only plan_review writes —
    // the pass-branch (review → publish) never goes through plan_review.
    g.nodes.plan_review!.writes.push("review_notes");
    g.nodes.publish!.reads.push("review_notes");
    const vs = validateGraph(g);
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({ node: "publish", key: "review_notes" });
    expect(vs[0]!.witness.join("→")).toContain("review");
    expect(formatViolations(vs)).toContain('"publish" reads "review_notes"');
  });

  test("run inputs count as written at entry", () => {
    const g: GraphShape = {
      entry: "a",
      inputs: ["goal"],
      nodes: { a: { reads: ["goal"], writes: [] } },
      edges: [],
    };
    expect(validateGraph(g)).toEqual([]);
  });

  test("a node reading its own output is a violation (reads see the in-set)", () => {
    const g: GraphShape = {
      entry: "a",
      inputs: [],
      nodes: { a: { reads: ["x"], writes: ["x"] } },
      edges: [],
    };
    const vs = validateGraph(g);
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({ node: "a", key: "x" });
  });

  test("cycle where the reader precedes the writer inside the loop is caught", () => {
    // a → b → a : a reads what b writes; the FIRST visit of a has no writer upstream.
    const g: GraphShape = {
      entry: "a",
      inputs: [],
      nodes: {
        a: { reads: ["late"], writes: [] },
        b: { reads: [], writes: ["late"] },
      },
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    };
    const vs = validateGraph(g);
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({ node: "a", key: "late" });
  });

  test("cycle where the writer covers the loop entry is clean", () => {
    // entry writes, loop re-reads — the wait/probe loop shape.
    const g: GraphShape = {
      entry: "publish",
      inputs: [],
      nodes: {
        publish: { reads: [], writes: ["publication_summary"] },
        probe: { reads: ["publication_summary"], writes: [] },
        wait: { reads: [], writes: [] },
      },
      edges: [
        { from: "publish", to: "probe" },
        { from: "probe", to: "wait" },
        { from: "wait", to: "probe" },
      ],
    };
    expect(validateGraph(g)).toEqual([]);
  });

  test("unknown edge endpoints and missing entry are hard errors", () => {
    expect(() =>
      validateGraph({ entry: "ghost", inputs: [], nodes: { a: { reads: [], writes: [] } }, edges: [] }),
    ).toThrow(/entry node/);
    expect(() =>
      validateGraph({
        entry: "a",
        inputs: [],
        nodes: { a: { reads: [], writes: [] } },
        edges: [{ from: "a", to: "ghost" }],
      }),
    ).toThrow(/unknown node/);
  });
});
