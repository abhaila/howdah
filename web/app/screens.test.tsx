/**
 * HOW-68 — the top-level screens on the shared frame (screens/frame.tsx): what the redesign
 * ADDED that nothing else pins. The list + detail split that shows one pane below 1100px, the
 * Settings switches that act at once (single-key shortcuts, desktop notifications), the launch
 * form's command preview and its reasons in words, and the diff that never relies on colour.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider } from "./components/ui/toast";
import { installShortcuts, resetShortcutsForTest, singleKeysEnabled } from "./lib/shortcuts";
import { Diff, PromptsScreen, promptFacts } from "./screens/prompts";
import { ProposalsScreen } from "./screens/proposals";
import { Settings } from "./screens/settings";
import { StartRun, launchCommand } from "./screens/start-run";

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
const setWidth = (width: number) => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height: 900 });

type Call = { url: string; method: string; body: unknown };
function serve(reads: Record<string, unknown | { status: number; body: unknown }>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).replace(/^https?:\/\/[^/]+/, "");
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const hit = reads[`${method} ${url}`] ?? reads[url] ?? reads[url.split("?")[0]!];
    const wrapped = hit !== null && typeof hit === "object" && "status" in (hit as object) && "body" in (hit as object) ? hit as { status: number; body: unknown } : { status: 200, body: hit ?? [] };
    return new Response(JSON.stringify(wrapped.body), { status: wrapped.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<ToastProvider>{node}</ToastProvider>); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  return host;
}
const button = (el: HTMLElement, name: string | RegExp) =>
  [...el.querySelectorAll("button")].find((b) => { const t = (b.getAttribute("aria-label") ?? b.textContent ?? "").trim(); return typeof name === "string" ? t === name : name.test(t); }) as HTMLButtonElement | undefined;
const press = (init: KeyboardEventInit, target: EventTarget = document.body) => act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });

let uninstall: (() => void) | null = null;
beforeEach(() => { resetShortcutsForTest(); localStorage.clear(); uninstall = installShortcuts(); });
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
  globalThis.fetch = realFetch;
  uninstall?.();
  resetShortcutsForTest();
  delete (globalThis as { Notification?: unknown }).Notification;
  setWidth(1024);
  history.replaceState(null, "", "/");
});

const PROMPTS = [
  { id: "delivery.publish", version: 4, tags: [], proposals: { pending: 1 }, feedback: { count: 2, rejects: 2 }, outcomes: { renders: 12, success: 9, failed: 2, aborted: 0, pending: 1 } },
  { id: "implementation.plan", version: 1, tags: [], proposals: { pending: 0 }, feedback: { count: 0, rejects: 0 }, outcomes: { renders: 0, success: 0, failed: 0, aborted: 0, pending: 0 } },
];
const DETAIL = { ...PROMPTS[0], body: "Publish the work.\n", accepted_at: null, provenance: null, history: [], feedback_entries: [], indirect_feedback: [], outcome_rows: [], by_version: {}, consumers: [{ graph: "implement-ticket", node: "delivery.publish" }] };

describe("the list + detail split (DESIGN.md Layout: below 1100px the detail replaces the list)", () => {
  const reads = { "/api/prompts": PROMPTS, "/api/prompts/delivery.publish": DETAIL };

  test("wide: both panes, each its own scroller, no Back", async () => {
    setWidth(1440);
    serve(reads);
    const el = await mount(<PromptsScreen selected="delivery.publish" />);
    expect(el.querySelector("[data-screen='prompts']")!.getAttribute("data-split")).toBe("both");
    expect(el.querySelectorAll("[data-slot='scroll-pane']")).toHaveLength(2);
    expect(el.querySelector("[data-pane='list']")).not.toBeNull();
    expect(el.querySelector("[data-pane='detail']")!.textContent).toContain("Publish the work.");
    expect(el.querySelector("[data-slot='split-back']")).toBeNull();
    expect(el.querySelector('a[aria-current="page"]')!.getAttribute("href")).toBe("/prompts/delivery.publish");
  });

  test("narrow with nothing selected: the list alone", async () => {
    serve(reads);
    const el = await mount(<PromptsScreen selected={null} />);
    expect(el.querySelector("[data-screen='prompts']")!.getAttribute("data-split")).toBe("list");
    expect(el.querySelectorAll("a[data-nav-row]")).toHaveLength(2);
    expect(el.querySelector("[data-pane='detail']")).toBeNull();
  });

  test("narrow with a selection: the detail alone, named in the header, with a Back link that Esc follows", async () => {
    serve(reads);
    const el = await mount(<PromptsScreen selected="delivery.publish" />);
    expect(el.querySelector("[data-screen='prompts']")!.getAttribute("data-split")).toBe("detail");
    expect(el.querySelector("[data-pane='list']")).toBeNull();
    expect(el.querySelector("h1")!.textContent).toBe("delivery.publish");
    const back = el.querySelector("[data-slot='split-back']") as HTMLAnchorElement;
    expect(back.getAttribute("href")).toBe("/prompts");
    expect(back.textContent).toBe("Prompts");
    let clicked = 0;
    back.addEventListener("click", (e) => { e.preventDefault(); clicked++; });
    press({ key: "Escape" });
    expect(clicked).toBe(1);
  });

  test("a prompt that does not exist says so, instead of a skeleton that never resolves", async () => {
    setWidth(1440);
    serve({ "/api/prompts": PROMPTS, "/api/prompts/nope": { status: 404, body: { error: "unknown prompt" } } });
    const el = await mount(<PromptsScreen selected="nope" />);
    expect(el.textContent).toContain("No such prompt");
    expect(el.querySelector('[data-pane="detail"] [role="status"]')).toBeNull();
  });

  test("a list row says what happened to a prompt in words; a pending proposal is a neutral chip, never amber", async () => {
    setWidth(1440);
    serve(reads);
    const el = await mount(<PromptsScreen selected={null} />);
    expect(promptFacts(PROMPTS[0]!)).toBe("v4 · 12 runs · 2 rejected");
    expect(promptFacts(PROMPTS[1]!)).toBe("v1");
    const row = el.querySelector('a[href="/prompts/delivery.publish"]')!;
    expect(row.textContent).toContain("v4 · 12 runs · 2 rejected");
    expect(row.textContent).toContain("1 proposed");
    expect(row.outerHTML).not.toContain("attention");
  });

  test("J/K move through the list; the arrows are the list's own, so the detail pane keeps them for scrolling", async () => {
    setWidth(1440);
    serve(reads);
    const el = await mount(<PromptsScreen selected="delivery.publish" />);
    press({ key: "j" });
    expect((document.activeElement as HTMLElement).getAttribute("href")).toBe("/prompts/delivery.publish");
    press({ key: "ArrowDown" }, document.activeElement!); // focus is IN the list: the arrow moves
    expect((document.activeElement as HTMLElement).getAttribute("href")).toBe("/prompts/implementation.plan");
    const detail = el.querySelector("[data-pane='detail']") as HTMLElement;
    const before = document.activeElement;
    const arrow = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    act(() => { detail.dispatchEvent(arrow); });
    expect(arrow.defaultPrevented).toBe(false); // outside the list the arrow is left to the platform
    expect(document.activeElement).toBe(before);
  });
});

describe("proposals on the split frame", () => {
  const P = { file: "a.proposal.md", id: "delivery.publish", base_version: 4, proposed_version: 5, current_version: 4, status: "pending", stale: false, created: null, eval: {}, feedback: [], reflection: "", diff: "", body: "x", rejection_reason: null, rejected_at: null, accepted_at: null };

  test("ONE primary action: Accept; pending is a neutral chip; narrow with no selection shows the list only", async () => {
    setWidth(1440);
    serve({ "/api/proposals": [P] });
    const el = await mount(<ProposalsScreen selected={null} />);
    const primaries = [...el.querySelectorAll("button")].filter((b) => b.className.includes("bg-primary"));
    expect(primaries.map((b) => b.textContent)).toEqual(["Accept as v5"]);
    expect(el.querySelector("[data-pane='detail']")!.outerHTML).not.toContain("attention");
    act(() => root!.unmount());
    host!.remove();
    setWidth(1024);
    const narrow = await mount(<ProposalsScreen selected={null} />);
    expect(narrow.querySelector("[data-screen='proposals']")!.getAttribute("data-split")).toBe("list");
    expect(button(narrow, "Reject")).toBeUndefined();
  });
});

describe("Diff: a sign as well as a colour", () => {
  test("every added and removed line carries its sign in a gutter, and says so to a screen reader", async () => {
    const el = await mount(<Diff text={"--- a v1\n+++ a v2\n@@ -1 +1 @@\n context\n-old line\n+new line"} />);
    const lines = [...el.querySelectorAll("[data-line]")].map((l) => [l.getAttribute("data-line"), l.firstElementChild!.textContent, l.lastElementChild!.textContent]);
    expect(lines).toEqual([
      ["meta", "", "--- a v1"], ["meta", "", "+++ a v2"], ["hunk", "", "@@ -1 +1 @@"],
      ["ctx", "", "context"], ["del", "−", "old line"], ["add", "+", "new line"],
    ]);
    expect(el.querySelector('[data-line="add"] .sr-only')!.textContent).toBe("added: ");
    expect(el.querySelector('[data-line="del"] .sr-only')!.textContent).toBe("removed: ");
    // not its own scroller: the pane scrolls, once
    expect(el.querySelector("[data-slot='diff']")!.className).not.toMatch(/overflow-(y-)?auto|max-h-/);
  });
});

describe("Settings", () => {
  const WS = { repos: [{ name: "acme-api", path: "/Users/someone/code/work/acme/services/acme-api" }], folders: [{ name: "notes", path: "/Users/someone/notes" }] };
  const reads = { "/api/settings": { editorCommand: "code", chime: false, typesafeApiKeyState: "unset" }, "/api/workspaces": WS, "/api/github/repos": [] };

  test("sections, each under a heading that is not uppercase", async () => {
    serve(reads);
    const el = await mount(<Settings />);
    expect([...el.querySelectorAll("section[data-section] h2")].map((h) => h.textContent)).toEqual(["Editor", "Notifications and sound", "Keyboard", "Integrations", "Workspaces2"]);
    for (const h of el.querySelectorAll("h2")) expect(h.className).not.toContain("uppercase");
  });

  test("Single-key shortcuts is wired to the registry's setting, at once", async () => {
    serve(reads);
    const el = await mount(<Settings />);
    const box = [...el.querySelectorAll("label")].find((l) => l.textContent === "Single-key shortcuts")!.parentElement!.querySelector("input")!;
    expect(box.checked).toBe(true);
    expect(singleKeysEnabled()).toBe(true);
    await act(async () => { box.click(); });
    expect(singleKeysEnabled()).toBe(false);
    expect(box.checked).toBe(false);
    await act(async () => { box.click(); });
    expect(singleKeysEnabled()).toBe(true);
  });

  test("the browser's permission is shown as it is, and asked for ONLY on the button's click", async () => {
    let permission: NotificationPermission = "default";
    let asked = 0;
    const shown: string[] = [];
    (globalThis as { Notification?: unknown }).Notification = class {
      static get permission() { return permission; }
      static requestPermission() { asked++; permission = "granted"; return Promise.resolve(permission); }
      onclick: (() => void) | null = null;
      constructor(title: string) { shown.push(title); }
      close() {}
    };
    serve(reads);
    const el = await mount(<Settings />);
    expect(asked).toBe(0); // never on load
    const state = el.querySelector("[data-slot='notify-permission']")!;
    expect(state.getAttribute("data-permission")).toBe("default");
    expect(button(el, "Send a test notification")!.disabled).toBe(true);
    await act(async () => { button(el, "Enable desktop notifications")!.click(); await new Promise((r) => setTimeout(r, 10)); });
    expect(asked).toBe(1);
    expect(state.getAttribute("data-permission")).toBe("granted");
    expect(button(el, "Enable desktop notifications")).toBeUndefined();
    await act(async () => { button(el, "Send a test notification")!.click(); });
    expect(shown).toEqual(["Howdah"]);
  });

  test("a browser with no Notification API says so and offers nothing to press", async () => {
    serve(reads);
    const el = await mount(<Settings />);
    expect(el.querySelector("[data-slot='notify-permission']")!.getAttribute("data-permission")).toBe("unsupported");
    expect(button(el, "Enable desktop notifications")).toBeUndefined();
    expect(button(el, "Send a test notification")!.disabled).toBe(true);
  });

  test("a workspace's NAME is never cut; its path is a Truncate with a copy button; remove is a named 24px control that asks first (audit 3.1.9, 3.5)", async () => {
    serve(reads);
    const el = await mount(<Settings />);
    const row = el.querySelector("[data-workspace='acme-api']")!;
    const name = row.querySelector("[data-col='name']")!;
    expect(name.textContent).toBe("acme-api");
    expect(name.className).not.toContain("truncate");
    expect(name.querySelector("[data-slot='truncate']")).toBeNull();
    expect(row.querySelector("[data-slot='truncate']")!.textContent).toBe("/Users/someone/code/work/acme/services/acme-api"); // whole, in order, in the DOM
    expect(button(el, "Copy the acme-api path")).toBeDefined();
    const remove = button(el, "remove the notes workspace")!;
    expect(remove.className).toContain("size-6");
    await act(async () => { remove.click(); });
    expect(el.querySelector("dialog")!.getAttribute("role")).toBe("alertdialog");
    expect(el.querySelector("dialog")!.textContent).toContain("left exactly as they are");
  });

  test("a gh failure is an inline error that says what to do, keeps the tool's words, and offers Retry (audit 3.8)", async () => {
    const calls = serve({ ...reads, "/api/github/repos": { status: 502, body: { error: "gh: To get started with GitHub CLI, please run:  gh auth login" } } });
    const el = await mount(<Settings />);
    const err = el.querySelector("[data-slot='gh-error']")!;
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.textContent).toContain("gh auth login");
    expect(err.textContent).toContain("gh: To get started with GitHub CLI"); // verbatim
    const before = calls.filter((c) => c.url.startsWith("/api/github/repos")).length;
    await act(async () => { button(el, "Retry")!.click(); await new Promise((r) => setTimeout(r, 10)); });
    expect(calls.filter((c) => c.url.startsWith("/api/github/repos")).length).toBe(before + 1);
  });

  test("Save is the one primary action, and mod+S saves from anywhere", async () => {
    const calls = serve(reads);
    const el = await mount(<Settings />);
    expect([...el.querySelectorAll("button")].filter((b) => b.className.includes("bg-primary")).map((b) => b.textContent!.replace(/(Ctrl S|⌘S)$/, "").trim())).toEqual(["Save"]);
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 20)); });
    expect(calls.filter((c) => c.method === "PUT" && c.url === "/api/settings")).toHaveLength(1);
  });
});

describe("New run", () => {
  const reads = {
    "/api/graphs": { graphs: [{ name: "implement-ticket", description: "Deliver one ticket", inputs: ["goal", "work"], kind: "repo", source: "builtin", builder: false }], problems: [] },
    "/api/workspaces": { repos: [{ name: "acme-api", path: "/code/acme-api" }], folders: [] },
  };
  const type = (el: HTMLInputElement | HTMLSelectElement, value: string) => act(() => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
  const field = (el: HTMLElement, label: string) => [...el.querySelectorAll("label")].find((l) => l.textContent!.startsWith(label))!.querySelector("input, select") as HTMLInputElement | HTMLSelectElement;

  test("launchCommand is the argv the server spawns, without the id it mints, quoted for a shell", () => {
    expect(launchCommand({ graph: "quick-task", inputs: { goal: "fix the user's login" }, workspace: "acme-api", name: "Fix login", overrides: { model: "claude-opus-5" } }))
      .toBe(`bun cli/main.ts run quick-task -i 'goal=fix the user'\\''s login' --workspace acme-api --name 'Fix login' --model claude-opus-5`);
    expect(launchCommand({ graph: "research" })).toBe("bun cli/main.ts run research");
  });

  test("what is missing is said in words beside the one primary action, and the command follows the form", async () => {
    serve(reads);
    const el = await mount(<StartRun />);
    const missing = () => el.querySelector("[data-slot='launch-missing']")!.textContent;
    expect(missing()).toBe("Still needed: a graph.");
    type(field(el, "Graph"), "implement-ticket");
    expect(missing()).toBe("Still needed: goal, work, a repo workspace.");
    expect(button(el, /^Launch run/)!.disabled).toBe(true);
    type(field(el, "goal"), "rate limit headers");
    type(field(el, "work"), "HOW-431");
    type(field(el, "Workspace"), "acme-api");
    expect(missing()).not.toContain("Still needed");
    expect(button(el, /^Launch run/)!.disabled).toBe(false);
    expect(el.querySelector("[data-slot='launch-command']")!.textContent).toBe("bun cli/main.ts run implement-ticket -i 'goal=rate limit headers' -i work=HOW-431 --workspace acme-api");
    expect([...el.querySelectorAll("button")].filter((b) => b.className.includes("bg-primary"))).toHaveLength(1);
  });

  test("mod+Enter launches from inside a field, and does nothing while something is missing", async () => {
    const calls = serve({ ...reads, "POST /api/runs": { status: 202, body: { id: "implement-ticket-abc" } } });
    const realAssign = window.location.assign;
    const assigned: string[] = [];
    window.location.assign = ((u: string) => { assigned.push(u); }) as typeof window.location.assign;
    try {
      const el = await mount(<StartRun />);
      type(field(el, "Graph"), "implement-ticket");
      const goal = field(el, "goal");
      const chord = () => act(async () => { goal.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 20)); });
      await chord();
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
      type(goal, "g");
      type(field(el, "work"), "w");
      type(field(el, "Workspace"), "acme-api");
      await chord();
      expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ graph: "implement-ticket", inputs: { goal: "g", work: "w" }, workspace: "acme-api", overrides: {} }]);
      expect(assigned).toEqual(["/run/implement-ticket-abc"]);
    } finally {
      window.location.assign = realAssign;
    }
  });

  test("run overrides sit behind an Advanced options disclosure", async () => {
    serve(reads);
    const el = await mount(<StartRun />);
    type(field(el, "Graph"), "implement-ticket");
    const toggle = button(el, "Advanced options")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(el.querySelector("#run-overrides")).toBeNull();
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(el.querySelector("#run-overrides")!.textContent).toContain("Harness");
  });
});

describe("a read that failed says so (it is neither empty nor still loading)", () => {
  test("Prompts: the server not answering is not 'no prompts yet', and Try again reads again", async () => {
    setWidth(1440);
    const calls = serve({ "/api/prompts": { status: 500, body: { error: "boom" } } });
    const el = await mount(<PromptsScreen selected={null} />);
    expect(el.textContent).toContain("Could not load the prompts");
    expect(el.textContent).not.toContain("No prompts yet");
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
    const before = calls.filter((c) => c.url === "/api/prompts").length;
    await act(async () => { button(el, "Try again")!.click(); await new Promise((r) => setTimeout(r, 10)); });
    expect(calls.filter((c) => c.url === "/api/prompts").length).toBe(before + 1);
  });

  test("Proposals and Settings: the same", async () => {
    setWidth(1440);
    serve({ "/api/proposals": { status: 500, body: {} }, "/api/settings": { status: 500, body: {} }, "/api/workspaces": { repos: [], folders: [] } });
    const proposals = await mount(<ProposalsScreen selected={null} />);
    expect(proposals.textContent).toContain("Could not load the proposals");
    expect(proposals.textContent).not.toContain("No proposals yet");
    act(() => root!.unmount());
    host!.remove();
    const settings = await mount(<Settings />);
    expect(settings.textContent).toContain("Could not load your settings");
  });
});
