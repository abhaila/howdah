/**
 * Activity — the step's journey, and the three ways it can go back to being a feed.
 *
 * The pane exists because the Logs tab rendered one row per streaming delta: on a real run,
 * 12,609 `text` chunks averaging 13 characters and 2,252 `thinking` chunks carrying nothing.
 * So what is pinned here is that prose arrives as PROSE, that a tool is one line until asked,
 * and that a FAILED tool does not wait to be asked — the cause of a parked step is almost
 * always in a tool result, and a failure you have to click to find is a failure you miss.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CoalescedTurn, TurnPart } from "../../log/coalesce";
import type { RunDetail } from "../derive";
import { StepActivity, beatsOf, groupBeats, toolLabel, toolSummary } from "./run/activity";

let root: Root | null = null;
let host: HTMLElement | null = null;

const ROW = {
  node: "slice.propose", visit: 1, started_at: "2026-01-01T00:00:00.000Z", finished_at: null,
  status: "succeeded" as const, duration_ms: 10, offset_ms: 0, run_span_ms: 10, waiting_ms: 0,
};
const turn = (parts: TurnPart[]): CoalescedTurn => ({ node: ROW.node, visit: 1, turn: 1, parts, finalized: true });

function render(turns: CoalescedTurn[], context: RunDetail["context"] = []): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<StepActivity turns={turns} row={ROW} context={context} />));
  return host;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
});

describe("toolSummary", () => {
  test("names the work, not the JSON", () => {
    expect(toolSummary('{"command":"ls web/app","description":"look"}')).toBe("ls web/app");
    expect(toolSummary('{"file_path":"/a/b.ts","offset":10}')).toBe("/a/b.ts");
    expect(toolSummary('{"pattern":"TODO"}')).toBe("TODO");
  });

  test("collapses whitespace so a multi-line command stays one line", () => {
    expect(toolSummary('{"command":"git status\\n  --short"}')).toBe("git status --short");
  });

  test("falls back rather than printing [object Object] at someone", () => {
    expect(toolSummary('{"weird":42}')).toBe('{"weird":42}');
    expect(toolSummary("not json at all")).toBe("not json at all");
  });
});

describe("beatsOf", () => {
  test("a tool result is folded into the call it answers", () => {
    const beats = beatsOf([
      { kind: "tool_call", content: '{"command":"ls"}', tool_id: "t1", tool_name: "Bash" },
      { kind: "tool_result", content: "a\nb", tool_id: "t1" },
    ]);
    expect(beats).toHaveLength(1);
    expect(beats[0]!.kind).toBe("tool");
    expect(beats[0]!.result!.content).toBe("a\nb");
  });

  test("empty thinking is dropped; thinking that says something is kept", () => {
    const beats = beatsOf([
      { kind: "thinking", content: "" },
      { kind: "text", content: "the answer" },
      { kind: "thinking", content: "a real thought" },
    ]);
    expect(beats.map((b) => b.kind)).toEqual(["text", "thinking"]);
  });

  test("a result whose call never arrived is still drawn", () => {
    // an orphan is a fact about the run, not a rendering problem to hide
    const beats = beatsOf([{ kind: "tool_result", content: "output", tool_id: "gone" }]);
    expect(beats).toHaveLength(1);
    expect(beats[0]!.kind).toBe("tool");
  });
});

describe("StepActivity", () => {
  test("streamed prose renders as one paragraph, not six fragments", () => {
    // coalesce() has already stitched the deltas; this is the pane not re-shredding them
    const el = render([turn([{ kind: "text", content: "I'll explore the harness abstraction before designing the slice." }])]);
    const paras = el.querySelectorAll(".act-text p");
    expect(paras).toHaveLength(1);
    expect(paras[0]!.textContent).toBe("I'll explore the harness abstraction before designing the slice.");
  });

  test("a tool is one line until asked, and opens to its input and output", () => {
    const el = render([turn([
      { kind: "tool_call", content: '{"command":"bun test"}', tool_id: "t1", tool_name: "Bash" },
      { kind: "tool_result", content: "1162 pass", tool_id: "t1" },
    ])]);
    const head = el.querySelector(".act-tool-head") as HTMLButtonElement;
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(el.querySelector(".act-pre")).toBeNull();
    expect(el.textContent).toContain("bun test"); // the summary line names the work

    act(() => head.click());
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(el.textContent).toContain("1162 pass");
  });

  test("a FAILED tool opens itself, because that is the one you came to read", () => {
    const el = render([turn([
      { kind: "tool_call", content: '{"command":"bun test"}', tool_id: "t1", tool_name: "Bash" },
      { kind: "tool_result", content: "error: 3 tests failed", tool_id: "t1" },
    ])]);
    expect(el.querySelector(".act-tool-head")!.getAttribute("aria-expanded")).toBe("true");
    expect(el.querySelector(".act-tool")!.className).toContain("failed");
    expect(el.textContent).toContain("error: 3 tests failed");
  });

  test("a turn the process died inside says so, rather than reading as complete", () => {
    const el = render([{ ...turn([{ kind: "text", content: "half a th" }]), finalized: false }]);
    expect(el.querySelector(".act-note")!.textContent).toContain("died inside this turn");
  });

  test("what the step published closes it, read off the context entries", () => {
    const context = [
      { key: "slice.proposal", written: true, scope: null, declared_writers: [], read_by: [],
        writes: [{ node: ROW.node, visit: 1, at: "x", replaced: false }] },
      { key: "someone.else", written: true, scope: null, declared_writers: [], read_by: [],
        writes: [{ node: "other.node", visit: 1, at: "x", replaced: false }] },
    ] as unknown as RunDetail["context"];
    const el = render([turn([{ kind: "text", content: "done" }])], context);
    const wrote = el.querySelector(".act-wrote")!.textContent!;
    expect(wrote).toContain("slice.proposal");
    expect(wrote).not.toContain("someone.else"); // another node's write is not this step's
  });

  test("HOW-29: prose is markdown, and the outputs object becomes a document, not a JSON line", () => {
    const plan = "# Plan\n\n## Steps\n\n1. **Port** the adapter\n2. Add `SigningTaskQueue`\n   - in-memory double\n\nThat is the whole plan, written at length so it reads as a document rather than a value.";
    const text = `I've written the plan. **The fix:** skip queued quotes.\n\n${JSON.stringify({ outputs: { implementation_plan: plan, verdict: "pass" } })}`;
    const el = render([turn([{ kind: "text", content: text }])]);
    // the summary is rendered, not printed with its asterisks
    expect(el.querySelector(".act-text strong")!.textContent).toBe("The fix:");
    // no escaped JSON anywhere on screen
    expect(el.textContent).not.toContain('{"outputs"');
    expect(el.textContent).not.toContain("\\n");
    // the plan is a document card with real structure
    const doc = el.querySelector(".out-doc")!;
    expect(doc.querySelector(".out-doc-name")!.textContent).toBe("implementation_plan");
    expect(doc.querySelector("h2")!.textContent).toBe("Steps");
    expect(doc.querySelectorAll("ol > li")).toHaveLength(2);
    expect(doc.querySelector("ol li ul li")!.textContent).toBe("in-memory double");
    // a short value stays a value
    expect(el.querySelector(".out-value")!.textContent).toContain("pass");
  });

  test("HOW-29: the document card expands in place and opens in the reader", () => {
    const plan = "## Plan\n\n" + "a line of the plan\n\n".repeat(40);
    const el = render([turn([{ kind: "text", content: JSON.stringify({ outputs: { implementation_plan: plan } }) }])]);
    const doc = el.querySelector(".out-doc")!;
    expect(doc.getAttribute("data-expanded")).toBe("closed");
    const expand = [...doc.querySelectorAll("button")].find((b) => b.textContent === "Expand")!;
    act(() => expand.click());
    expect(doc.getAttribute("data-expanded")).toBe("open");
    expect(document.querySelector("dialog")).toBeNull();
    act(() => (doc.querySelector('[aria-label="read implementation_plan"]') as HTMLButtonElement).click());
    const dialog = document.querySelector("dialog")!;
    expect(dialog.querySelector(".doc-reader h2")!.textContent).toBe("Plan");
  });

  test("HOW-29: an outputs object still streaming is named, not printed half-written", () => {
    const el = render([{ ...turn([{ kind: "text", content: 'Done.\n{"outputs": {"implementation_plan": "# Pla' }]), finalized: false }]);
    expect(el.textContent).not.toContain('{"outputs"');
    expect(el.querySelector(".act-note-quiet")!.textContent).toContain("writing outputs");
  });

  test("a step with nothing in it says so instead of rendering an empty frame", () => {
    const el = render([]);
    expect(el.textContent).toContain("nothing ran in this step yet");
  });
});

describe("toolLabel (HOW-30)", () => {
  test("an MCP tool is shown as its server's last segment and the tool", () => {
    expect(toolLabel("mcp__claude_ai_Linear__save_issue")).toBe("Linear · save_issue");
    expect(toolLabel("mcp__github__create_pr")).toBe("github · create_pr");
  });
  test("anything else is left exactly as the harness named it", () => {
    expect(toolLabel("Bash")).toBe("Bash");
    expect(toolLabel("mcp__")).toBe("mcp__");
    expect(toolLabel("mcp__only")).toBe("mcp__only");
  });
});

describe("groupBeats (HOW-30)", () => {
  const p = (kind: TurnPart["kind"], content = "x"): TurnPart => ({ kind, content }) as TurnPart;
  const tool = { kind: "tool" as const, part: p("tool_call") };
  const text = { kind: "text" as const, part: p("text") };

  test("two or more adjacent tools fold into one group; prose splits runs", () => {
    const g = groupBeats([text, tool, tool, text, tool, tool, tool]);
    expect(g.map((b) => b.kind)).toEqual(["text", "tools", "text", "tools"]);
    expect(g.map((b) => (b.kind === "tools" ? b.beats.length : 1))).toEqual([1, 2, 1, 3]);
  });
  test("a lone tool stays a beat — a group of one is a click for nothing", () => {
    expect(groupBeats([text, tool, text]).map((b) => b.kind)).toEqual(["text", "tool", "text"]);
    expect(groupBeats([tool]).map((b) => b.kind)).toEqual(["tool"]);
  });
  test("nothing in, nothing out", () => {
    expect(groupBeats([])).toEqual([]);
  });
});
