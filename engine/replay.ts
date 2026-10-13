/**
 * Resume-by-replay (R7 / A4.2): a run's only persistent state IS its event log. This
 * module folds the log back into engine state — visits, published context, position,
 * unresolved side-effect intents, park status. No secondary state file can drift,
 * because there is no secondary state file.
 *
 * Budget floors (system-map 0.3): an operator-jump with `reset_budgets` records, for every
 * node, the visit count at that moment. The engine's maxVisits check counts visits ABOVE
 * the floor, so a jump after a maxVisits park buys a fresh budget without renumbering
 * anything — `${node}#${visit}` attempt ids, side-effect attempt_ids and the viewer's
 * `${node}@${visit}` rows all treat visit numbers as identity, so they only ever climb.
 *
 * Reply notes (system-map 0.2): an OPERATOR reply to a park whose code is renderable (a
 * failed or throwing agent attempt) becomes `replyNote`, consumed by the next attempt of
 * that node — exactly like jumpNote. resume()'s own resolution never becomes one, nor
 * does a reply to a legacy (code-less) ask: those keep their pre-0.2 meaning, "logged,
 * not rendered". A later operator-jump supersedes the reply, as it supersedes the park.
 * rendersReply() is the one statement of that rule — replay, resolveReply and
 * reconstructRender all call it.
 *
 * A note is consumed by an attempt that FINISHES, not one that merely started: at
 * node-started it moves in flight, at that node's node-finished it is gone. If the log
 * ends mid-flight on that node (the runner died inside the attempt), resume re-attempts
 * the same visit, so the note is restored for it — otherwise a crash would silently eat
 * the operator's words.
 *
 * Refusal notes (system-map 1c review): a failed attempt whose PROPOSAL the graph refused
 * (node-finished.refused) leaves `refusalNote` — the validator's text — for that node's next
 * attempt, which renders it (suffix v3), so the proposer is told what to fix. Same lifecycle as
 * a reply note (in flight at node-started, restored for a re-attempt of an attempt that died,
 * dropped by an operator-jump — a redesign restarts the design conversation), except that it
 * is consumed only by a SUCCESSFUL finish of that node — a proposal that was accepted. A retry
 * that fails for another reason keeps it pending; a newer refusal replaces it.
 *
 * Decision-resolved parks (system-map 1a, D17): an `awaiting-approval` park counts as
 * RESOLVED once engine/slice-decision.ts finds a decision for the current proposal round —
 * the decision event alone is enough. A route that appended the decision and died before
 * appending the resolution leaves `parked` null here (the ask moves to `answeredPark`),
 * so `howdah up` resumes the run on its next tick instead of waiting forever. The awaiting
 * node itself never logged node-finished, so `position` keeps it mid-flight and resume
 * re-attempts the SAME visit: waiting never consumes a visit.
 *
 * Effect-resolved parks (HOW-3): the same rule for `ambiguous-effect`. An operator's
 * `side-effect-resolved` answers the park it was raised for as soon as it lands — every
 * intent the park named is gone from `pendingIntents`, so there is nothing left to be
 * ambiguous about. Without this, a resolution whose spawned resume died would leave the run
 * parked forever and `supervisorShouldResume` would skip it: the very dead end the verb
 * exists to remove.
 */
import { resolutionSource, type LoggedEvent, type ParkCode, type RunEvent } from "../log/events";
import { decisionAnswers } from "./slice-decision";

/**
 * Park codes whose reply is carried into the retried prompt. Whether the node can carry it
 * (only agent nodes render a prompt) is resolveReply's check — it refuses the reply on any
 * other kind, so no renderable-code reply ever lands on a command or worktree node.
 * HOW-14: `context-exhausted` is one — a reply ("skip the docs, just land the migration")
 * is exactly what helps a retry that is re-entering half-done work.
 */
export const RENDERABLE_REPLY_CODES: ReadonlySet<ParkCode> = new Set<ParkCode>(["attempt-failed", "executor-threw", "context-exhausted", "stuck", "turn-timeout"]);

/**
 * HOW-38: parks whose REASON is itself a fact the retry needs — the call that kept failing,
 * or the ceiling that was hit — so the rendered reply carries it after the operator's words.
 * Derived from the logged ask, so reconstruction rebuilds the identical text.
 */
const REASON_CARRYING_CODES: ReadonlySet<ParkCode> = new Set<ParkCode>(["stuck", "turn-timeout"]);

type Ask = Extract<LoggedEvent, { type: "attention-raised" }>;
type Resolution = Pick<Extract<RunEvent, { type: "attention-resolved" }>, "node" | "reply" | "source">;

/**
 * THE reply-rendering rule: does this resolution of this ask put the reply into the next
 * prompt? Only an operator's non-blank reply, to a park with a renderable code, on the
 * same node. Returns the message to render, or null.
 */
export function rendersReply(ask: Ask | null, resolution: Resolution): string | null {
  const message = resolution.reply;
  if (message === undefined || message.trim() === "") return null;
  if (resolutionSource(resolution) !== "operator") return null;
  if (!ask || ask.code === undefined || !RENDERABLE_REPLY_CODES.has(ask.code) || ask.node !== resolution.node) return null;
  if (REASON_CARRYING_CODES.has(ask.code)) return `${message}\n\n(The previous attempt was stopped by the harness — ${ask.reason})`;
  return message;
}

type Note = { node: string; message: string };

export interface ReplayedState {
  started: Extract<LoggedEvent, { type: "run-started" }> | null;
  finished: Extract<LoggedEvent, { type: "run-finished" }> | null;
  /** visits already consumed per node (the last LOGGED visit — a maxVisits park is not one) */
  visits: Record<string, number>;
  /** per-node maxVisits floor set by the latest reset_budgets jump; absent = 0 */
  floors: Record<string, number>;
  /** node-finished events in log order — re-applied through the ContextStore to rebuild scopes */
  finishes: Extract<LoggedEvent, { type: "node-finished" }>[];
  /** where the run is: the last edge target, or a node that started but never finished */
  position: { node: string; midFlight: boolean } | null;
  /** side-effect intents with no matching done — AMBIGUOUS, must be probed before retry */
  pendingIntents: Extract<LoggedEvent, { type: "side-effect-intent" }>[];
  /** effect keys proven complete (done written) — executors skip these on re-attempt */
  completedEffects: Set<string>;
  /** attention raised and not yet resolved (a decided awaiting-approval park is resolved: D17) */
  parked: Extract<LoggedEvent, { type: "attention-raised" }> | null;
  /**
   * A park an OPERATOR ACTION answered — an approval decision (D17) or an effect resolution
   * (HOW-3) — that no attention-resolved has closed yet. Resume closes it; `howdah up` treats
   * the run as resumable meanwhile.
   */
  answeredPark: Extract<LoggedEvent, { type: "attention-raised" }> | null;
  /** run-paused with no later run-resumed */
  paused: boolean;
  /** operator-jump message not yet consumed by an attempt of the target node */
  jumpNote: { node: string; message: string } | null;
  /** system-map 0.2: operator reply not yet consumed by the next attempt of the parked node */
  replyNote: { node: string; message: string } | null;
  /** system-map 1c: why the node's last proposal was refused, for its next attempt */
  refusalNote: { node: string; message: string } | null;
}

export const effectKey = (attemptId: string, effect: string): string => `${attemptId}\0${effect}`;

/** the note an attempt of `node` carries: a pending one, else the unfinished one it is re-attempting */
function takeNote(pending: Note | null, inFlight: Note | null, node: string): Note | null {
  if (pending?.node === node) return pending;
  if (inFlight?.node === node) return inFlight;
  return null;
}

/**
 * Has an operator action already answered this park, even though no attention-resolved has
 * landed? D17 for an approval decision; HOW-3 for an ambiguous effect.
 *
 * The effect rule needs BOTH halves. A `side-effect-resolved` after the park is the operator
 * action (the park cannot be answered by the mere absence of intents — a log with no intent
 * at all never became ambiguous by itself), and no intent may still be pending, because
 * resuming would only probe that one and park again.
 */
function parkAnswered(events: LoggedEvent[], ask: Ask, pending: readonly unknown[]): boolean {
  if (ask.code === "ambiguous-effect")
    return pending.length === 0 && events.some((e) => e.type === "side-effect-resolved" && e.seq > ask.seq);
  return decisionAnswers(events, ask);
}

export function replayState(events: LoggedEvent[]): ReplayedState {
  const state: ReplayedState = {
    started: null,
    finished: null,
    visits: {},
    floors: {},
    finishes: [],
    position: null,
    pendingIntents: [],
    completedEffects: new Set(),
    parked: null,
    answeredPark: null,
    paused: false,
    jumpNote: null,
    replyNote: null,
    refusalNote: null,
  };
  const intents = new Map<string, Extract<LoggedEvent, { type: "side-effect-intent" }>>();
  // notes taken by the attempt in flight — dropped when it finishes, restored if it never did
  let inFlightJump: Note | null = null;
  let inFlightReply: Note | null = null;
  let inFlightRefusal: Note | null = null;

  for (const e of events) {
    switch (e.type) {
      case "run-started":
        state.started = e;
        break;
      case "run-finished":
        state.finished = e;
        break;
      case "node-started":
        state.visits[e.node] = Math.max(state.visits[e.node] ?? 0, e.visit);
        state.position = { node: e.node, midFlight: true };
        // taken by this attempt; consumed only once it finishes (see header)
        // a re-attempt of an attempt that crashed keeps that attempt's unfinished note:
        // two crashes in a row must not lose the operator's words (node-finished and
        // operator-jump are what clear an in-flight note)
        inFlightJump = takeNote(state.jumpNote, inFlightJump, e.node);
        inFlightReply = takeNote(state.replyNote, inFlightReply, e.node);
        inFlightRefusal = takeNote(state.refusalNote, inFlightRefusal, e.node);
        if (inFlightJump) state.jumpNote = null;
        if (inFlightReply) state.replyNote = null;
        if (inFlightRefusal) state.refusalNote = null;
        break;
      case "node-finished":
        state.finishes.push(e);
        if (state.position?.node === e.node) state.position.midFlight = false;
        if (inFlightJump?.node === e.node) inFlightJump = null;
        if (inFlightReply?.node === e.node) inFlightReply = null;
        if (e.status === "failed" && e.refused !== undefined) state.refusalNote = { node: e.node, message: e.refused };
        // kept until a proposal is ACCEPTED: an attempt that failed for another reason (it
        // threw, broke the outputs contract) never got its draft checked, so the next one
        // must still be told what was wrong with the last refused draft
        else if (inFlightRefusal?.node === e.node && e.status === "failed") state.refusalNote = inFlightRefusal;
        if (inFlightRefusal?.node === e.node) inFlightRefusal = null;
        break;
      case "edge-taken":
        state.position = { node: e.to, midFlight: false };
        break;
      case "side-effect-intent":
        intents.set(effectKey(e.node, e.effect), e);
        break;
      case "side-effect-done": {
        const key = effectKey(e.node, e.effect);
        intents.delete(key);
        state.completedEffects.add(key);
        break;
      }
      case "side-effect-resolved": {
        // HOW-3: the operator's attestation. Either way the intent stops being ambiguous.
        const key = effectKey(e.node, e.effect);
        intents.delete(key);
        // `not-happened` never REMOVES a completed key: a proven done outranks an attestation
        if (e.verdict === "happened") state.completedEffects.add(key);
        break;
      }
      case "attention-raised":
        state.parked = e;
        break;
      case "attention-resolved": {
        const message = rendersReply(state.parked, e);
        if (message !== null) state.replyNote = { node: e.node, message };
        state.parked = null;
        break;
      }
      case "run-paused":
        state.paused = true;
        break;
      case "run-resumed":
        state.paused = false;
        break;
      case "operator-jump":
        state.position = { node: e.to, midFlight: false };
        state.jumpNote = e.message ? { node: e.to, message: e.message } : null;
        state.parked = null; // the jump supersedes whatever the run was stuck on
        state.replyNote = null; // ...and whatever the operator replied to it
        state.refusalNote = null; // ...and a refused draft the operator walked away from
        inFlightJump = inFlightReply = inFlightRefusal = null; // an abandoned attempt's notes go with it
        // system-map 0.3: every node, not just the target — the operator owns the run now.
        // A node never visited has visits 0 = no floor, so iterating visits covers them all.
        if (e.reset_budgets) for (const [node, v] of Object.entries(state.visits)) state.floors[node] = v;
        break;
    }
  }
  state.pendingIntents = [...intents.values()];
  if (state.parked && parkAnswered(events, state.parked, state.pendingIntents)) {
    state.answeredPark = state.parked;
    state.parked = null;
  }
  // died mid-attempt: resume re-attempts the SAME visit, which must still carry its notes
  if (state.position?.midFlight) {
    if (inFlightJump?.node === state.position.node) state.jumpNote = inFlightJump;
    if (inFlightReply?.node === state.position.node) state.replyNote = inFlightReply;
    if (inFlightRefusal?.node === state.position.node) state.refusalNote = inFlightRefusal;
  }
  return state;
}
