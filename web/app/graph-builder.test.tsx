/**
 * The graph builder, pinned at the two layers that carry the ticket (HOW-22, then HOW-24).
 *
 * THE DRAFT (no DOM). The reducer's job is the edits that are COUPLED, and coupled quietly:
 * removing a step has to take the edges that named it AND the instructions it owned, removing
 * a field has to take the branch rows that tested it, renaming a field has to follow the key
 * into the prompt bodies that reference it and re-type the operands that compare against it,
 * and renaming the graph before its first save has to move every agent step's prompt id AND
 * the body filed under it. Each of those, missed, leaves a draft that looks fine here and is
 * refused at save — which is what the HOW-22 review found, four times over. The whole-draft
 * form of that property (browser verdict ⟺ server gate) lives in graphs/builder.test.ts,
 * where the real save can be run; what is pinned here is each coupled edit on its own.
 *
 * HOW-24 replaced the wizard with a canvas and touched NONE of that on purpose, so this half
 * of the file is unchanged but for the three actions the canvas added — which are held to the
 * same rules: a drawn route is born able to fire, and row order is still priority.
 *
 * THE BUILDER (DOM). What the ticket asked for is only true if five things hold, so all five
 * are asserted rather than trusted: a step is added where you put it and without a mouse; a
 * route drawn between two steps can actually fire; selecting something opens it BESIDE the
 * canvas rather than over it; the arrangement is part of what gets saved; and the verdict is
 * still live, still attributed to the step that owns it, and still the same PUT at the end.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  SPEC_FIELD_KEY, SPEC_NODE_ID, buildGraph, predicateLabel, specProblems,
  type FieldKind, type FieldSpec, type GraphSpec, type NodeSpec,
} from "../../core/graph-spec";
import { templateReads } from "../../core/template-refs";
import {
  PRESETS, bySeverity, canRenameStep, draftProblems, draftReducer, fieldRemoval, newStep, nextNodeId, pickPrompts,
  removalHasCost,
  problemsByPane,
  type Draft, type DraftAction,
} from "./lib/spec-draft";
import { GraphBuilder } from "./screens/graph-builder";
import { STEP_KIND_MIME, applyNodeChangesToDraft, specToFlow } from "./builder/canvas";
import { StepFields, choiceSentence, sayChoices } from "./builder/step-form";
import { StepRoutes } from "./builder/branching";
import { ProblemText } from "./builder/problem";
import { FieldsPane } from "./builder/fields";
import { freeSpotNear } from "./lib/layout";
import { ToastProvider } from "./components/ui/toast";
import { Input } from "./components/ui/input";
import { useTypedText } from "./lib/hooks";

// ---- the draft ---------------------------------------------------------------------------

const apply = (draft: Draft, ...actions: DraftAction[]): Draft => actions.reduce(draftReducer, draft);
const doc = () => PRESETS.find((p) => p.id === "doc")!.build("my-review");

/** Can this step be reached again FROM itself? — i.e. is a revisit part of the shape. */
function onALoop(spec: GraphSpec, id: string): boolean {
  const seen = new Set<string>();
  const queue = spec.edges.filter((e) => e.from === id).map((e) => e.to);
  while (queue.length) {
    const at = queue.shift()!;
    if (at === id) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const e of spec.edges) if (e.from === at) queue.push(e.to);
  }
  return false;
}

describe("the draft keeps itself consistent, because the edits are coupled", () => {
  test("every preset is a graph that would actually run", () => {
    for (const preset of PRESETS) {
      const draft = preset.build("my-review");
      expect(draftProblems(draft), preset.id).toEqual([]);
      // and the real gate agrees, not just our re-wording of it
      expect(buildGraph(draft.spec).validate(), preset.id).toEqual({ structural: [], paths: [] });
      // what each agent step is GIVEN is read out of the body it ships with. A preset that
      // declared its own list could drift from its instructions, which is the exact class of
      // mistake this builder exists to make impossible.
      for (const n of draft.spec.nodes)
        if (n.kind === "agent") expect(n.reads, `${preset.id}/${n.id}`).toEqual(templateReads(draft.prompts[n.prompt] ?? ""));
    }
  });

  /**
   * HOW-26 review, finding 1. A preset is the builder's own answer to "compare this to the
   * inbuilt ones", so its steps have to survive the loops they ship with. A step a repair edge
   * comes BACK to is re-entered as a fresh agent session with no memory of the last one, so one
   * that acts on a pull request has to be told WHICH one — either by reading the field that
   * carries it, or, where the path validator cannot allow that read (a key with no writer on
   * the entry path), by being told in prose to go and look. The built-in states it in prose for
   * exactly that reason: prompts/delivery.publish.md says "any associated pull request",
   * "Update the existing open PR" and "avoid creating duplicate PRs". Without it the pr
   * preset's publish step opened a second PR on every repair visit, or parked on the `gh`
   * refusal to open one.
   */
  test("a preset step a repair edge returns to is told which pull request it is acting on", () => {
    let checked = 0;
    for (const preset of PRESETS) {
      const draft = preset.build("my-review");
      for (const n of draft.spec.nodes) {
        if (n.kind !== "agent" || !onALoop(draft.spec, n.id)) continue;
        const body = draft.prompts[n.prompt] ?? "";
        if (!/pull request/i.test(body)) continue;
        checked++;
        const told = n.reads.includes("publication_summary") || /\balready\b|\bexisting\b/i.test(body);
        expect(told, `${preset.id}/${n.id} is re-entered and must say which pull request it means`).toBe(true);
      }
    }
    // a rule no preset step reaches is not a rule, so the reach is asserted too
    expect(checked).toBeGreaterThan(0);
  });

  test("removing a step takes the edges that named it, in both directions", () => {
    const after = apply(doc(), { type: "remove-step", id: "revise" });
    expect(after.spec.nodes.map((n) => n.id)).not.toContain("revise");
    expect(after.spec.edges.filter((e) => e.from === "revise" || e.to === "revise")).toEqual([]);
  });

  test("removing the starting step moves the start rather than leaving it dangling", () => {
    const after = apply(doc(), { type: "remove-step", id: "draft" });
    expect(after.spec.entry).toBe(after.spec.nodes[0]!.id);
  });

  /**
   * HOW-22 review, finding 1. `remove-step`'s fallback was `nodes[0]`, which is the FINISH step
   * as soon as an operator drags one to the top: the draft then saved clean and every run ended
   * before doing anything. The entry falls through to the first step that can actually run.
   */
  test("removing the starting step never leaves a Finish step as the start", () => {
    // the review's exact reproduction, through actions the panes dispatch and nothing else
    const blank = PRESETS[0]!.build("demo");
    const made = newStep(blank.spec, "command", "Extra");
    const after = apply(
      blank,
      { type: "add-step", ...made },
      { type: "set-branching", from: made.node.id, edges: [{ to: "done" }] },
      { type: "move-step", id: "done", by: -1 },
      { type: "move-step", id: "done", by: -1 },
      { type: "remove-step", id: "work" },
    );
    expect(after.spec.nodes[0]!.kind).toBe("terminal");           // the Finish really is first
    expect(after.spec.nodes.find((n) => n.id === after.spec.entry)!.kind).not.toBe("terminal");
    expect(draftProblems(after)).toEqual([]);
  });

  test("removing the last step that can run leaves no start, and says so rather than throwing", () => {
    const after = apply(
      { spec: { ...doc().spec, nodes: [{ id: "done", kind: "terminal", outcome: "success" }], edges: [], entry: "done" }, prompts: {}, saved: false },
      { type: "remove-step", id: "nothing-here" },
    );
    expect(after.spec.entry).toBe("");
    expect(draftProblems(after).some((p) => p.where === "basics" && p.message.includes("not in the graph"))).toBe(true);
  });

  test("a Finish step added first does not become the start", () => {
    const empty: Draft = { spec: { ...doc().spec, nodes: [], edges: [], entry: "" }, prompts: {}, saved: false };
    const fin = newStep(empty.spec, "terminal", "All done");
    const after = apply(empty, { type: "add-step", ...fin });
    expect(after.spec.entry).toBe("");
    const work = newStep(after.spec, "command", "Do it");
    expect(apply(after, { type: "add-step", ...work }).spec.entry).toBe(work.node.id);
  });

  /** HOW-22 review, C9 — the review pane promises every step is reachable; now it is checked. */
  test("a step nothing goes to is counted in the Branching pane", () => {
    const made = newStep(doc().spec, "command", "Stranded");
    const after = apply(doc(), { type: "add-step", ...made }, { type: "set-branching", from: made.node.id, edges: [{ to: "done" }] });
    const problems = problemsByPane(draftProblems(after));
    expect(problems.branching).toHaveLength(1);
    expect(problems.branching[0]!.message).toContain("**Stranded** is never reached");
  });

  test("removing a field takes it off every step AND removes the branch rows that tested it", () => {
    const after = apply(doc(), { type: "remove-field", key: "review_verdict" });
    expect(after.spec.fields.map((f) => f.key)).not.toContain("review_verdict");
    expect(after.spec.nodes.some((n) => "writes" in n && n.writes.includes("review_verdict"))).toBe(false);
    expect(after.spec.edges.some((e) => e.when?.key === "review_verdict")).toBe(false);
  });

  test("renaming a field follows it into steps, launch inputs and conditions", () => {
    const after = apply(doc(), { type: "update-field", key: "review_verdict", patch: { key: "verdict" } });
    expect(after.spec.edges.filter((e) => e.when).every((e) => e.when!.key !== "review_verdict")).toBe(true);
    expect(after.spec.edges.some((e) => e.when?.key === "verdict")).toBe(true);
    expect(after.spec.nodes.find((n) => n.id === "review")).toMatchObject({ writes: ["verdict", "review_findings"] });
    expect(draftProblems(after)).toEqual([]);
  });

  test("renaming a field follows it into the INSTRUCTIONS that reference it", () => {
    // the one the review caught: the declaration moved and the body did not, so the draft
    // read as clean here and was refused at save with a message naming the old key
    const before = doc();
    expect(before.prompts["my-review.draft"]).toContain("{{ context.goal }}");
    const after = apply(before, { type: "update-field", key: "goal", patch: { key: "objective" } });
    expect(after.prompts["my-review.draft"]).toContain("{{ context.objective }}");
    expect(after.prompts["my-review.draft"]).not.toContain("context.goal");
    // and `reads` comes back off the rewritten body, so the two cannot contradict each other
    for (const n of after.spec.nodes)
      if (n.kind === "agent") expect(n.reads, n.id).toEqual(templateReads(after.prompts[n.prompt] ?? ""));
    expect(after.spec.inputs).toContain("objective");
    expect(draftProblems(after)).toEqual([]);
  });

  test("removing a field its instructions still ask for is REPORTED, in the steps pane", () => {
    // there is no correct rewrite of a body that asks for something that no longer exists, so
    // the disagreement is surfaced rather than papered over by editing the step's reads
    const after = apply(doc(), { type: "remove-field", key: "goal" });
    const problems = draftProblems(after);
    const orphan = problems.find((p) => p.message.includes("still asks for `goal`"))!;
    expect(orphan).toBeDefined();
    expect(orphan.where).toBe("steps");
    expect(orphan.node).toBe("draft");
  });

  test("removing a step takes its instructions with it, so a later save is not blocked", () => {
    const before = doc();
    const made = newStep(before.spec, "agent", "Extra");
    const added = apply(before, { type: "add-step", ...made });
    expect(added.prompts[(made.node as Extract<NodeSpec, { kind: "agent" }>).prompt]).toBeDefined();
    const after = apply(added, { type: "remove-step", id: made.node.id });
    expect(Object.keys(after.prompts)).toEqual(Object.keys(before.prompts));
  });

  test("a body two steps share survives the removal of one of them", () => {
    const shared = apply(doc(), {
      type: "add-step",
      node: { id: "second-draft", kind: "agent", title: "Draft again", prompt: "my-review.draft", reads: [], writes: ["summary"] },
    });
    const after = apply(shared, { type: "remove-step", id: "second-draft" });
    expect(after.prompts["my-review.draft"]).toBeDefined();
  });

  test("removing a non-agent step leaves the prompt map alone", () => {
    const withWait = apply(doc(), { type: "add-step", node: { id: "hold", kind: "wait", duration: "30 s" } });
    const after = apply(withWait, { type: "remove-step", id: "hold" });
    expect(after.prompts).toEqual(doc().prompts);
  });

  test("a worktree step flipped from clean-up to make drops the facts it can no longer emit", () => {
    // through the SAME update-step the form issues — the rule belongs to the reducer, so
    // both step forms get it rather than only the one that remembered to filter
    const code = PRESETS.find((p) => p.id === "code")!.build("my-code");
    const cleanup = code.spec.nodes.find((n) => n.id === "clean-up") as Extract<NodeSpec, { kind: "worktree" }>;
    expect(cleanup.writes).toEqual(["worktree.clean"]);
    const after = apply(code, { type: "update-step", id: "clean-up", node: { ...cleanup, action: "create" } });
    expect((after.spec.nodes.find((n) => n.id === "clean-up") as Extract<NodeSpec, { kind: "worktree" }>).writes).toEqual([]);
  });

  test("switching a command to another built-in drops produced keys the new one cannot emit", () => {
    const base = apply(doc(), {
      type: "add-step",
      node: { id: "probe", kind: "command", title: "Check the PR", run: "probe:pr", reads: [], writes: [] },
    });
    const withWrite = apply(base, {
      type: "add-field", patch: { key: "pr.state", kind: "text", scope: "per-visit" },
    }, {
      type: "update-step", id: "probe",
      node: { id: "probe", kind: "command", title: "Check the PR", run: "probe:pr", reads: [], writes: ["pr.state"] },
    });
    expect((withWrite.spec.nodes.find((n) => n.id === "probe") as Extract<NodeSpec, { kind: "command" }>).writes).toEqual(["pr.state"]);
    const switched = apply(withWrite, {
      type: "update-step", id: "probe",
      node: { ...(withWrite.spec.nodes.find((n) => n.id === "probe") as Extract<NodeSpec, { kind: "command" }>), run: "map:drift" },
    });
    expect((switched.spec.nodes.find((n) => n.id === "probe") as Extract<NodeSpec, { kind: "command" }>).writes).toEqual([]);
  });

  test("changing a field's kind re-types every operand that compares against it", () => {
    const before = doc();
    expect(before.spec.edges.find((e) => e.when?.key === "review_verdict")!.when).toMatchObject({ value: "reject" });
    const after = apply(before, { type: "update-field", key: "review_verdict", patch: { kind: "boolean" } });
    for (const e of after.spec.edges) {
      if (e.when?.key !== "review_verdict") continue;
      if (e.when.op === "equals" || e.when.op === "not-equals") expect(typeof e.when.value).toBe("boolean");
    }
    // a nullary op has no operand to re-type, and is returned untouched
    const nullary = apply(
      apply(before, { type: "set-branching", from: "review", edges: [{ to: "done", when: { op: "is-true", key: "review_verdict" } }] }),
      { type: "update-field", key: "review_verdict", patch: { kind: "number" } },
    );
    expect(nullary.spec.edges.find((e) => e.from === "review")!.when).toEqual({ op: "is-true", key: "review_verdict" });
  });

  test("renaming the graph before its first save moves the prompt ids and the bodies with them", () => {
    const before = doc();
    const body = before.prompts["my-review.draft"]!;
    const after = apply(before, { type: "set-name", name: "my-doc" });
    expect(after.spec.nodes.find((n) => n.id === "draft")).toMatchObject({ prompt: "my-doc.draft" });
    expect(after.prompts["my-doc.draft"]).toBe(body);
    expect(after.prompts["my-review.draft"]).toBeUndefined();
    expect(draftProblems(after)).toEqual([]);
  });

  test("once it is saved the name is the file name and stops moving", () => {
    const saved = { ...doc(), saved: true };
    expect(apply(saved, { type: "set-name", name: "something-else" }).spec.name).toBe("my-review");
  });

  test("branch rows REPLACE that step's routes and leave every other step's alone", () => {
    const after = apply(doc(), { type: "set-branching", from: "review", edges: [{ to: "done" }] });
    expect(after.spec.edges.filter((e) => e.from === "review")).toEqual([{ from: "review", to: "done" }]);
    expect(after.spec.edges.filter((e) => e.from === "draft")).toHaveLength(1);
  });

  test("row order is priority: the first row leaving a step gets the heavier weight", () => {
    const after = apply(doc(), {
      type: "set-branching",
      from: "review",
      edges: [
        { to: "revise", when: { op: "equals", key: "review_verdict", value: "reject" } },
        { to: "done", when: { op: "equals", key: "review_verdict", value: "pass" } },
      ],
    });
    const edges = buildGraph(after.spec).def.edges.filter((e) => e.from === "review");
    expect(edges.map((e) => ({ to: e.to, weight: e.weight }))).toEqual([
      { to: "revise", weight: 2 },
      { to: "done", weight: 1 },
    ]);
  });

  test("a step id is assigned once and never collides, however it is titled", () => {
    let draft = doc();
    for (const title of ["Review it", "Review it", "Review it"]) {
      const made = newStep(draft.spec, "agent", title);
      draft = apply(draft, { type: "add-step", ...made });
    }
    const ids = draft.spec.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("an approval step brings its own decision and comments fields — they are never invented by hand", () => {
    const made = newStep(doc().spec, "approval", "Get my approval");
    const draft = apply(doc(), { type: "add-step", ...made });
    const node = draft.spec.nodes.find((n) => n.id === made.node.id) as Extract<NodeSpec, { kind: "approval" }>;
    expect(draft.spec.fields.map((f) => f.key)).toContain(node.decision);
    expect(draft.spec.fields.map((f) => f.key)).toContain(node.feedback);
    expect(node.decision).not.toBe(node.feedback);
  });
});

describe("every native node kind can be built from the forms' own defaults (AC1)", () => {
  /**
   * The six kinds in one graph, assembled the way the wizard assembles them: newStep() for
   * the defaults each form starts from, then only the answers a form actually asks for. If
   * this validates, every kind is reachable through the UI without a file being edited.
   */
  function sixKinds(): Draft {
    let draft: Draft = {
      saved: false,
      prompts: {},
      spec: {
        version: 1, name: "everything", description: "one of each",
        fields: [
          { key: "goal", kind: "text", scope: "sticky" },
          { key: "summary", kind: "text", scope: "sticky" },
          { key: "design", kind: "json", scope: "sticky" },
          { key: "pr.state", kind: "json", scope: "per-visit" },
          { key: "worktree.clean", kind: "boolean", scope: "per-visit" },
        ],
        inputs: ["goal"],
        entry: "",
        nodes: [],
        edges: [],
      },
    };
    const add = (kind: Exclude<NodeSpec["kind"], "parallel">, title: string, over: (n: NodeSpec) => NodeSpec = (n) => n) => {
      const made = newStep(draft.spec, kind, title);
      draft = apply(draft, { type: "add-step", ...made, node: over(made.node) });
      return over(made.node).id;
    };
    add("worktree", "Make a worktree");
    add("agent", "Design it", (n) => ({ ...n, writes: ["design", "summary"] }));
    const approve = add("approval", "Get my approval", (n) =>
      n.kind === "approval" ? { ...n, proposal: "design", base: "summary", redesignTo: "design-it" } : n);
    add("agent", "Build it", (n) => ({ ...n, writes: ["summary"], requires: approve }));
    add("wait", "Wait");
    add("command", "Check the PR", (n) => (n.kind === "command" ? { ...n, writes: ["pr.state"] } : n));
    add("worktree", "Clean up", (n) => (n.kind === "worktree" ? { ...n, action: "remove", writes: ["worktree.clean"] } : n));
    add("terminal", "Finish");

    const ids = draft.spec.nodes.map((n) => n.id);
    const [worktree, design, approval, build, wait, command, cleanup, done] = ids as string[];
    return apply(
      draft,
      { type: "set-entry", id: worktree! },
      // the prompt bodies the agent forms seed, so `reads` is derived rather than declared
      { type: "set-prompt", id: "everything.design-it", body: "Design it.\n\n{{ context.goal }}" },
      { type: "set-prompt", id: "everything.build-it", body: "Build it.\n\n{{ context.design }}" },
      { type: "set-branching", from: worktree!, edges: [{ to: design! }] },
      { type: "set-branching", from: design!, edges: [{ to: approval! }] },
      { type: "set-branching", from: approval!, edges: [{ to: build! }] },
      { type: "set-branching", from: build!, edges: [{ to: wait! }] },
      { type: "set-branching", from: wait!, edges: [{ to: command! }] },
      {
        type: "set-branching",
        from: command!,
        edges: [
          { to: cleanup!, when: { op: "equals", key: "pr.state", path: "state", value: "merged" } },
          { to: wait! },
        ],
      },
      {
        type: "set-branching",
        from: cleanup!,
        edges: [{ to: done!, when: { op: "is-true", key: "worktree.clean" } }],
      },
    );
  }

  test("one graph with all six kinds has nothing outstanding, and validate() agrees", () => {
    const draft = sixKinds();
    expect(draftProblems(draft)).toEqual([]);
    expect(buildGraph(draft.spec).validate()).toEqual({ structural: [], paths: [] });
  });

  test("its conditions compile to the same labels a hand-written graph carries", () => {
    const labels = buildGraph(sixKinds().spec).def.edges.filter((e) => e.condition).map((e) => e.condition!.label);
    expect(labels).toContain("pr.state.state == 'merged'");
    expect(labels).toContain("worktree.clean == true");
  });

  test('a clean-up step with no "Otherwise" parks on purpose — that is legal, not a hole', () => {
    const draft = sixKinds();
    const cleanup = draft.spec.nodes.find((n) => n.title === "Clean up")!.id;
    expect(draft.spec.edges.filter((e) => e.from === cleanup && !e.when)).toEqual([]);
    expect(draftProblems(draft)).toEqual([]);
  });
});

describe("a problem is attributed to the pane that fixes it (AC4)", () => {
  test("a dead end is branching's, a missing writer is the step's, a bad name is basics'", () => {
    const dead = apply(doc(), { type: "set-branching", from: "revise", edges: [] });
    expect(problemsByPane(draftProblems(dead)).branching).toHaveLength(1);

    const unwritten: GraphSpec = { ...doc().spec, inputs: [] };
    expect(problemsByPane(specProblems(unwritten)).steps.length).toBeGreaterThan(0);

    const unnamed = apply(doc(), { type: "set-name", name: "Not Kebab" });
    expect(problemsByPane(draftProblems(unnamed)).basics).toHaveLength(1);

    const badKey = apply(doc(), { type: "update-field", key: "summary", patch: { key: "Not A Key" } });
    expect(problemsByPane(draftProblems(badKey)).fields.length).toBeGreaterThan(0);
  });

  test("no problem is ever left unplaced — `where` is required, so the rail cannot lose one", () => {
    const broken = apply(doc(), { type: "remove-step", id: "review" }, { type: "remove-field", key: "goal" });
    const problems = draftProblems(broken);
    expect(problems.length).toBeGreaterThan(0);
    const byPane = problemsByPane(problems);
    expect(byPane.basics.length + byPane.fields.length + byPane.steps.length + byPane.branching.length).toBe(problems.length);
  });
});


/**
 * HOW-24. Three actions the canvas added, held to the rules the panel already kept. They are
 * pinned HERE rather than only through the gestures that dispatch them, because the rules are
 * the reducer's and a gesture is only one way to ask.
 */
describe("a route drawn on the canvas is the same route the panel makes", () => {
  const seedDraft = (kind: FieldKind): Draft => ({
    saved: false,
    prompts: { "seed.work": "Do it." },
    spec: {
      version: 1, name: "seed", description: "",
      fields: [{ key: "flag", kind, scope: "sticky" }],
      inputs: [], entry: "work",
      nodes: [
        { id: "work", kind: "command", title: "Do it", run: "true", reads: [], writes: ["flag"] },
        { id: "done", kind: "terminal", outcome: "success" },
        { id: "other", kind: "terminal", outcome: "failed" },
      ],
      edges: [],
    },
  });

  test("the FIRST route leaving a step is its Otherwise — the one that needs no condition", () => {
    const after = apply(seedDraft("text"), { type: "add-edge", from: "work", to: "done" });
    expect(after.spec.edges).toEqual([{ from: "work", to: "done" }]);
  });

  test("a SECOND route is a condition, seeded so it can actually match", () => {
    // the finding-3 property, re-asserted through the new creation path: `flag == ''` on a
    // yes/no field is a predicate no runtime value satisfies, and it used to save clean
    for (const [kind, operand] of [["boolean", false], ["number", 0], ["text", ""]] as const) {
      const after = apply(
        seedDraft(kind),
        { type: "add-edge", from: "work", to: "done" },
        { type: "add-edge", from: "work", to: "other" },
      );
      const when = after.spec.edges.find((e) => e.when)!.when!;
      expect(when.op === "equals" && when.value, kind).toBe(operand);
    }
  });

  test("with no fields at all it is still a route, and the verdict says what is missing", () => {
    const bare: Draft = { ...seedDraft("text"), spec: { ...seedDraft("text").spec, fields: [], inputs: [] } };
    const after = apply(bare, { type: "add-edge", from: "work", to: "done" }, { type: "add-edge", from: "work", to: "other" });
    expect(after.spec.edges).toHaveLength(2);
    expect(draftProblems(after).length).toBeGreaterThan(0);
  });

  test("a drawn route is appended after the step's existing conditions, so priority is kept", () => {
    const after = apply(
      seedDraft("boolean"),
      {
        type: "set-branching", from: "work",
        edges: [{ to: "done", when: { op: "is-true", key: "flag" } }, { to: "other" }],
      },
      // the step already has its Otherwise, so this one is a condition — and it goes LAST,
      // below the condition that was already there
      { type: "add-edge", from: "work", to: "other" },
    );
    // the engine's own numbers, off the compiled graph: first listed wins
    expect(buildGraph(after.spec).def.edges.filter((e) => e.from === "work").map((e) => ({ to: e.to, weight: e.weight })))
      .toEqual([{ to: "done", weight: 2 }, { to: "other", weight: undefined }, { to: "other", weight: 1 }]);
  });

  test("the canvas path and the panel path leave a step with the same routes (AC6)", () => {
    const drawn = apply(
      seedDraft("boolean"),
      { type: "add-edge", from: "work", to: "done" },
      { type: "add-edge", from: "work", to: "other" },
    );
    const typed = apply(seedDraft("boolean"), {
      type: "set-branching",
      from: "work",
      edges: [{ to: "other", when: { op: "equals", key: "flag", value: false } }, { to: "done" }],
    });
    // the ROUTES, not the array order: what an operator can tell apart is where each one goes,
    // what it tests, and which wins — which is exactly what compileEdges derives
    const leaving = (d: Draft) =>
      buildGraph(d.spec).def.edges
        .filter((e) => e.from === "work")
        .map((e) => ({ to: e.to, weight: e.weight, label: e.condition?.label }))
        .sort((a, b) => a.to.localeCompare(b.to));
    expect(leaving(drawn)).toEqual(leaving(typed));
  });

  test("an edge is edited and removed by its index, and a cleared condition is the Otherwise", () => {
    const two = apply(
      seedDraft("boolean"),
      { type: "add-edge", from: "work", to: "done" },
      { type: "add-edge", from: "work", to: "other" },
    );
    expect(apply(two, { type: "update-edge", index: 1, patch: { to: "done" } }).spec.edges[1]!.to).toBe("done");
    expect(apply(two, { type: "update-edge", index: 1, patch: { when: null } }).spec.edges[1]!.when).toBeUndefined();
    // a target UNPICKED is kept as a row, not dropped — the condition just typed goes with it
    expect(apply(two, { type: "update-edge", index: 1, patch: { to: "" } }).spec.edges[1]).toMatchObject({ to: "" });
    expect(apply(two, { type: "remove-edge", index: 0 }).spec.edges).toEqual([two.spec.edges[1]!]);
    expect(apply(two, { type: "remove-edge", index: 9 }).spec.edges).toEqual(two.spec.edges);
  });
});

describe("the arrangement is part of the graph (AC4)", () => {
  test("every preset opens laid out, and no two steps share a place", () => {
    for (const preset of PRESETS) {
      const spec = preset.build("my-review").spec;
      const places = spec.nodes.map((n) => `${n.position!.x},${n.position!.y}`);
      expect(places.filter(Boolean), preset.id).toHaveLength(spec.nodes.length);
      expect(new Set(places).size, preset.id).toBe(places.length);
    }
  });

  test("a dragged step keeps where it was put, and nothing else moves", () => {
    const before = doc();
    const after = apply(before, { type: "move-node", id: "review", position: { x: 640, y: 12 } });
    expect(after.spec.nodes.find((n) => n.id === "review")!.position).toEqual({ x: 640, y: 12 });
    for (const n of after.spec.nodes)
      if (n.id !== "review") expect(n.position, n.id).toEqual(before.spec.nodes.find((x) => x.id === n.id)!.position);
    // a place is not a verdict
    expect(draftProblems(after)).toEqual([]);
  });

  test("a step added without a dropped position is still placed, below everything", () => {
    const made = newStep(doc().spec, "wait", "Hold");
    const after = apply(doc(), { type: "add-step", ...made });
    const added = after.spec.nodes.find((n) => n.id === made.node.id)!;
    expect(added.position).toBeDefined();
    expect(added.position!.y).toBeGreaterThan(Math.max(...doc().spec.nodes.map((n) => n.position!.y)) - 1);
  });
});

describe("the canvas is drawn from the draft, not fetched", () => {
  test("it speaks in titles while the ids — which are run identity — stay put", () => {
    const { nodes } = specToFlow(doc().spec, [], () => {});
    expect(nodes.find((n) => n.id === "draft")!.data.title).toBe("Draft it");
    expect(nodes.map((n) => n.id)).toContain("revise");
  });

  test("a step is drawn where the SPEC says, not where a layout would put it", () => {
    const moved = apply(doc(), { type: "move-node", id: "revise", position: { x: 777, y: 13 } });
    expect(specToFlow(moved.spec, [], () => {}).nodes.find((n) => n.id === "revise")!.position).toEqual({ x: 777, y: 13 });
  });

  test("its wire captions are the compiled graph's own labels, so picture and log agree", () => {
    const { edges } = specToFlow(doc().spec, [], () => {});
    const compiled = buildGraph(doc().spec).def.edges;
    for (const e of edges) {
      const label = (e.data as { label: string }).label;
      if (!label) continue;
      expect(compiled.find((c) => c.from === e.source && c.to === e.target)!.condition!.label).toBe(label);
    }
    expect(edges.map((e) => (e.data as { label: string }).label))
      .toContain(predicateLabel({ op: "equals", key: "review_verdict", value: "reject" }));
  });

  test("a problem is carried to the step that owns it, and to the wires leaving it", () => {
    const dead = apply(doc(), { type: "set-branching", from: "revise", edges: [] });
    const problems = draftProblems(dead);
    const { nodes } = specToFlow(dead.spec, problems, () => {});
    expect(nodes.find((n) => n.id === "revise")!.data.problems).toBe(1);
    expect(nodes.find((n) => n.id === "draft")!.data.problems).toBe(0);
    const { edges } = specToFlow(doc().spec, [{ node: "review", where: "branching", message: "…" }], () => {});
    expect(edges.filter((e) => (e.data as { flagged: boolean }).flagged).map((e) => e.source)).toEqual(["review", "review"]);
  });
});

// ---- the builder, on screen ------------------------------------------------------------------

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

/**
 * React Flow measures the DOM, and happy-dom has no layout engine: every box reads 0×0 and its
 * ResizeObserver never fires, so a node renders and a wire never does (`getEdgePosition`
 * returns null without handle bounds). Three readings are stubbed for this file and put back
 * afterwards — bun runs every test file in ONE process, so a prototype left patched would
 * follow the rest of the suite around.
 *
 * It is worth the twenty lines: it is the difference between asserting on the PICTURE — the
 * boxes and the wires an operator sees — and asserting only on the pure function behind it.
 */
const CARD = { w: 180, h: 52 };
const HANDLE = 6;
/** ...and the pane a size of its own. Without one there is no viewport for a clicked step to
 *  land INSIDE, so the placement assertions below would pass on anything (review finding 3),
 *  and `fitView` would be fitting a graph into 180x52. */
const PANE = { w: 900, h: 600 };
const isHandle = (el: Element) => el.classList?.contains("react-flow__handle");
/** what React Flow measures itself by: `domNode` is the `.react-flow` wrapper and the resize
 *  handler watches `.react-flow__renderer` */
const isPane = (el: Element) =>
  el.classList?.contains("react-flow") || el.classList?.contains("react-flow__renderer") || el.classList?.contains("gb-canvas");

function stubLayout(): () => void {
  const proto = window.HTMLElement.prototype;
  const savedW = Object.getOwnPropertyDescriptor(proto, "offsetWidth");
  const savedH = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
  const savedRect = window.Element.prototype.getBoundingClientRect;
  const savedRO = globalThis.ResizeObserver;
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get(this: Element) { return isHandle(this) ? HANDLE : isPane(this) ? PANE.w : CARD.w; } });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get(this: Element) { return isHandle(this) ? HANDLE : isPane(this) ? PANE.h : CARD.h; } });
  window.Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const handle = isHandle(this);
    const top = handle && this.getAttribute("data-handlepos") === "bottom" ? CARD.h : 0;
    const w = handle ? HANDLE : isPane(this) ? PANE.w : CARD.w;
    const h = handle ? HANDLE : isPane(this) ? PANE.h : CARD.h;
    return { x: 0, y: top, top, left: 0, right: w, bottom: top + h, width: w, height: h, toJSON: () => ({}) } as DOMRect;
  };
  globalThis.ResizeObserver = class {
    constructor(private cb: ResizeObserverCallback) {}
    observe(el: Element) {
      this.cb([{ target: el, contentRect: el.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  return () => {
    if (savedW) Object.defineProperty(proto, "offsetWidth", savedW); else delete (proto as unknown as Record<string, unknown>).offsetWidth;
    if (savedH) Object.defineProperty(proto, "offsetHeight", savedH); else delete (proto as unknown as Record<string, unknown>).offsetHeight;
    window.Element.prototype.getBoundingClientRect = savedRect;
    globalThis.ResizeObserver = savedRO;
  };
}

let unstub: (() => void) | null = null;
beforeAll(() => { unstub = stubLayout(); });
afterAll(() => { unstub?.(); unstub = null; });

/** the catalog answers every GET; a PUT is recorded and answered 201 unless told otherwise.
 *  `catalog` is the list of names already taken — the one fact a spec cannot carry, so the
 *  builder fetches it once and feeds it to draftProblems(). */
function serve(
  put: { status: number; body: unknown } = { status: 201, body: { ok: true } },
  catalog: string[] = [],
) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method !== "GET")
      return new Response(JSON.stringify(put.body), { status: put.status, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ graphs: catalog.map((name) => ({ name })), problems: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

async function mount(): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<ToastProvider><GraphBuilder /></ToastProvider>); });
  return host;
}

function type(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof window.HTMLSelectElement ? window.HTMLSelectElement.prototype
    : el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof window.HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

const buttons = (el: HTMLElement) => [...el.querySelectorAll("button")] as HTMLButtonElement[];
const byText = (el: HTMLElement, text: string) => buttons(el).find((b) => b.textContent?.includes(text));
const byLabel = (el: HTMLElement, prefix: string) => buttons(el).find((b) => b.getAttribute("aria-label")?.startsWith(prefix));
/** anything with a spoken name, control or not — the verdict chip is a Badge, not a button */
const labelled = (el: HTMLElement, prefix: string) =>
  [...el.querySelectorAll("[aria-label]")].find((n) => n.getAttribute("aria-label")!.startsWith(prefix));
const click = (b: HTMLElement | undefined) => act(() => { b!.click(); });

/** the six things you can pick up, by their own label */
const palette = (el: HTMLElement, label: string) => byLabel(el, `${label} —`);
/** the way INTO a step: a real control on its card, not the card itself (D7) */
const openStep = (el: HTMLElement, title: string) => byLabel(el, `Edit ${title}`);
const cards = (el: HTMLElement) => [...el.querySelectorAll("[data-testid=gb-node]")] as HTMLElement[];
const card = (el: HTMLElement, kind: string) => cards(el).find((n) => n.dataset.kind === kind);
const nameBox = (el: HTMLElement) => el.querySelector('input[placeholder="my-review"]') as HTMLInputElement;

/** the `.react-flow__node` a card sits in, and where the picture actually draws it */
const placed = (n: HTMLElement) => n.closest(".react-flow__node") as HTMLElement;
const TRANSLATE = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/;
function translation(el: HTMLElement): { x: number; y: number } {
  const m = TRANSLATE.exec(el.style.transform);
  if (!m?.[1] || !m[2]) throw new Error(`no translate in "${el.style.transform}"`);
  return { x: Number(m[1]), y: Number(m[2]) };
}
/** the viewport's own transform, so a flow-space position can be checked where it is DRAWN */
function viewport(el: HTMLElement): { x: number; y: number; zoom: number } {
  const vp = el.querySelector(".react-flow__viewport") as HTMLElement;
  const at = translation(vp);
  const m = /scale\(\s*(-?[\d.]+)\s*\)/.exec(vp.style.transform);
  if (!m?.[1]) throw new Error(`no scale in "${vp.style.transform}"`);
  return { ...at, zoom: Number(m[1]) };
}
/** a flow-space position, in the screen coordinates the operator is looking at */
const onScreen = (at: { x: number; y: number }, vp: { x: number; y: number; zoom: number }) =>
  ({ x: at.x * vp.zoom + vp.x, y: at.y * vp.zoom + vp.y });

/** React Flow's own arrow-key nudge: a keydown that bubbles out of the card to its wrapper */
const nudge = (el: HTMLElement, title: string, key: string) =>
  act(() => { openStep(el, title)!.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true })); });

/** the PUT body of the last save, which is the only place a position provably survives */
function saved(calls: Array<{ url: string; method: string; body: unknown }>): GraphSpec {
  const puts = calls.filter((c) => c.method === "PUT");
  return (puts[puts.length - 1]!.body as { spec: GraphSpec }).spec;
}
const at = (spec: GraphSpec, id: string) => spec.nodes.find((n) => n.id === id)!.position!;
const openDialog = () => document.querySelector("dialog[open]") as HTMLDialogElement | null;

/** a real drag-and-drop, as far as React is concerned: the drop event carries a dataTransfer */
function drop(el: HTMLElement, kind: string, at: { x: number; y: number }) {
  const canvas = el.querySelector(".gb-canvas")!;
  const ev = new window.Event("drop", { bubbles: true, cancelable: true }) as Event & { clientX: number; clientY: number };
  Object.defineProperties(ev, {
    dataTransfer: { value: { getData: (t: string) => (t === STEP_KIND_MIME ? kind : ""), dropEffect: "" } },
    clientX: { value: at.x },
    clientY: { value: at.y },
  });
  act(() => { canvas.dispatchEvent(ev); });
}

/**
 * What the NEXT step will be called (HOW-26). The palette's own box, which is where a step's
 * name — and therefore its id, and therefore its prompt file — now comes from, whichever
 * gesture places it. The old flow seeded the id from the MENU LABEL, so a graph of six agent
 * steps came out as `ask-an-agent` … `ask-an-agent-8` with its prompt files to match.
 */
const nextNameBox = (el: HTMLElement) =>
  el.querySelector('input[aria-label="what the next step is called"]') as HTMLInputElement;
const nameNext = (el: HTMLElement, name: string) => type(nextNameBox(el), name);
/** the id the palette PROMISES the next step, read out of the DOM rather than recomputed */
const previewedId = (el: HTMLElement) =>
  [...el.querySelectorAll(".field-hint")]
    .find((n) => n.textContent?.includes("The name becomes the step's id"))!
    .querySelector("code")!.textContent!;

beforeEach(() => { serve(); });
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
  globalThis.fetch = realFetch;
});

describe("a step is added where it was put, and without a mouse (AC1)", () => {
  test("dropping one on the canvas adds a step of that kind, at the drop point", async () => {
    const el = await mount();
    expect(card(el, "wait")).toBeUndefined();
    drop(el, "wait", { x: 300, y: 200 });
    drop(el, "wait", { x: 300, y: 420 });
    const waits = cards(el).filter((n) => n.dataset.kind === "wait");
    expect(waits).toHaveLength(2);
    // where it lands is where it was DROPPED, which is the whole reason positions exist. Two
    // distinct node ids would be true of any two steps and prove nothing, so this asserts on
    // the two PLACES: 220px apart on screen, because that is how far apart the drops were.
    const vp = viewport(el);
    const [first, second] = waits.map((n) => translation(placed(n)));
    expect(second!.y - first!.y).toBeCloseTo(220 / vp.zoom, 5);
    expect(second!.x - first!.x).toBeCloseTo(0, 5);
  });

  test("...and the same step is added from the keyboard, which is all a Button needs", async () => {
    const el = await mount();
    click(palette(el, "Wait"));
    expect(card(el, "wait")).toBeDefined();
    // the step that was just added is what the panel is showing — no second click to find it
    expect(el.textContent).toContain("Step id");
  });

  test("a clicked step lands where you are LOOKING, not below everything (finding 3)", async () => {
    const calls = serve();
    const el = await mount();
    type(nameBox(el), "my-review");
    // the graph is first made TALLER THAN THE PANE, because that is the case the finding is
    // about: "below everything" is only off-screen when there is a lot of everything, and a
    // two-step graph would have hidden the defect either way
    drop(el, "wait", { x: 400, y: PANE.h - 20 });
    click(palette(el, "Get my approval"));
    await act(async () => { byText(el, "Save and add to the catalog")!.click(); });

    // asserted through the SAVE, because that is the position that would survive a reload
    const spec = saved(calls);
    const added = spec.nodes.find((n) => n.kind === "approval")!;
    const on = onScreen(added.position!, viewport(el));
    // the palette says "in the middle" on both its item labels and its hint. This is that
    // sentence, asserted: somewhere inside the pane the operator is looking at.
    expect(on.x, `x of ${JSON.stringify(on)}`).toBeGreaterThanOrEqual(0);
    expect(on.x, `x of ${JSON.stringify(on)}`).toBeLessThanOrEqual(PANE.w);
    expect(on.y, `y of ${JSON.stringify(on)}`).toBeGreaterThanOrEqual(0);
    expect(on.y, `y of ${JSON.stringify(on)}`).toBeLessThanOrEqual(PANE.h);
  });

  test("two clicks are two places, not a pile on the same pixel", async () => {
    const calls = serve();
    const el = await mount();
    type(nameBox(el), "my-review");
    click(palette(el, "Wait"));
    click(palette(el, "Wait"));
    await act(async () => { byText(el, "Save and add to the catalog")!.click(); });

    const waits = saved(calls).nodes.filter((n) => n.kind === "wait");
    expect(waits).toHaveLength(2);
    const [a, b] = waits.map((n) => n.position!);
    // "always the centre" would cover the first card with the second; a free spot is the fix
    expect(Math.abs(a!.x - b!.x) >= 90 || Math.abs(a!.y - b!.y) >= 32, `${JSON.stringify([a, b])}`).toBe(true);
  });

  test("with nothing measured there is no middle to aim at, and nothing is invented", () => {
    // `undefined` in, `undefined` out — `add-step` then places it below everything, which is
    // the honest answer to "we do not know what is on screen"
    expect(freeSpotNear(doc().spec.nodes, undefined)).toBeUndefined();
  });

  test("every one of the six kinds is a named, enabled control (AC6)", async () => {
    const el = await mount();
    const six = ["Ask an agent", "Run a command", "Make or clean up a worktree", "Wait", "Get my approval", "Finish"];
    for (const label of six) {
      const b = palette(el, label);
      expect(b, label).toBeDefined();
      expect(b!.disabled, label).toBe(false);
    }
  });
});

describe("the canvas is the editor, and the panel sits beside it (AC3)", () => {
  test("the graph opens as boxes and wires, drawn from the draft with no fetch", async () => {
    const calls = serve();
    const el = await mount();
    const before = calls.length;
    expect(cards(el).map((n) => n.textContent)).toHaveLength(2);
    expect(byLabel(el, "Route otherwise")).toBeDefined();
    click(palette(el, "Wait"));
    expect(cards(el)).toHaveLength(3);
    expect(calls.length).toBe(before);
  });

  test("selecting a step opens its properties BESIDE the canvas — never over it", async () => {
    const el = await mount();
    click(openStep(el, "Do the work"));
    expect(el.textContent).toContain("Instructions for the agent");
    // the thing the edit is being checked against is still on screen, which a modal cannot do
    expect(el.querySelector(".gb-canvas")).not.toBeNull();
    expect(document.querySelector("dialog[open]")).toBeNull();
  });

  test("selecting a route opens its condition, and the way back to the graph is a control", async () => {
    const el = await mount();
    click(byLabel(el, "Route otherwise"));
    expect(el.textContent).toContain("This route");
    click(byText(el, "The graph itself"));
    expect(el.textContent).toContain("What is it called?");
  });

  test("with nothing selected the panel is the graph's own", async () => {
    const el = await mount();
    expect(el.textContent).toContain("What is it called?");
    expect(el.textContent).toContain("What it works with");
  });
});

describe("the verdict is live, and drawn on the step that owns it (AC5)", () => {
  test("naming it clears the only complaint, with no network call at all", async () => {
    const calls = serve();
    const el = await mount();
    const before = calls.length;
    expect(labelled(el, "1 to sort out")).toBeDefined();
    type(nameBox(el), "my-review");
    expect(labelled(el, "nothing outstanding")).toBeDefined();
    expect(calls.length).toBe(before);
  });

  test("a step nothing reaches is marked on its own box, with a count", async () => {
    const el = await mount();
    type(nameBox(el), "my-review");
    click(palette(el, "Run a command"));
    const added = card(el, "command")!;
    expect(added.className).toContain("needs-input");
    expect(added.textContent).toContain("1");
  });

  test("an issue in the list takes you to the step it names", async () => {
    const el = await mount();
    type(nameBox(el), "my-review");
    click(palette(el, "Run a command"));
    click(byText(el, "The graph itself"));
    const issue = byLabel(el, "Go to the step this is about:")!;
    expect(issue.textContent).toContain("has nowhere to go next");
    click(issue);
    expect(el.textContent).toContain("What to run");
  });

  /**
   * HOW-22 review, finding 2. The collision used to be a field-error one pane rendered on its
   * own, outside the verdict: the rail counted it clean, the review said "Ready to save", and
   * the save replaced the other graph. It is ONE counted problem, and there is one copy of it.
   */
  test("a name the catalog already owns is a counted problem, printed once", async () => {
    serve({ status: 201, body: { ok: true } }, ["taken-name"]);
    const el = await mount();
    type(nameBox(el), "taken-name");
    expect(labelled(el, "1 to sort out")).toBeDefined();
    const errors = [...el.querySelectorAll(".field-error")].map((n) => n.textContent);
    expect(errors.filter((t) => t?.includes("already a graph called"))).toHaveLength(1);
    expect(el.textContent).toContain("1 thing to sort out");
    expect(el.textContent).not.toContain("Ready to save");
  });
});

describe("saving is the same PUT it always was (AC5), and it carries the arrangement (AC4)", () => {
  test("adding a step and saving PUTs the spec the canvas built, with its prompt body", async () => {
    const calls = serve();
    const el = await mount();
    type(nameBox(el), "my-review");
    nameNext(el, "Summarise the goal");
    click(palette(el, "Ask an agent"));
    type(el.querySelector('textarea[aria-label="the agent\'s instructions"]') as HTMLTextAreaElement, "Summarise {{ context.goal }}");
    // what the agent is GIVEN is read out of the instructions while they are being written —
    // there is no second place to declare it, and nothing to keep in sync by hand
    expect(el.textContent).toContain("This step will be given:");
    await act(async () => { byText(el, "Save and add to the catalog")!.click(); });

    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/api/graphs/my-review/builder");
    const body = put.body as { spec: GraphSpec; prompts: Record<string, string> };
    expect(body.spec.name).toBe("my-review");
    // HOW-26: the id and the prompt file are named after the STEP, not after the button that
    // made it. This asserted `ask-an-agent` / `my-review.ask-an-agent` before the name box.
    expect(body.spec.nodes.map((n) => n.id)).toContain("summarise-the-goal");
    expect(body.prompts["my-review.summarise-the-goal"]).toBe("Summarise {{ context.goal }}");
    // `reads` was derived from that body, never declared beside it
    expect(body.spec.nodes.find((n) => n.id === "summarise-the-goal")).toMatchObject({ reads: ["goal"] });
    // ...and every step says where it sits, so re-opening re-draws what was arranged
    for (const n of body.spec.nodes) expect(n.position, n.id).toEqual({ x: expect.any(Number), y: expect.any(Number) } as never);
  });

  test("a step added and then removed is not posted — and the save is not blocked by it", async () => {
    const calls = serve();
    const el = await mount();
    type(nameBox(el), "my-review");
    nameNext(el, "Summarise the goal");
    click(palette(el, "Ask an agent"));
    type(el.querySelector('textarea[aria-label="the agent\'s instructions"]') as HTMLTextAreaElement, "Summarise {{ context.goal }}");
    click(byText(el, "Remove this step"));
    // it has instructions, so it asks first — see "a removal that destroys text asks first"
    click(byText(el, "Remove the step and its instructions"));
    await act(async () => { byText(el, "Save and add to the catalog")!.click(); });

    const body = calls.find((c) => c.method === "PUT")!.body as { spec: GraphSpec; prompts: Record<string, string> };
    expect(Object.keys(body.prompts)).not.toContain("my-review.summarise-the-goal");
    // and what IS posted is exactly what the spec's own steps name — the server refuses any
    // other id, and used to refuse every save for the rest of the session over one
    expect(Object.keys(body.prompts).sort()).toEqual(
      body.spec.nodes.filter((n) => n.kind === "agent").map((n) => (n as Extract<NodeSpec, { kind: "agent" }>).prompt).sort(),
    );
  });

  test("the first save declares a create; the next one declares an update", async () => {
    const calls = serve();
    const el = await mount();
    type(nameBox(el), "my-review");
    await act(async () => { byText(el, "Save and add to the catalog")!.click(); });
    await act(async () => { byText(el, "Save changes")!.click(); });
    const puts = calls.filter((c) => c.method === "PUT").map((c) => (c.body as { intent: string }).intent);
    expect(puts).toEqual(["create", "update"]);
  });

  test("a refused save says why, in the server's words, and keeps the draft open", async () => {
    serve({ status: 422, body: { error: 'node "work" has nowhere to go next' } });
    const el = await mount();
    type(nameBox(el), "my-review");
    await act(async () => { byText(el, "Save and add to the catalog")!.click(); });
    expect(el.textContent).toContain("nowhere to go next");
    expect(byText(el, "Save and add to the catalog")).toBeDefined();
    expect(el.querySelector(".gb-canvas")).not.toBeNull();
  });
});

describe("nothing in the builder asks anyone to write TypeScript or JSON (AC2)", () => {
  test("the free-text boxes are prose and scripts — never a serialized graph", async () => {
    const el = await mount();
    click(palette(el, "Ask an agent"));
    for (const ta of [...el.querySelectorAll("textarea")] as HTMLTextAreaElement[]) {
      const value = ta.value.trim();
      expect(value.startsWith("{"), ta.getAttribute("aria-label") ?? "").toBe(false);
      expect(value, ta.getAttribute("aria-label") ?? "").not.toContain("defineGraph");
      expect(value, ta.getAttribute("aria-label") ?? "").not.toContain('"kind"');
    }
  });

  test("the condition vocabulary is pickers — an operator never writes a predicate", async () => {
    const el = await mount();
    click(openStep(el, "Do the work"));
    click(byText(el, "Add a condition"));
    const ops = [...el.querySelectorAll("select")].find((s) => s.getAttribute("aria-label")?.startsWith("how row 1 compares"));
    expect([...ops!.options].map((o) => o.textContent)).toEqual([
      "is", "is not", "is one of", "is yes", "is no", "has a value", "is empty",
    ]);
  });
});

/**
 * HOW-22 review, finding 3. "Add a condition" seeded `value: ""` without passing it through
 * coerceOperand, so on a yes/no field the row compiled to `flag == ''` — a predicate no runtime
 * value can satisfy, showing a BLANK operand next to a picker that only offers yes/no, and
 * saving clean. The seed now uses the same rule a kind change already did.
 */
describe("a condition row is born able to fire", () => {
  /** the branching pane on its own, over a draft whose first field has the kind under test */
  async function openBranching(kind: "boolean" | "number" | "text"): Promise<{ el: HTMLElement; latest: () => Draft }> {
    let draft: Draft = {
      saved: false,
      prompts: { "seed.work": "Do it." },
      spec: {
        version: 1, name: "seed", description: "",
        fields: [{ key: "flag", kind, scope: "sticky" }],
        inputs: [], entry: "work",
        nodes: [
          { id: "work", kind: "command", title: "Do it", run: "true", reads: [], writes: ["flag"] },
          { id: "done", kind: "terminal", outcome: "success" },
        ],
        edges: [{ from: "work", to: "done" }],
      },
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const render = () =>
      root!.render(
        <ToastProvider>
          <StepRoutes
            draft={draft}
            from="work"
            problems={problemsByPane(draftProblems(draft)).branching}
            dispatch={(a) => { draft = draftReducer(draft, a); render(); }}
          />
        </ToastProvider>,
      );
    await act(async () => { render(); });
    return { el: host, latest: () => draft };
  }

  const rowOperand = (draft: Draft) => {
    const when = draft.spec.edges.find((e) => e.when)?.when;
    return when && (when.op === "equals" || when.op === "not-equals") ? when.value : undefined;
  };

  test("on a yes/no field the row is born `flag == false`, and the picker agrees", async () => {
    const { el, latest } = await openBranching("boolean");
    click(byText(el, "Add a condition"));
    expect(rowOperand(latest())).toBe(false);
    const operand = [...el.querySelectorAll("select")].find((x) => x.getAttribute("aria-label") === "what flag is compared with")!;
    expect(operand.value).toBe("false");
    expect([...operand.options].find((o) => o.selected)?.textContent).toBe("no");
    // a row that can fire is not a problem, so the rail stays quiet
    expect(problemsByPane(draftProblems(latest())).branching).toEqual([]);
  });

  test("on a number field it is born 0, not the string that would never match", async () => {
    const { el, latest } = await openBranching("number");
    click(byText(el, "Add a condition"));
    expect(rowOperand(latest())).toBe(0);
    expect(problemsByPane(draftProblems(latest())).branching).toEqual([]);
  });

  test("on a text field the row starts empty — and is REPORTED rather than silently dead", async () => {
    const { el, latest } = await openBranching("text");
    click(byText(el, "Add a condition"));
    expect(rowOperand(latest())).toBe("");
    const problems = problemsByPane(draftProblems(latest())).branching;
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("compares `flag` with nothing");
  });
});

describe("a declared fact is never invisible-and-unremovable", () => {
  /** the step form on its own, over a draft that already carries the awkward declaration */
  async function mountStepFields(draft: Draft): Promise<HTMLElement> {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<ToastProvider><StepFields draft={draft} id="clean" dispatch={() => {}} /></ToastProvider>);
    });
    return host;
  }

  /** the Checkbox primitive ties its text to the box by `for`, not by wrapping it */
  const tickboxes = (el: HTMLElement) =>
    ([...el.querySelectorAll("input[type=checkbox]")] as HTMLInputElement[]).map((box) => ({
      box,
      label: el.querySelector(`label[for="${box.id}"]`)?.textContent ?? "",
    }));

  const withWorktree = (action: "create" | "remove", writes: string[]): Draft => ({
    saved: false,
    prompts: {},
    spec: {
      version: 1, name: "wt", description: "",
      fields: [{ key: "worktree.clean", kind: "boolean", scope: "per-visit" }],
      inputs: [], entry: "clean",
      nodes: [{ id: "clean", kind: "worktree", title: "Clean up", action, writes }, { id: "done", kind: "terminal", outcome: "success" }],
      edges: [{ from: "clean", to: "done" }],
    },
  });

  test("a key a MAKE step should not produce is still shown, ticked, so it can be unticked", async () => {
    // the reducer keeps writes ⊆ emittable, so this state only arrives from a hand-edited
    // file or a PUT — which is exactly when the operator most needs to see it. Rendering
    // `only` alone hid it behind a picker that offered nothing (HOW-22 review, finding 3).
    const el = await mountStepFields(withWorktree("create", ["worktree.clean"]));
    const row = tickboxes(el).find((t) => t.label.includes("worktree.clean"));
    expect(row).toBeDefined();
    expect(row!.box.checked).toBe(true);
  });

  test("a clean-up step still offers exactly the two facts its executor emits", async () => {
    const el = await mountStepFields(withWorktree("remove", ["worktree.clean"]));
    const labels = tickboxes(el).map((t) => t.label).filter((t) => t.includes("worktree.clean") || t.includes("outcome"));
    expect(labels).toHaveLength(2);
  });

  test("a make step with nothing declared offers nothing, and says why", async () => {
    const el = await mountStepFields(withWorktree("create", []));
    expect(el.textContent).toContain("Making a worktree reports nothing");
    expect(tickboxes(el).filter((t) => t.label.includes("worktree."))).toHaveLength(0);
  });
});

/**
 * HOW-22 review, round 4. Three of the five findings this round lived in a COMPONENT — a
 * picture that asserted a draft was finished, and two boxes that mirrored stored MEANING back
 * at the keystrokes that produced it. The existing suite could not see any of them: it drives
 * the reducer directly and never renders a pane or simulates a keystroke. So these tests are
 * weighted to the real panes, driven by real events.
 */

/** the fields pane on its own, over a draft the caller supplies */
async function openFields(start: Draft): Promise<{ el: HTMLElement; latest: () => Draft }> {
  let draft = start;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const render = () =>
    root!.render(
      <ToastProvider>
        <FieldsPane draft={draft} dispatch={(a) => { draft = draftReducer(draft, a); render(); }} />
      </ToastProvider>,
    );
  await act(async () => { render(); });
  return { el: host, latest: () => draft };
}

/** the branching pane over a draft whose one testable field has the kind under test */
async function openRows(field: FieldSpec): Promise<{ el: HTMLElement; latest: () => Draft; setKind: (k: FieldKind) => void }> {
  let draft: Draft = {
    saved: false,
    prompts: { "seed.work": "Do it." },
    spec: {
      version: 1, name: "seed", description: "",
      fields: [field, { key: "other", kind: "text", scope: "sticky" }],
      inputs: [], entry: "work",
      nodes: [
        { id: "work", kind: "command", title: "Do it", run: "true", reads: [], writes: [field.key, "other"] },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
      edges: [{ from: "work", to: "done" }],
    },
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const render = () =>
    root!.render(
      <ToastProvider>
        <StepRoutes
          draft={draft}
          from="work"
          problems={problemsByPane(draftProblems(draft)).branching}
          dispatch={(a) => { draft = draftReducer(draft, a); render(); }}
        />
      </ToastProvider>,
    );
  await act(async () => { render(); });
  return {
    el: host,
    latest: () => draft,
    setKind: (k) => { draft = draftReducer(draft, { type: "update-field", key: field.key, patch: { kind: k } }); act(() => { render(); }); },
  };
}

const box = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll("input")].find((x) => x.getAttribute("aria-label") === label) as HTMLInputElement;
/**
 * One keystroke at a time, the way a person produces "3.5".
 *
 * Each key APPENDS to what the box is currently SHOWING, which is the whole point: a browser
 * types onto the rendered value, not onto some absolute string the test had in mind. Setting
 * the full prefix each time would quietly repair the very defect under test — the box would
 * never be asked to carry `3.` forward, so `35` could not happen.
 */
const typeEach = (get: () => HTMLInputElement, text: string) => {
  type(get(), "");                                  // select-all, as an operator would
  for (const ch of text) type(get(), get().value + ch);
};

/**
 * One key at a time, the way a BROWSER applies one: the character REPLACES the current
 * selection, and only then does the box hold it.
 *
 * `typeEach` above appends to `value` and so types straight past a box that keeps
 * re-selecting itself between keys — which is exactly the defect this helper exists to
 * catch (HOW-26: the add-a-step name box re-selected its whole value on every keystroke, so
 * "Implement the change" was added as a step called `e`).
 */
const typeKeys = (get: () => HTMLInputElement, text: string) => {
  for (const ch of text) {
    const box = get();
    const from = box.selectionStart ?? box.value.length;
    const to = box.selectionEnd ?? from;
    type(box, box.value.slice(0, from) + ch + box.value.slice(to));
  }
};
const rowPredicate = (d: Draft) => d.spec.edges.find((e) => e.when)?.when;

describe("a box keeps what was typed into it (finding 2)", () => {
  test("a number operand survives the decimal point on its way through", async () => {
    const { el, latest } = await openRows({ key: "count", kind: "number", scope: "sticky" });
    click(byText(el, "Add a condition"));
    typeEach(() => box(el, "what count is compared with"), "3.5");
    // before: "3." read back as "3", so the next key made 35 and specProblems said nothing
    expect(rowPredicate(latest())).toMatchObject({ value: 3.5 });
    expect(box(el, "what count is compared with").value).toBe("3.5");
  });

  test("...and the minus sign, which used to make a negative operand untypeable", async () => {
    const { el, latest } = await openRows({ key: "count", kind: "number", scope: "sticky" });
    click(byText(el, "Add a condition"));
    typeEach(() => box(el, "what count is compared with"), "-1");
    expect(rowPredicate(latest())).toMatchObject({ value: -1 });
  });

  test("`is one of` can be given a SECOND value, which the swallowed comma made impossible", async () => {
    const { el, latest } = await openRows({ key: "verdict", kind: "text", scope: "sticky" });
    click(byText(el, "Add a condition"));
    const op = [...el.querySelectorAll("select")].find((s) => s.getAttribute("aria-label") === "how row 1 compares")!;
    type(op, "one-of");
    typeEach(() => box(el, "what verdict is compared with"), "pass, warn");
    expect(rowPredicate(latest())).toMatchObject({ op: "one-of", values: ["pass", "warn"] });
    expect(box(el, "what verdict is compared with").value).toBe("pass, warn");
  });

  test("the box follows the DRAFT when the draft says something else — it is not uncontrolled", async () => {
    const { el, latest, setKind } = await openRows({ key: "count", kind: "number", scope: "sticky" });
    click(byText(el, "Add a condition"));
    typeEach(() => box(el, "what count is compared with"), "3.");
    expect(box(el, "what count is compared with").value).toBe("3.");
    // the kind flips from another pane: `3.` no longer MEANS what the draft holds, so the box
    // stops showing it. This is the equivalence branch, and what stops the hook drifting.
    setKind("text");
    expect(box(el, "what count is compared with").value).toBe(String(
      (rowPredicate(latest()) as { value: unknown }).value,
    ));
    expect(box(el, "what count is compared with").value).not.toBe("3.");
  });

  test("leaving the box settles it on what the spec actually holds", async () => {
    const { el, latest } = await openRows({ key: "count", kind: "number", scope: "sticky" });
    click(byText(el, "Add a condition"));
    type(box(el, "what count is compared with"), "-");
    expect(rowPredicate(latest())).toMatchObject({ value: 0 });
    // React maps onBlur onto the bubbling focusout event, which is what a real blur fires
    act(() => { box(el, "what count is compared with").dispatchEvent(new window.FocusEvent("focusout", { bubbles: true })); });
    expect(box(el, "what count is compared with").value).toBe("0");
  });

  test("a multi-value choice FIELD is typeable too — the same defect, the other box", async () => {
    const { el, latest } = await openFields({
      saved: false, prompts: {},
      spec: {
        version: 1, name: "c", description: "",
        fields: [{ key: "verdict", kind: "choice", scope: "sticky", choices: [] }],
        inputs: ["verdict"], entry: "done",
        nodes: [{ id: "done", kind: "terminal", outcome: "success" }],
        edges: [],
      },
    });
    typeEach(() => box(el, "the choices for verdict"), "pass, reject");
    expect(latest().spec.fields[0]!.choices).toEqual(["pass", "reject"]);
    expect(box(el, "the choices for verdict").value).toBe("pass, reject");
  });
});

describe("clearing a field's name is not a rename (finding 5)", () => {
  test("the box empties, the draft does not move, and retyping renames EVERYTHING in one go", async () => {
    const start = PRESETS.find((p) => p.id === "code")!.build("p5");
    // `goal` is the preset's FIRST field, which is the row the name box below belongs to —
    // asserted rather than assumed, so a preset reshuffle fails here and not mysteriously later
    expect(start.spec.fields[0]!.key).toBe("goal");
    const { el, latest } = await openFields(start);
    // the label names the CURRENT key, so it moves with every keystroke of the rename
    const name = () => el.querySelector("input.font-mono") as HTMLInputElement;

    type(name(), "");
    // the box shows what was typed; the draft keeps the name it had, and says nothing is wrong
    expect(name().value).toBe("");
    expect(latest().spec.fields.map((f) => f.key)).toEqual(start.spec.fields.map((f) => f.key));
    expect(draftProblems(latest())).toEqual([]);

    typeEach(name, "objective");

    const d = latest();
    expect(d.spec.fields.some((f) => f.key === "objective")).toBe(true);
    expect(d.spec.fields.some((f) => f.key === "goal")).toBe(false);
    expect(d.spec.inputs).toContain("objective");
    expect(d.spec.inputs).not.toContain("goal");
    for (const [id, body] of Object.entries(d.prompts)) {
      expect(body, id).not.toContain("{{ context.goal }}");
      expect(templateReads(body).includes("goal"), id).toBe(false);
    }
    for (const n of d.spec.nodes) if (n.kind === "agent") expect(n.reads, n.id).not.toContain("goal");
    for (const e of d.spec.edges) expect(e.when?.key, e.from).not.toBe("goal");
    // the invariant the whole cascade exists for
    expect(draftProblems(d)).toEqual([]);
  });

  test("the reducer treats a blank key as nothing happening, and still applies the rest", async () => {
    const start = PRESETS.find((p) => p.id === "code")!.build("p5b");
    expect(apply(start, { type: "update-field", key: "goal", patch: { key: "" } })).toEqual(start);
    expect(apply(start, { type: "update-field", key: "goal", patch: { key: "   " } })).toEqual(start);
    // a kind arriving with the blank name still lands; the name does not
    const both = apply(start, { type: "update-field", key: "goal", patch: { key: "", kind: "json" } });
    expect(both.spec.fields.find((f) => f.key === "goal")!.kind).toBe("json");
    expect(both.spec.fields.some((f) => f.key === "")).toBe(false);
  });
});

describe("a stale path cannot hide on a field that cannot hold one (finding 3)", () => {
  test("re-pointing a json row at a text field REPAIRS it rather than reporting it", async () => {
    const { el, latest } = await openRows({ key: "blob", kind: "json", scope: "sticky" });
    click(byText(el, "Add a condition"));
    type(box(el, "which part of blob row 1 tests"), "outcome");
    type(box(el, "what blob is compared with"), "reject");
    expect(rowPredicate(latest())).toMatchObject({ path: "outcome" });

    const key = [...el.querySelectorAll("select")].find((s) => s.getAttribute("aria-label") === "the field row 1 tests")!;
    type(key, "other");
    // the inner-name box is gone with the json kind, so a surviving path would be unremovable
    expect(box(el, "which part of other row 1 tests")).toBeUndefined();
    expect(rowPredicate(latest())).not.toHaveProperty("path");
  });

  test("flipping the FIELD's kind drops the path from every row that named it", async () => {
    const { el, latest, setKind } = await openRows({ key: "blob", kind: "json", scope: "sticky" });
    click(byText(el, "Add a condition"));
    type(box(el, "which part of blob row 1 tests"), "outcome");
    type(box(el, "what blob is compared with"), "reject");
    setKind("text");
    expect(rowPredicate(latest())).not.toHaveProperty("path");
    // nothing BLOCKS: the row is legal again. It is now ADVISED against — `blob` is free text
    // and the row compares it with a word (HOW-26) — which is a different sentence entirely.
    expect(problemsByPane(bySeverity(draftProblems(latest())).blocking).branching).toEqual([]);
  });
});

describe("useTypedText: controlled by meaning, not by spelling", () => {
  /** a box over a value stored as a NUMBER, the smallest form of what the operand box does */
  async function openBox(): Promise<{ input: () => HTMLInputElement; set: (n: number) => void }> {
    let stored = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    function Box() {
      const [shown, setTyped] = useTypedText(String(stored), (t) => String(Number(t.trim() === "" ? 0 : t) || 0));
      return (
        <Input
          aria-label="box" value={shown}
          onChange={(e) => { setTyped(e.target.value); stored = Number(e.target.value) || 0; render(); }}
        />
      );
    }
    const render = () => root!.render(<Box />);
    await act(async () => { render(); });
    return {
      input: () => box(host!, "box"),
      set: (n) => { stored = n; act(() => { render(); }); },
    };
  }

  test("what was typed stays while it still MEANS what is stored, and follows the store when it does not", async () => {
    const { input, set } = await openBox();
    typeEach(input, "3.");
    expect(input().value).toBe("3.");   // 3. means 3, which is what is stored
    set(9);                              // ...and now it does not
    expect(input().value).toBe("9");
  });
});

/**
 * HOW-23 review, finding 2. `runs:launch` reads `plan.slices` and `tickets` BY NAME and the
 * executor refuses a node that does not declare them — but a command step has no reads control
 * at all, so an entry in the picker without seeded reads would be a step guaranteed to park and
 * impossible to fix from the builder. The seeding is a convenience, not the gate: what makes it
 * safe is that specProblems() reports the gap either way (core/graph-spec.test.ts).
 */
describe("a built-in that works from named fields arrives wired up", () => {
  const fanOutDraft = (): Draft => ({
    saved: false,
    prompts: {},
    spec: {
      version: 1, name: "fan", description: "",
      fields: [
        { key: "plan.slices", kind: "json", scope: "sticky" },
        { key: "tickets", kind: "json", scope: "sticky" },
        { key: "launched", kind: "json", scope: "sticky" },
      ],
      inputs: ["plan.slices", "tickets"], entry: "fan-out",
      nodes: [
        { id: "fan-out", kind: "command", title: "Fan it out", run: "probe:pr", reads: [], writes: [] },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
      edges: [{ from: "fan-out", to: "done" }],
    },
  });

  async function openFanOut(): Promise<{ el: HTMLElement; latest: () => Draft }> {
    let draft = fanOutDraft();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const render = () =>
      root!.render(
        <ToastProvider>
          <StepFields draft={draft} id="fan-out" dispatch={(a) => { draft = draftReducer(draft, a); render(); }} />
        </ToastProvider>,
      );
    await act(async () => { render(); });
    return { el: host, latest: () => draft };
  }

  const step = (d: Draft) => d.spec.nodes.find((n) => n.id === "fan-out") as Extract<NodeSpec, { kind: "command" }>;
  const whatToRun = (el: HTMLElement) => [...el.querySelectorAll("select")].find((s) => s.value === "probe:pr" || s.value === "runs:launch" || s.value === "shell")!;

  test("picking it seeds what it works from, shows it, and leaves the draft clean", async () => {
    const { el, latest } = await openFanOut();
    type(whatToRun(el), "runs:launch");

    expect(step(latest()).reads).toEqual(["plan.slices", "tickets"]);
    expect(el.textContent).toContain("It works from");
    // …and the wired-up step is not reported, by either half of the contract
    expect(draftProblems({ ...latest(), spec: { ...latest().spec, nodes: latest().spec.nodes.map((n) => (n.id === "fan-out" ? { ...step(latest()), writes: ["launched"] } : n)) } }))
      .toEqual([]);
  });

  test("switching to a script of my own takes the built-in's reads back off", async () => {
    const { el, latest } = await openFanOut();
    type(whatToRun(el), "runs:launch");
    expect(step(latest()).reads).toEqual(["plan.slices", "tickets"]);
    type(whatToRun(el), "shell");
    expect(step(latest()).run).toBe("");
    expect(step(latest()).reads).toEqual([]);
    expect(el.textContent).not.toContain("It works from");
  });

  test("only this built-in claims to work from anything — the others are told nothing about reads", async () => {
    const { el } = await openFanOut();
    expect(el.textContent).not.toContain("It works from");
  });
});

/**
 * HOW-22 review, finding 1, in its HOW-24 form. The picture used to assert that a draft was
 * finished — an edge whose target was unpicked had no position to draw between, and the `!`
 * took the whole app down with it, unsaved draft included, because web/app has no error
 * boundary. React Flow simply does not draw an edge whose endpoint it cannot find, and what
 * is missing is still said in WORDS, in the panel that fixes it.
 */
describe("the canvas never takes the builder down with it (finding 1)", () => {
  test('picking "pick a step" leaves the builder standing and reports the row in words', async () => {
    const el = await mount();
    type(nameBox(el), "my-review");
    click(openStep(el, "Do the work"));
    click(byText(el, "Add a condition"));
    const to = [...el.querySelectorAll("select")].find((s) => s.getAttribute("aria-label") === "where row 1 goes")!;
    type(to, "");

    expect(el.querySelector(".gb-canvas")).not.toBeNull();
    expect(cards(el).length).toBeGreaterThan(0);
    expect(labelled(el, "1 to sort out")).toBeDefined();
    expect(el.textContent).toContain('has a "go to" with no step picked');
  });
});

describe("the canvas holds the frames; the draft holds the result (finding 1)", () => {
  test("a selected step is moved by the arrow keys, and the move is in the saved graph (AC6)", async () => {
    const calls = serve();
    const el = await mount();
    type(nameBox(el), "my-review");
    // the whole keyboard path, and every link in it already existed but the last: Tab to the
    // card's own control, Enter to select it, then arrows. React Flow's `isInputDOMNode`
    // exempts form controls, NOT a Button, so the keydown reaches the node wrapper's handler.
    click(openStep(el, "Do the work"));
    const before = translation(placed(card(el, "agent")!));
    nudge(el, "Do the work", "ArrowRight");
    nudge(el, "Do the work", "ArrowDown");
    await act(async () => { byText(el, "Save and add to the catalog")!.click(); });

    // the PICTURE moved...
    const after = translation(placed(card(el, "agent")!));
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeGreaterThan(before.y);
    // ...and so did the SPEC, which is the half a controlled `nodes` with no `onNodesChange`
    // was throwing away: the position would not have survived a reload
    const spec = saved(calls);
    expect(at(spec, "work").x).toBeCloseTo(after.x, 5);
    expect(at(spec, "work").y).toBeCloseTo(after.y, 5);
  });

  test("one drag is ONE edit, however many frames it took", () => {
    const moves: DraftAction[] = [];
    const dispatch = (a: DraftAction) => moves.push(a);
    // three frames under the pointer, then the release. Driving React Flow's real pointer
    // pipeline needs a layout engine happy-dom does not have, so the property is asserted at
    // the handler the pipeline calls — which is where "one gesture, one `draftProblems()` run"
    // is actually decided.
    const flying = [
      applyNodeChangesToDraft([{ id: "work", type: "position", position: { x: 10, y: 10 }, dragging: true }], dispatch),
      applyNodeChangesToDraft([{ id: "work", type: "position", position: { x: 20, y: 30 }, dragging: true }], dispatch),
      applyNodeChangesToDraft([{ id: "work", type: "position", position: { x: 33, y: 44 }, dragging: true }], dispatch),
    ];
    expect(moves).toEqual([]);
    // the frames are drawn from the overlay, not from the draft
    expect(flying.map((f) => f?.get("work"))).toEqual([{ x: 10, y: 10 }, { x: 20, y: 30 }, { x: 33, y: 44 }]);

    const settled = applyNodeChangesToDraft(
      [{ id: "work", type: "position", position: { x: 33, y: 44 }, dragging: false }],
      dispatch,
    );
    expect(settled).toBeNull();
    expect(moves).toEqual([{ type: "move-node", id: "work", position: { x: 33, y: 44 } }]);
  });

  test("a change that is not a position leaves the overlay and the draft alone", () => {
    const moves: DraftAction[] = [];
    const dispatch = (a: DraftAction) => moves.push(a);
    // `dimensions` and `select` were already being discarded when EVERY change was; ignoring
    // them here is byte-for-byte that behaviour, so nothing that works can regress through it
    const flying = applyNodeChangesToDraft(
      [
        { id: "work", type: "dimensions", dimensions: { width: 180, height: 64 } },
        { id: "work", type: "select", selected: true },
        // ...and a position that cannot round-trip through JSON is not a position
        { id: "work", type: "position", position: { x: NaN, y: 4 } },
      ],
      dispatch,
    );
    expect(flying).toBeNull();
    expect(moves).toEqual([]);
  });
});

describe("nothing is destroyed by a stray keystroke (finding 2)", () => {
  test("Backspace with a step selected destroys neither the step nor its instructions", async () => {
    const calls = serve();
    const el = await mount();
    type(nameBox(el), "my-review");
    click(openStep(el, "Do the work"));
    type(el.querySelector('textarea[aria-label="the agent\'s instructions"]') as HTMLTextAreaElement, "Summarise {{ context.goal }}");
    // React Flow binds its delete key on `document`, and `isInputDOMNode` exempts only
    // INPUT/SELECT/TEXTAREA — not the Button that is the documented way into a step. So this
    // is the keystroke that used to take the step AND its prompt body, with no undo.
    // awaited: `deleteElements` is async (it may consult `onBeforeDelete`), so a synchronous
    // assertion after the keydown would pass whether the key is live or not
    await act(async () => { document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Backspace", bubbles: true })); });
    expect(card(el, "agent")).toBeDefined();

    await act(async () => { byText(el, "Save and add to the catalog")!.click(); });
    const body = calls.find((c) => c.method === "PUT")!.body as { spec: GraphSpec; prompts: Record<string, string> };
    // the payload is the assertion that matters: the finding was about losing TEXT
    expect(body.spec.nodes.map((n) => n.id)).toContain("work");
    expect(body.prompts["my-review.work"]).toBe("Summarise {{ context.goal }}");
  });

  test("Delete does nothing either — the key is off, not moved one modifier away", async () => {
    const el = await mount();
    click(openStep(el, "Do the work"));
    await act(async () => { document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Delete", bubbles: true })); });
    expect(card(el, "agent")).toBeDefined();
  });

  test("a removal that destroys text asks first, and the default answer is no", async () => {
    const el = await mount();
    click(openStep(el, "Do the work"));
    type(el.querySelector('textarea[aria-label="the agent\'s instructions"]') as HTMLTextAreaElement, "Summarise {{ context.goal }}");
    click(byText(el, "Remove this step"));

    const dialog = openDialog();
    expect(dialog).not.toBeNull();
    // it says what goes, in the operator's words, rather than "are you sure?"
    expect(dialog!.textContent).toContain("instructions you wrote");
    expect(dialog!.getAttribute("role")).toBe("alertdialog");
    expect(card(el, "agent")).toBeDefined();

    click(byText(el, "Cancel"));
    expect(openDialog()).toBeNull();
    expect(card(el, "agent")).toBeDefined();
  });

  test("...and confirming takes the step and the instructions it owned", async () => {
    const calls = serve();
    const el = await mount();
    type(nameBox(el), "my-review");
    click(openStep(el, "Do the work"));
    type(el.querySelector('textarea[aria-label="the agent\'s instructions"]') as HTMLTextAreaElement, "Summarise {{ context.goal }}");
    click(byText(el, "Remove this step"));
    click(byText(el, "Remove the step and its instructions"));

    expect(card(el, "agent")).toBeUndefined();
    await act(async () => { byText(el, "Save and add to the catalog")!.click(); });
    const body = calls.find((c) => c.method === "PUT")!.body as { spec: GraphSpec; prompts: Record<string, string> };
    expect(body.spec.nodes.map((n) => n.id)).not.toContain("work");
    expect(Object.keys(body.prompts)).not.toContain("my-review.work");
  });

  test("removing a step with nothing at stake does not ask", async () => {
    const el = await mount();
    click(palette(el, "Wait"));
    click(byText(el, "Remove this step"));
    // a wait step dropped by mistake should not need a dialog; one that fires when nothing is
    // at stake is the kind that gets dismissed reflexively
    expect(openDialog()).toBeNull();
    expect(card(el, "wait")).toBeUndefined();
  });
});

/** a Select by its spoken name — `box` is the same thing for inputs */
const picker = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll("select")].find((x) => x.getAttribute("aria-label") === label) as HTMLSelectElement;
/** every "Otherwise" row the panel draws for one step, however many that is */
const otherwiseRows = (el: HTMLElement, from: string) =>
  [...el.querySelectorAll("select")].filter((s) => {
    const label = s.getAttribute("aria-label") ?? "";
    return label.startsWith(`where ${from} `) && label.includes("no row fits");
  });

describe("a route removed is a route the panel stops editing (finding 1)", () => {
  /** the doc preset's four edges, of which the reject branch is index 1 — NOT the last */
  async function threeOrMoreRoutes(): Promise<HTMLElement> {
    const el = await mount();
    type(nameBox(el), "my-review");
    click(byText(el, "Draft, review, revise"));
    return el;
  }

  test("removing a route that is not the last one closes the panel", async () => {
    const el = await threeOrMoreRoutes();
    click(byLabel(el, "Route review_verdict == 'reject'"));
    expect(el.textContent).toContain("This route");

    click(byLabel(el, "remove this route"));
    // `remove-edge` slides every later edge down one, so a panel that kept rendering would now
    // be editing the pass branch under a card still captioned "This route"
    expect(byLabel(el, "remove this route")).toBeUndefined();
    expect(el.textContent).not.toContain("This route");
    expect(el.textContent).toContain("What is it called?");
  });

  test("a second press cannot destroy the route that slid into its place", async () => {
    const calls = serve();
    const el = await threeOrMoreRoutes();
    click(byLabel(el, "Route review_verdict == 'reject'"));
    click(byLabel(el, "remove this route"));
    expect(byLabel(el, "remove this route")).toBeUndefined();

    // asserted through the PUT rather than the DOM: the property at risk is a route being
    // destroyed in the artifact, and the pass branch is what index 1 became
    await act(async () => { byText(el, "Save and add to the catalog")!.click(); });
    expect(saved(calls).edges.map((e) => `${e.from}->${e.to}`))
      .toEqual(["draft->review", "review->done", "revise->review"]);
  });

  test("removing the LAST route still closes the panel", async () => {
    // the shell's own `index >= edges.length` guard — kept, and pinned beside the callback so
    // the two cannot drift apart
    const el = await mount();
    click(byLabel(el, "Route otherwise"));
    expect(el.textContent).toContain("This route");
    click(byLabel(el, "remove this route"));
    expect(byLabel(el, "remove this route")).toBeUndefined();
    expect(el.textContent).toContain("What is it called?");
  });
});

describe('a second "Otherwise" is drawn, not deleted (finding 2)', () => {
  /** review ends up with two unconditional routes and no conditional one, made the way an
   *  operator would: the same control, twice, on two different wires */
  async function twoOtherwise(): Promise<HTMLElement> {
    const el = await mount();
    type(nameBox(el), "my-review");
    click(byText(el, "Draft, review, revise"));
    click(byLabel(el, "Route review_verdict == 'reject'"));
    click(byText(el, 'Make this the "Otherwise"'));
    click(byLabel(el, "Route review_verdict == 'pass'"));
    click(byText(el, 'Make this the "Otherwise"'));
    return el;
  }

  test("an edit to the routes keeps a second Otherwise", async () => {
    const calls = serve();
    const el = await twoOtherwise();
    click(openStep(el, "Review it"));
    // `set-branching` replaces the step's whole outgoing list, so ANY edit here used to drop
    // the route the panel had no row for
    type(picker(el, "where review goes when no row fits"), "draft");

    await act(async () => { byText(el, "Save and add to the catalog")!.click(); });
    expect(saved(calls).edges.filter((e) => e.from === "review"))
      .toEqual([{ from: "review", to: "draft" }, { from: "review", to: "done" }]);
  });

  test("both are rows, and the second can be removed", async () => {
    const calls = serve();
    const el = await twoOtherwise();
    click(openStep(el, "Review it"));
    expect(picker(el, "where review goes when no row fits")).toBeDefined();
    expect(picker(el, "where review also goes when no row fits (2)")).toBeDefined();

    click(byLabel(el, "remove otherwise 2"));
    await act(async () => { byText(el, "Save and add to the catalog")!.click(); });
    expect(saved(calls).edges.filter((e) => e.from === "review")).toEqual([{ from: "review", to: "revise" }]);
  });

  test("the message and the rows agree", async () => {
    const el = await twoOtherwise();
    click(openStep(el, "Review it"));
    // core already refuses this, in the operator's words and on this step. The defect was that
    // it named a row the panel did not draw, so it could only be acted on out on the canvas.
    expect(el.textContent).toContain('has more than one "Otherwise"');
    expect(otherwiseRows(el, "review")).toHaveLength(2);
  });

  test("one Otherwise is still one row, and 'pause and ask me' still removes it", async () => {
    const calls = serve();
    const el = await mount();
    type(nameBox(el), "my-review");
    click(openStep(el, "Do the work"));
    expect(otherwiseRows(el, "work")).toHaveLength(1);

    type(picker(el, "where work goes when no row fits"), "");
    await act(async () => { byText(el, "Save and add to the catalog")!.click(); });
    expect(saved(calls).edges.filter((e) => e.from === "work")).toEqual([]);
  });
});
// ---- HOW-26: easy AND correct --------------------------------------------------------------

/**
 * The step is NAMED before it exists, so its id and its prompt file are named after it.
 *
 * The ticket's graph came out as `ask-an-agent`, `ask-an-agent-2` … `ask-an-agent-8` with
 * `one-shot-ticket-implementation.ask-an-agent-8.md` beside it, because `newStep` was seeded
 * with the MENU LABEL and the id is frozen the moment the step exists. The title typed
 * afterwards never reached either, which is the whole of "everything looks weird".
 *
 * On the canvas (HOW-24) the kind is a thing you pick up, so the name cannot be asked for by
 * the button — a drop starts in the palette and lands on the canvas. It is one box ABOVE the
 * six, read by both gestures and spent by whichever one places the step.
 */
describe("a step is named when it is added (HOW-26)", () => {
  test("the name becomes the id, and the id becomes the prompt file", () => {
    const draft = PRESETS[0]!.build("my-graph");
    const made = newStep(draft.spec, "agent", "Implement the change");
    expect(made.node.id).toBe("implement-the-change");
    expect(made.node.kind === "agent" && made.node.prompt).toBe("my-graph.implement-the-change");
  });

  test("two steps with the same name still get distinct ids, and neither is named after the menu", () => {
    let draft = PRESETS[0]!.build("my-graph");
    for (let i = 0; i < 2; i++) draft = apply(draft, { type: "add-step", ...newStep(draft.spec, "agent", "Review it") });
    expect(draft.spec.nodes.map((n) => n.id)).toEqual(["work", "done", "review-it", "review-it-2"]);
  });

  /**
   * A step id is now derived from OPERATOR FREE TEXT, and SPEC_NODE_ID wants a leading
   * letter. Before the name box the seed was always a menu label, so this could not fire;
   * afterwards "1st draft" produced `1st-draft`, which every save refused — and the repair
   * the form offers suggested the same illegal id again, so it said nothing anyone could act on.
   */
  test("a name that does not start with a letter still yields a usable id", () => {
    const spec = PRESETS[0]!.build("my-graph").spec;
    const id = nextNodeId(spec, "1st draft");
    expect(id).toBe("step-1st-draft");
    expect(SPEC_NODE_ID.test(id)).toBe(true);
  });

  test("...and a draft built from that name has nothing blocking it", () => {
    let draft = PRESETS[0]!.build("my-graph");
    draft = apply(
      draft,
      { type: "add-step", ...newStep(draft.spec, "agent", "1st draft") },
      { type: "set-branching", from: "work", edges: [{ to: "step-1st-draft" }] },
      { type: "set-branching", from: "step-1st-draft", edges: [{ to: "done" }] },
    );
    // before: '"1st-draft" is not a usable step id.', blocking, on every save
    expect(bySeverity(draftProblems(draft)).blocking).toEqual([]);
  });

  test("an approval step derives its two fields from the id, so they must be legal too", () => {
    const spec = PRESETS[0]!.build("my-graph").spec;
    const made = newStep(spec, "approval", "1st draft");
    expect(made.fields!.length).toBe(2);
    for (const f of made.fields!) expect(SPEC_FIELD_KEY.test(f.key)).toBe(true);
  });

  test("a seed with no letters in it at all still names something", () => {
    const spec = PRESETS[0]!.build("my-graph").spec;
    for (const seed of ["!!!", "", "   ", "---"]) expect(nextNodeId(spec, seed)).toBe("step");
  });

  test("a long name is cut short without leaving a trailing hyphen", () => {
    const spec = PRESETS[0]!.build("my-graph").spec;
    const id = nextNodeId(spec, "implement the changes the reviewer asked for today");
    expect(id.endsWith("-")).toBe(false);
    expect(SPEC_NODE_ID.test(id)).toBe(true);
    expect(id.length).toBeLessThanOrEqual(32);
  });

  /**
   * ONE fallback for a step that was not named, and it lives in slug(). A second fallback in
   * the preview and a different one at the add is how an empty box came to promise one id and
   * create another — and the one it created was `ask-an-agent`, the id shape this whole ticket
   * exists to eliminate, reached through the affordance added to eliminate it.
   */
  describe("an un-named step is named once, in one place", () => {
    test("newStep on an empty name gives slug()'s answer, and no title at all", () => {
      const spec = PRESETS[0]!.build("my-graph").spec;
      const made = newStep(spec, "agent", "");
      expect(made.node.id).toBe("step");
      expect(made.node.kind === "agent" && made.node.prompt).toBe("my-graph.step");
      // NOT "" — stepTitle() falls back to the id, and an empty string would be written into
      // the saved module as `"title": ""`, which reads as a title someone chose
      expect(made.node.title).toBeUndefined();
      expect(nextNodeId(spec, "")).toBe(made.node.id);
    });

    test("...and a second one is step-2, preview and creation agreeing again", () => {
      let draft = PRESETS[0]!.build("my-graph");
      draft = apply(draft, { type: "add-step", ...newStep(draft.spec, "agent", "") });
      expect(nextNodeId(draft.spec, "")).toBe("step-2");
      expect(newStep(draft.spec, "agent", "").node.id).toBe("step-2");
    });
  });

  /**
   * A name typed the way a browser types one — key by key, each character REPLACING the
   * current selection. The wizard's version of this box re-selected its whole value between
   * keys (an effect that depended on an object `onChange` rebuilt per character), so
   * "Implement the change" was added as a step called `e`: the headline fix, defeated by its
   * own affordance. `type()` sets the whole value in ONE event and cannot see it.
   */
  test("a name typed one key at a time is the name the step gets", async () => {
    const el = await mount();
    typeKeys(() => nextNameBox(el), "Implement the change");
    expect(nextNameBox(el).value).toBe("Implement the change");
    expect(previewedId(el)).toBe("implement-the-change");
    click(palette(el, "Ask an agent"));
    expect(openStep(el, "Implement the change")).toBeDefined();
  });

  test("a named step is added by a palette click, id and prompt file to match", async () => {
    const el = await mount();
    nameNext(el, "Implement the change");
    // the preview under the box promises an id; it must be the one the step actually gets
    expect(previewedId(el)).toBe("implement-the-change");
    click(palette(el, "Ask an agent"));
    expect(openStep(el, "Implement the change")).toBeDefined();
  });

  test("...and by a DROP, which is the same creation path with a place attached", async () => {
    const el = await mount();
    nameNext(el, "Hold on");
    drop(el, "wait", { x: 300, y: 200 });
    expect(openStep(el, "Hold on")).toBeDefined();
  });

  test("the name is spent by the step it named, so the next one is not <id>-2", async () => {
    const calls = serve();
    const el = await mount();
    type(nameBox(el), "my-review");
    nameNext(el, "Implement the change");
    click(palette(el, "Ask an agent"));
    // the box is empty again, and what it now promises is slug()'s answer for nothing typed
    expect(nextNameBox(el).value).toBe("");
    expect(previewedId(el)).toBe("step");
    click(palette(el, "Wait"));
    await act(async () => { byText(el, "Save and add to the catalog")!.click(); });

    const ids = saved(calls).nodes.map((n) => n.id);
    expect(ids).toContain("implement-the-change");
    expect(ids).toContain("step");
    expect(ids.some((id) => id.startsWith("ask-an-agent"))).toBe(false);
  });

  test("clearing the name box creates the step the preview promised", async () => {
    const calls = serve();
    const el = await mount();
    type(nameBox(el), "my-review");
    nameNext(el, "Something");
    nameNext(el, "");
    // read the promise out of the DOM rather than recomputing it — the point is that what the
    // operator is SHOWN is what happens. Agreement on `ask-an-agent` would satisfy an
    // equality alone, so the value is named.
    const previewed = previewedId(el);
    expect(previewed).toBe("step");

    click(palette(el, "Ask an agent"));
    type(el.querySelector('textarea[aria-label="the agent\'s instructions"]') as HTMLTextAreaElement, "Do it.");
    await act(async () => { byText(el, "Save and add to the catalog")!.click(); });

    const body = calls.find((c) => c.method === "PUT")!.body as { spec: GraphSpec; prompts: Record<string, string> };
    const made = body.spec.nodes.find((n) => n.id === previewed);
    expect(made).toBeDefined();
    expect(made!.kind === "agent" && made!.prompt).toBe(`my-review.${previewed}`);
    expect(body.prompts[`my-review.${previewed}`]).toBe("Do it.");
  });
});

/**
 * Moving a step's id, which is the only way the ticket's graph could have been repaired: the
 * ids were wrong, and the prompt file is named after the id, so remove-and-re-add would have
 * lost every branch row and every word of the instructions.
 */
describe("renaming a step carries everything that names it (HOW-26)", () => {
  const renamed = () => {
    const base = PRESETS.find((p) => p.id === "code")!.build("my-code");
    return { base, after: apply(base, { type: "rename-step", id: "implement", to: "make-the-change" }) };
  };

  test("the id, the prompt id, the body, the edges and the entry all move together", () => {
    const { base, after } = renamed();
    expect(after.spec.nodes.some((n) => n.id === "implement")).toBe(false);
    const step = after.spec.nodes.find((n) => n.id === "make-the-change")!;
    expect(step.kind === "agent" && step.prompt).toBe("my-code.make-the-change");
    expect(after.prompts["my-code.make-the-change"]).toBe(base.prompts["my-code.implement"]);
    expect(after.prompts["my-code.implement"]).toBeUndefined();
    for (const e of after.spec.edges) {
      expect(e.from).not.toBe("implement");
      expect(e.to).not.toBe("implement");
    }
    expect(after.spec.edges.some((e) => e.to === "make-the-change")).toBe(true);
    // and the graph is still exactly as valid as it was
    expect(draftProblems(after)).toEqual([]);
  });

  test("the step keeps its PLACE, because the arrangement is part of the graph (HOW-24)", () => {
    const { base, after } = renamed();
    const was = base.spec.nodes.find((n) => n.id === "implement")!.position;
    expect(after.spec.nodes.find((n) => n.id === "make-the-change")!.position).toEqual(was!);
  });

  test("renaming the ENTRY moves the entry with it", () => {
    const base = PRESETS.find((p) => p.id === "code")!.build("my-code");
    const after = apply(base, { type: "rename-step", id: "make-worktree", to: "checkout" });
    expect(after.spec.entry).toBe("checkout");
    expect(draftProblems(after)).toEqual([]);
  });

  test("a rename that could not land leaves the draft exactly as it was", () => {
    const { base } = renamed();
    for (const to of ["review", "implement", "Not An Id", ""])
      expect(apply(base, { type: "rename-step", id: "implement", to })).toEqual(base);
  });

  /**
   * The button that OFFERS the rename, and the reducer that performs one, are held to the
   * same rule by `canRenameStep` — because they drifted: the form derived its suggestion over
   * the whole spec, where the step's own id is always taken, so a correctly-named step was
   * offered `<id>-2` and the "already matches" state was unreachable. Clicking it renamed a
   * right step to a numbered duplicate and took its instructions file along.
   */
  describe("the offer and the refusal are one rule", () => {
    /** one agent step with the id and title under test, plus somewhere for it to go */
    const withStep = (id: string, title: string): Draft => ({
      saved: true,
      prompts: { [`g.${id}`]: "Do the work." },
      spec: {
        version: 1, name: "g", description: "",
        fields: [], inputs: [], entry: id,
        nodes: [
          { id, kind: "agent", title, prompt: `g.${id}`, reads: [], writes: [] },
          { id: "done", kind: "terminal", outcome: "success" },
        ],
        edges: [{ from: id, to: "done" }],
      },
    });

    async function openRename(start: Draft, id: string) {
      let draft = start;
      let open = id;
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      const render = () =>
        root!.render(
          <ToastProvider>
            <StepFields
              draft={draft} id={open}
              dispatch={(a) => { draft = draftReducer(draft, a); render(); }}
              onRenamed={(next) => { open = next; render(); }}
            />
          </ToastProvider>,
        );
      await act(async () => { render(); });
      const button = () => buttons(host!).find((b) => b.textContent?.includes("Rename it to") || b.textContent?.includes("already matches"))!;
      return { el: host, latest: () => draft, button, openStep: () => open };
    }

    test("a step whose id already matches its name is offered nothing to do", async () => {
      const { button } = await openRename(
        withStep("implement-the-changes-required", "Implement the changes required"),
        "implement-the-changes-required",
      );
      // before: "Rename it to implement-the-changes-required-2", enabled
      expect(button().textContent).toContain("The id already matches the name");
      expect(button().disabled).toBe(true);
    });

    test("a step named after the menu is offered its title, with no numeric suffix", async () => {
      const { latest, button } = await openRename(
        withStep("ask-an-agent-8", "Implement the changes required"),
        "ask-an-agent-8",
      );
      expect(button().textContent).toBe("Rename it to implement-the-changes-required");
      click(button());
      const moved = latest().spec.nodes.find((n) => n.id === "implement-the-changes-required")!;
      expect(moved.kind === "agent" && moved.prompt).toBe("g.implement-the-changes-required");
      expect(latest().prompts["g.implement-the-changes-required"]).toBe("Do the work.");
      expect(latest().spec.entry).toBe("implement-the-changes-required");
    });

    test("a rename that cannot land leaves the draft alone AND the panel where it was", async () => {
      const start = withStep("implement-the-changes-required", "Implement the changes required");
      const { el, latest, button, openStep: open } = await openRename(start, "implement-the-changes-required");
      click(button());
      // the guard is in the handler as well as on the button, because onRenamed moves the
      // selection: pointing it at an id the reducer refused emptied the panel silently
      expect(latest()).toEqual(start);
      expect(open()).toBe("implement-the-changes-required");
      expect(el.textContent).toContain("What this step is called");
    });

    test("canRenameStep and the reducer refuse exactly the same renames", () => {
      const { base } = renamed();
      for (const to of ["review", "implement", "Not An Id", ""]) {
        expect(canRenameStep(base.spec, "implement", to)).toBe(false);
        expect(apply(base, { type: "rename-step", id: "implement", to })).toEqual(base);
      }
      expect(canRenameStep(base.spec, "implement", "make-the-change")).toBe(true);
      expect(canRenameStep(base.spec, "no-such-step", "make-the-change")).toBe(false);
    });
  });

  test("a body two steps SHARE does not move, because it is not this step's alone", () => {
    let draft = PRESETS[0]!.build("shared");
    draft = apply(draft, {
      type: "add-step",
      node: { id: "second", kind: "agent", title: "Second", prompt: "shared.work", reads: [], writes: [] },
    });
    const after = apply(draft, { type: "rename-step", id: "work", to: "first" });
    const moved = after.spec.nodes.find((n) => n.id === "first")!;
    expect(moved.kind === "agent" && moved.prompt).toBe("shared.work");
    expect(after.prompts["shared.work"]).toBeDefined();
  });

  test("the canvas follows the rename: the card, its wires and the selection all move", async () => {
    const el = await mount();
    nameNext(el, "Draught it");
    click(palette(el, "Ask an agent"));
    // the title is corrected AFTER the step exists, which is the order the ticket's operator
    // worked in — and the whole reason the id has to be moveable at all
    type(el.querySelector('input[placeholder="Draft the document"]') as HTMLInputElement, "Draft it");
    click(byText(el, "Rename it to draft-it"));
    // the panel is still on the step (it is keyed by the id that just moved), and the picture
    // is drawn from the same draft
    expect(el.textContent).toContain("What this step is called");
    expect(openStep(el, "Draft it")).toBeDefined();
  });
});

/**
 * The words a branch needs. Nothing tells an agent the values a condition compares against —
 * the outputs contract names KEYS only — so the builder says it in the instructions, which is
 * what every hand-written prompt in this repo does by hand.
 */
describe("a choice field's words reach the agent (HOW-26)", () => {
  /** a draft whose one agent step produces a choice field its instructions never mention */
  const silent = (): Draft => {
    const base = PRESETS[0]!.build("verdicts");
    return apply(
      base,
      { type: "add-field", patch: { key: "verdict", kind: "choice", scope: "cleared", choices: ["pass", "reject"] } },
      { type: "update-step", id: "work", node: { ...(base.spec.nodes[0] as Extract<NodeSpec, { kind: "agent" }>), writes: ["summary", "verdict"] } },
    );
  };

  async function openWork(start: Draft): Promise<{ el: HTMLElement; latest: () => Draft; send: (a: DraftAction) => void }> {
    let draft = start;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const apply1 = (a: DraftAction) => { draft = draftReducer(draft, a); render(); };
    const render = () =>
      root!.render(
        <ToastProvider>
          <StepFields draft={draft} id="work" dispatch={apply1} />
        </ToastProvider>,
      );
    await act(async () => { render(); });
    // an edit made from ANOTHER panel (the graph's fields), which is how a field's choices
    // move while this form is open
    return { el: host, latest: () => draft, send: (a) => { act(() => { apply1(a); }); } };
  }

  test("the form says the branch may never fire, and the button writes the sentence", async () => {
    const { el, latest } = await openWork(silent());
    expect(el.textContent).toContain("the instructions do not say so");
    click(byText(el, "Say it in the instructions"));

    const body = latest().prompts["verdicts.work"]!;
    expect(body).toContain("Return `verdict` as exactly one of: `pass`, `reject`.");
    // on its OWN line — a reference or a sentence run onto the end of the last one reads as
    // part of it, both to the operator and to the agent
    expect(body.split("\n\n").at(-1)).toBe("Return `verdict` as exactly one of: `pass`, `reject`.");
    // and once it is said, the form stops saying anything
    expect(el.textContent).toContain("the instructions say so");
    expect(byText(el, "Say it in the instructions")).toBeUndefined();
  });

  test("inserting a field puts the reference on its own line too", async () => {
    const { el, latest } = await openWork(silent());
    click(buttons(el).find((b) => b.textContent === "goal"));
    const body = latest().prompts["verdicts.work"]!;
    expect(body.split("\n\n").at(-1)).toBe("{{ context.goal }}");
    // the invariant the whole builder rests on still holds after it
    expect(latest().spec.nodes.find((n) => n.id === "work")).toMatchObject({ reads: templateReads(body) });
  });

  /**
   * Saying it REPLACES what it said before. `said` is a substring test over the choice
   * values, so ADDING a value makes it false again and brings the button back — and an
   * append-only handler then left the pinned prompt carrying two different allowed sets for
   * one key. The agent is told two contradictory things and a branch matches whichever it
   * happens to obey, which is the mis-branching the button exists to prevent.
   */
  describe("saying it again replaces the sentence rather than doubling it", () => {
    const count = (body: string) => (body.match(/Return `verdict` as exactly one of:/g) ?? []).length;

    test("nothing said yet — it is appended, on its own line, at the end", () => {
      expect(sayChoices("Do the work.", "verdict", ["pass", "fail"]))
        .toBe("Do the work.\n\nReturn `verdict` as exactly one of: `pass`, `fail`.");
    });

    test("a sentence mid-body is replaced IN PLACE, and what follows it is left alone", () => {
      const before = `Intro.\n\n${choiceSentence("verdict", ["pass"])}\n\nTail paragraph.`;
      const after = sayChoices(before, "verdict", ["pass", "warn"]);
      expect(count(after)).toBe(1);
      expect(after).toBe("Intro.\n\nReturn `verdict` as exactly one of: `pass`, `warn`.\n\nTail paragraph.");
    });

    test("a body already carrying two — the shape the defect produced — is repaired to one", () => {
      const damaged = [
        "Intro.", choiceSentence("verdict", ["pass"]), "Middle.", choiceSentence("verdict", ["pass", "fail"]), "End.",
      ].join("\n\n");
      const after = sayChoices(damaged, "verdict", ["pass", "warn", "fail"]);
      expect(count(after)).toBe(1);
      expect(after).toBe("Intro.\n\nReturn `verdict` as exactly one of: `pass`, `warn`, `fail`.\n\nMiddle.\n\nEnd.");
      // removing the duplicate must not leave the blank line that was its paragraph break
      expect(after).not.toContain("\n\n\n");
    });

    test("a sentence written for a DIFFERENT key is not touched", () => {
      const other = choiceSentence("outcome", ["ok"]);
      expect(sayChoices(other, "verdict", ["pass"])).toBe(`${other}\n\nReturn \`verdict\` as exactly one of: \`pass\`.`);
    });

    test("a dotted key is escaped, so it does not match another key's line", () => {
      // `.` is legal in SPEC_FIELD_KEY; unescaped it is the any-character wildcard, and
      // `review.verdict` would eat a line written for `reviewXverdict`
      const decoy = choiceSentence("reviewXverdict", ["a"]);
      expect(sayChoices(decoy, "review.verdict", ["p"]))
        .toBe(`${decoy}\n\nReturn \`review.verdict\` as exactly one of: \`p\`.`);
      expect(sayChoices(choiceSentence("review.verdict", ["a"]), "review.verdict", ["p"]))
        .toBe("Return `review.verdict` as exactly one of: `p`.");
    });

    test("through the real form: edit the choices, say it again, one sentence survives", async () => {
      const { el, latest, send } = await openWork(silent());
      click(byText(el, "Say it in the instructions"));
      expect(count(latest().prompts["verdicts.work"]!)).toBe(1);

      // widening the choices makes `said` false again, which is what brings the button back
      send({ type: "update-field", key: "verdict", patch: { choices: ["pass", "warn", "reject"] } });
      expect(byText(el, "Say it in the instructions")).toBeDefined();

      click(byText(el, "Say it in the instructions"));
      const body = latest().prompts["verdicts.work"]!;
      expect(count(body)).toBe(1);
      expect(body).toContain("Return `verdict` as exactly one of: `pass`, `warn`, `reject`.");
    });
  });
});

/**
 * The verdict, split. "Ready to save" still means what it always meant — `validate()` is
 * happy — and advice is counted beside it rather than inside it, because the graph in the
 * ticket was told it was ready and then spun forever.
 */
describe("the bar counts advice apart from what blocks (HOW-26)", () => {
  test("a graph that only draws advice still reads as ready to save", async () => {
    const el = await mount();
    type(nameBox(el), "my-review");
    click(openStep(el, "Do the work")!);
    // empty the one step's instructions of every field it names: perfectly legal, and now it
    // is told nothing — the state every hand-added step in the ticket's graph was in
    type(el.querySelector('textarea[aria-label="the agent\'s instructions"]') as HTMLTextAreaElement, "Do the work.");

    expect(labelled(el, "nothing outstanding")).toBeDefined();
    expect(labelled(el, "1 worth a second look")).toBeDefined();

    click(byText(el, "The graph itself"));
    expect(el.textContent).toContain("Ready to save");
    expect(el.textContent).toContain("worth a second look");
    expect(el.textContent).toContain("is given nothing");
  });

  test("advice never turns the step's own card into an alarm", async () => {
    const el = await mount();
    // the name FIRST: an unnamed graph blocks, and advice is held back until nothing does —
    // so without this the card is clean for the wrong reason and the assertion proves nothing
    type(nameBox(el), "my-review");
    click(openStep(el, "Do the work")!);
    type(el.querySelector('textarea[aria-label="the agent\'s instructions"]') as HTMLTextAreaElement, "Do the work.");
    expect(labelled(el, "1 worth a second look")).toBeDefined();
    // `--attention` means "a human is needed" and nothing else in this palette; advice is not
    // that, so the card it is about is left alone
    expect(card(el, "agent")!.className).not.toContain("needs-input");
  });

  test("and the server's gate reads the blocking half only", () => {
    // the browser-side half of the property graphs/builder.test.ts pins over a real save
    const draft = apply(PRESETS[0]!.build("my-review"), { type: "set-prompt", id: "my-review.work", body: "Do the work." });
    const problems = draftProblems(draft);
    expect(bySeverity(problems).advice.length).toBeGreaterThan(0);
    expect(bySeverity(problems).blocking).toEqual([]);
  });
});

/**
 * Every message the verdict produces is written with `**the step**` and `` `a field` `` in
 * it. They were printed raw, so the builder's own sentences reached the screen with the
 * markers in them — a share of "everything looks weird" that no rewording fixes.
 */
describe("a problem reads as a sentence, not as markdown source (HOW-26)", () => {
  const rendered = (message: string) => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(<ProblemText message={message} />); });
    return host;
  };

  test("the step's title is bold and a field key is code, and no marker survives", () => {
    const el = rendered("**Probe the PR** branches on `summary`, which is not a field.");
    expect(el.textContent).toBe("Probe the PR branches on summary, which is not a field.");
    expect(el.querySelector("strong")!.textContent).toBe("Probe the PR");
    expect(el.querySelector("code")!.textContent).toBe("summary");
  });

  test("a message with no markers is the characters that were typed, unchanged", () => {
    expect(rendered("A graph needs at least one step.").textContent).toBe("A graph needs at least one step.");
  });

  test("an unmatched marker is passed through rather than swallowing the rest", () => {
    const el = rendered("compares `count` with `3` as text — not 2 ** 3");
    expect(el.textContent).toBe("compares count with 3 as text — not 2 ** 3");
    expect([...el.querySelectorAll("code")].map((c) => c.textContent)).toEqual(["count", "3"]);
  });

  test("every message the ticket's own graph produces renders with no marker left in it", () => {
    const spec = PRESETS[0]!.build("markers").spec;
    const broken: GraphSpec = { ...spec, nodes: spec.nodes.map((n) => (n.id === "work" ? { ...n, reads: ["goal", "nope"] } : n)) };
    const messages = specProblems(broken).map((p) => p.message);
    expect(messages.length).toBeGreaterThan(0);
    for (const m of messages) {
      const el = rendered(m);
      expect(el.textContent, m).not.toContain("**");
      expect(el.textContent, m).not.toContain("`");
      act(() => root!.unmount());
      host!.remove();
    }
  });
});

/**
 * A step's routes print by SEVERITY, like everything else the verdict reaches.
 *
 * They did not. The other surfaces split the two classes and this one hard-coded
 * `field-error`, so the ticket's own branch-on-free-text advice — the row that never fired —
 * arrived in the refusal colour, saying the save was blocked when it was not. Nothing in the
 * suite could see it, because every assertion was about the message and none about the class
 * it lands in; this one is about the class.
 */
describe("advice about a route is advice, not a refusal (HOW-26)", () => {
  async function openRoutesOn(draft: Draft): Promise<HTMLElement> {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <ToastProvider>
          <StepRoutes
            draft={draft} from="review"
            problems={problemsByPane(draftProblems(draft)).branching.filter((p) => p.node === "review")}
            dispatch={() => {}}
          />
        </ToastProvider>,
      );
    });
    return host;
  }

  /** the doc preset with its review rows moved off the `choice` field and onto free text —
   *  which is exactly what the ticket's graph branched on */
  const onFreeText = () =>
    apply(doc(), {
      type: "set-branching", from: "review",
      edges: [{ to: "revise", when: { op: "equals", key: "summary", value: "reject" } }, { to: "done" }],
    });

  test("a free-text row is advised against in the quiet class, never the error class", async () => {
    const draft = onFreeText();
    const problems = problemsByPane(draftProblems(draft)).branching;
    expect(bySeverity(problems).blocking).toEqual([]);
    expect(bySeverity(problems).advice.length).toBeGreaterThan(0);

    const el = await openRoutesOn(draft);
    expect(el.querySelector(".field-advice")!.textContent).toContain("is free text");
    // the refusal colour means the save is blocked, and it is not — the server writes this graph
    expect(el.querySelector(".field-error")).toBeNull();
  });

  test("a row that really is refused still reads as one", async () => {
    // an operand left empty compares against nothing, whatever the field's kind — blocking
    const draft = apply(doc(), {
      type: "set-branching", from: "review",
      edges: [{ to: "revise", when: { op: "equals", key: "summary", value: "" } }, { to: "done" }],
    });
    const el = await openRoutesOn(draft);
    expect(el.querySelector(".field-error")).not.toBeNull();
    expect(el.querySelector(".field-advice")).toBeNull();
  });
});


describe("removing a field says what it destroys first (HOW-31 item 7)", () => {
  // HOW-31: "I was trying to build a new graph for my coding workflow and basically broke
  // everything." remove-field was one click on a trash icon that deleted every branch testing
  // the field, left agent instructions still naming it (so the draft went blocking), and had
  // no undo — while the panel's help text claimed it "removes it from the steps that used it".
  const reviewDraft = () => PRESETS.find((p) => p.id === "doc")!.build("demo");

  test("a field nothing uses costs nothing, so the removal is not interrupted", () => {
    const draft = draftReducer(reviewDraft(), { type: "add-field" });
    const fresh = draft.spec.fields.find((f) => !draft.spec.edges.some((e) => e.when?.key === f.key)
      && !draft.spec.nodes.some((n) => "writes" in n && n.writes.includes(f.key))
      && !draft.spec.inputs.includes(f.key));
    expect(fresh).toBeDefined();
    const cost = fieldRemoval(draft, fresh!.key);
    expect(removalHasCost(cost)).toBe(false);
    expect(cost).toEqual({ branches: [], instructions: [], producers: [], wasInput: false, strandedSteps: [] });
  });

  test("a field a branch tests reports the routes that go, and the step they strand", () => {
    const draft = reviewDraft();
    const branched = draft.spec.edges.find((e) => e.when)?.when?.key;
    expect(branched).toBeDefined();
    const cost = fieldRemoval(draft, branched!);
    expect(removalHasCost(cost)).toBe(true);
    expect(cost.branches.length).toBeGreaterThan(0);
    for (const b of cost.branches) {
      expect(b.from).toBeTruthy();
      expect(b.to).toBeTruthy();
      expect(b.label).toContain(branched!);
    }
    // the review preset routes a verdict two ways, so losing both strands the step
    expect(cost.strandedSteps.length).toBeGreaterThan(0);
  });

  test("a field an agent's instructions still name is reported, because that text is not ours to edit", () => {
    const draft = reviewDraft();
    const agent = draft.spec.nodes.find((n) => n.kind === "agent")!;
    const body = draft.prompts[(agent as { prompt: string }).prompt];
    expect(body).toBeDefined();
    const named = templateReads(body!)[0];
    expect(named).toBeDefined();

    const cost = fieldRemoval(draft, named!);
    expect(cost.instructions.map((i) => i.prompt)).toContain((agent as { prompt: string }).prompt);

    // and the warning is true: removing it really does leave the draft unsaveable, because
    // reads are derived from the body (spec-draft.ts withDerivedReads) and specProblems
    // reports the dangling reference rather than rewriting the operator's text.
    const after = draftReducer(draft, { type: "remove-field", key: named! });
    const blocking = draftProblems(after).filter((p) => p.severity !== "advice");
    expect(blocking.some((p) => p.message.includes(named!))).toBe(true);
  });

  test("an unopened prompt body is not claimed to be clean", () => {
    // Only a body the draft actually holds can be checked; specProblems at save is the
    // authority. The calculator must not imply an absent body is safe.
    const draft = reviewDraft();
    const agent = draft.spec.nodes.find((n) => n.kind === "agent")! as { prompt: string };
    const named = templateReads(draft.prompts[agent.prompt]!)[0]!;
    const withoutBody = { ...draft, prompts: {} };
    expect(fieldRemoval(withoutBody, named).instructions).toEqual([]);
    expect(fieldRemoval(draft, named).instructions.length).toBeGreaterThan(0);
  });

  test("an input reports that it will stop being asked for at launch", () => {
    const draft = reviewDraft();
    const input = draft.spec.inputs[0];
    expect(input).toBeDefined();
    expect(fieldRemoval(draft, input!).wasInput).toBe(true);
  });
});

// ---- HOW-71: a blank builder offers drafting instead ------------------------------------------

describe("a blank /graphs/new offers drafting (HOW-71)", () => {
  test("one quiet line, linking to New run with draft-graph picked", async () => {
    const el = await mount();
    const hint = el.querySelector(".gb-draft-hint");
    expect(hint?.textContent).toBe("Rather describe it? Draft a graph");
    expect(hint?.querySelector("a")?.getAttribute("href")).toBe("/new?graph=draft-graph");
  });

  test("not on /graphs/:name/build, which is a deliberate hand edit", async () => {
    const spec = doc().spec;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const body = path === `/api/graphs/${spec.name}` ? { spec, builder: true }
        : path.startsWith("/api/local-prompts/") ? { body: "" }
        : { graphs: [{ name: spec.name }], problems: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<ToastProvider><GraphBuilder name={spec.name} /></ToastProvider>); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(host.querySelector("h1")?.textContent).toBe(`Editing ${spec.name}`);
    expect(host.querySelector(".gb-draft-hint")).toBeNull();
  });
});
