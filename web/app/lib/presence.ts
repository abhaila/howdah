/**
 * The viewer's side of presence (HOW-68 D18; the other side is engine/viewer-presence.ts).
 *
 * An open viewer tells the server it is here and whether its browser may notify, every 20s and
 * whenever the tab is shown or hidden. The engine's OS notifier reads that and leaves the
 * banner to the browser's own `Notification` while the beat is fresh — one ask, one
 * notification, and never the "Script Editor" one while a real one is available.
 *
 * `notify` is the browser permission being `granted` and nothing else. It is deliberately NOT
 * "and the tab is hidden": a visible, focused viewer posts no notification because the operator
 * is looking at it (lib/notify.ts `decideNotify`), and an OS banner on top of the screen that
 * already says it is the alarm said twice.
 *
 * The beat stops when the tab closes, which is the whole signal: 45s later the OS path rings
 * again. A failed beat is not an error to show — the cost is one duplicate banner.
 */
import { notifyPermission } from "./notify";

export const PRESENCE_INTERVAL_MS = 20_000;

export function beatPresence(): Promise<void> {
  return fetch("/api/viewer/presence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ notify: notifyPermission() === "granted" }),
    keepalive: true,
  }).then(() => {}, () => {});
}

/** Fired by Settings when the permission changes, so the server learns at once rather than in 20s. */
export const PRESENCE_CHANGED = "howdah:presence-changed";

/** Start beating; returns the stop function. One caller: the shell. */
export function startPresence(intervalMs = PRESENCE_INTERVAL_MS): () => void {
  const beat = () => void beatPresence();
  beat();
  const t = setInterval(beat, intervalMs);
  document.addEventListener("visibilitychange", beat);
  window.addEventListener(PRESENCE_CHANGED, beat);
  return () => {
    clearInterval(t);
    document.removeEventListener("visibilitychange", beat);
    window.removeEventListener(PRESENCE_CHANGED, beat);
  };
}
