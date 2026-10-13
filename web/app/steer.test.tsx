/**
 * HOW-47 — the composer's explicit Ask/Steer switch, and a steer drawn where it landed.
 *
 * HOW-27's rule stands: a box never silently changes target. So Steer is a mode the operator
 * PICKS, it exists only while a turn is live on a harness that can be steered, and it changes
 * the placeholder, the send control and the footnote, so which target the box has is visible
 * before Enter is pressed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deriveDetail } from "../derive";
import { FakeLog } from "../slice.fixtures";
import { RunChat, conversation } from "./run/chat";

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
  globalThis.fetch = realFetch;
});

/** `build@1` is a live claude turn that has called one tool */
function live(harness: "claude" | "codex" = "claude"): FakeLog {
  const log = new FakeLog();
  log.add({ type: "run-started", graph: "g", inputs: { goal: "g" }, pinned_prompts: {} });
  log.add({ type: "node-started", node: "build", visit: 1, attempt_id: "build#1" });
  log.add({ type: "prompt-rendered", node: "build", visit: 1, prompt: "doc.draft", prompt_version: 1, rendered_hash: "h", context_read: {}, harness });
  log.add({ type: "chunk", node: "build", visit: 1, turn: 1, index: 0, kind: "text", content: "Building." });
  log.add({ type: "chunk", node: "build", visit: 1, turn: 1, index: 1, kind: "tool_call", content: '{"command":"bun test"}', tool_id: "t1", tool_name: "Bash" });
  log.add({ type: "chunk", node: "build", visit: 1, turn: 1, index: 2, kind: "tool_result", content: "ok", tool_id: "t1" });
  log.add({ type: "chunk", node: "build", visit: 1, turn: 1, index: 3, kind: "text", content: "Now the panel." });
  return log;
}

function render(log: FakeLog, runnerAlive = true): HTMLElement {
  const detail = deriveDetail("r1", log.events, {}, { runnerAlive });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<RunChat runId="r1" detail={detail} ask={detail.ask} onPickStep={() => {}} onResolved={() => {}} />));
  return host;
}

const modeButtons = (el: HTMLElement) => [...el.querySelectorAll(".chat-mode-option")] as HTMLButtonElement[];
const field = (el: HTMLElement) => el.querySelector(".chat-input-field") as HTMLTextAreaElement;
function type(el: HTMLTextAreaElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the composer's mode switch", () => {
  test("appears on a live claude turn; Ask is the default", () => {
    const el = render(live());
    expect(modeButtons(el).map((b) => b.textContent)).toEqual(["Ask (read-only)", "Steer the agent"]);
    expect(modeButtons(el)[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(field(el).placeholder).toBe("Ask about this run…");
    expect(el.querySelector(".chat-hint")!.textContent).toContain("It can't reply to the agent");
  });

  test("Steer changes the placeholder, the send control and the footnote", () => {
    const el = render(live());
    act(() => modeButtons(el)[1]!.click());
    expect(modeButtons(el)[1]!.getAttribute("aria-pressed")).toBe("true");
    expect(field(el).placeholder).toContain("it reads it at its next tool call");
    expect(el.querySelector(".chat-send")!.getAttribute("data-mode")).toBe("steer");
    expect(el.querySelector(".chat-send")!.getAttribute("aria-label")).toBe("Steer");
    expect(el.querySelector(".chat-hint")!.textContent).toContain("Delivered to the agent at its next tool call");
  });

  test.each([
    ["a parked run", (log: FakeLog) => log.add({ type: "attention-raised", node: "build", visit: 1, reason: "which?", ask: { kind: "can_use_tool" } }), true],
    ["a finished run", (log: FakeLog) => { log.add({ type: "node-finished", node: "build", visit: 1, status: "succeeded", writes: {} }); log.add({ type: "run-finished", outcome: "success" }); }, true],
    ["a dead runner", (_log: FakeLog) => {}, false],
  ] as const)("steer mode cannot be reached on %s", (_label, change, alive) => {
    const log = live();
    change(log);
    const el = render(log, alive);
    expect(el.querySelector(".chat-mode")).toBeNull();
    expect(el.querySelector(".chat-send")!.getAttribute("data-mode")).toBe("ask");
    expect(el.textContent).toContain("read-only");
  });

  test("a harness with no steer channel never offers it", () => {
    const el = render(live("codex"));
    expect(el.querySelector(".chat-mode")).toBeNull();
  });

  test("sending in steer mode posts to /steer — never to the ask route — and shows a refusal verbatim", async () => {
    const posted: string[] = [];
    // only WRITES are recorded: another file's RunView poll may still be ticking in this process
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "GET") posted.push(String(input));
      return new Response(JSON.stringify({ error: "the run is waiting on you — answer it with a reply, which reaches the agent directly" }), { status: 409 });
    }) as typeof fetch;
    const el = render(live());
    act(() => modeButtons(el)[1]!.click());
    type(field(el), "use core/");
    act(() => (el.querySelector(".chat-send") as HTMLButtonElement).click());
    // poll rather than sleep a fixed slice: under a loaded full-suite run 10ms was not enough
    for (let i = 0; i < 100 && !el.querySelector(".chat-steer-error"); i++)
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(posted).toEqual(["/api/runs/r1/steer"]);
    expect(el.querySelector(".chat-steer-error")!.textContent).toBe("the run is waiting on you — answer it with a reply, which reaches the agent directly");
    expect(field(el).value).toBe("use core/"); // kept, so it can be sent again
  });
});

describe("a steer in the transcript", () => {
  test("delivered: drawn right after the tool call it rode in on, splitting the step's beats", () => {
    const log = live();
    const s = log.add({ type: "operator-steered", node: "build", visit: 1, text: "use core/", by: "operator" });
    log.add({ type: "steer-delivered", node: "build", visit: 1, steer_seq: s.seq, after_tool_id: "t1" });
    const msgs = conversation(deriveDetail("r1", log.events, {}, { runnerAlive: true }));
    expect(msgs.map((m) => m.kind)).toEqual(["step", "beats", "steer", "beats"]);
    const [before, after] = msgs.filter((m) => m.kind === "beats") as Array<Extract<typeof msgs[number], { kind: "beats" }>>;
    expect(before!.beats.map((b) => b.kind)).toEqual(["text", "tool"]);
    expect(before!.state).toBe("done"); // the live note sits under the LAST words, not mid-way
    expect(after!.state).toBe("live");
    const el = render(log);
    expect(el.querySelector('.cv-steer[data-state="delivered"]')!.textContent).toContain("use core/");
  });

  test("pending: after the agent's latest words, saying it waits for the next tool call", () => {
    const log = live();
    log.add({ type: "operator-steered", node: "build", visit: 1, text: "also the docs", by: "operator" });
    expect(conversation(deriveDetail("r1", log.events, {}, { runnerAlive: true })).map((m) => m.kind)).toEqual(["step", "beats", "steer"]);
    const el = render(log);
    expect(el.querySelector('.cv-steer[data-state="pending"] .cv-steer-state')!.textContent).toBe("sent — it reaches the agent at its next tool call");
  });

  test("carried: says which step's prompt it was carried into", () => {
    const log = live();
    const s = log.add({ type: "operator-steered", node: "build", visit: 1, text: "also the docs", by: "operator" });
    log.add({ type: "turn-finalized", node: "build", visit: 1, turn: 1 });
    log.add({ type: "node-finished", node: "build", visit: 1, status: "succeeded", writes: {} });
    log.add({ type: "node-started", node: "review", visit: 1, attempt_id: "review#1" });
    log.add({ type: "prompt-rendered", node: "review", visit: 1, prompt: "doc.review", prompt_version: 1, rendered_hash: "h2", context_read: {}, steers_carried: [s.seq] });
    const el = render(log);
    expect(el.querySelector('.cv-steer[data-state="carried"]')!.textContent).toContain("carried into review@1's prompt");
  });
});
