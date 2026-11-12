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
import type { RunDetail, TurnState } from "../derive";
import { StepActivity, ToolGroup, beatsOf, groupBeats, toolLabel, toolOutcome, toolSummary } from "./run/activity";

let root: Root | null = null;
let host: HTMLElement | null = null;

const ROW = {
  node: "slice.propose", visit: 1, started_at: "2026-01-01T00:00:00.000Z", finished_at: null,
  status: "succeeded" as const, duration_ms: 10, offset_ms: 0, run_span_ms: 10, waiting_ms: 0, usage: null, profile: null,
};
const turn = (parts: TurnPart[]): CoalescedTurn => ({ node: ROW.node, visit: 1, turn: 1, parts, finalized: true });

function render(turns: CoalescedTurn[], context: RunDetail["context"] = [], state?: TurnState, lastActivityAt: string | null = null): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<StepActivity turns={turns} row={ROW} context={context} state={state ?? (turns.every((t) => t.finalized) ? "done" : "died")} lastActivityAt={lastActivityAt} />));
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
    // HOW-68: a tool's input and output are the shared CodeBlock now (was a local `.act-pre`)
    expect(el.querySelector(".code-block")).toBeNull();
    expect(el.textContent).toContain("bun test"); // the summary line names the work

    act(() => head.click());
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(el.textContent).toContain("1162 pass");
  });

  // HOW-68: "failed" is the HARNESS's word (`is_error`), carried through coalesce(). It used to
  // be a regex over the output, which badged "0 failed — BUILD SUCCESSFUL" red; these pin both
  // halves and the old-log fallback, which is a neutral hint and never the red badge.
  test("a tool the harness says FAILED opens itself, because that is the one you came to read", () => {
    const el = render([turn([
      { kind: "tool_call", content: '{"command":"bun test"}', tool_id: "t1", tool_name: "Bash" },
      { kind: "tool_result", content: "3 tests did not pass", tool_id: "t1", is_error: true },
    ])]);
    expect(el.querySelector(".act-tool-head")!.getAttribute("aria-expanded")).toBe("true");
    expect(el.querySelector(".act-tool")!.className).toContain("failed");
    expect(el.textContent).toContain("3 tests did not pass");
    expect(el.textContent).toContain("failed");
    expect(el.textContent).not.toContain("may have failed");
  });

  test("a tool the harness says did NOT fail is not failed, whatever its output says", () => {
    const el = render([turn([
      { kind: "tool_call", content: '{"command":"./gradlew test"}', tool_id: "t1", tool_name: "Bash" },
      { kind: "tool_result", content: "error: none\n14 tests completed, 0 failed — BUILD SUCCESSFUL\nexit code 1 was not returned", tool_id: "t1", is_error: false },
    ])]);
    expect(el.querySelector(".act-tool")!.className).not.toContain("failed");
    expect(el.querySelector(".act-tool-head")!.getAttribute("aria-expanded")).toBe("false");
    expect(el.querySelector(".act-tool-head")!.textContent).not.toMatch(/failed/);
  });

  test("with no word from the harness, a failure-shaped output is a NEUTRAL hint: closed, not red", () => {
    const el = render([turn([
      { kind: "tool_call", content: '{"command":"bun test"}', tool_id: "t1", tool_name: "Bash" },
      { kind: "tool_result", content: "error: 3 tests failed", tool_id: "t1" },
    ])]);
    expect(el.querySelector(".act-tool")!.className).not.toContain("failed");
    expect(el.querySelector(".act-tool-head")!.getAttribute("aria-expanded")).toBe("false");
    expect(el.querySelector(".act-tool-head")!.textContent).toContain("may have failed");
  });

  test("toolOutcome: the harness decides; the fallback is narrow", () => {
    const r = (content: string, is_error?: boolean): TurnPart => ({ kind: "tool_result", content, ...(is_error !== undefined ? { is_error } : {}) });
    expect(toolOutcome(undefined)).toBe("ok");
    expect(toolOutcome(r("fine", true))).toBe("failed");
    expect(toolOutcome(r("Traceback (most recent call last)", false))).toBe("ok");
    // nothing said: counts, prose and "not found" in a sentence are not failures
    for (const ok of ["14 tests completed, 0 failed — BUILD SUCCESSFUL", "no errors found", "the file was not found in the cache, fetched it", "access was denied last week; fixed", "1162 pass", "handles the error path"])
      expect(toolOutcome(r(ok))).toBe("ok");
    for (const maybe of ["error: expected 2, got 3", "  Error: ENOENT", "fatal: not a git repository", "Traceback (most recent call last):\n  File", "Process exited with code 2", "exit status 1", "bash: foo: command not found", "cat: /etc/shadow: Permission denied"])
      expect(toolOutcome(r(maybe))).toBe("maybe");
  });

  test("a group counts only what the harness called failed; guesses are a separate neutral count", () => {
    const call = (id: string): TurnPart => ({ kind: "tool_call", content: '{"command":"x"}', tool_id: id, tool_name: "Bash" });
    const el = render([turn([
      call("a"), { kind: "tool_result", content: "0 failed", tool_id: "a", is_error: false },
      call("b"), { kind: "tool_result", content: "boom", tool_id: "b", is_error: true },
      call("c"), { kind: "tool_result", content: "fatal: no", tool_id: "c" },
    ])]);
    // StepActivity draws beats one by one; the group is the Chat transcript's — render it directly
    act(() => root!.render(<ToolGroup beats={beatsOf(turn([
      call("a"), { kind: "tool_result", content: "0 failed", tool_id: "a", is_error: false },
      call("b"), { kind: "tool_result", content: "boom", tool_id: "b", is_error: true },
      call("c"), { kind: "tool_result", content: "fatal: no", tool_id: "c" },
    ]).parts)} />));
    const head = el.querySelector(".act-group-head")!;
    expect(head.textContent).toContain("1 failed");
    expect(head.textContent).toContain("1 may have failed");
    expect(head.getAttribute("aria-expanded")).toBe("true");
    // a group of guesses only stays shut
    act(() => root!.render(<ToolGroup key="g2" beats={beatsOf([call("c"), { kind: "tool_result", content: "fatal: no", tool_id: "c" }, call("d"), { kind: "tool_result", content: "ok", tool_id: "d" }])} />));
    const g2 = el.querySelector(".act-group-head")!;
    expect(g2.getAttribute("aria-expanded")).toBe("false");
    expect(g2.textContent).not.toMatch(/\d failed/);
  });

  test("a turn the process died inside says so, rather than reading as complete", () => {
    const el = render([{ ...turn([{ kind: "text", content: "half a th" }]), finalized: false }]);
    expect(el.querySelector(".act-note")!.textContent).toContain("died inside this turn");
  });

  test("HOW-46: a LIVE turn is working, not dead — and says how recently it last spoke", () => {
    const at = new Date(Date.now() - 12_000).toISOString();
    const el = render([{ ...turn([{ kind: "text", content: "half a th" }]), finalized: false }], [], "live", at);
    expect(el.querySelector(".act-note")).toBeNull();
    expect(el.textContent).not.toContain("died");
    const live = el.querySelector(".act-live")!;
    expect(live.textContent).toMatch(/working · last activity 1[2-4]s ago/);
    expect(live.className).not.toContain("quiet");
  });

  test("HOW-46: a live turn that has been silent past the threshold turns amber", () => {
    const at = new Date(Date.now() - 6 * 60_000).toISOString();
    const el = render([{ ...turn([{ kind: "text", content: "x" }]), finalized: false }], [], "live", at);
    expect(el.querySelector(".act-live")!.className).toContain("quiet");
  });

  test("HOW-46: a turn waiting on a mid-turn ask draws neither note", () => {
    const el = render([{ ...turn([{ kind: "text", content: "x" }]), finalized: false }], [], "waiting");
    expect(el.querySelector(".act-note")).toBeNull();
    expect(el.querySelector(".act-live")).toBeNull();
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
    // HOW-68: a document's headings sit one level down, so "# Plan" is not a second h1 on the run
    expect(doc.querySelector("h1")).toBeNull();
    expect(doc.querySelector("h2")!.textContent).toBe("Plan");
    expect(doc.querySelector("h3")!.textContent).toBe("Steps");
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
    // "## Plan" is an h3: a document's headings are drawn one level down (HOW-68, markdown.tsx)
    expect(dialog.querySelector(".doc-reader h3")!.textContent).toBe("Plan");
  });

  test("HOW-29: an outputs object still streaming is named, not printed half-written", () => {
    const el = render([{ ...turn([{ kind: "text", content: 'Done.\n{"outputs": {"implementation_plan": "# Pla' }]), finalized: false }]);
    expect(el.textContent).not.toContain('{"outputs"');
    expect(el.querySelector(".act-note-quiet")!.textContent).toContain("writing outputs");
  });

  test("a step with nothing in it says so instead of rendering an empty frame", () => {
    const el = render([]);
    // HOW-68: an empty state names the place and says what will appear (DESIGN.md Components)
    expect(el.textContent).toContain("Nothing ran here yet");
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

describe("splitEngineNotes (HOW-68)", () => {
  test("peels the engine's bracketed closing lines off the end, in order", async () => {
    const { splitEngineNotes } = await import("./run/activity");
    const r = splitEngineNotes("Done what I could.\n[output contract violation: no outputs line]\n[failed: output contract violation: no outputs line]");
    expect(r.prose).toBe("Done what I could.");
    expect(r.notes).toEqual([
      { kind: "failure", text: "output contract violation: no outputs line" },
      { kind: "failure", text: "output contract violation: no outputs line" },
    ]);
  });
  test("a reason with brackets and newlines in it stays one note", async () => {
    const { splitEngineNotes } = await import("./run/activity");
    const r = splitEngineNotes("x\n[attempt failed: gh exited 1 [stderr]\nsecond line]");
    expect(r).toEqual({ prose: "x", notes: [{ kind: "failure", text: "gh exited 1 [stderr]\nsecond line" }] });
  });
  test("the allowance hop is a note, not a failure, and an agent's own brackets are prose", async () => {
    const { splitEngineNotes } = await import("./run/activity");
    expect(splitEngineNotes("\n[claude allowance exhausted: retrying this node with codex]").notes).toEqual([{ kind: "note", text: "claude allowance exhausted: retrying this node with codex" }]);
    expect(splitEngineNotes("See the list [1] and [note: mine]")).toEqual({ prose: "See the list [1] and [note: mine]", notes: [] });
  });
});
