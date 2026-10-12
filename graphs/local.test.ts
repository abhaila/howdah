/**
 * Local graphs: the operator's own, kept in `$HOWDAH_HOME` rather than in this repo (D9).
 *
 * The thing worth pinning is the bargain this makes. Built-ins are protected by `validate()`
 * AND the compiler; a local graph is outside the repo's tsconfig, so the loader has to stand
 * in for the `PromptId` union by checking the property the union really protects — that every
 * agent node names a prompt file that exists.
 *
 * The other half is blast radius. `graphs/index.ts` validates at import so ONE broken graph
 * fails the registry, which is right for graphs we ship and wrong for a file the operator is
 * halfway through editing. Here a broken graph must stop ITSELF and nothing else: excluded
 * from the catalog, reported with a reason, never silently runnable.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteLocalGraph, ensureLocalDirs, listLocalGraphNames, loadLocalGraph, loadLocalGraphs,
  localGraphPath, localPromptsDir, promptSearchPath, readLocalSource, saveLocalSource,
} from "./local";
import { catalogOf, loadRegistry } from "./registry";
import { newGraph } from "../cli/new-graph";
import { typecheckLocalGraph } from "./typecheck";

const ROOT = join(import.meta.dir, "..");
const CORE = join(ROOT, "core", "graph");
const home = () => mkdtempSync(join(tmpdir(), "howdah-lg-"));

/** a minimal legal graph, written the way the scaffolder writes one (absolute core import) */
function graphSource(name: string, opts: { prompt?: string; extra?: string } = {}): string {
  return `import { defineGraph } from ${JSON.stringify(CORE)};
export const g = defineGraph<{ goal: string; summary: string }>({
  name: ${JSON.stringify(name)},
  entry: "work",
  inputs: ["goal"],
  nodes: {
    work: { kind: "agent", prompt: ${JSON.stringify(opts.prompt ?? `${name}.work`)}, reads: ["goal"], writes: { summary: { scope: "sticky" } } },
    done: { kind: "terminal", outcome: "success" },
  },
  edges: [{ from: "work", to: "done" }${opts.extra ?? ""}],
});
`;
}

function withPrompt(h: string, id: string) {
  ensureLocalDirs(h);
  writeFileSync(join(localPromptsDir(h), `${id}.md`), `---\nid: ${id}\nversion: 1\n---\nDo {{ context.goal }}.\n`);
}

describe("loading a local graph", () => {
  test("a legal graph loads, and its prompts may live in the local dir", async () => {
    const h = home();
    withPrompt(h, "mine.work");
    writeFileSync(localGraphPath(h, "mine"), graphSource("mine"));
    const g = await loadLocalGraph(h, "mine", ROOT);
    expect(g.def.name).toBe("mine");
    expect(promptSearchPath(h, ROOT)[0]).toBe(localPromptsDir(h));
  });

  test("a prompt that exists only in the REPO still resolves", async () => {
    const h = home();
    ensureLocalDirs(h);
    // quick-task.work.md is a shipped prompt; a local graph may reuse it
    writeFileSync(localGraphPath(h, "reuser"), graphSource("reuser", { prompt: "quick-task.work" }));
    await expect(loadLocalGraph(h, "reuser", ROOT)).resolves.toBeDefined();
  });

  test("a missing prompt file is caught at load, standing in for the PromptId union", async () => {
    const h = home();
    ensureLocalDirs(h);
    writeFileSync(localGraphPath(h, "noprompt"), graphSource("noprompt", { prompt: "nope.missing" }));
    await expect(loadLocalGraph(h, "noprompt", ROOT)).rejects.toThrow(/names prompt "nope.missing", which has no .md file/);
  });

  test("HOW-37: a prompt using a filter that does nothing is refused at load, with the filter named", async () => {
    const h = home();
    ensureLocalDirs(h);
    writeFileSync(join(localPromptsDir(h), "filt.work.md"), `---\nid: filt.work\nversion: 1\n---\nDo {{ context.goal | upper }}.\n`);
    writeFileSync(localGraphPath(h, "filt"), graphSource("filt"));
    await expect(loadLocalGraph(h, "filt", ROOT)).rejects.toThrow(/the filter "upper", which does nothing/);
  });

  test("validate() still gates: a dead end is refused", async () => {
    const h = home();
    withPrompt(h, "deadend.work");
    const src = graphSource("deadend").replace('edges: [{ from: "work", to: "done" }]', "edges: []");
    writeFileSync(localGraphPath(h, "deadend"), src);
    await expect(loadLocalGraph(h, "deadend", ROOT)).rejects.toThrow(/dead end|no outgoing edge/);
  });

  test("a file whose graph is named something else is refused", async () => {
    const h = home();
    withPrompt(h, "other.work");
    writeFileSync(localGraphPath(h, "mismatch"), graphSource("other"));
    await expect(loadLocalGraph(h, "mismatch", ROOT)).rejects.toThrow(/declares name "other" but the file is mismatch.ts/);
  });

  test("a file that exports no graph, or does not parse, says which", async () => {
    const h = home();
    ensureLocalDirs(h);
    writeFileSync(localGraphPath(h, "empty"), "export const x = 1;\n");
    await expect(loadLocalGraph(h, "empty", ROOT)).rejects.toThrow(/exports no graph/);
    writeFileSync(localGraphPath(h, "broken"), "this is not typescript {{{\n");
    await expect(loadLocalGraph(h, "broken", ROOT)).rejects.toThrow(/does not load/);
  });

  test("a name that could escape the graphs dir is refused before any file access", () => {
    const h = home();
    for (const bad of ["../escape", "a/b", "Bad", ".hidden", ""])
      expect(() => localGraphPath(h, bad)).toThrow(/kebab-case/);
  });
});

describe("one broken graph stops itself, not the registry", () => {
  test("the good ones still load and the broken one is reported with a reason", async () => {
    const h = home();
    withPrompt(h, "good.work");
    writeFileSync(localGraphPath(h, "good"), graphSource("good"));
    writeFileSync(localGraphPath(h, "bad"), "export const x = 1;\n");

    const { graphs, problems } = await loadLocalGraphs(h, ROOT);
    expect(Object.keys(graphs)).toEqual(["good"]);
    expect(problems.map((p) => p.name)).toEqual(["bad"]);
    expect(problems[0]!.error).toMatch(/exports no graph/);
  });

  test("a local graph cannot shadow a built-in, and is told why", async () => {
    const h = home();
    withPrompt(h, "write-doc.work");
    writeFileSync(localGraphPath(h, "write-doc"), graphSource("write-doc"));

    const reg = await loadRegistry(h, ROOT);
    // the built-in is the one that runs: a run named write-doc must mean the same thing tomorrow
    expect(reg.source["write-doc"]).toBe("builtin");
    expect(reg.problems.find((p) => p.name === "write-doc")!.error).toMatch(/already called "write-doc"/);
  });

  test("the catalog tags each graph's origin, built-ins first", async () => {
    const h = home();
    withPrompt(h, "zzz-local.work");
    writeFileSync(localGraphPath(h, "zzz-local"), graphSource("zzz-local"));
    const entries = catalogOf(await loadRegistry(h, ROOT));
    expect(entries.at(-1)).toMatchObject({ name: "zzz-local", source: "local", kind: "plain" });
    expect(entries.every((e) => e.source === "builtin" || e.name === "zzz-local")).toBe(true);
  });
});

describe("saving source", () => {
  test("a good edit is kept, and re-importing sees the NEW version", async () => {
    const h = home();
    withPrompt(h, "edit.work");
    writeFileSync(localGraphPath(h, "edit"), graphSource("edit"));
    await loadLocalGraph(h, "edit", ROOT); // prime the module cache

    const edited = graphSource("edit").replace('inputs: ["goal"]', 'inputs: ["goal"], description: "second version"');
    expect(await saveLocalSource(h, "edit", edited, ROOT)).toEqual({ ok: true });
    // without cache busting this would still report the first version
    expect((await loadLocalGraph(h, "edit", ROOT)).def.description).toBe("second version");
  });

  test("a bad edit is REFUSED and the previous bytes are restored", async () => {
    const h = home();
    withPrompt(h, "keep.work");
    const original = graphSource("keep");
    writeFileSync(localGraphPath(h, "keep"), original);

    const broken = original.replace('edges: [{ from: "work", to: "done" }]', "edges: []");
    const r = await saveLocalSource(h, "keep", broken, ROOT);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/dead end|no outgoing edge/);
    // what is on disk is still the graph that ran the gate
    expect(readLocalSource(h, "keep")).toBe(original);
    await expect(loadLocalGraph(h, "keep", ROOT)).resolves.toBeDefined();
  });

  test("a first save that fails leaves no file behind", async () => {
    const h = home();
    ensureLocalDirs(h);
    const r = await saveLocalSource(h, "never", "export const x = 1;\n", ROOT);
    expect(r.ok).toBe(false);
    expect(readLocalSource(h, "never")).toBeNull();
    expect(listLocalGraphNames(h)).toEqual([]);
  });
});

describe("listing and deleting", () => {
  test("only kebab-case .ts files count, and delete removes just that one", async () => {
    const h = home();
    await newGraph("one", "custom", h, ROOT);
    await newGraph("two", "custom", h, ROOT);
    mkdirSync(join(h, "graphs", "notes"), { recursive: true });
    writeFileSync(join(h, "graphs", "README.md"), "not a graph");
    writeFileSync(join(h, "graphs", "Bad.ts"), "not kebab");

    expect(listLocalGraphNames(h)).toEqual(["one", "two"]);
    expect(deleteLocalGraph(h, "one")).toBe(true);
    expect(deleteLocalGraph(h, "one")).toBe(false);
    expect(listLocalGraphNames(h)).toEqual(["two"]);
  });

  test("an absent graphs dir is empty, not an error", () => {
    expect(listLocalGraphNames(mkdtempSync(join(tmpdir(), "howdah-none-")))).toEqual([]);
  });
});

/**
 * The compiler pass (D8). `validate()` cannot see a type error — types are erased before
 * anything runs — so this is the only gate that catches one. It is separate from save because
 * it spawns tsc; it turns out to cost ~1.5s, not the seconds-to-tens the design assumed.
 */
describe("typechecking a local graph", () => {
  test("a fresh scaffold passes, and a real type error is caught with a readable path", async () => {
    const h = home();
    await newGraph("checked", "custom", h, ROOT);

    const clean = await typecheckLocalGraph(h, "checked", ROOT);
    // a scaffold that does not typecheck would make the button useless on day one
    expect(clean).toEqual({ ok: true, diagnostics: [] });

    const path = localGraphPath(h, "checked");
    const good = readFileSync(path, "utf8");
    writeFileSync(path, good.replace('inputs: ["goal"]', 'inputs: ["goal"], maxSteps: "not a number"'));
    const bad = await typecheckLocalGraph(h, "checked", ROOT);
    expect(bad.ok).toBe(false);
    expect(bad.diagnostics.join("\n")).toContain("maxSteps");
    // the operator sees checked.ts(…), not a chain of ../ back out of the repo
    expect(bad.diagnostics[0]).toMatch(/^checked\.ts\(\d+,\d+\)/);
    expect(bad.unavailable).toBeUndefined();

    // and this is exactly what save does NOT catch: it loads and validates fine
    writeFileSync(path, good);
  }, 60_000);

  test("a type error still LOADS, which is why save alone cannot be the only gate", async () => {
    const h = home();
    await newGraph("loose", "custom", h, ROOT);
    const path = localGraphPath(h, "loose");
    const src = readFileSync(path, "utf8").replace('description:', 'maxSteps: "nonsense" as any, description:');
    // save accepts it — the value is wrong but nothing at runtime reads it during validate
    expect(await saveLocalSource(h, "loose", src, ROOT)).toEqual({ ok: true });
  }, 30_000);
});
