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
 * EVERY server request is answered, or the turn hangs. The app-server has ten request kinds
 * (adapter/codex.ts) and this executor used to answer two; the others were ignored, which
 * held a thread open for ten hours on an MCP connector asking to be re-authenticated. Now:
 * a permission (command, file change, extra permission profile) parks `codex_approval` and is
 * answered allow/deny; a `request_user_input` question is the HOW-25 question card
 * (`user-question`), answered mid-turn in codex's own answer shape; an MCP elicitation in
 * `url` mode parks `mcp-elicitation` quoting the message and the URL (done = accept, a deny =
 * decline) while a `form` mode, which carries a schema nothing here can draw, is declined at
 * once with a note; and a kind the adapter does not model is refused with a JSON-RPC error
 * naming it. A park that ends with the harness gone, or past the configured wait, fails the
 * attempt with that reason — nothing waits in silence (same contract as claude.ts).
 *
 * ONE CONNECTION, MANY THREADS. Codex's `multi_agent` feature (stable, on by default in
 * 0.162.1) lets the model `spawn_agent` sub-threads, and their notifications arrive on this
 * same stdio connection under THEIR `threadId`. Every notification is therefore keyed on the
 * thread this executor opened: a sub-agent's `turn/completed` is not our turn's end, its
 * deltas are not our text, and its finished message is a tagged note in the transcript, never
 * the final message the outputs contract is read from. Before that, a reviewer that fanned
 * out to three sub-agents ended its turn on the first one's report, spent the repair turn on
 * the second's, and failed the outputs contract with three reports interleaved word by word.
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
import { environmentFiles } from "./agent-env";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Executor } from "../run";
import { JsonlChunkParser } from "../../adapter/parse";
import {
  mapCodexEvent, buildCodexApprovalResponse, buildCodexPermissionsResponse, buildCodexUserInputResponse,
  buildCodexElicitationResponse, buildCodexErrorResponse, codexUsage,
} from "../../adapter/codex";
import type { TurnUsage } from "../../adapter/events";
import { answersToReplyText, askReason, normalizeAskPayload, parseFreeTextAnswer, validateAnswers, type UserQuestion } from "../../core/ask";
import { isDenyReply } from "./reply";
import { buildRepairInstruction, checkWrites, parseOutputs } from "./outputs";
import type { MaterialiseBodies } from "../../core/graph-spec";
import { classifyHarnessExit, compactionNote, contextExhaustedFailure } from "./harness-failure";
import { AttentionCenter, osNotifier, type Notifier } from "../attention";
import { readLog } from "../../log/write";
import { isAllowReply } from "./reply";
import { effectiveCwd } from "./worktree";
import { killGroup } from "./shell";
import { ToolWatch, TurnCeiling, stuckReason, turnTimeoutReason, type StuckThresholds } from "./stuck";

export interface CodexExecutorOpts {
  /** HOW-56 T5: copies → text, so the outputs check can judge a `graph.draft` (outputs.ts) */
  materialise?: MaterialiseBodies;
  attentionDir: string;
  binary?: string;
  model?: string;
  effort?: string;
  sandbox?: string; // default danger-full-access: Howdah-owned Codex runs get full access
  askPollMs?: number;
  /** how long a park may wait for an answer before the attempt fails with that reason; default forever */
  askTimeoutMs?: number;
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

/**
 * Sent as the thread's `developerInstructions`. Codex has no Skill tool, but the operator's
 * Claude-Code-shaped plugins still fire their SessionStart hooks here (the sequence plugin's
 * `default-behaviour`: "Use the `Skill` tool … Never use the Read tool on skill files"), and
 * repos inject "you MUST invoke the `kotlin-engineer` skill". Together those deadlocked every
 * Codex review on a Kotlin repo: the model refused to read SKILL.md and refused to work until
 * a tool that is not on the wire had been called, then parked `no-progress`. This names how a
 * skill is invoked on THIS harness. Logged on `agent-environment`, since it is agent input.
 */
export const CODEX_SKILL_INSTRUCTIONS =
  "Howdah harness note: this Codex session has no `Skill` tool. Wherever any instruction tells you to " +
  "invoke, load or use a skill, invoke it by reading that skill's SKILL.md with your file tools and " +
  "following it. Reading SKILL.md is how a skill is invoked here; it is not a prohibited fallback. " +
  "Skills live under the skill roots listed in your instructions, `.agents/skills/<name>/SKILL.md` " +
  "or `.claude/skills/<name>/SKILL.md` in the repository. A missing Skill tool is never a reason to stop.";

export function codexExecutor(opts: CodexExecutorOpts): Executor {
  return async ({ nodeId, def, visit, runId, cwd, log, renderedPrompt, agentConfig, reads }) => {
    if (def.kind !== "agent") throw new Error("codexExecutor on non-agent node");
    const writeKeys = Object.keys(def.writes ?? {});
    const check = (w: Record<string, unknown>) => checkWrites(w, reads ?? {}, { materialise: opts.materialise }); // HOW-51, HOW-56 T5
    // HOW-55: codex has no switch for the operator's own config, so what it reads regardless is
    // recorded — hashed — on every attempt; a run can say what it ran with even where it cannot choose
    log.append({ type: "agent-environment", node: nodeId, visit, harness: "codex", setting_sources: null, inherits_user: true,
      developer_instructions: CODEX_SKILL_INSTRUCTIONS,
      files: environmentFiles("codex", effectiveCwd(log.path, cwd), true) });
    const prompt = renderedPrompt ?? ""; // exactly what rendered_hash covers (system-map 0.1)

    // ChatGPT app connectors (codex's `apps` feature: Linear, Notion… as `codex_apps` MCP tools)
    // are off for a run: they live on the operator's ChatGPT login, and when that lapses every
    // call parks the run on a "reconnect" ask nobody headless can answer — a publish step hit it
    // twice in one visit. The operator's own codex keeps them; the override is per spawn.
    const proc = Bun.spawn([opts.binary ?? "codex", "app-server", "-c", "features.apps=false"], {
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

    let harnessGone = false;
    void proc.exited.then(() => { harnessGone = true; }, () => { harnessGone = true; });
    /** the thread this attempt opened; a notification from any other thread is a sub-agent's */
    let ownThread: string | undefined;
    /** a park that ended without an answer is a FAILED attempt with a stated cause, never a hang */
    let stopped: string | null = null;

    /** the one wait behind every kind of park: durable ask, notify, poll for the reply */
    const awaitOperator = async (
      reason: string,
      ask: Record<string, unknown>,
    ): Promise<{ ok: true; reply: string; answers?: unknown } | { ok: false; reason: string }> => {
      const center = new AttentionCenter(opts.attentionDir, opts.notifiers ?? [osNotifier], { viewerBase: opts.viewerBase });
      // durable BEFORE delivered (engine/attention.ts): the record outlives a kill -9
      const raised = log.append({ type: "attention-raised", node: nodeId, visit, reason, ask });
      ceiling.pause(); // a human's thinking time is not the agent's (HOW-38)
      await center.raise({ run: runId, node: nodeId, visit, reason }).catch(() => {});
      const deadline = opts.askTimeoutMs === undefined ? null : Date.now() + opts.askTimeoutMs;
      for (;;) {
        await Bun.sleep(opts.askPollMs ?? 400);
        const resolved = readLog(log.path).find((e) => e.type === "attention-resolved" && e.seq > raised.seq && e.node === nodeId && e.visit === visit); // HOW-73: a sibling branch may be asking too
        if (resolved && resolved.type === "attention-resolved") {
          ceiling.start();
          return { ok: true, reply: (resolved.reply ?? "").trim(), answers: resolved.answers };
        }
        if (harnessGone) return { ok: false, reason: `the harness exited while it was waiting for you to answer: ${reason}` };
        if (deadline !== null && Date.now() > deadline) return { ok: false, reason: `nobody answered within the configured wait: ${reason}` };
      }
    };

    const send = (frame: string) => { proc.stdin.write(frame); proc.stdin.flush(); };

    /** a permission: command, file change, or (0.162.1) an extra permission profile */
    const answerApproval = async (rpcRequestId: string, toolName: string, input: unknown) => {
      const got = await awaitOperator(`${toolName} needs approval`, { kind: "codex_approval", request_id: rpcRequestId, tool_name: toolName, input });
      if (!got.ok) { stopped = got.reason; killGroup(proc.pid); return; } // nothing answers a dead park: end the turn
      const allow = isAllowReply(got.reply);
      if (!allow) watch.markDenied(String((input as { id?: unknown } | null)?.id ?? ""));
      if (toolName === "permissions") send(buildCodexPermissionsResponse(rpcRequestId, allow ? (input as { permissions?: unknown }).permissions : {}));
      else send(buildCodexApprovalResponse(rpcRequestId, allow ? "approved" : "denied"));
      chunk("tool_result", allow ? "approval granted" : `approval denied: ${got.reply}`, { name: toolName });
    };

    /**
     * HOW-25 for codex: `request_user_input`. The questions go into the park in the shape the
     * question card draws; the answer goes back keyed by codex's OWN question ids (core/ask.ts
     * numbers them q0.. in order, so the two line up by index). A payload the model cannot
     * read is refused on the wire with a note, never left waiting.
     */
    const answerQuestion = async (rpcRequestId: string, raw: unknown) => {
      const questions = normalizeAskPayload(raw);
      const ownIds = ((raw as { questions?: Array<{ id?: unknown }> } | null)?.questions ?? []).map((q) => (typeof q?.id === "string" ? q.id : null));
      if (!questions || ownIds.some((id) => id === null)) {
        send(buildCodexErrorResponse(rpcRequestId, "howdah could not read the request_user_input questions"));
        chunk("text", "\n[codex asked a question howdah could not read — refused on the wire]");
        return;
      }
      const got = await awaitOperator(askReason(questions), { kind: "user-question", request_id: rpcRequestId, tool_name: "request_user_input", questions });
      if (!got.ok) { stopped = got.reason; killGroup(proc.pid); return; } // nothing answers a dead park: end the turn
      const answers = validateAnswers(questions, got.answers) ?? parseFreeTextAnswer(questions, got.reply);
      const byOwnId: Record<string, { answers: string[] }> = {};
      for (const a of answers) {
        const i = questions.findIndex((q) => q.id === a.id);
        const own = ownIds[i];
        if (own === undefined || own === null) continue;
        byOwnId[own] = { answers: [...a.selected, ...(a.other ? [a.other] : [])] };
      }
      send(buildCodexUserInputResponse(rpcRequestId, byOwnId));
      chunk("tool_result", answersToReplyText(questions, answers) || "(no answer)", { name: "request_user_input" });
    };

    /**
     * An MCP server asking the HUMAN. `url` mode is a place to go (captured: "Reconnect Linear
     * on ChatGPT…" + the link): park with both, and any reply that is not a refusal means it
     * was done. A `form` mode carries a JSON schema nothing here can draw: declined at once,
     * and the transcript says why, so the model sees the tool fail instead of a frozen turn.
     */
    const answerElicitation = async (ev: { id: string; server: string; mode: string; message: string; url?: string }) => {
      if (ev.mode !== "url") {
        send(buildCodexElicitationResponse(ev.id, "decline"));
        chunk("text", `\n[${ev.server} asked for a ${ev.mode} form howdah cannot draw — declined: ${ev.message}]`);
        return;
      }
      const reason = `${ev.server} needs you: ${ev.message}${ev.url ? ` ${ev.url}` : ""}`;
      const got = await awaitOperator(reason, { kind: "mcp-elicitation", request_id: ev.id, server: ev.server, mode: ev.mode, message: ev.message, url: ev.url });
      if (!got.ok) { stopped = got.reason; killGroup(proc.pid); return; } // nothing answers a dead park: end the turn
      const accept = !isDenyReply(got.reply);
      send(buildCodexElicitationResponse(ev.id, accept ? "accept" : "decline"));
      chunk("tool_result", accept ? `elicitation accepted: ${got.reply || "done"}` : `elicitation declined: ${got.reply}`, { name: ev.server });
    };

    /**
     * What a sub-agent thread's notification contributes: its tool calls, so the transcript
     * and the HOW-38 stuck detector see work that is really happening (names unchanged, so
     * log/trajectory.ts classifies them like any other), and its finished message as a note
     * naming the thread. Never a text delta — three threads' deltas interleave word by word —
     * and never a turn end, which is the hang-then-fail this guards against.
     */
    const subagent = (raw: Record<string, any>, from: string) => {
      const tag = `sub-agent ${from.slice(0, 8)}`;
      if (raw.method === "item/completed" && raw.params?.item?.type === "agentMessage") {
        const text = String(raw.params.item.text ?? "").trim();
        if (text) chunk("text", `\n[${tag} reported]\n${text}\n`);
        return;
      }
      for (const ev of mapCodexEvent(raw)) {
        if (ev.type === "tool_call") {
          const summary = JSON.stringify(ev.input).slice(0, 400);
          chunk("tool_call", summary, { id: ev.id, name: ev.name, input_hash: watch.call(ev.id, ev.name, ev.input, summary) });
        } else if (ev.type === "tool_result") {
          chunk("tool_result", ev.content.slice(0, 400), { id: ev.id, ...(ev.is_error !== undefined ? { is_error: ev.is_error } : {}) });
          if (watch.result(ev.id, ev.is_error === true, ev.content)?.kind === "stop") killGroup(proc.pid);
        } else if (ev.type === "error") {
          chunk("text", `\n[${tag} notice: ${ev.message}]`);
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
          // a notification from a thread we did not open is a sub-agent's (header comment)
          const from = raw.method !== undefined && raw.id === undefined ? raw.params?.threadId : undefined;
          if (typeof from === "string" && ownThread !== undefined && from !== ownThread) {
            subagent(raw, from);
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
                if (ev.requires_user_interaction) await answerQuestion(ev.id, ev.input);
                else await answerApproval(ev.id, ev.tool_name, ev.input);
                break;
              case "elicitation":
                await answerElicitation(ev);
                break;
              case "unsupported_request":
                // answered, not ignored: an unanswered request holds the turn open forever
                send(buildCodexErrorResponse(ev.id, `howdah does not handle ${ev.method}`));
                chunk("text", `\n[codex asked for ${ev.method}, which howdah does not handle — refused on the wire]`);
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
        developerInstructions: CODEX_SKILL_INSTRUCTIONS,
        ...((agentConfig?.model ?? opts.model) ? { model: agentConfig?.model ?? opts.model } : {}),
      });
      const threadId = thread?.threadId ?? thread?.thread?.id;
      if (!threadId) throw new Error(`thread/start gave no threadId: ${JSON.stringify(thread).slice(0, 200)}`);
      ownThread = String(threadId);

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
      if (!ceiling.fired && !watch.stopped && !stopped) throw err;
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
    // a park that ended without an answer: the stated cause, before any reading of the exit
    if (stopped) {
      chunk("text", `\n[${stopped}]`);
      return { status: "failed", writes: {}, reason: stopped };
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
