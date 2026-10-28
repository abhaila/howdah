/**
 * A review of repairs judges only what the repairs changed (core/graph.ts `reviewsWorkOf`).
 *
 * Derived from the log, never cached: the scope starts at the commit the EARLIEST reviewed step
 * started from since this review step last judged (its last succeeded visit — a visit that
 * failed before answering judged nothing). The commit is the `reconciled` probe the engine
 * logged before that step's `node-started`, so a streak of repair visits (one timed out, the
 * next continued) is one scope, and a jump straight into the review with no repair since the
 * last verdict yields none — no briefing rather than a guessed range. Logged on the render as
 * `repair_scope`, so prompts/library.ts rebuilds the same words.
 */
import type { LoggedEvent } from "../log/events";
import type { RepairScope } from "../core/template";

/**
 * The git the engine observed just before the `node-started` at `startIndex` — the `reconciled`
 * probe logged for that node between the previous `node-started` and this one. Undefined when
 * no such probe exists (no reconciler, or a log written before it). Shared with HOW-75's
 * `repair:changed` (engine/executors/repair-check.ts), so "where did this step start" is
 * derived one way.
 */
export function startObservation(events: readonly LoggedEvent[], startIndex: number): Extract<LoggedEvent, { type: "reconciled" }>["git"] | undefined {
  const start = events[startIndex];
  if (start?.type !== "node-started") return undefined;
  for (let i = startIndex - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "node-started") return undefined;
    if (e.type === "reconciled" && e.node === start.node) return e.git;
  }
  return undefined;
}

export function repairScope(events: readonly LoggedEvent[], reviewNode: string, reviewed: readonly string[]): RepairScope | undefined {
  const judged = events.findLastIndex((e) => e.type === "node-finished" && e.node === reviewNode && e.status === "succeeded");
  const set = new Set(reviewed);
  const since = events.findIndex((e, i) => i > judged && e.type === "node-started" && set.has(e.node));
  if (since === -1) return undefined;
  const start = events[since] as Extract<LoggedEvent, { type: "node-started" }>;
  const git = startObservation(events, since);
  const head = git?.head;
  const branch = git?.branch;
  if (typeof head !== "string" || head === "") return undefined;
  return { node: start.node, visit: start.visit, sha: head, ...(typeof branch === "string" && branch !== "" ? { branch } : {}) };
}
