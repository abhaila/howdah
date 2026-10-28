/**
 * HOW-75: a review repair that rightly changes nothing is not a stall — but a PROBE that keeps
 * demanding the repair that just changed nothing, with nothing new on the PR, is.
 *
 * Before HOW-75 the HOW-54 tree check caught this at the repair: address_reviews answered a
 * thread, changed no file, and parked `no-progress` ("another review would judge the same code")
 * on a visit that had done exactly the right thing. Now the code-changing repairs declare
 * `changesFiles: false` and `delivery.repair_check` (`repair:changed`, engine/executors/
 * repair-check.ts) publishes `repair.changed`: a repair that changed nothing goes straight to the
 * wait and the next probe, with no review of nothing and no publish of nothing.
 *
 * HOW-54's purpose survives HERE, one step later and with better information: the probe parks
 * `repair-stalled` when its previous visit asked for the same repair, the repair that followed
 * changed nothing, and nothing new has arrived on the PR since. The probe knows what is
 * outstanding (the review decision, the failing check, the threads waiting on the reviewer), so
 * the park can say what the operator can do instead of "another review would judge the same code".
 *
 * Node-free and pure, folded from the run's log, so a resume decides the same way.
 */

/** the fact `repair:changed` publishes, and the step that runs it in the delivery graphs */
export const REPAIR_CHANGED_KEY = "repair.changed";
export const REPAIR_CHECK_BUILTIN = "repair:changed";
export const REPAIR_CHECK_NODE = "delivery.repair_check";
/** what the built-in reads (the repair's own summary, quoted in the thread) and publishes */
export const REPAIR_CHECK_READS = ["repair_summary"] as const;
export const REPAIR_CHECK_PRODUCES = [REPAIR_CHANGED_KEY] as const;

/** the pr.state values a delivery repair answers — any other state is not a repeat demand */
export const REPAIR_STATES: readonly string[] = ["CHANGES_REQUIRED", "CI_FAILED", "CONFLICTS"];

/** the minimal event shape this reads — engine logs satisfy it */
type StallEvent = { type: string; node?: string; visit?: number; status?: string; writes?: Record<string, unknown> };

export interface RepairStall {
  /** the probe visit that asked for the same repair last time */
  previousVisit: number;
  /** the repair that ran after it and changed nothing, when the log names one */
  repair: { node: string; visit: number } | null;
}

const finished = (e: StallEvent): e is StallEvent & { node: string; visit: number; writes: Record<string, unknown> } =>
  e.type === "node-finished" && typeof e.node === "string" && typeof e.visit === "number";

/**
 * Is `probeNode@visit`, about to answer `state`, asking again for the repair that just changed
 * nothing? `newInput` is the caller's: anything on the PR the last repair has not seen (new
 * review items, a review submitted since). Null — route as usual — on a first probe, a different
 * state, a repair that changed something, or no repair check since the previous probe.
 */
export function repairStall(events: readonly StallEvent[], probeNode: string, visit: number, state: string, newInput: boolean): RepairStall | null {
  if (newInput || !REPAIR_STATES.includes(state)) return null;
  const prevIndex = events.findLastIndex((e) => finished(e) && e.node === probeNode && e.visit < visit && e.status === "succeeded");
  if (prevIndex === -1) return null;
  const prev = events[prevIndex]!;
  if (prev.writes?.["pr.state"] !== state) return null;
  const after = events.slice(prevIndex + 1);
  const checkAt = after.findLastIndex((e) => finished(e) && e.status === "succeeded" && e.writes !== undefined && REPAIR_CHANGED_KEY in e.writes);
  if (checkAt === -1) return null;
  const check = after[checkAt]!;
  if (check.writes?.[REPAIR_CHANGED_KEY] !== false) return null;
  const repair = after.slice(0, checkAt).findLast((e) => finished(e) && e.node !== check.node);
  return { previousVisit: prev.visit as number, repair: repair && finished(repair) ? { node: repair.node, visit: repair.visit } : null };
}
