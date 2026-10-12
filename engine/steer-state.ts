/**
 * HOW-47: what became of every operator steer, folded from the log — and which agent turn a
 * new one would reach. NODE-FREE: the read model (web/derive.ts) is bundled into the browser,
 * and the engine's render and reconstruction ask the same questions, so all three share these
 * functions instead of re-deciding. The writing half (precheck + append) is engine/steer.ts.
 */
import type { LoggedEvent } from "../log/events";
import { harnessSpec, isHarness } from "../core/harnesses";

export interface SteerState {
  seq: number;
  node: string;
  visit: number;
  text: string;
  at: string;
  /** the harness echoed it: it landed after `after_tool_id`'s result */
  delivered: { at: string; after_tool_id?: string } | null;
  /** it never reached its turn and was rendered into a later prompt instead */
  carried: { node: string; visit: number; at: string; rendered_hash: string } | null;
}

/** every steer in the run, oldest first, with what became of it */
export function steerStates(events: readonly LoggedEvent[]): SteerState[] {
  const out = new Map<number, SteerState>();
  for (const e of events) {
    if (e.type === "operator-steered")
      out.set(e.seq, { seq: e.seq, node: e.node, visit: e.visit, text: e.text, at: e.ts, delivered: null, carried: null });
    else if (e.type === "steer-delivered") {
      const s = out.get(e.steer_seq);
      if (s && !s.delivered) s.delivered = { at: e.ts, ...(e.after_tool_id !== undefined ? { after_tool_id: e.after_tool_id } : {}) };
    } else if (e.type === "prompt-rendered" && e.steers_carried) {
      for (const seq of e.steers_carried) {
        const s = out.get(seq);
        if (s && !s.carried) s.carried = { node: e.node, visit: e.visit, at: e.ts, rendered_hash: e.rendered_hash };
      }
    }
  }
  return [...out.values()];
}

/**
 * The steers the NEXT render must carry: sent, never delivered, never carried yet. The engine
 * renders strictly after the previous step's executor has returned, so a steer still
 * undelivered here can no longer reach the turn it was sent to.
 */
export function undeliveredSteers(events: readonly LoggedEvent[]): SteerState[] {
  return steerStates(events).filter((s) => !s.delivered && !s.carried);
}

/** the live agent turn a steer would go to, or why there is none */
export function steerTarget(
  events: readonly LoggedEvent[],
  opts: { allowMidTurnAsk?: boolean } = {},
): { ok: true; node: string; visit: number } | { ok: false; message: string } {
  if (!events.some((e) => e.type === "run-started")) return { ok: false, message: "the run has not started" };
  const finished = events.findLast((e) => e.type === "run-finished");
  if (finished?.type === "run-finished") return { ok: false, message: `the run already finished (${finished.outcome}) — there is no agent to steer` };
  let started: Extract<LoggedEvent, { type: "node-started" }> | null = null;
  let paused = false;
  let ask: Extract<LoggedEvent, { type: "attention-raised" }> | null = null;
  for (const e of events) {
    if (e.type === "node-started") { started = e; ask = null; }
    else if (e.type === "run-paused") paused = true;
    else if (e.type === "run-resumed") paused = false;
    else if (e.type === "attention-raised") ask = e;
    else if (e.type === "attention-resolved" || e.type === "operator-jump") ask = null;
  }
  if (paused) return { ok: false, message: "the run is paused — resume it first; a steer only reaches a running turn" };
  if (!started) return { ok: false, message: "no step has started yet" };
  const s = started;
  // HOW-48: a MID-TURN ask (no park code, on this very turn) holds the turn open; a soft stop
  // may be queued behind it and applies after the answer. An engine park never may.
  const midTurnAsk = ask !== null && ask.code === undefined && ask.node === s.node && ask.visit === s.visit;
  if (ask && !(opts.allowMidTurnAsk && midTurnAsk))
    return { ok: false, message: "the run is waiting on you — answer it with a reply, which reaches the agent directly" };
  if (events.some((e) => e.type === "node-finished" && e.node === s.node && e.visit === s.visit))
    return { ok: false, message: `${s.node}@${s.visit} has finished — there is no live turn to steer` };
  const render = events.findLast((e) => e.type === "prompt-rendered" && e.node === s.node && e.visit === s.visit);
  if (!render || render.type !== "prompt-rendered") return { ok: false, message: `${s.node}@${s.visit} is not an agent turn — there is nothing to steer` };
  const harness = render.harness ?? "claude";
  if (!isHarness(harness) || harnessSpec(harness).steer === null)
    return { ok: false, message: `steer: not supported on ${harness} — it has no channel into a running turn yet` };
  return { ok: true, node: s.node, visit: s.visit };
}

/** HOW-48: the soft stop on one node@visit, and how far it got — null when none was asked for */
export interface SoftStopState {
  node: string;
  visit: number;
  requested_at: string;
  state: "requested" | "delivered" | "honored" | "moot";
}

export function softStopState(events: readonly LoggedEvent[], node: string, visit: number): SoftStopState | null {
  let out: SoftStopState | null = null;
  for (const e of events) {
    if (!("node" in e) || e.node !== node || !("visit" in e) || e.visit !== visit) continue;
    if (e.type === "soft-stop-requested" && !out) out = { node, visit, requested_at: e.ts, state: "requested" };
    else if (out && e.type === "soft-stop-delivered" && out.state === "requested") out.state = "delivered";
    else if (out && e.type === "soft-stop-honored") out.state = "honored";
    else if (out && e.type === "soft-stop-moot") out.state = "moot";
  }
  return out;
}

/**
 * HOW-48: the last message a soft-stopped visit of `node` left, for its NEXT visit's render —
 * once. The newest `soft-stop-honored` of this node from an earlier visit, unless a render of
 * this node has already carried it (`resumed_after_stop`).
 */
export function stopResumeFor(events: readonly LoggedEvent[], node: string, visit: number): { seq: number; last_message: string } | null {
  const honored = events.findLast((e) => e.type === "soft-stop-honored" && e.node === node && e.visit < visit);
  if (!honored || honored.type !== "soft-stop-honored") return null;
  const used = events.some((e) => e.type === "prompt-rendered" && e.node === node && e.resumed_after_stop === honored.seq);
  return used ? null : { seq: honored.seq, last_message: honored.last_message };
}
