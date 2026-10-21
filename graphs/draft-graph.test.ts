/**
 * HOW-64 (HOW-56 T5): draft-graph is a registered built-in whose drafting step can only ever be
 * checked — it is read-only and reads the catalog, which the outputs check needs (decision E).
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { GRAPHS, graphCatalog } from "./index";
import { draftGraph, spec } from "./draft-graph";
import { specOf } from "../core/graph-spec";
import { GRAPH_DRAFT_KEY, GRAPHS_CATALOG_BUILTIN, GRAPHS_CATALOG_KEY } from "../core/catalog";

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
