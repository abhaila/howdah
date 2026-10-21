/**
 * HOW-65: the draft's diff against its base — what the card and the review page both draw.
 */
import { describe, expect, test } from "bun:test";
import { diffDraft, lineDiff } from "./draft-diff";
import { draftRuleProblems, type GraphSpec, type NodeSpec } from "./graph-spec";
import { CATALOG_TEXTS, LOOK_ONLY, cleanDraft } from "./fixtures/graph-draft";
import { spec as quickTask } from "../graphs/quick-task";

const BASE: GraphSpec = {
  version: 1, name: "flow", description: "a flow", entry: "draft", inputs: ["goal"],
  fields: [
    { key: "goal", kind: "text", scope: "sticky" },
    { key: "doc", kind: "text", scope: "sticky" },
    { key: "verdict", kind: "text", scope: "sticky" },
  ],
  nodes: [
    { id: "draft", kind: "agent", prompt: "flow.draft", reads: ["goal"], writes: ["doc"] },
    { id: "review", kind: "agent", prompt: "flow.review", reads: ["doc"], writes: ["verdict"], readOnly: true },
    { id: "publish", kind: "command", run: "probe:pr", reads: [], writes: [] },
    { id: "done", kind: "terminal", outcome: "success" },
  ],
  edges: [
    { from: "draft", to: "review" },
    { from: "review", to: "publish" },
    { from: "publish", to: "done" },
  ],
};
const BASE_TEXTS = { "flow.draft": "Draft {{ context.goal }}.\n", "flow.review": "Review {{ context.doc }}.\n" };
const clone = (g: GraphSpec): GraphSpec => JSON.parse(JSON.stringify(g)) as GraphSpec;
const diff = (spec: GraphSpec, texts: Record<string, string>, bodies: Record<string, unknown> = texts, base: GraphSpec | null = BASE) =>
  diffDraft({ spec, bodies: bodies as never, texts, base, baseTexts: BASE_TEXTS });

describe("lineDiff", () => {
  test("equal, inserted, deleted, and mixed", () => {
    expect(lineDiff("a\nb\n", "a\nb\n")).toEqual([{ op: "eq", text: "a" }, { op: "eq", text: "b" }]);
    expect(lineDiff("", "a\nb")).toEqual([{ op: "ins", text: "a" }, { op: "ins", text: "b" }]);
    expect(lineDiff("a\nb", "")).toEqual([{ op: "del", text: "a" }, { op: "del", text: "b" }]);
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { op: "eq", text: "a" }, { op: "del", text: "b" }, { op: "ins", text: "x" }, { op: "eq", text: "c" },
    ]);
  });

  test("deterministic, and a huge body degrades to whole-delete + whole-insert rather than stalling", () => {
    expect(lineDiff("p\nq\nr", "q\nr\ns")).toEqual(lineDiff("p\nq\nr", "q\nr\ns"));
    const big = Array.from({ length: 2500 }, (_, i) => `l${i}`).join("\n");
    const other = Array.from({ length: 2500 }, (_, i) => `m${i}`).join("\n");
    const out = lineDiff(big, other);
    expect(out.filter((l) => l.op === "del")).toHaveLength(2500);
    expect(out.filter((l) => l.op === "ins")).toHaveLength(2500);
  });
});

describe("diffDraft", () => {
  test("with no base, every step is added and nothing is removed", () => {
    const d = diff(clone(BASE), BASE_TEXTS, BASE_TEXTS, null);
    expect(d.base).toBeNull();
    expect(d.added.map((r) => r.id)).toEqual(["draft", "review", "publish", "done"]);
    expect([d.removed, d.changed, d.unchanged, d.graph]).toEqual([[], [], [], []]);
    expect(d.added[0]!.body).toMatchObject({ added: 1, removed: 0 });
  });

  test("an identical draft is all unchanged", () => {
    const d = diff(clone(BASE), BASE_TEXTS);
    expect(d.unchanged.map((r) => r.id)).toEqual(["draft", "review", "publish", "done"]);
    expect([d.added, d.removed, d.changed]).toEqual([[], [], []]);
    expect(d.grantsNewWrite).toBe(false);
  });

  test("a removal names every route it drops, and the steps around it say what changed", () => {
    const spec = clone(BASE);
    spec.nodes = spec.nodes.filter((n) => n.id !== "review");
    spec.edges = [{ from: "draft", to: "publish" }, { from: "publish", to: "done" }];
    const d = diff(spec, { "flow.draft": BASE_TEXTS["flow.draft"] });
    expect(d.removed.map((r) => [r.id, r.cascades])).toEqual([["review", [
      "removing review also drops the route draft → review",
      "removing review also drops the route review → publish",
    ]]]);
    expect(d.removed[0]!.body).toMatchObject({ removed: 1, added: 0 });
    expect(d.changed.map((r) => [r.id, r.cascades])).toEqual([["draft", ["new route draft → publish", "drops the route draft → review"]]]);
    expect(d.graph).toEqual([]);
  });

  test("an added step names its routes; a changed body is a line diff; new reads are named", () => {
    const spec = clone(BASE);
    spec.fields.push({ key: "notes", kind: "text", scope: "sticky" });
    spec.nodes.splice(2, 0, { id: "fix", kind: "agent", prompt: "flow.fix", reads: ["verdict"], writes: ["notes"] });
    const draftNode = spec.nodes[0] as Extract<NodeSpec, { kind: "agent" }>;
    draftNode.reads = ["goal", "notes"];
    spec.edges = [
      { from: "draft", to: "review" },
      { from: "review", to: "fix" },
      { from: "fix", to: "publish" },
      { from: "publish", to: "done" },
    ];
    const texts = { ...BASE_TEXTS, "flow.draft": "Draft {{ context.goal }}.\nMind {{ context.notes }}.\n", "flow.fix": "Fix it.\n" };
    const d = diff(spec, texts);
    expect(d.added.map((r) => [r.id, r.cascades])).toEqual([["fix", ["adds the route review → fix", "adds the route fix → publish"]]]);
    const draft = d.changed.find((r) => r.id === "draft")!;
    expect(draft.changes).toEqual(["instructions"]);
    expect(draft.cascades).toEqual(["draft now reads `context.notes`"]);
    expect(draft.body!.lines).toEqual([{ op: "eq", text: "Draft {{ context.goal }}." }, { op: "ins", text: "Mind {{ context.notes }}." }]);
    expect(d.changed.find((r) => r.id === "review")!.cascades).toEqual(["new route review → fix", "drops the route review → publish"]);
    expect(d.graph).toEqual(["new fields `notes`"]);
  });

  test("a property change is named in words", () => {
    const spec = clone(BASE);
    spec.nodes = spec.nodes.map((n) => (n.id === "review" && n.kind === "agent" ? { ...n, readOnly: undefined, title: "Look" } : n.id === "publish" && n.kind === "command" ? { ...n, run: "verify:run" } : n));
    const d = diff(spec, BASE_TEXTS);
    expect(d.changed.map((r) => [r.id, r.changes])).toEqual([
      ["review", ['renamed from "review"', "no longer read-only — it can change files"]],
      ["publish", ["runs `verify:run` (was `probe:pr`)"]],
    ]);
  });

  test("a copy equal to the base step's text reads 'unchanged from <id>'; a different copy shows its diff", () => {
    const spec = clone(BASE);
    const copied = diff(spec, BASE_TEXTS, { ...BASE_TEXTS, "flow.review": { copyOf: "other.review" } });
    expect(copied.unchanged.find((r) => r.id === "review")!.body).toEqual({ unchangedFrom: "other.review", lines: [], added: 0, removed: 0 });
    const differs = diff(spec, { ...BASE_TEXTS, "flow.review": "Something else.\n" }, { ...BASE_TEXTS, "flow.review": { copyOf: "x.y" } });
    expect(differs.changed.find((r) => r.id === "review")!.body).toMatchObject({ copyOf: "x.y", added: 1, removed: 1 });
  });

  test("grantsNewWrite: false for read-only additions, true for a new writer, true for a step that lost readOnly", () => {
    const ro = clone(BASE);
    ro.nodes.splice(1, 0, { id: "look", kind: "agent", prompt: "flow.look", reads: [], writes: [], readOnly: true });
    expect(diff(ro, { ...BASE_TEXTS, "flow.look": "Look.\n" }).grantsNewWrite).toBe(false);

    const writer = clone(BASE);
    writer.nodes.splice(1, 0, { id: "poke", kind: "agent", prompt: "flow.poke", reads: [], writes: [] });
    const w = diff(writer, { ...BASE_TEXTS, "flow.poke": "Poke.\n" });
    expect(w.grantsNewWrite).toBe(true);
    expect(w.permission).toEqual([
      { id: "draft", title: "draft", isNew: false, lostReadOnly: false },
      { id: "poke", title: "poke", isNew: true, lostReadOnly: false },
    ]);

    const loosened = clone(BASE);
    loosened.nodes = loosened.nodes.map((n) => (n.id === "review" && n.kind === "agent" ? { ...n, readOnly: undefined } : n));
    const l = diff(loosened, BASE_TEXTS);
    expect(l.grantsNewWrite).toBe(true);
    expect(l.permission.find((p) => p.id === "review")).toEqual({ id: "review", title: "review", isNew: true, lostReadOnly: true });
  });

  test("grantsNewWrite covers every permission advice draftRuleProblems gives (the fixture draft)", () => {
    const d = cleanDraft();
    const texts = { "quick-review.work": CATALOG_TEXTS["quick-task.work"]!, "quick-review.review": d.prompts["quick-review.review"] as string };
    const out = diffDraft({ spec: d.spec, bodies: d.prompts, texts, base: quickTask, baseTexts: CATALOG_TEXTS });
    const advised = draftRuleProblems(d.spec, quickTask, { bodies: d.prompts }).filter((p) => p.kind === "permission").map((p) => p.node);
    expect(advised.length).toBeGreaterThan(0);
    for (const id of advised) expect(out.permission.find((p) => p.id === id)?.isNew).toBe(true);
    expect(out.grantsNewWrite).toBe(true);
    // the copy reads as unchanged from the prompt it copies, even as an added step
    expect(out.added.find((r) => r.id === "quick-review.work")!.body).toEqual({ unchangedFrom: "quick-task.work", lines: [], added: 0, removed: 0 });
    expect(out.removed.map((r) => r.id)).toEqual(["quick-task.work"]);
    expect(diffDraft({ spec: LOOK_ONLY, bodies: {}, texts: CATALOG_TEXTS, base: LOOK_ONLY, baseTexts: CATALOG_TEXTS }).grantsNewWrite).toBe(false);
  });
});
