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
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Graph } from "../core/graph";
import type { LoggedEvent, ParkCode, RunEvent } from "../log/events";
import { EventLog } from "../log/write";
import { pidAlive } from "./attention";
import { rendersReply, replayState } from "./replay";

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

/** Stop a live runner and its direct harness child; the event log remains resumable. */
export async function interruptRunner(runDir: string, graceMs = 500): Promise<boolean> {
  const pidFile = join(runDir, "runner.pid");
  if (!existsSync(pidFile)) return false;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isFinite(pid) || pid <= 0 || !pidAlive(pid)) return false;
  try {
    Bun.spawnSync(["pkill", "-TERM", "-P", String(pid)]);
    process.kill(pid, "SIGTERM");
    await Bun.sleep(graceMs);
    if (pidAlive(pid)) process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
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
  "executor-threw": retryWithReply,
  "max-visits": useJump,
  "no-edge": useJump,
  "max-steps": useJump,
  "ambiguous-effect": ({ run }) => ({
    accept: false,
    message: `a side effect may or may not have happened; resolve the effect first, then \`resume ${run}\``,
  }),
  "awaiting-approval": () => ({
    accept: false,
    message: "the run is waiting on an approval; use approve / send-feedback / redesign",
  }),
  "approval-missing": ({ run }) => ({
    accept: false,
    message: `this step requires an approval that is missing; use \`approve ${run}\`, or \`redesign ${run} <msg>\``,
  }),
  "stale-base": ({ run }) => ({
    accept: false,
    message: `the approved design no longer matches the code; use \`redesign ${run} <msg>\` (re-extracts)`,
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
    const verdict = REPLY_RULES[ask.code]({ node: ask.node, run, kind: def?.kind, retryOverBudget: overBudget ? maxVisits : undefined });
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
