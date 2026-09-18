/**
 * Codex executor (T16): one `codex app-server` child per attempt, JSON-RPC over stdio
 * (newline-delimited). Wire shapes verified against the generated v2 schema for the
 * installed CLI (0.154.0): initialize {clientInfo} → thread/start {cwd, approvalPolicy,
 * sandbox, model} → turn/start {threadId, input:[{type:"text",text}], effort?}.
 *
 * Approvals arrive as server→client REQUESTS (item/<kind>/requestApproval), answered
 * with {decision} on the same id — routed through the same attention round-trip as claude:
 * durable ask, human replies in the web card, executor answers the wire.
 *
 * PIN NOTE: the protocol is a moving target (S3-Q4). `howdah doctor` asserts the version.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Executor } from "../run";
import { JsonlChunkParser } from "../../adapter/parse";
import { mapCodexEvent, buildCodexApprovalResponse } from "../../adapter/codex";
import { buildOutputInstruction, buildRepairInstruction, parseOutputs } from "./outputs";
import { AttentionCenter, osNotifier, type Notifier } from "../attention";
import { readLog } from "../../log/write";
import { isAllowReply } from "./reply";
import { effectiveCwd } from "./worktree";

export interface CodexExecutorOpts {
  attentionDir: string;
  binary?: string;
  model?: string;
  effort?: string;
  sandbox?: string; // default danger-full-access: Howdah-owned Codex runs get full access
  askPollMs?: number;
  notifiers?: Notifier[];
  viewerBase?: string;
}

export function codexExecutor(opts: CodexExecutorOpts): Executor {
  return async ({ nodeId, def, visit, runId, cwd, log, renderedPrompt, agentConfig }) => {
    if (def.kind !== "agent") throw new Error("codexExecutor on non-agent node");
    const writeKeys = Object.keys(def.writes ?? {});
    const prompt = (renderedPrompt ?? "") + buildOutputInstruction(writeKeys);

    const proc = Bun.spawn([opts.binary ?? "codex", "app-server"], {
      cwd: effectiveCwd(log.path, cwd) ?? dirname(log.path),
      env: { ...process.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe", // verbose traces incl. full system prompts — file only, never UI
    });
    const stderrChunks: string[] = [];
    const stderrDone = (async () => {
      for await (const c of proc.stderr) stderrChunks.push(new TextDecoder().decode(c));
    })();

    let rpcId = 0;
    const pending = new Map<number, (result: any) => void>();
    const request = (method: string, params: unknown): Promise<any> => {
      const id = ++rpcId;
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      proc.stdin.flush();
      return new Promise((resolve) => pending.set(id, resolve));
    };

    let index = 0;
    let accumulated = "";
    let finalMessage: string | undefined;
    let turnDone: () => void = () => {}; // reassigned when the turn begins
    let usage: { input_tokens?: number; output_tokens?: number } | undefined;
    let turnError: string | undefined;
    let turnCompleted = false;
    const chunk = (kind: "text" | "thinking" | "tool_call" | "tool_result", content: string, tool?: { id?: string; name?: string }) =>
      log.append({ type: "chunk", node: nodeId, visit, turn: 1, index: index++, kind, content, tool_id: tool?.id, tool_name: tool?.name });

    const answerApproval = async (rpcRequestId: string | number, toolName: string, input: unknown) => {
      const center = new AttentionCenter(opts.attentionDir, opts.notifiers ?? [osNotifier], { viewerBase: opts.viewerBase });
      const raised = log.append({
        type: "attention-raised", node: nodeId, visit,
        reason: `${toolName} needs approval`,
        ask: { kind: "codex_approval", request_id: rpcRequestId, tool_name: toolName, input },
      });
      await center.raise({ run: runId, node: nodeId, visit, reason: `${toolName} needs approval` }).catch(() => {});
      for (;;) {
        await Bun.sleep(opts.askPollMs ?? 400);
        const resolved = readLog(log.path).find((e) => e.type === "attention-resolved" && e.seq > raised.seq);
        if (resolved && resolved.type === "attention-resolved") {
          const reply = (resolved.reply ?? "").trim();
          const allow = isAllowReply(reply);
          proc.stdin.write(buildCodexApprovalResponse(rpcRequestId, allow ? "approved" : "denied"));
          proc.stdin.flush();
          chunk("tool_result", allow ? "approval granted" : `approval denied: ${reply}`, { name: toolName });
          return;
        }
      }
    };

    const parser = new JsonlChunkParser();
    const pump = (async () => {
      for await (const bytes of proc.stdout) {
        for (const record of parser.push(bytes)) {
          if (!record.ok) continue;
          const raw = record.value as Record<string, any>;

          // RPC responses to our requests
          if (raw.id !== undefined && raw.method === undefined) {
            pending.get(Number(raw.id))?.(raw.result ?? raw.error);
            pending.delete(Number(raw.id));
            if (raw.error) turnError = String(raw.error.message ?? "codex rpc error");
            continue;
          }
          // capture the completed agent message for the outputs contract
          if (raw.method === "item/completed" && raw.params?.item?.type === "agentMessage")
            finalMessage = String(raw.params.item.text ?? "");
          if (raw.method === "thread/tokenUsage/updated") {
            const t = raw.params?.tokenUsage?.total;
            if (t) usage = { input_tokens: t.inputTokens ?? t.input_tokens, output_tokens: t.outputTokens ?? t.output_tokens };
          }
          if (raw.method === "turn/completed") { turnCompleted = true; turnDone(); }

          for (const ev of mapCodexEvent(raw)) {
            switch (ev.type) {
              case "text_delta":
                accumulated += ev.text;
                chunk("text", ev.text);
                break;
              case "tool_call":
                chunk("tool_call", JSON.stringify(ev.input).slice(0, 400), { id: ev.id, name: ev.name });
                break;
              case "tool_result":
                chunk("tool_result", ev.content.slice(0, 400), { id: ev.id });
                break;
              case "permission_request":
                await answerApproval(ev.id, ev.tool_name, ev.input);
                break;
              case "rate_limit":
                log.append({ type: "allowance", harness: "codex", state: ev.state, remaining: ev.remaining, resets_at: ev.resets_at, raw: ev.raw });
                break;
              case "error":
                // NOT fatal: codex emits error notifications for startup noise (expired
                // MCP server auth, observed live) and keeps working. Record it; the turn
                // fails only if it never completes.
                chunk("text", `\n[codex notice: ${ev.message}]`);
                turnError = ev.message;
                break;
            }
          }
        }
      }
      turnDone(); // stream closed
    })();

    try {
      await request("initialize", { clientInfo: { name: "howdah", version: "0.0.1" } });
      const thread = await request("thread/start", {
        cwd: effectiveCwd(log.path, cwd) ?? dirname(log.path),
        approvalPolicy: "on-request",
        sandbox: opts.sandbox ?? "danger-full-access",
        ...((agentConfig?.model ?? opts.model) ? { model: agentConfig?.model ?? opts.model } : {}),
      });
      const threadId = thread?.threadId ?? thread?.thread?.id;
      if (!threadId) throw new Error(`thread/start gave no threadId: ${JSON.stringify(thread).slice(0, 200)}`);

      const runTurn = async (text: string): Promise<void> => {
        const done = new Promise<void>((r) => (turnDone = r));
        await request("turn/start", {
          threadId,
          input: [{ type: "text", text }],
          ...((agentConfig?.effort ?? opts.effort) ? { effort: agentConfig?.effort ?? opts.effort } : {}),
        });
        await done;
      };

      await runTurn(prompt);

      // one repair turn on the SAME thread when the contract is missing — the work is
      // already done there, so this is far cheaper than parking and re-running the node
      if (turnCompleted && writeKeys.length && !parseOutputs(finalMessage ?? accumulated, writeKeys).ok) {
        chunk("text", "\n[outputs object missing — asking for it]");
        finalMessage = undefined;
        accumulated = "";
        await runTurn(buildRepairInstruction(writeKeys));
      }
    } finally {
      proc.kill();
      await proc.exited.catch(() => {});
      await pump.catch(() => {});
      await stderrDone.catch(() => {});
      if (stderrChunks.length)
        writeFileSync(join(dirname(log.path), `codex-${nodeId.replace(/[^\w.-]/g, "_")}-v${visit}.stderr.log`), stderrChunks.join(""));
    }

    log.append({ type: "turn-finalized", node: nodeId, visit, turn: 1, usage });
    if (!turnCompleted) {
      chunk("text", `\n[turn error: ${turnError ?? "app-server stream ended before turn/completed"}]`);
      return { status: "failed", writes: {} };
    }
    const parsed = parseOutputs(finalMessage ?? accumulated, writeKeys);
    if (!parsed.ok) {
      chunk("text", `\n[output contract violation: ${parsed.problem}]`);
      return { status: "failed", writes: {} };
    }
    return { status: "succeeded", writes: parsed.writes };
  };
}
