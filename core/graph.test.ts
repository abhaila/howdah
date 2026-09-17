import { describe, expect, test } from "bun:test";
import { defineGraph, GraphError } from "./graph";
import { implementTicket } from "../graphs/implement-ticket";
import { improveCodebase } from "../graphs/improve-codebase";
import { reviewTeammatePr } from "../graphs/review-teammate-pr";

interface MiniCtx {
  goal: string;
  verdict: "pass" | "reject";
  out: string;
}

describe("structural checks", () => {
  test("terminal with outgoing edge is rejected", () => {
    const g = defineGraph<MiniCtx>({
      name: "bad-terminal",
      entry: "a",
      inputs: ["goal"],
      nodes: {
        a: { kind: "agent", prompt: "discover", reads: ["goal"], writes: { out: { scope: "sticky" } } },
        done: { kind: "terminal", outcome: "success" },
      },
      edges: [
        { from: "a", to: "done" },
        { from: "done", to: "a" },
      ],
    });
    expect(g.validate().structural.join("\n")).toContain('terminal node "done" has outgoing edges');
  });

  test("dead-end non-terminal is rejected", () => {
    const g = defineGraph<MiniCtx>({
      name: "dead-end",
      entry: "a",
      inputs: ["goal"],
      nodes: { a: { kind: "agent", prompt: "discover", reads: ["goal"] } },
      edges: [],
    });
    expect(g.validate().structural.join("\n")).toContain("dead end");
  });

  test("conditional-only routing is legal: no match parks the run (Orbital semantics)", () => {
    const g = defineGraph<MiniCtx>({
      name: "no-fallback",
      entry: "a",
      inputs: ["goal"],
      nodes: {
        a: { kind: "agent", prompt: "discover", reads: ["goal"], writes: { verdict: { scope: "cleared" } } },
        b: { kind: "terminal", outcome: "success" },
      },
      edges: [
        {
          from: "a",
          to: "b",
          condition: { reads: ["verdict"], test: (v) => v.verdict === "pass", label: "pass" },
          weight: 1,
        },
      ],
    });
    expect(g.validate().structural).toEqual([]);
  });

  test("two unconditional edges from one node are ambiguous", () => {
    const g = defineGraph<MiniCtx>({
      name: "ambiguous",
      entry: "a",
      inputs: ["goal"],
      nodes: {
        a: { kind: "agent", prompt: "discover", reads: ["goal"] },
        b: { kind: "terminal", outcome: "success" },
        c: { kind: "terminal", outcome: "failed" },
      },
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
      ],
    });
    expect(g.validate().structural.join("\n")).toContain("ambiguous fallback");
  });

  test("conflicting scope declarations across writers throw", () => {
    const g = defineGraph<MiniCtx>({
      name: "scope-conflict",
      entry: "a",
      inputs: ["goal"],
      nodes: {
        a: { kind: "agent", prompt: "discover", reads: ["goal"], writes: { out: { scope: "sticky" } } },
        b: { kind: "agent", prompt: "discover", reads: ["goal"], writes: { out: { scope: "cleared" } } },
        done: { kind: "terminal", outcome: "success" },
      },
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "done" },
      ],
    });
    expect(() => g.validate()).toThrow(GraphError);
  });

  test("edge-condition read of an unavailable key is a path violation", () => {
    const g = defineGraph<MiniCtx>({
      name: "cond-read-hole",
      entry: "a",
      inputs: ["goal"],
      nodes: {
        a: { kind: "agent", prompt: "discover", reads: ["goal"] }, // writes nothing
        b: { kind: "terminal", outcome: "success" },
        c: { kind: "terminal", outcome: "failed" },
      },
      edges: [
        { from: "a", to: "b", condition: { reads: ["verdict"], test: (v) => v.verdict === "pass", label: "pass" }, weight: 1 },
        { from: "a", to: "c" },
      ],
    });
    const { paths } = g.validate();
    expect(paths).toHaveLength(1);
    expect(paths[0]!.key).toBe("verdict");
    expect(paths[0]!.node).toContain("condition");
  });

  test("declarations() derives multi-writer keys", () => {
    const decls = implementTicket.declarations();
    expect(decls["implementation_plan"]!.writer.sort()).toEqual(["implementation.plan", "implementation.plan_review"]);
    expect(decls["repair_summary"]!.writer.length).toBe(4);
    expect(decls["review_verdict"]).toMatchObject({ scope: "cleared" });
    expect(decls["pr.state"]).toMatchObject({ scope: "per-visit" });
  });
});

describe("ported Orbital graphs validate clean", () => {
  test("implement-ticket (19 nodes, loops, 5-way probe routing)", () => {
    expect(() => implementTicket.validateOrThrow()).not.toThrow();
  });
  test("improve-codebase (perpetual loop, no terminals is legal — every node has an exit)", () => {
    expect(() => improveCodebase.validateOrThrow()).not.toThrow();
  });
  test("review-teammate-pr (linear pipeline)", () => {
    expect(() => reviewTeammatePr.validateOrThrow()).not.toThrow();
  });
  test("all agent prompts exist in the prompt store", async () => {
    const { existsSync } = await import("node:fs");
    for (const g of [implementTicket, improveCodebase, reviewTeammatePr]) {
      for (const [id, n] of Object.entries(g.def.nodes)) {
        if (n.kind === "agent") {
          expect(existsSync(new URL(`../prompts/${n.prompt}.md`, import.meta.url).pathname)).toBe(true);
        }
      }
    }
  });
});

describe("delivery repair routing", () => {
  test("repair revisions are published before probing PR state again", () => {
    for (const graph of [implementTicket, improveCodebase]) {
      const reviseEdges = graph.def.edges.filter((edge) => edge.from === "delivery.revise_repairs");
      expect(reviseEdges).toEqual([{ from: "delivery.revise_repairs", to: "delivery.publish" }]);
      expect(graph.def.edges).toContainEqual({ from: "delivery.publish", to: "delivery.probe_pr" });
    }
  });
});
