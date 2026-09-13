#!/usr/bin/env bun
/**
 * Watchdog (shaping A7.2 / OV-10) — runs OUTSIDE the harness process, on a launchd
 * interval (see howdah-watchdog.plist). The harness dying is itself an attention event.
 *
 * Each tick:
 *   1. Heartbeat stale AND its pid dead  → raise a durable "harness died" attention.
 *   2. Pending attention never delivered, or delivered longer than reNotifyAfterMs ago
 *      → (re-)notify. This is what makes `kill -9` with attention pending still ring:
 *      the record was written before the death; this process delivers it.
 *
 * Everything is injectable; the CLI entry wires real notifiers.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import {
  AttentionCenter,
  osNotifier,
  pidAlive,
  readHeartbeat,
  type Notifier,
} from "../engine/attention";

export interface CheckOpts {
  attentionDir: string;
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
}

export async function check(opts: CheckOpts): Promise<CheckResult> {
  const clock = opts.clock ?? (() => new Date());
  const center = new AttentionCenter(opts.attentionDir, opts.notifiers, { clock, viewerBase: opts.viewerBase });
  const staleAfter = opts.staleAfterMs ?? 120_000;
  const reNotifyAfter = opts.reNotifyAfterMs ?? 30 * 60_000;

  // 1. harness liveness
  const hb = readHeartbeat(opts.heartbeatPath);
  let harnessDead = false;
  if (hb && clock().getTime() - new Date(hb.at).getTime() > staleAfter && !pidAlive(hb.pid)) {
    harnessDead = true;
    const already = center.pending().some((r) => r.node === "__harness__");
    if (!already)
      await center.raise({
        run: "howdah",
        node: "__harness__",
        visit: 1,
        reason: `harness process ${hb.pid} is dead (heartbeat stale) — run \`howdah up\``,
      });
  }

  // 2. deliver / re-deliver pending attention
  const delivered = await center.reRaise(reNotifyAfter);
  return { harnessDead, notified: delivered.map((r) => r.id) };
}

if (import.meta.main) {
  const base = process.env.HOWDAH_HOME ?? join(homedir(), ".howdah");
  const result = await check({
    attentionDir: join(base, "attention"),
    heartbeatPath: join(base, "heartbeat.json"),
    notifiers: [osNotifier],
  });
  console.log(JSON.stringify(result));
}
