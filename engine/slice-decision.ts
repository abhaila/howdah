/**
 * Proposal rounds and decisions (system-map 1a, D7/6A, D15, D17) — the ONLY place that
 * answers "what is the current proposal, and what was decided about it?". The approval
 * executor, the engine's `requires` gate, replay (decision-resolved parks), the derive
 * layer and the decision routes (engine/control.ts) all ask here, so the rule cannot drift
 * between the thing that waits and the thing that decides.
 *
 * Every answer is a pure fold over the run log — no sidecar state (the log is the only
 * storage). Only decision EVENTS count, never `attention-resolved`: resume() auto-resolves
 * parks, so a resolution proves nothing about what the operator decided.
 *
 * One proposal round, per approval node:
 *
 *                        ghost-proposed (proposal_id = its seq)
 *                                   │
 *                                   ▼
 *        comment-pinned* ──▶  ┌──────────┐
 *        (this round only)    │ proposed │── worktree fingerprint changed ──▶ stale
 *                             └──────────┘   (approval executor probe; no event —
 *                                   │         the decision key says outcome "stale")
 *            first decision event   │
 *            for this proposal_id   ▼
 *                  ┌────────────────┴────────────────┐
 *                  ▼                                 ▼
 *          decided: approved                 decided: feedback
 *          (slice-approved)                  (slice-feedback-sent + comment_ids)
 *
 *   - The FIRST decision event of a round is the decision; a later one is never written
 *     (the routes refuse a different decision and treat the same one as a no-op).
 *   - A newer ghost-proposed supersedes the round: its decisions and comments stay in the
 *     log as history but answer nothing about the current proposal. An identical redraw is
 *     a new round (new seq), so it is decidable.
 */
import type { Fingerprint, LoggedEvent } from "../log/events";
import { proposalHash } from "../core/proposal";
import { isFingerprint } from "./reconcile";

export type GhostProposed = Extract<LoggedEvent, { type: "ghost-proposed" }>;
export type DecisionEvent = Extract<LoggedEvent, { type: "slice-approved" | "slice-feedback-sent" }>;
export type CommentPinned = Extract<LoggedEvent, { type: "comment-pinned" }>;

/** The value an approval node writes to its `decision` key (per-visit). */
export interface ApprovalDecision {
  outcome: "approved" | "feedback" | "stale";
  proposal_id: number;
  proposal_hash: string;
  manifest_hash: string | null;
  /** stale only: what moved, e.g. "worktree changed during slice.propose: tracked changes differ" */
  reason?: string;
}

/** One entry of an approval node's `feedback` key (sticky) — what the proposer reads. */
export type FeedbackItem =
  | { source: "comment"; id: string; entity_id: string; text: string }
  | { source: "redesign"; text: string };

/** The shape an approval node's `base` key must hold (1c: map:extract writes it). */
export interface BaseSnapshot {
  manifest_hash: string | null;
  /** required: an approval binds to a git work tree (engine/reconcile.ts fingerprint) */
  fingerprint: Fingerprint;
  commit?: string | null;
}

/** The latest round, optionally for one approval node. */
export function currentProposal(events: readonly LoggedEvent[], approval?: string): GhostProposed | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "ghost-proposed" && (approval === undefined || e.approval === approval)) return e;
  }
  return null;
}

/** The FIRST decision event for that round, or null while it is undecided. */
export function findDecision(events: readonly LoggedEvent[], proposalId: number): DecisionEvent | null {
  for (const e of events)
    if ((e.type === "slice-approved" || e.type === "slice-feedback-sent") && e.proposal_id === proposalId) return e;
  return null;
}

export const decisionKind = (d: DecisionEvent): "approved" | "feedback" => (d.type === "slice-approved" ? "approved" : "feedback");

/**
 * Is THIS proposal, drawn against THIS base, approved? True only when the current round's
 * decision is an approval AND it binds to the same proposal bytes (proposalHash) and the
 * same manifest — a redraw, a changed base, or feedback all answer false.
 */
export function isApproved(
  events: readonly LoggedEvent[],
  proposal: unknown,
  manifestHash: string | null,
  approval?: string,
): boolean {
  const round = currentProposal(events, approval);
  if (!round) return false;
  const decision = findDecision(events, round.proposal_id);
  return (
    decision?.type === "slice-approved" &&
    decision.proposal_hash === round.proposal_hash &&
    decision.proposal_hash === proposalHash(proposal) &&
    decision.manifest_hash === manifestHash
  );
}

/** The comments pinned to a round, in pin order. */
export function roundComments(events: readonly LoggedEvent[], proposalId: number): CommentPinned[] {
  return events.filter((e): e is CommentPinned => e.type === "comment-pinned" && e.proposal_id === proposalId);
}

/** The comments a feedback decision sent, as the feedback key carries them. */
export function feedbackItems(events: readonly LoggedEvent[], decision: DecisionEvent): FeedbackItem[] {
  if (decision.type !== "slice-feedback-sent") return [];
  const byId = new Map(roundComments(events, decision.proposal_id).map((c) => [c.id, c]));
  return decision.comment_ids.flatMap((id) => {
    const c = byId.get(id);
    return c ? [{ source: "comment" as const, id: c.id, entity_id: c.entity_id, text: c.text }] : [];
  });
}

/**
 * D17: does a decision answer this `awaiting-approval` park? True once the park's approval
 * node has a decision for its current round — whether or not anyone appended the
 * resolution, so a route that crashed between the decision and the resolution still lets
 * `howdah up` resume the run.
 */
export function decisionAnswers(events: readonly LoggedEvent[], park: { node: string; code?: string }): boolean {
  if (park.code !== "awaiting-approval") return false;
  const round = currentProposal(events, park.node);
  return round !== null && findDecision(events, round.proposal_id) !== null;
}

/**
 * Redesign seeding (D22) — the contract 1c's map:extract relies on. A
 * `slice-redesign-requested` for approval node A is UNCONSUMED until A's `redesignTo` node
 * (the seeder) next succeeds having published A's feedback key. The engine calls this when
 * the seeder succeeds and writes the messages into the feedback key (engine-owned on that
 * node: see core/graph.ts), so a message reaches the proposer's prompt through that key
 * exactly once — the next write of the key (the approval node's own, after the redraw)
 * replaces it. Only the seeder consumes: an approval node finishing never swallows a
 * request, and requests for another approval node are never delivered here. A failed
 * seeding attempt publishes nothing, so the message waits for the retry.
 */
export function pendingRedesigns(
  events: readonly LoggedEvent[],
  approval: string,
  seeder: string,
  feedbackKey: string,
): FeedbackItem[] {
  let pending: FeedbackItem[] = [];
  for (const e of events) {
    if (e.type === "slice-redesign-requested" && e.approval === approval) pending.push({ source: "redesign", text: e.message });
    else if (e.type === "node-finished" && e.node === seeder && e.status === "succeeded" && feedbackKey in e.writes) pending = [];
  }
  return pending;
}

/**
 * The awaiting-approval asks a decision on round `proposalId` answers: the approval node's
 * asks raised after that round opened and before the next round of the same node — never a
 * newer round's ask (its attention record must keep ringing).
 */
export function asksOfRound(events: readonly LoggedEvent[], proposalId: number): Array<{ node: string; visit: number }> {
  const round = events.find((e): e is GhostProposed => e.type === "ghost-proposed" && e.proposal_id === proposalId);
  if (!round) return [];
  const next = events.find((e) => e.type === "ghost-proposed" && e.approval === round.approval && e.seq > round.seq);
  return events.flatMap((e) =>
    e.type === "attention-raised" && e.code === "awaiting-approval" && e.node === round.approval && e.seq > round.seq && (!next || e.seq < next.seq)
      ? [{ node: e.node, visit: e.visit }]
      : [],
  );
}

/** Read an approval node's `base` value, refusing a malformed one loudly (an engine or graph bug). */
export function readBase(value: unknown, key: string): BaseSnapshot {
  if (typeof value !== "object" || value === null) throw new Error(`base "${key}" is not an object: ${JSON.stringify(value)}`);
  const v = value as Record<string, unknown>;
  const manifest = v.manifest_hash ?? null;
  if (manifest !== null && typeof manifest !== "string") throw new Error(`base "${key}".manifest_hash must be a string or null`);
  const fp = v.fingerprint ?? null;
  if (fp === null) throw new Error(`base "${key}" has no fingerprint — an approval needs a git work tree to bind the design to`);
  if (!isFingerprint(fp)) throw new Error(`base "${key}".fingerprint must be a fingerprint ({head, tracked, untracked})`);
  return { manifest_hash: manifest, fingerprint: fp, commit: typeof v.commit === "string" ? v.commit : null };
}

/** "14:02" in local time — how a refusal names when the earlier decision landed. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * The seq the NEXT append will be stamped with, computed inside EventLog.appendIf's build
 * (which runs under the log lock over every complete event): the writer stamps tail + 1,
 * and a torn tail is neither in `events` nor counted by the writer. This is how a round's
 * proposal_id and a comment's id equal their own event's seq — callers re-check the stamp.
 */
export function nextSeq(events: readonly LoggedEvent[]): number {
  return (events.at(-1)?.seq ?? 0) + 1;
}
