/**
 * HOW-48 — the run header while an agent turn is live: "Stop at next tool call" is the primary
 * action, and the hard stop sits in a menu with a line saying how the two differ.
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

describe("the run header on a live agent turn", () => {
  test("'Stop at next tool call' is the primary action; there is no bare Pause beside it", () => {
    const el = render({ softStoppable: true });
    expect(buttons(el)[0]!.textContent).toBe("Stop at next tool call");
    expect(buttons(el).some((b) => b.textContent === "Pause")).toBe(false);
  });

  test("'Stop now' sits in the menu with a line explaining the difference", () => {
    const el = render({ softStoppable: true });
    const more = el.querySelector('[aria-label="more ways to stop"]') as HTMLButtonElement;
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(el.querySelector(".run-menu")).toBeNull();
    act(() => more.click());
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const menu = el.querySelector('.run-menu[role="menu"]')!;
    expect(menu.querySelector('[role="menuitem"]')!.textContent).toBe("Stop now");
    expect(menu.querySelector(".run-menu-note")!.textContent).toContain("Stop now interrupts the agent wherever it is");
    expect(menu.querySelector(".run-menu-note")!.textContent).toContain("Stop at next tool call lets it finish its thought");
  });

  test("the soft stop posts to /soft-stop; Stop now posts to the old pause", async () => {
    const posted: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "GET") posted.push(String(input));
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }) as typeof fetch;
    const el = render({ softStoppable: true });
    await act(async () => { buttons(el)[0]!.click(); await new Promise((r) => setTimeout(r, 10)); });
    act(() => (el.querySelector('[aria-label="more ways to stop"]') as HTMLButtonElement).click());
    await act(async () => { (el.querySelector('[role="menuitem"]') as HTMLButtonElement).click(); await new Promise((r) => setTimeout(r, 10)); });
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
  });

  test("a step that is not a steerable agent turn keeps the plain Pause", () => {
    const el = render({ softStoppable: false });
    expect(buttons(el)[0]!.textContent).toBe("Pause");
    expect(el.querySelector('[aria-label="more ways to stop"]')).toBeNull();
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
