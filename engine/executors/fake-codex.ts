#!/usr/bin/env bun
/**
 * Fake `codex app-server` for executor tests. It captures thread/start params and
 * emits the minimum JSON-RPC/notification sequence the executor expects.
 */
import { writeFileSync } from "node:fs";

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const capture = process.env.FAKE_CODEX_CAPTURE;

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
    if (req.method === "initialize") {
      out({ jsonrpc: "2.0", id: req.id, result: {} });
    } else if (req.method === "thread/start") {
      if (capture) writeFileSync(capture, JSON.stringify(req.params, null, 2));
      out({ jsonrpc: "2.0", id: req.id, result: { threadId: "fake-thread" } });
      out({ method: "thread/started", params: { threadId: "fake-thread" } });
    } else if (req.method === "turn/start") {
      const input = req.params.input as Array<{ text?: string }> | undefined;
      const promptText = input?.[0]?.text ?? "";
      const keys = [...promptText.matchAll(/"([\w.]+)": <value>/g)].map((m) => m[1]!);
      const outputs = Object.fromEntries(keys.map((k) => [k, k === "review_verdict" ? "pass" : `fake ${k}`]));
      const finalText = `All done.\n{"outputs": ${JSON.stringify(outputs)}}`;
      out({ jsonrpc: "2.0", id: req.id, result: {} });
      out({ method: "item/agentMessage/delta", params: { delta: "All done." } });
      out({ method: "item/completed", params: { item: { type: "agentMessage", text: finalText } } });
      out({ method: "turn/completed", params: { usage: { input_tokens: 1, output_tokens: 1 } } });
    }
  }
}
