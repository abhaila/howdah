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

  test("a run cannot START at a Finish step — it would end before doing anything", () => {
    const def = {
      name: "starts-at-the-end",
      entry: "done",
      inputs: ["goal"] as Array<keyof MiniCtx & string>,
      nodes: {
        a: { kind: "agent" as const, prompt: "discover" as const, reads: ["goal"] as Array<keyof MiniCtx & string> },
        done: { kind: "terminal" as const, outcome: "success" as const },
      },
      edges: [{ from: "a", to: "done" }],
    };
    const g = defineGraph<MiniCtx>(def);
    expect(g.validate().structural).toEqual(['entry node "done" is a terminal']);
    expect(() => g.validateOrThrow()).toThrow(/entry node "done" is a terminal/);
    // and the rule does not fire on a normal entry, which is what keeps it from judging graphs
    // that are fine (every built-in's entry is a worktree or an agent)
    expect(defineGraph<MiniCtx>({ ...def, entry: "a" }).validate().structural).toEqual([]);
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

// ---- approval node kind (system-map 1a) ---------------------------------------------

interface ApprovalCtx {
  goal: string;
  base: { manifest_hash: string | null; fingerprint: null };
  proposal: unknown;
  decision: { outcome: "approved" | "feedback" | "stale" };
  feedback: unknown[];
  summary: string;
}

function approvalGraph(over: { redesignTo?: string; requires?: string; decision?: keyof ApprovalCtx; extractDeclaresFeedback?: boolean } = {}) {
  return defineGraph<ApprovalCtx>({
    name: "approval-shape",
    entry: "extract",
    inputs: ["goal"],
    nodes: {
      extract: {
        kind: "command",
        run: "true",
        reads: ["goal"],
        writes: {
          base: { scope: "sticky" },
          ...(over.extractDeclaresFeedback ? { feedback: { scope: "sticky" as const } } : {}),
        },
      },
      propose: { kind: "agent", prompt: "discover", readOnly: true, reads: ["goal", "base", "feedback"], writes: { proposal: { scope: "per-visit" } } },
      approve: {
        kind: "approval",
        proposal: "proposal",
        base: "base",
        decision: (over.decision ?? "decision") as "decision",
        feedback: "feedback",
        redesignTo: over.redesignTo ?? "extract",
      },
      implement: {
        kind: "agent",
        prompt: "implementation.implement",
        requires: { approvalOf: over.requires ?? "approve" },
        reads: ["goal", "proposal", "decision"],
        writes: { summary: { scope: "sticky" } },
      },
      done: { kind: "terminal", outcome: "success" },
    },
    edges: [
      { from: "extract", to: "propose" },
      { from: "propose", to: "approve" },
      { from: "approve", to: "implement", condition: { reads: ["decision"], test: (v) => v.decision.outcome === "approved", label: "approved" } },
      { from: "approve", to: "propose", condition: { reads: ["decision"], test: (v) => v.decision.outcome === "feedback", label: "feedback" } },
      { from: "approve", to: "extract", condition: { reads: ["decision"], test: (v) => v.decision.outcome === "stale", label: "stale" } },
      { from: "implement", to: "done" },
    ],
  });
}

describe("approval node (system-map 1a)", () => {
  test("a well-wired approval graph validates; its writes carry the fixed scopes", () => {
    const g = approvalGraph();
    expect(g.validate()).toEqual({ structural: [], paths: [] });
    const decl = g.declarations();
    expect(decl["decision"]).toEqual({ scope: "per-visit", writer: ["approve"] });
    // engine-owned on the redesign target: declared for the ContextStore, not in extract's own writes
    expect(decl["feedback"]).toEqual({ scope: "sticky", writer: ["extract", "approve"] });
    expect(Object.keys(g.writesOf("extract"))).toEqual(["base", "feedback"]);
    expect(Object.keys((g.def.nodes.extract as { writes: object }).writes)).toEqual(["base"]);
    expect(g.approvalNodes().map(([id]) => id)).toEqual(["approve"]);
  });

  test("the approval node's reads join the MUST-analysis: an unwritten proposal is a path violation", () => {
    const g = defineGraph<ApprovalCtx>({
      name: "approval-unwritten",
      entry: "extract",
      inputs: ["goal"],
      nodes: {
        extract: { kind: "command", run: "true", writes: { base: { scope: "sticky" } } },
        approve: { kind: "approval", proposal: "proposal", base: "base", decision: "decision", feedback: "feedback", redesignTo: "extract" },
        done: { kind: "terminal", outcome: "success" },
      },
      edges: [
        { from: "extract", to: "approve" },
        { from: "approve", to: "done" },
      ],
    });
    expect(g.validate()).toEqual({ structural: [], paths: [{ node: "approve", key: "proposal", witness: ["extract", "approve"] }] });
  });

  test("the approval node's writes satisfy downstream reads (decision + feedback)", () => {
    // implement reads decision; propose (on the feedback loop) reads feedback — both proven
    expect(approvalGraph().validate().paths).toEqual([]);
  });

  test("another writer of the feedback key with a different scope is a scope conflict", () => {
    const g = defineGraph<ApprovalCtx>({
      name: "approval-scope",
      entry: "extract",
      inputs: ["goal"],
      nodes: {
        extract: { kind: "command", run: "true", writes: { base: { scope: "sticky" } } },
        propose: { kind: "agent", prompt: "discover", reads: ["base"], writes: { proposal: { scope: "per-visit" } } },
        approve: { kind: "approval", proposal: "proposal", base: "base", decision: "decision", feedback: "feedback", redesignTo: "extract" },
        tidy: { kind: "command", run: "true", writes: { feedback: { scope: "cleared" } } },
        done: { kind: "terminal", outcome: "success" },
      },
      edges: [
        { from: "extract", to: "propose" },
        { from: "propose", to: "approve" },
        { from: "approve", to: "tidy" },
        { from: "tidy", to: "done" },
      ],
    });
    expect(() => g.validate()).toThrow(GraphError);
  });

  test("wiring mistakes are structural errors, each named", () => {
    expect(approvalGraph({ redesignTo: "nowhere" }).validate().structural).toContain('approval node "approve" redesigns to unknown node "nowhere"');
    expect(approvalGraph({ redesignTo: "done" }).validate().structural).toContain('approval node "approve" redesigns to terminal node "done"');
    expect(approvalGraph({ extractDeclaresFeedback: true }).validate().structural).toContain(
      'node "extract" declares "feedback", which is engine-owned there (approval "approve" redesigns to it) — remove it from its writes',
    );
    expect(approvalGraph({ requires: "propose" }).validate().structural).toContain(
      'node "implement" requires approval of "propose", which is not an approval node',
    );
    expect(approvalGraph({ decision: "feedback" }).validate().structural).toContain(
      'approval node "approve" uses "feedback" as both its decision and feedback key',
    );
  });
});
