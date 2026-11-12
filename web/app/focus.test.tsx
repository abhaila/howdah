/**
 * HOW-68 fix pass — where focus is, what the tab is called, and the viewer's presence beat.
 *
 * D20: a client-side router gives none of the page-load behaviour a browser gives a real
 * navigation, so each piece is pinned here: the title per screen, focus on the new screen's
 * heading (and NOT on a selection inside the same screen), and the skip link still working.
 * D3 / D4 / D5: three keyboard fixes from the sign-off pass that shipped without a test.
 * D18: the presence beat says `notify` exactly when the browser permission is granted, and the
 * shell announces asks from every screen.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./main";
import { deriveDetail } from "../derive";
import { FakeLog } from "../slice.fixtures";
import { AcceptanceCard } from "./run/acceptance";
import { RunLogs } from "./run/logs";
import { AlertDialog, Dialog } from "./components/ui/dialog";
import { ShortcutSheet } from "./components/ui/shortcut-sheet";
import { ToastProvider } from "./components/ui/toast";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { installShortcuts, resetShortcutsForTest } from "./lib/shortcuts";
import { focusRunStatus, focusScreenHeading, pageTitle, screenKey } from "./lib/page";
import { beatPresence } from "./lib/presence";
import { navigate } from "./lib/nav";

let root: Root | null = null;
let host: HTMLElement | null = null;
let uninstall: () => void = () => {};
const realFetch = globalThis.fetch;
const realNotification = (globalThis as { Notification?: unknown }).Notification;

class StubEventSource { onmessage = null; constructor(readonly url: string) {} addEventListener() {} close() {} }

beforeEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = StubEventSource;
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* not every environment has one */ }
  resetShortcutsForTest();
  globalThis.fetch = shaped();
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
  uninstall();
  uninstall = () => {};
  globalThis.fetch = realFetch;
  (globalThis as { Notification?: unknown }).Notification = realNotification;
  history.pushState(null, "", "/");
  document.title = "";
});

/** every read the shell and its screens make, in the shape each expects; `over` answers first */
function shaped(over: (url: string, init?: RequestInit) => unknown = () => undefined): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).replace(/^https?:\/\/[^/]+/, "");
    const mine = over(url, init);
    const body = mine !== undefined ? mine
      : url.startsWith("/api/workspaces") ? { repos: [], folders: [] }
      : url.startsWith("/api/settings") ? { chime: false }
      : url.startsWith("/api/graphs") ? { graphs: [], problems: [] }
      : [];
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}
const settle = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
function press(key: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) {
  act(() => { target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });
}
function type(el: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("D20: the pure rules", () => {
  test("pageTitle", () => {
    expect(pageTitle("Runs")).toBe("Runs · Howdah");
    expect(pageTitle("  HOW-431 Rate-limit headers ")).toBe("HOW-431 Rate-limit headers · Howdah");
    expect(pageTitle(null)).toBe("Howdah");
    expect(pageTitle("")).toBe("Howdah");
  });

  test("screenKey: a selection inside a screen is the same screen; a different run is not", () => {
    expect(screenKey("/")).toBe("runs");
    expect(screenKey("/prompts")).toBe(screenKey("/prompts/implementation.plan"));
    expect(screenKey("/proposals/a.md")).toBe(screenKey("/proposals/b.md"));
    expect(screenKey("/run/a")).not.toBe(screenKey("/run/b"));
    expect(screenKey("/run/a/")).toBe(screenKey("/run/a"));
    expect(screenKey("/graphs")).not.toBe(screenKey("/graphs/new"));
    expect(screenKey("/graphs/x/build")).not.toBe(screenKey("/graphs/y/build"));
    expect(screenKey("/runs/r1/draft")).toBe("draft:r1");
    expect(screenKey("/nowhere")).not.toBe(screenKey("/"));
  });

  test("focusScreenHeading: the heading when there is one; #main until it arrives, unless the operator moved", async () => {
    const main = document.createElement("main");
    main.innerHTML = "<h1>Runs</h1>";
    document.body.appendChild(main);
    focusScreenHeading(main);
    const h1 = main.querySelector("h1")!;
    expect(document.activeElement).toBe(h1);
    expect(h1.getAttribute("tabindex")).toBe("-1"); // focusable from script, never a Tab stop

    // a screen still loading: main takes focus, then hands it to the heading when it renders
    main.innerHTML = "<p>Loading…</p>";
    const stop = focusScreenHeading(main);
    expect(document.activeElement).toBe(main);
    main.innerHTML = "<h1>Prompts</h1>";
    await new Promise((r) => setTimeout(r, 10));
    expect(document.activeElement).toBe(main.querySelector("h1"));
    stop();

    // ...but not if the operator has put focus somewhere real in the meantime
    main.innerHTML = '<input aria-label="x" />';
    const stop2 = focusScreenHeading(main);
    (main.querySelector("input") as HTMLInputElement).focus();
    main.insertAdjacentHTML("beforeend", "<h1>Late</h1>");
    await new Promise((r) => setTimeout(r, 10));
    expect(document.activeElement).toBe(main.querySelector("input"));
    stop2();
    main.remove();
  });

  test("focusRunStatus: only when focus is lost, and only onto the status line", () => {
    const status = document.createElement("span");
    status.id = "run-status";
    const other = document.createElement("button");
    document.body.append(status, other);
    other.focus();
    expect(focusRunStatus()).toBe(false); // the operator is somewhere real: leave them there
    expect(document.activeElement).toBe(other);
    other.blur();
    expect(focusRunStatus()).toBe(true);
    expect(document.activeElement).toBe(status);
    status.remove();
    other.remove();
    expect(focusRunStatus()).toBe(false); // no run on this page: nothing to focus
  });
});

describe("D20: the shell — a change of screen moves focus to its heading and names the tab", () => {
  async function at(path: string): Promise<HTMLElement> {
    history.pushState(null, "", path);
    const el = mount(<App />);
    await settle();
    return el;
  }
  const go = async (path: string) => { act(() => navigate(path)); await settle(); };

  test("first paint leaves focus alone; each screen then titles the tab and takes focus on its h1", async () => {
    const el = await at("/");
    expect(document.title).toBe("Runs · Howdah");
    expect(document.activeElement).toBe(document.body); // a page load is the browser's to focus

    await go("/attention");
    expect(document.title).toBe("Needs you · Howdah");
    const h1 = el.querySelector("#main h1") as HTMLElement;
    expect(h1.textContent).toBe("Needs you");
    expect(document.activeElement).toBe(h1);
    expect(h1.getAttribute("tabindex")).toBe("-1");

    await go("/settings");
    expect(document.title).toBe("Settings · Howdah");
    expect(document.activeElement).toBe(el.querySelector("#main h1"));

    await go("/graphs/new");
    expect(document.title).toBe("Build a graph · Howdah");
    expect(document.activeElement).toBe(el.querySelector("#main h1"));

    await go("/no/such/place");
    expect(document.title).toBe("Not found · Howdah");
    expect((document.activeElement as HTMLElement).tagName).toBe("H1");
  });

  test("a link in the rail does the same (the click the router intercepts)", async () => {
    const el = await at("/");
    const link = el.querySelector('nav a[href="/prompts"]') as HTMLAnchorElement;
    act(() => link.focus());
    await act(async () => { link.click(); await new Promise((r) => setTimeout(r, 30)); });
    expect(location.pathname).toBe("/prompts");
    expect(document.title).toBe("Prompts · Howdah");
    expect((document.activeElement as HTMLElement).tagName).toBe("H1");
  });

  test("a deep link with a hash is left to its target, and the skip link still points at #main", async () => {
    const el = await at("/");
    const marker = el.querySelector(".skip-link") as HTMLAnchorElement;
    expect(marker.getAttribute("href")).toBe("#main");
    expect(el.querySelector("main#main")).not.toBeNull();
    act(() => marker.focus());
    act(() => navigate("/attention#needs-input"));
    await settle();
    // the hash's own target takes focus (the ask card does it); the shell did not move it to the h1
    expect((document.activeElement as HTMLElement).tagName).not.toBe("H1");
  });
});

describe("D3: on Logs, / focuses the search; Esc clears what was typed, then lets go", () => {
  test("the whole path", async () => {
    uninstall = installShortcuts();
    globalThis.fetch = (async () => new Response(JSON.stringify({ rows: [], total: 0 }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const el = mount(<ToastProvider><RunLogs runId="r1" /></ToastProvider>);
    await settle();
    const search = el.querySelector('input[aria-label="Search events"]') as HTMLInputElement;
    expect(search).not.toBeNull();
    expect(document.activeElement).not.toBe(search);
    press("/");
    expect(document.activeElement).toBe(search);
    type(search, "node-started");
    expect(search.value).toBe("node-started");
    press("Escape", search);
    expect(search.value).toBe(""); // first Esc: clear
    expect(document.activeElement).toBe(search); // ...and stay, so a new search can be typed
    press("Escape", search);
    expect(document.activeElement).not.toBe(search); // second Esc: let go
  });
});

describe("D4: a dialog opens with focus where it says, not on its first control", () => {
  test("Dialog honours data-autofocus over document order", () => {
    mount(
      <Dialog open onClose={() => {}} title="A dialog">
        <Checkbox label="first in the document" />
        <Button data-autofocus>the one that asked</Button>
      </Dialog>,
    );
    expect((document.activeElement as HTMLElement).textContent).toBe("the one that asked");
  });

  test("the ? sheet does not open with focus on the single-key checkbox", () => {
    const el = mount(<ShortcutSheet open onClose={() => {}} />);
    const box = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box).not.toBeNull();
    expect(document.activeElement).not.toBe(box);
    expect((document.activeElement as HTMLElement).textContent).toBe("Done");
  });

  test("AlertDialog: Cancel holds focus, and a confirmation that destroys nothing is not red (D26)", () => {
    const el = mount(<AlertDialog open onClose={() => {}} onConfirm={() => {}} title="Send feedback?" confirmLabel="Send the feedback" tone="default" />);
    expect((document.activeElement as HTMLElement).textContent).toBe("Cancel");
    const confirm = [...el.querySelectorAll("button")].find((b) => b.textContent === "Send the feedback")!;
    expect(confirm.getAttribute("data-variant") ?? confirm.className).not.toContain("destructive");
    act(() => root!.unmount());
    host!.remove();
    const el2 = mount(<AlertDialog open onClose={() => {}} onConfirm={() => {}} title="Abort?" confirmLabel="Abort the run" />);
    const abort = [...el2.querySelectorAll("button")].find((b) => b.textContent === "Abort the run")!;
    expect(`${abort.getAttribute("data-variant") ?? ""} ${abort.className}`).toContain("destructive"); // the default is still the destructive one
  });
});

describe("D5: the waive reason field — focused on open, Enter submits, Esc cancels and gives focus back", () => {
  function gated() {
    const log = new FakeLog();
    log.add({ type: "run-started", graph: "implement-ticket", inputs: { goal: "g" }, pinned_prompts: {} });
    log.add({ type: "node-started", node: "implementation.local_review", visit: 1, attempt_id: "r#1" });
    log.add({
      type: "node-finished", node: "implementation.local_review", visit: 1, status: "succeeded", writes: {
        acceptance: [
          { id: "ac-1", text: "the copy is approved", source: "ticket", passes: false, evidence: null, check: "human" },
          { id: "ac-2", text: "the metric shows", source: "ticket", passes: false, evidence: null, check: "human" },
        ],
      },
    });
    log.add({ type: "attention-raised", node: "delivery.publish", visit: 1, reason: "2 unmet", code: "acceptance-unmet" });
    return deriveDetail("r1", log.events);
  }

  test("open → focused; Esc → closed, focus back on the control that opened it; Enter → posted", async () => {
    const posted: unknown[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const detail = gated();
    expect(detail.acceptance?.waivable).toBe(true);
    const el = mount(<ToastProvider><AcceptanceCard runId="r1" detail={detail} onChanged={() => {}} /></ToastProvider>);
    const openers = () => [...el.querySelectorAll(".ac-waive-open")] as HTMLButtonElement[];
    act(() => { openers()[0]!.focus(); openers()[0]!.click(); });
    const input = () => el.querySelector(".ac-waive input") as HTMLInputElement | null;
    expect(document.activeElement).toBe(input()); // focused on open: no click needed to type

    press("Escape", input()!);
    expect(input()).toBeNull();
    expect(posted).toEqual([]);
    expect(document.activeElement).toBe(openers()[0]!); // not <body>

    act(() => openers()[0]!.click());
    press("Enter", input()!);
    expect(posted).toEqual([]); // Enter on an empty reason does nothing
    type(input()!, "product signed it off in the ticket");
    press("Enter", input()!);
    await settle();
    expect(posted).toEqual([{ criterion: "ac-1", reason: "product signed it off in the ticket" }]);
    expect(input()).toBeNull();
    // the row's own opener is still there in this test (the read model was not reloaded), so
    // focus is back on it; what matters is that it is on a control of the card, not on <body>
    expect(document.activeElement).not.toBe(document.body);
    expect(el.querySelector("[data-slot='acceptance-card']")!.contains(document.activeElement)).toBe(true);
  });
});

describe("D18: the viewer's presence beat", () => {
  function captureBeats(): Array<{ url: string; body: unknown }> {
    const beats: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = shaped((url, init) => {
      if (init?.method === "POST") beats.push({ url, body: JSON.parse(String(init.body)) });
      return undefined;
    });
    return beats;
  }

  test("notify is true exactly when the browser permission is granted", async () => {
    const beats = captureBeats();
    (globalThis as { Notification?: unknown }).Notification = undefined;
    await beatPresence();
    (globalThis as { Notification?: unknown }).Notification = { permission: "default" };
    await beatPresence();
    (globalThis as { Notification?: unknown }).Notification = { permission: "denied" };
    await beatPresence();
    (globalThis as { Notification?: unknown }).Notification = { permission: "granted" };
    await beatPresence();
    expect(beats).toEqual([
      { url: "/api/viewer/presence", body: { notify: false } },
      { url: "/api/viewer/presence", body: { notify: false } },
      { url: "/api/viewer/presence", body: { notify: false } },
      { url: "/api/viewer/presence", body: { notify: true } },
    ]);
  });

  test("the shell beats on mount and when the tab is shown or hidden — from any screen", async () => {
    const beats = captureBeats();
    history.pushState(null, "", "/settings");
    mount(<App />);
    await settle();
    expect(beats.filter((b) => b.url === "/api/viewer/presence")).toHaveLength(1);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    expect(beats.filter((b) => b.url === "/api/viewer/presence")).toHaveLength(2);
  });

  test("the shell announces a run that newly waits even on a screen that lists no runs", async () => {
    const shown: Array<{ title: string; body?: string; tag?: string }> = [];
    class FakeNotification {
      static permission = "granted";
      onclick: (() => void) | null = null;
      constructor(title: string, opts: { body?: string; tag?: string }) { shown.push({ title, ...opts }); }
      close() {}
    }
    (globalThis as { Notification?: unknown }).Notification = FakeNotification;
    const hasFocus = document.hasFocus;
    document.hasFocus = () => false; // a background tab: the browser's notification is the one that speaks
    let waiting: unknown[] = [];
    globalThis.fetch = shaped((url) => (url.startsWith("/api/attention") ? waiting : undefined));
    try {
      history.pushState(null, "", "/settings");
      mount(<App />);
      await settle(60); // first sight: nothing waiting, and nothing announced
      expect(shown).toEqual([]);
      waiting = [{ id: "r9:plan:1", run: "r9", href: "/run/r9#needs-input", graph: "g", node: "plan", visit: 1, reason: "needs your reply", raised_at: new Date().toISOString(), waited: "just now" }];
      await settle(5200); // the rail's own 5s poll
      expect(shown).toEqual([{ title: "r9", body: "needs your reply", tag: "r9" }]);
      await settle(5200); // still waiting: not news a second time
      expect(shown).toHaveLength(1);
    } finally {
      document.hasFocus = hasFocus;
    }
  }, 20_000);
});
