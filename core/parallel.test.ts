/**
 * HOW-73: the parallel (fork/join) step's static half — core/graph.ts parallelProblems() and the
 * path check across the join (core/validate.ts), the spec round trip and every refusal in the
 * operator's words (core/graph-spec.ts), the draft rule, and the multi-attempt ContextStore.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineGraph, type NodeDef } from "./graph";
import { ContextError, ContextStore } from "./context";
import { buildGraph, draftRuleProblems, parseGraphSpec, specFlowEdges, specProblems, type GraphSpec, type NodeSpec } from "./graph-spec";
import { shapeOf } from "../graphs/spec-shape";
import {
  PARALLEL_REVIEW_ROUTED_SPEC, PARALLEL_REVIEW_SPEC, parallelReview, parallelReviewRouted,
} from "../engine/fixtures/parallel-review";

type Ctx = { goal: string; summary: string; a: string; b: string; c: string };

/** fork over a/b reviewers into `after`, which reads what `afterReads` names */
function graphWith(over: { nodes?: Record<string, NodeDef<Ctx> | undefined>; edges?: Array<{ from: string; to: string }>; entry?: string } = {}) {
  const nodes: Record<string, NodeDef<Ctx>> = {
    build: { kind: "command", run: "x", reads: ["goal"], writes: { summary: { scope: "sticky" } } },
    fan: { kind: "parallel", branches: ["ra", "rb"], join: "after" },
    ra: { kind: "agent", prompt: "doc.review", reads: ["summary"], writes: { a: { scope: "sticky" } }, readOnly: true },
    rb: { kind: "command", run: "lint", reads: ["summary"], writes: { b: { scope: "sticky" } }, changesFiles: false },
    after: { kind: "command", run: "y", reads: ["a", "b"], writes: { c: { scope: "sticky" } } },
    done: { kind: "terminal", outcome: "success" },
  };
  for (const [k, v] of Object.entries(over.nodes ?? {})) {
    if (v === undefined) delete nodes[k];
    else nodes[k] = v;
  }
  return defineGraph<Ctx>({
    name: "t", entry: over.entry ?? "build", inputs: ["goal"], nodes,
    edges: over.edges ?? [{ from: "build", to: "fan" }, { from: "after", to: "done" }],
  });
}

const structural = (g: ReturnType<typeof graphWith>) => g.validate().structural;

describe("validate(): parallel steps", () => {
  test("a legal fork/join validates clean, and a read after the join of ANY branch's output is accepted", () => {
    expect(graphWith().validate()).toEqual({ structural: [], paths: [] });
    expect(parallelReview().validate()).toEqual({ structural: [], paths: [] });
  });

  test("a file-writing branch is refused — an agent that is not readOnly, a command without changesFiles: false", () => {
    const agent = structural(graphWith({ nodes: { ra: { kind: "agent", prompt: "doc.review", reads: ["summary"], writes: { a: { scope: "sticky" } } } } }));
    expect(agent).toEqual([expect.stringContaining(`branch "ra" of parallel node "fan" may write files — an agent branch must be readOnly`)]);
    const command = structural(graphWith({ nodes: { rb: { kind: "command", run: "lint", reads: ["summary"], writes: { b: { scope: "sticky" } } } } }));
    expect(command).toEqual([expect.stringContaining(`a command branch must declare changesFiles: false`)]);
  });

  test("overlapping writes are refused", () => {
    const g = graphWith({ nodes: { rb: { kind: "command", run: "lint", reads: ["summary"], writes: { a: { scope: "sticky" } }, changesFiles: false }, after: { kind: "command", run: "y", reads: ["a"] } } });
    expect(structural(g)).toEqual([`branches "ra" and "rb" of parallel node "fan" both write "a" — branches must write different keys`]);
  });

  test("a branch reading a sibling's output is refused", () => {
    const g = graphWith({ nodes: { rb: { kind: "command", run: "lint", reads: ["a"], writes: { b: { scope: "sticky" } }, changesFiles: false } } });
    expect(structural(g)).toEqual([expect.stringContaining(`branch "rb" of parallel node "fan" reads "a", which its sibling "ra" writes`)]);
  });

  test("the path check alone also refuses a sibling read (in(branch) = out(parallel step))", async () => {
    const { validateGraph } = await import("./validate");
    const v = validateGraph({
      entry: "p", inputs: [],
      nodes: { p: { reads: [], writes: [], branches: ["x", "y"] }, x: { reads: [], writes: ["k"] }, y: { reads: ["k"], writes: [] }, j: { reads: ["k"], writes: [] } },
      edges: [{ from: "p", to: "x" }, { from: "p", to: "y" }, { from: "p", to: "j" }],
    });
    expect(v.map((x) => `${x.node}:${x.key}`)).toEqual(["y:k"]); // j, after the join, may read it
  });

  test("a read after the join of a key only ONE path writes is still refused (MUST analysis)", () => {
    const g = graphWith({
      nodes: { after: { kind: "command", run: "y", reads: ["a", "b"], writes: { c: { scope: "sticky" } } }, other: { kind: "command", run: "z", writes: {} } },
      edges: [{ from: "build", to: "fan" }, { from: "build", to: "other" }, { from: "other", to: "after" }, { from: "after", to: "done" }],
    });
    // `build` now has two outgoing unconditional edges, so give one a condition-free check only on paths
    expect(g.validate().paths.map((p) => p.key).sort()).toEqual(["a", "b"]);
  });

  test("a nested parallel is refused", () => {
    const g = graphWith({ nodes: { rb: { kind: "parallel", branches: ["x1", "x2"], join: "after" }, x1: { kind: "command", run: "a", changesFiles: false }, x2: { kind: "command", run: "b", changesFiles: false }, after: { kind: "command", run: "y", reads: ["a"] } } });
    expect(structural(g)).toContain(`branch "rb" of parallel node "fan" is itself a parallel step — nested parallel steps are not supported`);
  });

  test("other refusals: edges on a branch, a branch as entry, the join a branch, kinds, counts, concurrency, gates, edges on the parallel step", () => {
    expect(structural(graphWith({ edges: [{ from: "build", to: "fan" }, { from: "after", to: "done" }, { from: "ra", to: "done" }] })))
      .toContain(`branch "ra" of parallel node "fan" has outgoing edges — a branch continues at the join "after"`);
    expect(structural(graphWith({ edges: [{ from: "build", to: "ra" }, { from: "after", to: "done" }] })).join("\n"))
      .toContain(`branch "ra" of parallel node "fan" has incoming edges`);
    expect(structural(graphWith({ entry: "ra" }))).toContain(`branch "ra" of parallel node "fan" is the entry — a branch is reached only through its parallel step`);
    expect(structural(graphWith({ nodes: { fan: { kind: "parallel", branches: ["ra", "rb"], join: "rb" } } })))
      .toContain(`parallel node "fan" joins to "rb", which is one of its own branches`);
    expect(structural(graphWith({ nodes: { fan: { kind: "parallel", branches: ["ra", "done"], join: "after" } } })))
      .toContain(`branch "done" of parallel node "fan" is a terminal step — a branch must be one agent or command step`);
    expect(structural(graphWith({ nodes: { fan: { kind: "parallel", branches: ["ra"], join: "after" }, rb: undefined, after: { kind: "command", run: "y", reads: ["a"] } } })))
      .toContain(`parallel node "fan" names 1 branch — it needs 2 to 8`);
    expect(structural(graphWith({ nodes: { fan: { kind: "parallel", branches: ["ra", "rb"], join: "after", concurrency: 3 } } })))
      .toEqual([`parallel node "fan" has concurrency 3 — it must be a whole number from 1 to 2`]);
    expect(structural(graphWith({ nodes: { fan: { kind: "parallel", branches: ["ra", "rb"], join: "nowhere" } } })))
      .toContain(`parallel node "fan" joins to unknown node "nowhere"`);
    expect(structural(graphWith({ edges: [{ from: "build", to: "fan" }, { from: "fan", to: "after" }, { from: "after", to: "done" }] })))
      .toContain(`parallel node "fan" has outgoing edges — its only successor is its join "after"`);
    expect(structural(graphWith({ nodes: { ra: { kind: "agent", prompt: "doc.review", reads: ["summary"], writes: { a: { scope: "sticky" } }, readOnly: true, requiresAcceptance: true } } })).join("\n"))
      .toContain(`gates are not supported on branches`);
  });

  test("the fork and join edges a picture draws", () => {
    expect(parallelReview().flowEdges().filter((e) => e.kind).map((e) => `${e.kind}:${e.from}>${e.to}`)).toEqual([
      "fork:fan>review_security", "join:review_security>done",
      "fork:fan>review_tests", "join:review_tests>done",
      "fork:fan>review_ux", "join:review_ux>done",
    ]);
    expect(parallelReview().parallelOf("review_ux")).toBe("fan");
    expect(parallelReview().parallelOf("build")).toBeUndefined();
  });
});

/**
 * The fixture's prompts are repo ids (the hand-written twin needs real PromptIds); a BUILDER
 * graph owns only `<graph>.<step>` prompts, so specProblems is asked about a copy that does.
 */
const owned = (spec: GraphSpec): GraphSpec =>
  ({ ...spec, nodes: spec.nodes.map((n) => (n.kind === "agent" ? { ...n, prompt: `${spec.name}.${n.id}` } : n)) });

describe("GraphSpec: parallel steps", () => {
  test("buildGraph(spec) is the hand-written graph (shapeOf), for both fixture variants", () => {
    expect(shapeOf(buildGraph(PARALLEL_REVIEW_SPEC))).toEqual(shapeOf(parallelReview()));
    expect(shapeOf(buildGraph(PARALLEL_REVIEW_ROUTED_SPEC))).toEqual(shapeOf(parallelReviewRouted()));
  });

  test("a parallel spec round-trips through JSON and parseGraphSpec, and validates clean", () => {
    for (const spec of [PARALLEL_REVIEW_SPEC, PARALLEL_REVIEW_ROUTED_SPEC]) {
      const parsed = parseGraphSpec(JSON.parse(JSON.stringify(spec)));
      expect(parsed).toEqual({ ok: true, spec });
      expect(specProblems(owned(spec)).filter((p) => p.severity !== "advice")).toEqual([]);
    }
  });

  test("the pre-spec shapes fixture does not mention a parallel step (no built-in changed)", () => {
    const raw = readFileSync(join(import.meta.dir, "..", "graphs", "fixtures", "pre-spec-shapes.json"), "utf8");
    expect(raw).not.toContain(`"parallel"`);
  });

  test("reachability walks the fork/join: branches and the join are not 'never reached'", () => {
    expect(specProblems(owned(PARALLEL_REVIEW_ROUTED_SPEC)).some((p) => /never reached/.test(p.message))).toBe(false);
    expect(specFlowEdges(PARALLEL_REVIEW_SPEC).filter((e) => e.kind === "fork")).toHaveLength(3);
  });

  const withNode = (spec: GraphSpec, id: string, patch: Partial<NodeSpec>): GraphSpec =>
    owned({ ...spec, nodes: spec.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as NodeSpec) : n)) });
  const messages = (spec: GraphSpec) => specProblems(spec).map((p) => `${p.node}|${p.where}|${p.message}`);

  test("each refusal is in the operator's words, attributed to the step", () => {
    const writing = messages(withNode(PARALLEL_REVIEW_SPEC, "review_ux", { readOnly: undefined } as Partial<NodeSpec>));
    expect(writing).toEqual([`review_ux|steps|**review_ux** runs at the same time as other steps in one worktree, so it must not change files. Make it read-only.`]);

    const overlap = messages(withNode(PARALLEL_REVIEW_SPEC, "review_ux", { writes: ["tests"] } as Partial<NodeSpec>));
    expect(overlap).toContain(`review_ux|steps|**review_tests** and **review_ux** both produce \`tests\`, and they run at the same time in **fan**. Give each its own field.`);

    const sibling = messages(withNode(PARALLEL_REVIEW_SPEC, "review_ux", { reads: ["goal", "summary", "security"] } as Partial<NodeSpec>));
    expect(sibling).toContain(`review_ux|steps|**review_ux** is given \`security\`, but **review_security** produces it at the same time, in **fan** — one cannot see the other's answer. Read it in the step after them instead.`);

    const nested: GraphSpec = owned({
      ...PARALLEL_REVIEW_SPEC,
      nodes: [
        ...PARALLEL_REVIEW_SPEC.nodes.filter((n) => n.id !== "review_ux"),
        { id: "review_ux", kind: "parallel", branches: ["x1", "x2"], join: "done" },
        { id: "x1", kind: "command", run: "a", reads: [], writes: [], changesFiles: false },
        { id: "x2", kind: "command", run: "b", reads: [], writes: [], changesFiles: false },
      ],
    });
    expect(messages(nested).join("\n")).toContain(`**review_ux** runs steps at once itself, so **fan** cannot run it as one of its steps`);

    const commandBranch = messages(withNode(PARALLEL_REVIEW_ROUTED_SPEC, "fan", { branches: ["review_security", "decide"] } as Partial<NodeSpec>));
    // decide is now both the join and a branch
    expect(commandBranch).toContain(`fan|steps|**fan** continues at **decide**, which is one of the steps it runs at once. Pick a step that comes after them.`);
    expect(commandBranch).toContain(`decide|branching|**decide** has its own "go to" rows, but it is run at once by **fan** and always continues at **decide**. Remove its rows in Branching.`);
  });

  test("a structural parallel refusal never leaks the raw validator wording", () => {
    const spec = withNode(PARALLEL_REVIEW_SPEC, "fan", { concurrency: 9 } as Partial<NodeSpec>);
    const ps = specProblems(spec);
    expect(ps).toEqual([{ node: "fan", where: "steps", message: `**fan** runs 9 at once, which is not a whole number from 1 to the number of steps it runs. Change how many run at once.` }]);
  });

  test("draftRuleProblems refuses a parallel step (a draft may not run steps at once in v1)", () => {
    const ps = draftRuleProblems(PARALLEL_REVIEW_SPEC);
    expect(ps.filter((p) => p.node === "fan")).toEqual([{
      node: "fan", where: "steps",
      message: `**fan** runs steps at the same time. A drafted graph cannot do that yet — run them one after another, and make them parallel in the source after saving.`,
    }]);
  });
});

describe("ContextStore: concurrent attempts (HOW-73)", () => {
  const store = () => new ContextStore<{ a: string; b: string }>({ a: { scope: "cleared", writer: "x" }, b: { scope: "sticky", writer: "y" } });

  test("two steps hold attempts at once; each publishes on its own success", () => {
    const ctx = store();
    ctx.beginAttempt("x", 1);
    ctx.beginAttempt("y", 1);
    ctx.setFor("x", "a", "A");
    ctx.setFor("y", "b", "B");
    ctx.endAttemptOf("y", "succeeded");
    expect(ctx.has("b")).toBe(true);
    expect(ctx.has("a")).toBe(false);
    ctx.endAttemptOf("x", "failed");
    expect(ctx.has("a")).toBe(false);
  });

  test("the one-attempt API still refuses what it refused, and refuses ambiguity", () => {
    const ctx = store();
    expect(() => ctx.set("a", "A")).toThrow(ContextError);
    expect(() => ctx.endAttempt("succeeded")).toThrow("endAttempt without beginAttempt");
    ctx.beginAttempt("x", 1);
    expect(() => ctx.beginAttempt("x", 2)).toThrow("attempt already open: x@1");
    ctx.beginAttempt("y", 1);
    expect(() => ctx.set("a", "A")).toThrow("ambiguous");
    expect(() => ctx.setFor("x", "b", "B")).toThrow("x is not a declared writer of b");
    expect(() => ctx.setFor("z", "a", "A")).toThrow("outside an attempt of z");
  });
});
