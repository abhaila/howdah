#!/usr/bin/env bun
/**
 * A fake `codex app-server` for executor tests: newline-delimited JSON-RPC over stdio,
 * the same request shapes codex.ts sends (initialize → thread/start → turn/start), without
 * spending tokens. On turn/start it replies, streams one agent message carrying the
 * outputs contract it was asked for, and completes the turn.
 *
 * FAKE_CAPTURE=<file> appends the exact prompt text received in turn/start (one JSON
 * string per line) so tests can prove rendered_hash covers the bytes sent (system-map 0.1).
 */
import { appendFileSync } from "node:fs";

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");

const decoder = new TextDecoder();
let buffer = "";

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
        out({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "fake-thread-1" } } });
        break;
      case "turn/start": {
        const promptText = String(msg.params?.input?.[0]?.text ?? "");
        if (process.env.FAKE_CAPTURE) appendFileSync(process.env.FAKE_CAPTURE, JSON.stringify(promptText) + "\n");
        out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: "fake-turn-1" } } });
        const keys = [...promptText.matchAll(/"(\w+)": <value>/g)].map((m) => m[1]!);
        const outputs = Object.fromEntries(keys.map((k) => [k, k === "review_verdict" ? (process.env.FAKE_CLAUDE_VERDICT ?? "pass") : `fake ${k}`]));
        const text = `All done.\n{"outputs": ${JSON.stringify(outputs)}}`;
        out({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: text } });
        out({ jsonrpc: "2.0", method: "item/completed", params: { item: { type: "agentMessage", text } } });
        out({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "fake-turn-1", status: "completed" } } });
        break;
      }
    }
  }
}
