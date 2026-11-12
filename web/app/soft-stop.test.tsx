/**
 * HOW-48 — the run header while an agent turn is live: "Stop at next tool call" is the primary
 * action, and the hard stop sits in a menu with a line saying how the two differ.
 *
 * HOW-68: that menu is the header's ONE More menu now (`components/ui/menu`, on Base UI, so
 * its popup is portalled to the document) instead of a hand-written popover of its own, and an
 * overdue soft stop turns the visible control INTO Stop now rather than adding a sentence and
 * a second button to a header that must stay one row. What is pinned is unchanged: which verb
 * is primary, that Stop now explains itself, and which route each one posts to.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RunDetail } from "../derive";
import { RunControls } from "./run/view";
import { suggestionsFor } from "./run/chat";
import { deriveDetail } from "../derive";
import { FakeLog } from "../slice.fixtures";
import { ToastProvider } from "@/components/ui/toast";

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
  globalThis.fetch = realFetch;
});

const RUNNING = {
  graph: "implement-ticket", name: null, parent: null, goal: "g", status: "running", started_at: null, last_event_at: null,
  waiting_since: null, needs_input_reason: null, failure: null, paused: false, outcome: null,
} as RunDetail["summary"];

function render(props: Partial<Parameters<typeof RunControls>[0]> = {}): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ToastProvider><RunControls runId="r1" summary={RUNNING} onAction={() => {}} {...props} /></ToastProvider>));
  return host;
}
const buttons = (el: HTMLElement) => [...el.querySelectorAll(".run-controls button")] as HTMLButtonElement[];
const moreButton = (el: HTMLElement) => el.querySelector('.run-controls button[aria-haspopup="menu"]') as HTMLButtonElement;
const menuItem = (label: string) => [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent === label) as HTMLElement | undefined;

describe("the run header on a live agent turn", () => {
  test("'Stop at next tool call' is the primary action; there is no bare Pause beside it", () => {
    const el = render({ softStoppable: true });
    expect(buttons(el)[0]!.textContent).toBe("Stop at next tool call");
    expect(buttons(el).some((b) => b.textContent === "Pause")).toBe(false);
  });

  test("'Stop now' sits in the menu with a line explaining the difference", async () => {
    const el = render({ softStoppable: true });
    const more = moreButton(el);
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await act(async () => more.click());
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const menu = document.querySelector('[role="menu"]')!;
    expect(menuItem("Stop now")).toBeDefined();
    expect(menu.textContent).toContain("Stop now interrupts the agent wherever it is");
    expect(menu.textContent).toContain("Stop at next tool call lets it finish its thought");
    // the explanation is prose under the item, not something the arrow keys land on
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent)).toEqual(["Stop now", "Abort the run…"]);
  });

  test("the soft stop posts to /soft-stop; Stop now posts to the old pause", async () => {
    const posted: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "GET") posted.push(String(input));
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }) as typeof fetch;
    const el = render({ softStoppable: true });
    await act(async () => { buttons(el)[0]!.click(); await new Promise((r) => setTimeout(r, 10)); });
    await act(async () => moreButton(el).click());
    await act(async () => { menuItem("Stop now")!.click(); await new Promise((r) => setTimeout(r, 10)); });
    expect(posted).toEqual(["/api/runs/r1/soft-stop", "/api/runs/r1/pause"]);
  });

  test("once asked, the action says it is on its way and cannot be sent twice", () => {
    const el = render({ softStoppable: true, softStop: { node: "b", visit: 1, requested_at: new Date().toISOString(), state: "requested" } });
    expect(buttons(el)[0]!.textContent).toBe("Stopping at next tool call…");
    expect(buttons(el)[0]!.disabled).toBe(true);
    expect(el.querySelector(".run-escalate")).toBeNull();
  });

  test("a stop that has not taken effect within the escalation window offers Stop now", () => {
    const now = Date.now();
    const el = render({ softStoppable: true, now, escalateMs: 120_000, softStop: { node: "b", visit: 1, requested_at: new Date(now - 125_000).toISOString(), state: "delivered" } });
    const escalate = el.querySelector(".run-escalate")!;
    expect(escalate.textContent).toContain("not stopped after 2m 5s");
    expect(escalate.querySelector("button")!.textContent).toBe("Stop now");
    // it REPLACES the spinner that had stopped meaning anything; it is not a second control
    expect(buttons(el)[0]!.textContent).toBe("Stop now");
  });

  test("a step that is not a steerable agent turn keeps the plain Pause", async () => {
    const el = render({ softStoppable: false });
    expect(buttons(el)[0]!.textContent).toBe("Pause");
    // Pause already IS the hard stop here, so the menu does not offer it a second time
    await act(async () => moreButton(el).click());
    expect(menuItem("Stop now")).toBeUndefined();
    expect(menuItem("Abort the run…")).toBeDefined();
  });
});

describe("a soft-stopped step is not a failure", () => {
  test("the starting suggestions do not ask why it failed", () => {
    const log = new FakeLog();
    log.add({ type: "run-started", graph: "g", inputs: {}, pinned_prompts: {} });
    log.add({ type: "node-started", node: "build", visit: 1, attempt_id: "build#1" });
    log.add({ type: "node-finished", node: "build", visit: 1, status: "failed", writes: {} });
    log.add({ type: "attention-raised", node: "build", visit: 1, reason: "paused by the operator", code: "paused-by-operator" });
    const detail = deriveDetail("r", log.events);
    expect(suggestionsFor(detail, detail.ask).map((s) => s.kind)).toEqual(["waiting"]);
  });
});
