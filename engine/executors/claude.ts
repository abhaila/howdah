/**
 * Claude executor (T16): runs a node's rendered prompt through the REAL `claude` CLI —
 * the user's logged-in subscription, no API key. One spawn per attempt:
 *
 *   claude -p --input-format stream-json --output-format stream-json
 *          --include-partial-messages --permission-prompt-tool stdio
 *          --permission-mode auto --session-id <uuid>
 *
 * Streaming events land in the run log as durable chunks (T6). A `can_use_tool` request
 * becomes a structured ask: attention is raised (durable + notified), the executor POLLS
 * THE RUN LOG for the attention-resolved reply (written by the web card or `howdah
 * reply`), and answers the CLI over stdin. The human's reply travels: browser → log →
 * this process → claude's stdin.
 *
 * HOW-25 — two kinds of ask ride that one mechanism, and telling them apart is the whole
 * ticket. An ordinary permission is a yes/no. An AskUserQuestion is a QUESTION FOR THE
 * OPERATOR, flagged by the CLI as `requires_user_interaction`, and it used to freeze the run:
 * it parked as "AskUserQuestion needs permission", the card never drew the question, and
 * whatever was typed was collapsed to allow/deny, so an answer reached the model as
 * `permission denied: Option B`. Now the questions go INTO the park (core/ask.ts owns the
 * payload, the card draws it, the banner and the notification quote it) and the answer goes
 * back as the tool result on the same session, mid-turn.
 *
 * Nothing here waits forever without saying so. `awaitOperator` is the single wait, and it
 * ends in exactly one of: an answer, a harness that exited underneath it, or a configured
 * ceiling. The harness-exit guard fixed a latent hang on the permission path too — that loop
 * watched only the log, so a dead CLI spun for ever while the viewer said `running`.
 *
 * Outputs: the node's declared writes are parsed from the final message (outputs.ts).
 * The prompt already carries the skill hint and outputs contract — the engine assembles
 * and hashes them (system-map 0.1) — so it is sent UNCHANGED: appending anything here
 * would put bytes outside rendered_hash. This executor also serves `opencode` (index.ts).
 * If the final message lacks the contract, ONE repair turn (outputs.ts
 * buildRepairInstruction, same key list) is sent on the same session. It is a follow-up
 * user turn, not part of the first-turn prompt, so it sits outside rendered_hash by design.
 * stderr goes to a file in the run dir, never the UI.
 *
 * HOW-14: a turn that died because the context window filled fails with its own code,
 * `context-exhausted`, rather than `turn error: Prompt is too long` — the engine parks it
 * without hopping harnesses and briefs the retry to re-enter. A mid-turn compaction is only
 * a transcript note: the turn carries on and its outcome is decided as usual.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Executor } from "../run";
import { JsonlChunkParser } from "../../adapter/parse";
import { mapClaudeEvent, buildClaudePermissionResponse, buildClaudeUserTurn, claudeArgs } from "../../adapter/claude";
import { buildRepairInstruction, parseOutputs } from "./outputs";
import { classifyHarnessExit, compactionNote, contextExhaustedFailure } from "./harness-failure";
import { AttentionCenter, osNotifier, type Notifier } from "../attention";
import { readLog } from "../../log/write";
import { effectiveCwd } from "./worktree";
import { isAllowReply } from "./reply";
import {
  answersToReplyText, askReason, askResultMessage, normalizeAskPayload, parseFreeTextAnswer,
  validateAnswers, type UserQuestion,
} from "../../core/ask";

export interface ClaudeExecutorOpts {
  attentionDir: string;
  binary?: string; // overridable for tests (fake-claude fixture)
  permissionMode?: string; // default auto — full Claude Code autonomy without bypass mode
  model?: string;
  askPollMs?: number;
  /**
   * HOW-25: give up waiting for a human after this long. UNSET by default and meant to stay
   * that way — howdah's premise is that a park waits as long as the operator needs, and the
   * permission channel this ask rides on showed no deadline of its own when probed. It exists
   * so the guard is real and testable, and so a future CLI that DOES expire a question parks
   * with a stated reason instead of answering into a closed door.
   */
  askTimeoutMs?: number;
  notifiers?: Notifier[];
  viewerBase?: string;
}

export function claudeExecutor(opts: ClaudeExecutorOpts): Executor {
  return async ({ nodeId, def, visit, runId, cwd, log, renderedPrompt, agentConfig }) => {
    if (def.kind !== "agent") throw new Error("claudeExecutor on non-agent node");
    const writeKeys = Object.keys(def.writes ?? {});
    const prompt = renderedPrompt ?? ""; // exactly what rendered_hash covers (system-map 0.1)
    const sessionId = randomUUID();

    const proc = Bun.spawn(
      [opts.binary ?? "claude", ...claudeArgs({
        sessionId,
        permissionMode: agentConfig?.permissionMode ?? opts.permissionMode ?? "auto",
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
    let contextExceeded = false; // HOW-14: the adapter's verdict, never re-read from text here
    const chunk = (kind: "text" | "thinking" | "tool_call" | "tool_result", content: string, tool?: { id?: string; name?: string }) =>
      log.append({ type: "chunk", node: nodeId, visit, turn: 1, index: index++, kind, content, tool_id: tool?.id, tool_name: tool?.name });

    // HOW-25: the harness process can die while a human is mid-thought. The poll loop below
    // used to watch only the log, so a dead CLI left it spinning for ever and the run showed
    // `running` with nothing running. Watching `exited` is what turns that into a park.
    let harnessGone = false;
    void proc.exited.then(() => { harnessGone = true; }, () => { harnessGone = true; });

    /**
     * Raise a park and wait for the human — the ONE mechanism behind both kinds of mid-turn
     * ask (HOW-25). The permission ask and the question ask differ only in what they put in
     * `ask` and what they do with the answer; the durable raise, the notification, the
     * "resolved AFTER my raise" seq rule and the termination guards are shared.
     *
     * Returns the resolution, or why it stopped waiting. It never returns without one of the
     * two, because a silent wait is the bug this ticket was filed about.
     *
     * Known limit, stated rather than hidden: this runs INSIDE the stdout read loop, so while
     * it waits nothing is draining stdout and a `control_cancel_request` for the pending ask
     * is buffered rather than seen. The case that actually strands a run — the CLI going away
     * — is caught by `harnessGone`; a cancel that arrives while the process is still alive is
     * read straight after the answer, and the CLI ignores an answer to a request it already
     * settled, so the turn ends normally instead of hanging. Draining stdout concurrently
     * would fix the cosmetic half and is not worth restructuring the loop for today.
     */
    const awaitOperator = async (
      reason: string,
      ask: Record<string, unknown>,
    ): Promise<
      | { ok: true; reply: string; answers?: unknown }
      | { ok: false; reason: string }
    > => {
      const center = new AttentionCenter(opts.attentionDir, opts.notifiers ?? [osNotifier], { viewerBase: opts.viewerBase });
      // durable BEFORE delivered (engine/attention.ts): the record outlives a kill -9, so the
      // watchdog still rings even if this process never gets to notify
      const raised = log.append({ type: "attention-raised", node: nodeId, visit, reason, ask });
      await center.raise({ run: runId, node: nodeId, visit, reason }).catch(() => {});
      const deadline = opts.askTimeoutMs === undefined ? null : Date.now() + opts.askTimeoutMs;
      // the reply arrives in the log from the web card / CLI — poll for it, however long it takes
      for (;;) {
        await Bun.sleep(opts.askPollMs ?? 400);
        const resolved = readLog(log.path).find((e) => e.type === "attention-resolved" && e.seq > raised.seq);
        if (resolved && resolved.type === "attention-resolved")
          return { ok: true, reply: (resolved.reply ?? "").trim(), answers: resolved.answers };
        if (harnessGone)
          return { ok: false, reason: `the harness exited while it was waiting for you to answer: ${reason}` };
        if (deadline !== null && Date.now() > deadline)
          return { ok: false, reason: `nobody answered within the configured wait: ${reason}` };
      }
    };

    /** a park that ended without an answer is a FAILED attempt with a stated cause, never a hang */
    let stopped: string | null = null;

    const answerPermission = async (requestId: string, toolName: string, input: unknown, suggestions?: unknown[]) => {
      const got = await awaitOperator(`${toolName} needs permission`, {
        kind: "can_use_tool", request_id: requestId, tool_name: toolName, input, suggestions,
      });
      if (!got.ok) { stopped = got.reason; return; }
      const allow = isAllowReply(got.reply);
      proc.stdin.write(
        buildClaudePermissionResponse(requestId, allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: got.reply }),
      );
      proc.stdin.flush();
      chunk("tool_result", allow ? `permission granted` : `permission denied: ${got.reply}`, { name: toolName });
    };

    /**
     * HOW-25: the agent is asking the OPERATOR something. This is not a permission, and
     * answering it allow/deny throws the answer away — see core/ask.ts askResultMessage for
     * the captured evidence. So the questions go into the park (the card draws them, the
     * banner and the notification quote the first one) and the answer goes back as the tool
     * result, on the SAME session, mid-turn: the agent carries on rather than restarting.
     *
     * A typed reply is just as good as a clicked one: `answers` when the card sent them,
     * otherwise the prose is matched against the option labels (`howdah reply <run> "Option
     * B"` works, and so does the plain composer).
     */
    const answerQuestion = async (requestId: string, toolName: string, toolUseId: string | undefined, questions: UserQuestion[]) => {
      const got = await awaitOperator(askReason(questions), {
        kind: "user-question", request_id: requestId, tool_name: toolName, tool_use_id: toolUseId, questions,
      });
      if (!got.ok) { stopped = got.reason; return; }
      const answers = validateAnswers(questions, got.answers) ?? parseFreeTextAnswer(questions, got.reply);
      proc.stdin.write(
        buildClaudePermissionResponse(requestId, { behavior: "deny", message: askResultMessage(questions, answers) }),
      );
      proc.stdin.flush();
      // pinned to the tool_use id so the viewer pairs it with the AskUserQuestion call itself
      chunk("tool_result", answersToReplyText(questions, answers) || "(no answer)", { id: toolUseId, name: toolName });
    };

    let turnEnded = false;
    let repairSent = false;
    let sawEvent = false; // did the CLI ever speak stream-json? a logged-out CLI never does
    readLoop: for await (const bytes of proc.stdout) {
      for (const record of parser.push(bytes)) {
        if (!record.ok) continue; // non-JSON noise is not fatal
        sawEvent = true;
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
            case "permission_request": {
              // HOW-25: the harness's own flag decides. A question needs the question card;
              // everything else is an ordinary permission and keeps its exact prior semantics.
              const questions = ev.requires_user_interaction === true ? normalizeAskPayload(ev.input) : null;
              if (questions) await answerQuestion(ev.id, ev.tool_name, ev.tool_use_id, questions);
              else await answerPermission(ev.id, ev.tool_name, ev.input, ev.suggestions);
              break;
            }
            case "rate_limit":
              log.append({ type: "allowance", harness: "claude", state: ev.state, remaining: ev.remaining, resets_at: ev.resets_at, raw: ev.raw });
              break;
            case "turn_end":
              log.append({ type: "turn-finalized", node: nodeId, visit, turn: 1, usage: ev.usage });
              resultText = ev.result_text ?? accumulated;
              turnError = ev.error;
              if (ev.context_exceeded) contextExceeded = true;
              turnEnded = true;
              break;
            case "error":
              turnError = ev.message;
              if (ev.context_exceeded) contextExceeded = true;
              break;
            case "context_compacted":
              chunk("text", compactionNote(ev.trigger, ev.pre_tokens));
              break;
          }
        }
      }
      if (stopped !== null) break readLoop; // nothing will answer now — park instead of reading on
      if (turnEnded) {
        // one repair turn before giving up: the session still holds the work, so asking for
        // the missing contract costs a short turn instead of re-running the whole node
        if (!repairSent && !turnError && writeKeys.length && !parseOutputs(resultText ?? accumulated, writeKeys).ok) {
          repairSent = true;
          turnEnded = false;
          resultText = undefined;
          accumulated = "";
          chunk("text", "\n[outputs object missing — asking for it]");
          proc.stdin.write(buildClaudeUserTurn(buildRepairInstruction(writeKeys)));
          proc.stdin.flush();
          continue;
        }
        // the CLI stays open for more stdin turns; one attempt = one turn, so leave on result
        break readLoop;
      }
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

    // a CLI that never spoke the protocol did not start: say WHY (usually "not logged in")
    // instead of letting it fall through to an outputs complaint that blames the model
    const startup = classifyHarnessExit({
      harness: opts.binary ?? "claude",
      exitCode: exited, // null when WE killed it after the grace period, not a self-exit
      stderr: stderrChunks.join(""),
      sawOutput: sawEvent,
    });
    if (startup) {
      chunk("text", startup.note);
      return { status: "failed", writes: {}, reason: startup.reason, code: startup.code };
    }

    // a wait that ended without an answer is the failure — saying "output contract violation"
    // here would blame the model for a question nobody answered
    if (stopped !== null) {
      chunk("text", `\n[${stopped}]`);
      return { status: "failed", writes: {}, reason: stopped };
    }

    // HOW-14: before the generic turn error — "Prompt is too long" names a cause the engine
    // treats differently (no harness hop, a re-entry briefing on the retry)
    if (turnError && contextExceeded) {
      const failure = contextExhaustedFailure("claude");
      chunk("text", failure.note);
      return { status: "failed", writes: {}, reason: failure.reason, code: failure.code };
    }
    if (turnError) {
      chunk("text", `\n[turn error: ${turnError}]`);
      return { status: "failed", writes: {}, reason: `turn error: ${turnError}` };
    }
    const parsed = parseOutputs(resultText ?? accumulated, writeKeys);
    if (!parsed.ok) {
      chunk("text", `\n[output contract violation: ${parsed.problem}]`);
      return { status: "failed", writes: {}, reason: `output contract violation: ${parsed.problem}` };
    }
    return { status: "succeeded", writes: parsed.writes };
  };
}

