/**
 * The inbox read model, and the one question underneath it (HOW-20).
 *
 * The complaint was two complaints. Notifications arrived in a flood — a watchdog tick
 * re-rang every pending record every thirty minutes, including records of runs that had
 * finished hours earlier, because nothing on the notify path ever looked at the run again.
 * And a banner that says "Howdah needs you" answers none of "what is the actual issue, and
 * where do I read it": there was no screen listing what is waiting.
 *
 * Both halves need the SAME answer to "does this pending record still need a human?", or the
 * screen and the ring disagree — a badge counting three while two ring, or an empty inbox
 * that still buzzes. So it is answered once, here, from the run's own log through the
 * existing `replayState`: no second status derivation invented for notifications.
 *
 * The conservative direction is deliberate. A record is dropped only on PROOF that nobody is
 * waiting (the run finished, an operator action answered the park, the ask was superseded by
 * a later one, the run dir is gone). A log that cannot be read keeps its record — losing a
 * standing ask is far worse than one extra line in a list.
 *
 * "Proof" is about THIS record, not about its run: the question is whether the run's standing
 * park is this exact `node:visit`, because a run that parked, was answered and parked again
 * leaves a record for each and only the last one is a live ask. The two records with no log
 * event of their own — the harness and a wedged runner lock — are judged by the thing they
 * are about (the heartbeat, the lock), never by the log.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readLog } from "../log/write";
import { replayState } from "./replay";
import { runnerHolder } from "./control";
import { AttentionCenter, formatWait, RUNLESS_NODES, type AttentionRecord } from "./attention";

/** re-exported from engine/attention.ts, which needs it to decide a record's deep link */
export { RUNLESS_NODES };

/**
 * The other record with no event of its own: `<run>:runner-lock:0` (engine/control.ts
 * raiseRunnerLock) says a live process that is NOT the run's runner holds its lock, and
 * `resume <run> --force` is the fix. Its run HAS a log, but the log never mentions the lock,
 * so replaying it would answer about some other ask entirely. The lock itself is the proof.
 */
export const RUNNER_LOCK_NODE = "runner-lock";

export interface InboxItem {
  /** the record's id — `${run}:${node}:${visit}`, what `resolve()` takes */
  id: string;
  run: string;
  /**
   * the in-app path this row links to, or null when the record has no run page to link at
   * (RUNLESS_NODES — the harness record's run id, "howdah", is not a run). Decided here so
   * the screen never has to import this module's node-side code to ask.
   */
  href: string | null;
  /** the graph the run is of, from its run-started event; "" when the log cannot say */
  graph: string;
  node: string;
  visit: number;
  reason: string;
  raised_at: string;
  /** the ONE wait phrasing (engine/attention.ts formatWait), not a second one in the viewer */
  waited: string;
  deep_link: string;
  /** when the last ring went out; absent = never delivered */
  notified_at?: string;
}

/**
 * Does this pending record still need a human? Answered from the run's log alone, so the
 * watchdog (out of process) and the viewer can never disagree.
 */
export function stillNeedsHuman(runsDir: string, record: Pick<AttentionRecord, "run" | "node" | "visit">): boolean {
  if (RUNLESS_NODES.has(record.node)) return true;
  const runDir = join(runsDir, record.run);
  // the lock is its own evidence: kept while a non-runner still holds it (so `howdah up`'s
  // once-guard keeps holding and it cannot re-ring every tick), dropped the moment it does
  // not — which is exactly when `resume --force`, a pause or the holder's death fixed it
  if (record.node === RUNNER_LOCK_NODE) {
    const holder = runnerHolder(runDir);
    return holder !== null && !holder.genuine;
  }
  const path = join(runDir, "run.jsonl");
  if (!existsSync(path)) return false; // the run was deleted; its ask went with it
  let events;
  try {
    events = readLog(path);
  } catch {
    return true; // corrupt log: never drop an ask on a read error
  }
  const state = replayState(events);
  if (!state.started) return true; // an empty or torn-from-the-top log cannot say
  if (state.finished) return false; // finished or aborted — nobody is waiting
  /**
   * The record is judged against its OWN identity, not the run's global mood (HOW-20
   * review). "The run is parked" is the wrong question: a run that parked on implement#1,
   * was resumed (which appends attention-resolved but never deletes the disk record) and
   * then parked again as implement#2 has TWO records, and answering "is it parked?" keeps
   * both — two inbox rows and a "2 runs need you" banner for one run, one of them showing a
   * reason that was answered hours ago.
   *
   * So: keep it only while the STANDING park is this very ask. That one comparison also
   * covers the rest — an ask an operator answered is no longer the standing park, a park a
   * decision or an effect attestation answered leaves `parked` null (D17 / HOW-3), and a run
   * mid-flight has no park at all. A later raise of the same node+visit (the permission ask
   * answered, then the attempt fails and parks on the same visit) matches again, which is
   * right: the record was rewritten with the new reason and is a live ask once more.
   */
  const standing = state.parked;
  return standing !== null && standing.node === record.node && standing.visit === record.visit;
}

/**
 * Every pending record that still needs a human, joined with its run's graph and its wait.
 * Oldest wait first (`pending()` sorts by raised_at), so the newest wait reads last.
 *
 * Purely a read: a record `stillNeedsHuman` rejects is DROPPED from the list, not deleted —
 * reading a screen must not mutate the operator's state, and the watchdog tick that clears
 * it is coming anyway. Records leave disk through resolve(), which the reply, approval and
 * effect paths call.
 */
export function inboxItems(opts: { runsDir: string; attentionDir: string; clock?: () => Date }): InboxItem[] {
  const now = opts.clock?.() ?? new Date();
  const center = new AttentionCenter(opts.attentionDir, [], { clock: opts.clock });
  const items: InboxItem[] = [];
  for (const r of center.pending()) {
    if (!stillNeedsHuman(opts.runsDir, r)) continue;
    items.push({
      id: r.id,
      run: r.run,
      href: RUNLESS_NODES.has(r.node) ? null : `/run/${r.run}#needs-input`,
      graph: graphOf(opts.runsDir, r.run),
      node: r.node,
      visit: r.visit,
      reason: r.reason,
      raised_at: r.raised_at,
      waited: formatWait(r.raised_at, now),
      deep_link: r.deep_link,
      ...(r.notified_at ? { notified_at: r.notified_at } : {}),
    });
  }
  return items;
}

function graphOf(runsDir: string, run: string): string {
  const path = join(runsDir, run, "run.jsonl");
  if (!existsSync(path)) return "";
  try {
    const started = readLog(path).find((e) => e.type === "run-started");
    return started?.type === "run-started" ? started.graph : "";
  } catch {
    return "";
  }
}
