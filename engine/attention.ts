/**
 * Attention (shaping A7, OV-10): a step needing input raises an OS notification and a
 * Slack DM — not only a UI state. Two durability rules:
 *
 *   1. Pending attention is a FILE, written before any notifier runs. A harness killed
 *      between raising and notifying leaves the record on disk; the watchdog (an interval
 *      job OUTSIDE this process) finds it and the notification still arrives.
 *   2. Notification text carries the wait duration and a deep link to the exact ask
 *      (design review: `run/:id#needs-input` with the control focused) — the reader acts
 *      from the notification, they don't go hunting.
 *
 * The heartbeat file is the watchdog's liveness signal: the engine touches it on a timer;
 * a stale heartbeat with a dead pid IS an attention event ("the harness died").
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface AttentionRecord {
  id: string; // `${run}:${node}:${visit}`
  run: string;
  node: string;
  visit: number;
  reason: string;
  raised_at: string;
  deep_link: string;
  /** stamped after a notifier successfully fired; absent = never delivered */
  notified_at?: string;
}

export interface Notification {
  title: string;
  body: string;
  link: string;
}

export type Notifier = (n: Notification) => Promise<void>;

/** macOS notification via osascript — replace/augment with Slack webhook in config */
export const osNotifier: Notifier = async (n) => {
  const esc = (s: string) => s.replace(/["\\]/g, "");
  Bun.spawnSync(["osascript", "-e", `display notification "${esc(n.body)}" with title "${esc(n.title)}" sound name "Glass"`]);
};

export const slackNotifier = (webhookUrl: string): Notifier => async (n) => {
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `*${n.title}*\n${n.body}\n${n.link}` }),
  });
};

export function formatWait(sinceIso: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - new Date(sinceIso).getTime());
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `waiting ${m}m`;
  return `waiting ${Math.floor(m / 60)}h ${m % 60}m`;
}

export class AttentionCenter {
  constructor(
    readonly dir: string,
    private readonly notifiers: Notifier[],
    private readonly opts: { viewerBase?: string; clock?: () => Date } = {},
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private now(): Date {
    return this.opts.clock?.() ?? new Date();
  }

  private path(id: string): string {
    return join(this.dir, `${id.replace(/[^\w.-]/g, "_")}.json`);
  }

  /** Durable-first: the record hits disk BEFORE any notifier runs. */
  async raise(input: { run: string; node: string; visit: number; reason: string }): Promise<AttentionRecord> {
    const id = `${input.run}:${input.node}:${input.visit}`;
    const record: AttentionRecord = {
      id,
      ...input,
      raised_at: this.now().toISOString(),
      deep_link: `${this.opts.viewerBase ?? "http://localhost:4711"}/run/${input.run}#needs-input`,
    };
    writeFileSync(this.path(id), JSON.stringify(record, null, 2));
    await this.notify(record);
    return record;
  }

  /** Notify (or re-notify) a pending record; stamps notified_at on success. */
  async notify(record: AttentionRecord): Promise<void> {
    const n: Notification = {
      title: `Howdah needs you — ${record.node}`,
      body: `${record.reason} (${formatWait(record.raised_at, this.now())})`,
      link: record.deep_link,
    };
    for (const fire of this.notifiers) await fire(n);
    record.notified_at = this.now().toISOString();
    writeFileSync(this.path(record.id), JSON.stringify(record, null, 2));
  }

  resolve(id: string): void {
    rmSync(this.path(id), { force: true });
  }

  pending(): AttentionRecord[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf8")) as AttentionRecord)
      .sort((a, b) => a.raised_at.localeCompare(b.raised_at));
  }

  /** Restart path (A7.2): re-raise anything never delivered or delivered too long ago. */
  async reRaise(reNotifyAfterMs: number): Promise<AttentionRecord[]> {
    const now = this.now().getTime();
    const due = this.pending().filter(
      (r) => !r.notified_at || now - new Date(r.notified_at).getTime() >= reNotifyAfterMs,
    );
    for (const r of due) await this.notify(r);
    return due;
  }
}

// ---- heartbeat -------------------------------------------------------------------

export interface Heartbeat {
  pid: number;
  at: string;
}

export function writeHeartbeat(path: string, clock: () => Date = () => new Date(), pid = process.pid): void {
  writeFileSync(path, JSON.stringify({ pid, at: clock().toISOString() } satisfies Heartbeat));
}

export function readHeartbeat(path: string): Heartbeat | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Heartbeat;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
