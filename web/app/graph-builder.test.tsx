/**
 * The graph builder (HOW-22), pinned at the two layers that carry the ticket.
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
 * THE WIZARD (DOM). What the ticket actually asked for — "the user shouldn't be concerned
 * with typescript checks" — is only true if three things hold, so all three are asserted
 * here rather than trusted: nothing in the builder asks anyone to type TypeScript or JSON;
 * the verdict is live and attributed to the pane that fixes it, so a problem is never
 * discovered only at Save; and the picture re-draws from the draft with NO network call,
 * which is the whole reason core/graph-spec.ts is node-free.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { buildGraph, specProblems, type FieldKind, type FieldSpec, type GraphSpec, type NodeSpec } from "../../core/graph-spec";
import { templateReads } from "../../core/template-refs";
import {
  PRESETS, draftProblems, draftReducer, newStep, pickPrompts, problemsByPane, specToShape,
  type Draft, type DraftAction,
} from "./lib/spec-draft";
import { GraphBuilder } from "./screens/graph-builder";
import { StepForm } from "./builder/step-form";
import { BranchingPane } from "./builder/branching";
import { FieldsPane } from "./builder/fields";
import { ToastProvider } from "./components/ui/toast";
import { Input } from "./components/ui/input";
import { useTypedText } from "./lib/hooks";

// ---- the draft ---------------------------------------------------------------------------

const apply = (draft: Draft, ...actions: DraftAction[]): Draft => actions.reduce(draftReducer, draft);
const doc = () => PRESETS.find((p) => p.id === "doc")!.build("my-review");

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
    const add = (kind: NodeSpec["kind"], title: string, over: (n: NodeSpec) => NodeSpec = (n) => n) => {
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

describe("the preview is drawn from the draft, not fetched", () => {
  test("it speaks in titles while the ids — which are run identity — stay put", () => {
    const shape = specToShape(doc().spec);
    expect(shape.nodes.find((n) => n.id === "draft")!.title).toBe("Draft it");
    expect(shape.nodes.map((n) => n.id)).toContain("revise");
  });

  test("its edge captions are the compiled graph's own labels, so picture and log agree", () => {
    const shape = specToShape(doc().spec);
    const compiled = buildGraph(doc().spec).def.edges;
    for (const e of shape.edges) {
      if (e.label === undefined) continue;
      expect(compiled.find((c) => c.from === e.from && c.to === e.to)!.condition!.label).toBe(e.label);
    }
  });
});

// ---- the wizard ----------------------------------------------------------------------------

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

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
const click = (b: HTMLElement | undefined) => act(() => { b!.click(); });
const goTo = (el: HTMLElement, pane: string) => click(buttons(el).find((b) => b.getAttribute("aria-label")?.startsWith(pane)));

beforeEach(() => { serve(); });
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
  globalThis.fetch = realFetch;
});

describe("the wizard, end to end (AC3)", () => {
  test("the rail shows the five panes and what each still owes", async () => {
    const el = await mount();
    const rail = [...el.querySelectorAll(".builder-rail-label")].map((n) => n.textContent);
    expect(rail).toEqual(["Basics", "What it works with", "Steps", "Branching", "Review & save"]);
    // the blank preset is complete except for its name, which only the operator can give
    const basics = buttons(el).find((b) => b.getAttribute("aria-label")?.startsWith("Basics"))!;
    expect(basics.getAttribute("aria-label")).toContain("1 to sort out");
    expect(
      buttons(el).find((b) => b.getAttribute("aria-label")?.startsWith("Steps"))!.getAttribute("aria-label"),
    ).toContain("nothing outstanding");
  });

  test("naming it clears the rail's only complaint, with no network call at all", async () => {
    const calls = serve();
    const el = await mount();
    const before = calls.length;
    type(el.querySelector('input[placeholder="my-review"]') as HTMLInputElement, "my-review");
    expect(
      buttons(el).find((b) => b.getAttribute("aria-label")?.startsWith("Basics"))!.getAttribute("aria-label"),
    ).toContain("nothing outstanding");
    // the verdict, the rail and the picture all moved, and nothing was fetched to do it
    expect(calls.length).toBe(before);
  });

  test("the picture re-draws from the draft as steps are added — still no fetch", async () => {
    const calls = serve();
    const el = await mount();
    type(el.querySelector('input[placeholder="my-review"]') as HTMLInputElement, "my-review");
    const before = calls.length;
    goTo(el, "Steps");
    click(byText(el, "Wait"));
    click(byText(el, "Done"));                                   // close the step dialog
    expect([...el.querySelectorAll(".dag-title")].map((n) => n.textContent)).toContain("◔ Wait");
    expect(calls.length).toBe(before);
  });

  test("adding a step and saving PUTs the spec the forms built, with its prompt body", async () => {
    const calls = serve();
    const el = await mount();
    type(el.querySelector('input[placeholder="my-review"]') as HTMLInputElement, "my-review");
    goTo(el, "Steps");
    click(byText(el, "Ask an agent"));
    type(el.querySelector('textarea[aria-label="the agent\'s instructions"]') as HTMLTextAreaElement, "Summarise {{ context.goal }}");
    // what the agent is GIVEN is read out of the instructions while they are being written —
    // there is no second place to declare it, and nothing to keep in sync by hand
    expect(el.textContent).toContain("This step will be given:");
    expect(el.querySelector("dialog")!.textContent).toContain("goal");
    click(byText(el, "Done"));
    goTo(el, "Review");
    await act(async () => { byText(el, "Save and add to the catalog")!.click(); });

    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/api/graphs/my-review/builder");
    const body = put.body as { spec: GraphSpec; prompts: Record<string, string> };
    expect(body.spec.name).toBe("my-review");
    expect(body.spec.nodes.map((n) => n.id)).toContain("ask-an-agent");
    expect(body.prompts["my-review.ask-an-agent"]).toBe("Summarise {{ context.goal }}");
    // `reads` was derived from that body, never declared beside it
    expect(body.spec.nodes.find((n) => n.id === "ask-an-agent")).toMatchObject({ reads: ["goal"] });
  });

  test("a step added and then removed is not posted — and the save is not blocked by it", async () => {
    const calls = serve();
    const el = await mount();
    type(el.querySelector('input[placeholder="my-review"]') as HTMLInputElement, "my-review");
    goTo(el, "Steps");
    click(byText(el, "Ask an agent"));
    type(el.querySelector('textarea[aria-label="the agent\'s instructions"]') as HTMLTextAreaElement, "Summarise {{ context.goal }}");
    click(byText(el, "Remove this step"));
    goTo(el, "Review");
    await act(async () => { byText(el, "Save and add to the catalog")!.click(); });

    const body = calls.find((c) => c.method === "PUT")!.body as { spec: GraphSpec; prompts: Record<string, string> };
    expect(Object.keys(body.prompts)).not.toContain("my-review.ask-an-agent");
    // and what IS posted is exactly what the spec's own steps name — the server refuses any
    // other id, and used to refuse every save for the rest of the session over one
    expect(Object.keys(body.prompts).sort()).toEqual(
      body.spec.nodes.filter((n) => n.kind === "agent").map((n) => (n as Extract<NodeSpec, { kind: "agent" }>).prompt).sort(),
    );
  });

  /**
   * HOW-22 review, finding 2. The collision used to be a field-error the Basics pane rendered
   * on its own, outside the verdict: the rail counted Basics clean, Review printed "Ready to
   * save", and the save replaced the other graph. It is now ONE counted problem, and there is
   * only one copy of it.
   */
  test("a name the catalog already owns is a counted problem, printed once", async () => {
    serve({ status: 201, body: { ok: true } }, ["taken-name"]);
    const el = await mount();
    type(el.querySelector('input[placeholder="my-review"]') as HTMLInputElement, "taken-name");
    expect(
      buttons(el).find((b) => b.getAttribute("aria-label")?.startsWith("Basics"))!.getAttribute("aria-label"),
    ).toContain("1 to sort out");
    const errors = [...el.querySelectorAll(".field-error")].map((n) => n.textContent);
    expect(errors.filter((t) => t?.includes("already a graph called"))).toHaveLength(1);
    goTo(el, "Review");
    expect(el.textContent).toContain("1 thing to sort out");
    expect(el.textContent).not.toContain("Ready to save");
  });

  test("the first save declares a create; the next one declares an update", async () => {
    const calls = serve();
    const el = await mount();
    type(el.querySelector('input[placeholder="my-review"]') as HTMLInputElement, "my-review");
    goTo(el, "Review");
    await act(async () => { byText(el, "Save and add to the catalog")!.click(); });
    await act(async () => { byText(el, "Save changes")!.click(); });
    const puts = calls.filter((c) => c.method === "PUT").map((c) => (c.body as { intent: string }).intent);
    expect(puts).toEqual(["create", "update"]);
  });

  test("a refused save says why, in the server's words, and keeps the draft open", async () => {
    serve({ status: 422, body: { error: 'node "work" has nowhere to go next' } });
    const el = await mount();
    type(el.querySelector('input[placeholder="my-review"]') as HTMLInputElement, "my-review");
    goTo(el, "Review");
    await act(async () => { byText(el, "Save and add to the catalog")!.click(); });
    expect(el.textContent).toContain("nowhere to go next");
    expect(byText(el, "Save and add to the catalog")).toBeDefined();
  });
});

describe("nothing in the builder asks anyone to write TypeScript or JSON (AC2)", () => {
  test("the free-text boxes are prose and scripts — never a serialized graph", async () => {
    const el = await mount();
    goTo(el, "Steps");
    click(byText(el, "Ask an agent"));
    for (const ta of [...el.querySelectorAll("textarea")] as HTMLTextAreaElement[]) {
      const value = ta.value.trim();
      expect(value.startsWith("{"), ta.getAttribute("aria-label") ?? "").toBe(false);
      expect(value, ta.getAttribute("aria-label") ?? "").not.toContain("defineGraph");
      expect(value, ta.getAttribute("aria-label") ?? "").not.toContain('"kind"');
    }
  });

  test("the condition vocabulary is pickers — an operator never writes a predicate", async () => {
    const el = await mount();
    goTo(el, "Branching");
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
          <BranchingPane
            draft={draft}
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
  async function openStep(draft: Draft): Promise<HTMLElement> {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<ToastProvider><StepForm draft={draft} id="clean" dispatch={() => {}} onClose={() => {}} /></ToastProvider>);
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
    const el = await openStep(withWorktree("create", ["worktree.clean"]));
    const row = tickboxes(el).find((t) => t.label.includes("worktree.clean"));
    expect(row).toBeDefined();
    expect(row!.box.checked).toBe(true);
  });

  test("a clean-up step still offers exactly the two facts its executor emits", async () => {
    const el = await openStep(withWorktree("remove", ["worktree.clean"]));
    const labels = tickboxes(el).map((t) => t.label).filter((t) => t.includes("worktree.clean") || t.includes("outcome"));
    expect(labels).toHaveLength(2);
  });

  test("a make step with nothing declared offers nothing, and says why", async () => {
    const el = await openStep(withWorktree("create", []));
    expect(el.querySelector("dialog")!.textContent).toContain("Making a worktree reports nothing");
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
        <BranchingPane
          draft={draft}
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
    expect(problemsByPane(draftProblems(latest())).branching).toEqual([]);
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

describe("the picture never takes the wizard down with it (finding 1)", () => {
  test('picking "pick a step" leaves the wizard standing and reports the row in words', async () => {
    const el = await mount();
    goTo(el, "Branching");
    click(byText(el, "Add a condition"));
    const to = [...el.querySelectorAll("select")].find((s) => s.getAttribute("aria-label") === "where row 1 goes")!;
    type(to, "");

    // the wizard is still mounted, and so is the live picture beside it
    expect(el.querySelector(".builder-rail-label")).not.toBeNull();
    expect(el.querySelector("svg.dag")).not.toBeNull();
    const rail = buttons(el).find((b) => b.getAttribute("aria-label")?.startsWith("Branching"))!;
    expect(rail.getAttribute("aria-label")).toContain("1 to sort out");
    expect(el.textContent).toContain('has a "go to" with no step picked');
  });
});
