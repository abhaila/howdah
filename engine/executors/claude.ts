/**
 * Claude executor (T16): runs a node's rendered prompt through the REAL `claude` CLI —
 * the user's logged-in subscription, no API key. One spawn per attempt:
 *
 *   claude -p --input-format stream-json --output-format stream-json
 *          --include-partial-messages --permission-prompt-tool stdio --session-id <uuid>
 *
 * Streaming events land in the run log as durable chunks (T6). A `can_use_tool` request
 * becomes a structured ask: attention is raised (durable + notified), the executor POLLS
 * THE RUN LOG for the attention-resolved reply (written by the web card or `howdah
 * reply`), and answers the CLI over stdin. The human's reply travels: browser → log →
 * this process → claude's stdin.
 *
 * Outputs: the node's declared writes are appended to the prompt as a JSON contract and
 * parsed from the final message (outputs.ts). stderr goes to a file in the run dir, never
 * the UI.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Executor } from "../run";
import { JsonlChunkParser } from "../../adapter/parse";
import { mapClaudeEvent, buildClaudePermissionResponse, buildClaudeUserTurn, claudeArgs } from "../../adapter/claude";
import { buildOutputInstruction, parseOutputs } from "./outputs";
import { AttentionCenter, osNotifier, type Notifier } from "../attention";
import { readLog } from "../../log/write";
import { effectiveCwd } from "./worktree";
import { isAllowReply } from "./reply";

export interface ClaudeExecutorOpts {
  attentionDir: string;
  binary?: string; // overridable for tests (fake-claude fixture)
  permissionMode?: string; // default acceptEdits — manual asks on every write otherwise
  model?: string;
  askPollMs?: number;
  notifiers?: Notifier[];
  viewerBase?: string;
}

export function claudeExecutor(opts: ClaudeExecutorOpts): Executor {
  return async ({ nodeId, def, visit, runId, cwd, log, renderedPrompt, agentConfig }) => {
    if (def.kind !== "agent") throw new Error("claudeExecutor on non-agent node");
    const writeKeys = Object.keys(def.writes ?? {});
    const skills = agentConfig?.skills ?? [];
    const skillHint = skills.length ? `\n\nRelevant installed skills for this task: ${skills.map((s) => `/${s}`).join(", ")} — invoke them where they apply.` : "";
    const prompt = (renderedPrompt ?? "") + skillHint + buildOutputInstruction(writeKeys);
    const sessionId = randomUUID();

    const proc = Bun.spawn(
      [opts.binary ?? "claude", ...claudeArgs({
        sessionId,
        permissionMode: agentConfig?.permissionMode ?? opts.permissionMode ?? "acceptEdits",
        model: agentConfig?.model ?? opts.model,
        maxTurns: agentConfig?.maxTurns,
      })],
      { cwd: effectiveCwd(log.path, cwd) ?? dirname(log.path), env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    proc.stdin.write(buildClaudeUserTurn(prompt));
    proc.stdin.flush();

    const stderrChunks: string[] = [];
    const stderrDone = (async () => {
      for await (const c of proc.stderr) stderrChunks.push(new TextDecoder().decode(c));
    })();

    const parser = new JsonlChunkParser();
    let index = 0;
    let accumulated = "";
    let resultText: string | undefined;
    let turnError: string | undefined;
    const chunk = (kind: "text" | "thinking" | "tool_call" | "tool_result", content: string, tool?: { id?: string; name?: string }) =>
      log.append({ type: "chunk", node: nodeId, visit, turn: 1, index: index++, kind, content, tool_id: tool?.id, tool_name: tool?.name });

    const answerPermission = async (requestId: string, toolName: string, input: unknown, suggestions?: unknown[]) => {
      const center = new AttentionCenter(opts.attentionDir, opts.notifiers ?? [osNotifier], { viewerBase: opts.viewerBase });
      const raised = log.append({
        type: "attention-raised", node: nodeId, visit,
        reason: `${toolName} needs permission`,
        ask: { kind: "can_use_tool", request_id: requestId, tool_name: toolName, input, suggestions },
      });
      await center.raise({ run: runId, node: nodeId, visit, reason: `${toolName} needs permission` }).catch(() => {});
      // the reply arrives in the log from the web card / CLI — poll for it, however long it takes
      for (;;) {
        await Bun.sleep(opts.askPollMs ?? 400);
        const resolved = readLog(log.path).find((e) => e.type === "attention-resolved" && e.seq > raised.seq);
        if (resolved && resolved.type === "attention-resolved") {
          const reply = (resolved.reply ?? "").trim();
          const allow = isAllowReply(reply);
          proc.stdin.write(
            buildClaudePermissionResponse(requestId, allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: reply }),
          );
          proc.stdin.flush();
          chunk("tool_result", allow ? `permission granted` : `permission denied: ${reply}`, { name: toolName });
          return;
        }
      }
    };

    let turnEnded = false;
    readLoop: for await (const bytes of proc.stdout) {
      for (const record of parser.push(bytes)) {
        if (!record.ok) continue; // non-JSON noise is not fatal
        for (const ev of mapClaudeEvent(record.value)) {
          switch (ev.type) {
            case "text_delta":
              accumulated += ev.text;
              chunk("text", ev.text);
              break;
            case "thinking_delta":
              chunk("thinking", ev.text);
              break;
            case "tool_call":
              chunk("tool_call", JSON.stringify(ev.input).slice(0, 400), { id: ev.id, name: ev.name });
              break;
            case "tool_result":
              chunk("tool_result", ev.content.slice(0, 400), { id: ev.id });
              break;
            case "permission_request":
              await answerPermission(ev.id, ev.tool_name, ev.input, ev.suggestions);
              break;
            case "rate_limit":
              log.append({ type: "allowance", harness: "claude", state: ev.state, remaining: ev.remaining, resets_at: ev.resets_at, raw: ev.raw });
              break;
            case "turn_end":
              log.append({ type: "turn-finalized", node: nodeId, visit, turn: 1, usage: ev.usage });
              resultText = ev.result_text ?? accumulated;
              turnError = ev.error;
              turnEnded = true;
              break;
            case "error":
              turnError = ev.message;
              break;
          }
        }
      }
      // the CLI stays open for more stdin turns; one attempt = one turn, so leave on result
      if (turnEnded) break readLoop;
    }
    parser.flush();
    try { proc.stdin.end(); } catch {}
    // grace, then make sure it is gone
    const exited = await Promise.race([proc.exited, Bun.sleep(3000).then(() => null)]);
    if (exited === null) proc.kill();
    await proc.exited.catch(() => {});
    await stderrDone.catch(() => {});
    if (stderrChunks.length)
      writeFileSync(join(dirname(log.path), `claude-${nodeId.replace(/[^\w.-]/g, "_")}-v${visit}.stderr.log`), stderrChunks.join(""));

    if (turnError) {
      chunk("text", `\n[turn error: ${turnError}]`);
      return { status: "failed", writes: {} };
    }
    const parsed = parseOutputs(resultText ?? accumulated, writeKeys);
    if (!parsed.ok) {
      chunk("text", `\n[output contract violation: ${parsed.problem}]`);
      return { status: "failed", writes: {} };
    }
    return { status: "succeeded", writes: parsed.writes };
  };
}
