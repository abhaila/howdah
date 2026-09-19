#!/usr/bin/env bun
/**
 * A fake `claude` binary for executor tests: speaks the stream-json wire protocol
 * (verified shapes from agent-deck spikes) without spending tokens. Reads the user turn
 * from stdin, streams deltas, optionally demands a permission (FAKE_CLAUDE_ASK=1) and
 * honours the control_response, then emits the outputs contract and a result event.
 *
 * FAKE_CAPTURE=<file> appends the exact prompt text of EVERY user turn received on stdin
 * (one JSON string per line, in order) so tests can prove rendered_hash covers the bytes
 * of the first turn (system-map 0.1); an in-session repair turn lands on a later line.
 * FAKE_CLAUDE_DROP_OUTPUTS=1 ends the first turn in prose with no contract.
 */
import { appendFileSync } from "node:fs";

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");

const decoder = new TextDecoder();
let buffer = "";
const lines: string[] = [];
let wake: () => void = () => {};

(async () => {
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      lines.push(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      wake();
    }
  }
})();

async function nextLine(): Promise<string> {
  for (;;) {
    const line = lines.shift();
    if (line !== undefined) return line;
    await new Promise<void>((r) => (wake = r));
  }
}

const userTurn = JSON.parse(await nextLine()) as { message: { content: Array<{ text: string }> } };
const promptText = userTurn.message.content[0]?.text ?? "";
if (process.env.FAKE_CAPTURE) appendFileSync(process.env.FAKE_CAPTURE, JSON.stringify(promptText) + "\n");

out({ type: "system", subtype: "init", session_id: "fake-session-0001" });
out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Working on it — " } } });
out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "doing the thing. 🐘" } } });

if (process.env.FAKE_CLAUDE_ASK === "1") {
  out({
    type: "control_request",
    request_id: "req-42",
    request: {
      subtype: "can_use_tool", tool_name: "Write", display_name: "Write",
      input: { file_path: "out.txt", content: "hi" },
      permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    },
  });
  // wait for the control_response before continuing — the real CLI blocks here too
  for (;;) {
    const line = JSON.parse(await nextLine()) as any;
    if (line.type === "control_response" && line.response?.request_id === "req-42") {
      const behavior = line.response?.response?.behavior;
      out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: behavior === "allow" ? " Permission granted, wrote the file." : " Denied, skipping the write." } } });
      break;
    }
  }
}

if (process.env.FAKE_CLAUDE_RATELIMIT === "1")
  out({ type: "rate_limit_event", rate_limit: { status: "allowed", remaining: 0.31, resetsAt: "2026-09-13T18:00:00Z" } });

// derive the demanded output keys from the appended contract so tests exercise parsing
function emitTurn(text: string): boolean {
  const keys = [...text.matchAll(/"(\w+)": <value>/g)].map((m) => m[1]!);
  const outputs = Object.fromEntries(keys.map((k) => [k, k === "review_verdict" ? (process.env.FAKE_CLAUDE_VERDICT ?? "pass") : `fake ${k}`]));
  const isRepair = /did not end with the required outputs object/.test(text);
  // FAKE_CLAUDE_DROP_OUTPUTS=1 reproduces the live failure: a long turn ending in prose with
  // no contract. The repair turn, which names itself, complies.
  const drop = process.env.FAKE_CLAUDE_DROP_OUTPUTS === "1" && !isRepair;
  out({
    type: "result", subtype: "success", is_error: false,
    usage: { input_tokens: 321, output_tokens: 45 }, total_cost_usd: 0.0042,
    result: drop
      ? "Verified the shared renderer and the affected integration cases. No files modified."
      : `All done.\n{"outputs": ${JSON.stringify(outputs)}}`,
  });
  return drop;
}

if (emitTurn(promptText)) {
  // the real CLI stays open for more stdin turns — answer the repair the same way
  const repair = JSON.parse(await nextLine()) as { message: { content: Array<{ text?: string }> } };
  const repairText = repair.message.content[0]?.text ?? "";
  if (process.env.FAKE_CAPTURE) appendFileSync(process.env.FAKE_CAPTURE, JSON.stringify(repairText) + "\n");
  emitTurn(repairText);
}
process.exit(0);

