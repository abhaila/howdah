/**
 * HOW-54 — cycle membership, computed at validate time from the graph's shape: the only nodes a
 * run can revisit, and so the only place "this visit changed nothing" can mean a stalled loop.
 */
import { describe, expect, test } from "bun:test";
import { cycleNodes } from "./validate";
import { buildGraph, type GraphSpec } from "./graph-spec";
import { GRAPHS } from "../graphs/index";

const shape = (edges: Array<[string, string]>, ids = [...new Set(edges.flat())]) => ({
  nodes: Object.fromEntries(ids.map((id) => [id, { reads: [], writes: [] }])),
  edges: edges.map(([from, to]) => ({ from, to })),
});

describe("cycleNodes", () => {
  test("a straight line has none; a loop and a self-edge do", () => {
    expect([...cycleNodes(shape([["a", "b"], ["b", "c"]]))]).toEqual([]);
    expect([...cycleNodes(shape([["a", "b"], ["b", "c"], ["c", "b"], ["c", "d"]]))].sort()).toEqual(["b", "c"]);
    expect([...cycleNodes(shape([["a", "a"], ["a", "b"]]))]).toEqual(["a"]);
  });

  test("two separate cycles, and a node between them that is on neither", () => {
    const s = shape([["a", "b"], ["b", "a"], ["b", "m"], ["m", "x"], ["x", "y"], ["y", "x"]]);
    expect([...cycleNodes(s)].sort()).toEqual(["a", "b", "x", "y"]);
  });

  test("a long graph does not blow the stack (the walk is iterative)", () => {
    const edges: Array<[string, string]> = Array.from({ length: 20_000 }, (_, i) => [`n${i}`, `n${i + 1}`]);
    edges.push(["n20000", "n0"]);
    expect(cycleNodes(shape(edges)).size).toBe(20_001);
  });
});

describe("which steps are progress-checked in the built-ins", () => {
  // HOW-75: the three probe-driven repairs dropped out on purpose — changing nothing can be the
  // right answer for them, and delivery.repair_check routes on it (core/repair-stall.ts parks the
  // repeat). revise_repairs answers a reject of this very code, so it stays checked.
  test("implement-ticket: the reviewed repairs — not the probe-driven ones, the reviewers, the planner, the publisher or the first build", () => {
    expect([...GRAPHS["implement-ticket"]!.progressChecked()].sort()).toEqual([
      "delivery.revise_repairs",
      "implementation.implement_review",
    ]);
  });

  test("HOW-75: no built-in progress-checks a probe-driven repair", () => {
    for (const name of ["implement-ticket", "implement-slice", "implement-stacked", "improve-codebase"]) {
      const checked = GRAPHS[name]!.progressChecked();
      for (const repair of ["delivery.address_reviews", "delivery.fix_ci", "delivery.resolve_conflicts"]) expect(checked.has(repair), `${name} ${repair}`).toBe(false);
      expect(checked.has("delivery.revise_repairs"), name).toBe(true);
    }
  });

  test("implement-slice: the build sits on its review loop, so it is checked too", () => {
    const checked = GRAPHS["implement-slice"]!.progressChecked();
    expect(checked.has("implementation.implement")).toBe(true);
    expect(checked.has("implementation.local_review")).toBe(false);
    expect(checked.has("delivery.publish")).toBe(false);
  });

  test("a graph with no loop checks nothing", () => {
    expect([...GRAPHS["quick-task"]!.progressChecked()]).toEqual([]);
  });
});

describe("a builder-made graph", () => {
  test("cycle membership comes from its edges, like any other", () => {
    const spec: GraphSpec = {
      version: 1, name: "my-loop", description: "", entry: "write", inputs: ["goal"],
      fields: [
        { key: "goal", kind: "text", scope: "sticky" },
        { key: "draft", kind: "text", scope: "sticky" },
        { key: "verdict", kind: "choice", scope: "cleared", choices: ["pass", "reject"] },
      ],
      nodes: [
        { id: "write", kind: "agent", prompt: "my-loop.write", reads: ["goal"], writes: ["draft"] },
        { id: "check", kind: "agent", prompt: "my-loop.check", reads: ["draft"], writes: ["verdict"], readOnly: true },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
      edges: [
        { from: "write", to: "check" },
        { from: "check", to: "write", when: { op: "equals", key: "verdict", value: "reject" } },
        { from: "check", to: "done", when: { op: "equals", key: "verdict", value: "pass" } },
      ],
    } as GraphSpec;
    const g = buildGraph(spec);
    expect([...g.progressChecked()]).toEqual(["write"]);
  });
});
