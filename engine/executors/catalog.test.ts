/**
 * `graphs:catalog` (HOW-56 T4) — unit tests over `computeCatalog` plus one end-to-end that
 * exercises the executor's dispatch, args guards and publish path.
 *
 * The pure half is tested against a FAKE registry (loadRegistry's return shape), so a broken
 * local graph and the over-cap case can be constructed deterministically without a temp
 * HOWDAH_HOME scaffolded with real `.ts` files on every run. One end-to-end test uses the
 * real `loadRegistry` over a temp HOWDAH_HOME to prove the two halves wire up.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../../log/write";
import {
  GRAPHS_CATALOG_BUILTIN,
  computeCatalog,
  graphsCatalogBuiltinExecutor,
} from "./catalog";
import { ensureLocalDirs, localGraphPath } from "../../graphs/local";
import { loadRegistry } from "../../graphs/registry";
import { buildGraph, type GraphSpec } from "../../core/graph-spec";
import type { ExecArgs } from "../run";
import type { Registry } from "../../graphs/registry";

const ROOT = join(import.meta.dir, "..", "..");

function runLog(): EventLog {
  const runDir = mkdtempSync(join(tmpdir(), "howdah-catalog-run-"));
  return new EventLog(join(runDir, "run.jsonl"));
}

function args(log: EventLog, def: Partial<Extract<ExecArgs["def"], { kind: "command" }>> = {}): ExecArgs {
  return {
    nodeId: "catalog", visit: 1, attemptId: "catalog#1", runId: "r", reads: {}, log,
    def: {
      kind: "command",
      run: GRAPHS_CATALOG_BUILTIN,
      writes: { "graphs.catalog": { scope: "per-visit" } },
      ...def,
    },
    effects: { claim: () => false, done: () => {} },
  } as ExecArgs;
}

/** A GraphSpec large enough to force over-cap trimming when stacked. Prompt ids only — the
 *  tests pin that bodies are NOT in the published value, so no bodies need to exist. */
function bigSpec(name: string, bytes: number): GraphSpec {
  const padding = "x".repeat(Math.max(0, bytes));
  return {
    version: 1,
    name,
    description: padding,
    fields: [{ key: "goal", kind: "text", scope: "sticky" }],
    inputs: ["goal"],
    entry: "step",
    nodes: [
      { id: "step", kind: "agent", prompt: `${name}.step`, reads: ["goal"], writes: [] },
      { id: "done", kind: "terminal", outcome: "success" },
    ],
    edges: [{ from: "step", to: "done" }],
  };
}

function fakeRegistry(entries: Array<{ name: string; spec?: GraphSpec; broken?: string }>): Registry {
  const graphs: Registry["graphs"] = {};
  const source: Registry["source"] = {};
  const problems: Registry["problems"] = [];
  for (const e of entries) {
    if (e.spec) {
      graphs[e.name] = buildGraph(e.spec);
      source[e.name] = "local";
    } else if (e.broken) {
      problems.push({ name: e.name, error: e.broken });
    }
  }
  return { graphs, source, problems };
}

describe("computeCatalog: content", () => {
  test("lists every builder-readable graph with its prompt ids and spec", () => {
    const cat = computeCatalog(fakeRegistry([
      { name: "alpha", spec: bigSpec("alpha", 10) },
      { name: "beta", spec: bigSpec("beta", 10) },
    ]), 1_000_000);
    expect(cat.graphs.map((g) => g.name)).toEqual(["alpha", "beta"]);
    expect(cat.graphs[0]!.promptIds).toEqual(["alpha.step"]);
    expect(cat.graphs[1]!.promptIds).toEqual(["beta.step"]);
    expect(cat.graphs[0]!.spec.name).toBe("alpha");
    expect(cat.omitted).toBeUndefined();
    expect(cat.broken).toEqual([]);
  });

  test("carries prompt IDS only — no prompt body text", () => {
    const cat = computeCatalog(fakeRegistry([
      { name: "alpha", spec: bigSpec("alpha", 10) },
    ]), 1_000_000);
    const json = JSON.stringify(cat);
    expect(json).toContain("alpha.step");
    // the body of a built-in prompt — a sentence the drafter would recognise — is never in it
    expect(json).not.toContain("Do the work");
    // the catalog carries the spec, not the compiled Graph; no executor-side fields leak
    expect(json).not.toContain("defineGraph");
  });

  test("node and field kinds come from the live tables", () => {
    const cat = computeCatalog(fakeRegistry([]), 1_000_000);
    expect(cat.nodeKinds.sort()).toEqual(["agent", "approval", "command", "terminal", "wait", "worktree"].sort());
    expect(cat.fieldKinds.sort()).toEqual(["boolean", "choice", "json", "number", "text"]);
  });

  test("command built-ins list every row the table has, except runs:launch — a drafted graph may not launch", () => {
    const cat = computeCatalog(fakeRegistry([]), 1_000_000);
    const runs = cat.commandBuiltins.map((b) => b.run);
    expect(runs).toContain("graphs:catalog");
    expect(runs).toContain("probe:pr");
    expect(runs).toContain("verify:run");
    expect(runs).not.toContain("runs:launch");
    // deterministic order
    expect(runs).toEqual([...runs].sort());
  });

  test("takenNames includes built-in, local and broken names (a drafter picks a new one)", () => {
    const cat = computeCatalog(fakeRegistry([
      { name: "alpha", spec: bigSpec("alpha", 10) },
      { name: "beta", broken: "does not load: Cannot find module './missing'" },
    ]), 1_000_000);
    expect(cat.takenNames).toContain("alpha");
    expect(cat.takenNames).toContain("beta");
    // deterministic order
    expect(cat.takenNames).toEqual([...cat.takenNames].sort());
  });

  test("output is deterministic — two runs over the same registry publish byte-identical JSON", () => {
    const reg = fakeRegistry([
      { name: "charlie", spec: bigSpec("charlie", 10) },
      { name: "alpha", spec: bigSpec("alpha", 10) },
      { name: "bravo", broken: "does not load: syntax error" },
    ]);
    const a = JSON.stringify(computeCatalog(reg, 1_000_000));
    const b = JSON.stringify(computeCatalog(reg, 1_000_000));
    expect(a).toBe(b);
  });
});

describe("computeCatalog: a broken local graph", () => {
  test("is listed under broken with its reason, and in takenNames", () => {
    const cat = computeCatalog(fakeRegistry([
      { name: "alpha", spec: bigSpec("alpha", 10) },
      { name: "mangled", broken: "does not load: SyntaxError: Unexpected token ';'" },
    ]), 1_000_000);
    expect(cat.broken).toEqual([{ name: "mangled", reason: "does not load: SyntaxError: Unexpected token ';'" }]);
    expect(cat.takenNames).toContain("mangled");
    // a broken graph is NEVER offered as a base to stack on
    expect(cat.graphs.map((g) => g.name)).not.toContain("mangled");
  });
});

describe("computeCatalog: over-cap trimming", () => {
  test("drops the largest specs first, lists them in omitted, and the result fits", () => {
    // three graphs whose JSON is dominated by their padded descriptions
    const reg = fakeRegistry([
      { name: "tiny", spec: bigSpec("tiny", 10) },
      { name: "medium", spec: bigSpec("medium", 1000) },
      { name: "huge", spec: bigSpec("huge", 5000) },
    ]);
    const cap = 3000;
    const cat = computeCatalog(reg, cap);
    expect(cat.omitted).toBeDefined();
    expect(cat.omitted!).toContain("huge");
    expect(cat.graphs.map((g) => g.name)).not.toContain("huge");
    // the result actually fits
    expect(new TextEncoder().encode(JSON.stringify(cat)).length).toBeLessThanOrEqual(cap);
  });

  test("omits the LARGEST graphs first, keeping smaller ones", () => {
    const reg = fakeRegistry([
      { name: "tiny", spec: bigSpec("tiny", 10) },
      { name: "huge", spec: bigSpec("huge", 5000) },
    ]);
    const cat = computeCatalog(reg, 2000);
    // huge drops before tiny
    expect(cat.omitted).toEqual(["huge"]);
    expect(cat.graphs.map((g) => g.name)).toEqual(["tiny"]);
  });

  test("ties on size break on name, so trimming is deterministic", () => {
    const reg = fakeRegistry([
      { name: "zz", spec: bigSpec("zz", 2000) },
      { name: "aa", spec: bigSpec("aa", 2000) },
    ]);
    const a = computeCatalog(reg, 2000);
    const b = computeCatalog(reg, 2000);
    expect(a.omitted).toEqual(b.omitted);
  });

  test("a cap of 0 or negative uses the default rather than publishing nothing", () => {
    const reg = fakeRegistry([{ name: "a", spec: bigSpec("a", 10) }]);
    const cat = computeCatalog(reg, 0);
    expect(cat.graphs.map((g) => g.name)).toEqual(["a"]);
    expect(cat.omitted).toBeUndefined();
  });
});

describe("graphsCatalogBuiltinExecutor", () => {
  test("refuses an undeclared write BEFORE loading the registry", async () => {
    let loaded = 0;
    const exec = graphsCatalogBuiltinExecutor({ registry: async () => { loaded++; return fakeRegistry([]); } });
    const log = runLog();
    const r = await exec(args(log, { writes: { "graphs.catalog": { scope: "per-visit" }, "something.else": { scope: "sticky" } } }));
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/cannot produce/);
    expect(loaded).toBe(0);
  });

  test("refuses arguments after the built-in name BEFORE loading the registry", async () => {
    let loaded = 0;
    const exec = graphsCatalogBuiltinExecutor({ registry: async () => { loaded++; return fakeRegistry([]); } });
    const log = runLog();
    const r = await exec(args(log, { run: `${GRAPHS_CATALOG_BUILTIN} --since yesterday` }));
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/takes no arguments/);
    expect(loaded).toBe(0);
  });

  test("fails cleanly when the registry provider throws", async () => {
    const exec = graphsCatalogBuiltinExecutor({ registry: async () => { throw new Error("home missing"); } });
    const log = runLog();
    const r = await exec(args(log));
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/home missing/);
  });

  test("fails loudly, never silently, when no registry provider is wired", async () => {
    const exec = graphsCatalogBuiltinExecutor({});
    const log = runLog();
    const r = await exec(args(log));
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/no registry/);
  });

  test("publishes graphs.catalog over a real temp HOWDAH_HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "howdah-catalog-home-"));
    ensureLocalDirs(home);
    // one broken local file to prove it reaches `broken`
    writeFileSync(localGraphPath(home, "mangled"), "export const notAGraph = 1;\n");
    const exec = graphsCatalogBuiltinExecutor({
      registry: () => loadRegistry(home, ROOT),
      contextCap: 1_000_000,
    });
    const log = runLog();
    const r = await exec(args(log));
    expect(r.status).toBe("succeeded");
    const cat = r.writes["graphs.catalog"] as { broken: Array<{ name: string }>; commandBuiltins: Array<{ run: string }> };
    expect(cat.broken.map((b) => b.name)).toContain("mangled");
    expect(cat.commandBuiltins.map((b) => b.run)).toContain(GRAPHS_CATALOG_BUILTIN);
  });
});
