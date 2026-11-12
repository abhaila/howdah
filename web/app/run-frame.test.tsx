/**
 * HOW-68 — the run view's frame and its Build pane, as DESIGN.md describes them:
 *
 *   the alarm is said ONCE (no banner repeating the card, no transcript row repeating it);
 *   a park's card is written for a person, with the engine's message verbatim one click away;
 *   an approval is decided from the conversation;
 *   Details is a drawer that ⌘I toggles and Esc closes;
 *   every action has a key, and the keys are rows in the one registry.
 *
 * The older suites (runview, chat, no-reply-card, effect-card, steer, soft-stop, progress) pin
 * what each card and control DOES. This file pins the frame those contracts now sit in.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deriveDetail, type RunStatus } from "../derive";
import { FakeLog, ghostsV1, proposeAndPark, started } from "../slice.fixtures";
import { GRAPHS } from "../../graphs/index";
import { RunView, OPEN_GRACE_MS } from "./run/view";
import { RunChat } from "./run/chat";
import { StandingAsk } from "./run/ask";
import { planWindow } from "./run/progress";
import { StatusBadge, StatusGlyph } from "./status";
import { ToastProvider } from "./components/ui/toast";
import { allShortcuts, installShortcuts, isMac, resetShortcutsForTest } from "./lib/shortcuts";

let root: Root | null = null;
let host: HTMLElement | null = null;
let uninstall: () => void = () => {};
const realFetch = globalThis.fetch;

class StubEventSource {
  onmessage: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  addEventListener() {}
  close() {}
}

beforeEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = StubEventSource;
  localStorage.clear();
  resetShortcutsForTest();
  uninstall = installShortcuts();
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
  uninstall();
  globalThis.fetch = realFetch;
});

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ToastProvider>{node}</ToastProvider>));
  return host;
}
const settle = (ms = 50) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
  act(() => { target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });
}
const MOD: KeyboardEventInit = isMac() ? { metaKey: true } : { ctrlKey: true };

const LONG_REASON =
  '"delivery.publish" requires the acceptance criteria to be met: 2 of 5 criteria are not met and have not been waived — ac-4 "the metric shows in production" (after-publish: this run cannot observe production), ac-5 "product confirmed the copy" (human: nobody has said so on the ticket). Publishing is held until every criterion passes or you waive the ones this run cannot prove. Waive them with `howdah waive r1 --unprovable "<reason>"`, or reply here with what the reviewer should accept as evidence and the run will retry the step.';

/** an implement-ticket run parked at the publish step on its acceptance contract */
function acceptancePark(): FakeLog {
  const log = new FakeLog();
  log.add({ type: "run-started", graph: "implement-ticket", inputs: { goal: "ship the headers" }, pinned_prompts: {} });
  log.add({ type: "node-started", node: "implementation.local_review", visit: 1, attempt_id: "r#1" });
  log.add({
    type: "node-finished", node: "implementation.local_review", visit: 1, status: "succeeded", writes: {
      acceptance: [
        { id: "ac-1", text: "tests cover the parser", source: "ticket", passes: true, evidence: { kind: "verify.result", note: "parser.test.ts" } },
        { id: "ac-4", text: "the metric shows in production", source: "ticket", passes: false, evidence: null, check: "after-publish" },
        { id: "ac-5", text: "product confirmed the copy", source: "ticket", passes: false, evidence: null, check: "human" },
      ],
    },
  });
  log.add({ type: "node-started", node: "delivery.publish", visit: 1, attempt_id: "delivery.publish#1" });
  log.add({ type: "node-finished", node: "delivery.publish", visit: 1, status: "failed", writes: {} });
  log.add({ type: "attention-raised", node: "delivery.publish", visit: 1, reason: LONG_REASON, code: "acceptance-unmet" });
  return log;
}

function serve(body: unknown) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0] ?? url;
    if ((init?.method ?? "GET") !== "GET") return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    if (!/\/api\/runs\/[^/]+(?:\/shell)?$/.test(path)) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(body), { status: body === null ? 404 : 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const tabs = (el: HTMLElement) => [...el.querySelectorAll('.run-tabs [role="tab"]')] as HTMLElement[];
const selectedTab = (el: HTMLElement) => tabs(el).find((t) => t.getAttribute("aria-selected") === "true")?.textContent;
const drawer = (el: HTMLElement) => el.querySelector('[data-slot="drawer"]');

describe("status is a shape before it is a colour", () => {
  const shapeOf = (status: RunStatus) => mount(<StatusGlyph status={status} />).querySelector("svg")!.getAttribute("data-shape");

  test("each status has its own glyph, and no two meanings share one", () => {
    const shapes = Object.fromEntries((["needs-input", "running", "waiting", "queued", "failed-recoverable", "failed-terminal", "harness-dead", "done"] as RunStatus[]).map((s) => {
      const shape = shapeOf(s);
      act(() => root!.unmount());
      host!.remove();
      return [s, shape];
    }));
    root = host = null;
    expect(shapes).toEqual({
      "needs-input": "triangle", running: "half", waiting: "ring", queued: "ring",
      "failed-recoverable": "cross", "failed-terminal": "cross", "harness-dead": "cross", done: "check",
    });
  });

  test("the badge says it in the operator's words, at a size that can be seen, and nothing pulses", () => {
    const el = mount(<StatusBadge status="needs-input" />);
    expect(el.textContent?.trim()).toBe("Waiting on you");
    const svg = el.querySelector("svg")!;
    expect(Number(svg.getAttribute("width"))).toBeGreaterThanOrEqual(12);
    expect(svg.getAttribute("aria-hidden")).toBe("true"); // the words beside it are the name
    expect(el.querySelector(".dot")).toBeNull();
  });
});

describe("a park is one card, written for a person", () => {
  const ask = (log: FakeLog) => {
    const detail = deriveDetail("r1", log.events, {}, { graphs: GRAPHS });
    return mount(<StandingAsk runId="r1" detail={detail} ask={detail.ask!} onResolved={() => {}} />);
  };

  test("the heading is the park's one-sentence summary, not the engine's paragraph", () => {
    const el = ask(acceptancePark());
    const card = el.querySelector("#needs-input")!;
    expect(card.querySelector("h3")!.textContent).toBe("Some acceptance criteria are not proven.");
    expect(card.getAttribute("aria-labelledby")).toBe(card.querySelector("h3")!.id);
    expect(card.querySelector(".ask-where")!.textContent).toContain("delivery.publish@1");
  });

  test("the items in question are listed from the read model: each unproven criterion and why", () => {
    const el = ask(acceptancePark());
    const items = [...el.querySelectorAll(".ask-item")].map((li) => [li.querySelector(".ask-item-id")!.textContent, li.querySelector(".ask-item-body")!.firstElementChild!.textContent]);
    expect(items).toEqual([["ac-4", "the metric shows in production"], ["ac-5", "product confirmed the copy"]]);
    // the criterion that passed is not something the operator is being asked about
    expect(el.querySelector(".ask-items")!.textContent).not.toContain("tests cover the parser");
  });

  test("the engine's message is one click away, VERBATIM, and a long one starts closed", () => {
    const el = ask(acceptancePark());
    const full = el.querySelector("details.ask-full") as HTMLDetailsElement;
    expect(full.querySelector("summary")!.textContent).toBe("Full message");
    expect(full.open).toBe(false);
    expect(full.querySelector(".ask-message")!.textContent).toBe(LONG_REASON);
  });

  test("a short message starts open: one sentence behind a disclosure would be chrome", () => {
    const log = new FakeLog();
    log.add({ type: "run-started", graph: "implement-ticket", inputs: { goal: "g" }, pinned_prompts: {} });
    log.add({ type: "node-started", node: "implementation.implement", visit: 1, attempt_id: "i#1" });
    log.add({ type: "attention-raised", node: "implementation.implement", visit: 2, reason: "maxVisits exceeded (2 > 1)", code: "max-visits" });
    const el = ask(log);
    expect(el.querySelector("h3")!.textContent).toBe("implementation.implement reached its visit limit.");
    expect((el.querySelector("details.ask-full") as HTMLDetailsElement).open).toBe(true);
  });

  test("a park this viewer has no words for still names the step, and the message carries the meaning", () => {
    const log = new FakeLog();
    log.add({ type: "run-started", graph: "write-doc", inputs: { goal: "g" }, pinned_prompts: {} });
    log.add({ type: "node-started", node: "doc.review", visit: 1, attempt_id: "d#1" });
    log.add({ type: "attention-raised", node: "doc.review", visit: 1, reason: "needs your reply" });
    const el = ask(log);
    expect(el.querySelector("h3")!.textContent).toBe("doc.review is waiting on you.");
    expect(el.querySelector(".ask-message")!.textContent).toBe("needs your reply");
    expect(el.querySelector('textarea[aria-label="your reply"]')).not.toBeNull();
  });

  test("the entrance is played for an ask that ARRIVES, once — never for one that was already standing", () => {
    // FakeLog stamps its events in the past: this is the park you navigate to hours later
    const standing = ask(acceptancePark());
    expect(standing.querySelector("#needs-input")!.hasAttribute("data-arriving")).toBe(false);
    act(() => root!.unmount());
    host!.remove();

    const fresh = () => {
      const detail = deriveDetail("r-fresh", acceptancePark().events, {}, { graphs: GRAPHS });
      const now = { ...detail.ask!, ts: new Date().toISOString() };
      return mount(<StandingAsk runId="r-fresh" detail={{ ...detail, ask: now }} ask={now} onResolved={() => {}} />);
    };
    const first = fresh();
    expect(first.querySelector("#needs-input")!.getAttribute("data-arriving")).toBe("true");
    act(() => root!.unmount());
    host!.remove();
    // the same ask drawn again — a tab switch back to Build, a re-render — is simply there
    expect(fresh().querySelector("#needs-input")!.hasAttribute("data-arriving")).toBe(false);
  });

  test("an approval park is decided from the card itself: Approve and Send feedback are in the ask", () => {
    const log = new FakeLog();
    started(log);
    proposeAndPark(log, ghostsV1());
    const el = ask(log);
    expect(el.querySelector(".ask-approval .approval-card.needs-you")).not.toBeNull();
    const labels = [...el.querySelectorAll(".ask-approval button")].map((b) => b.textContent?.trim());
    expect(labels).toContain("Approve");
    expect(labels).toContain("Send feedback");
    // one deep-link target, not two: the approval card carries the id while it awaits a decision
    expect(el.querySelectorAll('[id="needs-input"]')).toHaveLength(1);
    // ...and it can TAKE the focus the deep link and the `A` key give it
    const target = el.querySelector("#needs-input") as HTMLElement;
    target.focus();
    expect(document.activeElement).toBe(target);
    expect(el.textContent).not.toContain("A reply can't move this run");
    expect(el.querySelector("details.ask-full .ask-message")!.textContent).toBe(deriveDetail("r1", log.events).ask!.reason);
  });
});

describe("the Build pane says the ask once and keeps its chrome to a line", () => {
  const chat = (log: FakeLog) => {
    const detail = deriveDetail("r1", log.events, {}, { graphs: GRAPHS });
    return mount(<RunChat runId="r1" detail={detail} ask={detail.ask} onPickStep={() => {}} onResolved={() => {}} />);
  };

  test("the standing park's reason is in its card and nowhere else in the transcript", () => {
    const el = chat(acceptancePark());
    expect(el.querySelector(".cv-asked")).toBeNull();
    expect(el.querySelector(".chat-log")!.textContent!.split(LONG_REASON)).toHaveLength(2); // exactly once
  });

  test("the starting questions are chips inside the composer, and the field is one line", () => {
    const el = chat(acceptancePark());
    const composer = el.querySelector(".chat-input")!;
    expect(composer.querySelectorAll(".chat-suggestion").length).toBeGreaterThan(0);
    expect(composer.querySelector("textarea")!.getAttribute("rows")).toBe("1");
  });

  test("E expands and collapses every tool call, and is listed under 'A run'", () => {
    const log = new FakeLog();
    log.add({ type: "run-started", graph: "quick-task", inputs: { goal: "g" }, pinned_prompts: {} });
    log.add({ type: "node-started", node: "do", visit: 1, attempt_id: "do#1" });
    log.add({ type: "chunk", node: "do", visit: 1, turn: 1, index: 0, kind: "tool_call", tool_id: "t1", tool_name: "Bash", content: '{"command":"ls web"}' });
    log.add({ type: "chunk", node: "do", visit: 1, turn: 1, index: 1, kind: "tool_result", tool_id: "t1", content: "app" });
    const el = chat(log);
    expect(el.querySelectorAll(".act-tool-body")).toHaveLength(0);
    press("e");
    expect(el.querySelectorAll(".act-tool-body")).toHaveLength(1);
    press("e");
    expect(el.querySelectorAll(".act-tool-body")).toHaveLength(0);
    const row = allShortcuts().find((s) => s.id === "run.expand-tools")!;
    expect(row.scope).toBe("A run");
    expect(row.keys).toBe("e");
  });

  test("/ puts the caret in the composer; typing there is never a shortcut", () => {
    const el = chat(acceptancePark());
    const field = el.querySelector(".chat-input-field") as HTMLTextAreaElement;
    press("/");
    expect(document.activeElement).toBe(field);
    press("e", {}, field); // a letter typed into the field must not toggle the transcript
    expect(el.querySelector('button[aria-pressed="true"].chat-disclosure')).toBeNull();
  });

  test("the pinned plan is a window around the item in progress, never a second scroller", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ status: i < 11 ? "completed" : i === 11 ? "in_progress" : "pending", n: i }));
    const { from, shown } = planWindow(items);
    expect(shown).toHaveLength(6);
    expect(shown.map((i) => i.n)).toContain(11);
    expect(from).toBe(10); // one finished item of context above the one in progress
    expect(planWindow(items.slice(0, 5)).shown).toHaveLength(5); // a short plan is shown whole
    expect(planWindow(items.slice(15)).from).toBe(0);
  });
});

describe("the run's frame: one header row, one tab strip, Details in a drawer", () => {
  const open = async (log: FakeLog) => {
    serve(deriveDetail("r1", log.events, {}, { graphs: GRAPHS }));
    const el = mount(<RunView id="r1" graceMs={OPEN_GRACE_MS} />);
    await settle();
    return el;
  };

  test("no banner repeats the ask: the header carries one line of status, and it is a way to the card", async () => {
    const el = await open(acceptancePark());
    expect(el.querySelector(".banner")).toBeNull();
    const head = el.querySelector(".run-head")!;
    expect(head.textContent).not.toContain("requires the acceptance criteria");
    const status = head.querySelector(".run-status-line") as HTMLButtonElement;
    expect(status.textContent).toContain("Waiting on you");
    expect(status.getAttribute("aria-label")).toContain("go to what the run is asking");
    // from another tab it brings you back to Build, where the card is
    act(() => tabs(el).find((t) => t.textContent!.startsWith("Logs"))!.click());
    expect(selectedTab(el)).toContain("Logs");
    await act(async () => { status.click(); await new Promise((r) => setTimeout(r, 10)); });
    expect(selectedTab(el)).toContain("Build");
    expect(document.activeElement).toBe(el.querySelector("#needs-input"));
  });

  test("the seven tabs print their number keys, and 1–7 switch between them", async () => {
    const el = await open(acceptancePark());
    expect(tabs(el).map((t) => t.textContent)).toEqual(["Plan1", "Build2", "Report3", "Steps4", "Context5", "Logs6", "Graph7"]);
    expect(selectedTab(el)).toBe("Build2");
    press("4");
    expect(selectedTab(el)).toBe("Steps4");
    press("2");
    expect(selectedTab(el)).toBe("Build2");
  });

  test("Details is closed at this width, ⌘I opens it, and Esc closes it again", async () => {
    const el = await open(acceptancePark());
    expect(drawer(el)).toBeNull(); // happy-dom's window is 1024px wide: below the 1280px default
    const toggle = [...el.querySelectorAll(".run-head button")].find((b) => b.textContent!.startsWith("Details")) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    press("i", MOD);
    expect(drawer(el)).not.toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(drawer(el)!.getAttribute("aria-label")).toBe("Run details");
    // ids are whole and copyable, and no value is cut
    const run = [...drawer(el)!.querySelectorAll("dt")].find((dt) => dt.textContent === "Run")!;
    expect(run.nextElementSibling!.textContent).toBe("r1");
    expect(run.nextElementSibling!.querySelector('button[aria-label="Copy run"]')).not.toBeNull();
    // the timeline names every step in full
    expect(drawer(el)!.textContent).toContain("implementation.local_review@1");
    press("Escape");
    expect(drawer(el)).toBeNull();
    // and the choice is remembered
    expect(localStorage.getItem("howdah.run.details.open")).toBe("0");
  });

  test("the run's shortcuts are rows in the one registry, so the ? sheet lists every one", async () => {
    await open(acceptancePark());
    const mine = allShortcuts().filter((s) => s.scope === "A run");
    const byKeys = Object.fromEntries(mine.filter((s) => s.keys !== undefined).map((s) => [String(s.keys), s.label]));
    expect(byKeys["1"]).toBe("Show Plan");
    expect(byKeys["7"]).toBe("Show Graph");
    expect(byKeys["mod+i"]).toBe("Show details");
    expect(byKeys["r"]).toBe("Reply to the run");
    expect(byKeys["a"]).toBe("Go to what the run is asking");
    expect(byKeys["o"]).toBe("Open in IDE");
    expect(byKeys["e"]).toBeDefined();
    expect(byKeys["/"]).toBe("Ask about this run");
    // gone with the screen: a shortcut cannot outlive what it acts on
    act(() => root!.unmount());
    root = null;
    expect(allShortcuts().filter((s) => s.scope === "A run")).toHaveLength(0);
  });

  test("secondary actions are behind ONE More menu, with the key that does the same", async () => {
    const el = await open(acceptancePark());
    const triggers = el.querySelectorAll('.run-head button[aria-haspopup="menu"]');
    expect(triggers).toHaveLength(1);
    await act(async () => (triggers[0] as HTMLButtonElement).click());
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((i) => i.firstElementChild?.nextElementSibling?.textContent ?? i.textContent);
    expect(items).toContain("Open run folder");
    expect(items).toContain("Abort the run…");
  });

  test("a run that has not appeared yet says what the page is doing, in words", async () => {
    serve(null);
    const el = mount(<RunView id="nope" graceMs={OPEN_GRACE_MS} />);
    await settle();
    expect(el.textContent).toContain("Looking for this run…");
    expect(el.querySelector('[data-screen="run-loading"]')).not.toBeNull();
  });
});

describe("a step the timeline lists twice is one step in the conversation", () => {
  test("an approval that parked and was then decided on the same visit is drawn once, as it ended", () => {
    const log = new FakeLog();
    started(log);
    proposeAndPark(log, ghostsV1());
    const detail = deriveDetail("r1", log.events, {}, { graphs: GRAPHS });
    const row = detail.timeline.at(-1)!;
    // the shape the read model produces for an approval visit: the same node@visit, twice
    const twice = { ...detail, timeline: [...detail.timeline.slice(0, -1), { ...row, status: "failed" as const }, { ...row, status: "succeeded" as const }] };
    const el = mount(<RunChat runId="r1" detail={twice} ask={null} onPickStep={() => {}} onResolved={() => {}} />);
    const ids = [...el.querySelectorAll('[data-slot="message-scroller-item"]')].map((r) => r.getAttribute("data-message-id"));
    expect(new Set(ids).size).toBe(ids.length); // no duplicate keys
    const steps = [...el.querySelectorAll(`.cv-step`)].filter((s) => s.querySelector(".cv-step-key")!.textContent === row.node);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.getAttribute("data-status")).toBe("succeeded");
  });
});

describe("D20: an answered ask hands focus to the run's status line, and the tab is named", () => {
  /** a plain agent step that failed and parked: the prose reply card */
  function prosePark(): FakeLog {
    const log = new FakeLog();
    log.add({ type: "run-started", graph: "implement-ticket", inputs: { goal: "ship the headers" }, pinned_prompts: {} });
    log.add({ type: "node-started", node: "implementation.plan", visit: 1, attempt_id: "implementation.plan#1" });
    log.add({ type: "node-finished", node: "implementation.plan", visit: 1, status: "failed", writes: {} });
    log.add({ type: "attention-raised", node: "implementation.plan", visit: 1, reason: "attempt failed", code: "attempt-failed" });
    return log;
  }

  test("reply → the card goes, focus lands on #run-status (not <body>), and a polite toast says what happened", async () => {
    const log = prosePark();
    let body: unknown = deriveDetail("r1", log.events, {}, { graphs: GRAPHS });
    const posted: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0] ?? url;
      if ((init?.method ?? "GET") !== "GET") {
        posted.push(path);
        // the reply is in the log now: the park is resolved and the step runs again
        log.add({ type: "attention-resolved", node: "implementation.plan", visit: 1, reply: "carry on" });
        log.add({ type: "node-started", node: "implementation.plan", visit: 2, attempt_id: "implementation.plan#2" });
        body = deriveDetail("r1", log.events, {}, { graphs: GRAPHS });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (!/\/api\/runs\/[^/]+(?:\/shell)?$/.test(path)) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const el = mount(<RunView id="r1" graceMs={OPEN_GRACE_MS} />);
    await settle();
    expect(document.title).toBe("ship the headers · Howdah");
    const status = el.querySelector("#run-status") as HTMLElement;
    expect(status.getAttribute("tabindex")).toBe("-1"); // a focus TARGET, not a Tab stop
    expect(status.textContent).toContain("Waiting on you");

    const box = el.querySelector("#needs-input textarea") as HTMLTextAreaElement;
    act(() => box.focus());
    expect(document.activeElement).toBe(box);
    const reply = [...el.querySelectorAll("#needs-input button")].find((b) => b.textContent === "Reply") as HTMLButtonElement;
    await act(async () => { reply.click(); await new Promise((r) => setTimeout(r, 20)); });
    expect(posted).toEqual(["/api/runs/r1/reply"]);
    // sending → delivered: the toast region is aria-live="polite", so this is the announcement
    const live = document.querySelector('[role="status"][aria-live="polite"]')!;
    expect(live.textContent).toContain("Reply sent. The run is resuming.");

    // the collapse plays (420ms), then the reload takes the card away — waited for, not slept past
    for (let i = 0; i < 60 && el.querySelector("#needs-input") !== null; i++) await settle(50);
    await settle(50);
    expect(el.querySelector("#needs-input")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLElement).id).toBe("run-status");
    expect(document.activeElement!.textContent).toContain("Running"); // where the run now says what it is doing
  });

  test("a notification's deep link (#needs-input) lands ON the control, and a stale one is dropped only after the run loads", async () => {
    const parked = deriveDetail("r1", prosePark().events, {}, { graphs: GRAPHS });
    history.pushState(null, "", "/run/r1#needs-input");
    try {
      serve(parked);
      const el = mount(<RunView id="r1" graceMs={OPEN_GRACE_MS} />);
      await settle();
      // the hash survived the loading render — it used to be stripped before the card existed
      expect(location.hash).toBe("#needs-input");
      expect(document.activeElement).toBe(el.querySelector("#needs-input textarea"));
      act(() => root!.unmount());
      host!.remove();

      // a run that is NOT asking anything: the hash points at nothing, so it goes
      const log = new FakeLog();
      log.add({ type: "run-started", graph: "implement-ticket", inputs: { goal: "g" }, pinned_prompts: {} });
      log.add({ type: "node-started", node: "implementation.plan", visit: 1, attempt_id: "implementation.plan#1" });
      history.replaceState(null, "", "/run/r1#needs-input");
      serve(deriveDetail("r1", log.events, {}, { graphs: GRAPHS }));
      mount(<RunView id="r1" graceMs={OPEN_GRACE_MS} />);
      await settle();
      expect(location.hash).toBe("");
    } finally {
      history.pushState(null, "", "/");
    }
  });

  test("focus is NOT taken from an operator who was never in the card", async () => {
    const log = prosePark();
    let body: unknown = deriveDetail("r1", log.events, {}, { graphs: GRAPHS });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0] ?? url;
      if (!/\/api\/runs\/[^/]+(?:\/shell)?$/.test(path)) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const el = mount(<RunView id="r1" graceMs={OPEN_GRACE_MS} />);
    await settle();
    const elsewhere = tabs(el).find((t) => t.getAttribute("aria-selected") === "true")!;
    act(() => elsewhere.focus());
    // the ask is answered from the CLI while the operator's focus is on the tab strip
    log.add({ type: "attention-resolved", node: "implementation.plan", visit: 1, reply: "carry on" });
    log.add({ type: "node-started", node: "implementation.plan", visit: 2, attempt_id: "implementation.plan#2" });
    body = deriveDetail("r1", log.events, {}, { graphs: GRAPHS });
    // the page's own 5s refresh — waited FOR rather than slept past
    for (let i = 0; i < 90 && el.querySelector("#needs-input") !== null; i++) await settle(100);
    expect(el.querySelector("#needs-input")).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  }, 15_000);
});

describe("D26: a dead run's interrupted step is not drawn running, and it says it died once", () => {
  function deadDetail() {
    const log = new FakeLog();
    log.add({ type: "run-started", graph: "implement-ticket", inputs: { goal: "ship the headers" }, pinned_prompts: {} });
    log.add({ type: "node-started", node: "implementation.plan", visit: 1, attempt_id: "implementation.plan#1" });
    const detail = deriveDetail("r1", log.events, {}, { graphs: GRAPHS });
    // the runner is gone: derive.ts says so from runner.pid, which a FakeLog has none of
    return { ...detail, summary: { ...detail.summary, status: "harness-dead" as RunStatus }, turn_states: { "implementation.plan@1": "died" as const } };
  }

  test("stepInterrupted reads the read model's two facts and nothing else", async () => {
    const { stepInterrupted } = await import("./status");
    const row = { node: "n", visit: 1, status: "running" };
    expect(stepInterrupted({ summary: { status: "harness-dead" }, turn_states: {} }, row)).toBe(true);
    expect(stepInterrupted({ summary: { status: "running" }, turn_states: { "n@1": "died" } }, row)).toBe(true);
    expect(stepInterrupted({ summary: { status: "running" }, turn_states: { "n@1": "live" } }, row)).toBe(false);
    expect(stepInterrupted({ summary: { status: "harness-dead" }, turn_states: {} }, { ...row, status: "succeeded" })).toBe(false);
  });

  // The confirming review: a step parked MID-TURN on a question is still "running" in the
  // timeline (its attempt has not ended), and the drawer drew the running half-disc under a
  // header that said "Waiting on you".
  test("Details timeline: a step parked mid-turn on a question is the triangle and 'waiting on you', not 'running'", async () => {
    const log = new FakeLog();
    log.add({ type: "run-started", graph: "implement-ticket", inputs: { goal: "ship the headers" }, pinned_prompts: {} });
    log.add({ type: "node-started", node: "implementation.plan", visit: 1, attempt_id: "implementation.plan#1" });
    log.add({
      type: "attention-raised", node: "implementation.plan", visit: 1, reason: "Cursor or offset?",
      ask: { kind: "user-question", request_id: "r1", tool_name: "AskUserQuestion", tool_use_id: "t2", questions: [{ question: "Cursor or offset?", header: "Paging", options: [{ label: "Cursor" }, { label: "Offset" }] }] },
    } as never);
    const detail = deriveDetail("r1", log.events, {}, { graphs: GRAPHS });
    expect(detail.timeline[0]!.status).toBe("running"); // the timeline's own word is unchanged
    serve(detail);
    const el = mount(<RunView id="r1" graceMs={OPEN_GRACE_MS} />);
    await settle();
    press("i", MOD); // open Details
    await settle();
    const row = el.querySelector(".run-details-row") as HTMLElement;
    expect(row.getAttribute("data-step-status")).toBe("waiting on you");
    expect(row.getAttribute("aria-label")).toContain("waiting on you");
    expect(row.querySelector("svg")!.getAttribute("data-shape")).toBe("triangle");
  });

  test("Details timeline: the cross and the word 'interrupted'; the page says it died in the header and ONE notice", async () => {
    serve(deadDetail());
    const el = mount(<RunView id="r1" graceMs={OPEN_GRACE_MS} />);
    await settle();
    press("i", MOD); // open Details
    await settle();
    const row = el.querySelector(".run-details-row") as HTMLElement;
    expect(row.getAttribute("data-step-status")).toBe("interrupted");
    expect(row.getAttribute("aria-label")).toContain("interrupted");
    expect(row.querySelector("svg")!.getAttribute("data-shape")).toBe("cross"); // it drew the running half-disc
    // said once in the header's status, once in the notice that names the action — and not a third time
    expect(el.querySelector("#run-status")!.textContent!.trim()).toBe("Runner died");
    const notices = [...el.querySelectorAll(".run-notice")].map((n) => n.textContent);
    expect(notices).toEqual(["The runner stopped before the current step finished. Resume to pick the run back up."]);
    expect(el.textContent).not.toContain("The process died inside this turn");
    // Steps says the same thing the drawer says
    act(() => tabs(el).find((t) => t.textContent!.startsWith("Steps"))!.click());
    await settle();
    expect(el.querySelector(".step-row[data-status='interrupted']")).not.toBeNull();
    expect(el.querySelector(".step-row[data-status='running']")).toBeNull();
  });

  test("between runners is not dead: seconds after the run's last event the frame says Resuming, with no red notice", async () => {
    const d = deadDetail();
    serve({ ...d, summary: { ...d.summary, last_event_at: new Date().toISOString() } });
    const el = mount(<RunView id="r1" graceMs={OPEN_GRACE_MS} />);
    await settle();
    expect(el.querySelector("#run-status")!.textContent!.trim()).toBe("Resuming");
    expect(el.querySelector(".run-notice")).toBeNull();
    // ...and the same run an hour later is what it looks like: dead
    act(() => root!.unmount());
    host!.remove();
    serve({ ...d, summary: { ...d.summary, last_event_at: new Date(Date.now() - 3_600_000).toISOString() } });
    const later = mount(<RunView id="r1" graceMs={OPEN_GRACE_MS} />);
    await settle();
    expect(later.querySelector("#run-status")!.textContent!.trim()).toBe("Runner died");
    expect(later.querySelector(".run-notice")).not.toBeNull();
  });
});
