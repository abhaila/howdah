/**
 * Run control file (T22): the operator's channel INTO a live runner. The engine reads it
 * at every node boundary — pause and abort therefore land between attempts, never
 * mid-write. The file also gates `howdah up`: a paused/aborted run is never auto-resumed.
 *
 * Replies (system-map 0.2): resolveReply() is the ONE place that decides what an operator
 * reply to a park does — `howdah reply` and the web reply route both call it (they used to
 * carry two copies of "find the ask, append a resolution"). The park's `code` picks the
 * rule in REPLY_RULES: a failed agent attempt accepts the reply and renders it into the
 * retry; every park a reply cannot fix is REFUSED with the verb that can, so the operator's
 * words are never silently dropped. The check and the append run inside one
 * EventLog.appendIf critical section, so two concurrent replies land exactly one.
 *
 * Approval decisions (system-map 1a, D5/4A, D15, D17, D22): approve(), sendFeedback(),
 * pinComment() and redesign() are the ONE implementation behind the CLI verbs and the web
 * routes. Each decision is written with EventLog.appendIf, deciding under the log lock:
 * the proposal must be the CURRENT round of the approval node the run is at; no decision
 * yet → append it; the SAME decision already → idempotent success, nothing appended; a
 * DIFFERENT decision → refused ("already approved at 14:02"). Reading the round and its
 * decisions goes through engine/slice-decision.ts, never a copy of its rules.
 *
 * Waking the runner (D17): afterDecision() wakes the runner, then clears the attention of
 * the asks the decided round raised. wakeRunner() does not trust a live PID blindly: a runner
 * that exits within a short grace without consuming the decision (it checked just before
 * the decision landed, then parked) is resumed. An idempotent repeat wakes nothing — the
 * first decision already did. Even if every step after the append is lost, replay counts
 * the decision as answering the park, so `howdah up` resumes the run on its next tick.
 *
 * Ambiguous effects (HOW-3): resolveEffect() is the ONE implementation behind
 * `howdah resolve-effect` and POST /api/runs/:id/effects. An `ambiguous-effect` park (an
 * intent with no done that the resume probe could not decide) had no exit but hand-editing
 * run.jsonl; the operator now attests to the outside world with an additive
 * `side-effect-resolved`, which replay honours both ways — `happened` counts as done,
 * `not-happened` clears the intent so the retry claims it again. Decided and appended under
 * the same appendIf lock as a decision: one resolution per ambiguous intent, a repeat of the
 * same verdict is idempotent, and the opposite verdict is refused naming the first.
 *
 * One runner per run (system-map 1a review): `up`, a decision route, a reply and a manual
 * resume can all try to resume the same run at once. claimRunner() takes `runner.pid` as
 * an O_EXCL lockfile (log/lockfile.ts, stale-PID recovery) for the whole engine run —
 * Engine.start/resume take it, and a loser returns `busy` without touching the log.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { nodeReads, type Graph } from "../core/graph";
import { ContextStore } from "../core/context";
import type { LoggedEvent, ParkCode, RunEvent } from "../log/events";
import { EventLog, readLog } from "../log/write";
import { rendersReply, replayState, type ReplayedState } from "./replay";
import { AttentionCenter, type Notifier } from "./attention";
import { inspectLock, pidAlive as lockPidAlive, processCommand, processStart, releaseHeld, tryAcquireLock, unlinkQuiet, type Holder } from "../log/lockfile";
import { asksOfRound, clockTime, currentProposal, decisionKind, findDecision, nextSeq, roundComments } from "./slice-decision";

export type ControlCommand = "pause" | "abort";

export function controlPath(runDir: string): string {
  return join(runDir, "control.json");
}

export function readControl(runDir: string): ControlCommand | null {
  const p = controlPath(runDir);
  if (!existsSync(p)) return null;
  try {
    const c = (JSON.parse(readFileSync(p, "utf8")) as { command?: string }).command;
    return c === "pause" || c === "abort" ? c : null;
  } catch {
    return null;
  }
}

export function writeControl(runDir: string, command: ControlCommand): void {
  writeFileSync(controlPath(runDir), JSON.stringify({ command, at: new Date().toISOString() }));
}

export function clearControl(runDir: string): void {
  rmSync(controlPath(runDir), { force: true });
}

export function runnerPidPath(runDir: string): string {
  return join(runDir, "runner.pid");
}

/** a lock file with no readable PID yet is a runner between create and write for this long */
const RUNNER_LOCK_STALE_MS = 2_000;

/** Who holds a run's runner lock, and how sure we are it is that run's runner. */
export interface RunnerHolder {
  pid: number | undefined;
  /** the holder's command line, when ps can tell */
  command: string | null;
  /**
   * decided from EVIDENCE: the PID still has the start time recorded in the lock, or (legacy
   * PID-only lock) its argv is `… cli/main.ts … <this run id> …`. The only basis on which
   * anything may SIGNAL the holder (the viewer's abort route).
   */
  proven: boolean;
  /**
   * proven, or its identity cannot be checked at all (ps unavailable) — treated as the
   * runner for WAITING purposes (busy, never broken on a guess), never for killing
   */
  genuine: boolean;
  /**
   * a legacy lock whose holder runs `cli/main.ts` without naming this run — possibly an
   * old-code runner started as `run <graph>` without `--id`: `--force` refuses it too
   */
  legacyCli: boolean;
}

function describeHolder(runDir: string, h: Holder | undefined): RunnerHolder {
  // mid-create: a runner starting up — wait for it, never signal it
  if (!h) return { pid: undefined, command: null, proven: false, genuine: true, legacyCli: false };
  const command = processCommand(h.pid);
  if (!lockPidAlive(h.pid)) return { pid: h.pid, command, proven: false, genuine: false, legacyCli: false };
  if (h.start !== undefined) {
    const now = processStart(h.pid);
    const proven = now !== null && now === h.start;
    return { pid: h.pid, command, proven, genuine: proven || now === null, legacyCli: false };
  }
  const argv = command?.split(/\s+/) ?? [];
  const legacyCli = argv.some((a) => a.endsWith("cli/main.ts"));
  const proven = legacyCli && argv.includes(basename(runDir));
  return { pid: h.pid, command, proven, genuine: proven || command === null, legacyCli: legacyCli && !proven };
}

/** The live holder of a run's runner lock, or null when nobody (live) holds it. */
export function runnerHolder(runDir: string): RunnerHolder | null {
  const state = inspectLock(runnerPidPath(runDir), RUNNER_LOCK_STALE_MS);
  return state.kind === "held" && !state.stale ? describeHolder(runDir, state.holder) : null;
}

/** Why a run's lock needs the operator, naming what to do — the runner-lock attention text. */
export function runnerLockReason(run: string, holder: RunnerHolder): string {
  const who = `pid ${holder.pid ?? "?"}${holder.command ? ` (${holder.command})` : ""}`;
  return holder.legacyCli
    ? `run ${run} is locked by ${who}, which runs cli/main.ts but does not name this run — it may be an older runner of it; ` +
        `pause or abort it, then \`resume ${run}\``
    : `run ${run} is locked by ${who}, which is not its runner — \`resume ${run} --force\` breaks the lock`;
}

/**
 * Raise the durable runner-lock attention (once: a pending record is not re-notified, so
 * `howdah up` can call this every tick).
 */
export async function raiseRunnerLock(attentionDir: string, notifiers: Notifier[], run: string, holder: RunnerHolder): Promise<string> {
  const reason = runnerLockReason(run, holder);
  const center = new AttentionCenter(attentionDir, notifiers);
  if (!center.pending().some((r) => r.id === `${run}:runner-lock:0`))
    await center.raise({ run, node: "runner-lock", visit: 0, reason }).catch(() => {});
  return reason;
}

/**
 * Become the run's one runner: take `runner.pid` exclusively. A lock whose holder is dead —
 * or whose PID now belongs to another process (log/lockfile.ts identity check) — is broken.
 * Returns null on success, else who holds it. Release with releaseRunner().
 */
export function claimRunner(runDir: string): RunnerHolder | null {
  const r = tryAcquireLock(runnerPidPath(runDir), RUNNER_LOCK_STALE_MS);
  if (r.ok) return null;
  const state = inspectLock(runnerPidPath(runDir), RUNNER_LOCK_STALE_MS);
  return describeHolder(runDir, state.kind === "held" ? state.holder : undefined);
}

export function releaseRunner(runDir: string): void {
  releaseHeld(runnerPidPath(runDir));
}

/**
 * `resume <run> --force`: break a runner lock whose holder is NOT this run's live runner (a
 * legacy lock naming some other bun process, say). Refused for a genuine live runner AND for
 * any legacy holder running cli/main.ts (an old-code `run <graph>` without --id cannot be
 * told apart from this run's runner) — the refusal says to pause or abort it. Returns null
 * once the lock is gone.
 */
export function forceReleaseRunner(runDir: string): { refused: string } | null {
  const path = runnerPidPath(runDir);
  const state = inspectLock(path, RUNNER_LOCK_STALE_MS);
  if (state.kind === "gone") return null;
  const holder = describeHolder(runDir, state.holder);
  if (holder.genuine || holder.legacyCli)
    return {
      refused:
        `pid ${holder.pid ?? "?"} ${holder.legacyCli ? "runs cli/main.ts and may be this run's (older) runner" : "is this run's live runner"}` +
        `${holder.command ? ` (${holder.command})` : ""} — pause or abort it instead of forcing`,
    };
  // unlink only the lock we judged: if a real runner claimed it meanwhile, leave theirs
  let now: string | null = null;
  try {
    now = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (state.holder && now.trim().startsWith(String(state.holder.pid))) unlinkQuiet(path);
  return null;
}

/** Is the run's runner lock held by a live runner? (the same inspect path the lock itself uses) */
export function runnerAlive(runDir: string): boolean {
  const state = inspectLock(runnerPidPath(runDir), RUNNER_LOCK_STALE_MS);
  return state.kind === "held" && !state.stale;
}

/**
 * `howdah up`'s predicate, shared with wakeRunner: a run with no live runner should be
 * resumed iff it started, has not finished, is not parked (a decided awaiting-approval park
 * is not parked — D17), and the operator is not holding it (paused, or a control command).
 */
export function supervisorShouldResume(replayed: ReplayedState, control: ControlCommand | null): boolean {
  return !!replayed.started && !replayed.finished && !replayed.parked && !replayed.paused && control === null;
}

/**
 * The jump precheck, shared by `jump` and `redesign`: the target's declared reads must be
 * readable in the replayed context, otherwise the jump is refused with the missing keys
 * named — never a runtime surprise. Returns the missing keys ([] = the jump may proceed).
 */
export function jumpMissingReads(graph: Graph<any>, replayed: ReplayedState, node: string): string[] {
  const def = graph.def.nodes[node];
  if (!def || !replayed.started) return [];
  const declared = graph.declarations() as Record<string, { scope: any; writer: string[] }>;
  for (const k of graph.def.inputs) {
    if (declared[k]) declared[k]!.writer.push("__inputs__");
    else declared[k] = { scope: "sticky", writer: ["__inputs__"] };
  }
  const ctx = new ContextStore<any>(declared);
  ctx.beginAttempt("__inputs__", 0);
  for (const k of graph.def.inputs) ctx.set(k, replayed.started.inputs[k]);
  ctx.endAttempt("succeeded");
  for (const f of replayed.finishes) {
    ctx.beginAttempt(f.node, f.visit);
    for (const [k, v] of Object.entries(f.writes)) ctx.set(k, v);
    ctx.endAttempt(f.status);
  }
  return nodeReads(def).filter((k) => !ctx.has(k));
}

/**
 * The whole jump precheck, shared by `howdah jump` and the viewer's jump route: the viewer
 * spawns the jump detached (f8c8d96 — `jump` resumes the run, so waiting on it would hold the
 * request for the whole run), so it must refuse in-process first, or every refusal below
 * would vanish silently. The CLI re-checks when the spawned jump runs.
 */
export function jumpRefusal(
  runDir: string,
  node: string,
  graphs: Record<string, Graph<any>>,
): { ok: false; message: string } | { ok: true; replayed: ReplayedState; graph: Graph<any> } {
  const path = join(runDir, "run.jsonl");
  if (!existsSync(path)) return { ok: false, message: `unknown run: ${basename(runDir)}` };
  if (runnerAlive(runDir)) return { ok: false, message: "runner is live — pause or abort first, then jump" };
  const replayed = replayState(readLog(path));
  if (!replayed.started) return { ok: false, message: "empty run" };
  if (replayed.finished) return { ok: false, message: `run already finished (${replayed.finished.outcome})` };
  const graph = graphs[replayed.started.graph];
  if (!graph) return { ok: false, message: `unknown graph ${replayed.started.graph}` };
  const def = graph.def.nodes[node];
  if (!def) return { ok: false, message: `unknown node "${node}" — have: ${Object.keys(graph.def.nodes).join(", ")}` };
  if (def.kind === "terminal") return { ok: false, message: "cannot jump to a terminal node" };
  // the target's declared reads must be satisfiable from the replayed context, otherwise the
  // jump is refused with the missing keys named — never a runtime surprise
  const missing = jumpMissingReads(graph, replayed, node);
  if (missing.length)
    return { ok: false, message: `cannot jump to "${node}": context missing ${missing.join(", ")} — those writers have not run` };
  return { ok: true, replayed, graph };
}

/**
 * Pause's interrupt (f8c8d96): stop a live runner and its direct harness child mid-turn;
 * the event log remains resumable. Signals ONLY a holder PROVEN to be this run's runner
 * (runnerHolder: start time matched, or a legacy lock whose argv is cli/main.ts … <run>) —
 * a runner.pid can name any process once its PID is reused, and an unknown identity is
 * never a licence to kill. Returns true iff a proven runner was signalled; otherwise the
 * control file still stops a real runner at its next boundary. Shared by pause and abort.
 */
export async function interruptRunner(runDir: string, graceMs = 500): Promise<boolean> {
  const holder = runnerHolder(runDir);
  if (!holder?.proven || holder.pid === undefined) return false;
  const pid = holder.pid;
  try {
    Bun.spawnSync(["pkill", "-TERM", "-P", String(pid)]); // the claude/codex child too
    process.kill(pid, "SIGTERM");
    await Bun.sleep(graceMs);
    if (lockPidAlive(pid)) process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false; // already gone
  }
}

/**
 * Record an operator pause in the log (f8c8d96) — once, and never on a finished run. The
 * "already paused / finished?" check and the append share one appendIf critical section, so
 * the CLI and the viewer pausing together land one run-paused. Returns whether it appended.
 */
export function markPaused(runDir: string): boolean {
  const path = join(runDir, "run.jsonl");
  if (!existsSync(path)) return false;
  const appended = new EventLog(path).appendIf((events) => {
    if (events.some((e) => e.type === "run-finished")) return null;
    const last = events.findLast((e) => e.type === "run-paused" || e.type === "run-resumed");
    return last?.type === "run-paused" ? null : { type: "run-paused", by: "operator" };
  });
  return appended !== null;
}

// ---- replies (system-map 0.2) ------------------------------------------------------

export type ReplyResult =
  /** the resolution landed; `rendered` = the retried prompt will carry the reply */
  | { ok: true; node: string; visit: number; code?: ParkCode; rendered: boolean }
  /** nothing was appended; `message` names what to do instead */
  | { ok: false; message: string; code?: ParkCode };

interface AskContext {
  node: string;
  run: string;
  /** the node's kind from the registered graph; undefined = graph or node not registered */
  kind: string | undefined;
  /** the node's maxVisits when the retry would exceed it (budget counted above the jump floor) */
  retryOverBudget: number | undefined;
  /** system-map 1a: the approval node this node `requires`, when it has one */
  requires: string | undefined;
}

/** what an ask resolves to: accepted, or refused naming the verb that CAN move the run */
type Rule = (ask: AskContext) => { accept: true } | { accept: false; message: string };

const jumpVerb = (run: string) => `\`jump ${run} <node> <msg>\``;

/**
 * A failure the agent can act on: accept only when the retry will actually happen on an
 * agent node. A command/worktree node has no prompt; an unregistered graph cannot even be
 * resumed; and a retry past maxVisits parks before the node starts, stranding the reply.
 */
const retryWithReply: Rule = ({ node, run, kind, retryOverBudget }) => {
  if (kind === undefined)
    return {
      accept: false,
      message: `the run's graph (or its node "${node}") is not registered in graphs/index.ts, so the run cannot move until it is`,
    };
  if (kind !== "agent")
    return { accept: false, message: `"${node}" is a ${kind} node, so there is no prompt to carry it; fix the cause, then \`resume ${run}\`` };
  if (retryOverBudget !== undefined)
    return { accept: false, message: `the retry would exceed maxVisits (${retryOverBudget}); use ${jumpVerb(run)}` };
  return { accept: true };
};

/**
 * An auth failure is not the agent's to answer: the fix is a human logging the CLI in, and
 * only then does a retry mean anything. Replying is still ACCEPTED — the retry is exactly
 * what the operator wants next, and a reply that arrives while still logged out simply fails
 * the same way with the same message, which is honest. The wording leads with the login step
 * so the operator does the thing that actually unblocks the run.
 */
const loginThenRetry: Rule = (ask) => {
  const r = retryWithReply(ask);
  if (r.accept) return r;
  return { accept: false, message: `log the harness in first, then ${r.message}` };
};

const useJump: Rule = ({ run }) => ({
  accept: false,
  message: `a reply cannot change where the graph routes; use ${jumpVerb(run)} to restart at a node with your instruction`,
});

/**
 * One rule per code — a Record, so adding a ParkCode without deciding its reply rule is a
 * compile error. The slice 1 codes (awaiting-approval, approval-missing, stale-base) are
 * raised by the approval flow, which owns the verbs these messages name.
 */
export const REPLY_RULES: Readonly<Record<ParkCode, Rule>> = {
  "attempt-failed": retryWithReply,
  "harness-unauthenticated": loginThenRetry,
  "executor-threw": retryWithReply,
  "max-visits": useJump,
  "no-edge": useJump,
  "max-steps": useJump,
  "ambiguous-effect": ({ run }) => ({
    accept: false,
    message:
      `a side effect may or may not have happened; \`resolve-effect ${run} <effect> happened|not-happened\`, ` +
      `then \`resume ${run}\``,
  }),
  "awaiting-approval": ({ run }) => ({
    accept: false,
    message:
      `the run is waiting on a decision about the current proposal; use \`approve ${run}\`, ` +
      `\`comment ${run} <entity-id> <text>\` then \`send-feedback ${run}\`, or \`redesign ${run} <msg>\``,
  }),
  "approval-missing": ({ run, node, requires }) => ({
    accept: false,
    message:
      `"${node}" needs an approved proposal${requires ? ` from "${requires}"` : ""}; use ` +
      `\`jump ${run} ${requires ?? "<approval-node>"}\` to return to the approval step (then \`approve ${run}\`), ` +
      `or \`redesign ${run} <msg>\``,
  }),
  "stale-base": ({ run }) => ({
    accept: false,
    message:
      `the worktree changed since the design was approved; undo the change and \`resume ${run}\`, ` +
      `or \`redesign ${run} <msg>\` to re-extract and redraw`,
  }),
};

export const NOTHING_AWAITING = "nothing awaiting a reply";

export interface ReplyOpts {
  /**
   * graph registry used to tell a node's kind and budget — passed in (the CLI and server
   * hand over graphs/index.ts GRAPHS) so the engine layer never imports the graphs
   */
  graphs: Record<string, Graph<any>>;
}

/** The pure decision: the resolution to append, or why not. Runs inside appendIf. */
export function decideReply(
  events: LoggedEvent[],
  run: string,
  text: string,
  graphs: Record<string, Graph<any>>,
): { event: RunEvent; result: ReplyResult } | { event: null; result: ReplyResult } {
  const replayed = replayState(events);
  // replay's `parked` already drops asks a jump superseded; a finished run awaits nothing
  const ask = replayed.finished ? null : replayed.parked;
  if (!ask) return { event: null, result: { ok: false, message: NOTHING_AWAITING } };

  if (ask.code !== undefined) {
    const graph = replayed.started ? graphs[replayed.started.graph] : undefined;
    const def = graph?.def.nodes[ask.node];
    // the engine's own check (run.ts loop): visit - floor > maxVisits parks before node-started
    const maxVisits = def && "maxVisits" in def ? def.maxVisits : undefined;
    const retryVisit = (replayed.visits[ask.node] ?? 0) + 1;
    const overBudget = maxVisits !== undefined && retryVisit - (replayed.floors[ask.node] ?? 0) > maxVisits;
    const requires = def?.kind === "agent" ? def.requires?.approvalOf : undefined;
    const verdict = REPLY_RULES[ask.code]({ node: ask.node, run, kind: def?.kind, retryOverBudget: overBudget ? maxVisits : undefined, requires });
    if (!verdict.accept)
      return { event: null, result: { ok: false, message: `reply refused (${ask.code}): ${verdict.message}`, code: ask.code } };
  }
  // no code: a legacy park, or a live mid-node harness permission ask (claude.ts / codex.ts
  // poll the log for this very event) — both keep their pre-0.2 meaning: logged, not rendered
  const event = { type: "attention-resolved", node: ask.node, visit: ask.visit, reply: text, source: "operator" } as const;
  return {
    event,
    result: { ok: true, node: ask.node, visit: ask.visit, code: ask.code, rendered: rendersReply(ask, event) !== null },
  };
}

/**
 * Answer the run's standing ask. Atomic: the "is there an unresolved ask, and may a reply
 * answer it?" check and the append happen under the log lock, so of two racing replies one
 * lands and the other reads the first's resolution and gets NOTHING_AWAITING. The caller
 * clears the attention record and kicks a resume when `ok`.
 */
export function resolveReply(runDir: string, text: string, opts: ReplyOpts): ReplyResult {
  const path = join(runDir, "run.jsonl");
  const run = basename(runDir);
  if (!existsSync(path)) return { ok: false, message: `unknown run: ${run}` };
  let result: ReplyResult = { ok: false, message: NOTHING_AWAITING };
  new EventLog(path).appendIf((events) => {
    const decision = decideReply(events, run, text, opts.graphs);
    result = decision.result;
    return decision.event;
  });
  return result;
}

// ---- approval decisions (system-map 1a) ----------------------------------------------

export type DecisionRefusal =
  | "unknown-run"
  | "not-started"
  | "finished"
  | "no-proposal"
  | "not-awaiting"
  | "superseded"
  | "already-decided"
  | "no-comments"
  | "runner-live"
  | "unknown-graph"
  | "no-approval-node"
  | "cannot-jump"
  | "bad-request";

/** an awaiting-approval ask, by the key its attention record uses */
export interface AskRef {
  node: string;
  visit: number;
}

export type DecisionResult =
  | {
      ok: true;
      /** the round decided / commented on (redesign: null) */
      proposal_id: number | null;
      /** the same decision was already recorded — nothing was appended */
      idempotent: boolean;
      /** comment-pinned: the new comment's id */
      comment_id?: string;
      /** redesign: the node the run jumped to */
      jumped_to?: string;
      /** asks this action answered — their attention records can be cleared */
      asks: AskRef[];
    }
  | { ok: false; code: DecisionRefusal; message: string };

type RoundAction = { kind: "approve" } | { kind: "feedback" } | { kind: "comment"; entityId: string; text: string };

const refuse = (code: DecisionRefusal, message: string): { event: null; result: DecisionResult } => ({
  event: null,
  result: { ok: false, code, message },
});

/**
 * The pure decision over one log snapshot: the event to append (or null) and the answer.
 * Runs inside appendIf, so the snapshot IS the log at the moment of the append.
 */
export function decideRound(
  events: LoggedEvent[],
  run: string,
  action: RoundAction,
  proposalId?: number,
): { event: RunEvent | null; result: DecisionResult } {
  const replayed = replayState(events);
  if (!replayed.started) return refuse("not-started", `run ${run} has not started`);
  if (replayed.finished) return refuse("finished", `run ${run} already finished (${replayed.finished.outcome})`);

  const latest = currentProposal(events);
  if (!latest) return refuse("no-proposal", `nothing has been proposed in run ${run} yet`);
  if (proposalId !== undefined && proposalId !== latest.proposal_id) {
    const known = events.some((e) => e.type === "ghost-proposed" && e.proposal_id === proposalId);
    return refuse(
      "superseded",
      known
        ? `proposal #${proposalId} was superseded by #${latest.proposal_id}; decide on the current proposal`
        : `proposal #${proposalId} is not a proposal of run ${run} (the current one is #${latest.proposal_id})`,
    );
  }
  // the run must be at (or parked on) the approval node that decides this round
  const at = replayed.position?.node;
  if (at !== latest.approval)
    return refuse(
      "not-awaiting",
      `run ${run} is at "${at ?? "(start)"}", not at the approval step "${latest.approval}" — nothing is awaiting a decision`,
    );

  const round = latest;
  const decision = findDecision(events, round.proposal_id);
  const decidedAs = decision
    ? decisionKind(decision) === "approved"
      ? `already approved at ${clockTime(decision.ts)}`
      : `already sent feedback at ${clockTime(decision.ts)}`
    : "";

  if (action.kind === "comment") {
    if (decision)
      return refuse("already-decided", `proposal #${round.proposal_id} was ${decidedAs}; comment on the next proposal`);
    const id = `c${nextSeq(events)}`;
    return {
      event: { type: "comment-pinned", id, entity_id: action.entityId, proposal_id: round.proposal_id, text: action.text },
      result: { ok: true, proposal_id: round.proposal_id, idempotent: false, comment_id: id, asks: [] },
    };
  }

  const want = action.kind === "approve" ? "approved" : "feedback";
  if (decision) {
    if (decisionKind(decision) === want)
      return { event: null, result: { ok: true, proposal_id: round.proposal_id, idempotent: true, asks: [] } };
    return refuse("already-decided", `proposal #${round.proposal_id} was ${decidedAs}`);
  }
  const bound = { proposal_id: round.proposal_id, proposal_hash: round.proposal_hash, manifest_hash: round.manifest_hash };
  if (want === "approved")
    return { event: { type: "slice-approved", ...bound }, result: { ok: true, proposal_id: round.proposal_id, idempotent: false, asks: [] } };
  const comments = roundComments(events, round.proposal_id);
  if (comments.length === 0)
    return refuse(
      "no-comments",
      `no comments are pinned to proposal #${round.proposal_id}; pin one with \`comment ${run} <entity-id> <text>\` first, or use \`redesign ${run} <msg>\``,
    );
  return {
    event: { type: "slice-feedback-sent", ...bound, comment_ids: comments.map((c) => c.id) },
    result: { ok: true, proposal_id: round.proposal_id, idempotent: false, asks: [] },
  };
}

function logPathOf(runDir: string): string {
  return join(runDir, "run.jsonl");
}

function decide(runDir: string, action: RoundAction, proposalId?: number): DecisionResult {
  const path = logPathOf(runDir);
  const run = basename(runDir);
  if (!existsSync(path)) return { ok: false, code: "unknown-run", message: `unknown run: ${run}` };
  // `as`: assigned inside the appendIf callback, which TS's narrowing cannot see
  let result = { ok: false, code: "no-proposal", message: "nothing decided" } as DecisionResult;
  const log = new EventLog(path);
  const stamped = log.appendIf((events) => {
    const d = decideRound(events, run, action, proposalId);
    result = d.result;
    return d.event;
  });
  if (stamped?.type === "comment-pinned" && stamped.id !== `c${stamped.seq}`)
    throw new Error(`comment-pinned was stamped seq ${stamped.seq} but carries id ${stamped.id}`);
  if (!result.ok || action.kind === "comment") return result;

  // close the park this decision answers, if the runner already parked (D17 makes this
  // bookkeeping — replay counts the decision alone — but the log should read as answered)
  const reply = action.kind === "approve" ? "approved" : "feedback sent";
  log.appendIf((events) => {
    const ask = replayState(events).answeredPark;
    return ask ? { type: "attention-resolved", node: ask.node, visit: ask.visit, reply, source: "operator" } : null;
  });
  return { ...result, asks: result.proposal_id === null ? [] : asksOfRound(log.read(), result.proposal_id) };
}

/** Approve the current proposal round (optionally: only if it is still `proposalId`). */
export function approve(runDir: string, opts: { proposalId?: number } = {}): DecisionResult {
  return decide(runDir, { kind: "approve" }, opts.proposalId);
}

/** Send the current round's pinned comments back to the proposer. */
export function sendFeedback(runDir: string, opts: { proposalId?: number } = {}): DecisionResult {
  return decide(runDir, { kind: "feedback" }, opts.proposalId);
}

/** Pin a comment to an entity of the current (undecided) round. */
export function pinComment(runDir: string, entityId: string, text: string, opts: { proposalId?: number } = {}): DecisionResult {
  if (entityId.trim() === "") return { ok: false, code: "bad-request", message: "a comment needs an entity id" };
  if (text.trim() === "") return { ok: false, code: "bad-request", message: "a comment needs text" };
  return decide(runDir, { kind: "comment", entityId, text }, opts.proposalId);
}

/**
 * `redesign <run> <msg>` (D22): append slice-redesign-requested, then an operator-jump
 * (budgets reset) to the approval node's redesignTo. Works whether or not the run is
 * parked; refused while a runner is live, exactly like `jump`. The message reaches the
 * proposer through the feedback key (engine/slice-decision.ts pendingRedesigns). The
 * caller clears control and resumes, as jump does.
 */
export function redesign(runDir: string, message: string, opts: { graphs: Record<string, Graph<any>> }): DecisionResult {
  const path = logPathOf(runDir);
  const run = basename(runDir);
  if (!existsSync(path)) return { ok: false, code: "unknown-run", message: `unknown run: ${run}` };
  if (message.trim() === "") return { ok: false, code: "bad-request", message: "a redesign needs a message for the proposer" };
  if (runnerAlive(runDir)) return { ok: false, code: "runner-live", message: "runner is live — pause or abort first, then redesign" };

  let result = { ok: false, code: "not-started", message: `run ${run} has not started` } as DecisionResult;
  // ONE append for the request and its jump: no crash can leave a request without its jump
  new EventLog(path).appendAllIf((events): RunEvent[] => {
    const replayed = replayState(events);
    if (!replayed.started) return [];
    if (replayed.finished) {
      result = { ok: false, code: "finished", message: `run ${run} already finished (${replayed.finished.outcome})` };
      return [];
    }
    const graph = opts.graphs[replayed.started.graph];
    if (!graph) {
      result = { ok: false, code: "unknown-graph", message: `run ${run} uses graph "${replayed.started.graph}", which is not registered in graphs/index.ts` };
      return [];
    }
    const approvals = graph.approvalNodes();
    const at = replayed.position?.node;
    const approval = approvals.find(([id]) => id === at) ?? (approvals.length === 1 ? approvals[0] : undefined);
    if (!approval) {
      result = {
        ok: false,
        code: "no-approval-node",
        message: approvals.length
          ? `graph "${graph.def.name}" has several approval steps and the run is at none of them; use \`jump ${run} <node> <msg>\``
          : `graph "${graph.def.name}" has no approval step to redesign; use \`jump ${run} <node> <msg>\``,
      };
      return [];
    }
    const target = approval[1].redesignTo;
    const missing = jumpMissingReads(graph, replayed, target);
    if (missing.length) {
      result = { ok: false, code: "cannot-jump", message: `cannot redesign via "${target}": context missing ${missing.join(", ")}` };
      return [];
    }
    const asks = replayed.parked ? [{ node: replayed.parked.node, visit: replayed.parked.visit }] : [];
    result = { ok: true, proposal_id: null, idempotent: false, jumped_to: target, asks };
    return [
      { type: "slice-redesign-requested", approval: approval[0], message },
      { type: "operator-jump", to: target, reset_budgets: true },
    ];
  });
  return result;
}

// ---- ambiguous side effects (HOW-3) --------------------------------------------------

export type EffectVerdict = "happened" | "not-happened";

export const EFFECT_VERDICTS: readonly EffectVerdict[] = ["happened", "not-happened"];

/**
 * Why a resolution was refused. Built from the members of DecisionRefusal that genuinely
 * apply (DecisionRefusal itself is approval vocabulary and is not widened) plus the two
 * codes only this verb can raise.
 */
export type EffectRefusal =
  | Extract<DecisionRefusal, "unknown-run" | "not-started" | "finished" | "runner-live" | "bad-request">
  | "no-ambiguous-effect"
  | "already-resolved";

export type EffectResult =
  | {
      ok: true;
      /** copied from the intent this attestation answers */
      node: string;
      visit: number;
      effect: string;
      verdict: EffectVerdict;
      /** the SAME verdict was already recorded — nothing was appended */
      idempotent: boolean;
      /** the ambiguous-effect park this answers — its attention record can be cleared */
      asks: AskRef[];
    }
  | { ok: false; code: EffectRefusal; message: string };

const refuseEffect = (code: EffectRefusal, message: string): { event: null; result: EffectResult } => ({
  event: null,
  result: { ok: false, code, message },
});

const namesEffect = (e: { node: string; effect: string }, effect: string, node?: string): boolean =>
  e.effect === effect && (node === undefined || e.node === node);

const quoted = (xs: readonly string[]): string => [...new Set(xs)].map((x) => `"${x}"`).join(", ");

/**
 * The pure decision over one log snapshot: the event to append (or null) and the answer.
 * Runs inside appendIf, so the snapshot IS the log at the moment of the append.
 */
export function decideEffect(
  events: LoggedEvent[],
  run: string,
  effect: string,
  verdict: EffectVerdict,
  opts: { node?: string } = {},
): { event: RunEvent | null; result: EffectResult } {
  const replayed = replayState(events);
  if (!replayed.started) return refuseEffect("not-started", `run ${run} has not started`);
  if (replayed.finished) return refuseEffect("finished", `run ${run} already finished (${replayed.finished.outcome})`);

  const on = opts.node === undefined ? "" : ` on "${opts.node}"`;
  const candidates = replayed.pendingIntents.filter((i) => namesEffect(i, effect, opts.node));

  if (candidates.length === 0) {
    // nothing ambiguous by that name — say WHY, because "already done", "already resolved the
    // other way" and "you named the wrong effect" are three different operator mistakes
    const prior = events.filter((e) => e.type === "side-effect-resolved" && namesEffect(e, effect, opts.node)).at(-1);
    if (prior?.type === "side-effect-resolved") {
      if (prior.verdict === verdict)
        return {
          event: null,
          result: { ok: true, node: prior.node, visit: prior.visit, effect, verdict, idempotent: true, asks: answeredAsks(replayed) },
        };
      return refuseEffect("already-resolved", `"${effect}"${on} was already resolved as ${prior.verdict}`);
    }
    if (events.some((e) => e.type === "side-effect-done" && namesEffect(e, effect, opts.node)))
      return refuseEffect("already-resolved", `"${effect}"${on} completed; there is nothing to resolve`);
    const pending = replayed.pendingIntents;
    return refuseEffect(
      "no-ambiguous-effect",
      pending.length
        ? `run ${run} has no ambiguous effect "${effect}"${on}; ambiguous now: ${pending.map((i) => `"${i.effect}" on "${i.node}"`).join(", ")}`
        : `nothing is ambiguous in run ${run}`,
    );
  }

  if (candidates.length > 1)
    return refuseEffect(
      "bad-request",
      `"${effect}" is ambiguous on several nodes (${quoted(candidates.map((i) => i.node))}); name one with \`--node <node>\``,
    );

  const intent = candidates[0]!;
  return {
    event: {
      type: "side-effect-resolved",
      node: intent.node,
      visit: intent.visit,
      attempt_id: intent.attempt_id,
      effect: intent.effect,
      verdict,
      by: "operator",
    },
    result: {
      ok: true,
      node: intent.node,
      visit: intent.visit,
      effect: intent.effect,
      verdict,
      idempotent: false,
      asks: standingAsks(replayed),
    },
  };
}

/** the ambiguous-effect park still standing in this snapshot (pre-append) */
const standingAsks = (replayed: ReplayedState): AskRef[] =>
  replayed.parked?.code === "ambiguous-effect" ? [{ node: replayed.parked.node, visit: replayed.parked.visit }] : [];

/** the same park once a resolution has already answered it — an idempotent repeat still clears it */
const answeredAsks = (replayed: ReplayedState): AskRef[] =>
  replayed.answeredPark?.code === "ambiguous-effect"
    ? [{ node: replayed.answeredPark.node, visit: replayed.answeredPark.visit }]
    : standingAsks(replayed);

/**
 * `resolve-effect <run> <effect> happened|not-happened` (HOW-3): a human attests to the
 * outside world for an effect the resume probe could not decide, which is the only exit from
 * an `ambiguous-effect` park that is not hand-editing run.jsonl. Atomic: the "is this effect
 * still ambiguous, and was it already resolved?" check and the append happen inside ONE
 * EventLog.appendIf critical section, so two racing resolutions land exactly one event and
 * the loser reads the winner's (idempotent for the same verdict, refused for the opposite).
 *
 * Refused while a runner is live — it owns its own effects and may be mid-claim — exactly as
 * `jump` and `redesign` are. The caller clears the attention record (`asks`) and resumes.
 */
export function resolveEffect(
  runDir: string,
  effect: string,
  verdict: EffectVerdict,
  opts: { node?: string } = {},
): EffectResult {
  const path = logPathOf(runDir);
  const run = basename(runDir);
  if (!existsSync(path)) return { ok: false, code: "unknown-run", message: `unknown run: ${run}` };
  if (effect.trim() === "") return { ok: false, code: "bad-request", message: "name the effect to resolve" };
  if (!EFFECT_VERDICTS.includes(verdict))
    return { ok: false, code: "bad-request", message: `verdict must be ${EFFECT_VERDICTS.join(" or ")}, not "${verdict}"` };
  // a filesystem fact, not a log fact, so it is checked outside the critical section
  if (runnerAlive(runDir))
    return { ok: false, code: "runner-live", message: "runner is live — pause or abort first, then resolve-effect" };

  // `as`: assigned inside the appendIf callback, which TS's narrowing cannot see
  let result = { ok: false, code: "no-ambiguous-effect", message: `nothing is ambiguous in run ${run}` } as EffectResult;
  new EventLog(path).appendIf((events) => {
    const d = decideEffect(events, run, effect, verdict, opts);
    result = d.result;
    return d.event;
  });
  return result;
}

/**
 * Make sure a runner picks the decision up. Dead runner → spawn one if the run needs it
 * (supervisorShouldResume). Live runner → watch it for `graceMs`: if it exits in that
 * window and the run still needs a runner (it checked for a decision just before ours
 * landed, then parked), spawn one. A runner still alive after the grace owns the run.
 */
export async function wakeRunner(
  runDir: string,
  spawn: () => void,
  opts: {
    graceMs?: number;
    pollMs?: number;
    /** injectable for deterministic tests: liveness probe, wait, clock */
    alive?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<"spawned" | "live" | "idle"> {
  const alive = opts.alive ?? (() => runnerAlive(runDir));
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = opts.now ?? Date.now;
  const needsRunner = () => supervisorShouldResume(replayState(readLog(logPathOf(runDir))), readControl(runDir));
  const settle = (): "spawned" | "idle" => {
    if (!needsRunner()) return "idle";
    spawn();
    return "spawned";
  };
  if (!alive()) return settle();
  const deadline = now() + (opts.graceMs ?? 3000);
  while (now() < deadline) {
    await sleep(opts.pollMs ?? 100);
    if (!alive()) return settle();
  }
  return "live";
}

/** Clear the durable attention records of asks an operator action answered. */
export function clearAsks(attentionDir: string, runDir: string, asks: readonly AskRef[]): void {
  const center = new AttentionCenter(attentionDir, []);
  for (const a of asks) center.resolve(`${basename(runDir)}:${a.node}:${a.visit}`);
}

/**
 * After an accepted decision: wake the runner (not for an idempotent repeat — the first
 * decision already did, and a second wake is a second runner racing for the lock), THEN
 * clear the attention records of the decided round's asks (after, so an ask the runner
 * raised during the grace window is cleared too — otherwise the watchdog would ring for a
 * decided round). A newer round's ask is never cleared.
 */
export async function afterDecision(
  runDir: string,
  result: Extract<DecisionResult, { ok: true }>,
  deps: { attentionDir: string; spawn: () => void; graceMs?: number; pollMs?: number },
): Promise<"spawned" | "live" | "idle" | "already-woken"> {
  const woke = result.idempotent ? "already-woken" : await wakeRunner(runDir, deps.spawn, deps);
  const later = result.proposal_id === null ? [] : asksOfRound(readLog(logPathOf(runDir)), result.proposal_id);
  clearAsks(deps.attentionDir, runDir, [...result.asks, ...later]);
  return woke;
}
