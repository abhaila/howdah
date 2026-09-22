/**
 * Saving a built graph (HOW-22). The promise being pinned is the one graphs/local.ts already
 * makes — what is on disk is always runnable — extended over the PROMPT files a builder save
 * also writes, plus the round trip the builder depends on to re-open its own work.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptIdFor, promptIdsOf, readLocalPrompt, renderSpecModule, saveBuilderGraph } from "./builder";
import { loadLocalGraph, localGraphPath, localPromptsDir, ensureLocalDirs } from "./local";
import { COMMAND_BUILTINS, WORKTREE_FACTS, type GraphSpec, type NodeSpec } from "../core/graph-spec";
// the reducer is plain data over core/ — no React, no DOM — so the browser's verdict can be
// driven from here and compared against this file's gate, which is the whole point below
import { PRESETS, draftProblems, draftReducer, newStep, pickPrompts, type Draft, type DraftAction } from "../web/app/lib/spec-draft";

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
    nodes: [
      { id: "make-worktree", kind: "worktree", title: "Make a worktree", action: "create", writes: [] },
      { id: "plan-it", kind: "agent", title: "Plan the change", prompt: p("plan-it"), reads: ["goal", "work"], writes: ["plan", "plan_base"], readOnly: true, class: "planning" },
      { id: "approve", kind: "approval", title: "Get my approval", proposal: "plan", base: "plan_base", decision: "plan_decision", feedback: "plan_feedback", redesignTo: "plan-it" },
      { id: "build", kind: "agent", title: "Build it", prompt: p("build"), reads: ["goal", "plan"], writes: ["summary", "review_verdict"], maxVisits: 3, requires: "approve", config: { harness: "codex", effort: "high" } },
      { id: "settle", kind: "wait", title: "Let CI settle", duration: "30 s" },
      { id: "check-pr", kind: "command", title: "Check the PR", run: "probe:pr", reads: [], writes: ["pr.state"], timeoutMs: 60000 },
      { id: "clean-up", kind: "worktree", title: "Clean up", action: "remove", writes: ["worktree.clean"] },
      { id: "done", kind: "terminal", outcome: "success", label: "shipped" },
      { id: "stuck", kind: "terminal", outcome: "failed" },
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
    const saved = await saveBuilderGraph({ home: h, repoRoot: ROOT, spec, prompts: bodies(spec) });
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
    await saveBuilderGraph({ home: h, repoRoot: ROOT, spec, prompts: bodies(spec) });
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
    await saveBuilderGraph({ home: h, repoRoot: ROOT, spec: lying, prompts: bodies(spec) });
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
    expect((await saveBuilderGraph({ home: h, repoRoot: ROOT, spec, prompts: first })).ok).toBe(true);

    const graphBytes = readFileSync(localGraphPath(h, "guarded"), "utf8");
    const promptBytes = Object.fromEntries(
      Object.keys(first).map((id) => [id, readFileSync(join(localPromptsDir(h), `${id}.md`), "utf8")]),
    );

    // a dangling redesignTo: valid JSON, refused by validate()
    const broken: GraphSpec = {
      ...spec,
      nodes: spec.nodes.map((n) => (n.kind === "approval" ? { ...n, redesignTo: "no-such-step" } : n)),
    };
    const refused = await saveBuilderGraph({
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
    expect((await saveBuilderGraph({ home: h, repoRoot: ROOT, spec: broken, prompts: bodies(spec) })).ok).toBe(false);
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
    const r = await saveBuilderGraph({ home: h, repoRoot: ROOT, spec, prompts: { "tiny.work": "x", "somebody.else": "y" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no step names the prompt");
  });

  test("a prompt that would shadow one of Howdah's own is refused by name", async () => {
    const h = home();
    const spec = tiny("shadowy", "delivery.publish");
    const r = await saveBuilderGraph({ home: h, repoRoot: ROOT, spec, prompts: { "delivery.publish": "hijacked" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("shadow");
    expect(existsSync(join(localPromptsDir(h), "delivery.publish.md"))).toBe(false);
  });

  test("an existing prompt file keeps its version rather than being renumbered", async () => {
    const h = home();
    ensureLocalDirs(h);
    writeFileSync(join(localPromptsDir(h), "versioned.work.md"), "---\nid: versioned.work\nversion: 7\n---\nold body\n");
    const spec = tiny("versioned", "versioned.work");
    expect((await saveBuilderGraph({ home: h, repoRoot: ROOT, spec, prompts: { "versioned.work": "new body {{ context.goal }}" } })).ok).toBe(true);
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
    await saveBuilderGraph({ home: h, repoRoot: ROOT, spec, prompts: bodies(spec) });
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
    expect((await saveBuilderGraph({ home: h, repoRoot: ROOT, spec, prompts: bodies(spec) })).ok).toBe(true);

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
      const refused = await saveBuilderGraph({ home: h, repoRoot: ROOT, spec: grown, prompts: rewritten });
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
  const MUTATIONS: Array<{ name: string; apply: (d: Draft) => Draft; saves: boolean; applies?: (d: Draft) => boolean }> = [
    { name: "untouched", apply: (d) => d, saves: true },
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
  ];

  for (const preset of PRESETS) {
    for (const mutation of MUTATIONS) {
      const base = preset.build(`agree-${preset.id}`);
      if (mutation.applies && !mutation.applies(base)) continue;
      test(`${preset.id}: ${mutation.name}`, async () => {
        const draft = mutation.apply(base);
        const problems = draftProblems(draft);
        const saved = await saveBuilderGraph({
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

  test("a removed step leaves nothing behind for a later save to trip over", async () => {
    // posted RAW — not through pickPrompts — so this fails if the reducer keeps the orphan,
    // which is the shape the review found: one removal blocked every save for the session
    const draft = PRESETS[0]!.build("orphan");
    const made = newStep(draft.spec, "agent", "Extra");
    const after = ([{ type: "add-step", ...made }, { type: "remove-step", id: made.node.id }] as DraftAction[])
      .reduce(draftReducer, draft);
    expect(Object.keys(after.prompts)).toEqual(promptIdsOf(after.spec));
    const saved = await saveBuilderGraph({ home: home(), repoRoot: ROOT, spec: after.spec, prompts: after.prompts });
    expect(saved.ok, saved.ok ? "" : saved.error).toBe(true);
  });

  test("the payload a save posts is derived from the spec, so an orphan body cannot reach it", () => {
    const draft = PRESETS[0]!.build("orphan");
    const withJunk: Draft = { ...draft, prompts: { ...draft.prompts, "orphan.ghost": "nobody names me" } };
    expect(Object.keys(pickPrompts(withJunk))).toEqual(promptIdsOf(withJunk.spec));
  });
});
