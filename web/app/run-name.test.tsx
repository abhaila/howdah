/**
 * HOW-18: a run's operator-given name is what the viewer calls it — the Runs list row, the run
 * heading and the Identity rail — with the goal, then the id, as the fallback. And the launch
 * form sends the name it collects through the `Input` primitive (no raw fields outside ui/).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deriveDetail, deriveSummary } from "../derive";
import { FakeLog } from "../slice.fixtures";
import { runLabel } from "./lib/format";
import { RunsList } from "./screens/runs";
import { StartRun } from "./screens/start-run";
import { RunView, OPEN_GRACE_MS } from "./run/view";
import { ToastProvider } from "./components/ui/toast";

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
const realAssign = window.location.assign;

class StubEventSource {
  onmessage: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  /** HOW-49: named events (`git-live`) are listened for, as on the real EventSource */
  addEventListener(_type: string, _fn: (e: unknown) => void) {}
  close() {}
}

function logFor(name?: string, goal = "add a user endpoint") {
  const log = new FakeLog();
  log.add({ type: "run-started", graph: "write-doc", ...(name ? { name } : {}), inputs: { goal }, pinned_prompts: {} });
  return log.events;
}

type Posted = { url: string; body: unknown };
/** GETs answer from `reads` by exact path (else `[]`); writes are recorded and answered `write` */
function serve(reads: Record<string, unknown>, write: unknown = { ok: true }) {
  const posted: Posted[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    if ((init?.method ?? "GET") !== "GET") {
      posted.push({ url: path, body: JSON.parse(String(init?.body ?? "null")) });
      return new Response(JSON.stringify(write), { status: 202, headers: { "content-type": "application/json" } });
    }
    const body = path in reads ? reads[path] : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return posted;
}

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ToastProvider>{node}</ToastProvider>));
  return host;
}

async function settle(ms = 50) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

function type(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof window.HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof window.HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = StubEventSource;
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
  globalThis.fetch = realFetch;
  window.location.assign = realAssign;
});

describe("the derived name (HOW-18)", () => {
  test("a named run carries its name; a legacy log without one derives null", () => {
    expect(deriveSummary("r1", logFor("Fix login")).name).toBe("Fix login");
    expect(deriveSummary("r1", logFor()).name).toBeNull();
    expect(deriveSummary("r1", []).name).toBeNull(); // not even started
  });

  test("runLabel: name, then goal, then id", () => {
    expect(runLabel({ id: "g-1", name: "Fix login", goal: "the goal" })).toBe("Fix login");
    expect(runLabel({ id: "g-1", name: null, goal: "the goal" })).toBe("the goal");
    expect(runLabel({ id: "g-1", name: null, goal: "" })).toBe("g-1");
    expect(runLabel({ id: "g-1" })).toBe("g-1");
  });
});

describe("the Runs list (HOW-18)", () => {
  test("a named row shows the name; an unnamed one still shows its goal", async () => {
    serve({ "/api/runs": [deriveSummary("named-1", logFor("Fix login", "goal A")), deriveSummary("plain-1", logFor(undefined, "goal B"))] });
    const el = mount(<RunsList />);
    await settle();
    const labels = [...el.querySelectorAll(".run-goal")].map((n) => n.textContent);
    expect(labels).toEqual(["Fix login", "goal B"]);
  });
});

describe("the run page (HOW-18)", () => {
  test("the heading is the name, and the Identity rail lists it beside the graph", async () => {
    serve({ "/api/runs/write-doc-abc": deriveDetail("write-doc-abc", logFor("Fix login")) });
    const el = mount(<RunView id="write-doc-abc" graceMs={OPEN_GRACE_MS} />);
    await settle();
    expect(el.querySelector(".topbar h1")!.textContent).toBe("Fix login");
    const rows = [...el.querySelectorAll(".rail .kv")].map((r) => [r.querySelector(".k")?.textContent, r.lastElementChild?.textContent]);
    expect(rows).toContainEqual(["name", "Fix login"]);
    expect(rows).toContainEqual(["run", "write-doc-abc"]); // the id is still shown — it is identity
  });

  test("an unnamed run renders as before: goal heading, no name row", async () => {
    serve({ "/api/runs/write-doc-abc": deriveDetail("write-doc-abc", logFor()) });
    const el = mount(<RunView id="write-doc-abc" graceMs={OPEN_GRACE_MS} />);
    await settle();
    expect(el.querySelector(".topbar h1")!.textContent).toBe("add a user endpoint");
    expect([...el.querySelectorAll(".rail .kv .k")].map((k) => k.textContent)).not.toContain("name");
  });
});

describe("the launch form (HOW-18)", () => {
  const catalog = {
    "/api/graphs": { graphs: [{ name: "research", description: "d", inputs: ["goal"], kind: "plain", source: "builtin" }], problems: [] },
    "/api/workspaces": { repos: [], folders: [] },
  };

  async function fill(el: HTMLElement, name: string) {
    await settle();
    type(el.querySelector("select")!, "research");
    const nameField = [...el.querySelectorAll("label")].find((l) => l.textContent!.startsWith("Run name (optional)"))!.querySelector("input")!;
    const goalField = [...el.querySelectorAll("label")].find((l) => l.textContent!.startsWith("goal"))!.querySelector("input")!;
    type(nameField, name);
    type(goalField, "find things");
    return nameField;
  }

  test("the name field is the Input primitive, and the POST carries the trimmed name", async () => {
    const posted = serve(catalog, { id: "research-abc" });
    const assigned: string[] = [];
    window.location.assign = ((u: string) => { assigned.push(u); }) as typeof window.location.assign;
    const el = mount(<StartRun />);
    const nameField = await fill(el, "  Fix login  ");
    expect(nameField.className).toContain("font-mono"); // Input's own classes — not a raw <input>
    await act(async () => ([...el.querySelectorAll("button")].find((b) => b.textContent!.includes("Launch run")) as HTMLButtonElement).click());
    await settle();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ url: "/api/runs", body: { graph: "research", name: "Fix login", inputs: { goal: "find things" } } });
    expect(assigned).toEqual(["/run/research-abc"]);
  });

  test("a blank name is not sent at all", async () => {
    const posted = serve(catalog, { id: "research-abc" });
    window.location.assign = (() => {}) as typeof window.location.assign;
    const el = mount(<StartRun />);
    await fill(el, "   ");
    await act(async () => ([...el.querySelectorAll("button")].find((b) => b.textContent!.includes("Launch run")) as HTMLButtonElement).click());
    await settle();
    expect(posted).toHaveLength(1);
    expect("name" in (posted[0]!.body as object)).toBe(false);
  });
});

// HOW-57: implement-stacked's `deps` names sibling runs only its plan-feature parent knows, so
// a free-text box for it was a trap ("merged" typed in, then a park on unparseable JSON)
describe("the launch form leaves out graphs another graph starts", () => {
  test("a launched_by graph is not offered; the others are", async () => {
    serve({
      "/api/graphs": { graphs: [
        { name: "research", description: "d", inputs: ["goal"], kind: "plain", source: "builtin" },
        { name: "implement-stacked", description: "d", inputs: ["goal", "work", "deps"], kind: "repo", source: "builtin", launched_by: "plan-feature" },
      ], problems: [] },
      "/api/workspaces": { repos: [], folders: [] },
    });
    const el = mount(<StartRun />);
    await settle();
    const options = [...el.querySelectorAll("select option")].map((o) => o.textContent);
    expect(options.some((o) => o?.includes("research"))).toBe(true);
    expect(options.some((o) => o?.includes("implement-stacked"))).toBe(false);
  });
});

