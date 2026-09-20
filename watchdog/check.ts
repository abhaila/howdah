#!/usr/bin/env bun
/**
 * Watchdog (shaping A7.2 / OV-10) — runs OUTSIDE the harness process, on a launchd
 * interval (see howdah-watchdog.plist). The harness dying is itself an attention event.
 *
 * Each tick:
 *   1. Heartbeat stale AND its pid dead  → raise a durable "harness died" attention.
 *      Heartbeat back  → resolve that record: the harness returning is the answer to it,
 *      and nothing else ever cleared it (HOW-20).
 *   2. Pending attention never delivered, or delivered longer than reNotifyAfterMs ago
 *      → (re-)notify. This is what makes `kill -9` with attention pending still ring:
 *      the record was written before the death; this process delivers it.
 *
 * What HOW-20 changed is step 2's arithmetic. It used to be "every pending record, every
 * thirty minutes, one banner each", which for six parked runs — two of them long finished —
 * is twelve banners an hour saying nothing the operator can act on. Now each record is first
 * asked whether its run still waits for a human (engine/attention-inbox.ts, the same answer
 * the viewer's inbox screen uses), stale ones are resolved instead of rung, and what remains
 * is delivered as ONE notification: "Howdah needs you — 3 runs", linking the inbox.
 *
 * Everything is injectable; the CLI entry wires real notifiers.
 */
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  AttentionCenter,
  osNotifier,
  pidAlive,
  readHeartbeat,
  type AttentionRecord,
  type Notifier,
} from "../engine/attention";
import { stillNeedsHuman } from "../engine/attention-inbox";

/** the id of the one record that is about the harness itself, not about a run */
const HARNESS_NODE = "__harness__";
const HARNESS_RECORD = `howdah:${HARNESS_NODE}:1`;

export interface CheckOpts {
  attentionDir: string;
  /** where run logs live, for the liveness probe; default: `runs/` beside the attention dir */
  runsDir?: string;
  heartbeatPath: string;
  notifiers: Notifier[];
  /** heartbeat older than this is stale */
  staleAfterMs?: number;
  /** re-notify pending attention after this long */
  reNotifyAfterMs?: number;
  clock?: () => Date;
  viewerBase?: string;
}

export interface CheckResult {
  harnessDead: boolean;
  notified: string[]; // attention ids (re-)delivered this tick
  /** records dropped because their run no longer waits for a human (HOW-20) */
  resolved: string[];
}

export async function check(opts: CheckOpts): Promise<CheckResult> {
  const clock = opts.clock ?? (() => new Date());
  const center = new AttentionCenter(opts.attentionDir, opts.notifiers, { clock, viewerBase: opts.viewerBase });
  const runsDir = opts.runsDir ?? join(dirname(opts.attentionDir), "runs");
  const staleAfter = opts.staleAfterMs ?? 120_000;
  const reNotifyAfter = opts.reNotifyAfterMs ?? 30 * 60_000;

  // 1. harness liveness
  const hb = readHeartbeat(opts.heartbeatPath);
  const fresh = !!hb && clock().getTime() - new Date(hb.at).getTime() <= staleAfter;
  let harnessDead = false;
  const resolved: string[] = [];
  if (hb && !fresh && !pidAlive(hb.pid)) {
    harnessDead = true;
    const already = center.pending().some((r) => r.node === HARNESS_NODE);
    if (!already)
      await center.raise({
        run: "howdah",
        node: HARNESS_NODE,
        visit: 1,
        reason: `harness process ${hb.pid} is dead (heartbeat stale) — run \`howdah up\``,
      });
  } else if (fresh && center.pending().some((r) => r.node === HARNESS_NODE)) {
    // the harness is demonstrably back: the record it left behind has been answered, and
    // nothing else clears it — left alone it rings on every tick, forever (HOW-20)
    center.resolve(HARNESS_RECORD);
    resolved.push(HARNESS_RECORD);
  }

  // 2. drop what no longer needs a human, then deliver what does — as ONE notification
  const before = new Set(center.pending().map((r) => r.id));
  const alive = (r: AttentionRecord) => (r.node === HARNESS_NODE ? harnessDead : stillNeedsHuman(runsDir, r));
  const due = await center.reRaise(reNotifyAfter, alive);
  const after = new Set(center.pending().map((r) => r.id));
  for (const id of before) if (!after.has(id)) resolved.push(id);
  if (due.length > 0) await center.notify(due);
  return { harnessDead, notified: due.map((r) => r.id), resolved };
}

if (import.meta.main) {
  const base = process.env.HOWDAH_HOME ?? join(homedir(), ".howdah");
  const result = await check({
    attentionDir: join(base, "attention"),
    runsDir: join(base, "runs"),
    heartbeatPath: join(base, "heartbeat.json"),
    notifiers: [osNotifier],
  });
  console.log(JSON.stringify(result));
}
