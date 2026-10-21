/**
 * HOW-65: the draft card in the run's Chat, the /runs/:id/draft review page and the builder's
 * `?fromRun=`, on screen. The D-4A state matrix (working, empty, refused twice, done, partial),
 * D-8A's labels and tab order, D-9A's refusal handling and D-10A's receipt.
 *
 * The draft itself is built here with the same `diffDraft` the server runs, so the fixtures
 * cannot drift from what GET /api/runs/:id/draft returns (web/draft.test.ts pins that route).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deriveDetail } from "../derive";
import { FakeLog } from "../slice.fixtures";
import { RunChat } from "./run/chat";
import { DraftCard } from "./run/draft";
import { DraftReview, draftShape } from "./screens/draft-review";
import { GraphBuilder } from "./screens/graph-builder";
import { ToastProvider } from "./components/ui/toast";
import { diffDraft } from "../../core/draft-diff";
import type { GraphSpec } from "../../core/graph-spec";
import { CATALOG_TEXTS, cleanDraft } from "../../core/fixtures/graph-draft";
import { spec as quickTask } from "../../graphs/quick-task";
import type { ReadyDraft, RunDraft } from "../draft";

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
  globalThis.fetch = realFetch;
  history.replaceState(null, "", "/"); // the builder's redirect must not follow the next file around
});

// ---- fixtures ------------------------------------------------------------------------------

function ready(over: { base?: GraphSpec | null; spec?: GraphSpec; texts?: Record<string, string>; prompts?: ReadyDraft["draft"]["prompts"] } & Partial<Omit<ReadyDraft, "draft" | "base">> = {}): ReadyDraft {
  const d = cleanDraft();
  const spec = over.spec ?? d.spec;
  const prompts = over.prompts ?? d.prompts;
  const texts = over.texts ?? { "quick-review.work": CATALOG_TEXTS["quick-task.work"]!, "quick-review.review": d.prompts["quick-review.review"] as string };
  const base = over.base === undefined ? quickTask : over.base;
  const diff = diffDraft({ spec, bodies: prompts, texts, base, baseTexts: CATALOG_TEXTS });
  return {
    state: "ready", run: "r1",
    draft: { spec, prompts, based_on: base?.name ?? null, notes: d.notes },
    base, texts, diff, advice: [], grantsNewWrite: diff.grantsNewWrite, draftHash: "c53:abc",
    saved: null, baseChanged: null,
    ...over,
  } as ReadyDraft;
}

/** read-only additions only: Save is offered directly (D-6A) */
function readOnlyDraft(): ReadyDraft {
  const spec: GraphSpec = JSON.parse(JSON.stringify(quickTask));
  spec.fields.push({ key: "verdict", kind: "text", scope: "sticky" });
  spec.nodes.splice(1, 0, { id: "look", kind: "agent", prompt: "quick-task.look", reads: ["summary"], writes: ["verdict"], readOnly: true });
  spec.edges = [{ from: "quick-task.work", to: "look" }, { from: "look", to: "done" }];
  const texts = { "quick-task.work": CATALOG_TEXTS["quick-task.work"]!, "quick-task.look": "Look at {{ context.summary }}.\n" };
  return ready({ spec, texts, prompts: { "quick-task.work": { copyOf: "quick-task.work" }, "quick-task.look": texts["quick-task.look"] } });
}

/** fetch: GET /draft answers the queue in order (last one sticks); POST /save answers `save` */
function serve(drafts: RunDraft[], save: { status: number; body: unknown } = { status: 201, body: { ok: true, name: "x" } }, catalog: string[] = []) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const queue = [...drafts];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/draft/save")) return res(save.status, save.body);
    if (url.includes("/draft")) {
      const d = queue.length > 1 ? queue.shift()! : queue[0]!;
      return res(d.state === "ready" ? 200 : d.state === "unknown" ? 404 : 409, d);
    }
    if (method === "PUT") return res(201, { ok: true });
    return res(200, { graphs: catalog.map((name) => ({ name })), problems: [] });
  }) as typeof fetch;
  return calls;
}

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<ToastProvider>{node}</ToastProvider>); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host;
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const buttonNamed = (el: HTMLElement, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
const linkNamed = (el: HTMLElement, text: string) => [...el.querySelectorAll("a")].find((a) => a.textContent?.trim() === text);
const nameBox = (el: HTMLElement) => el.querySelector(".draft-name input") as HTMLInputElement;
const typeInto = (box: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, value);
  box.dispatchEvent(new Event("input", { bubbles: true }));
});

/** a draft-graph run's log at each phase */
function draftRunLog(phase: "running" | "parked" | "done"): FakeLog {
  const log = new FakeLog();
  log.add({ type: "run-started", graph: "draft-graph", inputs: { intent: "i" }, pinned_prompts: {} });
  log.add({ type: "node-started", node: "graph.draft", visit: 1, attempt_id: "graph.draft#1" });
  if (phase === "parked") {
    log.add({ type: "node-finished", node: "graph.draft", visit: 1, status: "failed", writes: {} });
    log.add({ type: "attention-raised", node: "graph.draft", visit: 1, reason: "output contract violation: the draft cannot be saved:\n- There is already a graph called `quick-task`. Pick another name." });
  }
  if (phase === "done") {
    log.add({ type: "node-finished", node: "graph.draft", visit: 1, status: "succeeded", writes: { "graph.draft": cleanDraft() } });
    log.add({ type: "run-finished", outcome: "success" });
  }
  return log;
}

async function mountChat(phase: "running" | "parked" | "done"): Promise<HTMLElement> {
  const detail = deriveDetail("r1", draftRunLog(phase).events, {});
  return mount(<RunChat runId="r1" detail={detail} ask={detail.ask} onPickStep={() => {}} onResolved={() => {}} />);
}

// ---- D-4A: the state matrix ----------------------------------------------------------------

describe("the draft card in the run's Chat — D-4A", () => {
  test("working: no card while the drafter runs, and the draft is not even asked for", async () => {
    const calls = serve([ready()]);
    const el = await mountChat("running");
    expect(el.querySelector(".draft-card")).toBeNull();
    expect(calls.some((c) => c.url.includes("/draft"))).toBe(false);
  });

  test("refused twice: no draft card, the park quotes the problem, and there is no Save anywhere", async () => {
    serve([{ state: "refused", reason: "x" }]);
    const el = await mountChat("parked");
    expect(el.querySelector(".draft-card")).toBeNull();
    expect(el.textContent).toContain("There is already a graph called");
    expect(buttonNamed(el, "Save")).toBeUndefined();
  });

  test("done: the card sits in the transcript with the summary, risk first", async () => {
    serve([ready()]);
    const el = await mountChat("done");
    const card = el.querySelector(".draft-card")!;
    expect(card).not.toBeNull();
    expect(card.querySelector(".draft-basis")?.textContent).toBe("based on quick-task · 3 steps");
    expect(card.querySelector(".draft-sum")?.textContent).toBe("⚠ 1 step can change your code · ◐ 4 changed · ⓘ 0 worth a look");
    const headings = [...card.querySelectorAll(".draft-sec h3")].map((h) => h.textContent);
    expect(headings).toEqual(["Can change your code · 1", "What changed from quick-task · 4", "Unchanged (1)", "Worth a look · 0"]);
  });

  test("empty: a draft from nothing says `New graph`, every row is added, empty sections say Nothing flagged", async () => {
    serve([ready({ base: null })]);
    const el = await mount(<DraftCard runId="r1" />);
    expect(el.querySelector(".draft-basis")?.textContent).toBe("New graph · 3 steps");
    const rows = [...el.querySelectorAll(".draft-row[data-change]")];
    expect(rows.map((r) => r.getAttribute("data-change"))).toEqual(["added", "added", "added"]);
    expect([...el.querySelectorAll(".draft-none")].map((n) => n.textContent)).toEqual(["Nothing flagged", "Nothing flagged"]);
  });

  test("done, no new write power: Save is offered directly", async () => {
    serve([readOnlyDraft()]);
    const el = await mount(<DraftCard runId="r1" />);
    expect(buttonNamed(el, "Save")).toBeDefined();
    expect(buttonNamed(el, "Review and save")).toBeUndefined();
    await click(buttonNamed(el, "Review all changes")!);
    expect(location.pathname).toBe("/runs/r1/draft");
  });

  test("done, a new writer: the primary is Review and save, and there is no Save on the card (D-6A)", async () => {
    serve([ready()]);
    const el = await mount(<DraftCard runId="r1" />);
    expect(buttonNamed(el, "Save")).toBeUndefined();
    await click(buttonNamed(el, "Review and save")!);
    expect(location.pathname).toBe("/runs/r1/draft");
  });

  test("partial: a base that changed after drafting raises the banner", async () => {
    serve([ready({ baseChanged: { base: "quick-task", gone: false } })]);
    const el = await mount(<DraftCard runId="r1" />);
    expect(el.querySelector(".draft-banner")?.textContent).toBe("quick-task changed after this draft; copied steps use today's text");
  });

  test("Save → receipt: `Saved as X · not edited`, then `edited on canvas` when it was", async () => {
    const calls = serve([readOnlyDraft(), { ...readOnlyDraft(), saved: { name: "my-look", edited: false } }]);
    const el = await mount(<DraftCard runId="r1" />);
    typeInto(nameBox(el), "my-look");
    await click(buttonNamed(el, "Save")!);
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ url: "/api/runs/r1/draft/save", body: { name: "my-look" } });
    const receipt = el.querySelector(".draft-receipt")!;
    expect(receipt.textContent).toBe("✓ Saved as my-look · not edited · Open · Run it");
    expect(linkNamed(el, "Open")?.getAttribute("href")).toBe("/graphs/my-look/build");
    expect(linkNamed(el, "Run it")?.getAttribute("href")).toBe("/new?graph=my-look");
    expect(buttonNamed(el, "Save")).toBeUndefined(); // a reload or a second tab never offers it twice

    if (root) act(() => root!.unmount());
    host?.remove();
    serve([{ ...readOnlyDraft(), saved: { name: "my-look", edited: true } }]);
    const again = await mount(<DraftCard runId="r1" />);
    expect(again.querySelector(".draft-receipt")?.textContent).toContain("Saved as my-look · edited on canvas");
  });

  test("a 409 is shown word for word and the cursor goes back to the name (D-9A)", async () => {
    const sentence = "There is already a graph called `quick-task`. Pick another name.";
    serve([readOnlyDraft()], { status: 409, body: { error: sentence } });
    const el = await mount(<DraftCard runId="r1" />);
    (buttonNamed(el, "Save") as HTMLButtonElement).focus();
    await click(buttonNamed(el, "Save")!);
    expect(el.querySelector("[role=alert]")?.textContent).toBe(sentence);
    expect(document.activeElement).toBe(nameBox(el));
  });

  test("the name box says live when a name is taken", async () => {
    serve([readOnlyDraft()], undefined, ["quick-task", "taken-one"]);
    const el = await mount(<DraftCard runId="r1" />);
    typeInto(nameBox(el), "taken-one");
    expect(el.querySelector(".draft-name .field-error")?.textContent).toBe("There is already a graph called taken-one. Pick another name.");
    expect(nameBox(el).getAttribute("aria-invalid")).toBe("true");
  });

  test("a body diff past 20 lines collapses behind `show all N lines`, and expands", async () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const d = cleanDraft();
    serve([ready({ texts: { "quick-review.work": CATALOG_TEXTS["quick-task.work"]!, "quick-review.review": long }, prompts: { ...d.prompts, "quick-review.review": long } })]);
    const el = await mount(<DraftCard runId="r1" />);
    const pre = () => [...el.querySelectorAll(".draft-diff pre")].find((p) => p.textContent?.includes("line 0"))!;
    expect(pre().querySelectorAll("ins")).toHaveLength(20);
    const more = buttonNamed(el, "show all 30 lines")!;
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await click(more);
    expect(pre().querySelectorAll("ins")).toHaveLength(30);
  });

  test("Unchanged is a closed disclosure that toggles aria-expanded", async () => {
    serve([ready()]);
    const el = await mount(<DraftCard runId="r1" />);
    const toggle = buttonNamed(el, "Unchanged (1)")!;
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect([toggle.getAttribute("aria-expanded"), panel.hidden]).toEqual(["false", true]);
    await click(toggle);
    expect([toggle.getAttribute("aria-expanded"), panel.hidden]).toEqual(["true", false]);
  });
});

// ---- D-8A: labels and tab order ------------------------------------------------------------

describe("D-8A: every glyph has its word, every section is a region, the tab order reads down", () => {
  test("labels, regions, del/ins and copies", async () => {
    const d = cleanDraft();
    const changedBody = ready({
      base: { ...quickTask, nodes: [...quickTask.nodes, { id: "quick-review.review", kind: "agent", prompt: "look-only.review", reads: ["summary"], writes: ["verdict"], readOnly: true }] },
      prompts: d.prompts,
    });
    serve([changedBody]);
    const el = await mount(<DraftCard runId="r1" />);
    for (const s of el.querySelectorAll(".draft-sec")) {
      expect(s.getAttribute("role")).toBe("region");
      const h = document.getElementById(s.getAttribute("aria-labelledby")!);
      expect(h?.tagName).toBe("H3");
    }
    // every glyph is hidden from assistive tech and has a visible word beside it
    for (const g of el.querySelectorAll(".draft-row .draft-glyph")) {
      expect(g.getAttribute("aria-hidden")).toBe("true");
      expect(g.parentElement?.querySelector(".draft-tag")?.textContent?.length).toBeGreaterThan(0);
    }
    expect(el.querySelector(".draft-sum")?.textContent).toContain("can change your code");
    const review = el.querySelector('.draft-row[data-change][data-step="quick-review.review"]')!;
    expect(review.querySelector("del")?.textContent).toBe("Review {{ context.goal }} and give a verdict.\n");
    expect(review.querySelector("ins")?.textContent).toContain("Check this summary");
    expect(el.querySelector('.draft-row[data-change][data-step="quick-review.work"]')?.textContent).toContain("Instructions unchanged from quick-task.work");
  });

  test("the tab order follows the page: name → Save → Review all changes → rows → the Unchanged disclosure", async () => {
    serve([readOnlyDraft()]);
    const el = await mount(<DraftCard runId="r1" />);
    const focusable = [...el.querySelectorAll<HTMLElement>("input, button, a[href], [tabindex='0']")].filter((e) => !e.closest("[hidden]"));
    const describe = (e: HTMLElement) =>
      e.tagName === "INPUT" ? "name" : e.tagName === "LI" ? `row:${e.getAttribute("data-step") ?? "graph"}` : e.textContent?.trim();
    expect(focusable.map(describe)).toEqual([
      "name", "Save", "Review all changes",
      "row:quick-task.work", // can change your code
      "row:graph", "row:look", "row:quick-task.work", // what changed: the graph's new field, the added step, the new route

      "Unchanged (1)",
    ]);
  });
});

// ---- the review page -----------------------------------------------------------------------

/** the review page's two layouts hang on (min-width: 1280px); happy-dom starts at 1024 */
const setWidth = (width: number) => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height: 900 });

describe("/runs/:id/draft", () => {
  afterEach(() => setWidth(1024));

  test("still drafting: the reason and a link back to the run", async () => {
    serve([{ state: "drafting", reason: "Howdah is still drafting this graph." }]);
    const el = await mount(<DraftReview runId="r1" />);
    expect(el.textContent).toContain("Howdah is still drafting this graph.");
    expect(linkNamed(el, "Back to the run")?.getAttribute("href")).toBe("/run/r1");
  });

  test("an unknown run says so", async () => {
    serve([{ state: "unknown", reason: "There is no run called `r1`." }]);
    const el = await mount(<DraftReview runId="r1" />);
    expect(el.textContent).toContain("There is no run called `r1`.");
  });

  test("ready, wide: the list, the picture beside it with the removed step struck through, Save and Open on canvas", async () => {
    setWidth(1440);
    serve([ready()]);
    const el = await mount(<DraftReview runId="r1" />);
    expect(el.querySelector(".draft-list")).not.toBeNull();
    const removed = el.querySelector(".dag-node.removed")!;
    expect(removed.getAttribute("aria-label")).toContain("quick-task.work");
    expect(removed.getAttribute("aria-label")).toContain("removed");
    expect(buttonNamed(el, "Save")).toBeDefined(); // the page always offers Save (D-6A)
    await click(buttonNamed(el, "Open on canvas")!);
    expect(location.pathname + location.search).toBe("/graphs/new?fromRun=r1");
  });

  test("below 1280px the picture is under the list, behind `Show the draft`", async () => {
    serve([ready()]);
    const el = await mount(<DraftReview runId="r1" />);
    expect(el.querySelector(".dag-node")).toBeNull();
    const show = buttonNamed(el, "Show the draft")!;
    expect(show.getAttribute("aria-expanded")).toBe("false");
    await click(show);
    expect(el.querySelector(".draft-page-main .dag-node.removed")).not.toBeNull();
    expect(buttonNamed(el, "Hide the draft")?.getAttribute("aria-expanded")).toBe("true");
  });

  test("focusing a row lights its box", async () => {
    setWidth(1440);
    serve([ready()]);
    const el = await mount(<DraftReview runId="r1" />);
    const row = el.querySelector<HTMLElement>('.draft-row[data-step="quick-review.review"]')!;
    await act(async () => { row.focus(); });
    const lit = [...el.querySelectorAll(".dag-node.highlight")];
    expect(lit).toHaveLength(1);
    expect(lit[0]!.getAttribute("aria-label")).toContain("quick-review.review");
    await act(async () => { row.blur(); });
    expect(el.querySelectorAll(".dag-node.highlight")).toHaveLength(0);
  });

  test("draftShape: removed steps are drawn, and nothing routes into them", () => {
    const shape = draftShape(ready());
    expect(shape.nodes.map((n) => n.id)).toEqual(["quick-review.work", "quick-review.review", "done", "quick-task.work"]);
    expect(shape.edges.some((e) => e.to === "quick-task.work" || e.from === "quick-task.work")).toBe(false);
  });
});

// ---- the builder's ?fromRun= ----------------------------------------------------------------

describe("the builder opens a draft from its run", () => {
  test("loads the draft unsaved, names the run, and its Save carries fromRun", async () => {
    const calls = serve([ready()]);
    const el = await mount(<GraphBuilder fromRun="r1" />);
    expect(el.querySelector(".gb-from-run")?.textContent).toBe("Editing draft from run r1 · back to review");
    expect(linkNamed(el, "back to review")?.getAttribute("href")).toBe("/runs/r1/draft");
    await click(buttonNamed(el, "Save and add to the catalog")!);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/api/graphs/quick-review/builder");
    expect(put.body).toMatchObject({ intent: "create", fromRun: "r1" });
    expect((put.body as { spec: { drafted?: unknown } }).spec.drafted).toBeUndefined();
    // the copy arrives as text: the builder never sends a copyOf
    expect((put.body as { prompts: Record<string, unknown> }).prompts["quick-review.work"]).toBe(CATALOG_TEXTS["quick-task.work"]);
  });

  test("a draft that is already a graph opens that graph instead", async () => {
    serve([{ ...ready(), saved: { name: "my-review", edited: false } }]);
    await mount(<GraphBuilder fromRun="r1" />);
    expect(location.pathname).toBe("/graphs/my-review/build");
  });
});
