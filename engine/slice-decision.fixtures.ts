/**
 * Test fixtures for system-map 1a (shared by engine/slice-decision.test.ts, cli/main.test.ts
 * and web/web.test.ts): hand-written run logs parked on an approval node, built with the
 * same events and the same nextSeq() rule the engine uses, so decision routes can be
 * exercised without running a graph.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { EventLog } from "../log/write";
import type { LoggedEvent } from "../log/events";
import { proposalHash } from "../core/proposal";
import { replayState } from "./replay";
import { nextSeq } from "./slice-decision";

export type Round = Extract<LoggedEvent, { type: "ghost-proposed" }>;

/** one proposer round: ghost-proposed, then the run moves into the approval node and parks */
export function proposeRound(log: EventLog, proposal: unknown, approval = "approve", manifest: string | null = "m1"): Round {
  const visit = (replayState(log.read()).visits["propose"] ?? 0) + 1;
  log.append({ type: "node-started", node: "propose", visit, attempt_id: `propose#${visit}` });
  const ghost = log.appendIf((events) => ({
    type: "ghost-proposed",
    node: "propose",
    approval,
    proposal_id: nextSeq(events),
    proposal_hash: proposalHash(proposal),
    manifest_hash: manifest,
    fingerprint: null,
    proposal,
  })) as Round;
  log.append({ type: "node-finished", node: "propose", visit, status: "succeeded", writes: { proposal } });
  log.append({ type: "edge-taken", from: "propose", to: approval });
  const av = (replayState(log.read()).visits[approval] ?? 0) + 1;
  log.append({ type: "node-started", node: approval, visit: av, attempt_id: `${approval}#${av}` });
  log.append({ type: "attention-raised", node: approval, visit: av, reason: "awaiting", code: "awaiting-approval" });
  return ghost;
}

/** the approval node consumed a decision (outcome feedback) and the proposer drew again */
export function consumeAndRedraw(log: EventLog, proposal: unknown, approval = "approve"): Round {
  const v = replayState(log.read()).visits[approval] ?? 1;
  log.append({ type: "attention-resolved", node: approval, visit: v, reply: "resume", source: "resume" });
  log.append({ type: "node-started", node: approval, visit: v, attempt_id: `${approval}#${v}` });
  log.append({ type: "node-finished", node: approval, visit: v, status: "succeeded", writes: { decision: { outcome: "feedback" }, feedback: [] } });
  log.append({ type: "edge-taken", from: approval, to: "propose" });
  return proposeRound(log, proposal, approval);
}

/** a run dir `<parent>/<id>` whose log is parked awaiting a decision on one round */
export function seedAwaitingRun(
  parent: string,
  id: string,
  opts: { proposal?: unknown; graph?: string; approval?: string; manifest?: string | null } = {},
): { dir: string; log: EventLog; round: Round; events: () => LoggedEvent[] } {
  const dir = join(parent, id);
  mkdirSync(dir, { recursive: true });
  const log = new EventLog(join(dir, "run.jsonl"));
  log.append({ type: "run-started", graph: opts.graph ?? "decide-graph", inputs: { goal: "g" }, pinned_prompts: {} });
  const round = proposeRound(log, opts.proposal ?? { ghosts: ["v1"] }, opts.approval ?? "approve", opts.manifest === undefined ? "m1" : opts.manifest);
  return { dir, log, round, events: () => log.read() };
}
