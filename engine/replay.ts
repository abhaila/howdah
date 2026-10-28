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
 * Parallel steps (HOW-73): a branch's `node-started` carries `parallel`, and does NOT move
 * `position` — the run stays mid-flight on the parallel step until that step's own
 * node-finished, which the engine logs only once every branch has succeeded.
 * `parallelProgress()` says which branches of one parallel visit succeeded, failed or are in
 * flight. Notes are kept in flight PER STEP, because several branches can be in flight at once,
 * and asks are kept open per step@visit, so two branches' mid-turn questions can stand together:
 * `parked` is the earliest still open, and an `attention-resolved` closes the one it names.
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
 * is exactly what helps a retry that is re-entering half-done work. HOW-48's
 * `paused-by-operator` and HOW-54's `no-progress` are both retried with REPLY_RULES
 * retryWithReply, so both must render here too — a reply accepted and then never shown to the
 * agent is the operator's words silently dropped.
 */
export const RENDERABLE_REPLY_CODES: ReadonlySet<ParkCode> = new Set<ParkCode>([
  "attempt-failed", "executor-threw", "context-exhausted", "stuck", "turn-timeout",
  // HOW-48: the agent stopped where the operator asked; the reply says how to carry on
  "paused-by-operator",
  // HOW-54: the repair changed nothing; the reply says what to do differently this time
  "no-progress",
]);

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
  // notes taken by an attempt in flight, BY STEP (HOW-73: several branches can be in flight) —
  // dropped when it finishes, restored if it never did
  const inFlightJump = new Map<string, Note>();
  const inFlightReply = new Map<string, Note>();
  const inFlightRefusal = new Map<string, Note>();
  // steps that started and have not finished: where a crash leaves notes to restore
  const open = new Set<string>();
  // asks still standing, oldest first (HOW-73: two branches may ask at once)
  let asks: Ask[] = [];

  for (const e of events) {
    switch (e.type) {
      case "run-started":
        state.started = e;
        break;
      case "run-finished":
        state.finished = e;
        break;
      case "node-started": {
        state.visits[e.node] = Math.max(state.visits[e.node] ?? 0, e.visit);
        // HOW-73: a branch runs INSIDE its parallel step's visit — the run stays there
        if (!e.parallel) state.position = { node: e.node, midFlight: true };
        open.add(e.node);
        // taken by this attempt; consumed only once it finishes (see header)
        // a re-attempt of an attempt that crashed keeps that attempt's unfinished note:
        // two crashes in a row must not lose the operator's words (node-finished and
        // operator-jump are what clear an in-flight note)
        const take = (pending: Note | null, inFlight: Map<string, Note>): boolean => {
          const note = takeNote(pending, inFlight.get(e.node) ?? null, e.node);
          if (note) inFlight.set(e.node, note);
          return note !== null;
        };
        if (take(state.jumpNote, inFlightJump)) state.jumpNote = null;
        if (take(state.replyNote, inFlightReply)) state.replyNote = null;
        if (take(state.refusalNote, inFlightRefusal)) state.refusalNote = null;
        break;
      }
      case "node-finished": {
        state.finishes.push(e);
        open.delete(e.node);
        if (state.position?.node === e.node) state.position.midFlight = false;
        inFlightJump.delete(e.node);
        inFlightReply.delete(e.node);
        const refusal = inFlightRefusal.get(e.node);
        if (e.status === "failed" && e.refused !== undefined) state.refusalNote = { node: e.node, message: e.refused };
        // kept until a proposal is ACCEPTED: an attempt that failed for another reason (it
        // threw, broke the outputs contract) never got its draft checked, so the next one
        // must still be told what was wrong with the last refused draft
        else if (refusal && e.status === "failed") state.refusalNote = refusal;
        inFlightRefusal.delete(e.node);
        break;
      }
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
        // an ENGINE park (it has a code) is raised only once no turn is live, so it is the one
        // thing standing — exactly the old single-ask rule. A mid-turn ask (no code) stands
        // beside other steps' mid-turn asks (HOW-73) and replaces an older one of its own step.
        asks = e.code !== undefined ? [e] : [...asks.filter((a) => a.node !== e.node), e];
        break;
      case "attention-resolved": {
        // the ask it answers: the one on its own step@visit (HOW-73), else — a resolution that
        // names nothing standing, as resume's bookkeeping can — the latest, as before
        const answered = asks.findLast((a) => a.node === e.node && a.visit === e.visit) ?? asks.at(-1) ?? null;
        const message = rendersReply(answered, e);
        if (message !== null) state.replyNote = { node: e.node, message };
        asks = answered && answered.node === e.node && answered.visit === e.visit
          ? asks.filter((a) => !(a.node === e.node && a.visit === e.visit))
          : [];
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
        asks = []; // the jump supersedes whatever the run was stuck on
        state.replyNote = null; // ...and whatever the operator replied to it
        state.refusalNote = null; // ...and a refused draft the operator walked away from
        // an abandoned attempt's notes go with it
        inFlightJump.clear(); inFlightReply.clear(); inFlightRefusal.clear(); open.clear();
        // system-map 0.3: every node, not just the target — the operator owns the run now.
        // A node never visited has visits 0 = no floor, so iterating visits covers them all.
        if (e.reset_budgets) for (const [node, v] of Object.entries(state.visits)) state.floors[node] = v;
        break;
    }
  }
  state.pendingIntents = [...intents.values()];
  state.parked = asks[0] ?? null;
  if (state.parked && parkAnswered(events, state.parked, state.pendingIntents)) {
    state.answeredPark = state.parked;
    state.parked = null;
  }
  // died mid-attempt: resume re-attempts the SAME visit, which must still carry its notes
  // (HOW-73: or a branch of the parallel step it is in — every step still open)
  if (state.position?.midFlight) {
    for (const node of open) {
      const [jump, reply, refusal] = [inFlightJump.get(node), inFlightReply.get(node), inFlightRefusal.get(node)];
      if (jump) state.jumpNote = jump;
      if (reply) state.replyNote = reply;
      if (refusal) state.refusalNote = refusal;
    }
  }
  return state;
}

/** HOW-73: what each branch of one parallel visit has done, from the log alone */
export interface ParallelProgress {
  /** branches with a SUCCEEDED attempt in this parallel visit — never re-run */
  succeeded: Set<string>;
  /** branches whose latest attempt in this visit started and never finished, by that visit */
  inFlight: Map<string, number>;
  /** branches whose latest attempt in this visit failed */
  failed: Set<string>;
}

export function parallelProgress(events: readonly LoggedEvent[], parallelNode: string, parallelVisit: number): ParallelProgress {
  const latest = new Map<string, { visit: number; status: "running" | "succeeded" | "failed" }>();
  const succeeded = new Set<string>();
  for (const e of events) {
    if (e.type === "node-started" && e.parallel?.node === parallelNode && e.parallel.visit === parallelVisit)
      latest.set(e.node, { visit: e.visit, status: "running" });
    else if (e.type === "node-finished") {
      const l = latest.get(e.node);
      if (l && l.visit === e.visit && l.status === "running") {
        l.status = e.status;
        if (e.status === "succeeded") succeeded.add(e.node);
      }
    } else if (e.type === "operator-jump") {
      latest.clear();
      succeeded.clear();
    }
  }
  const inFlight = new Map<string, number>();
  const failed = new Set<string>();
  for (const [node, l] of latest) {
    if (succeeded.has(node)) continue;
    if (l.status === "running") inFlight.set(node, l.visit);
    else if (l.status === "failed") failed.add(node);
  }
  return { succeeded, inFlight, failed };
}
