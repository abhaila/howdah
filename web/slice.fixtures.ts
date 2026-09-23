/**
 * Test fixtures for the slice read model and its UI (system-map 1d): a hand-stamped run log
 * with proposal rounds, decisions, comments, extraction and drift events. Shared by
 * web/slice.test.ts (deriveSlice) and web/app/slice.test.tsx (components), so the components
 * are tested against the real read model rather than a hand-written view object.
 */
import type { LoggedEvent, RunEvent } from "../log/events";
import type { DriftItem, DriftOutcome } from "../map/drift";
import { emptyCounts } from "../map/drift";

/** Appends events with seq 1,2,3… and ts one minute apart from 14:00 local time. */
export class FakeLog {
  readonly events: LoggedEvent[] = [];
  private readonly start = new Date(2026, 8, 19, 14, 0, 0).getTime();
  add(e: RunEvent): LoggedEvent {
    const seq = this.events.length + 1;
    const stamped = { ...e, seq, ts: new Date(this.start + (seq - 1) * 60_000).toISOString() } as LoggedEvent;
    this.events.push(stamped);
    return stamped;
  }
  get last(): LoggedEvent {
    return this.events.at(-1)!;
  }
}

export const ROUTE = "GET /users/{*}";
export const FIND = "com.x.Users.find(String)";
export const LOAD = "web/src/users#load";
export const HANDLER_EDGE = `${ROUTE}→${FIND}:route-handler`;

/** A ghost set touching every op, with an edge, a trace and prose. */
export function ghostsV1() {
  return {
    blocks: [
      { id: "api", op: "modify", responsibility: "serves the user API" },
      { id: "web/src", op: "keep", responsibility: "the React app" },
    ],
    entities: [
      { id: ROUTE, op: "add", block: "api", kind: "route", expected_file: "api/src/Routes.kt" },
      { id: FIND, op: "modify", block: "api", kind: "function", expected_file: "api/src/Users.kt", names: ["find"] },
      { id: "com.x.Users.legacy()", op: "remove", block: "api", kind: "function", expected_file: "api/src/Users.kt" },
      { id: LOAD, op: "keep", block: "web/src", kind: "function", expected_file: "web/src/users.ts" },
    ],
    edges: [{ from: ROUTE, to: FIND, kind: "route-handler", op: "add" }],
    trace: [{ scenario: "load a user", steps: [LOAD, ROUTE, FIND] }],
  };
}

/** The redraw: keeps the route and FIND, drops `legacy()` and LOAD. */
export function ghostsV2() {
  const v1 = ghostsV1();
  return { ...v1, entities: v1.entities.filter((e) => e.id === ROUTE || e.id === FIND), blocks: v1.blocks.slice(0, 1), trace: [] };
}

/**
 * HOW-23: a plan-feature proposal — a SLICE PLAN rather than a ghost set. Nothing in it is an
 * identity key, which is the point: the operator judges the decomposition, not the map.
 */
export function planV1() {
  return {
    feature: "let users delete their account",
    slices: [
      { id: "api-route", title: "DELETE /api/users/{id}", goal: "the route exists", work: "add the route", verify: "curl it", depends_on: [] },
      { id: "web-client", title: "Call it from the web", workspace: "web", goal: "the client can delete", work: "add deleteUser", verify: "click delete", depends_on: ["api-route"] },
    ],
    out_of_scope: ["the admin UI"],
    risks: ["the delete is not reversible"],
  };
}

/** The base snapshot the tiers come from (a slice of an AssembledMap). */
export const SNAPSHOT = {
  blocks: [{ key: "api", tier: "syntactic" }, { key: "web/src", tier: "syntactic" }],
  entities: [
    { key: FIND, tier: "syntactic", block: "api" },
    { key: "com.x.Users.legacy()", tier: "syntactic", block: "api" },
    { key: LOAD, tier: "resolved", block: "web/src" },
  ],
  edges: [],
} as never;

export function started(log: FakeLog, graph = "implement-slice"): void {
  log.add({ type: "run-started", graph, inputs: { goal: "add a user endpoint" }, pinned_prompts: {} });
}

/** propose → ghost-proposed → the approval node starts. Returns the round's proposal_id. */
export function proposeRound(log: FakeLog, proposal: unknown, visit = 1): number {
  log.add({ type: "node-started", node: "slice.propose", visit, attempt_id: `slice.propose#${visit}` });
  const proposalId = log.events.length + 1;
  log.add({
    type: "ghost-proposed", node: "slice.propose", approval: "slice.approve", proposal_id: proposalId,
    proposal_hash: `h${proposalId}`, manifest_hash: "m1", fingerprint: null, proposal,
  });
  log.add({ type: "node-finished", node: "slice.propose", visit, status: "succeeded", writes: { "slice.ghosts": proposal } });
  log.add({ type: "node-started", node: "slice.approve", visit, attempt_id: `slice.approve#${visit}` });
  return proposalId;
}

/** proposeRound, then the approval node parks awaiting a decision. Returns the round's proposal_id. */
export function proposeAndPark(log: FakeLog, proposal: unknown, visit = 1): number {
  const proposalId = proposeRound(log, proposal, visit);
  log.add({ type: "attention-raised", node: "slice.approve", visit, reason: "awaiting your decision on the proposed design", code: "awaiting-approval" });
  return proposalId;
}

/** The approval node's attempt failed and the run parked on it (engine/run.ts attempt-failed). */
export function failApproval(log: FakeLog, visit = 1, reason = "approval executor threw: base unreadable"): void {
  log.add({ type: "node-finished", node: "slice.approve", visit, status: "failed", writes: {} });
  log.add({ type: "attention-raised", node: "slice.approve", visit, reason, code: "attempt-failed" });
}

export function pin(log: FakeLog, proposalId: number, entityId: string, text: string): string {
  const id = `c${log.events.length + 1}`;
  log.add({ type: "comment-pinned", id, entity_id: entityId, proposal_id: proposalId, text });
  return id;
}

export function drift(items: Array<Pick<DriftItem, "key" | "outcome"> & Partial<DriftItem>>, opts: { commit?: string; dirty?: boolean; truncated?: number; extra?: Partial<Record<DriftOutcome, number>> } = {}): RunEvent {
  const full: DriftItem[] = items.map((i) => ({ kind: "function", op: "modify", ...i }));
  const counts = emptyCounts();
  for (const i of full) counts[i.outcome]++;
  for (const [k, n] of Object.entries(opts.extra ?? {})) counts[k as DriftOutcome] += n;
  return {
    type: "drift-detected", node: "map.drift", visit: 1, commit: opts.commit ?? "abc1234def5678",
    stamp: (opts.commit ?? "abc1234def5678").slice(0, 12) + (opts.dirty ? " + uncommitted changes" : ""), dirty: opts.dirty ?? false,
    base_commit: "0001112223334",
    manifest_hash: "m2", base_manifest_hash: "m1", counts, items: full, truncated: opts.truncated ?? 0,
  };
}
