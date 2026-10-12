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
 * HOW-47: an operator STEER reaches a running turn without pausing it — written to stdin while
 * a tool call is in flight, delivered by the CLI at that tool's result boundary, and proven by
 * the CLI's echo. See the steer channel below and engine/steer.ts.
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
import { killGroup } from "./shell";
import { diagnosticsSettings } from "../hooks/diagnostics";
import { ToolWatch, TurnCeiling, stuckReason, turnTimeoutReason, type StuckThresholds } from "./stuck";
import { isAllowReply } from "./reply";
import { STOP_GRACE_TOOL_CALLS, STOP_MESSAGE, steerTurnText, stopTurnText } from "../../core/steer";
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
  /** HOW-47: how often the log is read for operator steers (default: askPollMs, then 400ms) */
  steerPollMs?: number;
  notifiers?: Notifier[];
  viewerBase?: string;
  /** HOW-38: config.json `stuck` thresholds (default warn 5, stop 8) */
  stuck?: StuckThresholds;
  /** HOW-39: the diagnostics hook's own ceiling (default engine/hooks/diagnostics.ts) */
  diagnosticsTimeoutMs?: number;
}

/**
 * HOW-34: this turn's share of a session-cumulative cost. If a CLI ever reports a total
 * SMALLER than the last one, it is not cumulative after all, and the report is the turn's own.
 */
export function turnShare(cumulative: number, before: number): number {
  return cumulative >= before ? Math.round((cumulative - before) * 1e9) / 1e9 : cumulative;
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
        // HOW-33: resolved for THIS harness (effortFor) — undefined when inert, never dropped
        // silently: the inert reason is on this attempt's prompt-rendered
        effort: agentConfig?.effort,
        // HOW-41: resolved (readOnly already stripped any allowance), translated per core/harnesses.ts
        allowedTools: agentConfig?.tools?.allow,
        disallowedTools: agentConfig?.tools?.deny,
        // HOW-39: resolved by the engine only when the node, the harness and the workspace all say yes
        ...(agentConfig?.diagnosticsCommand ? { settings: diagnosticsSettings(opts.diagnosticsTimeoutMs) } : {}),
      })],
      // HOW-38: its own process group, so a stuck or timed-out turn is ended with every
      // child it started (a test runner's workers) rather than leaving them orphaned
      {
        cwd: effectiveCwd(log.path, cwd) ?? dirname(log.path),
        // HOW-39: claude hands its environment to its hooks — this is how the hook learns its
        // command and where to record what it ran
        env: agentConfig?.diagnosticsCommand
          ? {
              ...process.env,
              HOWDAH_DIAG_CMD: agentConfig.diagnosticsCommand,
              HOWDAH_DIAG_LOG: log.path,
              HOWDAH_DIAG_NODE: nodeId,
              HOWDAH_DIAG_VISIT: String(visit),
              ...(opts.diagnosticsTimeoutMs ? { HOWDAH_DIAG_TIMEOUT_MS: String(opts.diagnosticsTimeoutMs) } : {}),
            }
          : { ...process.env },
        stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true,
      },
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
    // HOW-34: the outputs-repair follow-up is turn 2, so its chunks and usage are its own
    let turn = 1;
    // HOW-34: claude's total_cost_usd is session-cumulative; each turn records its own share
    let costSoFar = 0;
    const chunk = (kind: "text" | "thinking" | "tool_call" | "tool_result", content: string, tool?: { id?: string; name?: string; input_hash?: string; is_error?: boolean }) =>
      log.append({
        type: "chunk", node: nodeId, visit, turn, index: index++, kind, content, tool_id: tool?.id, tool_name: tool?.name,
        ...(tool?.input_hash !== undefined ? { input_hash: tool.input_hash } : {}),
        ...(tool?.is_error !== undefined ? { is_error: tool.is_error } : {}),
      });

    // HOW-38: stuck detection over this turn's calls, and the wall-clock ceiling
    const watch = new ToolWatch({
      harness: "claude", log, node: nodeId, visit, thresholds: opts.stuck, note: (t) => chunk("text", t),
      enabled: agentConfig?.stuckDetection !== false,
      // the SPIKE (stuck.ts): delivered at the next tool boundary, attached to the tool result
      remind: (text) => { try { proc.stdin.write(buildClaudeUserTurn(text)); proc.stdin.flush(); } catch {} },
    });
    const ceiling = new TurnCeiling(agentConfig?.turnTimeoutMs, () => killGroup(proc.pid));
    ceiling.start();

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
      awaitingOperator = true;
      const raised = log.append({ type: "attention-raised", node: nodeId, visit, reason, ask });
      ceiling.pause(); // a human's thinking time is not the agent's (HOW-38)
      await center.raise({ run: runId, node: nodeId, visit, reason }).catch(() => {});
      const deadline = opts.askTimeoutMs === undefined ? null : Date.now() + opts.askTimeoutMs;
      // the reply arrives in the log from the web card / CLI — poll for it, however long it takes
      try {
        for (;;) {
          await Bun.sleep(opts.askPollMs ?? 400);
          const resolved = readLog(log.path).find((e) => e.type === "attention-resolved" && e.seq > raised.seq);
          if (resolved && resolved.type === "attention-resolved") {
            ceiling.start();
            return { ok: true, reply: (resolved.reply ?? "").trim(), answers: resolved.answers };
          }
          if (harnessGone)
            return { ok: false, reason: `the harness exited while it was waiting for you to answer: ${reason}` };
          if (deadline !== null && Date.now() > deadline)
            return { ok: false, reason: `nobody answered within the configured wait: ${reason}` };
        }
      } finally {
        awaitingOperator = false;
      }
    };

    /** a park that ended without an answer is a FAILED attempt with a stated cause, never a hang */
    let stopped: string | null = null;

    const answerPermission = async (requestId: string, toolName: string, input: unknown, suggestions?: unknown[], toolUseId?: string) => {
      const got = await awaitOperator(`${toolName} needs permission`, {
        kind: "can_use_tool", request_id: requestId, tool_name: toolName, input, suggestions,
      });
      if (!got.ok) { stopped = got.reason; return; }
      const allow = isAllowReply(got.reply);
      if (!allow) watch.markDenied(toolUseId); // HOW-38: a refused call is not the agent spinning
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

    /**
     * HOW-47: the operator's steer channel. A poll reads this node@visit's `operator-steered`
     * events from the log; a steer is WRITTEN to stdin only while a tool call is in flight, so
     * the CLI delivers it at that tool's result boundary (adapter/fixtures/claude-steer.jsonl).
     * Writing it while the model is only generating text would let it queue behind the turn's
     * end, where the CLI would run it as a fresh turn nobody is reading. Delivery is proven by
     * the harness's own echo (`user_echo`), never assumed from the write; a steer still unwritten
     * when the turn ends was never seen, and the engine carries it into the next render.
     */
    const steersPending = new Map<number, { line: string; written: boolean }>();
    /**
     * HOW-48: the soft stop rides the same channel. Requested → written while a tool is in
     * flight → echoed (delivered). The turn that ends after delivery is `paused-by-operator`;
     * one that ends before the stop was even written is moot (the engine pauses at the boundary).
     */
    const stop = { requested: false, written: false, delivered: false, textFrom: 0, toolsAfter: 0, forced: false };
    const stopLine = stopTurnText();
    let awaitingOperator = false; // never write into stdin while the CLI waits on a control_response
    const steersSeen = new Set<number>();
    const toolsInFlight = new Set<string>();
    let lastToolResultId: string | undefined;
    const pollSteers = () => {
      let events: ReturnType<typeof readLog>;
      try { events = readLog(log.path); } catch { return; } // a torn tail mid-write: next tick
      const delivered = new Set(events.flatMap((e) => (e.type === "steer-delivered" ? [e.steer_seq] : [])));
      if (!stop.requested && events.some((e) => e.type === "soft-stop-requested" && e.node === nodeId && e.visit === visit)) stop.requested = true;
      for (const e of events) {
        if (e.type !== "operator-steered" || e.node !== nodeId || e.visit !== visit) continue;
        if (steersSeen.has(e.seq) || delivered.has(e.seq)) continue;
        steersSeen.add(e.seq);
        steersPending.set(e.seq, { line: steerTurnText(e.text), written: false });
      }
    };
    const flushSteers = () => {
      if (toolsInFlight.size === 0 || awaitingOperator) return;
      for (const s of steersPending.values()) {
        if (s.written) continue;
        proc.stdin.write(buildClaudeUserTurn(s.line));
        s.written = true;
      }
      if (stop.requested && !stop.written) {
        proc.stdin.write(buildClaudeUserTurn(stopLine));
        stop.written = true;
      }
      proc.stdin.flush();
    };
    const steerTimer = setInterval(() => { pollSteers(); flushSteers(); }, opts.steerPollMs ?? opts.askPollMs ?? 400);

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
            case "user_echo": {
              // HOW-47: the harness consumed a stdin message. Match it to the steer we wrote —
              // the echo of the prompt itself, or of a repair turn, matches nothing here
              if (stop.written && !stop.delivered && ev.text === stopLine) {
                stop.delivered = true;
                stop.textFrom = accumulated.length; // the agent's words AFTER reading the stop
                log.append({ type: "soft-stop-delivered", node: nodeId, visit, ...(lastToolResultId !== undefined ? { after_tool_id: lastToolResultId } : {}) });
                break;
              }
              const hit = [...steersPending.entries()].find(([, p]) => p.written && p.line === ev.text);
              if (hit) {
                steersPending.delete(hit[0]);
                log.append({ type: "steer-delivered", node: nodeId, visit, steer_seq: hit[0], ...(lastToolResultId !== undefined ? { after_tool_id: lastToolResultId } : {}) });
              }
              break;
            }
            case "tool_call": {
              // Tool inputs are clipped to 400 chars: the transcript wants a one-line summary,
              // not a 40KB Write. The ONE exception is TodoWrite (HOW-49): its input IS the
              // agent's own plan, the live progress panel derives the checklist from the latest
              // one (web/derive.ts derivePlan), and a plan cut mid-JSON cannot be parsed at all.
              const summary = ev.name === "TodoWrite" ? JSON.stringify(ev.input) : JSON.stringify(ev.input).slice(0, 400);
              chunk("tool_call", summary, { id: ev.id, name: ev.name, input_hash: watch.call(ev.id, ev.name, ev.input, summary) });
              toolsInFlight.add(ev.id);
              flushSteers(); // a steer waiting for a boundary has one now
              // HOW-48: an agent that read the stop and keeps working is stopped hard
              if (stop.delivered && ++stop.toolsAfter > STOP_GRACE_TOOL_CALLS) stop.forced = true;
              break;
            }
            case "tool_result": {
              chunk("tool_result", ev.content.slice(0, 400), { id: ev.id, ...(ev.is_error !== undefined ? { is_error: ev.is_error } : {}) });
              toolsInFlight.delete(ev.id);
              lastToolResultId = ev.id;
              watch.result(ev.id, ev.is_error === true, ev.content);
              // HOW-39: the hook ran before claude emitted this result and recorded itself in the
              // log; a PostToolUse hook has no stream event, so this is how the transcript sees it
              if (agentConfig?.diagnosticsCommand) {
                const ran = readLog(log.path).findLast((e) => e.type === "diagnostics-ran" && e.tool_use_id === ev.id);
                if (ran?.type === "diagnostics-ran")
                  chunk("text", `\n[diagnostics after ${ran.tool_name}${ran.file ? ` ${ran.file}` : ""}: ${ran.timed_out ? "timed out" : ran.exit_code === 0 ? "passed" : `exit ${ran.exit_code}\n${ran.output.slice(-400)}`}]`);
              }
              break;
            }
            case "permission_request": {
              // HOW-48: once the operator has asked for a stop, nothing new is asked of them —
              // the request is refused with the stop itself, as cwc's kill switch does
              if (stop.requested) {
                proc.stdin.write(buildClaudePermissionResponse(ev.id, { behavior: "deny", message: STOP_MESSAGE }));
                proc.stdin.flush();
                chunk("tool_result", `refused: the operator asked the agent to stop`, { id: ev.tool_use_id, name: ev.tool_name });
                break;
              }
              // HOW-25: the harness's own flag decides. A question needs the question card;
              // everything else is an ordinary permission and keeps its exact prior semantics.
              const questions = ev.requires_user_interaction === true ? normalizeAskPayload(ev.input) : null;
              if (questions) await answerQuestion(ev.id, ev.tool_name, ev.tool_use_id, questions);
              else await answerPermission(ev.id, ev.tool_name, ev.input, ev.suggestions, ev.tool_use_id);
              flushSteers(); // a steer or stop that waited out the ask can go now
              break;
            }
            case "rate_limit":
              log.append({ type: "allowance", harness: "claude", state: ev.state, remaining: ev.remaining, resets_at: ev.resets_at, raw: ev.raw });
              break;
            case "turn_end": {
              const usage = ev.usage && typeof ev.usage.cost_usd === "number"
                ? { ...ev.usage, cost_usd: turnShare(ev.usage.cost_usd, costSoFar) }
                : ev.usage;
              if (typeof ev.usage?.cost_usd === "number") costSoFar = ev.usage.cost_usd;
              log.append({ type: "turn-finalized", node: nodeId, visit, turn, usage });
              resultText = ev.result_text ?? accumulated;
              turnError = ev.error;
              if (ev.context_exceeded) contextExceeded = true;
              turnEnded = true;
              break;
            }
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
      if (watch.stopped) break readLoop; // HOW-38: the same failing call, again — end the turn
      if (stop.forced) break readLoop; // HOW-48: it ignored the stop; the kill below ends it
      if (turnEnded) {
        // one repair turn before giving up: the session still holds the work, so asking for
        // the missing contract costs a short turn instead of re-running the whole node
        // (never with a steer in limbo: the CLI would answer the queued steer before the repair)
        const limbo = [...steersPending.values()].some((p) => p.written) || (stop.written && !stop.delivered);
        // HOW-48: a turn that ended after the stop reached it OBEYED — it is not asked for outputs
        if (!repairSent && !limbo && !stop.delivered && !turnError && writeKeys.length && !parseOutputs(resultText ?? accumulated, writeKeys).ok) {
          repairSent = true;
          turnEnded = false;
          resultText = undefined;
          accumulated = "";
          chunk("text", "\n[outputs object missing — asking for it]");
          turn = 2;
          proc.stdin.write(buildClaudeUserTurn(buildRepairInstruction(writeKeys)));
          proc.stdin.flush();
          continue;
        }
        // the CLI stays open for more stdin turns; one attempt = one turn, so leave on result
        break readLoop;
      }
    }
    parser.flush();
    ceiling.clear();
    // HOW-38: a stuck turn is still running — end it and everything it started
    if (watch.stopped) killGroup(proc.pid);
    clearInterval(steerTimer);
    // HOW-47: a steer written but never echoed is queued inside the CLI, which would run it as a
    // fresh turn after this one — work nobody is reading. Stop the process instead of letting it
    // drain stdin; the steer is undelivered, so the engine carries it into the next render.
    const steerInLimbo = [...steersPending.values()].some((p) => p.written) || (stop.written && !stop.delivered);
    if (steerInLimbo || stop.forced) proc.kill();
    try { proc.stdin.end(); } catch {}
    // grace, then make sure it is gone
    const exited = await Promise.race([proc.exited, Bun.sleep(3000).then(() => null)]);
    if (exited === null) proc.kill();
    await proc.exited.catch(() => {});
    await stderrDone.catch(() => {});
    if (stderrChunks.length)
      writeFileSync(join(dirname(log.path), `claude-${nodeId.replace(/[^\w.-]/g, "_")}-v${visit}.stderr.log`), stderrChunks.join(""));

    // HOW-38: before the startup check — WE killed it, so its exit says nothing about login
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

    // HOW-48: classified from what the executor itself saw (the stop was echoed, then the turn
    // ended), never from the agent's prose. Obeying the operator is not a contract violation.
    if (stop.delivered && (turnEnded || stop.forced)) {
      const said = (stop.forced ? accumulated.slice(stop.textFrom) : (resultText ?? accumulated.slice(stop.textFrom))).trim();
      const lastMessage = said.slice(-1500) || "(the agent ended its turn without saying where it was)";
      log.append({ type: "soft-stop-honored", node: nodeId, visit, last_message: lastMessage, ...(stop.forced ? { forced: true } : {}) });
      const excerpt = lastMessage.replace(/\s+/g, " ").slice(0, 240);
      return {
        status: "failed", writes: {}, code: "paused-by-operator",
        reason: stop.forced
          ? `stopped hard: the agent kept calling tools after the operator's stop — it last said: "${excerpt}"`
          : `paused by the operator at a tool boundary — the agent said: "${excerpt}"`,
      };
    }
    if (stop.requested && !stop.delivered && turnEnded) {
      // the step finished before another tool call: its work stands, the engine pauses at the boundary
      log.append({ type: "soft-stop-moot", node: nodeId, visit });
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

