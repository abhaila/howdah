/**
 * Pin-time includes (system-map 1c review): `{{> prompt.id }}` expands when a run pins its
 * prompts, so rendering, rendered_hash and reconstruction never see an include. One function,
 * core/template.ts expandIncludes, serves the engine's pinning, the prompt store's undeclared-
 * read guard and codegen.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IncludeError, MAX_INCLUDE_DEPTH, expandIncludes, includeRefs, isPartialId } from "./template";
import { defineGraph } from "./graph";
import { Engine } from "../engine/run";
import { PromptStore } from "../prompts/store";
import { reconstructRender } from "../prompts/library";
import { PROMPT_IDS } from "./prompt-ids";

const bodies = (m: Record<string, string>) => (id: string) => {
  const b = m[id];
  if (b === undefined) throw new Error(`no prompts/${id}.md`);
  return b;
};

describe("expandIncludes", () => {
  test("expands nested includes, trims each included body's trailing whitespace, reports every id once", () => {
    const load = bodies({ "a._p": "P says {{ context.x }}\n\n", "b._q": "Q then {{> a._p }}\n" });
    expect(expandIncludes("start\n{{> b._q }}\nmid {{>a._p}} end", load)).toEqual({
      text: "start\nQ then P says {{ context.x }}\nmid P says {{ context.x }} end",
      included: ["b._q", "a._p"],
    });
    expect(includeRefs("x {{> a._p }} y {{> b._q}}")).toEqual(["a._p", "b._q"]);
  });

  test("a body with no include comes back byte for byte", () => {
    const body = "Plain {{ context.goal }} — {{ inputs.work | dump }}\n";
    expect(expandIncludes(body, bodies({}))).toEqual({ text: body, included: [] });
  });

  test("cycles, unknown ids and runaway nesting are refused with the path named", () => {
    expect(() => expandIncludes("{{> a }}", bodies({ a: "{{> b }}", b: "{{> a }}" }), ["root"])).toThrow(new IncludeError("include cycle: root → a → b → a"));
    expect(() => expandIncludes("{{> self }}", bodies({ self: "x" }), ["self"])).toThrow(/include cycle: self → self/);
    expect(() => expandIncludes("{{> nope }}", bodies({}))).toThrow(/cannot include "nope": no prompts\/nope.md/);
    const chain: Record<string, string> = {};
    for (let i = 0; i <= MAX_INCLUDE_DEPTH + 1; i++) chain[`p${i}`] = `{{> p${i + 1} }}`;
    chain[`p${MAX_INCLUDE_DEPTH + 2}`] = "leaf";
    expect(() => expandIncludes("{{> p0 }}", bodies(chain))).toThrow(/includes nest deeper than/);
  });

  test("partial ids are never runnable prompts; the real slice prompts include their partial", () => {
    expect(isPartialId("slice._design")).toBe(true);
    expect(isPartialId("slice.propose")).toBe(false);
    expect(PROMPT_IDS as readonly string[]).not.toContain("slice._design");
    const store = new PromptStore();
    const expanded = expandIncludes(store.load("slice.fix_ci").body, (id) => store.load(id).body, ["slice.fix_ci"]);
    expect(expanded.included).toEqual(["delivery.fix_ci", "slice._design"]);
    expect(expanded.text).toContain("## The approved design");
    expect(expanded.text).toContain(store.load("delivery.fix_ci").body.trim());
  });
});

// ---- the store's undeclared-read guard through includes ------------------------------------

interface Ctx {
  goal: string;
  work: string;
  secret: string;
}

const graph = defineGraph<Ctx>({
  name: "includer",
  entry: "discover",
  inputs: ["goal", "work"],
  nodes: {
    discover: { kind: "agent", prompt: "discover", reads: ["goal", "work"], writes: {} },
    done: { kind: "terminal", outcome: "success" },
  },
  edges: [{ from: "discover", to: "done" }],
});

function promptDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "howdah-includes-"));
  for (const [id, body] of Object.entries(files)) writeFileSync(join(dir, `${id}.md`), `---\nid: ${id}\nversion: 1\n---\n${body}`);
  return dir;
}

describe("PromptStore.validateTemplateReads through includes", () => {
  test("a read inside an included partial counts against the includer's node", () => {
    const store = new PromptStore(promptDir({ discover: "Go {{ context.goal }}\n{{> shared._p }}\n", "shared._p": "Work: {{ context.work }}\n" }));
    expect(store.validateTemplateReads("discover", store.load("discover").body, [graph])).toEqual([]);
    // the includer revised to include nothing new: fine; revised to read an undeclared key through the partial: refused
    expect(store.validateTemplateReads("shared._p", "Leak: {{ context.secret }}\n", [graph])).toEqual([
      'includer/discover: template reads "secret" but the node does not declare it',
    ]);
  });

  test("a revision that breaks an include (cycle / unknown id) is refused", () => {
    const store = new PromptStore(promptDir({ discover: "{{> shared._p }}\n", "shared._p": "ok\n" }));
    expect(store.validateTemplateReads("shared._p", "{{> discover }}\n", [graph])[0]).toContain("include cycle");
    expect(store.validateTemplateReads("discover", "{{> shared._missing }}\n", [graph])[0]).toContain('cannot include "shared._missing"');
  });
});

// ---- pinning + reconstruction -----------------------------------------------------------

describe("engine pinning expands includes; reconstruction verifies the included prompt", () => {
  test("the pinned file holds the expanded text, the render hashes it, reconstructRender verifies it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-include-run-"));
    const promptsDir = promptDir({ discover: "Goal: {{ context.goal }}\n\n{{> shared._p }}\n", "shared._p": "Work: {{ context.work }}\n" });
    let sent = "";
    const engine = new Engine(graph, {
      dir,
      promptsDir,
      executors: { agent: async ({ renderedPrompt }) => ((sent = renderedPrompt ?? ""), { status: "succeeded", writes: {} }) },
    });
    expect(await engine.start({ goal: "ship", work: "the thing" })).toEqual({ state: "finished", outcome: "success" });
    const pinned = readFileSync(join(dir, "prompts", "discover.md"), "utf8");
    expect(pinned).toBe("---\nid: discover\nversion: 1\n---\nGoal: {{ context.goal }}\n\nWork: {{ context.work }}\n");
    expect(sent).toStartWith("Goal: ship\n\nWork: the thing\n");
    const render = engine.log.read().find((e) => e.type === "prompt-rendered")!;
    if (render.type !== "prompt-rendered") throw new Error("no render");
    expect(render.context_read).toEqual({ goal: "ship", work: "the thing" });
    const rebuilt = reconstructRender(dir, render.rendered_hash);
    expect(rebuilt).toMatchObject({ verified: true, text: sent });
  });

  test("a prompt without includes is pinned byte for byte (implement-ticket's pinned prompts do not change)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-include-run-"));
    const raw = "---\nid: discover\nversion: 1\ntags: [x]\n---\nGoal: {{ context.goal }}   \n";
    const promptsDir = mkdtempSync(join(tmpdir(), "howdah-includes-"));
    writeFileSync(join(promptsDir, "discover.md"), raw);
    const engine = new Engine(graph, { dir, promptsDir, executors: { agent: async () => ({ status: "succeeded", writes: {} }) } });
    await engine.start({ goal: "g", work: "w" });
    expect(readFileSync(join(dir, "prompts", "discover.md"), "utf8")).toBe(raw);
  });

  test("a broken include refuses the start before anything is written: no half-pinned run dir, no log", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "howdah-include-run-")), "run");
    const promptsDir = promptDir({ discover: "Goal: {{ context.goal }}\n{{> shared._gone }}\n" });
    const engine = new Engine(graph, { dir, promptsDir, executors: { agent: async () => ({ status: "succeeded", writes: {} }) } });
    await expect(engine.start({ goal: "g", work: "w" })).rejects.toThrow('cannot include "shared._gone"');
    expect(existsSync(join(dir, "prompts"))).toBe(false);
    expect(existsSync(join(dir, "run.jsonl"))).toBe(false);
  });
});
