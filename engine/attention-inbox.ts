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
 * a later visit, the run dir is gone). A log that cannot be read keeps its record — losing a
 * standing ask is far worse than one extra line in a list.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readLog } from "../log/write";
import { replayState } from "./replay";
import { AttentionCenter, formatWait, type AttentionRecord } from "./attention";

/**
 * Nodes that name the HARNESS rather than a node of some run (`howdah:__harness__:1`, raised
 * by watchdog/check.ts when the heartbeat goes stale with a dead pid). There is no run log to
 * replay, so this file does not judge them — the heartbeat does, back in the watchdog.
 */
export const RUNLESS_NODES: ReadonlySet<string> = new Set(["__harness__"]);

export interface InboxItem {
  /** the record's id — `${run}:${node}:${visit}`, what `resolve()` takes */
  id: string;
  run: string;
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
  const path = join(runsDir, record.run, "run.jsonl");
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
  if (state.answeredPark) return false; // an approval or an effect attestation answered it
  if (state.parked) return true;
  // No standing park. If the node has since been attempted again, this record's ask was
  // answered and the run moved on; if it has not, the run is mid-flight and the record is
  // the ask that resolved — either way there is nothing here for a human to answer. This is
  // also what ages out a `runner-lock` record (engine/control.ts raiseRunnerLock), which has
  // no log event of its own: it rings once, when it happens, and is not re-rung for a run
  // that is otherwise fine.
  return false;
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
