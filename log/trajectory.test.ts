/**
 * HOW-35: the trajectory profile. A golden profile from each captured fixture (replayed into
 * chunks exactly as the executors log them), the edge cases the ticket names (no tool chunks
 * is no-data; exhaustion/pause/abort have their own termination; re-patches and verification
 * after the last edit are counted), and an old log without input_hash.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JsonlChunkParser } from "../adapter/parse";
import { mapClaudeEvent } from "../adapter/claude";
import { mapCodexEvent } from "../adapter/codex";
import { argumentsHash } from "../adapter/tools";
import type { AgentEvent } from "../adapter/events";
import { deriveProfile, deriveProfiles, describeProfile } from "./trajectory";
import type { LoggedEvent, RunEvent } from "./events";

const stamp = (events: RunEvent[]): LoggedEvent[] => events.map((e, i) => ({ ...e, seq: i + 1, ts: "2026-10-12T00:00:00.000Z" }) as LoggedEvent);
const rendered = (harness = "claude", node = "impl", visit = 1): RunEvent => ({
  type: "prompt-rendered", node, visit, prompt: "doc.draft", prompt_version: 1, rendered_hash: "h", context_read: {}, harness: harness as never,
});
const started = (node = "impl", visit = 1): RunEvent => ({ type: "node-started", node, visit, attempt_id: `${node}#${visit}` });
const finished = (status: "succeeded" | "failed", node = "impl", visit = 1): RunEvent => ({ type: "node-finished", node, visit, status, writes: {} });

/** the executors' chunk path: AgentEvents → chunk events, clipped and hashed the same way */
function chunksFrom(harness: string, agentEvents: AgentEvent[], node = "impl", visit = 1): RunEvent[] {
  let index = 0;
  const out: RunEvent[] = [];
  for (const ev of agentEvents) {
    if (ev.type === "tool_call")
      out.push({ type: "chunk", node, visit, turn: 1, index: index++, kind: "tool_call", content: JSON.stringify(ev.input).slice(0, 400), tool_id: ev.id, tool_name: ev.name, input_hash: argumentsHash(harness, ev.name, ev.input) });
    else if (ev.type === "tool_result")
      out.push({ type: "chunk", node, visit, turn: 1, index: index++, kind: "tool_result", content: ev.content.slice(0, 400), tool_id: ev.id, ...(ev.is_error !== undefined ? { is_error: ev.is_error } : {}) });
    else if (ev.type === "text_delta")
      out.push({ type: "chunk", node, visit, turn: 1, index: index++, kind: "text", content: ev.text });
  }
  return out;
}
const fixture = (name: string, map: (raw: unknown) => AgentEvent[]) => {
  const parser = new JsonlChunkParser();
  return parser.push(readFileSync(join(import.meta.dir, "..", "adapter", "fixtures", name))).flatMap((r) => (r.ok ? map(r.value) : []));
};

describe("golden profiles from captured turns", () => {
  test("claude-turn.jsonl: one Write, ended with an edit", () => {
    const events = stamp([started(), rendered("claude"), ...chunksFrom("claude", fixture("claude-turn.jsonl", mapClaudeEvent)), finished("succeeded")]);
    expect(deriveProfile(events, "impl", 1)).toEqual({
      status: "ok", node: "impl", visit: 1, harness: "claude", termination: "succeeded", turns: 1,
      calls: { inspect: 0, edit: 1, verify: 0, other: 0, unclassified: 0, total: 1 },
      ended_without_edit: false, repatch_count: 0, verify_after_last_edit: 0,
      longest_identical_streak: 1, streak_approximate: false,
      files_read: [], files_edited: ["touched.txt"], commands: [],
    });
  });

  test("codex-turn.jsonl: one `bun test`, verified, no edit", () => {
    const events = stamp([started(), rendered("codex"), ...chunksFrom("codex", fixture("codex-turn.jsonl", mapCodexEvent)), finished("succeeded")]);
    const p = deriveProfile(events, "impl", 1);
    expect(p).toMatchObject({
      status: "ok", harness: "codex", calls: { verify: 1, total: 1 }, ended_without_edit: true, verify_after_last_edit: null,
      commands: [{ command: "bun test", ok: null }],
    });
    expect(describeProfile(p)).toBe("0 inspect · 0 edit · 1 verify · ended without an edit");
  });
});

describe("the edge cases", () => {
  const call = (id: string, name: string, input: unknown, index: number): RunEvent => ({
    type: "chunk", node: "impl", visit: 1, turn: 1, index, kind: "tool_call", content: JSON.stringify(input), tool_id: id, tool_name: name, input_hash: argumentsHash("claude", name, input),
  });
  const result = (id: string, isError: boolean, index: number): RunEvent => ({ type: "chunk", node: "impl", visit: 1, turn: 1, index, kind: "tool_result", content: isError ? "1 fail" : "ok", tool_id: id, is_error: isError });

  test("re-patches, and verification AFTER the last edit — the paper's redundant-verification proxy", () => {
    const events = stamp([
      started(), rendered(),
      call("a", "Read", { file_path: "x.ts" }, 0),
      call("b", "Edit", { file_path: "x.ts", old_string: "1", new_string: "2" }, 1),
      call("c", "Bash", { command: "bun test" }, 2), result("c", true, 3),
      call("d", "Edit", { file_path: "x.ts", old_string: "2", new_string: "3" }, 4),
      call("e", "Bash", { command: "bun test" }, 5), result("e", false, 6),
      call("f", "Bash", { command: "bun test" }, 7), result("f", false, 8),
      call("g", "Bash", { command: "bun run check" }, 9), result("g", false, 10),
      finished("succeeded"),
    ]);
    expect(deriveProfile(events, "impl", 1)).toMatchObject({
      calls: { inspect: 1, edit: 2, verify: 4 }, repatch_count: 1, verify_after_last_edit: 3, longest_identical_streak: 2,
      files_read: ["x.ts"], files_edited: ["x.ts"],
      commands: [{ command: "bun test", ok: false }, { command: "bun test", ok: true }, { command: "bun test", ok: true }, { command: "bun run check", ok: true }],
    });
  });

  test("an old log with no tool chunks is no-data, not zeros", () => {
    const events = stamp([started(), rendered(), { type: "chunk", node: "impl", visit: 1, turn: 1, index: 0, kind: "text", content: "did it" }, finished("succeeded")]);
    expect(deriveProfile(events, "impl", 1)).toEqual({ status: "no-data", node: "impl", visit: 1, termination: "succeeded" });
    expect(deriveProfiles(events)).toHaveLength(1);
  });

  test("chunks without input_hash (pre-HOW-38) measure streaks on clipped content, marked approximate", () => {
    const events = stamp([started(), rendered(),
      { type: "chunk", node: "impl", visit: 1, turn: 1, index: 0, kind: "tool_call", content: '{"command":"ls"}', tool_id: "a", tool_name: "Bash" },
      { type: "chunk", node: "impl", visit: 1, turn: 1, index: 1, kind: "tool_call", content: '{"command":"ls"}', tool_id: "b", tool_name: "Bash" },
      finished("succeeded")]);
    expect(deriveProfile(events, "impl", 1)).toMatchObject({ longest_identical_streak: 2, streak_approximate: true, commands: [{ command: "ls", ok: null }, { command: "ls", ok: null }] });
  });

  const readOnly = [call("a", "Read", { file_path: "x.ts" }, 0)];
  test("context exhaustion is its own termination, never 'ended without an edit'", () => {
    const events = stamp([started(), rendered(), ...readOnly, finished("failed"), { type: "attention-raised", node: "impl", visit: 1, reason: "full", code: "context-exhausted" }]);
    expect(deriveProfile(events, "impl", 1)).toMatchObject({ termination: "context-exhausted", ended_without_edit: null });
  });

  test("a pause or an abort mid-attempt is its own termination", () => {
    const paused = stamp([started(), rendered(), ...readOnly, { type: "run-paused", by: "operator" }]);
    expect(deriveProfile(paused, "impl", 1)).toMatchObject({ termination: "paused", ended_without_edit: null });
    const aborted = stamp([started(), rendered(), ...readOnly, { type: "run-finished", outcome: "aborted" }]);
    expect(deriveProfile(aborted, "impl", 1)).toMatchObject({ termination: "aborted", ended_without_edit: null });
  });

  test("an ordinary failure that edited nothing DID end without an edit", () => {
    const events = stamp([started(), rendered(), ...readOnly, finished("failed"), { type: "attention-raised", node: "impl", visit: 1, reason: "x", code: "attempt-failed" }]);
    expect(deriveProfile(events, "impl", 1)).toMatchObject({ termination: "failed", ended_without_edit: true });
  });

  test("the run's own verify.result names the workspace command, so running it counts as verify", () => {
    const events = stamp([
      { type: "node-finished", node: "verify.run", visit: 1, status: "succeeded", writes: { "verify.result": { outcome: "pass", command: "./ci.sh", output_tail: "" } } },
      started(), rendered(), call("a", "Bash", { command: "./ci.sh --quick" }, 0), finished("succeeded"),
    ]);
    expect(deriveProfile(events, "impl", 1)).toMatchObject({ calls: { verify: 1 } });
  });
});
