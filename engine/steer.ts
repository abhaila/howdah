/**
 * HOW-47: steering a running agent — saying something to it mid-turn without pausing it.
 *
 * Pause and Abort both SIGTERM the runner, so "use the existing helper in core/ instead" used
 * to cost the agent its whole session. cwc's `steer.sh` showed the third lever, and a spike
 * against claude 2.1.296 (adapter/fixtures/claude-steer.jsonl) showed Howdah already holds the
 * channel: a stream-json user message written to the claude executor's stdin while a tool call
 * is in flight is delivered at that tool's result boundary, the tool call is not lost, and the
 * CLI echoes the message back as proof (`--replay-user-messages`).
 *
 * This module is the LOG side, shared by everyone who touches a steer:
 *   - `steerRefusal` / `steer` — the precheck and the append, ONE function for the server
 *     route and `howdah steer`, the way `jumpRefusal` is shared. The check runs again INSIDE
 *     the log lock (appendIf), so a turn that ended between the check and the append refuses
 *     rather than queueing a steer for a turn that is gone.
 *   - `steerStates` (engine/steer-state.ts, node-free) — every steer and what became of it,
 *     folded from the log. The engine's render, the read model and reconstruction all ask it.
 *
 * Not a trust boundary in the worktree (cwc's STEER.md is, by its own README, not one): the
 * channel is the run's own log, appended by the operator's server or CLI, never a file the
 * agent can write.
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { EventLog, readLog } from "../log/write";
import { steerTextProblem } from "../core/steer";
import { runnerAlive } from "./control";
import { softStopState, steerTarget } from "./steer-state";

export { steerStates, undeliveredSteers, steerTarget, softStopState, stopResumeFor, type SteerState, type SoftStopState } from "./steer-state";

/**
 * The precheck the route and the CLI share. It needs a PROVEN live runner: a steer to a run
 * whose runner is dead would sit in the log with nothing to deliver it — and resume starts the
 * step over anyway, where the operator should reply or jump instead.
 */
export function steerRefusal(runDir: string, text: unknown): string | null {
  const path = join(runDir, "run.jsonl");
  if (!existsSync(path)) return `unknown run: ${basename(runDir)}`;
  const problem = steerTextProblem(text);
  if (problem) return problem;
  const target = steerTarget(readLog(path));
  if (!target.ok) return target.message;
  if (!runnerAlive(runDir)) return "the runner is not alive — nothing would deliver it; resume the run, then reply or jump instead";
  return null;
}

/** Refuse, or append the steer under the log lock — re-checking the target inside it. */
export function steer(runDir: string, text: string): { ok: true; seq: number; node: string; visit: number } | { ok: false; message: string } {
  const refused = steerRefusal(runDir, text);
  if (refused) return { ok: false, message: refused };
  let lateRefusal: string | null = null;
  const appended = new EventLog(join(runDir, "run.jsonl")).appendIf((events) => {
    const target = steerTarget(events);
    if (!target.ok) { lateRefusal = target.message; return null; }
    return { type: "operator-steered", node: target.node, visit: target.visit, text: text.trim(), by: "operator" };
  });
  if (!appended || appended.type !== "operator-steered") return { ok: false, message: lateRefusal ?? "the turn ended before the steer could be recorded" };
  return { ok: true, seq: appended.seq, node: appended.node, visit: appended.visit };
}

/**
 * HOW-48: "stop at the next tool call" — the soft pause. The same channel as a steer, the same
 * precheck, one difference: a mid-turn ask may be pending (the stop then applies after the
 * answer — awaitOperator is never interrupted). Asking twice for the same turn is idempotent.
 */
export function softStopRefusal(runDir: string): string | null {
  const path = join(runDir, "run.jsonl");
  if (!existsSync(path)) return `unknown run: ${basename(runDir)}`;
  const target = steerTarget(readLog(path), { allowMidTurnAsk: true });
  if (!target.ok) return target.message.replace("steer:", "stop at the next tool call:").replace("nothing to steer", "nothing to stop softly — use Stop now");
  if (!runnerAlive(runDir)) return "the runner is not alive — there is no turn to stop";
  return null;
}

export function softStop(runDir: string): { ok: true; seq: number; node: string; visit: number; already: boolean } | { ok: false; message: string } {
  const refused = softStopRefusal(runDir);
  if (refused) return { ok: false, message: refused };
  let late: string | null = null;
  let existing: { seq: number; node: string; visit: number } | null = null;
  const appended = new EventLog(join(runDir, "run.jsonl")).appendIf((events) => {
    const target = steerTarget(events, { allowMidTurnAsk: true });
    if (!target.ok) { late = target.message; return null; }
    if (softStopState(events, target.node, target.visit)) {
      const prior = events.find((e) => e.type === "soft-stop-requested" && e.node === target.node && e.visit === target.visit)!;
      existing = { seq: prior.seq, node: target.node, visit: target.visit };
      return null;
    }
    return { type: "soft-stop-requested", node: target.node, visit: target.visit, by: "operator" };
  });
  if (existing) return { ok: true, ...(existing as { seq: number; node: string; visit: number }), already: true };
  if (!appended || appended.type !== "soft-stop-requested") return { ok: false, message: late ?? "the turn ended before the stop could be recorded" };
  return { ok: true, seq: appended.seq, node: appended.node, visit: appended.visit, already: false };
}
