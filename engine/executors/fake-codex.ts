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
 * FAKE_CODEX_NOTICE=1 also emits an error NOTIFICATION before the message — codex's startup
 * noise, which must not stop the repair.
 * FAKE_CODEX_RPC_FAULT=1 also answers turn/start with an error RESPONSE while still
 * completing the turn — the app-server refused us, so no repair should be asked for.
 * FAKE_CODEX_CONTEXT (HOW-14), shapes from the 0.154.0 generated schema, not a captured turn:
 *   compact  a `contextCompaction` item before the message; the turn completes normally
 *   exceed   an `error` notification + `turn/completed { status: "failed" }`, both carrying
 *            codexErrorInfo "contextWindowExceeded"
 * FAKE_CODEX_FAIL=1 completes the turn with status "failed" and an ordinary error — the case
 * that used to be reported as an output contract violation.
 * Server→client REQUESTS, raised on the first turn and held until the executor answers on the
 * id, which is the shape of the live ten-hour hang (adapter/fixtures/codex-elicitation.jsonl):
 *   FAKE_CODEX_ELICIT=1           an mcpToolCall item, then `mcpServer/elicitation/request`
 *                                 (FAKE_CODEX_ELICIT_MODE overrides `url`); the tool item
 *                                 completes or fails on the action, and the final text names it
 *   FAKE_CODEX_ASK=1              `item/tool/requestUserInput` with one two-option question
 *                                 (0.162.1 schema); the final text carries the answers received
 *   FAKE_CODEX_UNKNOWN_REQUEST=1  `account/chatgptAuthTokens/refresh`, a kind howdah does not
 *                                 model; the final text says whether it was answered or refused
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const threadCapture = process.env.FAKE_CODEX_CAPTURE;

const decoder = new TextDecoder();
let buffer = "";
let turns = 0;
/** a server→client request this fake raised and has not been answered yet (see below) */
let pendingRequest: { id: number; kind: "elicit" | "ask" | "unknown"; turnId: string; promptText: string } | null = null;

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line) as { id?: number; method?: string; params?: any; result?: any; error?: any };
    // the executor's answer to a request this fake raised: finish the turn and SAY what came back
    if (msg.method === undefined && msg.id !== undefined && pendingRequest && msg.id === pendingRequest.id) {
      const { kind, turnId, promptText } = pendingRequest;
      pendingRequest = null;
      let note: string;
      if (kind === "elicit") {
        const action = String(msg.result?.action ?? (msg.error ? "error" : "none"));
        out({ jsonrpc: "2.0", method: "item/completed", params: { item: { type: "mcpToolCall", id: "mcp1", server: "codex_apps", tool: "linear.get_issue", status: action === "accept" ? "completed" : "failed", error: action === "accept" ? null : { message: "Reconnect Linear on ChatGPT to restore access for this request." } } } });
        note = `[fake: elicitation ${action}] `;
      } else if (kind === "ask") {
        note = msg.error ? `[fake: question refused: ${msg.error.message}] ` : `[fake: answered ${JSON.stringify(msg.result?.answers ?? null)}] `;
      } else {
        note = msg.error ? `[fake: token refresh refused: ${msg.error.message}] ` : "[fake: token refresh answered] ";
      }
      finishTurn(turnId, promptText, note);
      continue;
    }
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
        if (process.env.FAKE_CODEX_RPC_FAULT === "1") out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "fake app-server fault" } });
        else out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: turnId } } });
        if (process.env.FAKE_CODEX_NOTICE === "1")
          out({ jsonrpc: "2.0", method: "error", params: { message: "MCP server auth expired" } });
        // HOW-36: exceed-once (FAKE_CODEX_CONTEXT_STATE remembers it across spawns), and
        // FAKE_CODEX_EXCEED_TOOLS=1 runs a command and changes a file before the window fills
        const state = process.env.FAKE_CODEX_CONTEXT_STATE;
        const exceedOnce = process.env.FAKE_CODEX_CONTEXT === "exceed-once" && state !== undefined && !existsSync(state);
        if (exceedOnce) writeFileSync(state!, "exceeded");
        if ((process.env.FAKE_CODEX_CONTEXT === "exceed" || exceedOnce) && process.env.FAKE_CODEX_EXCEED_TOOLS === "1") {
          out({ jsonrpc: "2.0", method: "item/started", params: { item: { type: "commandExecution", id: "cx1", command: "bash -lc 'cargo test parser'" } } });
          out({ jsonrpc: "2.0", method: "item/completed", params: { item: { type: "commandExecution", id: "cx1", status: "failed", aggregatedOutput: "test parser ... FAILED" } } });
          out({ jsonrpc: "2.0", method: "item/started", params: { item: { type: "fileChange", id: "fc1", changes: [{ path: "src/parser.rs", kind: "update" }] } } });
          out({ jsonrpc: "2.0", method: "item/completed", params: { item: { type: "fileChange", id: "fc1", status: "completed" } } });
        }
        if (process.env.FAKE_CODEX_CONTEXT === "exceed" || exceedOnce || process.env.FAKE_CODEX_FAIL === "1") {
          const error = process.env.FAKE_CODEX_FAIL === "1" && !exceedOnce
            ? { message: "stream disconnected before completion", codexErrorInfo: "responseStreamDisconnected" }
            : { message: "Codex ran out of room in the model's context window.", codexErrorInfo: "contextWindowExceeded" };
          if (process.env.FAKE_CODEX_CONTEXT === "exceed" || exceedOnce) out({ jsonrpc: "2.0", method: "error", params: { error, willRetry: false, threadId: "fake-thread-1", turnId } });
          out({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "fake-thread-1", turn: { id: turnId, status: "failed", error } } });
          break;
        }
        // the three server→client REQUESTS (first turn only; the repair turn never asks). Each
        // holds the turn until the executor answers on the id — exactly the live hang
        const request = process.env.FAKE_CODEX_ELICIT === "1" ? "elicit"
          : process.env.FAKE_CODEX_ASK === "1" ? "ask"
          : process.env.FAKE_CODEX_UNKNOWN_REQUEST === "1" ? "unknown" : null;
        if (request && turns === 1) {
          pendingRequest = { id: 7, kind: request, turnId, promptText };
          if (request === "elicit") {
            out({ jsonrpc: "2.0", method: "item/started", params: { item: { type: "mcpToolCall", id: "mcp1", server: "codex_apps", tool: "linear.get_issue", status: "inProgress", arguments: { id: "BADGE-1" } } } });
            out({ jsonrpc: "2.0", method: "thread/status/changed", params: { threadId: "fake-thread-1", status: { type: "active", activeFlags: ["waitingOnApproval"] } } });
            out({ jsonrpc: "2.0", id: 7, method: "mcpServer/elicitation/request", params: {
              threadId: "fake-thread-1", turnId, serverName: "codex_apps", mode: process.env.FAKE_CODEX_ELICIT_MODE ?? "url",
              message: "Reconnect Linear on ChatGPT to restore access for this request.", url: "https://chatgpt.com/apps/linear/fake", elicitationId: "codex_apps_auth_mcp1",
            } });
          } else if (request === "ask") {
            out({ jsonrpc: "2.0", id: 7, method: "item/tool/requestUserInput", params: {
              threadId: "fake-thread-1", turnId, itemId: "ask1", isBlocking: true,
              questions: [{ id: "colour", header: "Colour", question: "Which colour?", isOther: false, isSecret: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }],
            } });
          } else {
            out({ jsonrpc: "2.0", id: 7, method: "account/chatgptAuthTokens/refresh", params: { reason: "expired", previousAccountId: null } });
          }
          break;
        }
        finishTurn(turnId, promptText);
        break;
      }
    }
  }
}

/** the agent's final message — carrying the outputs contract it was asked for — and the turn's end */
function finishTurn(turnId: string, promptText: string, note = ""): void {
  if (process.env.FAKE_CODEX_CONTEXT === "compact")
    out({ jsonrpc: "2.0", method: "item/started", params: { item: { type: "contextCompaction", id: "compact-1" } } });
  const keys = [...promptText.matchAll(/"([\w.]+)": <value>/g)].map((m) => m[1]!);
  const outputs = Object.fromEntries(keys.map((k) => [k, k === "review_verdict" ? (process.env.FAKE_CLAUDE_VERDICT ?? "pass") : `fake ${k}`]));
  const isRepair = /did not end with the required outputs object/.test(promptText);
  const drop = process.env.FAKE_CODEX_DROP_OUTPUTS === "1" && !isRepair;
  const text = drop
    ? `${note}Verified the shared renderer and the affected integration cases. No files modified.`
    : `${note}All done.\n{"outputs": ${JSON.stringify(outputs)}}`;
  out({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: text } });
  out({ jsonrpc: "2.0", method: "item/completed", params: { item: { type: "agentMessage", text } } });
  // HOW-34: codex reports THREAD totals (cachedInputTokens included in inputTokens), so a
  // repair turn's figures are the running total — the executor records the delta
  out({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: "fake-thread-1", tokenUsage: { total: { inputTokens: 500 * turns, cachedInputTokens: 300 * turns, outputTokens: 40 * turns } } } });
  out({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: turnId, status: "completed" } } });
}
