/**
 * The run page must not re-walk a multi-megabyte log to draw one new text delta.
 * The fold matches coalesce() and deriveLogRows() when it is caught up, and a later
 * append touches only the new line — the turn already on screen is the same object.
 */
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLiveEvent, coalesce } from "../log/coalesce";
import type { LoggedEvent, RunEvent } from "../log/events";
import { deriveLogRows } from "./derive";
import { RunViewCache } from "./run-view-cache";

function stamped(events: RunEvent[]): LoggedEvent[] {
  return events.map((e, i) => ({ ...e, seq: i + 1, ts: new Date(1_700_000_000_000 + i * 1000).toISOString() }) as LoggedEvent);
}

function writeLog(events: RunEvent[]): { path: string; events: LoggedEvent[] } {
  const dir = mkdtempSync(join(tmpdir(), "howdah-view-"));
  const path = join(dir, "run.jsonl");
  const logged = stamped(events);
  writeFileSync(path, logged.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { path, events: logged };
}

const body: RunEvent[] = [
  { type: "run-started", graph: "write-doc", inputs: { goal: "g" }, pinned_prompts: {} },
  { type: "node-started", node: "doc.draft", visit: 1, attempt_id: "doc.draft#1" },
  { type: "chunk", node: "doc.draft", visit: 1, turn: 1, index: 0, kind: "text", content: "Hello " },
  { type: "chunk", node: "doc.draft", visit: 1, turn: 1, index: 1, kind: "text", content: "there" },
  { type: "chunk", node: "doc.draft", visit: 1, turn: 1, index: 2, kind: "tool_call", content: "Write(doc.md)", tool_id: "t1", tool_name: "Write" },
  { type: "chunk", node: "doc.draft", visit: 1, turn: 1, index: 3, kind: "thinking", content: "" },
  { type: "chunk", node: "doc.draft", visit: 1, turn: 1, index: 4, kind: "thinking", content: "hmm" },
  { type: "turn-finalized", node: "doc.draft", visit: 1, turn: 1, usage: { input_tokens: 10, output_tokens: 4, cost_usd: 0.01 } },
  { type: "attention-raised", node: "doc.draft", visit: 1, reason: "needs your reply" },
];

describe("run view cache", () => {
  test("a caught-up fold matches coalesce and deriveLogRows, and drops streaming chunks from the shell", () => {
    const { path, events } = writeLog(body);
    const view = new RunViewCache().fold(path);
    expect(view.turns).toEqual(coalesce(events));
    const rows = deriveLogRows(events).map(({ seq, type, merged, summary }) => ({ seq, type, merged, summary }));
    expect(view.logRows.map(({ seq, type, merged, summary }) => ({ seq, type, merged, summary }))).toEqual(rows);
    expect(view.shellEvents.some((e) => e.type === "chunk" && (e.kind === "text" || e.kind === "thinking"))).toBe(false);
    expect(view.shellEvents.some((e) => e.type === "chunk" && e.kind === "tool_call")).toBe(true);
    expect(view.notices.map((r) => r.type)).toEqual(["attention-raised"]);
    expect(view.shellCount).toBe(view.shellEvents.length);
  });

  test("an appended text chunk does not rebuild the shell or copy the turn", () => {
    const { path, events } = writeLog(body);
    const cache = new RunViewCache();
    const first = cache.fold(path);
    const turn = first.turns[0]!;
    const shellCount = first.shellCount;
    const extra = stamped([{ type: "chunk", node: "doc.draft", visit: 1, turn: 1, index: 5, kind: "text", content: " more" }])[0]!;
    extra.seq = events.length + 1;
    appendFileSync(path, JSON.stringify(extra) + "\n");
    const second = cache.fold(path);
    expect(second.shellCount).toBe(shellCount);
    expect(second.turns[0]).toBe(turn);
    expect(turn.parts.map((p) => p.content).join("")).toContain("more");
    expect(second.lastSeq).toBe(extra.seq);
  });

  test("a shrunk log is refolded from zero", () => {
    const { path } = writeLog(body);
    const cache = new RunViewCache();
    cache.fold(path);
    const shorter = writeLog(body.slice(0, 3));
    writeFileSync(path, shorter.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const view = cache.fold(path);
    expect(view.turns).toEqual(coalesce(shorter.events));
    expect(view.turns[0]!.parts.map((p) => p.content).join("")).toBe("Hello ");
  });

  test("the transcript is a tail window and the log page omits the stored event", () => {
    const { path, events } = writeLog(body);
    const cache = new RunViewCache();
    const tail = cache.transcript(path, { limit: 1 });
    expect(tail.total).toBe(1);
    expect(tail.start).toBe(0);
    expect(tail.turns).toHaveLength(1);

    const page = cache.logs(path, { limit: 2 });
    expect(page.total).toBe(deriveLogRows(events).length);
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]).not.toHaveProperty("raw");
    expect(page.oldest).toBe(page.rows[0]!.seq);
    const earlier = cache.logs(path, { limit: 2, before: page.oldest! });
    expect(earlier.rows.every((r) => r.seq < page.oldest!)).toBe(true);

    const raw = cache.event(path, page.oldest!);
    expect(raw?.seq).toBe(page.oldest ?? undefined);
    expect(cache.event(path, 999999)).toBeNull();
  });

  test("applyLiveEvent folds a chunk into a copy and leaves the previous window alone", () => {
    const events = stamped(body);
    const turns = coalesce(events);
    const before = turns[0]!.parts.map((p) => p.content).join("");
    const extra = stamped([{ type: "chunk", node: "doc.draft", visit: 1, turn: 1, index: 5, kind: "text", content: " more" }])[0]!;
    const next = applyLiveEvent(turns, extra);
    expect(turns[0]!.parts.map((p) => p.content).join("")).toBe(before);
    expect(next[0]!.parts.map((p) => p.content).join("")).toContain("more");
    expect(applyLiveEvent(turns, events[0]!).length).toBe(turns.length);
  });
});
