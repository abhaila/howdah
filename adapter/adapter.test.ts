import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JsonlChunkParser, type JsonlRecord } from "./parse";
import { mapClaudeEvent, buildClaudePermissionResponse, buildClaudeUserTurn, claudeArgs } from "./claude";
import { mapCodexEvent, buildCodexApprovalResponse } from "./codex";
import { mapOpencodeEvent } from "./opencode";
import { mapCursorEvent, cursorArgs } from "./cursor";
import { harnessNames } from "../core/harnesses";
import { CAPABILITIES } from "./capabilities";
import { normalizeAskPayload } from "../core/ask";
import type { AgentEvent } from "./events";

const claudeFixture = readFileSync(join(import.meta.dir, "fixtures", "claude-turn.jsonl"));
/** HOW-25: a REAL AskUserQuestion round trip captured from claude 2.1.278 */
const askFixture = readFileSync(join(import.meta.dir, "fixtures", "claude-ask-user-question.jsonl"));
const codexFixture = readFileSync(join(import.meta.dir, "fixtures", "codex-turn.jsonl"));

describe("Claude argv", () => {
  test("defaults to auto permission mode", () => {
    expect(claudeArgs({ sessionId: "s" })).toEqual(expect.arrayContaining(["--permission-mode", "auto"]));
  });
});

/** run the whole fixture through a parser in slices of the given size */
function replay(bytes: Uint8Array, sliceSize: number): JsonlRecord[] {
  const parser = new JsonlChunkParser();
  const out: JsonlRecord[] = [];
  for (let i = 0; i < bytes.length; i += sliceSize) out.push(...parser.push(bytes.subarray(i, i + sliceSize)));
  out.push(...parser.flush());
  return out;
}

describe("JsonlChunkParser — chunk-boundary replay (CRITICAL)", () => {
  const wholeClaude = replay(claudeFixture, claudeFixture.length);

  test("fixture parses fully in one push", () => {
    expect(wholeClaude).toHaveLength(9);
    expect(wholeClaude.every((r) => r.ok)).toBe(true);
  });

  test.each([1, 2, 3, 5, 7, 13, 64, 1024])("byte-size %p slices yield identical records", (size) => {
    expect(replay(claudeFixture, size)).toEqual(wholeClaude);
  });

  test("seeded random split points yield identical records", () => {
    // deterministic LCG so failures reproduce
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 20; round++) {
      const parser = new JsonlChunkParser();
      const out: JsonlRecord[] = [];
      let i = 0;
      while (i < claudeFixture.length) {
        const n = 1 + Math.floor(rand() * 40);
        out.push(...parser.push(claudeFixture.subarray(i, i + n)));
        i += n;
      }
      out.push(...parser.flush());
      expect(out).toEqual(wholeClaude);
    }
  });

  test("a split INSIDE a multi-byte character does not corrupt text", () => {
    // the elephant emoji in line 4 is 4 bytes; slicing at 1 byte guarantees splitting it
    const records = replay(claudeFixture, 1);
    const events = records.flatMap((r) => (r.ok ? mapClaudeEvent(r.value) : []));
    const text = events.filter((e): e is Extract<AgentEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text).join("");
    expect(text).toBe("I will edit the file — voilà, naïve café 🐘🎯 done.");
  });

  test("torn final line is surfaced by flush, not lost or fatal", () => {
    const parser = new JsonlChunkParser();
    parser.push('{"type":"result"}\n{"type":"trunc');
    const tail = parser.flush();
    expect(tail).toEqual([{ ok: false, line: '{"type":"trunc', reason: "invalid-json" }]);
  });

  test("fuzz: random bytes never crash and always return (never hang)", () => {
    let seed = 1337;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 200; round++) {
      const parser = new JsonlChunkParser(4096);
      for (let c = 0; c < 20; c++) {
        const len = Math.floor(rand() * 512);
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = Math.floor(rand() * 256);
        expect(() => parser.push(bytes)).not.toThrow();
      }
      expect(() => parser.flush()).not.toThrow();
    }
  });

  test("a line that never ends is bounded, not buffered forever", () => {
    const parser = new JsonlChunkParser(1024);
    for (let i = 0; i < 100; i++) parser.push("x".repeat(1000)); // 100KB, no newline
    const records = parser.push('tail\n{"ok":1}\n');
    expect(records).toEqual([
      { ok: false, line: expect.stringMatching(/^x{256}$/), reason: "line-too-long" },
      { ok: true, value: { ok: 1 } },
    ]);
  });
});

describe("claude adapter mapping", () => {
  const events = replay(claudeFixture, 64).flatMap((r) => (r.ok ? mapClaudeEvent(r.value) : []));

  test("full fixture maps to the normalized sequence", () => {
    expect(events.map((e) => e.type)).toEqual([
      "session_started", "thinking_delta", "text_delta", "text_delta",
      "tool_call", "permission_request", "tool_result", "rate_limit", "turn_end",
    ]);
  });

  test("permission request carries id, tool, input, suggestions", () => {
    const p = events.find((e) => e.type === "permission_request")!;
    expect(p).toMatchObject({ id: "fd7ba295-1234", tool_name: "Write" });
    expect((p as any).suggestions).toHaveLength(1);
  });

  test("turn_end carries usage and cost", () => {
    const t = events.find((e) => e.type === "turn_end")!;
    expect((t as any).usage).toEqual({ input_tokens: 1200, output_tokens: 340, cost_usd: 0.0213 });
    expect((t as any).error).toBeUndefined();
  });

  test("error result surfaces the error", () => {
    const [t] = mapClaudeEvent({ type: "result", subtype: "error_max_turns", is_error: true, result: "max turns" });
    expect(t).toMatchObject({ type: "turn_end", error: "max turns" });
  });

  test("unknown event types are ignored, never fatal", () => {
    expect(mapClaudeEvent({ type: "totally_new_thing" })).toEqual([]);
    expect(mapClaudeEvent(null)).toEqual([]);
    expect(mapClaudeEvent("nope")).toEqual([]);
  });

  test("permission response + user turn wire shapes", () => {
    const resp = JSON.parse(buildClaudePermissionResponse("r1", { behavior: "allow", updatedInput: { a: 1 } }));
    expect(resp.response).toMatchObject({ subtype: "success", request_id: "r1", response: { behavior: "allow" } });
    const turn = JSON.parse(buildClaudeUserTurn("hello"));
    expect(turn.message.content[0]).toEqual({ type: "text", text: "hello" });
  });

  test("claudeArgs pins the load-bearing flags", () => {
    const args = claudeArgs({ sessionId: "s1" });
    expect(args).toContain("--permission-prompt-tool");
    expect(args).toContain("stdio");
    expect(args).toContain("--include-partial-messages");
    expect(claudeArgs({ sessionId: "s1", resume: true })).toContain("--resume");
  });
});

describe("codex adapter mapping", () => {
  const events = replay(codexFixture, 32).flatMap((r) => (r.ok ? mapCodexEvent(r.value) : []));

  test("full fixture maps to the normalized sequence", () => {
    expect(events.map((e) => e.type)).toEqual([
      "session_started", "text_delta", "tool_call", "permission_request",
      "tool_result", "rate_limit", "turn_end",
    ]);
  });

  test("approval request keeps the JSON-RPC id for the reply", () => {
    const p = events.find((e) => e.type === "permission_request")!;
    expect((p as any).id).toBe("7");
    expect((p as any).tool_name).toBe("commandExecution");
    const reply = JSON.parse(buildCodexApprovalResponse(7, "approved"));
    expect(reply).toEqual({ id: 7, result: { decision: "approved" } });
  });

  test("usedPercent 100 maps to exhausted with remaining 0", () => {
    const rl = events.find((e) => e.type === "rate_limit")!;
    expect(rl).toMatchObject({ state: "exhausted", remaining: 0 });
  });
});

describe("opencode adapter + capability matrix", () => {
  test("known shapes map; unknown ignored", () => {
    expect(mapOpencodeEvent({ type: "message.part.updated", properties: { part: { type: "text", text: "hi" } } }))
      .toEqual([{ type: "text_delta", text: "hi" }]);
    expect(mapOpencodeEvent({ type: "session.idle" })).toEqual([{ type: "turn_end" }]);
    expect(mapOpencodeEvent({ type: "mystery" })).toEqual([]);
  });

  test("matrix covers every harness and declares the claude/codex spike results", () => {
    // the matrix is total over the harness union by construction (HOW-17: adding cursor to
    // core/harnesses.ts made this file a compile error until its entry existed, which is the
    // point of keying it on Harness)
    expect(Object.keys(CAPABILITIES).sort()).toEqual([...harnessNames()].sort());
    expect(CAPABILITIES.claude.permissions).toBe("yes");
    expect(CAPABILITIES.claude.steer).toBe("no");
    expect(CAPABILITIES.codex.native_review).toBe("yes");
    expect(CAPABILITIES.codex.live_diff).toBe("yes");
    // untested is a declared state, not a guess
    expect(CAPABILITIES.opencode.resume).toBe("untested");
    // cursor-agent is not installed here, so nothing about it has been probed: its entries
    // say so rather than claiming support the viewer would then offer
    expect(CAPABILITIES.cursor.resume).toBe("untested");
    expect(CAPABILITIES.cursor.permissions).toBe("no"); // print mode has no wire round-trip
    // HOW-25: only claude has been seen to ask a human and take the answer back
    expect(CAPABILITIES.claude.user_questions).toBe("yes");
    expect(CAPABILITIES.codex.user_questions).toBe("no");
    expect(CAPABILITIES.cursor.user_questions).toBe("no");
    expect(CAPABILITIES.opencode.user_questions).toBe("untested");
  });
});

/**
 * HOW-25 — the ask-the-human round trip, pinned to a turn captured from the live CLI. What
 * matters here is that a question is DISTINGUISHABLE from an ordinary permission (the executor
 * routes on it) and that its payload survives the wire intact, including across chunk
 * boundaries: the same replay the claude fixture gets, because the failure it guards against
 * (a frame split mid-JSON) showed up as a permanent hang the last time it was not guarded.
 */
describe("Claude AskUserQuestion (HOW-25, captured fixture)", () => {
  const events = replay(askFixture, askFixture.length).flatMap((r) => (r.ok ? mapClaudeEvent(r.value) : []));
  const ask = events.find((e): e is Extract<AgentEvent, { type: "permission_request" }> => e.type === "permission_request");

  test("the question arrives as a permission request that DECLARES it needs a human", () => {
    expect(ask).toBeDefined();
    expect(ask!.tool_name).toBe("AskUserQuestion");
    expect(ask!.requires_user_interaction).toBe(true);
    expect(ask!.tool_use_id).toBe("toolu_01Fex9FavrujxeGMr5U8yMh9");
  });

  test("the questions themselves survive the mapping", () => {
    const qs = normalizeAskPayload(ask!.input);
    expect(qs).toHaveLength(1);
    expect(qs![0]!.question).toBe("Which approach should I take?");
    expect(qs![0]!.header).toBe("Approach");
    expect(qs![0]!.multiSelect).toBe(false);
    expect(qs![0]!.options.map((o) => o.label)).toEqual(["Approach A", "Approach B"]);
  });

  test("an ordinary permission is NOT read as a question", () => {
    const plain = mapClaudeEvent({
      type: "control_request",
      request_id: "r1",
      request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "a.txt" } },
    })[0] as Extract<AgentEvent, { type: "permission_request" }>;
    expect(plain.requires_user_interaction).toBeUndefined();
    expect(plain.tool_use_id).toBeUndefined();
    expect(normalizeAskPayload(plain.input)).toBeNull();
  });

  test("the captured answer reached the model as the tool result for that call", () => {
    // the fixture holds the real reply we sent (a deny `message`) coming back as a tool_result
    const result = events.find((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result");
    expect(result!.id).toBe("toolu_01Fex9FavrujxeGMr5U8yMh9"); // the call it answers
    expect(result!.content).toContain("The user answered:");
    expect(result!.content).toContain("Approach B");
    // and the model then acted on it, in the SAME turn — no second node-started
    const end = events.find((e): e is Extract<AgentEvent, { type: "turn_end" }> => e.type === "turn_end");
    expect(end!.result_text).toContain("Approach B");
  });

  test.each([1, 3, 7, 64, 4096])("byte-size %p slices carry the question intact", (size) => {
    const sliced = replay(askFixture, size).flatMap((r) => (r.ok ? mapClaudeEvent(r.value) : []));
    expect(sliced).toEqual(events);
  });
});

/**
 * Cursor (HOW-17). Unlike the claude and codex blocks above, these records are NOT captured
 * from a live CLI — cursor-agent is not installed here — so what is pinned is the mapper's
 * CONTRACT rather than the wire: the shapes the documented envelope allows are mapped, both
 * spellings of an id are accepted, and anything unrecognised is dropped rather than guessed
 * at. Replace the inputs with a real capture (adapter/fixtures/) once the CLI is available.
 */
describe("cursor adapter (shapes documented, not captured)", () => {
  test("argv is print mode + stream-json, with the prompt LAST", () => {
    const argv = cursorArgs({ prompt: "do the thing" });
    expect(argv.slice(0, 3)).toEqual(["-p", "--output-format", "stream-json"]);
    expect(argv.at(-1)).toBe("do the thing"); // positional: a piped prompt would arrive empty
    expect(argv).not.toContain("--force"); // approval flags are the caller's decision, never a default
    expect(argv).not.toContain("--model");
  });

  test("model, resume and approval flags ride only when given", () => {
    const argv = cursorArgs({ prompt: "p", model: "auto", resume: "chat-7", approvalFlags: ["--force"] });
    expect(argv.join(" ")).toContain("--model auto");
    expect(argv.join(" ")).toContain("--resume chat-7");
    expect(argv).toContain("--force");
    expect(argv.at(-1)).toBe("p");
  });

  test("the init record starts a session, under either spelling of the id", () => {
    expect(mapCursorEvent({ type: "system", subtype: "init", session_id: "c1" })).toEqual([{ type: "session_started", session_id: "c1" }]);
    expect(mapCursorEvent({ type: "system", subtype: "init", chatId: "c2" })).toEqual([{ type: "session_started", session_id: "c2" }]);
    // no id to resume is not an invented one
    expect(mapCursorEvent({ type: "system", subtype: "init" })).toEqual([]);
  });

  test("assistant records become text deltas, from content blocks or a bare string", () => {
    expect(mapCursorEvent({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi " }] } }))
      .toEqual([{ type: "text_delta", text: "hi " }]);
    expect(mapCursorEvent({ type: "assistant", message: "there" })).toEqual([{ type: "text_delta", text: "there" }]);
    expect(mapCursorEvent({ type: "assistant", message: { content: [] } })).toEqual([]); // nothing to say
  });

  test("tool calls come in pairs, and a failed one says so", () => {
    const started = mapCursorEvent({ type: "tool_call", subtype: "started", call_id: "t1", tool_call: { readToolCall: { args: { path: "a" } } } });
    expect(started[0]).toMatchObject({ type: "tool_call", id: "t1", name: "readToolCall" });
    const done = mapCursorEvent({ type: "tool_call", subtype: "completed", call_id: "t1", tool_call: { readToolCall: { result: "contents" } } });
    expect(done).toEqual([{ type: "tool_result", id: "t1", content: "contents", is_error: undefined }]);
    const failed = mapCursorEvent({ type: "tool_call", subtype: "failed", call_id: "t1", tool_call: { editToolCall: {} } });
    expect(failed[0]).toMatchObject({ type: "tool_result", is_error: true });
  });

  test("the result record ends the turn and carries the text the contract is read from", () => {
    expect(mapCursorEvent({ type: "result", subtype: "success", is_error: false, result: 'done\n{"outputs": {}}', usage: { input_tokens: 5 } }))
      .toEqual([{ type: "turn_end", result_text: 'done\n{"outputs": {}}', error: undefined, usage: { input_tokens: 5, output_tokens: undefined } }]);
    const bad = mapCursorEvent({ type: "result", subtype: "error", is_error: true, result: "it went wrong" });
    expect(bad[0]).toMatchObject({ type: "turn_end", error: "it went wrong" });
  });

  test("a failed result with NO words still carries an error — an empty one reads as no error", () => {
    // the executor's `if (turn.turnError)` is a truthiness check, so `error: ""` would fall
    // through to the outputs check and blame the model for a turn cursor said had failed
    for (const record of [
      { type: "result", subtype: "error", is_error: true },
      { type: "result", subtype: "error", is_error: true, result: "" },
      { type: "result", subtype: "success", is_error: true, result: { content: [] } },
    ]) {
      const [ev] = mapCursorEvent(record);
      expect(ev).toMatchObject({ type: "turn_end" });
      expect((ev as { error?: string }).error).toBe("cursor reported an error");
    }
    // an error RECORD with an empty message says the same rather than nothing
    expect(mapCursorEvent({ type: "error", message: "" })).toEqual([{ type: "error", message: "cursor error" }]);
    expect(mapCursorEvent({ type: "error", message: "", error: "real words" }))
      .toEqual([{ type: "error", message: "real words" }]);
  });

  test("unmapped record kinds are dropped, never guessed at", () => {
    expect(mapCursorEvent({ type: "mystery", text: "words" })).toEqual([]);
    expect(mapCursorEvent({ type: "tool_call", subtype: "unheard-of" })).toEqual([]);
    expect(mapCursorEvent(null)).toEqual([]);
    expect(mapCursorEvent("not an object")).toEqual([]);
  });
});
