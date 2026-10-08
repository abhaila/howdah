/**
 * HOW-25 — the central pane and the question card. HOW-27 — the same two things after the
 * rebuild onto `message-scroller` and `questionnaire`.
 *
 * HOW-25's complaint was that a question had nowhere to appear: the run parked, the card drew a
 * bare text box, and the question, its options and their descriptions stayed in the log. So the
 * assertions here are mostly about what is ON SCREEN, and about the exact body the card posts —
 * those two are the whole fix from the operator's side, and neither changed in HOW-27.
 *
 * What DID change is the shape of the asking, so the assertions follow it: one question at a
 * time rather than all of them at once, `1`…`9` on the options, Back/Next to move, Answer only
 * on the last question. The navigation helpers below exist because a wizard's assertions have to
 * say which question they are on — and `hidden` is how the primitive says it, which Tailwind's
 * preflight backs with `display: none !important`, so an inactive question is genuinely not on
 * screen even though its text is still in `textContent`. Assertions that care use `activeItem()`
 * or `shown()` rather than reading the whole subtree.
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

/** the same ask with a single question, so Answer is the control on screen from the start */
const ONE_QUESTION = [QUESTIONS[0]];

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

const click = (el: Element) => act(() => { (el as HTMLElement).click(); });

/** an element the operator can actually see: no `hidden` on it or on any ancestor */
const shown = (el: Element) => !el.closest("[hidden]");
const buttonsNamed = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll("button")].filter((b) => b.textContent?.trim() === text && shown(b));
/** the question currently on screen — the primitive marks it `data-active` and hides the rest */
const activeItem = (el: HTMLElement) => el.querySelector("fieldset[data-active]") as HTMLElement;
const optionInputs = (el: HTMLElement) =>
  [...activeItem(el).querySelectorAll("input[type=radio], input[type=checkbox]")] as HTMLInputElement[];
/** the active question's free-text box */
const otherBox = (el: HTMLElement) => activeItem(el).querySelector("input[type=text]") as HTMLInputElement;
/** pick the active question's first option */
const answerActive = (el: HTMLElement) => click(optionInputs(el)[0]!);
/**
 * Advance to the last question. Answering is part of advancing: every item is `required`, so
 * Next refuses an untouched question — which is asserted on its own below.
 */
const toLastQuestion = (el: HTMLElement) => {
  for (let i = 0; i < 10 && buttonsNamed(el, "Next").length > 0; i++) {
    answerActive(el);
    click(buttonsNamed(el, "Next")[0]!);
  }
};
/** type into a controlled input the way the DOM would, then let React see it */
const type = (box: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("the question renders as itself", () => {
  test("the first question, its header, options and descriptions are on screen", () => {
    const el = render(askingLog());
    const shownText = activeItem(el).textContent ?? "";
    expect(shownText).toContain("Which approach should I take?");
    expect(shownText).toContain("Approach");
    expect(shownText).toContain("Approach A");
    expect(shownText).toContain("Rewrite the renderer.");
    expect(shownText).toContain("Approach B");
    expect(shownText).toContain("Patch the caller instead.");
  });

  test("one question at a time, and the next one is a Next away", () => {
    const el = render(askingLog());
    // HOW-27: the second question exists but is hidden — asking all of them at once was the
    // thing that did not read like the CLIs
    expect(el.querySelectorAll("fieldset")).toHaveLength(2);
    expect(el.querySelectorAll("fieldset[data-active]")).toHaveLength(1);
    expect(activeItem(el).querySelector("legend")?.textContent).toBe("Which approach should I take?");
    expect(el.textContent).toContain("Question 1 of 2");

    answerActive(el);
    click(buttonsNamed(el, "Next")[0]!);
    expect(activeItem(el).querySelector("legend")?.textContent).toBe("Which files may I touch?");
    expect(el.textContent).toContain("Question 2 of 2");
    const shownText = activeItem(el).textContent ?? "";
    expect(shownText).toContain("Scope");
    expect(shownText).toContain("the product code");
  });

  test("a required question cannot be walked past, and says why", () => {
    const el = render(askingLog());
    click(buttonsNamed(el, "Next")[0]!); // nothing picked yet
    expect(activeItem(el).querySelector("legend")?.textContent).toBe("Which approach should I take?");
    expect(activeItem(el).querySelector('[role="alert"]')?.textContent).toContain("Choose an answer");
  });

  test("the options are numbered, which is how the CLI is driven", () => {
    const el = render(askingLog());
    expect(optionInputs(el).map((i) => i.getAttribute("aria-keyshortcuts"))).toEqual(["1", "2"]);
  });

  test("single-select draws radios; multi-select draws checkboxes", () => {
    const el = render(askingLog());
    // the asking tool's own `multiSelect` decides the control, and it still does
    expect(optionInputs(el).map((i) => i.type)).toEqual(["radio", "radio"]);
    expect(optionInputs(el).map((i) => i.getAttribute("value"))).toEqual(["Approach A", "Approach B"]);
    answerActive(el);
    click(buttonsNamed(el, "Next")[0]!);
    expect(optionInputs(el).map((i) => i.type)).toEqual(["checkbox", "checkbox"]);
  });

  test("each question carries a free-text box, so \"neither\" is sayable", () => {
    const el = render(askingLog());
    const labels = [...el.querySelectorAll("input[type=text]")].map((i) => i.getAttribute("aria-label"));
    expect(labels).toEqual(["other answer for Approach", "other answer for Scope"]);
    // and the one on screen belongs to the question on screen
    expect(otherBox(el).getAttribute("aria-label")).toBe("other answer for Approach");
  });

  test("the card is the deep-link target a notification lands on", () => {
    expect(render(askingLog()).querySelector("#needs-input")).not.toBeNull();
  });

  test("Answer belongs to the last question; Back only appears after the first", () => {
    const el = render(askingLog());
    expect(buttonsNamed(el, "Answer")).toHaveLength(0); // not on question 1 of 2
    expect(buttonsNamed(el, "Back")).toHaveLength(0);   // nowhere to go back to
    answerActive(el);
    click(buttonsNamed(el, "Next")[0]!);
    expect(buttonsNamed(el, "Answer")).toHaveLength(1);
    expect(buttonsNamed(el, "Next")).toHaveLength(0);
    expect(buttonsNamed(el, "Back")).toHaveLength(1);
  });

  test("nothing is submittable until something is answered", () => {
    const el = render(askingLog(ONE_QUESTION));
    expect((buttonsNamed(el, "Answer")[0] as HTMLButtonElement).disabled).toBe(true);
    answerActive(el);
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
    click(optionInputs(el)[1]!);                 // Approach B, on question 1
    click(buttonsNamed(el, "Next")[0]!);
    click(optionInputs(el)[0]!);                 // src
    click(optionInputs(el)[1]!);                 // and tests — multi-select accumulates
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
    const el = render(askingLog(ONE_QUESTION));
    click(optionInputs(el)[0]!);                 // Approach A
    click(optionInputs(el)[1]!);                 // then Approach B — a radio replaces, never adds
    await act(async () => { buttonsNamed(el, "Answer")[0]!.click(); });
    expect(sent[0]).toEqual({ answers: [{ id: "q0", selected: ["Approach B"] }] });
  });

  test("free text rides along as `other` on the question it was typed under", async () => {
    const sent: unknown[] = [];
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const el = render(askingLog(ONE_QUESTION));
    type(otherBox(el), "neither — read the spec first");
    await act(async () => { buttonsNamed(el, "Answer")[0]!.click(); });
    // it rides as `other`, NOT as a `selected` label — which is the whole reason the card holds
    // its own state instead of reading FormData, where the two are indistinguishable
    expect(sent[0]).toEqual({ answers: [{ id: "q0", selected: [], other: "neither — read the spec first" }] });
  });

  test("a refusal is shown VERBATIM, never collapsed into \"failed\"", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "answers do not match the questions being asked" }), {
        status: 400, headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const el = render(askingLog(ONE_QUESTION));
    answerActive(el);
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

  test("a run parked on a question has not \"died inside this turn\"", () => {
    // the mid-turn ask holds the session open on purpose, so there is no turn-finalized yet.
    // Claiming a death here put the line two rows above the card asking for an answer.
    const msgs = conversation(deriveDetail("r1", askingLog().events));
    const beats = msgs.find((m) => m.kind === "beats") as Extract<typeof msgs[number], { kind: "beats" }>;
    expect(beats.unfinished).toBe(false);
  });

  test("a turn that really was cut off still says so", () => {
    // same un-finalized turn, but the run is NOT parked here — nothing is waiting on a human
    const log = new FakeLog();
    log.add({ type: "run-started", graph: "quick-task", inputs: { goal: "g" }, pinned_prompts: {} });
    log.add({ type: "node-started", node: "do", visit: 1, attempt_id: "do#1" });
    log.add({ type: "chunk", node: "do", visit: 1, turn: 1, index: 0, kind: "text", content: "half a thou" });
    const msgs = conversation(deriveDetail("r1", log.events));
    const beats = msgs.find((m) => m.kind === "beats") as Extract<typeof msgs[number], { kind: "beats" }>;
    expect(beats.unfinished).toBe(true);
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
    expect(log.querySelector(".cv-standing")).not.toBeNull();
    // it is the LAST row in the conversation, which is what "at the foot" means. Compared by
    // messageId rather than by node identity: the content box also carries the scroller's own
    // trailing spacer, and a DOM-vs-DOM `toBe` that fails takes the whole run down when Bun's
    // formatter tries to print two happy-dom trees.
    const rows = [...log.querySelectorAll('[data-slot="message-scroller-item"]')];
    expect(rows.at(-1)!.querySelector(".cv-standing")).not.toBeNull();
  });

  test("every row is its own scroller item, and a step is the anchor a new turn lands on", () => {
    const el = render(askingLog());
    const rows = [...el.querySelectorAll('[data-slot="message-scroller-item"]')];
    // step, beats, asked, and the standing ask
    expect(rows).toHaveLength(4);
    // each row is addressable, which is what lets the viewport hold a position across renders.
    // The ask row's id carries its log seq, so it is matched rather than pinned — the seq is an
    // artefact of the fixture, not part of the contract.
    const ids = rows.map((r) => r.getAttribute("data-message-id"));
    expect(ids[0]).toBe("step:do@1");
    expect(ids[1]).toBe("beats:do@1");
    expect(ids[2]).toMatch(/^ask:\d+$/);
    expect(ids[3]).toBe("needs-input");
    // HOW-27: a step boundary IS the turn boundary, so a step is what the viewport anchors to
    // and the agent's own prose is not — otherwise every chunk would re-anchor the view
    expect(rows.map((r) => r.getAttribute("data-scroll-anchor"))).toEqual([
      "true", "false", "false", "true",
    ]);
  });

  test("a run with nothing in it says so rather than drawing an empty frame", () => {
    const log = new FakeLog();
    log.add({ type: "run-started", graph: "quick-task", inputs: { goal: "g" }, pinned_prompts: {} });
    expect(render(log).textContent).toContain("nothing has happened in this run yet");
  });
});

describe("moving around a long transcript (HOW-27)", () => {
  test("both pins are present, and each says which way it goes", () => {
    const el = render(askingLog());
    const pins = [...el.querySelectorAll('[data-slot="message-scroller-button"]')];
    expect(pins.map((p) => p.getAttribute("data-direction"))).toEqual(["start", "end"]);
    // a hairline arrow is not a label; each pin carries its own accessible name AND a visible
    // word (HOW-30) — a bare arrow floating over prose read as part of the text
    expect(pins.map((p) => p.getAttribute("aria-label"))).toEqual(["Scroll to start", "Scroll to end"]);
    expect(pins.map((p) => p.textContent?.trim())).toEqual(["Top", "Latest"]);
  });

  test("the Top pin is in the toolbar, not floating over the transcript (HOW-30)", () => {
    const el = render(askingLog());
    const top = el.querySelector('[data-slot="message-scroller-button"][data-direction="start"]')!;
    expect(top.closest(".chat-head")).not.toBeNull();
    expect(top.closest('[data-slot="message-scroller"]')).toBeNull();
  });

  test("a pin is inert while that direction is not scrollable", () => {
    // happy-dom has no layout, so nothing is scrollable and BOTH pins report inactive —
    // which is the assertion worth having: they are not drawn active by default
    const el = render(askingLog());
    const pins = [...el.querySelectorAll('[data-slot="message-scroller-button"]')];
    expect(pins.map((p) => p.getAttribute("data-active"))).toEqual(["false", "false"]);
  });
});

describe("collapsing the tool calls (HOW-27)", () => {
  const bodies = (el: HTMLElement) => [...el.querySelectorAll(".act-tool-body")];
  const toggle = (el: HTMLElement) =>
    [...el.querySelectorAll("button")].find((b) => /tool call/.test(b.textContent ?? ""))!;

  test("the control counts the tool calls it acts on", () => {
    const el = render(askingLog());
    expect(toggle(el).textContent).toContain("Expand 1 tool call");
  });

  test("it opens every tool call, then closes every one again", () => {
    const el = render(askingLog());
    expect(bodies(el)).toHaveLength(0);       // closed by default
    click(toggle(el));
    expect(bodies(el)).toHaveLength(1);
    expect(toggle(el).textContent).toContain("Collapse 1 tool call");
    click(toggle(el));
    expect(bodies(el)).toHaveLength(0);
  });

  test("a single beat can still be toggled on its own after a bulk action", () => {
    // the epoch is what protects this: a beat adopts the bulk value once, then is its own
    // again, so a bulk expand does not nail every beat open for the rest of the session
    const el = render(askingLog());
    click(toggle(el));
    expect(bodies(el)).toHaveLength(1);
    const head = el.querySelector(".act-tool-head") as HTMLElement;
    click(head);
    expect(bodies(el)).toHaveLength(0);
    expect(head.getAttribute("aria-expanded")).toBe("false");
  });

  test("a run with no tool calls gets no control rather than an inert one", () => {
    const log = new FakeLog();
    log.add({ type: "run-started", graph: "quick-task", inputs: { goal: "g" }, pinned_prompts: {} });
    log.add({ type: "node-started", node: "do", visit: 1, attempt_id: "do#1" });
    log.add({ type: "chunk", node: "do", visit: 1, turn: 1, index: 0, kind: "text", content: "just prose" });
    const el = render(log);
    expect([...el.querySelectorAll("button")].filter((b) => /tool call/.test(b.textContent ?? ""))).toHaveLength(0);
  });
});

describe("reading a transcript that is mostly tool work (HOW-30)", () => {
  /** a turn whose prose is separated by runs of tools — the shape of the ticket's screenshot */
  const toolHeavyLog = (results: string[] = ["ok", "ok", "ok"]) => {
    const log = new FakeLog();
    log.add({ type: "run-started", graph: "quick-task", inputs: { goal: "g" }, pinned_prompts: {} });
    log.add({ type: "node-started", node: "do", visit: 1, attempt_id: "do#1" });
    let i = 0;
    const chunk = (c: Record<string, unknown>) =>
      log.add({ type: "chunk", node: "do", visit: 1, turn: 1, index: i++, ...c } as never);
    chunk({ kind: "text", content: "Checking the PR." });
    results.forEach((r, n) => {
      chunk({ kind: "tool_call", tool_id: `t${n}`, tool_name: n === 1 ? "mcp__claude_ai_Linear__get_issue" : "Bash", content: JSON.stringify({ command: `cmd ${n}` }) });
      chunk({ kind: "tool_result", tool_id: `t${n}`, content: r });
    });
    chunk({ kind: "text", content: "All merged." });
    return log;
  };

  test("a run of adjacent tool calls is one line, between the sentences it sits between", () => {
    const el = render(toolHeavyLog());
    const agent = el.querySelector(".cv-agent")!;
    expect(agent.querySelectorAll(".act-group")).toHaveLength(1);
    expect(agent.querySelector(".act-group-head")!.textContent).toContain("Used 3 tools");
    // the group names what ran, by the short label, de-duplicated
    expect(agent.querySelector(".act-group-head")!.textContent).toContain("Bash, Linear · get_issue");
    // closed, its beats are not on screen — the prose is what is
    expect(agent.querySelectorAll(".act-tool")).toHaveLength(0);
    expect(agent.textContent).toContain("Checking the PR.");
    expect(agent.textContent).toContain("All merged.");
  });

  test("opening the group shows each tool as its own beat, still closed", () => {
    const el = render(toolHeavyLog());
    click(el.querySelector(".act-group-head") as HTMLElement);
    expect(el.querySelectorAll(".act-group .act-tool")).toHaveLength(3);
    expect(el.querySelectorAll(".act-tool-body")).toHaveLength(0);
  });

  test("a group with a failure inside opens itself, and so does the failed beat", () => {
    const el = render(toolHeavyLog(["ok", "error: not found", "ok"]));
    const group = el.querySelector(".act-group")!;
    expect(group.getAttribute("data-open")).toBe("open");
    expect(group.querySelector(".act-group-head")!.textContent).toContain("1 failed");
    expect(el.querySelectorAll(".act-tool-body")).toHaveLength(1);
  });

  test("the bulk control opens the groups AND every call inside them", () => {
    const el = render(toolHeavyLog());
    const toggle = [...el.querySelectorAll("button")].find((b) => /tool call/.test(b.textContent ?? ""))!;
    expect(toggle.textContent).toContain("Expand 3 tool calls");
    click(toggle);
    expect(el.querySelector(".act-group")!.getAttribute("data-open")).toBe("open");
    expect(el.querySelectorAll(".act-tool-body")).toHaveLength(3);
    click(toggle);
    expect(el.querySelector(".act-group")!.getAttribute("data-open")).toBe("closed");
  });

  test("the composer has a send control that is off until there is something to send", () => {
    const el = render(askingLog());
    const send = el.querySelector('button[aria-label="Ask"]') as HTMLButtonElement;
    expect(send).not.toBeNull();
    expect(send.disabled).toBe(true);
    type(el.querySelector('input[aria-label="ask about this run"]') as HTMLInputElement, "why?");
    expect((el.querySelector('button[aria-label="Ask"]') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("model output stays untrusted input", () => {
  test("a citation-shaped string in an answer is rendered as TEXT, not markup", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ answer: 'see do@1 and <img src=x onerror="alert(1)">' }), {
        status: 200, headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const el = render(askingLog());
    // HOW-27: no tab to switch to — the composer is at the foot of the transcript, always
    const input = el.querySelector('input[aria-label="ask about this run"]') as HTMLInputElement;
    type(input, "what happened?");
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror="alert(1)">');
    // a real step key becomes a chip the operator can click through to
    expect([...el.querySelectorAll(".chat-cite")].map((c) => c.textContent)).toContain("do@1");
  });
});
