/**
 * HOW-25 — the central pane and the question card.
 *
 * The ticket's complaint was that a question had nowhere to appear: the run parked, the card
 * drew a bare text box, and the question, its options and their descriptions stayed in the
 * log. So the assertions here are mostly about what is ON SCREEN, and about the exact body
 * the card posts — those two are the whole fix from the operator's side.
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

const QUESTIONS = [
  {
    question: "Which approach should I take?",
    header: "Approach",
    multiSelect: false,
    options: [
      { label: "Approach A", description: "Rewrite the renderer." },
      { label: "Approach B", description: "Patch the caller instead." },
    ],
  },
  {
    question: "Which files may I touch?",
    header: "Scope",
    multiSelect: true,
    options: [{ label: "src", description: "the product code" }, { label: "tests" }],
  },
];

/** a run that ran one step, said something, called a tool, and is now asking a question */
function askingLog(questions: unknown[] = QUESTIONS): FakeLog {
  const log = new FakeLog();
  log.add({ type: "run-started", graph: "quick-task", inputs: { goal: "g" }, pinned_prompts: { "doc.draft": 1 } });
  log.add({ type: "node-started", node: "do", visit: 1, attempt_id: "do#1" });
  log.add({
    type: "prompt-rendered", node: "do", visit: 1, prompt: "doc.draft", prompt_version: 1,
    rendered_hash: "h1", context_read: { goal: "g" }, harness: "claude", skills: [], output_keys: ["result"], suffix_version: 3,
  });
  log.add({ type: "chunk", node: "do", visit: 1, turn: 1, index: 0, kind: "text", content: "Let me check the renderer first." });
  log.add({ type: "chunk", node: "do", visit: 1, turn: 1, index: 1, kind: "tool_call", content: '{"command":"ls web"}', tool_id: "t1", tool_name: "Bash" });
  log.add({ type: "chunk", node: "do", visit: 1, turn: 1, index: 2, kind: "tool_result", content: "app\npublic", tool_id: "t1" });
  log.add({
    type: "attention-raised", node: "do", visit: 1,
    reason: "Which approach should I take? (+1 more)",
    ask: { kind: "user-question", request_id: "r1", tool_name: "AskUserQuestion", tool_use_id: "t2", questions },
  });
  return log;
}

function render(log: FakeLog): HTMLElement {
  const detail = deriveDetail("r1", log.events);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<RunChat runId="r1" detail={detail} ask={detail.ask} onPickStep={() => {}} onResolved={() => {}} />));
  return host;
}

const buttonsNamed = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll("button")].filter((b) => b.textContent?.trim() === text);
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });

describe("the question renders as itself", () => {
  test("every question, header, option and description is on screen", () => {
    const el = render(askingLog());
    const text = el.textContent ?? "";
    expect(text).toContain("Which approach should I take?");
    expect(text).toContain("Approach");
    expect(text).toContain("Approach A");
    expect(text).toContain("Rewrite the renderer.");
    expect(text).toContain("Approach B");
    expect(text).toContain("Patch the caller instead.");
    expect(text).toContain("Which files may I touch?");
    expect(text).toContain("Scope");
    expect(text).toContain("the product code");
  });

  test("single-select draws option buttons; multi-select draws checkboxes", () => {
    const el = render(askingLog());
    expect(buttonsNamed(el, "Approach A")).toHaveLength(1);
    const boxes = [...el.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    // one per option of the multi-select question only
    expect(boxes).toHaveLength(2);
  });

  test("each question carries a free-text box, so \"neither\" is sayable", () => {
    const el = render(askingLog());
    const others = [...el.querySelectorAll("textarea")];
    expect(others).toHaveLength(2);
    expect(others[0]!.getAttribute("aria-label")).toBe("other answer for Approach");
  });

  test("the card is the deep-link target a notification lands on", () => {
    expect(render(askingLog()).querySelector("#needs-input")).not.toBeNull();
  });

  test("nothing is submittable until something is answered", () => {
    const el = render(askingLog());
    const answer = buttonsNamed(el, "Answer")[0] as HTMLButtonElement;
    expect(answer.disabled).toBe(true);
    click(buttonsNamed(el, "Approach A")[0]!);
    expect((buttonsNamed(el, "Answer")[0] as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("answering posts exactly what the park can accept", () => {
  test("a single pick and a multi pick travel as structured answers", async () => {
    const sent: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const el = render(askingLog());
    click(buttonsNamed(el, "Approach B")[0]!);
    const boxes = [...el.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    click(boxes[0]!);
    click(boxes[1]!);
    await act(async () => { buttonsNamed(el, "Answer")[0]!.click(); });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("/api/runs/r1/reply");
    expect(sent[0]!.body).toEqual({
      answers: [{ id: "q0", selected: ["Approach B"] }, { id: "q1", selected: ["src", "tests"] }],
    });
  });

  test("a single-select does not accumulate: picking again replaces", async () => {
    const sent: unknown[] = [];
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const el = render(askingLog());
    click(buttonsNamed(el, "Approach A")[0]!);
    click(buttonsNamed(el, "Approach B")[0]!);
    await act(async () => { buttonsNamed(el, "Answer")[0]!.click(); });
    expect(sent[0]).toEqual({ answers: [{ id: "q0", selected: ["Approach B"] }] });
  });

  test("free text rides along as `other` on the question it was typed under", async () => {
    const sent: unknown[] = [];
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const el = render(askingLog());
    const box = el.querySelectorAll("textarea")[0] as HTMLTextAreaElement;
    // React tracks the value internally; set it the way the DOM would and fire the event
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(box, "neither — read the spec first");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { buttonsNamed(el, "Answer")[0]!.click(); });
    expect(sent[0]).toEqual({ answers: [{ id: "q0", selected: [], other: "neither — read the spec first" }] });
  });

  test("a refusal is shown VERBATIM, never collapsed into \"failed\"", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "answers do not match the questions being asked" }), {
        status: 400, headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const el = render(askingLog());
    click(buttonsNamed(el, "Approach A")[0]!);
    await act(async () => { buttonsNamed(el, "Answer")[0]!.click(); });
    expect(el.textContent).toContain("answers do not match the questions being asked");
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
  });
});

describe("a payload the harness malformed falls back rather than crashing", () => {
  test("an unreadable question set draws the ordinary reply card", () => {
    // no `question` text: core/ask.ts refuses it, so ask_questions is null
    const el = render(askingLog([{ header: "Approach", options: [{ label: "A" }] }]));
    expect(el.querySelector("#needs-input")).not.toBeNull();
    // the free-text reply box is still there, so the run is still answerable
    expect(el.querySelector('textarea[aria-label="your reply"]')).not.toBeNull();
  });
});

describe("the run reads as one conversation", () => {
  test("conversation() yields prompt, prose, tool work and the ask in log order", () => {
    const detail = deriveDetail("r1", askingLog().events);
    const msgs = conversation(detail);
    expect(msgs.map((m) => m.kind)).toEqual(["step", "beats", "asked"]);
    const step = msgs[0] as Extract<typeof msgs[number], { kind: "step" }>;
    expect(step.node).toBe("do");
    expect(step.prompt).toEqual({ id: "doc.draft", version: 1, read: ["goal"] });
    const beats = msgs[1] as Extract<typeof msgs[number], { kind: "beats" }>;
    // the prose, then the tool call paired with its own result — one beat, not two
    expect(beats.beats.map((b) => b.kind)).toEqual(["text", "tool"]);
    expect(beats.beats[1]!.result?.content).toBe("app\npublic");
  });

  test("the operator's own answer becomes its own row in the transcript", () => {
    const log = askingLog();
    log.add({ type: "attention-resolved", node: "do", visit: 1, reply: "Approach: Approach B", source: "operator", answers: [{ id: "q0", selected: ["Approach B"] }] });
    const msgs = conversation(deriveDetail("r1", log.events));
    const answered = msgs.find((m) => m.kind === "answered");
    expect(answered).toBeDefined();
    expect((answered as { text: string }).text).toContain("Approach B");
  });

  test("what a step published closes it", () => {
    const log = askingLog();
    log.add({ type: "attention-resolved", node: "do", visit: 1, reply: "Approach B", source: "operator" });
    log.add({ type: "node-finished", node: "do", visit: 1, status: "succeeded", writes: { result: "done" } });
    const msgs = conversation(deriveDetail("r1", log.events));
    const wrote = msgs.find((m) => m.kind === "wrote");
    expect((wrote as { keys: string[] }).keys).toEqual(["result"]);
  });

  test("the prose and the tool work are on screen, and the standing ask sits at the foot", () => {
    const el = render(askingLog());
    expect(el.textContent).toContain("Let me check the renderer first.");
    expect(el.textContent).toContain("ls web"); // the tool's one-line summary
    const log = el.querySelector(".chat-log")!;
    const standing = log.querySelector(".cv-standing")!;
    expect(standing).not.toBeNull();
    // it is the LAST thing in the conversation, which is what "at the foot" means
    expect(log.lastElementChild).toBe(standing);
  });

  test("a run with nothing in it says so rather than drawing an empty frame", () => {
    const log = new FakeLog();
    log.add({ type: "run-started", graph: "quick-task", inputs: { goal: "g" }, pinned_prompts: {} });
    expect(render(log).textContent).toContain("nothing has happened in this run yet");
  });
});

describe("model output stays untrusted input", () => {
  test("a citation-shaped string in an answer is rendered as TEXT, not markup", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ answer: 'see do@1 and <img src=x onerror="alert(1)">' }), {
        status: 200, headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const el = render(askingLog());
    click([...el.querySelectorAll('[role="tab"]')].find((t) => t.textContent === "Ask")!);
    const input = el.querySelector('input[aria-label="ask about this run"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "what happened?");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror="alert(1)">');
    // a real step key becomes a chip the operator can click through to
    expect([...el.querySelectorAll(".chat-cite")].map((c) => c.textContent)).toContain("do@1");
  });
});
