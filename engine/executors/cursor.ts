/**
 * Cursor executor (HOW-17): runs a node's rendered prompt through the real `cursor-agent`
 * CLI on the operator's own subscription — the third harness beside claude and codex, and
 * the last hop of the fallback chain when both of those are out of allowance.
 *
 *   cursor-agent -p --output-format stream-json [--model M] [--resume CHAT] [--force] PROMPT
 *
 * One spawn per attempt. Streaming records land in the run log as durable chunks (T6), the
 * same as every other harness, because they arrive as AgentEvents (adapter/cursor.ts).
 *
 * The prompt is sent UNCHANGED: the engine assembled the outputs contract and every other
 * suffix, and hashed the result, before this executor ever saw it (system-map 0.1).
 * Appending anything here would put bytes outside rendered_hash.
 *
 * Two differences from the claude executor, both forced by cursor's print mode:
 *
 *   - There is no approval round-trip on the wire. Cursor decides approvals from a
 *     SPAWN-TIME flag, so the permission mode is mapped to flags by cursorApprovalMode()
 *     instead of being answered turn by turn through attention. A `plan` node therefore
 *     never gets the auto-approve flag — that is how D6/5A survives a fallback to cursor.
 *   - Print mode ends the process at the end of the turn, so the one in-session repair turn
 *     (outputs.ts buildRepairInstruction, same key list) is a SECOND spawn that
 *     `--resume`s the chat id from the first. It is the same chat, so the work is still
 *     there; like the other harnesses' repair turns it sits outside rendered_hash by design.
 *
 * stderr goes to a file in the run dir, never the UI, and the process's own exit code is
 * read and classified (harness-failure.ts) so a logged-out CLI is reported as a login
 * problem rather than blamed on the model.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Executor } from "../run";
import { JsonlChunkParser } from "../../adapter/parse";
import { cursorArgs, mapCursorEvent } from "../../adapter/cursor";
import { buildRepairInstruction, parseOutputs } from "./outputs";
import { classifyHarnessExit } from "./harness-failure";
import { harnessSpec } from "../../core/harnesses";
import { effectiveCwd } from "./worktree";
import { killGroup } from "./shell";
import { ToolWatch, TurnCeiling, stuckReason, turnTimeoutReason, type StuckThresholds } from "./stuck";

export interface CursorExecutorOpts {
  binary?: string; // overridable for tests (fake-cursor fixture)
  model?: string;
  /**
   * the read-only variant (engine/executors/index.ts): the node runs as if in plan mode
   * whatever the resolved config says. Belt and braces around the same rule
   * resolveAgentConfig already enforces, exactly like codexExecutor's read-only sandbox.
   */
  readOnly?: boolean;
  /** HOW-38: config.json `stuck` thresholds */
  stuck?: StuckThresholds;
}

/**
 * Cursor's equivalent of codexSandbox: the resolved permission mode as cursor approval
 * FLAGS. Cursor has no permission modes, only "may the agent act without asking".
 *
 *   plan     a readOnly node (system-map 1a, D6/5A) — resolveAgentConfig forces this mode
 *            over every override AND over the fallback, so it must never auto-approve
 *   manual   the operator asked to be asked, and print mode has nobody to ask: also no flag
 *   others   act (--force), which is what an autonomous Howdah node is for
 *
 * Without the flag cursor refuses the actions it would have asked about, so a plan node
 * reads and reports rather than writing — the constraint survives the hop to cursor.
 */
export function cursorApprovalMode(permissionMode: string | undefined): string[] {
  if (permissionMode === "plan" || permissionMode === "manual") return [];
  return ["--force"];
}

export function cursorExecutor(opts: CursorExecutorOpts = {}): Executor {
  return async ({ nodeId, def, visit, cwd, log, renderedPrompt, agentConfig }) => {
    if (def.kind !== "agent") throw new Error("cursorExecutor on non-agent node");
    const writeKeys = Object.keys(def.writes ?? {});
    const prompt = renderedPrompt ?? ""; // exactly what rendered_hash covers (system-map 0.1)
    const binary = opts.binary ?? harnessSpec("cursor").binary;
    const permissionMode = opts.readOnly ? "plan" : agentConfig?.permissionMode;
    const approvalFlags = cursorApprovalMode(permissionMode);
    const workdir = effectiveCwd(log.path, cwd) ?? dirname(log.path);

    let index = 0;
    let turnNo = 1; // HOW-34: the outputs-repair spawn is turn 2
    const chunk = (kind: "text" | "thinking" | "tool_call" | "tool_result", content: string, tool?: { id?: string; name?: string; input_hash?: string; is_error?: boolean }) =>
      log.append({
        type: "chunk", node: nodeId, visit, turn: turnNo, index: index++, kind, content, tool_id: tool?.id, tool_name: tool?.name,
        ...(tool?.input_hash !== undefined ? { input_hash: tool.input_hash } : {}),
        ...(tool?.is_error !== undefined ? { is_error: tool.is_error } : {}),
      });
    // HOW-38: stuck detection (warn + stop, no mid-turn channel) and the ceiling, across both spawns
    const watch = new ToolWatch({ harness: "cursor", log, node: nodeId, visit, thresholds: opts.stuck, note: (t) => chunk("text", t), enabled: agentConfig?.stuckDetection !== false });
    let livePid: number | undefined;
    const ceiling = new TurnCeiling(agentConfig?.turnTimeoutMs, () => { if (livePid !== undefined) killGroup(livePid); });

    const stderrChunks: string[] = [];
    let sessionId: string | undefined;
    let sawEvent = false; // did the CLI ever speak stream-json? a logged-out one never does

    /** one spawn = one turn; returns what the turn produced without judging it */
    const runTurn = async (text: string, resume?: string) => {
      const proc = Bun.spawn([binary, ...cursorArgs({ prompt: text, model: agentConfig?.model ?? opts.model, resume, approvalFlags })], {
        cwd: workdir,
        env: { ...process.env },
        stdin: "ignore", // the prompt is argv (adapter/cursor.ts cursorArgs), not stdin
        stdout: "pipe",
        stderr: "pipe",
        detached: true, // HOW-38: a stuck or timed-out turn ends the whole group
      });
      livePid = proc.pid;
      ceiling.start();
      const stderrDone = (async () => {
        for await (const c of proc.stderr) stderrChunks.push(new TextDecoder().decode(c));
      })();

      const parser = new JsonlChunkParser();
      let accumulated = "";
      let resultText: string | undefined;
      let turnError: string | undefined;
      let turnEnded = false;
      for await (const bytes of proc.stdout) {
        for (const record of parser.push(bytes)) {
          if (!record.ok) continue; // non-JSON noise is not fatal
          sawEvent = true;
          for (const ev of mapCursorEvent(record.value)) {
            switch (ev.type) {
              case "session_started":
                sessionId = ev.session_id;
                break;
              case "text_delta":
                accumulated += ev.text;
                chunk("text", ev.text);
                break;
              case "thinking_delta":
                chunk("thinking", ev.text);
                break;
              case "tool_call": {
                const summary = JSON.stringify(ev.input).slice(0, 400);
                chunk("tool_call", summary, { id: ev.id, name: ev.name, input_hash: watch.call(ev.id, ev.name, ev.input, summary) });
                break;
              }
              case "tool_result":
                chunk("tool_result", ev.content.slice(0, 400), { id: ev.id, ...(ev.is_error !== undefined ? { is_error: ev.is_error } : {}) });
                if (watch.result(ev.id, ev.is_error === true, ev.content)?.kind === "stop") killGroup(proc.pid);
                break;
              case "rate_limit":
                log.append({ type: "allowance", harness: "cursor", state: ev.state, remaining: ev.remaining, resets_at: ev.resets_at, raw: ev.raw });
                break;
              case "turn_end":
                log.append({ type: "turn-finalized", node: nodeId, visit, turn: turnNo, usage: ev.usage });
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
      }
      parser.flush();
      const exited = await proc.exited.catch(() => null);
      await stderrDone.catch(() => {});
      return { text: resultText ?? accumulated, turnError, turnEnded, exitCode: exited };
    };

    let turn = await runTurn(prompt);
    const interrupted = () => ceiling.fired || watch.stopped !== null;

    // One repair turn before giving up — the chat still holds the work, so asking for the
    // missing contract costs a short turn instead of re-running the whole node. It can only
    // be asked on a chat we know the id of: without one there is no session to resume, and
    // a fresh spawn would be a re-run of the node, not a repair.
    if (!interrupted() && turn.turnEnded && !turn.turnError && sessionId && writeKeys.length && !parseOutputs(turn.text, writeKeys).ok) {
      chunk("text", "\n[outputs object missing — asking for it]");
      turnNo = 2;
      turn = await runTurn(buildRepairInstruction(writeKeys), sessionId);
    }

    if (stderrChunks.length)
      writeFileSync(join(dirname(log.path), `cursor-${nodeId.replace(/[^\w.-]/g, "_")}-v${visit}.stderr.log`), stderrChunks.join(""));

    ceiling.clear();
    // HOW-38: WE ended it — before the startup check, whose exit reading would be ours
    if (ceiling.fired) {
      const reason = turnTimeoutReason(agentConfig!.turnTimeoutMs!);
      chunk("text", `\n[${reason}]`);
      return { status: "failed", writes: {}, reason, code: "turn-timeout" };
    }
    if (watch.stopped) {
      const reason = stuckReason(watch.stopped);
      chunk("text", `\n[${reason}]`);
      return { status: "failed", writes: {}, reason, code: "stuck" };
    }
    // a CLI that never spoke the protocol did not start: say WHY (usually "not logged in")
    // instead of falling through to an outputs complaint that blames the model
    const startup = classifyHarnessExit({ harness: binary, exitCode: turn.exitCode, stderr: stderrChunks.join(""), sawOutput: sawEvent });
    if (startup) {
      chunk("text", startup.note);
      return { status: "failed", writes: {}, reason: startup.reason, code: startup.code };
    }
    if (turn.turnError) {
      chunk("text", `\n[turn error: ${turn.turnError}]`);
      return { status: "failed", writes: {}, reason: `turn error: ${turn.turnError}` };
    }
    if (!turn.turnEnded) {
      chunk("text", "\n[turn error: cursor stream ended before a result]");
      return { status: "failed", writes: {}, reason: "turn error: cursor stream ended before a result" };
    }
    const parsed = parseOutputs(turn.text, writeKeys);
    if (!parsed.ok) {
      chunk("text", `\n[output contract violation: ${parsed.problem}]`);
      return { status: "failed", writes: {}, reason: `output contract violation: ${parsed.problem}` };
    }
    return { status: "succeeded", writes: parsed.writes };
  };
}
