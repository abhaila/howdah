/**
 * Viewer presence (HOW-68 D18): is a viewer tab open that will announce an ask ITSELF?
 *
 * One ask used to be announced twice. The engine (a separate process) posted the OS banner —
 * through `terminal-notifier`, or through `osascript`, which arrives as "Script Editor" and
 * cannot be clicked — while an open viewer posted a real browser `Notification` for the same
 * ask (web/app/lib/notify.ts). The operator's words: "a random script notification turns up …
 * rather than a native notification system".
 *
 * So the viewer says it is there. While it is open and its browser permission is `granted`,
 * the shell POSTs `/api/viewer/presence` every ~20s (and on a visibility change), the server
 * writes `$HOWDAH_HOME/viewer.json`, and `osNotifier` (engine/attention.ts) reads it: a
 * notifying viewer seen inside `VIEWER_FRESH_MS` means the browser's notification IS the
 * native one, and the OS banner is skipped.
 *
 * THIS IS LIVENESS, NOT RUN STATE. It sits beside `heartbeat.json` for the same reason that
 * file exists: nothing in a run log implies whether a browser tab is open, so this is not a
 * sidecar of something the log already says ("the log is the only storage" is about runs).
 * Losing the file costs one duplicate banner; a stale one costs nothing, because staleness is
 * exactly what `viewerDelivers` reads.
 *
 * Two edges, both deliberate:
 *   - A viewer that is visible AND focused posts no browser notification (the operator is
 *     looking at the amber glyph and the count). The OS banner is skipped then too — a banner
 *     over the screen that already says it is the alarm said twice.
 *   - A viewer that closed just before the ask still looks fresh for up to VIEWER_FRESH_MS and
 *     delivers nothing. `viewerMissedIt` is the proof the watchdog uses to ring through the OS
 *     after all: a viewer that never beat again after the ask was not there to announce it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ViewerPresence {
  /** when a viewer tab last said it was open */
  at: string;
  /** the browser's Notification permission was `granted` — this viewer announces asks itself */
  notify: boolean;
  /** where that viewer is served, so a deep link built by another process lands on it */
  base?: string;
}

/** the shell beats every 20s; two missed beats and the viewer is gone */
export const VIEWER_FRESH_MS = 45_000;

export const presencePath = (home: string): string => join(home, "viewer.json");

export function writePresence(home: string, p: { notify: boolean; base?: string }, clock: () => Date = () => new Date()): ViewerPresence {
  const record: ViewerPresence = { at: clock().toISOString(), notify: p.notify, ...(p.base ? { base: p.base } : {}) };
  mkdirSync(dirname(presencePath(home)), { recursive: true });
  writeFileSync(presencePath(home), JSON.stringify(record));
  return record;
}

/** null for no file, a torn file, or anything that is not a presence record */
export function readPresence(home: string): ViewerPresence | null {
  const path = presencePath(home);
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as Partial<ViewerPresence> | null;
    if (!v || typeof v.at !== "string" || Number.isNaN(new Date(v.at).getTime())) return null;
    return { at: v.at, notify: v.notify === true, ...(typeof v.base === "string" ? { base: v.base } : {}) };
  } catch {
    return null;
  }
}

/**
 * Skip the OS banner? Pure — the whole ring/skip decision. True only for a viewer that both
 * can notify and was seen inside the window; a beat stamped in the future (a clock that moved)
 * is not proof of anything and rings.
 */
export function viewerDelivers(p: ViewerPresence | null, now: Date, freshMs = VIEWER_FRESH_MS): boolean {
  if (!p || !p.notify) return false;
  const age = now.getTime() - new Date(p.at).getTime();
  return age >= 0 && age <= freshMs;
}

/**
 * A notification was left to the viewer at `deferredAt`. Did the viewer turn out not to be
 * there? Pure. Yes only when it has not beaten since the deferral AND a whole freshness window
 * has passed — a beat after the deferral proves an open tab received the ask.
 */
export function viewerMissedIt(p: ViewerPresence | null, deferredAt: string, now: Date, freshMs = VIEWER_FRESH_MS): boolean {
  const deferred = new Date(deferredAt).getTime();
  if (now.getTime() - deferred < freshMs) return false; // too early to tell
  if (!p || !p.notify) return true;
  return new Date(p.at).getTime() < deferred;
}
