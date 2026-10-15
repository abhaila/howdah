import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JsonlChunkParser, type JsonlRecord } from "./parse";
import { mapClaudeEvent, buildClaudePermissionResponse, buildClaudeUserTurn, claudeArgs, looksContextExceeded } from "./claude";
import { mapCodexEvent, buildCodexApprovalResponse, buildCodexElicitationResponse, buildCodexErrorResponse, buildCodexPermissionsResponse, buildCodexUserInputResponse } from "./codex";
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
/** HOW-34: a real two-turn claude 2.1.296 session (haiku), captured 2026-10-12 — cache fields present */
const cacheFixture = readFileSync(join(import.meta.dir, "fixtures", "claude-turn-cache.jsonl"));

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
      "session_started", "agent_env", "thinking_delta", "text_delta", "text_delta",
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
    expect((t as any).usage).toEqual({ input_tokens: 1200, output_tokens: 340, cost_usd: 0.0213, cost_source: "reported" });
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
    // HOW-47: the echo of a consumed stdin message is the proof a steer was delivered
    expect(args).toContain("--replay-user-messages");
  });
});

/**
 * HOW-47 — the steer spike, captured from claude 2.1.296: a stdin user message written while a
 * Bash call was in flight. Pinned here so an upgrade that changes WHERE it lands (or stops
 * echoing it) fails a test instead of silently breaking delivery proof.
 */
describe("claude steer wire (adapter/fixtures/claude-steer.jsonl)", () => {
  const steerFixture = readFileSync(join(import.meta.dir, "fixtures", "claude-steer.jsonl"));
  const events = replay(steerFixture, 64).flatMap((r) => (r.ok ? mapClaudeEvent(r.value) : []));
  const steerText = "[OPERATOR STEERING — from the human operator running this session, not from a tool] Change of plan: skip the remaining commands, and end your final reply with the single word PINEAPPLE.";

  test("the steer is echoed AFTER the in-flight tool's result, as its own message, in the same turn", () => {
    // (the fixture keeps no stream_event deltas: the capture dropped them to stay small)
    expect(events.filter((e) => e.type !== "rate_limit").map((e) => e.type)).toEqual([
      "session_started", "agent_env", "user_echo", "tool_call", "tool_result", "user_echo", "turn_end",
    ]);
    const call = events.findIndex((e) => e.type === "tool_call");
    const result = events.findIndex((e) => e.type === "tool_result");
    const echo = events.findIndex((e) => e.type === "user_echo" && e.text === steerText);
    expect(call).toBeGreaterThan(-1);
    expect(result).toBeGreaterThan(call);
    expect(echo).toBeGreaterThan(result); // delivered at the tool boundary, not inside the result
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(1); // no extra turn
  });

  test("the tool call was not lost, and the agent obeyed in the same turn", () => {
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ content: "one" });
    const end = events.find((e) => e.type === "turn_end");
    expect(end).toMatchObject({ result_text: expect.stringContaining("PINEAPPLE") });
  });

  test("the prompt's own echo is a user_echo too — the executor matches by exact text", () => {
    const echoes = events.filter((e) => e.type === "user_echo");
    expect(echoes).toHaveLength(2);
    expect((echoes[0] as { text: string }).text).toStartWith("Run these three shell commands");
  });

  test("a user message that is not a replay is not an echo", () => {
    expect(mapClaudeEvent({ type: "user", message: { content: [{ type: "text", text: "hi" }] } })).toEqual([]);
  });

  test("HOW-33: a resolved effort is sent as --effort, and none sends no flag", () => {
    const args = claudeArgs({ sessionId: "s1", effort: "high" });
    expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual(["--effort", "high"]);
    expect(claudeArgs({ sessionId: "s1" })).not.toContain("--effort");
  });
});

describe("HOW-34: claude usage against a captured turn with cache tokens", () => {
  const ends = replay(cacheFixture, 64).flatMap((r) => (r.ok ? mapClaudeEvent(r.value) : [])).filter((e) => e.type === "turn_end");

  test("all three input figures are recorded, separately", () => {
    expect(ends).toHaveLength(2);
    expect(ends[0]!.type === "turn_end" && ends[0]!.usage).toEqual({
      input_tokens: 2, cache_read_input_tokens: 10586, cache_creation_input_tokens: 20047, output_tokens: 3,
      cost_usd: 0.004116959999999999, cost_source: "reported",
    });
  });

  test("the captured cost is SESSION-CUMULATIVE while tokens are per turn — what the executor's delta relies on", () => {
    const [a, b] = ends.map((e) => (e.type === "turn_end" ? e.usage! : {}));
    expect(b!.cost_usd!).toBeGreaterThan(a!.cost_usd!);
    // turn 2 alone costs about what turn 1 did; the report is the running total
    expect(b!.cost_usd! - a!.cost_usd!).toBeCloseTo(0.00456, 4);
  });

  test("an old result with no cache fields maps them to absent (unknown), not 0", () => {
    const [end] = mapClaudeEvent({ type: "result", is_error: false, usage: { input_tokens: 5, output_tokens: 1 }, total_cost_usd: 0.1, result: "x" });
    expect(end?.type === "turn_end" && end.usage).toEqual({ input_tokens: 5, cache_read_input_tokens: undefined, cache_creation_input_tokens: undefined, output_tokens: 1, cost_usd: 0.1, cost_source: "reported" });
  });

  test("codex usage moves its cached share across and is unpriced, never 0", () => {
    const [end] = mapCodexEvent({ method: "turn/completed", params: { usage: { inputTokens: 900, cachedInputTokens: 600, outputTokens: 30 }, turn: { status: "completed" } } });
    expect(end?.type === "turn_end" && end.usage).toEqual({ input_tokens: 300, cache_read_input_tokens: 600, output_tokens: 30, cost_usd: null, cost_source: "unpriced" });
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

// Captured against codex 0.162.1 (the ChatGPT Linear connector asking to be reconnected —
// the request that held a live turn open for ten hours), plus the other request kinds the
// generated schema lists, read from the schema rather than captured.
describe("codex server requests are modelled or reported, never dropped", () => {
  const elicitFixture = readFileSync(join(import.meta.dir, "fixtures", "codex-elicitation.jsonl"));
  const events = replay(elicitFixture, 32).flatMap((r) => (r.ok ? mapCodexEvent(r.value) : []));

  test("an MCP tool item is a tool call, the elicitation is its own event, the failed item is an error result", () => {
    expect(events.map((e) => e.type)).toEqual(["tool_call", "elicitation", "tool_result", "turn_end"]);
    expect(events[0]).toMatchObject({ type: "tool_call", id: "exec-66a0fb7b-57a3-42eb-ae37-a4d4ab7f9268", name: "mcpToolCall" });
    expect(events[1]).toEqual({
      type: "elicitation", id: "0", server: "codex_apps", mode: "url",
      message: "Reconnect Linear on ChatGPT to restore access for this request.",
      url: "https://chatgpt.com/apps/linear/asdk_app_69a089a326dc8191b32a3f2553f5be2c",
    });
    expect(events[2]).toMatchObject({ type: "tool_result", id: "exec-66a0fb7b-57a3-42eb-ae37-a4d4ab7f9268", is_error: true });
    expect((events[2] as any).content).toContain("Reconnect Linear");
    expect(JSON.parse(buildCodexElicitationResponse(0, "decline"))).toEqual({ id: 0, result: { action: "decline" } });
  });

  test("every tool-shaped item with an id is shown; messages and reasoning are not", () => {
    for (const type of ["dynamicToolCall", "webSearch", "someFutureKind"])
      expect(mapCodexEvent({ method: "item/started", params: { item: { type, id: "x1" } } })).toEqual([{ type: "tool_call", id: "x1", name: type, input: { type, id: "x1" } }]);
    for (const type of ["agentMessage", "userMessage", "reasoning", "plan"])
      expect(mapCodexEvent({ method: "item/started", params: { item: { type, id: "m1", text: "hi" } } })).toEqual([]);
    // the output is read from whichever field the item kind uses
    expect(mapCodexEvent({ method: "item/completed", params: { item: { type: "dynamicToolCall", id: "x1", status: "completed", output: "42" } } })[0]).toMatchObject({ type: "tool_result", content: "42" });
    expect(mapCodexEvent({ method: "item/completed", params: { item: { type: "webSearch", id: "x2", status: "completed", result: { hits: 3 } } } })[0]).toMatchObject({ content: '{"hits":3}' });
  });

  test("request_user_input is a question for the operator in the shape core/ask.ts reads", () => {
    const [ev] = mapCodexEvent({ id: 3, method: "item/tool/requestUserInput", params: {
      itemId: "ask1", questions: [{ id: "colour", header: "Colour", question: "Which colour?", options: [{ label: "Red" }, { label: "Blue", description: "cool" }] }],
    } });
    expect(ev).toMatchObject({ type: "permission_request", id: "3", tool_name: "request_user_input", requires_user_interaction: true });
    const questions = normalizeAskPayload((ev as any).input);
    expect(questions).toEqual([{ id: "q0", header: "Colour", question: "Which colour?", multiSelect: false, options: [{ label: "Red" }, { label: "Blue", description: "cool" }] }]);
    expect(JSON.parse(buildCodexUserInputResponse(3, { colour: { answers: ["Blue"] } }))).toEqual({ id: 3, result: { answers: { colour: { answers: ["Blue"] } } } });
  });

  test("a permission-profile request is a permission whose answer is the profile granted, not a decision", () => {
    const [ev] = mapCodexEvent({ id: 4, method: "item/permissions/requestApproval", params: { itemId: "i", permissions: { network: { enabled: true } }, reason: "fetch deps" } });
    expect(ev).toMatchObject({ type: "permission_request", id: "4", tool_name: "permissions", input: { permissions: { network: { enabled: true } }, reason: "fetch deps" } });
    expect(JSON.parse(buildCodexPermissionsResponse(4, { network: { enabled: true } }))).toEqual({ id: 4, result: { permissions: { network: { enabled: true } }, scope: "turn" } });
    expect(JSON.parse(buildCodexPermissionsResponse(4, {}))).toEqual({ id: 4, result: { permissions: {}, scope: "turn" } });
    // the v1 names still in the schema answer with a decision, like the v2 item approvals
    expect(mapCodexEvent({ id: 5, method: "execCommandApproval", params: { command: ["ls"], cwd: "/x" } })[0]).toMatchObject({ type: "permission_request", tool_name: "execCommandApproval" });
    expect(mapCodexEvent({ id: 6, method: "applyPatchApproval", params: {} })[0]).toMatchObject({ type: "permission_request", tool_name: "applyPatchApproval" });
  });

  test("a request kind the adapter does not model is reported with its method, so the executor can refuse it", () => {
    expect(mapCodexEvent({ id: 9, method: "account/chatgptAuthTokens/refresh", params: { reason: "expired" } })).toEqual([{ type: "unsupported_request", id: "9", method: "account/chatgptAuthTokens/refresh" }]);
    expect(mapCodexEvent({ id: 10, method: "item/tool/call", params: {} })).toEqual([{ type: "unsupported_request", id: "10", method: "item/tool/call" }]);
    expect(JSON.parse(buildCodexErrorResponse(9, "howdah does not handle account/chatgptAuthTokens/refresh"))).toEqual({ id: 9, error: { code: -32601, message: "howdah does not handle account/chatgptAuthTokens/refresh" } });
    // a NOTIFICATION with an unknown method carries no id and is still nothing
    expect(mapCodexEvent({ method: "thread/status/changed", params: { status: { activeFlags: ["waitingOnApproval"] } } })).toEqual([]);
  });
});

// HOW-14: shapes read from claude 2.1.283's SDK types and codex 0.154.0's generated schema,
// not captured turns — the adapters say so in their headers
describe("context exhaustion and compaction (HOW-14)", () => {
  test("claude: compact_boundary maps to context_compacted with its trigger and size", () => {
    expect(mapClaudeEvent({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 167000, post_tokens: 9000 } }))
      .toEqual([{ type: "context_compacted", trigger: "auto", pre_tokens: 167000 }]);
    // metadata missing or garbled: still the fact, never a throw
    expect(mapClaudeEvent({ type: "system", subtype: "compact_boundary" })).toEqual([{ type: "context_compacted" }]);
    expect(mapClaudeEvent({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: 3, pre_tokens: "lots" } }))
      .toEqual([{ type: "context_compacted" }]);
  });

  test("claude: a 'Prompt is too long' error result is flagged context_exceeded; another error is not", () => {
    expect(mapClaudeEvent({ type: "result", subtype: "success", is_error: true, result: "Prompt is too long" }))
      .toEqual([expect.objectContaining({ type: "turn_end", error: "Prompt is too long", context_exceeded: true })]);
    const [plain] = mapClaudeEvent({ type: "result", subtype: "error_max_turns", is_error: true, result: "max turns" });
    expect(plain).not.toHaveProperty("context_exceeded");
    // a SUCCESSFUL result whose text merely mentions it is not an error at all
    const [ok] = mapClaudeEvent({ type: "result", subtype: "success", is_error: false, result: "Prompt is too long, so I trimmed it" });
    expect(ok).not.toHaveProperty("context_exceeded");
  });

  test("looksContextExceeded: the CLI's constant and narrow 'exceeds the context window' phrasings only", () => {
    for (const yes of ["Prompt is too long", "prompt is too long: 210000 tokens > 200000 maximum", "Input exceeds the context window of this model"])
      expect(looksContextExceeded(yes)).toBe(true);
    for (const no of ["max turns", "the context of this change is unclear", "the prompt was long but fine", "context window"])
      expect(looksContextExceeded(no)).toBe(false);
  });

  test("codex: a FAILED turn/completed carries its error; contextWindowExceeded also flags it", () => {
    const [failed] = mapCodexEvent({ method: "turn/completed", params: { turn: { id: "t", status: "failed", error: { message: "boom", codexErrorInfo: "other" } } } });
    expect(failed).toMatchObject({ type: "turn_end", error: "boom" });
    expect(failed).not.toHaveProperty("context_exceeded");
    const [full] = mapCodexEvent({ method: "turn/completed", params: { turn: { id: "t", status: "failed", error: { message: "no room", codexErrorInfo: "contextWindowExceeded" } } } });
    expect(full).toMatchObject({ type: "turn_end", error: "no room", context_exceeded: true });
    // a completed turn is still a plain turn_end, and a failed one with no error object still fails
    const [done] = mapCodexEvent({ method: "turn/completed", params: { turn: { id: "t", status: "completed" } } });
    expect(done).not.toHaveProperty("error");
    expect(mapCodexEvent({ method: "turn/completed", params: { turn: { status: "failed" } } })[0]).toMatchObject({ error: "codex turn failed" });
  });

  test("codex: an error notification naming contextWindowExceeded is flagged", () => {
    expect(mapCodexEvent({ method: "error", params: { error: { message: "no room", codexErrorInfo: "contextWindowExceeded" }, willRetry: false } }))
      .toEqual([{ type: "error", message: "no room", context_exceeded: true }]);
    expect(mapCodexEvent({ method: "error", params: { error: { message: "MCP auth expired" } } })).toEqual([{ type: "error", message: "MCP auth expired" }]);
  });

  test("codex: a contextCompaction item and the legacy thread/compacted both map to context_compacted", () => {
    expect(mapCodexEvent({ method: "item/started", params: { item: { type: "contextCompaction", id: "c1" } } })).toEqual([{ type: "context_compacted" }]);
    expect(mapCodexEvent({ method: "thread/compacted", params: { threadId: "x", turnId: "t" } })).toEqual([{ type: "context_compacted" }]);
    // completion of the compaction item is not a second compaction
    expect(mapCodexEvent({ method: "item/completed", params: { item: { type: "contextCompaction", id: "c1" } } })).toEqual([]);
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
    // the worktree is howdah's own: without this cursor-agent exits 1 on "Workspace Trust
    // Required" before saying anything, which is how a fallback visit died live
    expect(argv).toContain("--trust");
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
      .toEqual([{ type: "turn_end", result_text: 'done\n{"outputs": {}}', error: undefined, usage: { input_tokens: 5, output_tokens: undefined, cost_usd: null, cost_source: "unpriced" } }]);
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

/**
 * HOW-53 — plan mode, captured from claude 2.1.296. It is NOT a sandbox: `git diff` and Read run,
 * but an Edit (and the ExitPlanMode a plan-mode agent reaches for) arrive as ordinary
 * `can_use_tool` permission requests — to Howdah. So the executor's refusal of every permission
 * request on a read-only node is what makes `readOnly` real (engine/executors/claude.ts).
 */
describe("claude plan mode (adapter/fixtures/claude-plan-mode-*.jsonl)", () => {
  const load = (name: string) =>
    replay(readFileSync(join(import.meta.dir, "fixtures", name)), 64).flatMap((r) => (r.ok ? mapClaudeEvent(r.value) : []));

  test("a reviewer can still run git diff and read files", () => {
    const events = load("claude-plan-mode-review.jsonl");
    const calls = events.filter((e) => e.type === "tool_call").map((e) => (e as { name: string }).name);
    expect(calls.slice(0, 2)).toEqual(["Bash", "Read"]);
    const diff = events.find((e) => e.type === "tool_result");
    expect(diff).toMatchObject({ content: expect.stringContaining("1 file changed") });
  });

  test("ExitPlanMode is a permission request, not a no-op", () => {
    const asks = load("claude-plan-mode-review.jsonl").filter((e) => e.type === "permission_request");
    expect(asks.map((e) => (e as { tool_name: string }).tool_name)).toEqual(["ExitPlanMode"]);
  });

  test("an Edit is a permission request — the CLI does not refuse it itself", () => {
    const asks = load("claude-plan-mode-edit.jsonl").filter((e) => e.type === "permission_request");
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ tool_name: "Edit" });
    expect((asks[0] as { requires_user_interaction?: boolean }).requires_user_interaction).toBeUndefined();
  });
});

/** HOW-55 — the startup a session reports: hooks before init, then what init says it loaded */
describe("claude startup (adapter/fixtures/claude-init-*.jsonl)", () => {
  const load = (name: string) =>
    replay(readFileSync(join(import.meta.dir, "fixtures", name)), 128).flatMap((r) => (r.ok ? mapClaudeEvent(r.value) : []));

  test("with user settings: five SessionStart hooks ran BEFORE init, four injecting context", () => {
    const events = load("claude-init-user-settings.jsonl");
    const init = events.findIndex((e) => e.type === "agent_env");
    const hooks = events.filter((e) => e.type === "hook");
    expect(hooks.length).toBe(10); // 5 started + 5 responses
    expect(events.findLastIndex((e) => e.type === "hook")).toBeLessThan(init);
    expect(hooks.filter((h) => (h as { injected?: string }).injected)).toHaveLength(4);
  });

  test("init maps to session_started and agent_env, names only", () => {
    const events = load("claude-init-project-local.jsonl");
    expect(events.map((e) => e.type)).toEqual(["session_started", "agent_env"]);
    const env = events[1] as Extract<(typeof events)[number], { type: "agent_env" }>;
    expect(env).toMatchObject({ version: "2.1.296", permission_mode: "plan" });
    expect(env.skills).toHaveLength(19);
    expect(env.plugins.map((p) => p.source)).toEqual(["cc-plugin-agents-md@builtin", "cc-plugin-telemetry@builtin", "cc-plugin-plugin-authoring@builtin"]);
  });

  test("a malformed init degrades to empty lists rather than throwing", () => {
    const [, env] = mapClaudeEvent({ type: "system", subtype: "init", session_id: "s", tools: "nope", plugins: [null], skills: [1] });
    expect(env).toMatchObject({ type: "agent_env", tools: [], plugins: [], skills: [] }); // a number is not a skill name: dropped, not stringified
    // and an init that reports no skills list at all is UNKNOWN, not "no skills"
    expect(mapClaudeEvent({ type: "system", subtype: "init", session_id: "s" })[1]).not.toHaveProperty("skills");
  });
});
