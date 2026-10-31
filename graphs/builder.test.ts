/**
 * Saving a built graph (HOW-22). The promise being pinned is the one graphs/local.ts already
 * makes — what is on disk is always runnable — extended over the PROMPT files a builder save
 * also writes, plus the round trip the builder depends on to re-open its own work.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptIdFor, promptIdsOf, readLocalPrompt, renderSpecModule, saveBuilderGraph, saveVerdict } from "./builder";
import { loadLocalGraph, localGraphPath, localPromptsDir, ensureLocalDirs, promptSearchPath } from "./local";
import { COMMAND_BUILTINS, WORKTREE_FACTS, coerceOperand, isBlocking, keepPath, specAdvice, specOf, specProblems, unknownCopyProblem, type GraphSpec, type NodeSpec } from "../core/graph-spec";
import { frontMatterField, splitFrontMatter, templateReads } from "../core/template";
import { defineGraph, type NodeDef } from "../core/graph";
import { Engine } from "../engine/run";
import type { PromptId } from "../core/prompt-ids";
import { GRAPHS } from "./index";
// core/ is node-free and cannot import an executor, so the table REPEATS what the executors
// know. This file is node-side, so it imports the executors' own constants and pins the repetition.
import { LAUNCH_BUILTIN, LAUNCH_PRODUCES, LAUNCH_READS } from "../engine/executors/launch";
import { MAP_BUILTINS } from "../engine/executors/map";
import { VERIFY_BUILTIN, VERIFY_PRODUCES } from "../engine/executors/verify";
import { AWAIT_BUILTIN } from "../engine/executors/await";
import { RESTACK_BUILTIN } from "../engine/executors/restack";
import { AWAIT_PRODUCES, AWAIT_PROBE_PRODUCES, AWAIT_READS, RESTACK_PRODUCES, RESTACK_READS } from "../core/stack";
import { REPAIR_CHECK_BUILTIN, REPAIR_CHECK_PRODUCES, REPAIR_CHECK_READS } from "../core/repair-stall";
import { EVIDENCE_BUILTIN } from "../engine/executors/evidence";
import { GRAPHS_CATALOG_BUILTIN } from "../engine/executors/catalog";
// the reducer is plain data over core/ — no React, no DOM — so the browser's verdict can be
// driven from here and compared against this file's gate, which is the whole point below
import { PRESETS, bySeverity, draftProblems, draftReducer, newStep, pickPrompts, type Draft, type DraftAction } from "../web/app/lib/spec-draft";

const ROOT = join(import.meta.dir, "..");
const home = () => mkdtempSync(join(tmpdir(), "howdah-builder-"));

/** one spec exercising every node kind, every scope and several predicate shapes */
function everything(name = "kitchen-sink"): GraphSpec {
  const p = (node: string) => promptIdFor(name, node);
  return {
    version: 1,
    name,
    description: "every node kind at once",
    fields: [
      { key: "goal", kind: "text", scope: "sticky", description: "what to do" },
      { key: "work", kind: "text", scope: "sticky" },
      { key: "summary", kind: "text", scope: "sticky" },
      { key: "plan", kind: "json", scope: "sticky" },
      { key: "plan_base", kind: "json", scope: "sticky" },
      { key: "plan_decision", kind: "json", scope: "per-visit" },
      { key: "plan_feedback", kind: "json", scope: "sticky" },
      { key: "review_verdict", kind: "choice", scope: "cleared", choices: ["pass", "reject"] },
      { key: "pr.state", kind: "choice", scope: "per-visit", choices: ["MERGED", "CLOSED"] },
      { key: "worktree.clean", kind: "boolean", scope: "per-visit" },
    ],
    inputs: ["goal", "work"],
    defaults: { permissionMode: "auto" },
    entry: "make-worktree",
    // HOW-24: the canvas arrangement is part of the artifact, so the round trip has to carry
    // it — and `compileNode` has to keep dropping it (core/graph-spec.test.ts)
    nodes: [
      { id: "make-worktree", kind: "worktree", title: "Make a worktree", action: "create", writes: [], position: { x: 40, y: 40 } },
      { id: "plan-it", kind: "agent", title: "Plan the change", prompt: p("plan-it"), reads: ["goal", "work"], writes: ["plan", "plan_base"], readOnly: true, class: "planning" },
      { id: "approve", kind: "approval", title: "Get my approval", proposal: "plan", base: "plan_base", decision: "plan_decision", feedback: "plan_feedback", redesignTo: "plan-it" },
      { id: "build", kind: "agent", title: "Build it", prompt: p("build"), reads: ["goal", "plan"], writes: ["summary", "review_verdict"], maxVisits: 3, requires: "approve", config: { harness: "codex", effort: "high" } },
      { id: "settle", kind: "wait", title: "Let CI settle", duration: "30 s" },
      { id: "check-pr", kind: "command", title: "Check the PR", run: "probe:pr", reads: [], writes: ["pr.state"], timeoutMs: 60000 },
      { id: "clean-up", kind: "worktree", title: "Clean up", action: "remove", writes: ["worktree.clean"] },
      { id: "done", kind: "terminal", outcome: "success", label: "shipped", position: { x: 40, y: 684 } },
      { id: "stuck", kind: "terminal", outcome: "failed", position: { x: 250, y: 684 } },
    ],
    edges: [
      { from: "make-worktree", to: "plan-it" },
      { from: "plan-it", to: "approve" },
      { from: "approve", to: "build", when: { op: "equals", key: "plan_decision", path: "outcome", value: "approved" } },
      { from: "approve", to: "plan-it" },
      { from: "build", to: "settle", when: { op: "equals", key: "review_verdict", value: "pass" } },
      { from: "build", to: "stuck" },
      { from: "settle", to: "check-pr" },
      { from: "check-pr", to: "clean-up", when: { op: "one-of", key: "pr.state", values: ["MERGED", "CLOSED"] } },
      { from: "check-pr", to: "settle" },
      { from: "clean-up", to: "done", when: { op: "is-true", key: "worktree.clean" } },
      { from: "clean-up", to: "stuck" },
    ],
  };
}

const bodies = (spec: GraphSpec): Record<string, string> => ({
  [promptIdFor(spec.name, "plan-it")]: "Plan it. Goal: {{ context.goal }}\n\nWork: {{ context.work }}",
  [promptIdFor(spec.name, "build")]: "Build it. Goal: {{ context.goal }}\n\nPlan: {{ context.plan }}",
});

describe("a builder graph is an ordinary local graph", () => {
  test("it saves, loads, validates, and the spec round-trips byte-for-byte", async () => {
    const h = home();
    const spec = everything();
    const saved = await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec, prompts: bodies(spec) });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.created).toBe(true);

    const loaded = await loadLocalGraph(h, spec.name, ROOT);
    loaded.validateOrThrow();
    // reads are DERIVED from the prompt body, so the spec on disk differs from the input in
    // exactly that one way — and in no other
    const expected: GraphSpec = {
      ...spec,
      nodes: spec.nodes.map((n) =>
        n.id === "plan-it" ? { ...n, reads: ["goal", "work"] } : n.id === "build" ? { ...n, reads: ["goal", "plan"] } : n,
      ),
    };
    expect(loaded.def.spec).toEqual(expected);
  });

  test("every node kind survives the compile", async () => {
    const h = home();
    const spec = everything();
    await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec, prompts: bodies(spec) });
    const g = await loadLocalGraph(h, spec.name, ROOT);
    expect(Object.values(g.def.nodes).map((n) => n.kind).sort()).toEqual(
      ["agent", "agent", "approval", "command", "terminal", "terminal", "wait", "worktree", "worktree"],
    );
    const build = g.def.nodes["build"]!;
    expect(build.kind === "agent" && build.requires).toEqual({ approvalOf: "approve" });
    expect(build.kind === "agent" && build.harness).toBe("codex");
    const plan = g.def.nodes["plan-it"]!;
    expect(plan.kind === "agent" && plan.readOnly).toBe(true);
  });

  test("the reads a step declares come from its prompt body, not from the client", async () => {
    const h = home();
    const spec = everything();
    // the client claims it reads nothing; the body says otherwise, and the body wins
    const lying: GraphSpec = { ...spec, nodes: spec.nodes.map((n) => (n.id === "build" ? { ...n, reads: [] } : n)) };
    await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec: lying, prompts: bodies(spec) });
    const g = await loadLocalGraph(h, spec.name, ROOT);
    const build = g.def.nodes["build"]!;
    expect(build.kind === "agent" && build.reads).toEqual(["goal", "plan"]);
  });
});

describe("a refused save changes nothing — the graph OR its prompts", () => {
  test("the second save is rejected and both files hold the first version", async () => {
    const h = home();
    const spec = everything("guarded");
    const first = bodies(spec);
    expect((await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec, prompts: first })).ok).toBe(true);

    const graphBytes = readFileSync(localGraphPath(h, "guarded"), "utf8");
    const promptBytes = Object.fromEntries(
      Object.keys(first).map((id) => [id, readFileSync(join(localPromptsDir(h), `${id}.md`), "utf8")]),
    );

    // a dangling redesignTo: valid JSON, refused by validate()
    const broken: GraphSpec = {
      ...spec,
      nodes: spec.nodes.map((n) => (n.kind === "approval" ? { ...n, redesignTo: "no-such-step" } : n)),
    };
    const refused = await saveBuilderGraph({ intent: "update",
      home: h, repoRoot: ROOT, spec: broken,
      prompts: Object.fromEntries(Object.keys(first).map((id) => [id, "REWRITTEN — must not survive"])),
    });
    expect(refused.ok).toBe(false);
    // the refusal is specProblems()' wording, not validate()'s: the browser had already shown
    // the operator this exact sentence, on the pane that fixes it
    if (!refused.ok) {
      expect(refused.error).toContain('sends "ask for changes" to a step that no longer exists');
      expect(refused.error).not.toContain("redesigns to unknown node");
    }

    expect(readFileSync(localGraphPath(h, "guarded"), "utf8")).toBe(graphBytes);
    for (const [id, bytes] of Object.entries(promptBytes))
      expect(readFileSync(join(localPromptsDir(h), `${id}.md`), "utf8")).toBe(bytes);
  });

  test("a first save that fails leaves no half-made graph and no orphan prompts", async () => {
    const h = home();
    const spec = everything("never-was");
    const broken: GraphSpec = { ...spec, edges: [] };
    expect((await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec: broken, prompts: bodies(spec) })).ok).toBe(false);
    expect(existsSync(localGraphPath(h, "never-was"))).toBe(false);
    for (const id of Object.keys(bodies(spec))) expect(existsSync(join(localPromptsDir(h), `${id}.md`))).toBe(false);
  });
});

describe("what a prompt id is allowed to be", () => {
  const tiny = (name: string, prompt: string): GraphSpec => ({
    version: 1, name, description: "", fields: [{ key: "goal", kind: "text", scope: "sticky" }], inputs: ["goal"],
    entry: "work",
    nodes: [{ id: "work", kind: "agent", prompt, reads: ["goal"], writes: [] }, { id: "done", kind: "terminal", outcome: "success" }],
    edges: [{ from: "work", to: "done" }],
  });

  test("a body for a prompt no step names is refused — the id is a file path", async () => {
    const h = home();
    const spec = tiny("tiny", "tiny.work");
    const r = await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec, prompts: { "tiny.work": "x", "somebody.else": "y" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no step names the prompt");
  });

  test("a prompt that would shadow one of Howdah's own is refused by name", async () => {
    const h = home();
    const spec = tiny("shadowy", "delivery.publish");
    const r = await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec, prompts: { "delivery.publish": "hijacked" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("shadow");
    expect(existsSync(join(localPromptsDir(h), "delivery.publish.md"))).toBe(false);
  });

  /**
   * HOW-22 review, finding 4. Local prompts share ONE directory, so `<graph>.<step>` is the only
   * thing keeping two graphs' instructions apart — and nothing proved it, so a create naming
   * another graph's id rewrote that graph's prompt file and returned ok. This is C7's guarantee
   * ("a create that lands on an existing graph is refused, never merged") one level down: the
   * module was protected and the prompts it renders from were not.
   */
  test("a save may not write ANOTHER local graph's prompt — the victim's bytes survive it", async () => {
    const h = home();
    const victim = tiny("victim", "victim.work");
    expect((await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec: victim, prompts: { "victim.work": "Do the work. {{ context.goal }}" } })).ok).toBe(true);
    const path = join(localPromptsDir(h), "victim.work.md");
    const before = readFileSync(path, "utf8");
    const listing = readdirSync(localPromptsDir(h)).sort();

    const attacker = tiny("attacker", "victim.work");
    const r = await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec: attacker, prompts: { "victim.work": "PWNED. {{ context.goal }}" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("another graph's prompt");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(localGraphPath(h, "attacker"))).toBe(false);
    expect(readdirSync(localPromptsDir(h)).sort()).toEqual(listing);
  });

  test("the same id in the PAYLOAD alone is refused too — the two guards leave no hole", async () => {
    const h = home();
    // declared by no step of this spec, so the "no step names" guard fires first; asserted so a
    // later reshuffle of the loop cannot let a foreign id through on the strength of the other
    const r = await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec: tiny("mine", "mine.work"), prompts: { "mine.work": "x", "victim.work": "y" } });
    expect(r.ok).toBe(false);
    expect(existsSync(join(localPromptsDir(h), "victim.work.md"))).toBe(false);
  });

  test("...and two steps of ONE graph sharing a body still saves, which is how remove-step leaves things", async () => {
    const h = home();
    const spec: GraphSpec = {
      version: 1, name: "shared", description: "", fields: [{ key: "goal", kind: "text", scope: "sticky" }], inputs: ["goal"],
      entry: "work",
      nodes: [
        { id: "work", kind: "agent", prompt: "shared.work", reads: ["goal"], writes: [] },
        { id: "again", kind: "agent", prompt: "shared.work", reads: ["goal"], writes: [] },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
      edges: [{ from: "work", to: "again" }, { from: "again", to: "done" }],
    };
    const r = await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec, prompts: { "shared.work": "Do it. {{ context.goal }}" } });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
  });

  test("an existing prompt file keeps its version rather than being renumbered", async () => {
    const h = home();
    ensureLocalDirs(h);
    writeFileSync(join(localPromptsDir(h), "versioned.work.md"), "---\nid: versioned.work\nversion: 7\n---\nold body\n");
    const spec = tiny("versioned", "versioned.work");
    expect((await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec, prompts: { "versioned.work": "new body {{ context.goal }}" } })).ok).toBe(true);
    const raw = readFileSync(join(localPromptsDir(h), "versioned.work.md"), "utf8");
    expect(raw).toContain("version: 7");
    expect(readLocalPrompt(h, "versioned.work")).toBe("new body {{ context.goal }}");
  });
});

describe("the rendered module", () => {
  test("an operator's prose cannot become code — everything is JSON", async () => {
    const h = home();
    const spec = everything("sneaky");
    spec.description = 'not a string"; process.exit(1); const x = "';
    const src = renderSpecModule(spec, ROOT);
    // the quote that would have closed the literal is escaped, so the payload stays a string
    expect(src).toContain(String.raw`not a string\"; process.exit(1); const x = \"`);
    // and the proof is that the module still loads, with the prose intact as prose
    await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec, prompts: bodies(spec) });
    expect((await loadLocalGraph(h, "sneaky", ROOT)).def.description).toBe(spec.description);
  });

  test("the import is absolute, because a local graph is imported from a temp dir", () => {
    expect(renderSpecModule(everything(), ROOT)).toContain(JSON.stringify(join(ROOT, "core", "graph-spec")));
  });
});


describe("an IO failure is still all-or-nothing (the writes live inside the try)", () => {
  test("a prompt that cannot be created leaves every earlier file byte-identical", async () => {
    const h = home();
    const spec = everything("io-fail");
    expect((await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec, prompts: bodies(spec) })).ok).toBe(true);

    const graphBytes = readFileSync(localGraphPath(h, "io-fail"), "utf8");
    const promptBytes = Object.fromEntries(
      Object.keys(bodies(spec)).map((id) => [id, readFileSync(join(localPromptsDir(h), `${id}.md`), "utf8")]),
    );

    // a second save that ADDS a step, so the existing prompt files are rewritten (allowed —
    // the files themselves are writable) and a new one has to be CREATED, which needs write
    // permission on the directory. Taking that away makes the loop throw half way through:
    // the exact failure restore() could not see while the writes sat outside the try.
    const grown: GraphSpec = {
      ...spec,
      nodes: [...spec.nodes, { id: "extra", kind: "agent", title: "One more", prompt: promptIdFor("io-fail", "extra"), reads: [], writes: [] }],
      edges: spec.edges.map((e) => (e.from === "settle" ? { ...e, to: "extra" } : e)).concat([{ from: "extra", to: "check-pr" }]),
    };
    const rewritten = {
      ...Object.fromEntries(Object.keys(bodies(spec)).map((id) => [id, "REWRITTEN — must not survive"])),
      [promptIdFor("io-fail", "extra")]: "never written",
    };
    chmodSync(localPromptsDir(h), 0o500);
    try {
      const refused = await saveBuilderGraph({ intent: "update", home: h, repoRoot: ROOT, spec: grown, prompts: rewritten });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error).toMatch(/EACCES|permission denied/i);
    } finally {
      chmodSync(localPromptsDir(h), 0o700);
    }

    expect(readFileSync(localGraphPath(h, "io-fail"), "utf8")).toBe(graphBytes);
    for (const [id, bytes] of Object.entries(promptBytes))
      expect(readFileSync(join(localPromptsDir(h), `${id}.md`), "utf8")).toBe(bytes);
    expect(readdirSync(localPromptsDir(h)).sort()).toEqual(Object.keys(promptBytes).map((id) => `${id}.md`).sort());
  });
});

describe("what an executor can emit — the table checked against the executors themselves", () => {
  const executor = (file: string) => readFileSync(join(ROOT, "engine", "executors", file), "utf8");

  test("WORKTREE_FACTS is exactly what engine/executors/worktree.ts fills in", () => {
    const src = executor("worktree.ts");
    const facts = [...new Set([...src.matchAll(/declared\.has\("([^"]+)"\)/g)].map((m) => m[1]!))].sort();
    // a rename in the executor that stopped matching this pattern would make the test vacuous
    expect(facts.length).toBeGreaterThan(0);
    expect(facts).toEqual([...WORKTREE_FACTS].sort());
  });

  test("probe:pr publishes exactly what the table claims", () => {
    const facts = [...new Set([...executor("worktree.ts").matchAll(/declared\.includes\("([^"]+)"\)/g)].map((m) => m[1]!))].sort();
    expect(facts.length).toBeGreaterThan(0);
    expect(facts).toEqual([...COMMAND_BUILTINS.find((b) => b.run === "probe:pr")!.produces].sort());
  });

  test("every map:* built-in publishes exactly what the table claims", () => {
    const src = executor("map.ts");
    // each `declaredWrites(<builtin>, def, { … })`; where the first argument is `run.name`,
    // the builtin is the nearest `run.name === "…"` guard above the call
    const found: Record<string, string[]> = {};
    for (const m of src.matchAll(/declaredWrites\(\s*(?:"([^"]+)"|run\.name)\s*,\s*def\s*,\s*\{([^}]*)\}/g)) {
      const name = m[1] ?? [...src.slice(0, m.index).matchAll(/run\.name === "([^"]+)"/g)].at(-1)?.[1];
      if (!name) continue;
      const keys = [...m[2]!.matchAll(/(?:"([^"]+)"|([A-Za-z_]\w*))\s*:/g)].map((k) => k[1] ?? k[2]!);
      found[name] = [...new Set([...(found[name] ?? []), ...keys])].sort();
    }
    const table = Object.fromEntries(
      COMMAND_BUILTINS.filter((b) => b.run.startsWith("map:")).map((b) => [b.run, [...b.produces].sort()]),
    );
    expect(Object.keys(found).sort()).toEqual(Object.keys(table).sort());
    expect(found).toEqual(table);
  });

  // HOW-23 review, finding 2. The fan-out built-in was dispatched by the command executor and
  // was not in the table at all, so the browser had no answer for it: nothing to offer, nothing
  // to refuse with, and a step declaring an impossible fact saved clean.
  test("runs:launch publishes — and works from — exactly what the table claims", () => {
    const row = COMMAND_BUILTINS.find((b) => b.run === LAUNCH_BUILTIN)!;
    expect(row.produces).toEqual([...LAUNCH_PRODUCES]);
    expect(row.reads).toEqual([...LAUNCH_READS]);
  });

  test("…and those constants are the object engine/executors/launch.ts actually hands declaredWrites", () => {
    const m = executor("launch.ts").match(/declaredWrites\(\s*LAUNCH_BUILTIN\s*,\s*def\s*,\s*\{([^}]*)\}/);
    // a rewrite that stopped matching this pattern would make the test vacuous
    expect(m, "no declaredWrites(LAUNCH_BUILTIN, def, { … }) call found").not.toBeNull();
    const keys = [...m![1]!.matchAll(/(?:"([^"]+)"|([A-Za-z_]\w*))\s*:/g)].map((k) => k[1] ?? k[2]!).sort();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toEqual([...LAUNCH_PRODUCES].sort());
  });

  /**
   * The test that would have caught the omission. A built-in the command executor dispatches
   * but the table has never heard of is invisible to the whole builder — `emittableWrites`
   * returns undefined, which MEANS "anything the operator declares is legal".
   */
  test("every built-in the command executor dispatches is in the table", () => {
    expect([...MAP_BUILTINS, LAUNCH_BUILTIN, VERIFY_BUILTIN, EVIDENCE_BUILTIN, AWAIT_BUILTIN, RESTACK_BUILTIN, GRAPHS_CATALOG_BUILTIN, REPAIR_CHECK_BUILTIN, "probe:pr"].sort()).toEqual(COMMAND_BUILTINS.map((b) => b.run).sort());
  });

  // HOW-56 T4. core/catalog.ts carries the key the row produces, so what is pinned here is
  // that the EXECUTOR hands declaredWrites exactly that contract — and is dispatched at all.
  test("graphs:catalog publishes exactly what the table claims", () => {
    const row = COMMAND_BUILTINS.find((b) => b.run === GRAPHS_CATALOG_BUILTIN)!;
    expect(row.produces).toEqual(["graphs.catalog"]);
    expect(row.reads).toBeUndefined();
    const src = executor("catalog.ts");
    const m = src.match(/declaredWrites\(\s*GRAPHS_CATALOG_BUILTIN\s*,\s*def\s*,\s*\{\s*\[([A-Z_]+)\]\s*:/);
    expect(m, "no declaredWrites(GRAPHS_CATALOG_BUILTIN, def, { [KEY]: … }) call found").not.toBeNull();
    expect(m![1]).toBe("GRAPHS_CATALOG_KEY");
    expect(executor("worktree.ts")).toContain("if (isGraphsCatalogBuiltin(def.run)) return catalogBuiltin(args);");
  });

  // HOW-57. runs:await reads core/stack.ts like verify reads core/verify.ts; what is pinned is
  // that the executor hands declaredWrites exactly those keys, in both modes, and is dispatched.
  test("runs:await publishes — and works from — exactly what the table claims", () => {
    const row = COMMAND_BUILTINS.find((b) => b.run === AWAIT_BUILTIN)!;
    expect(row.produces).toEqual([...AWAIT_PRODUCES, ...AWAIT_PROBE_PRODUCES]);
    expect(row.reads).toEqual([...AWAIT_READS]);
    const src = executor("await.ts");
    const calls = [...src.matchAll(/declaredWrites\(\s*AWAIT_BUILTIN\s*,\s*def\s*,\s*\{([^}]*)\}/g)];
    expect(calls).toHaveLength(2);
    const keysOf = (body: string) => [...body.matchAll(/"([^"]+)"\s*:/g)].map((k) => k[1]!).sort();
    const byMode = calls.map((c) => keysOf(c[1]!)).sort((a, b) => a.length - b.length);
    expect(byMode).toEqual([[...AWAIT_PROBE_PRODUCES].sort(), [...AWAIT_PRODUCES].sort()]);
    expect(executor("worktree.ts")).toContain("if (isAwaitBuiltin(def.run)) return awaitBuiltin(args);");
  });

  // HOW-75: repair:changed reads core/repair-stall.ts's contract; pin the executor to it
  test("repair:changed publishes — and works from — exactly what the table claims", () => {
    const row = COMMAND_BUILTINS.find((b) => b.run === REPAIR_CHECK_BUILTIN)!;
    expect(row.produces).toEqual([...REPAIR_CHECK_PRODUCES]);
    expect(row.reads).toEqual([...REPAIR_CHECK_READS]);
    const src = executor("repair-check.ts");
    const m = src.match(/declaredWrites\(\s*REPAIR_CHECK_BUILTIN\s*,\s*def\s*,\s*\{\s*\[([A-Z_]+)\]\s*:/);
    expect(m, "no declaredWrites(REPAIR_CHECK_BUILTIN, def, { [KEY]: … }) call found").not.toBeNull();
    expect(m![1]).toBe("REPAIR_CHANGED_KEY");
    expect(executor("worktree.ts")).toContain("if (isRepairCheckBuiltin(def.run)) return repairCheckBuiltin(args);");
  });

  test("git:restack publishes — and works from — exactly what the table claims", () => {
    const row = COMMAND_BUILTINS.find((b) => b.run === RESTACK_BUILTIN)!;
    expect(row.produces).toEqual([...RESTACK_PRODUCES]);
    expect(row.reads).toEqual([...RESTACK_READS]);
    const m = executor("restack.ts").match(/declaredWrites\(\s*RESTACK_BUILTIN\s*,\s*def\s*,\s*\{([^}]*)\}/);
    expect(m, "no declaredWrites(RESTACK_BUILTIN, def, { … }) call found").not.toBeNull();
    expect([...m![1]!.matchAll(/"([^"]+)"\s*:/g)].map((k) => k[1]!).sort()).toEqual([...RESTACK_PRODUCES].sort());
    expect(executor("worktree.ts")).toContain("if (isRestackBuiltin(def.run)) return restackBuiltin(args);");
  });

  // HOW-12. The row reads core/verify.ts rather than repeating it, so what is pinned here is
  // that the EXECUTOR hands declaredWrites exactly that contract — and is dispatched at all.
  test("verify:run publishes exactly what the table claims", () => {
    const row = COMMAND_BUILTINS.find((b) => b.run === VERIFY_BUILTIN)!;
    expect(row.produces).toEqual([...VERIFY_PRODUCES]);
    expect(row.reads).toBeUndefined();
    const src = executor("verify.ts");
    const m = src.match(/declaredWrites\(\s*VERIFY_BUILTIN\s*,\s*def\s*,\s*\{\s*\[([A-Z_]+)\]\s*:/);
    expect(m, "no declaredWrites(VERIFY_BUILTIN, def, { [KEY]: … }) call found").not.toBeNull();
    expect(m![1]).toBe("VERIFY_RESULT_KEY");
    expect([...VERIFY_PRODUCES]).toEqual(["verify.result"]);
    expect(executor("worktree.ts")).toContain("if (isVerifyBuiltin(def.run)) return verifyBuiltin(args);");
  });
});

/**
 * THE AGREEMENT TEST. Every blocking finding in the HOW-22 review was one draft on which the
 * browser said "Ready to save" and this file said no — so what is pinned is that PROPERTY,
 * not four examples of it:
 *
 *     draftProblems(draft) is empty  ⟺  saveBuilderGraph(draft) is ok
 *
 * and, when both refuse, that the server's message is one specProblems() produced rather than
 * a raw `Violation` string. Reverting a correction turns a row of this matrix red, which is
 * what makes it evidence rather than decoration.
 */
describe("the browser's verdict and the server's gate cannot disagree", () => {
  const seq = (...actions: DraftAction[]) => (d: Draft) => actions.reduce(draftReducer, d);
  const cleanupStep = (d: Draft) =>
    d.spec.nodes.find((n): n is Extract<NodeSpec, { kind: "worktree" }> => n.kind === "worktree" && n.action === "remove");

  /**
   * `saves` is not redundant with the ⟺ above. Agreement alone is satisfied by BOTH sides
   * refusing, so a correction that stops a legitimate edit from working — a rename whose
   * bodies no longer follow, say — would keep the property while breaking the feature. Each
   * row therefore also says what the right answer IS.
   */
  /** what the Branching pane's "Add a condition" does: one more row leaving the entry step,
   *  its operand seeded by the field's KIND through the same coerceOperand the form calls */
  const addSeededRow = (d: Draft, key: string): Draft => {
    const f = d.spec.fields.find((x) => x.key === key)!;
    // the step the operator would be standing on: whichever one already branches on this field
    // if there is one (so the field is written by the time the row is evaluated), else the entry
    const from = d.spec.edges.find((e) => e.when?.key === key)?.from ?? d.spec.entry;
    const mine = d.spec.edges.filter((e) => e.from === from);
    const fallback = mine.find((e) => !e.when);
    return draftReducer(d, {
      type: "set-branching", from,
      edges: [
        ...mine.filter((e) => e.when).map((e) => ({ to: e.to, when: e.when! })),
        { to: fallback?.to ?? d.spec.nodes.find((n) => n.kind === "terminal")!.id,
          when: { op: "equals" as const, key, value: coerceOperand("", f.kind) } },
        ...(fallback ? [{ to: fallback.to }] : []),
      ],
    });
  };

  /**
   * HOW-23: a fan-out step, built the way the wizard builds one. It goes in FRONT of the
   * existing entry so every other step stays reachable, and the plan and its tickets are asked
   * for at launch so something writes them on every path — the smallest draft that puts
   * `runs:launch` in a graph at all.
   */
  const fanOut = (patch: (n: Extract<NodeSpec, { kind: "command" }>) => NodeSpec) => (d: Draft): Draft => {
    const made = newStep(d.spec, "command", "Fan it out");
    const wasEntry = d.spec.entry;
    const node = { ...(made.node as Extract<NodeSpec, { kind: "command" }>), run: "runs:launch", reads: ["plan.slices", "tickets"], writes: ["launched"] };
    const built = ([
      { type: "add-field", patch: { key: "plan.slices", kind: "json", scope: "sticky" } },
      { type: "add-field", patch: { key: "tickets", kind: "json", scope: "sticky" } },
      { type: "add-field", patch: { key: "launched", kind: "json", scope: "sticky" } },
      { type: "toggle-input", key: "plan.slices" },
      { type: "toggle-input", key: "tickets" },
      { type: "add-step", ...made, node },
      { type: "set-branching", from: node.id, edges: [{ to: wasEntry }] },
      { type: "set-entry", id: node.id },
    ] as DraftAction[]).reduce(draftReducer, d);
    // the reducer NORMALISES a step's writes to what its executor can emit, so an impossible
    // declaration cannot be typed — it arrives by PUT or from a hand-edited file, which is
    // what these rows put straight onto the spec
    return { ...built, spec: { ...built.spec, nodes: built.spec.nodes.map((n) => (n.id === node.id ? patch(n as Extract<NodeSpec, { kind: "command" }>) : n)) } };
  };

  const MUTATIONS: Array<{ name: string; apply: (d: Draft) => Draft; saves: boolean; applies?: (d: Draft) => boolean }> = [
    { name: "untouched", apply: (d) => d, saves: true },
    { name: "fan one run out per approved slice", apply: fanOut((n) => n), saves: true },
    // HOW-23 review, finding 2: `runs:launch` reports `launched` and nothing else
    { name: "a fan-out step claiming it produces the tickets", apply: fanOut((n) => ({ ...n, writes: ["tickets"] })), saves: false },
    // …and the other half of the contract: the executor refuses a node that does not name what
    // it reads, so the browser has to refuse it too or the two disagree again
    { name: "a fan-out step wired to nothing", apply: fanOut((n) => ({ ...n, reads: [] })), saves: false },
    {
      name: "add an agent step, then remove it",
      apply: (d) => {
        const made = newStep(d.spec, "agent", "Extra");
        return seq({ type: "add-step", ...made }, { type: "remove-step", id: made.node.id })(d);
      },
      saves: true,
    },
    { name: "rename a field its instructions use", apply: seq({ type: "update-field", key: "goal", patch: { key: "objective" } }), saves: true },
    { name: "remove a field its instructions use", apply: seq({ type: "remove-field", key: "goal" }), saves: false },
    {
      name: "flip a worktree step from clean-up to make",
      applies: (d) => cleanupStep(d) !== undefined,
      apply: (d) => {
        const wt = cleanupStep(d)!;
        return draftReducer(d, { type: "update-step", id: wt.id, node: { ...wt, action: "create" } });
      },
      // the branch that tested `worktree.clean` survives, and nothing writes it any more
      saves: false,
    },
    { name: "rename the graph before its first save", apply: seq({ type: "set-name", name: "renamed-here" }), saves: true },
    // HOW-22 review, finding 1: an entry that cannot run. The picker cannot offer a terminal,
    // so this is the shape that arrives from a PUT or a hand-edited file — refused by BOTH sides.
    {
      name: "point the start at a Finish step",
      applies: (d) => d.spec.nodes.some((n) => n.kind === "terminal"),
      apply: (d) => draftReducer(d, { type: "set-entry", id: d.spec.nodes.find((n) => n.kind === "terminal")!.id }),
      saves: false,
    },
    // HOW-22 review, C9: the review pane promises every step is reachable
    {
      name: "add a step nothing goes to",
      apply: (d) => {
        const made = newStep(d.spec, "command", "Stranded");
        const done = d.spec.nodes.find((n) => n.kind === "terminal")!.id;
        return seq({ type: "add-step", ...made }, { type: "set-branching", from: made.node.id, edges: [{ to: done }] })(d);
      },
      saves: false,
    },
    // HOW-22 review, finding 3. A row seeded through coerceOperand on a yes/no field is BORN
    // able to fire, and must save: agreement alone would be satisfied by both sides refusing a
    // condition an operator had only just added.
    {
      name: "add a condition row on a yes/no field",
      applies: (d) => d.spec.fields.some((f) => f.kind === "boolean" && d.spec.edges.some((e) => e.when?.key === f.key)),
      apply: (d) => addSeededRow(d, d.spec.fields.find((f) => f.kind === "boolean")!.key),
      saves: true,
    },
    // on a TEXT field the seed is genuinely "" — there is no value to guess — so the unfinished
    // row is REPORTED rather than saved as a branch that can never fire (plan R7, accepted)
    {
      name: "add a condition row on a text field",
      applies: (d) => d.spec.fields.some((f) => f.kind === "text" && d.spec.inputs.includes(f.key)),
      apply: (d) => addSeededRow(d, d.spec.fields.find((f) => f.kind === "text")!.key),
      saves: false,
    },
    // HOW-22 review, finding 1. "go to [pick a step]" is a real state of the picker; it must be
    // reported in words, and the picture beside it must survive being drawn (graph-dag.test.tsx).
    {
      name: "point a branch at no step",
      apply: (d) => {
        const from = d.spec.entry;
        return draftReducer(d, {
          type: "set-branching", from,
          edges: d.spec.edges.filter((e) => e.from === from).map((e, i) => (i === 0 ? { to: "", ...(e.when ? { when: e.when } : {}) } : { to: e.to, ...(e.when ? { when: e.when } : {}) })),
        });
      },
      saves: false,
    },
    // HOW-22 review, finding 3. A path on a field that cannot hold one saved clean and never
    // fired; it is the verdict, not the form, that has to say so.
    {
      name: "reach inside a field that is not structured",
      applies: (d) => d.spec.edges.some((e) => e.when && d.spec.fields.some((f) => f.key === e.when!.key && f.kind !== "json")),
      apply: (d) => ({
        ...d,
        spec: {
          ...d.spec,
          edges: d.spec.edges.map((e) =>
            e.when && d.spec.fields.some((f) => f.key === e.when!.key && f.kind !== "json")
              ? { ...e, when: { ...e.when, path: "outcome" } }
              : e),
        },
      }),
      saves: false,
    },
    // ...and the REPAIR must leave a LEGAL row, or the fix would merely have moved the dead end.
    // keepPath is the rule BOTH mutation paths resolve through (repredicate in the pane,
    // recoercePredicate in the reducer), applied here the way they apply it.
    {
      name: "re-point a json row with a path at a text field",
      applies: (d) => d.spec.edges.some((e) => e.when) && d.spec.fields.some((f) => f.kind === "text" && d.spec.inputs.includes(f.key)),
      apply: (d) => {
        const key = d.spec.fields.find((f) => f.kind === "text" && d.spec.inputs.includes(f.key))!.key;
        const e0 = d.spec.edges.find((e) => e.when)!;
        const path = keepPath("outcome", "text");
        return {
          ...d,
          spec: {
            ...d.spec,
            edges: d.spec.edges.map((e) =>
              e === e0 ? { ...e, when: { op: "equals" as const, key, ...(path ? { path } : {}), value: "reject" } } : e),
          },
        };
      },
      saves: true,
    },
    {
      name: "a branch comparing a yes/no field with text",
      applies: (d) => d.spec.fields.some((f) => f.kind === "boolean"),
      apply: (d) => {
        const key = d.spec.fields.find((f) => f.kind === "boolean")!.key;
        const from = d.spec.edges.find((e) => e.when?.key === key)!.from;
        return draftReducer(d, {
          type: "set-branching", from,
          edges: d.spec.edges.filter((e) => e.from === from).map((e) =>
            e.when?.key === key ? { to: e.to, when: { op: "equals" as const, key, value: "yes please" } } : { to: e.to, ...(e.when ? { when: e.when } : {}) }),
        });
      },
      saves: false,
    },
  ];

  for (const preset of PRESETS) {
    for (const mutation of MUTATIONS) {
      const base = preset.build(`agree-${preset.id}`);
      if (mutation.applies && !mutation.applies(base)) continue;
      test(`${preset.id}: ${mutation.name}`, async () => {
        const draft = mutation.apply(base);
        // BLOCKING only, both sides (HOW-26). The verdict also carries advice now, and advice
        // is deliberately not a gate — so the property being pinned here is what it always
        // meant: the browser and this file refuse the SAME drafts.
        const problems = bySeverity(draftProblems(draft)).blocking;
        const saved = await saveBuilderGraph({ intent: "create",
          home: home(), repoRoot: ROOT, spec: draft.spec, prompts: pickPrompts(draft),
        });
        expect(saved.ok, `browser said ${problems.length} problem(s); server said ${saved.ok ? "ok" : saved.error}`)
          .toBe(problems.length === 0);
        expect(saved.ok, saved.ok ? "" : saved.error).toBe(mutation.saves);
        if (!saved.ok) {
          // the operator's words, and a sentence the browser had already shown them
          expect(problems.map((p) => p.message)).toContain(saved.error);
          expect(saved.error).not.toContain("no writer covers every path");
        }
      });
    }
  }

  /**
   * The review's reproduction, INVERTED. It used to leave `entry` on the Finish step — clean on
   * both sides, and a graph that ended every run before doing anything. It must now SAVE,
   * because the entry falls through to a step that can actually run. It is outside the matrix
   * because the right answer is preset-dependent: removing the doc preset's first agent takes
   * the writer of a field its later steps read, which is a legitimate refusal for other reasons.
   */
  test("moving Finish to the top and removing the start lands on a step that runs", async () => {
    const blank = PRESETS[0]!.build("runnable");
    const made = newStep(blank.spec, "command", "Extra");
    const after = ([
      { type: "add-step", ...made },
      { type: "set-branching", from: made.node.id, edges: [{ to: "done" }] },
      { type: "move-step", id: "done", by: -1 },
      { type: "move-step", id: "done", by: -1 },
      { type: "remove-step", id: "work" },
    ] as DraftAction[]).reduce(draftReducer, blank);

    expect(after.spec.nodes[0]!.kind).toBe("terminal");
    expect(after.spec.nodes.find((n) => n.id === after.spec.entry)!.kind).toBe("command");
    expect(draftProblems(after)).toEqual([]);
    const saved = await saveBuilderGraph({ intent: "create", home: home(), repoRoot: ROOT, spec: after.spec, prompts: pickPrompts(after) });
    expect(saved.ok, saved.ok ? "" : saved.error).toBe(true);
  });

  /**
   * The one fact the matrix above cannot reach: every row gets a fresh `home`, so no name is
   * ever taken. The ⟺ is asserted here over a shared home instead — the browser's list has to
   * carry the same sentence the save refuses with (HOW-22 review, finding 2).
   */
  test("a name already in the catalog: the browser says so, and the save refuses with that sentence", async () => {
    const h = home();
    const first = PRESETS[0]!.build("collides");
    expect((await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec: first.spec, prompts: pickPrompts(first) })).ok).toBe(true);
    const graphBytes = readFileSync(localGraphPath(h, "collides"), "utf8");

    const fresh = PRESETS[0]!.build("collides");
    const problems = draftProblems(fresh, { taken: ["collides"] });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]!.where).toBe("basics");

    const refused = await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec: fresh.spec, prompts: pickPrompts(fresh) });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("exists");
      expect(problems.map((x) => x.message)).toContain(refused.error);
    }
    expect(readFileSync(localGraphPath(h, "collides"), "utf8")).toBe(graphBytes);

    // an already-saved draft legitimately owns its own name, so the same draft as an UPDATE is clean
    expect(draftProblems({ ...fresh, saved: true }, { taken: ["collides"] })).toEqual([]);
    expect((await saveBuilderGraph({ intent: "update", home: h, repoRoot: ROOT, spec: fresh.spec, prompts: pickPrompts(fresh) })).ok).toBe(true);
  });

  test("an update of a graph that is not there is refused rather than creating one", async () => {
    const h = home();
    const d = PRESETS[0]!.build("never-made");
    const r = await saveBuilderGraph({ intent: "update", home: h, repoRoot: ROOT, spec: d.spec, prompts: pickPrompts(d) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("missing");
    expect(existsSync(localGraphPath(h, "never-made"))).toBe(false);
  });

  test("a removed step leaves nothing behind for a later save to trip over", async () => {
    // posted RAW — not through pickPrompts — so this fails if the reducer keeps the orphan,
    // which is the shape the review found: one removal blocked every save for the session
    const draft = PRESETS[0]!.build("orphan");
    const made = newStep(draft.spec, "agent", "Extra");
    const after = ([{ type: "add-step", ...made }, { type: "remove-step", id: made.node.id }] as DraftAction[])
      .reduce(draftReducer, draft);
    expect(Object.keys(after.prompts)).toEqual(promptIdsOf(after.spec));
    const saved = await saveBuilderGraph({ intent: "create", home: home(), repoRoot: ROOT, spec: after.spec, prompts: after.prompts });
    expect(saved.ok, saved.ok ? "" : saved.error).toBe(true);
  });

  test("the payload a save posts is derived from the spec, so an orphan body cannot reach it", () => {
    const draft = PRESETS[0]!.build("orphan");
    const withJunk: Draft = { ...draft, prompts: { ...draft.prompts, "orphan.ghost": "nobody names me" } };
    expect(Object.keys(pickPrompts(withJunk))).toEqual(promptIdsOf(withJunk.spec));
  });

  /**
   * HOW-26. The verdict now carries two severities, and only one of them is a gate. Advice
   * describes a graph that loads, `validate()`s and RUNS and is merely not what was probably
   * meant — refusing it here would be refusing a graph the launcher would happily accept, and
   * would make the builder's own opinion into a rule nobody agreed to.
   */
  test("a graph the builder advises against is still SAVED, and still loads", async () => {
    const h = home();
    const draft = PRESETS[0]!.build("advised");
    // the ticket's shape in miniature: the step's "Otherwise" goes back to itself, so whenever
    // the one condition does not match it runs again with nothing changed
    const spec: GraphSpec = {
      ...draft.spec,
      edges: [
        { from: "work", to: "done", when: { op: "is-not-empty", key: "summary" } },
        { from: "work", to: "work" },
      ],
    };
    const problems = specProblems(spec, { knownPrompts: Object.keys(draft.prompts) });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.filter(isBlocking)).toEqual([]);

    const saved = await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec, prompts: pickPrompts({ ...draft, spec }) });
    expect(saved.ok, saved.ok ? "" : saved.error).toBe(true);
    expect((await loadLocalGraph(h, "advised", ROOT)).def.name).toBe("advised");
  });

  test("a BLOCKING problem is still refused, and the browser named the same one first", async () => {
    const h = home();
    // the only step asks for `summary` in its own instructions and nothing writes it — a path
    // violation. It is expressed in the BODY rather than in `reads`, because `reads` is derived
    // from the body on both sides and a declaration the text contradicts would be repaired
    // rather than refused.
    const draft = draftReducer(PRESETS[0]!.build("refused"), {
      type: "set-prompt", id: "refused.work",
      body: "Do the work.\n\nGoal: {{ context.goal }}\n\nWhat happened so far: {{ context.summary }}",
    });
    const spec: GraphSpec = { ...draft.spec, nodes: draft.spec.nodes.map((n) => (n.id === "work" ? { ...n, writes: [] } : n)) };
    const blocking = bySeverity(specProblems(spec, { knownPrompts: Object.keys(draft.prompts) })).blocking;
    expect(blocking.length).toBeGreaterThan(0);

    const r = await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec, prompts: pickPrompts({ ...draft, spec }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(blocking.map((x) => x.message)).toContain(r.error);
    expect(existsSync(localGraphPath(h, "refused"))).toBe(false);
  });

  /** HOW-26: a preset is the worked example an operator edits, so it may not ship a single
   *  thing this module would say a word about — at EITHER severity. */
  test("every preset is exemplary: no problems and no advice", () => {
    for (const preset of PRESETS) {
      const d = preset.build("demo-graph");
      expect(specProblems(d.spec, { knownPrompts: Object.keys(d.prompts) }), preset.id).toEqual([]);
      expect(draftProblems(d), preset.id).toEqual([]);
    }
  });

  test("a preset saves and loads for real, every one of them", async () => {
    for (const preset of PRESETS) {
      const h = home();
      const d = preset.build(`p-${preset.id}`);
      const saved = await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec: d.spec, prompts: pickPrompts(d) });
      expect(saved.ok, saved.ok ? "" : `${preset.id}: ${saved.error}`).toBe(true);
      // loadLocalGraph is the launcher's own gate: it imports, validates and checks that every
      // agent step's prompt file exists. It throws rather than returning a verdict.
      const loaded = await loadLocalGraph(h, `p-${preset.id}`, ROOT);
      expect(loaded.def.name, preset.id).toBe(`p-${preset.id}`);
    }
  });
});

/**
 * HOW-60: the verifier gaps H2/H3/H6, on the save route. The browser's draftProblems and the
 * server's saveVerdict both hand specProblems the BODIES they are about to write, so an
 * include, a missing body and a choice row naming no choice are refused on both sides alike.
 */
describe("the bodies are checked on both sides, and both sides agree (HOW-60)", () => {
  const INCLUDE = "{{> review._verify_result }}";
  const withBody = (draft: Draft, id: string, body: string): Draft => draftReducer(draft, { type: "set-prompt", id, body });

  test("a body with an include is a refusal BEFORE any write — neither the graph nor its prompt exists", async () => {
    const h = home();
    const draft = withBody(PRESETS[0]!.build("includes"), "includes.work", `Do the work.\n\nGoal: {{ context.goal }}\n\n${INCLUDE}`);
    expect(draftProblems(draft).filter(isBlocking).map((p) => p.message)).toEqual([
      "**Do the work**'s instructions include `review._verify_result` with `{{> … }}`. A graph built here cannot include another prompt — paste the text it needs into the instructions instead.",
    ]);
    const r = await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec: draft.spec, prompts: pickPrompts(draft) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("include `review._verify_result` with `{{> … }}`");
    expect(existsSync(localGraphPath(h, "includes"))).toBe(false);
    expect(existsSync(join(localPromptsDir(h), "includes.work.md"))).toBe(false);
  });

  test("an include in a body already ON DISK blocks an update too — the server reads what the browser loaded", async () => {
    const h = home();
    const draft = PRESETS[0]!.build("on-disk");
    expect((await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec: draft.spec, prompts: pickPrompts(draft) })).ok).toBe(true);
    // hand-edited after the save
    const path = join(localPromptsDir(h), "on-disk.work.md");
    writeFileSync(path, readFileSync(path, "utf8").replace(/\n$/, `\n${INCLUDE}\n`));
    const r = await saveBuilderGraph({ intent: "update", home: h, repoRoot: ROOT, spec: draft.spec, prompts: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("cannot include another prompt");
  });

  /** one draft carrying all three: an include, a choice row naming no choice, a missing body */
  const brokenThreeWays = (): Draft => {
    const d = withBody(PRESETS.find((p) => p.id === "doc")!.build("three-ways"), "three-ways.draft",
      `Write the deliverable.\n\nGoal: {{ context.goal }}\n\nWork item: {{ context.work }}\n\n${INCLUDE}`);
    const prompts = { ...d.prompts };
    delete prompts["three-ways.revise"];
    return {
      ...d,
      prompts,
      spec: {
        ...d.spec,
        edges: d.spec.edges.map((e) => (e.from === "review" && e.to === "revise" ? { ...e, when: { op: "equals" as const, key: "review_verdict", value: "approved" } } : e)),
      },
    };
  };

  test("parity: the browser's blocking set IS the server's, and the save refuses with the first of it", async () => {
    const h = home();
    const draft = brokenThreeWays();
    const browser = draftProblems(draft).filter(isBlocking);
    const server = saveVerdict({ home: h, spec: draft.spec, prompts: pickPrompts(draft) }).problems;
    expect(server).toEqual(browser);
    // all three kinds, each attributed to its step
    expect(browser.map((p) => [p.node, p.where])).toEqual([
      ["draft", "steps"],
      ["revise", "steps"],
      ["review", "branching"],
    ]);
    expect(browser[0]!.message).toContain("cannot include another prompt");
    expect(browser[1]!.message).toContain("has no file yet");
    expect(browser[2]!.message).toContain("not one of its choices (`pass`, `reject`)");

    const r = await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec: draft.spec, prompts: pickPrompts(draft) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(browser[0]!.message);
    expect(existsSync(localGraphPath(h, "three-ways"))).toBe(false);
  });

  test("parity, clean side: every preset is empty on both sides, and saves", async () => {
    for (const preset of PRESETS) {
      const h = home();
      const d = preset.build(`clean-${preset.id}`);
      expect(draftProblems(d).filter(isBlocking), preset.id).toEqual([]);
      expect(saveVerdict({ home: h, spec: d.spec, prompts: pickPrompts(d) }).problems, preset.id).toEqual([]);
      const r = await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec: d.spec, prompts: pickPrompts(d) });
      expect(r.ok, r.ok ? preset.id : `${preset.id}: ${r.error}`).toBe(true);
    }
  });

  test("a requiresAcceptance step keeps `acceptance` though its body never names it (HOW-74)", () => {
    const d = PRESETS.find((p) => p.id === "doc")!.build("gated");
    const spec: GraphSpec = {
      ...d.spec,
      fields: [...d.spec.fields, { key: "acceptance", kind: "json", scope: "sticky" }],
      inputs: [...d.spec.inputs, "acceptance"],
      nodes: d.spec.nodes.map((n) => (n.kind === "agent" && n.id === "draft" ? { ...n, requiresAcceptance: true as const, reads: [] } : n)),
    };
    const prompts = pickPrompts(d);
    const draftStep = spec.nodes.find((n) => n.id === "draft") as Extract<NodeSpec, { kind: "agent" }>;
    expect(templateReads(prompts[draftStep.prompt]!)).not.toContain("acceptance");
    const v = saveVerdict({ home: home(), spec, prompts });
    expect(v.problems).toEqual([]);
    expect((v.spec.nodes.find((n) => n.id === "draft") as Extract<NodeSpec, { kind: "agent" }>).reads).toContain("acceptance");
  });

  test("a shadowed row is ADVICE: the browser notes it and the save still goes through", async () => {
    const h = home();
    const d = PRESETS.find((p) => p.id === "doc")!.build("shadowed");
    const spec: GraphSpec = {
      ...d.spec,
      edges: [
        { from: "draft", to: "review" },
        { from: "review", to: "done", when: { op: "is-not-empty", key: "review_verdict" } },
        { from: "review", to: "revise", when: { op: "equals", key: "review_verdict", value: "reject" } },
        { from: "revise", to: "review" },
      ],
    };
    const draft: Draft = { ...d, spec };
    const problems = draftProblems(draft);
    expect(problems.filter(isBlocking)).toEqual([]);
    expect(problems.some((p) => !isBlocking(p) && p.node === "review" && p.message.includes("never fires"))).toBe(true);
    const r = await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec, prompts: pickPrompts(draft) });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
  });
});

/**
 * HOW-60: the built-in graphs, with their REAL bodies. They are hand-written, so they may use
 * includes (expanded when a run pins its prompts), file their prompts under shared ids, and
 * declare reads an include supplies — none of which a builder graph may do, and none of which
 * this ticket may edit. So the test proves what is provable: H3 and H6 say nothing about any
 * built-in, no step is missing a body and no body is orphaned, and every problem that DOES
 * appear is one of three named, known categories — so a new kind of problem still fails here.
 */
describe("the built-ins, checked with their real bodies (HOW-60)", () => {
  const KNOWN = [/which belongs to another graph/, /cannot include another prompt/, /does not match its instructions/];
  const specs = Object.values(GRAPHS).map((g) => specOf(g)).filter((s): s is GraphSpec => s !== null);

  test("there are built-in specs to check", () => {
    expect(specs.length).toBeGreaterThanOrEqual(6);
  });

  for (const spec of specs)
    test(`${spec.name}: no new kind of problem`, () => {
      const bodies: Record<string, string> = {};
      for (const id of promptIdsOf(spec)) {
        const path = join(ROOT, "prompts", `${id}.md`);
        expect(existsSync(path), id).toBe(true);
        bodies[id] = splitFrontMatter(readFileSync(path, "utf8")).body;
      }
      const problems = specProblems(spec, { bodies });
      expect(problems.filter((p) => p.message.includes("not one of its choices"))).toEqual([]);
      expect(problems.filter((p) => /has no file yet|no step uses them/.test(p.message))).toEqual([]);
      expect(specAdvice(spec).filter((p) => p.message.includes("never fires"))).toEqual([]);
      const unknown = problems.filter(isBlocking).filter((p) => !KNOWN.some((re) => re.test(p.message)));
      expect(unknown.map((p) => p.message)).toEqual([]);
    });
});

/**
 * HOW-63: a drafted step may name its instructions as `{ copyOf: <prompt id> }`, and save writes
 * that out as an ordinary `<graph>.<step>` prompt. The promise is that the saved text IS what a
 * run would pin for the original — so the expected value below is taken from a real Engine's
 * pin, never from prompts/pin.ts itself, which would only prove the function agrees with itself.
 */
describe("copyOf bodies are written out as the text a run pins (HOW-63)", () => {
  const WITH_INCLUDE = "implementation.implement";
  const WITHOUT_INCLUDE = "implementation.plan";

  /** what a run started over the same search path pins for each id, read from its run dir */
  async function pinnedByEngine(h: string, ids: PromptId[]): Promise<Record<string, string>> {
    const dir = mkdtempSync(join(tmpdir(), "howdah-pin-"));
    // the agent steps are never reached: pinning covers every agent node at start, and the
    // entry command fails, so the run parks before any of them renders
    const nodes: Record<string, NodeDef<any>> = { gate: { kind: "command", run: "true", reads: [] }, done: { kind: "terminal", outcome: "success" } };
    ids.forEach((id, i) => { nodes[`a${i}`] = { kind: "agent", prompt: id, reads: [], writes: {} }; });
    const chain = ["gate", ...ids.map((_, i) => `a${i}`), "done"];
    const edges = chain.slice(1).map((to, i) => ({ from: chain[i]!, to }));
    const engine = new Engine(defineGraph<any>({ name: "pin-probe", entry: "gate", inputs: [], nodes, edges }), {
      dir, promptsDir: promptSearchPath(h, ROOT),
      executors: { command: async () => ({ status: "failed", reason: "pin probe stops here", writes: {} }) },
    });
    await engine.start({});
    return Object.fromEntries(ids.map((id) => [id, readFileSync(join(dir, "prompts", `${id}.md`), "utf8")]));
  }

  /** a two-step graph whose fields are exactly what the copied texts read */
  function copySpec(name: string, texts: string[], extra: Partial<GraphSpec> = {}): GraphSpec {
    const keys = [...new Set(texts.flatMap((t) => templateReads(t)))];
    return {
      version: 1, name, description: "",
      fields: keys.map((key) => ({ key, kind: "text", scope: "sticky" })),
      inputs: keys,
      entry: "first",
      nodes: [
        { id: "first", kind: "agent", prompt: `${name}.first`, reads: [], writes: [] },
        { id: "second", kind: "agent", prompt: `${name}.second`, reads: [], writes: [] },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
      edges: [{ from: "first", to: "second" }, { from: "second", to: "done" }],
      ...extra,
    };
  }

  const bodyOfFile = (raw: string) => splitFrontMatter(raw).body;
  const savedRaw = (h: string, id: string) => readFileSync(join(localPromptsDir(h), `${id}.md`), "utf8");

  test("the base prompts are what this test claims: one includes, one does not", () => {
    expect(readFileSync(join(ROOT, "prompts", `${WITH_INCLUDE}.md`), "utf8")).toContain("{{>");
    expect(readFileSync(join(ROOT, "prompts", `${WITHOUT_INCLUDE}.md`), "utf8")).not.toContain("{{>");
  });

  test("a saved copy byte-equals the pinned base body — with an include and without", async () => {
    const h = home();
    const pinned = await pinnedByEngine(h, [WITH_INCLUDE, WITHOUT_INCLUDE]);
    const spec = copySpec("copied", [bodyOfFile(pinned[WITH_INCLUDE]!), bodyOfFile(pinned[WITHOUT_INCLUDE]!)]);
    const r = await saveBuilderGraph({
      intent: "create", home: h, repoRoot: ROOT, spec,
      prompts: { "copied.first": { copyOf: WITH_INCLUDE }, "copied.second": { copyOf: WITHOUT_INCLUDE } },
    });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);

    for (const [id, base] of [["copied.first", WITH_INCLUDE], ["copied.second", WITHOUT_INCLUDE]] as const) {
      const saved = savedRaw(h, id);
      // exact, not trimmed: a normalisation in promptFile that changed the text must fail here
      expect(bodyOfFile(saved)).toBe(bodyOfFile(pinned[base]!));
      expect(saved).not.toContain("{{>");
      expect(frontMatterField(splitFrontMatter(saved).frontmatter, "id")).toBe(id);
    }
    // the include really was expanded, not merely absent
    expect(bodyOfFile(pinned[WITH_INCLUDE]!)).not.toBe(bodyOfFile(readFileSync(join(ROOT, "prompts", `${WITH_INCLUDE}.md`), "utf8")));

    // reads are derived from the COPIED text, as for any other body
    if (!r.ok) return;
    const saved = specOf(r.graph)!;
    const reads = (id: string) => (saved.nodes.find((n) => n.id === id) as Extract<NodeSpec, { kind: "agent" }>).reads;
    expect(reads("first")).toEqual(templateReads(bodyOfFile(pinned[WITH_INCLUDE]!)));
    expect(reads("second")).toEqual(templateReads(bodyOfFile(pinned[WITHOUT_INCLUDE]!)));
  });

  test("a copy of a LOCAL prompt resolves local-first, as a run's search path does", async () => {
    const h = home();
    ensureLocalDirs(h);
    writeFileSync(join(localPromptsDir(h), "mine.base.md"), "---\nid: mine.base\nversion: 3\n---\nLocal text for {{ context.goal }}.\n");
    const pinned = await pinnedByEngine(h, ["mine.base" as PromptId]);
    const spec: GraphSpec = { ...copySpec("local-copy", ["{{ context.goal }}"]), nodes: [
      { id: "first", kind: "agent", prompt: "local-copy.first", reads: [], writes: [] },
      { id: "done", kind: "terminal", outcome: "success" },
    ], edges: [{ from: "first", to: "done" }] };
    const r = await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec, prompts: { "local-copy.first": { copyOf: "mine.base" } } });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(bodyOfFile(savedRaw(h, "local-copy.first"))).toBe(bodyOfFile(pinned["mine.base"]!));
    // this graph's own version, not the copied file's
    expect(frontMatterField(splitFrontMatter(savedRaw(h, "local-copy.first")).frontmatter, "version")).toBe("1");
  });

  for (const copyOf of ["no.such_prompt", "../../etc/passwd", "Implementation.Implement"])
    test(`an unknown copyOf (${copyOf}) is refused in the operator's words and writes nothing, on create`, async () => {
      const h = home();
      const spec = copySpec("unknown-copy", ["{{ context.goal }}"]);
      const r = await saveBuilderGraph({
        intent: "create", home: h, repoRoot: ROOT, spec,
        prompts: { "unknown-copy.first": "Do {{ context.goal }}", "unknown-copy.second": { copyOf } },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe(unknownCopyProblem("unknown-copy.second", copyOf).message);
        expect(r.code).toBeUndefined(); // → 422 at the route
      }
      for (const d of [join(h, "graphs"), localPromptsDir(h)]) expect(existsSync(d) ? readdirSync(d) : []).toEqual([]);
    });

  test("an unknown copyOf on UPDATE leaves the existing graph and its prompts byte-identical", async () => {
    const h = home();
    const spec = copySpec("kept", ["{{ context.goal }}"]);
    const first = { "kept.first": "One {{ context.goal }}", "kept.second": "Two {{ context.goal }}" };
    expect((await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec, prompts: first })).ok).toBe(true);
    const snapshot = () => Object.fromEntries(
      [localGraphPath(h, "kept"), ...readdirSync(localPromptsDir(h)).map((f) => join(localPromptsDir(h), f))].map((p) => [p, readFileSync(p, "utf8")]),
    );
    const before = snapshot();
    const r = await saveBuilderGraph({
      intent: "update", home: h, repoRoot: ROOT, spec,
      prompts: { "kept.first": "REWRITTEN {{ context.goal }}", "kept.second": { copyOf: "nope" } },
    });
    expect(r.ok).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  test("a copy whose include cannot be expanded is refused before any write", async () => {
    const h = home();
    ensureLocalDirs(h);
    writeFileSync(join(localPromptsDir(h), "broken.base.md"), "---\nid: broken.base\nversion: 1\n---\nUses {{> missing._partial }}\n");
    const spec = copySpec("broken-copy", ["{{ context.goal }}"]);
    const r = await saveBuilderGraph({
      intent: "create", home: h, repoRoot: ROOT, spec,
      prompts: { "broken-copy.first": "x {{ context.goal }}", "broken-copy.second": { copyOf: "broken.base" } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('cannot include "missing._partial"');
    expect(existsSync(localGraphPath(h, "broken-copy"))).toBe(false);
    expect(readdirSync(localPromptsDir(h))).toEqual(["broken.base.md"]);
  });

  test("`drafted` survives save → loadLocalGraph → spec, alongside a copied body", async () => {
    const h = home();
    const drafted = { run: "draft-graph-abc123", draftHash: "c53:00000000000001" };
    const pinned = await pinnedByEngine(h, [WITHOUT_INCLUDE]);
    const spec = copySpec("drafted-one", [bodyOfFile(pinned[WITHOUT_INCLUDE]!), "{{ context.goal }}"], { drafted });
    const r = await saveBuilderGraph({
      intent: "create", home: h, repoRoot: ROOT, spec,
      prompts: { "drafted-one.first": { copyOf: WITHOUT_INCLUDE }, "drafted-one.second": "Then {{ context.goal }}" },
    });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(readFileSync(localGraphPath(h, "drafted-one"), "utf8")).toContain(`"draftHash": "${drafted.draftHash}"`);
    const loaded = await loadLocalGraph(h, "drafted-one", ROOT);
    expect(specOf(loaded)?.drafted).toEqual(drafted);
  });

  test("a copy keyed under another graph's id is still refused — the copied-FROM id is only read", async () => {
    const h = home();
    const victim = copySpec("victim", ["{{ context.goal }}"]);
    expect((await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec: victim, prompts: { "victim.first": "V1 {{ context.goal }}", "victim.second": "V2 {{ context.goal }}" } })).ok).toBe(true);
    const before = savedRaw(h, "victim.first");

    const attacker: GraphSpec = { ...copySpec("attacker", ["{{ context.goal }}"]), nodes: [
      { id: "first", kind: "agent", prompt: "victim.first", reads: [], writes: [] },
      { id: "done", kind: "terminal", outcome: "success" },
    ], edges: [{ from: "first", to: "done" }] };
    const r = await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec: attacker, prompts: { "victim.first": { copyOf: WITHOUT_INCLUDE } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("another graph's prompt");
    expect(savedRaw(h, "victim.first")).toBe(before);
    expect(existsSync(localGraphPath(h, "attacker"))).toBe(false);

    // and a key that IS a repo prompt is still the shadowing refusal, copy or not
    const shadow: GraphSpec = { ...attacker, name: "shadow", nodes: [
      { id: "first", kind: "agent", prompt: WITHOUT_INCLUDE, reads: [], writes: [] },
      { id: "done", kind: "terminal", outcome: "success" },
    ] };
    const s = await saveBuilderGraph({ intent: "create", home: h, repoRoot: ROOT, spec: shadow, prompts: { [WITHOUT_INCLUDE]: { copyOf: WITHOUT_INCLUDE } } });
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.error).toContain("shadow");
    expect(existsSync(join(localPromptsDir(h), `${WITHOUT_INCLUDE}.md`))).toBe(false);
  });
});
