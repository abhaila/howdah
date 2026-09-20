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

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

/** happy-dom has no EventSource, and RunView opens one as soon as a detail lands. */
class StubEventSource {
  onmessage: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  close() {}
}

/** the smallest log that derives a real RunDetail */
function runDetail() {
  const log = new FakeLog();
  started(log);
  return deriveDetail("r1", log.events);
}

type Reply = { status: number; body: unknown };

/** every GET /api/runs/<id> answers from this queue; the last entry repeats */
function serve(replies: Reply[]) {
  const calls: string[] = [];
  let i = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    // every other read model the page touches answers empty; only the run detail matters here
    if (!/\/api\/runs\/[^/]+$/.test(url)) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    const r = replies[Math.min(i++, replies.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls: () => calls.filter((u) => /\/api\/runs\/[^/]+$/.test(u)) };
}

function render(graceMs: number): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<RunView id="write-doc-abc" graceMs={graceMs} />));
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
