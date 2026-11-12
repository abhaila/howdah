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
 *
 * HOW-20 added the third rule, the one that makes the first two bearable: a notification is
 * raised for a SITUATION, not for every event that mentions it.
 *
 *   3. One ring per situation. Re-raising an id that is already on disk rewrites the record
 *      (durability is unchanged) but does not ring again inside a short cooldown — the
 *      executor's permission ask and the park that follows it are one situation. And a
 *      record whose run stopped needing a human is resolved by the watchdog rather than
 *      re-rung forever; see engine/attention-inbox.ts for who answers that question.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { howdahHome, loadConfig } from "../config/config";
import { readPresence, viewerDelivers, viewerMissedIt, type ViewerPresence } from "./viewer-presence";

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
  /**
   * `viewer` when the OS banner was skipped because an open viewer announces the ask itself
   * (HOW-68 D18, engine/viewer-presence.ts). It still counts as notified — the browser's
   * notification is the delivery — but `reRaise` re-opens it the moment the viewer is shown
   * not to have been there, so the watchdog rings through the OS path after all.
   */
  notified_via?: "viewer";
}

export interface Notification {
  title: string;
  body: string;
  link: string;
}

/**
 * A notifier delivers, or says it LEFT the delivery to the open viewer (`"viewer"`). Anything
 * else it cannot do is a throw, which leaves the record undelivered for the watchdog.
 */
/** where the viewer lives when nothing at all says otherwise — the base of every deep link */
export const DEFAULT_VIEWER_BASE = "http://localhost:4711";

export type Notifier = (n: Notification) => Promise<void | "viewer">;

/**
 * The macOS ring. A notification whose whole point is its deep link must be CLICKABLE
 * (HOW-20): `osascript -e 'display notification'` posts the banner as Script Editor, so
 * clicking it opens Script Editor — the reader is told a run needs them and then handed a
 * blank AppleScript window. `terminal-notifier -open <url>` opens the run instead.
 *
 * It is not installable from here, so this degrades rather than depends: with no click-capable
 * deliverer on PATH we still ring through osascript, with the URL spelled out in the body so
 * the reader can get there by hand. Either way the escaping guard stays — a reason with a
 * quote in it must not break the AppleScript (or the argv).
 */
export function notifierArgv(n: Notification, deliverer: string | null, sound = false): string[] {
  const esc = (s: string) => s.replace(/["\\]/g, "");
  if (deliverer)
    return [deliverer, "-title", esc(n.title), "-message", esc(n.body), "-open", n.link, ...(sound ? ["-sound", OS_SOUND] : [])];
  return [
    "osascript",
    "-e",
    `display notification "${esc(`${n.body} — ${n.link}`)}" with title "${esc(n.title)}"${sound ? ` sound name "${OS_SOUND}"` : ""}`,
  ];
}

/**
 * The one system sound the OS path may play, and only when the operator turned sound on
 * (D19). "Tink" is macOS's shortest and softest; "Glass" was a second, louder jingle beside
 * the viewer's own.
 */
export const OS_SOUND = "Tink";

/** what makes the OS banner clickable, and the one line that installs it — doctor and Settings say the same */
export const CLICKABLE_NOTIFIER = "terminal-notifier";
export const CLICKABLE_NOTIFIER_FIX = "brew install terminal-notifier";

export interface NotifierStatus {
  /** `terminal-notifier` is on PATH: the banner is Howdah's and opens the ask when clicked */
  clickable: boolean;
  /** the deliverer's path, or null when the banner falls back to `osascript` */
  path: string | null;
  /** one sentence saying which banner the operator gets */
  detail: string;
  /** the command that fixes it; absent when there is nothing to fix */
  fix?: string;
}

/** Pure over `which`, so doctor, the settings route and their tests share one sentence. */
export function notifierStatus(which: (bin: string) => string | null = (b) => Bun.which(b)): NotifierStatus {
  const path = which(CLICKABLE_NOTIFIER);
  return path
    ? { clickable: true, path, detail: `${CLICKABLE_NOTIFIER} — with no viewer open, the banner opens the ask when clicked` }
    : {
        clickable: false,
        path: null,
        detail: `${CLICKABLE_NOTIFIER} is not installed — with no viewer open, the banner arrives as “Script Editor” and cannot be clicked`,
        fix: CLICKABLE_NOTIFIER_FIX,
      };
}

/**
 * Where the viewer lives, for a process that was not told (the CLI, the watchdog, an
 * executor): `HOWDAH_PORT` if this process has it, else where a viewer last said it was
 * (viewer.json — launchd's watchdog has no HOWDAH_PORT), else the default. Deep links used to
 * say :4711 whatever port the viewer was actually on.
 */
export function resolveViewerBase(home: string, env: Record<string, string | undefined> = process.env, presence: ViewerPresence | null = readPresence(home)): string {
  const port = Number(env.HOWDAH_PORT);
  if (env.HOWDAH_PORT && Number.isInteger(port) && port > 0) return `http://localhost:${port}`;
  if (presence?.base && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(presence.base)) return presence.base;
  return DEFAULT_VIEWER_BASE;
}


/**
 * Silent unless the operator asked for sound (HOW-68): the banner is the notification, and
 * the same `chime` setting that governs the viewer's sound governs this one, so "off" means
 * off everywhere. An unreadable config is silence, never a reason not to deliver the banner.
 *
 * D18: and it does not ring at all while an open viewer will announce the ask itself — see
 * engine/viewer-presence.ts. It returns `"viewer"` then, so the record can say who was trusted
 * with the delivery. `spawn` is injectable so the decision is testable without a banner.
 */
export function makeOsNotifier(opts: {
  home?: string;
  clock?: () => Date;
  spawn?: (argv: string[]) => void;
  which?: (bin: string) => string | null;
} = {}): Notifier {
  return async (n) => {
    const home = opts.home ?? howdahHome();
    if (viewerDelivers(readPresence(home), opts.clock?.() ?? new Date())) return "viewer";
    let sound = false;
    try { sound = loadConfig(home).chime === true; } catch { /* deliver silently */ }
    const argv = notifierArgv(n, (opts.which ?? ((b: string) => Bun.which(b)))(CLICKABLE_NOTIFIER), sound);
    (opts.spawn ?? ((a: string[]) => void Bun.spawnSync(a)))(argv);
  };
}

export const osNotifier: Notifier = makeOsNotifier();

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

/**
 * Two raises of the SAME id inside this window are one situation, and ring once (HOW-20):
 * the claude/codex executor raises `run:node:visit` when a tool needs permission, and the
 * park that follows raises the very same id seconds later. The second write still happens —
 * durability is never traded for quiet — only the second ring is skipped.
 */
export const NOTIFY_COOLDOWN_MS = 10 * 60_000;


/**
 * Nodes that name the HARNESS itself rather than a node of some run — `howdah:__harness__:1`,
 * raised by watchdog/check.ts when the heartbeat goes stale with a dead pid.
 *
 * There is no run behind them, which decides two things. Nobody can judge them from a run log
 * (engine/attention-inbox.ts leaves them to the heartbeat), and `/run/howdah#needs-input` is
 * NOT a page: the run view renders "No run howdah — nothing was written to its log, so it
 * probably failed to start". Since HOW-20 made the banner clickable, the one notification
 * whose fix is `howdah up` would open a page asserting a launch failure — the same dead-end
 * click the ticket reports. So a runless record links at the inbox, which does list it.
 */
export const RUNLESS_NODES: ReadonlySet<string> = new Set(["__harness__"]);

export class AttentionCenter {
  constructor(
    readonly dir: string,
    private readonly notifiers: Notifier[],
    private readonly opts: {
      viewerBase?: string;
      clock?: () => Date;
      notifyCooldownMs?: number;
      /** the viewer's presence, for `reRaise`; default: viewer.json beside the attention dir */
      presence?: () => ViewerPresence | null;
    } = {},
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private now(): Date {
    return this.opts.clock?.() ?? new Date();
  }

  private viewerBase(): string {
    // the attention dir is `$HOWDAH_HOME/attention`, so its parent is the home viewer.json is in
    return this.opts.viewerBase ?? resolveViewerBase(dirname(this.dir));
  }

  private presence(): ViewerPresence | null {
    return this.opts.presence ? this.opts.presence() : readPresence(dirname(this.dir));
  }

  private path(id: string): string {
    return join(this.dir, `${id.replace(/[^\w.-]/g, "_")}.json`);
  }

  /**
   * Durable-first: the record hits disk BEFORE any notifier runs.
   *
   * An id already on disk keeps its original `raised_at` — re-raising must not restart the
   * wait clock, or the operator is told a two-hour-old ask arrived "just now". The reason and
   * the link are rewritten (the later raise knows more: `park: no matching edge` says more
   * than `Bash needs permission`), and the ring is skipped inside NOTIFY_COOLDOWN_MS.
   */
  async raise(input: { run: string; node: string; visit: number; reason: string }): Promise<AttentionRecord> {
    const id = `${input.run}:${input.node}:${input.visit}`;
    const prior = this.read(id);
    const record: AttentionRecord = {
      id,
      ...input,
      raised_at: prior?.raised_at ?? this.now().toISOString(),
      deep_link: RUNLESS_NODES.has(input.node)
        ? `${this.viewerBase()}/attention` // no /run/howdah exists to land on; see RUNLESS_NODES
        : `${this.viewerBase()}/run/${input.run}#needs-input`,
      ...(prior?.notified_at ? { notified_at: prior.notified_at } : {}),
      ...(prior?.notified_via ? { notified_via: prior.notified_via } : {}),
    };
    writeFileSync(this.path(id), JSON.stringify(record, null, 2));
    const cooldown = this.opts.notifyCooldownMs ?? NOTIFY_COOLDOWN_MS;
    const rang = prior?.notified_at ? this.now().getTime() - new Date(prior.notified_at).getTime() : Infinity;
    if (rang >= cooldown) await this.notify(record);
    return record;
  }

  /**
   * Notify (or re-notify) pending records; stamps notified_at on success.
   *
   * This is what a notification is MEANT to look like (HOW-20): the title names the run AND
   * the node, because "Howdah needs you — implementation.plan" against six parked runs names
   * nothing; the body is the reason plus how long it has waited; and the link is handed to
   * every notifier, not only Slack — the whole point of the banner is that clicking it lands
   * on the ask.
   *
   * Given MORE THAN ONE record it delivers ONE notification that counts them and links the
   * inbox, instead of a banner per record (what the watchdog tick does with a backlog).
   */
  async notify(records: AttentionRecord | AttentionRecord[]): Promise<void> {
    const list = Array.isArray(records) ? records : [records];
    if (list.length === 0) return;
    const first = list[0]!;
    const one = (r: AttentionRecord) => `${r.run} · ${r.node}`;
    const n: Notification = list.length === 1
      ? {
          title: `Howdah needs you — ${one(first)}`,
          body: `${first.reason} · ${formatWait(first.raised_at, this.now())}`,
          link: first.deep_link,
        }
      : {
          title: `Howdah needs you — ${list.length} runs`,
          body: list.map((r) => `${one(r)} · ${formatWait(r.raised_at, this.now())}`).join(", "),
          link: `${this.viewerBase()}/attention`,
        };
    let deferred = false;
    for (const fire of this.notifiers) if ((await fire(n)) === "viewer") deferred = true;
    // stamped only after every notifier returned: a throw above leaves the records
    // undelivered on disk, which is what makes the watchdog deliver them later.
    // A banner LEFT TO THE VIEWER counts as notified (D18) — the browser's notification is the
    // delivery — and says so, which is what lets reRaise take it back if nobody was there.
    const at = this.now().toISOString();
    for (const r of list) {
      r.notified_at = at;
      if (deferred) r.notified_via = "viewer";
      else delete r.notified_via;
      writeFileSync(this.path(r.id), JSON.stringify(r, null, 2));
    }
  }

  private read(id: string): AttentionRecord | null {
    const path = this.path(id);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as AttentionRecord;
    } catch {
      return null; // a torn record is no record: re-raising rewrites it
    }
  }

  resolve(id: string): void {
    rmSync(this.path(id), { force: true });
  }

  pending(): AttentionRecord[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf8")) as AttentionRecord)
      // raised_at ties within a millisecond, and readdir order is the filesystem's (APFS sorts,
      // ext4 does not) — the id breaks the tie so the inbox reads the same everywhere
      .sort((a, b) => a.raised_at.localeCompare(b.raised_at) || a.id.localeCompare(b.id));
  }

  /**
   * Restart path (A7.2): everything never delivered, or delivered too long ago.
   *
   * `stillNeedsHuman` is asked FIRST, and a record it rejects is RESOLVED, not notified
   * (HOW-20): a run that finished hours ago, or whose ask was answered, was re-ringing every
   * thirty minutes forever because nothing on this path ever looked at the run again. The
   * predicate is injected rather than imported so this file keeps knowing nothing about runs
   * — watchdog/check.ts and the viewer both pass engine/attention-inbox.ts's one answer.
   *
   * It returns the still-due records WITHOUT ringing, so the caller decides how to deliver
   * them: one ring for one record, one coalesced ring for a backlog.
   */
  async reRaise(reNotifyAfterMs: number, stillNeeded?: (r: AttentionRecord) => boolean): Promise<AttentionRecord[]> {
    const now = this.now().getTime();
    const due: AttentionRecord[] = [];
    for (const r of this.pending()) {
      if (stillNeeded && !stillNeeded(r)) {
        this.resolve(r.id);
        continue;
      }
      // D18: a ring left to a viewer that then never beat again was delivered by nobody. It is
      // due NOW, and by then the presence is stale, so the notifier rings through the OS path.
      const missed = r.notified_via === "viewer" && !!r.notified_at && viewerMissedIt(this.presence(), r.notified_at, this.now());
      if (!r.notified_at || missed || now - new Date(r.notified_at).getTime() >= reNotifyAfterMs) due.push(r);
    }
    return due;
  }
}

// ---- heartbeat -------------------------------------------------------------------

export interface Heartbeat {
  pid: number;
  at: string;
}

export function writeHeartbeat(path: string, clock: () => Date = () => new Date(), pid = process.pid): void {
  mkdirSync(dirname(path), { recursive: true });
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
