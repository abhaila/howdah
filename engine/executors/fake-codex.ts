#!/usr/bin/env bun
/**
 * A fake `codex app-server` for executor tests: newline-delimited JSON-RPC over stdio,
 * the same request shapes codex.ts sends (initialize → thread/start → turn/start), without
 * spending tokens. On turn/start it replies, streams one agent message carrying the
 * outputs contract it was asked for, and completes the turn. The thread stays open, so a
 * second turn/start (the executor's in-session repair turn) is answered the same way.
 *
 * FAKE_CODEX_CAPTURE=<file> writes the thread/start params (sandbox, cwd, model) so tests
 * can assert how the thread was opened.
 * FAKE_CAPTURE=<file> appends the exact prompt text received in EVERY turn/start (one JSON
 * string per line, in order) so tests can prove rendered_hash covers the bytes of the
 * first turn (system-map 0.1); a repair turn lands on a later line.
 * FAKE_CODEX_DROP_OUTPUTS=1 reproduces the live failure: a turn that ends in prose with no
 * contract. The repair turn, which names itself, complies.
 */
import { appendFileSync, writeFileSync } from "node:fs";

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const threadCapture = process.env.FAKE_CODEX_CAPTURE;

const decoder = new TextDecoder();
let buffer = "";
let turns = 0;

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line) as { id?: number; method?: string; params?: any };
    switch (msg.method) {
      case "initialize":
        out({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "fake-codex" } });
        break;
      case "thread/start":
        if (threadCapture) writeFileSync(threadCapture, JSON.stringify(msg.params ?? {}, null, 2));
        out({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "fake-thread-1" } } });
        out({ jsonrpc: "2.0", method: "thread/started", params: { threadId: "fake-thread-1" } });
        break;
      case "turn/start": {
        const turnId = `fake-turn-${++turns}`;
        const promptText = String(msg.params?.input?.[0]?.text ?? "");
        if (process.env.FAKE_CAPTURE) appendFileSync(process.env.FAKE_CAPTURE, JSON.stringify(promptText) + "\n");
        out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: turnId } } });
        const keys = [...promptText.matchAll(/"([\w.]+)": <value>/g)].map((m) => m[1]!);
        const outputs = Object.fromEntries(keys.map((k) => [k, k === "review_verdict" ? (process.env.FAKE_CLAUDE_VERDICT ?? "pass") : `fake ${k}`]));
        const isRepair = /did not end with the required outputs object/.test(promptText);
        const drop = process.env.FAKE_CODEX_DROP_OUTPUTS === "1" && !isRepair;
        const text = drop
          ? "Verified the shared renderer and the affected integration cases. No files modified."
          : `All done.\n{"outputs": ${JSON.stringify(outputs)}}`;
        out({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: text } });
        out({ jsonrpc: "2.0", method: "item/completed", params: { item: { type: "agentMessage", text } } });
        out({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: turnId, status: "completed" } } });
        break;
      }
    }
  }
}
