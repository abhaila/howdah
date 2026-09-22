/**
 * The graph builder (HOW-22), pinned at the two layers that carry the ticket.
 *
 * THE DRAFT (no DOM). The reducer's job is the edits that are COUPLED, and coupled quietly:
 * removing a step has to take the edges that named it, removing a field has to take the
 * branch rows that tested it, and renaming the graph before its first save has to move every
 * agent step's prompt id AND the body filed under it. Each of those, missed, leaves a draft
 * that looks fine and saves into a graph that will not load.
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
import { buildGraph, specProblems, type GraphSpec, type NodeSpec } from "../../core/graph-spec";
import { templateReads } from "../../core/template-refs";
import {
  PRESETS, draftProblems, draftReducer, newStep, problemsByPane, specToShape, type Draft, type DraftAction,
} from "./lib/spec-draft";
import { GraphBuilder } from "./screens/graph-builder";
import { ToastProvider } from "./components/ui/toast";

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

/** the catalog answers every GET; a PUT is recorded and answered 201 unless told otherwise */
function serve(put: { status: number; body: unknown } = { status: 201, body: { ok: true } }) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method !== "GET")
      return new Response(JSON.stringify(put.body), { status: put.status, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ graphs: [], problems: [] }), { status: 200, headers: { "content-type": "application/json" } });
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
