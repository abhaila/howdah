/**
 * HOW-64 (HOW-56 T5): draft-graph is a registered built-in whose drafting step can only ever be
 * checked — it is read-only and reads the catalog, which the outputs check needs (decision E).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRAPHS, graphCatalog } from "./index";
import { draftGraph, spec } from "./draft-graph";
import { checkGraphDraft, specOf, type GraphSpec, type MaterialiseBodies } from "../core/graph-spec";
import { GRAPH_DRAFT_KEY, GRAPHS_CATALOG_BUILTIN, GRAPHS_CATALOG_KEY, type GraphsCatalog } from "../core/catalog";
import { ACCEPTANCE_KEY } from "../core/acceptance";
import { computeCatalog } from "../engine/executors/catalog";
import { loadRegistry } from "./registry";
import { materialiseBodies, promptIdFor } from "./builder";

describe("draft-graph", () => {
  test("is registered and validates", () => {
    expect(GRAPHS["draft-graph"]).toBe(draftGraph);
    expect(() => draftGraph.validateOrThrow()).not.toThrow();
  });

  test("asks for the intent alone, and runs on a plain folder", () => {
    expect(draftGraph.def.inputs).toEqual(["intent"]);
    expect(graphCatalog().find((g) => g.name === "draft-graph")?.kind).toBe("plain");
  });

  test("catalog → draft → done", () => {
    expect(draftGraph.def.entry).toBe(GRAPHS_CATALOG_KEY);
    expect(draftGraph.def.nodes[GRAPHS_CATALOG_KEY]).toMatchObject({ kind: "command", run: GRAPHS_CATALOG_BUILTIN });
    expect(draftGraph.def.edges.map((e) => [e.from, e.to])).toEqual([[GRAPHS_CATALOG_KEY, "graph.draft"], ["graph.draft", "done"]]);
  });

  test("the drafting step is read-only and reads the catalog, so its draft is always checked (E)", () => {
    const draft = draftGraph.def.nodes["graph.draft"];
    expect(draft).toMatchObject({ kind: "agent", readOnly: true, prompt: "graph.draft" });
    if (draft?.kind !== "agent") throw new Error("not an agent");
    expect([...(draft.reads ?? [])].sort()).toEqual([GRAPHS_CATALOG_KEY, "intent"]);
    expect(Object.keys(draft.writes ?? {})).toEqual([GRAPH_DRAFT_KEY]);
  });

  test("its prompt exists and its spec round-trips", () => {
    expect(existsSync(join(import.meta.dir, "..", "prompts", "graph.draft.md"))).toBe(true);
    expect(specOf(draftGraph)).toEqual(spec);
  });
});

/**
 * HOW-74: a drafter starting from a built-in must be able to publish the base itself. Before
 * this, the builder's reads-must-match-body rule refused implement-ticket's `delivery.publish`
 * for listing `acceptance` (which only the requiresAcceptance gate consumes), and dropping the
 * read was then refused by validate()'s acceptance rule — a park with no way out. Judged on the
 * REAL registry, catalog and materialiser, so a copy is read exactly as Save would pin it.
 */
describe("a draft that copies a built-in unchanged is one that would save (HOW-74)", () => {
  const ROOT = join(import.meta.dir, "..");
  let home = "";
  let catalog: GraphsCatalog;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "howdah-how74-"));
    catalog = computeCatalog(await loadRegistry(home, ROOT), 10_000_000);
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const materialise: MaterialiseBodies = (bodies) => materialiseBodies(home, ROOT, bodies);

  /** the base under a new name, every agent step filed under it, every body a copy */
  function copyOfBase(baseName: string, name = `${baseName}-copy`) {
    const base = catalog.graphs.find((g) => g.name === baseName)?.spec;
    if (!base) throw new Error(`${baseName} is not in the catalog`);
    const prompts: Record<string, { copyOf: string }> = {};
    const nodes = base.nodes.map((n) => {
      if (n.kind !== "agent") return n;
      const id = promptIdFor(name, n.id);
      prompts[id] = { copyOf: n.prompt };
      return { ...n, prompt: id };
    });
    const { drafted: _d, ...rest } = base;
    return { spec: { ...rest, name, nodes } as GraphSpec, prompts, based_on: baseName, notes: "An unchanged copy." };
  }
  const withReads = (draft: ReturnType<typeof copyOfBase>, step: string, edit: (reads: string[]) => string[]) => ({
    ...draft,
    spec: { ...draft.spec, nodes: draft.spec.nodes.map((n) => (n.kind === "agent" && n.id === step ? { ...n, reads: edit(n.reads) } : n)) },
  });

  test("the operator's run: implement-ticket-team-review from implement-ticket, visit by visit", () => {
    const draft = copyOfBase("implement-ticket", "implement-ticket-team-review");
    // graph.draft@2 — the unchanged copy. Was refused twice (verify_command, acceptance).
    expect(checkGraphDraft(draft, catalog, materialise)).toEqual([]);

    // graph.draft@3 — what the drafter did when told to: drop the "unused" reads. Dropping the
    // dormant verify_command is still a graph that saves (nothing reads it)...
    const noVerify = withReads(draft, "implementation.implement", (r) => r.filter((k) => k !== "worktree.verify_command"));
    expect(checkGraphDraft(noVerify, catalog, materialise)).toEqual([]);

    // ...and dropping acceptance is refused ONCE, telling the drafter to add it back — not by
    // validate()'s rule as well, and not with an instruction a second rule would refuse.
    const noAcceptance = withReads(draft, "delivery.publish", (r) => r.filter((k) => k !== ACCEPTANCE_KEY));
    const problems = checkGraphDraft(noAcceptance, catalog, materialise);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("its instructions use `acceptance`, which the step does not list");
    expect(problems[0]).not.toContain("never use");
  });

  // A built-in this guard knows is broken in its OWN right is pinned word for word, so the day
  // it is fixed (or gets worse) this fails. improve-codebase's local review includes
  // `review._verify_result`, which reads `context.verify.result` — a key improve-codebase never
  // declares or writes. That is a defect in the built-in graph, not in the draft check, and is
  // left for a follow-up ticket (HOW-74 is confined to the spec/validate/draft layer).
  const KNOWN: Record<string, string[]> = {
    "improve-codebase": [
      "**implementation.local_review** does not match its instructions: its instructions use `verify.result`, which the step does not list. Save the instructions again so the step is given what they ask for.",
    ],
  };
  for (const name of ["implement-ticket", "improve-codebase", "review-teammate-pr", "quick-task", "write-doc", "research"])
    test(`an unchanged copy of ${name} passes checkGraphDraft`, () => {
      expect(checkGraphDraft(copyOfBase(name), catalog, materialise)).toEqual(KNOWN[name] ?? []);
    });
});
