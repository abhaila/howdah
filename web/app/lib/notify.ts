/**
 * The browser notification for a run that newly starts waiting (HOW-68, DESIGN.md
 * "Notifications and sound").
 *
 * The only notification Howdah had was the OS one (engine/attention.ts): posted by `osascript`
 * as Script Editor, with a sound, and not clickable — the link was text in the body. That path
 * stays, because it is the one that works when no viewer is open. This is the one for when a
 * viewer IS open in a tab the operator is not looking at: a real `Notification` carrying the
 * run's name and what it is asking, and a click that focuses the window on the ask.
 *
 * ONE ASK, ONE NOTIFICATION (D18). While this path can deliver, the OS one stands down: the
 * shell tells the server a notifying viewer is open (lib/presence.ts) and the engine's notifier
 * skips its banner. That is also why the shell — not only the three screens that list runs —
 * observes asks: a viewer left on Settings has to announce them too.
 *
 * What is NEWS is not decided here. `decideNews` (lib/attention-sound.ts) names the runs that
 * newly started waiting — the same rule the sound uses, so navigation, a reload and the first
 * sight of a session announce nothing — and `observeAsks` hands them to `notifyRuns`. This
 * file decides only whether a notification may be SHOWN for them (`decideNotify`, pure):
 *
 *   - permission is `granted`. It is asked for from Settings, on a click, never on load
 *     (`requestNotifyPermission` is called from exactly one button).
 *   - the page is not already visible AND focused. An operator looking at the viewer sees the
 *     amber glyph and the nav count change; a banner on top of that is the alarm said twice.
 *
 * `tag` is the run id, so a run that asks again REPLACES its earlier notification instead of
 * stacking beside it, and two tabs posting for the same run collapse to one.
 *
 * Every touch of `Notification` is guarded: it does not exist in the test DOM, in some
 * embedded browsers, or on an insecure origin, and constructing one can throw (Android Chrome
 * only allows the service-worker form). A notification that cannot be shown is not an error —
 * the favicon, the count and the OS path still say it.
 */
import { navigate } from "./nav";

/** `unsupported` = this browser has no Notification API at all */
export type NotifyPermission = "unsupported" | "default" | "granted" | "denied";

export interface RunNews {
  id: string;
  /** the notification's title: the run's name */
  title: string;
  /** one sentence: what it is asking */
  body: string;
  /** where a click lands when it is not the run's own ask (the harness record has no run page) */
  href?: string;
}

function api(): typeof Notification | null {
  return typeof Notification === "undefined" ? null : Notification;
}

export function notifyPermission(): NotifyPermission {
  const n = api();
  if (!n) return "unsupported";
  return n.permission === "granted" || n.permission === "denied" ? n.permission : "default";
}

/** Ask the browser. Call ONLY from a click (Settings): browsers ignore or punish anything else. */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  const n = api();
  if (!n || typeof n.requestPermission !== "function") return "unsupported";
  try { await n.requestPermission(); } catch { /* an old callback-only API, or a refusal: read the state below */ }
  return notifyPermission();
}

/**
 * Which of the new runs get a notification, and what each says. Pure — the whole decision.
 * A run this screen has no note for is announced by its id rather than dropped: the fact that
 * it is waiting is the news, the wording is a courtesy.
 */
export function decideNotify(
  fresh: readonly string[],
  info: Readonly<Record<string, { name: string; body: string; href?: string } | undefined>>,
  env: { permission: NotifyPermission; visible: boolean; focused: boolean },
): RunNews[] {
  if (env.permission !== "granted") return [];
  if (env.visible && env.focused) return [];
  return fresh.map((id) => {
    const note = info[id];
    return { id, title: note?.name || id, body: note?.body || "A run is waiting on you.", ...(note?.href ? { href: note.href } : {}) };
  });
}

/** where a notification's click lands: the ask itself */
export const runAskHref = (id: string) => `/run/${encodeURIComponent(id)}#needs-input`;

function post(news: RunNews, onClick: () => void): boolean {
  const n = api();
  if (!n) return false;
  try {
    const shown = new n(news.title, { body: news.body, tag: news.id });
    shown.onclick = () => {
      try { window.focus(); } catch { /* a browser that will not be focused from script */ }
      onClick();
      shown.close?.();
    };
    return true;
  } catch {
    return false; // e.g. Android Chrome: `new Notification` is illegal outside a service worker
  }
}

/** Post a notification for each run that is news, if one may be shown. Returns how many were. */
export function notifyRuns(fresh: readonly string[], info: Readonly<Record<string, { name: string; body: string; href?: string } | undefined>>): number {
  if (fresh.length === 0 || typeof document === "undefined") return 0;
  const news = decideNotify(fresh, info, {
    permission: notifyPermission(),
    visible: document.visibilityState === "visible",
    focused: typeof document.hasFocus === "function" ? document.hasFocus() : true,
  });
  return news.filter((n) => post(n, () => navigate(n.href ?? runAskHref(n.id)))).length;
}

/** Settings' "Send a test notification": shown even while the page is focused — that is the point of a test. */
/**
 * HOW-68 — "granted" is the BROWSER's answer, not the operator's experience. Chrome on macOS
 * reports `granted` and accepts `new Notification()` while macOS itself shows nothing (Chrome
 * switched off under System Settings → Notifications, or a Focus mode), and no event tells
 * the page so. The first build trusted `granted`, told the server "this viewer delivers", and
 * the engine then skipped its own banner — so an operator in that state got NO notification
 * at all. The only reliable witness is the person: Settings sends a test and asks whether it
 * appeared, and only a yes makes this viewer claim delivery (lib/presence.ts). Until then
 * both paths ring, which is the safe failure.
 */
const CONFIRMED_KEY = "howdah.notify.confirmed";

export function notifyConfirmed(): boolean {
  try { return localStorage.getItem(CONFIRMED_KEY) === "yes"; } catch { return false; }
}

export function setNotifyConfirmed(seen: boolean): void {
  try { if (seen) localStorage.setItem(CONFIRMED_KEY, "yes"); else localStorage.removeItem(CONFIRMED_KEY); } catch { /* private window: stays unconfirmed, so the OS path keeps ringing */ }
}

/** This viewer may be relied on to deliver: the browser allows it AND the operator has seen one. */
export function notifyDelivers(): boolean {
  return notifyPermission() === "granted" && notifyConfirmed();
}

let testSeq = 0;

export function sendTestNotification(): boolean {
  if (notifyPermission() !== "granted") return false;
  // a fresh tag each time: a repeated tag REPLACES the standing notification silently, so a
  // second press of the test button would show nothing even where notifications work
  return post({ id: `howdah-test-${Date.now()}-${++testSeq}`, title: "Howdah", body: "This is what a run waiting on you will look like." }, () => {});
}
