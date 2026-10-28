/**
 * HOW-71: the Graphs page's way in is "Draft a graph" (HOW-56 D-1B), not the hand builder.
 * Primary vs secondary is asserted on the variant classes the Button primitive emits, and the
 * destination on where navigate() actually pushed history — not on a label.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GraphsList } from "./screens/graphs";
import { ToastProvider } from "./components/ui/toast";

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
const realUrl = location.pathname + location.search;

const catalog = {
  graphs: [
    { name: "quick-task", description: "d", inputs: ["goal"], kind: "plain", source: "builtin", builder: false },
    { name: "my-review", description: "d", inputs: ["goal"], kind: "plain", source: "local", builder: true },
    { name: "hand-written", description: "d", inputs: ["goal"], kind: "plain", source: "local", builder: false },
  ],
  problems: [],
};

/** /api/graphs answers the catalog; anything else (a selected graph's shape, its source) 404s */
function serve() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    if (path === "/api/graphs") return new Response(JSON.stringify(catalog), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

async function mount(): Promise<HTMLElement> {
  serve();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ToastProvider><GraphsList /></ToastProvider>));
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  return host;
}

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement | undefined;
const row = (el: HTMLElement, name: string) => el.querySelector(`[aria-label="the ${name} graph"]`) as HTMLElement;
/** select a row and let its shape fetch land, so nothing updates outside act() */
async function select(el: HTMLElement, name: string) {
  await act(async () => { row(el, name).click(); await new Promise((r) => setTimeout(r, 50)); });
}
const here = () => location.pathname + location.search;

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
  globalThis.fetch = realFetch;
  history.replaceState(null, "", realUrl);
});

describe("the Graphs page leads to drafting (HOW-71)", () => {
  test("\"Draft a graph\" is the primary action, first, and opens New run with draft-graph picked", async () => {
    const el = await mount();
    const draft = button(el, "Draft a graph")!;
    const byHand = button(el, "Build by hand")!;
    expect(draft).toBeDefined();
    expect(byHand).toBeDefined();
    expect(draft.compareDocumentPosition(byHand) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(draft.className).toContain("bg-primary");
    expect(draft.className).not.toContain("border-input");
    act(() => draft.click());
    expect(here()).toBe("/new?graph=draft-graph");
  });

  test("\"Build by hand\" stays reachable, as the outline secondary, and opens the empty builder", async () => {
    const el = await mount();
    const byHand = button(el, "Build by hand")!;
    expect(byHand.className).toContain("border-input");
    expect(byHand.className).not.toContain("bg-primary");
    act(() => byHand.click());
    expect(here()).toBe("/graphs/new");
  });

  test("the old \"Build a graph\" label is gone from the page", async () => {
    const el = await mount();
    expect(button(el, "Build a graph")).toBeUndefined();
  });

  test("a selected graph the builder can open is passed as the base", async () => {
    const el = await mount();
    await select(el, "my-review");
    act(() => button(el, "Draft a graph")!.click());
    expect(here()).toBe("/new?graph=draft-graph&base=my-review");
  });

  test("a selected graph New run would not offer as a base is not passed — built-in or hand-written", async () => {
    for (const name of ["quick-task", "hand-written"]) {
      const el = await mount();
      await select(el, name);
      act(() => button(el, "Draft a graph")!.click());
      expect(here(), name).toBe("/new?graph=draft-graph");
      act(() => root!.unmount());
      host?.remove();
      root = host = null;
    }
  });
});
