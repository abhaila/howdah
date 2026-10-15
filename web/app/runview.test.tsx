/**
 * Opening a run that does not exist YET. Launching spawns the CLI detached and answers 202
 * before run.jsonl exists (web/server.ts POST /api/runs), so the viewer routinely arrives at
 * /run/<id> during a ~150ms window where GET /api/runs/<id> is a 404.
 *
 * What is pinned here is that a non-ok response never becomes state. `fetch` resolves on a
 * 404 and its error body parses as JSON, so the old `.then(r => r.json()).then(setDetail)`
 * stored `{error: "unknown run"}` — truthy, so it walked past the `if (!detail)` loading
 * guard, and the next property read threw mid-render. With no error boundary in this app that
 * throw unmounted the tree: a blank page that only a manual reload fixed.
 *
 * So: a 404 leaves `detail` null and the loading state showing, the poll brings the run in
 * when it lands, and a run that never lands says so instead of spinning forever.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deriveDetail } from "../derive";
import { FakeLog, started } from "../slice.fixtures";
import { RunView, OPEN_GRACE_MS } from "./run/view";
import { ToastProvider } from "./components/ui/toast";

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

/** happy-dom has no EventSource, and RunView opens one as soon as a detail lands. */
class StubEventSource {
  /** the open streams, so a test can push a named event into the page */
  static open: StubEventSource[] = [];
  onmessage: ((e: unknown) => void) | null = null;
  readonly listeners = new Map<string, (e: unknown) => void>();
  constructor(readonly url: string) { StubEventSource.open.push(this); }
  /** HOW-49: named events (`git-live`) are listened for, as on the real EventSource */
  addEventListener(type: string, fn: (e: unknown) => void) { this.listeners.set(type, fn); }
  close() {}
}

/**
 * The smallest log that derives a real RunDetail. The graph is a parameter because the abort
 * confirmation names it — naming the graph is how that dialog says WHICH run is about to
 * stop, so a test of it has to be able to choose one.
 */
function runDetail(graph?: string) {
  const log = new FakeLog();
  started(log, graph);
  return deriveDetail("r1", log.events);
}

type Reply = { status: number; body: unknown };

/**
 * Every GET /api/runs/<id> answers from this queue; the last entry repeats. `write` answers
 * every non-GET — the control verbs (pause/abort/resume) post, and what they get back is the
 * difference between a control that reports and one that swallows.
 */
function serve(replies: Reply[], write: Reply = { status: 200, body: { ok: true } }) {
  const calls: string[] = [];
  let i = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    if ((init?.method ?? "GET") !== "GET") return new Response(JSON.stringify(write.body), { status: write.status, headers: { "content-type": "application/json" } });
    // the page loads /shell (and, separately, /transcript). A fixture served as the shell still
    // carries its turns, which is what these tests render; the transcript answer is ignored
    // unless it is a `{ turns }` page. Every other read answers empty.
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0] ?? url;
    if (!/\/api\/runs\/[^/]+(?:\/shell)?$/.test(path)) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    const r = replies[Math.min(i++, replies.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls: () => calls.filter((u) => /\/api\/runs\/[^/]+(?:\/shell)?$/.test(u.replace(/^https?:\/\/[^/]+/, "").split("?")[0] ?? u)) };
}

/** the provider is the app shell's, so a control's toast is observable here as it is live */
function render(graceMs: number): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ToastProvider><RunView id="write-doc-abc" graceMs={graceMs} /></ToastProvider>));
  return host;
}

/** let the component's poll run: real timers, so this is the honest path */
async function settle(ms: number) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

beforeEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = StubEventSource;
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
  globalThis.fetch = realFetch;
});

describe("opening a run that has not been written yet", () => {
  test("a 404 shows the loading state and never blanks the page", async () => {
    serve([{ status: 404, body: { error: "unknown run" } }]);
    const el = render(OPEN_GRACE_MS);
    await settle(50);
    // the regression: the 404 body used to become `detail`, and `detail.timeline.map` threw
    // mid-render, leaving host.innerHTML empty
    expect(el.innerHTML).not.toBe("");
    expect(el.textContent).toContain("Loading run");
    expect(el.textContent).not.toContain("unknown run");
  });

  test("the run appears on a later poll and renders without a reload", async () => {
    const { calls } = serve([
      { status: 404, body: { error: "unknown run" } },
      { status: 404, body: { error: "unknown run" } },
      { status: 200, body: runDetail() },
    ]);
    const el = render(OPEN_GRACE_MS);
    await settle(50);
    expect(el.textContent).toContain("Loading run");
    await settle(800); // two polls at 300ms
    expect(calls().length).toBeGreaterThanOrEqual(3);
    expect(el.textContent).not.toContain("Loading run");
    expect(el.textContent).not.toContain("failed to start");
  });

  test("a run that never lands gives up with a reason instead of spinning", async () => {
    serve([{ status: 404, body: { error: "unknown run" } }]);
    const el = render(400); // the real grace is 10s; the seam keeps the test honest and quick
    await settle(50);
    expect(el.textContent).toContain("Loading run");
    await settle(700);
    expect(el.textContent).toContain("No run");
    expect(el.textContent).toContain("write-doc-abc");
    expect(el.textContent).toContain("failed to start");
    expect(el.querySelector("a[href='/']")).not.toBeNull();
  });

  test("a 500 is not state either — the page keeps its loading state", async () => {
    serve([{ status: 500, body: { error: "derive blew up" } }]);
    const el = render(OPEN_GRACE_MS);
    await settle(50);
    expect(el.innerHTML).not.toBe("");
    expect(el.textContent).not.toContain("derive blew up");
    expect(el.textContent).toContain("Loading run");
  });
});

/**
 * Abort is the one irreversible verb, so it confirms — and a confirmation that stays open
 * over its own failure is worse than none. The AlertDialog is a native <dialog> opened with
 * showModal(): it makes the rest of the document inert and covers it with a ::backdrop, and
 * BOTH explanations of a refused abort — the inline field-error and the aria-live toast
 * region — render outside it. So the dialog closes before the verb is sent, the way every
 * other confirmation in this app does.
 */
describe("the fan-out is visible from both ends (HOW-23)", () => {
  /** a plan-feature parent that launched two children, and one of those children */
  function fanOut() {
    const log = new FakeLog();
    log.add({ type: "run-started", graph: "plan-feature", inputs: { goal: "ship things" }, pinned_prompts: {} });
    log.add({ type: "node-started", node: "runs.launch", visit: 1, attempt_id: "runs.launch#1" });
    log.add({ type: "run-spawned", node: "runs.launch", visit: 1, child: "p--api", graph: "implement-ticket", slice_id: "api", ticket: "HOW-31", workspace: "api" });
    log.add({ type: "run-spawned", node: "runs.launch", visit: 1, child: "p--web", graph: "implement-ticket", slice_id: "web" });
    const child = new FakeLog();
    child.add({ type: "run-started", graph: "implement-ticket", inputs: { goal: "g" }, pinned_prompts: {}, parent: "p" });
    return { parent: deriveDetail("p", log.events), child: deriveDetail("p--api", child.events) };
  }

  test("the parent lists every run it launched, linked, with the ticket it came from", async () => {
    serve([{ status: 200, body: fanOut().parent }]);
    const el = render(OPEN_GRACE_MS);
    await settle(50);
    expect(el.textContent).toContain("Launched runs");
    expect([...el.querySelectorAll("a[href^='/run/p--']")].map((a) => a.textContent)).toEqual(["p--api", "p--web"]);
    // the identifier where there is one; the slice id is the fallback, never a blank label
    expect(el.textContent).toContain("HOW-31");
    expect(el.textContent).toContain("web");
    // no status per child: this run's log only knows that it launched them
    expect(el.querySelector("a[href='/run/p--api']")!.closest("section")!.textContent).not.toContain("running");
  });

  test("the child names the run that planned it; an ordinary run has no such row", async () => {
    const { child, parent } = fanOut();
    serve([{ status: 200, body: child }]);
    const el = render(OPEN_GRACE_MS);
    await settle(50);
    expect(el.textContent).toContain("planned by");
    expect(el.querySelector("a[href='/run/p']")!.textContent).toBe("p");
    expect(el.textContent).not.toContain("Launched runs"); // a child launched nothing
    act(() => root!.unmount());

    serve([{ status: 200, body: runDetail() }]);
    const plain = render(OPEN_GRACE_MS);
    await settle(50);
    expect(plain.textContent).not.toContain("planned by");
    expect(plain.textContent).not.toContain("Launched runs");
    expect(parent.children).toHaveLength(2); // the fixture really is a fan-out
  });
});

describe("aborting a run", () => {
  const controls = (el: HTMLElement) => [...el.querySelectorAll(".run-controls button")] as HTMLButtonElement[];
  const abortButton = (el: HTMLElement) => controls(el).find((b) => b.textContent!.startsWith("Abort"))!;
  const confirmButton = (el: HTMLElement) =>
    [...el.querySelectorAll("dialog button")].find((b) => b.textContent === "Abort the run") as HTMLButtonElement | undefined;

  async function openConfirm(el: HTMLElement) {
    await settle(50);
    await act(async () => abortButton(el).click());
    return el.querySelector("dialog")!;
  }

  test("the confirmation names the graph the run stops at, and Cancel leaves the run alone", async () => {
    const { calls } = serve([{ status: 200, body: runDetail("write-doc") }]);
    const el = render(OPEN_GRACE_MS);
    const dialog = await openConfirm(el);
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    expect(dialog.textContent).toContain("write-doc");
    expect(dialog.textContent).toContain("cannot be un-aborted");
    const before = calls().length;
    await act(async () => ([...dialog.querySelectorAll("button")].find((b) => b.textContent === "Cancel") as HTMLButtonElement).click());
    expect(el.querySelectorAll("dialog").length).toBe(0);
    expect(calls().length).toBe(before); // nothing was posted, and the poll is the only traffic
  });

  test("a refused abort closes the dialog, so its reason is readable and not behind a backdrop", async () => {
    serve([{ status: 200, body: runDetail() }], { status: 409, body: { error: "runner lock held by another process" } });
    const el = render(OPEN_GRACE_MS);
    const dialog = await openConfirm(el);
    await act(async () => confirmButton(el)!.click());
    // the regression: the dialog used to stay open on the failure path, with the field-error
    // and the toast region both outside it — inert, dimmed, and unreadable
    expect(el.querySelectorAll("dialog").length).toBe(0);
    expect(dialog.isConnected).toBe(false);
    expect(el.querySelector(".field-error")!.textContent).toBe("runner lock held by another process");
    expect(el.querySelector('[aria-live="polite"]')!.textContent).toContain("runner lock held by another process");
    // and the control is offered again rather than left saying "Aborting…"
    expect(abortButton(el).textContent).toBe("Abort");
    expect(abortButton(el).disabled).toBe(false);
  });

  test("an accepted abort closes the dialog and announces the outcome", async () => {
    serve([{ status: 200, body: runDetail() }], { status: 200, body: { ok: true } });
    const el = render(OPEN_GRACE_MS);
    await openConfirm(el);
    await act(async () => confirmButton(el)!.click());
    expect(el.querySelectorAll("dialog").length).toBe(0);
    expect(el.querySelectorAll(".field-error").length).toBe(0);
    expect(el.querySelector('[aria-live="polite"]')!.textContent).toContain("abort accepted");
  });
});

describe("HOW-49: the live progress panel on the run page", () => {
  test("a `git-live` push lands in the pinned panel and the rail while the step is live", async () => {
    StubEventSource.open = [];
    const log = new FakeLog();
    log.add({ type: "run-started", graph: "write-doc", inputs: { goal: "g" }, pinned_prompts: {} });
    log.add({ type: "node-started", node: "doc.draft", visit: 1, attempt_id: "doc.draft#1" });
    log.add({ type: "chunk", node: "doc.draft", visit: 1, turn: 1, index: 0, kind: "text", content: "drafting" });
    serve([{ status: 200, body: deriveDetail("r1", log.events, {}, { runnerAlive: true }) }]);
    const el = render(OPEN_GRACE_MS);
    await settle(50);
    expect(el.querySelectorAll(".progress-panel")).toHaveLength(2); // pinned + rail
    expect(el.textContent).toContain("worktree not probed yet");
    const at = new Date().toISOString();
    act(() => StubEventSource.open.at(-1)!.listeners.get("git-live")!({
      data: JSON.stringify({ node: "doc.draft", visit: 1, commits: [{ sha: "abc1234", subject: "docs: first draft", at }], commit_count: 1, uncommitted: 2, last_commit_at: at, base: null, probed_at: at }),
    }));
    expect(el.textContent).toContain("1 commit this step");
    expect(el.textContent).toContain("docs: first draft");
  });

  test("no panel once the run is not live", async () => {
    serve([{ status: 200, body: runDetail() }]);
    const el = render(OPEN_GRACE_MS);
    await settle(50);
    expect(el.querySelector(".progress-panel")).toBeNull();
  });
});
