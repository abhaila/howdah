import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JsonlChunkParser, type JsonlRecord } from "./parse";
import { mapClaudeEvent, buildClaudePermissionResponse, buildClaudeUserTurn, claudeArgs } from "./claude";
import { mapCodexEvent, buildCodexApprovalResponse } from "./codex";
import { mapOpencodeEvent } from "./opencode";
import { CAPABILITIES } from "./capabilities";
import type { AgentEvent } from "./events";

const claudeFixture = readFileSync(join(import.meta.dir, "fixtures", "claude-turn.jsonl"));
const codexFixture = readFileSync(join(import.meta.dir, "fixtures", "codex-turn.jsonl"));

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
    expect(Object.keys(CAPABILITIES).sort()).toEqual(["claude", "codex", "opencode"]);
    expect(CAPABILITIES.claude.permissions).toBe("yes");
    expect(CAPABILITIES.claude.steer).toBe("no");
    expect(CAPABILITIES.codex.native_review).toBe("yes");
    expect(CAPABILITIES.codex.live_diff).toBe("yes");
    // untested is a declared state, not a guess
    expect(CAPABILITIES.opencode.resume).toBe("untested");
  });
});
