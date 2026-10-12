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
 *
 * The prompt is sent UNCHANGED: the engine already appended the outputs contract before
 * hashing (system-map 0.1), and codex gets no skill hint (core/template.ts skillsForHarness).
 * The one in-session repair turn (buildRepairInstruction) is a follow-up turn on the same
 * thread, outside rendered_hash by design — the hash covers the first turn only.
 *
 * HOW-14: `turn/completed` with `turn.status: "failed"` is a FAILED turn. It used to set
 * the same flag a successful one did, so every failed codex turn fell through to the outputs
 * check and was reported as an output contract violation — blaming the model. It is now a
 * `turn error` carrying codex's own message, gets no repair turn, and when codex says the
 * context window filled (`contextWindowExceeded`) it fails `context-exhausted` instead.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Executor } from "../run";
import { JsonlChunkParser } from "../../adapter/parse";
import { mapCodexEvent, buildCodexApprovalResponse, codexUsage } from "../../adapter/codex";
import type { TurnUsage } from "../../adapter/events";
import { buildRepairInstruction, checkWrites, parseOutputs } from "./outputs";
import { classifyHarnessExit, compactionNote, contextExhaustedFailure } from "./harness-failure";
import { AttentionCenter, osNotifier, type Notifier } from "../attention";
import { readLog } from "../../log/write";
import { isAllowReply } from "./reply";
import { effectiveCwd } from "./worktree";
import { killGroup } from "./shell";
import { ToolWatch, TurnCeiling, stuckReason, turnTimeoutReason, type StuckThresholds } from "./stuck";

export interface CodexExecutorOpts {
  attentionDir: string;
  binary?: string;
  model?: string;
  effort?: string;
  sandbox?: string; // default danger-full-access: Howdah-owned Codex runs get full access
  askPollMs?: number;
  notifiers?: Notifier[];
  viewerBase?: string;
  /** HOW-38: config.json `stuck` thresholds */
  stuck?: StuckThresholds;
}

/**
 * The thread's sandbox. Codex has no permission MODES, so the one mode that must hold is
 * mapped here: "plan" (a `readOnly` node, system-map 1a D6/5A — resolveAgentConfig forces it
 * over every override, and over the Claude→Codex fallback) opens a read-only sandbox, never
 * the full-access default. Every other mode gets the configured sandbox.
 */
export function codexSandbox(permissionMode: string | undefined, configured?: string): string {
  if (permissionMode === "plan") return "read-only";
  return configured ?? "danger-full-access";
}

/**
 * HOW-34: one turn's usage from two thread-total snapshots. A figure either snapshot lacks
 * stays unknown; the price is always null (codex reports none).
 */
export function usageDelta(now: TurnUsage | undefined, before: TurnUsage | undefined): TurnUsage | undefined {
  if (!now) return undefined;
  if (!before) return now;
  const minus = (a?: number, b?: number) => (a === undefined ? undefined : b === undefined ? a : Math.max(0, a - b));
  return {
    input_tokens: minus(now.input_tokens, before.input_tokens),
    ...(now.cache_read_input_tokens !== undefined ? { cache_read_input_tokens: minus(now.cache_read_input_tokens, before.cache_read_input_tokens) } : {}),
    output_tokens: minus(now.output_tokens, before.output_tokens),
    cost_usd: null,
    cost_source: "unpriced",
  };
}

export function codexExecutor(opts: CodexExecutorOpts): Executor {
  return async ({ nodeId, def, visit, runId, cwd, log, renderedPrompt, agentConfig, reads }) => {
    if (def.kind !== "agent") throw new Error("codexExecutor on non-agent node");
    const writeKeys = Object.keys(def.writes ?? {});
    const check = (w: Record<string, unknown>) => checkWrites(w, reads ?? {}); // HOW-51
    const prompt = renderedPrompt ?? ""; // exactly what rendered_hash covers (system-map 0.1)

    const proc = Bun.spawn([opts.binary ?? "codex", "app-server"], {
      cwd: effectiveCwd(log.path, cwd) ?? dirname(log.path),
      env: { ...process.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe", // verbose traces incl. full system prompts — file only, never UI
      detached: true, // HOW-38: a stuck or timed-out turn ends the whole group
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
    /** HOW-34: codex reports THREAD totals; each turn records the delta from the last one */
    let totals: TurnUsage | undefined;
    let totalsBefore: TurnUsage | undefined;
    const turnUsages: Array<TurnUsage | undefined> = [];
    let turn = 0; // HOW-34: 1 for the attempt's turn, 2 for the outputs repair
    /**
     * Two different things, deliberately NOT one variable (they were, and it made the repair
     * guard below read as a missing check):
     *   rpcFault  — an error RESPONSE to one of our own requests: the app-server refused us,
     *               so the thread is not in a state worth asking anything else of.
     *   notice    — an error NOTIFICATION. Codex emits these for startup noise (expired MCP
     *               server auth, observed live) and keeps working, so it is not fatal on its
     *               own; only a turn that never completes is.
     */
    let rpcFault: string | undefined;
    let notice: string | undefined;
    let turnCompleted = false;
    /** HOW-14: codex's own message for a turn that completed with status "failed" */
    let turnFailed: string | undefined;
    /** HOW-14: codex said the context window filled (on the failed turn, or an error notice) */
    let contextExceeded = false;
    /**
     * The exit code the app-server reached ON ITS OWN. Read before the `finally` kills it,
     * because a kill would overwrite it and make "we shut it down" look like "it crashed".
     * null therefore means it was still alive, which is the normal path.
     */
    let selfExit: number | null = null;
    const chunk = (kind: "text" | "thinking" | "tool_call" | "tool_result", content: string, tool?: { id?: string; name?: string; input_hash?: string; is_error?: boolean }) =>
      log.append({
        type: "chunk", node: nodeId, visit, turn: Math.max(turn, 1), index: index++, kind, content, tool_id: tool?.id, tool_name: tool?.name,
        ...(tool?.input_hash !== undefined ? { input_hash: tool.input_hash } : {}),
        ...(tool?.is_error !== undefined ? { is_error: tool.is_error } : {}),
      });
    // HOW-38: stuck detection (warn + stop; codex gets no mid-turn reminder) and the ceiling
    const watch = new ToolWatch({ harness: "codex", log, node: nodeId, visit, thresholds: opts.stuck, note: (t) => chunk("text", t), enabled: agentConfig?.stuckDetection !== false });
    const ceiling = new TurnCeiling(agentConfig?.turnTimeoutMs, () => killGroup(proc.pid));
    ceiling.start();

    const answerApproval = async (rpcRequestId: string | number, toolName: string, input: unknown) => {
      const center = new AttentionCenter(opts.attentionDir, opts.notifiers ?? [osNotifier], { viewerBase: opts.viewerBase });
      const raised = log.append({
        type: "attention-raised", node: nodeId, visit,
        reason: `${toolName} needs approval`,
        ask: { kind: "codex_approval", request_id: rpcRequestId, tool_name: toolName, input },
      });
      ceiling.pause(); // a human's thinking time is not the agent's (HOW-38)
      await center.raise({ run: runId, node: nodeId, visit, reason: `${toolName} needs approval` }).catch(() => {});
      for (;;) {
        await Bun.sleep(opts.askPollMs ?? 400);
        const resolved = readLog(log.path).find((e) => e.type === "attention-resolved" && e.seq > raised.seq);
        if (resolved && resolved.type === "attention-resolved") {
          const reply = (resolved.reply ?? "").trim();
          const allow = isAllowReply(reply);
          ceiling.start();
          if (!allow) watch.markDenied(String((input as { id?: unknown } | null)?.id ?? ""));
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
            if (raw.error) rpcFault = String(raw.error.message ?? "codex rpc error");
            continue;
          }
          // capture the completed agent message for the outputs contract
          if (raw.method === "item/completed" && raw.params?.item?.type === "agentMessage")
            finalMessage = String(raw.params.item.text ?? "");
          if (raw.method === "thread/tokenUsage/updated") {
            const t = raw.params?.tokenUsage?.total;
            if (t) totals = codexUsage(t);
          }
          // turn/completed is handled after mapping, where turn_end says whether it FAILED

          for (const ev of mapCodexEvent(raw)) {
            switch (ev.type) {
              case "text_delta":
                accumulated += ev.text;
                chunk("text", ev.text);
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
              case "permission_request":
                await answerApproval(ev.id, ev.tool_name, ev.input);
                break;
              case "rate_limit":
                log.append({ type: "allowance", harness: "codex", state: ev.state, remaining: ev.remaining, resets_at: ev.resets_at, raw: ev.raw });
                break;
              case "turn_end":
                turnCompleted = true;
                if (ev.error !== undefined) turnFailed = ev.error;
                if (ev.context_exceeded) contextExceeded = true;
                turnDone();
                break;
              case "context_compacted":
                chunk("text", compactionNote(ev.trigger, ev.pre_tokens));
                break;
              case "error":
                if (ev.context_exceeded) contextExceeded = true;
                // NOT fatal: codex emits error notifications for startup noise (expired
                // MCP server auth, observed live) and keeps working. Record it; the turn
                // fails only if it never completes.
                chunk("text", `\n[codex notice: ${ev.message}]`);
                notice = ev.message;
                break;
            }
          }
        }
      }
      turnDone(); // stream closed
      // a killed app-server (HOW-38) answers nothing more: release every request still waiting
      for (const resolve of pending.values()) resolve(undefined);
      pending.clear();
    })();

    try {
      await request("initialize", { clientInfo: { name: "howdah", version: "0.0.1" } });
      const thread = await request("thread/start", {
        cwd: effectiveCwd(log.path, cwd) ?? dirname(log.path),
        approvalPolicy: "on-request",
        sandbox: codexSandbox(agentConfig?.permissionMode, opts.sandbox),
        ...((agentConfig?.model ?? opts.model) ? { model: agentConfig?.model ?? opts.model } : {}),
      });
      const threadId = thread?.threadId ?? thread?.thread?.id;
      if (!threadId) throw new Error(`thread/start gave no threadId: ${JSON.stringify(thread).slice(0, 200)}`);

      const runTurn = async (text: string): Promise<void> => {
        turn++;
        const done = new Promise<void>((r) => (turnDone = r));
        await request("turn/start", {
          threadId,
          input: [{ type: "text", text }],
          ...((agentConfig?.effort ?? opts.effort) ? { effort: agentConfig?.effort ?? opts.effort } : {}),
        });
        await done;
        turnUsages[turn - 1] = usageDelta(totals, totalsBefore);
        totalsBefore = totals;
      };

      await runTurn(prompt);

      // One repair turn on the SAME thread when the contract is missing — the work is already
      // done there, so this is far cheaper than parking and re-running the node. Guarded the
      // way THIS harness decides failure: the turn completed (claude's equivalent is
      // !turnError, because for claude any turn error fails the attempt) and the app-server
      // did not fault on us. A mere notice must not skip the repair, or benign startup noise
      // would park a run whose work is already done.
      const firstParse = writeKeys.length ? parseOutputs(finalMessage ?? accumulated, writeKeys, check) : { ok: true as const };
      if (turnCompleted && turnFailed === undefined && !rpcFault && writeKeys.length && !firstParse.ok) {
        // HOW-51: a value the outputs check refused is named, so the repair fixes THAT
        const refused = "refused" in firstParse && firstParse.refused ? firstParse.problem : undefined;
        chunk("text", refused ? `\n[outputs refused — ${refused} — asking again]` : "\n[outputs object missing — asking for it]");
        finalMessage = undefined;
        accumulated = "";
        await runTurn(buildRepairInstruction(writeKeys, refused));
      }
    } catch (err) {
      // HOW-38: an app-server WE killed fails whatever it was doing; that is the timeout or the
      // stuck streak speaking, reported below — anything else is a real fault
      if (!ceiling.fired && !watch.stopped) throw err;
    } finally {
      ceiling.clear();
      selfExit = proc.exitCode; // non-null here = it died before we asked it to
      proc.kill();
      await proc.exited.catch(() => {});
      await pump.catch(() => {});
      await stderrDone.catch(() => {});
      if (stderrChunks.length)
        writeFileSync(join(dirname(log.path), `codex-${nodeId.replace(/[^\w.-]/g, "_")}-v${visit}.stderr.log`), stderrChunks.join(""));
    }

    // one turn-finalized per turn started (at least one: a thread that died before its first
    // turn still finalizes, with whatever codex had reported — or nothing, which reads unknown)
    for (let t = 1; t <= Math.max(turn, 1); t++)
      log.append({ type: "turn-finalized", node: nodeId, visit, turn: t, usage: turnUsages[t - 1] ?? (t === Math.max(turn, 1) ? usageDelta(totals, totalsBefore) : undefined) });
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
    // an app-server that died without ever answering us did not start: name the cause
    // (usually "not logged in") rather than reporting a stream that ended
    const startup = classifyHarnessExit({
      harness: opts.binary ?? "codex",
      exitCode: selfExit,
      stderr: stderrChunks.join(""),
      sawOutput: index > 0 || turnCompleted || rpcFault !== undefined,
    });
    if (startup) {
      chunk("text", startup.note);
      return { status: "failed", writes: {}, reason: startup.reason, code: startup.code };
    }
    // HOW-14: a context window that filled — on a failed turn, or a stream that ended without
    // one after codex said so — is its own park, never an outputs complaint or an allowance hop
    if (contextExceeded && (turnFailed !== undefined || !turnCompleted)) {
      const failure = contextExhaustedFailure("codex");
      chunk("text", failure.note);
      return { status: "failed", writes: {}, reason: failure.reason, code: failure.code };
    }
    if (turnFailed !== undefined) {
      chunk("text", `\n[turn error: ${turnFailed}]`);
      return { status: "failed", writes: {}, reason: `turn error: ${turnFailed}` };
    }
    if (!turnCompleted) {
      const why = rpcFault ?? notice ?? "app-server stream ended before turn/completed";
      chunk("text", `\n[turn error: ${why}]`);
      return { status: "failed", writes: {}, reason: `turn error: ${why}` };
    }
    const parsed = parseOutputs(finalMessage ?? accumulated, writeKeys, check);
    if (!parsed.ok) {
      chunk("text", `\n[output contract violation: ${parsed.problem}]`);
      return { status: "failed", writes: {}, reason: `output contract violation: ${parsed.problem}` };
    }
    return { status: "succeeded", writes: parsed.writes };
  };
}
