#!/usr/bin/env bun
/**
 * A fake `cursor-agent` for executor tests (HOW-17): print mode, newline-delimited
 * stream-json on stdout, the prompt as the trailing positional argument — the wire the
 * cursor executor speaks, without spending tokens or needing the CLI installed.
 *
 * Unlike fake-claude.ts and fake-codex.ts, whose shapes were captured from live turns, this
 * one is written against the DOCUMENTED cursor-agent envelope (adapter/cursor.ts says so at
 * length). It therefore pins the executor's behaviour — argv, chunking, the repair turn, the
 * exit classification — and NOT that cursor-agent really talks this way. Re-capture and
 * replace it the day cursor-agent is installed.
 *
 * FAKE_CURSOR_CAPTURE=<file> writes the argv of EVERY spawn (one JSON array per line, in
 * order) so tests can assert the flag policy — in particular that a plan node never gets
 * --force — and that the repair turn resumed the first turn's chat rather than starting over.
 * FAKE_CAPTURE=<file> appends the exact prompt text of every spawn, so tests can prove
 * rendered_hash covers the bytes of the first turn (system-map 0.1).
 * FAKE_CURSOR_DROP_OUTPUTS=1 ends the first turn in prose with no contract; the repair turn,
 * which names itself, complies.
 */
import { appendFileSync } from "node:fs";

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");

const argv = process.argv.slice(2);
if (process.env.FAKE_CURSOR_CAPTURE) appendFileSync(process.env.FAKE_CURSOR_CAPTURE, JSON.stringify(argv) + "\n");

const promptText = argv[argv.length - 1] ?? "";
if (process.env.FAKE_CAPTURE) appendFileSync(process.env.FAKE_CAPTURE, JSON.stringify(promptText) + "\n");

out({ type: "system", subtype: "init", session_id: "fake-cursor-chat-1", model: "auto", permissionMode: "default" });
out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Working on it — " }] } });
out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "doing the thing. 🐘" }] } });
out({ type: "tool_call", subtype: "started", call_id: "call-1", tool_call: { readToolCall: { args: { path: "README.md" } } } });
out({ type: "tool_call", subtype: "completed", call_id: "call-1", tool_call: { readToolCall: { args: { path: "README.md" }, result: "ok" } } });

const keys = [...promptText.matchAll(/"([\w.]+)": <value>/g)].map((m) => m[1]!);
const outputs = Object.fromEntries(keys.map((k) => [k, k === "review_verdict" ? (process.env.FAKE_CLAUDE_VERDICT ?? "pass") : `fake ${k}`]));
const isRepair = /did not end with the required outputs object/.test(promptText);
const drop = process.env.FAKE_CURSOR_DROP_OUTPUTS === "1" && !isRepair;

out({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 12,
  usage: { input_tokens: 111, output_tokens: 22 },
  result: drop
    ? "Verified the shared renderer and the affected integration cases. No files modified."
    : `All done.\n{"outputs": ${JSON.stringify(outputs)}}`,
});
process.exit(0);
