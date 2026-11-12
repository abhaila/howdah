/**
 * When the "a run needs you" sound may play (HOW-68).
 *
 * The chime used to fire on a false→true change of a boolean that every screen computed after
 * mounting with no data, so it rang on NAVIGATION: seven times in eight page visits with
 * nothing new, measured. And the "Attention chime" setting was saved and never read. Both
 * are fixed here, in one pure decision the hook calls:
 *
 *   - OFF unless the operator turned it on (`config.chime === true`). A sound is an
 *     interruption; the default for an interruption is silence.
 *   - only for a run that was NOT already known to be waiting. What is known is kept for the
 *     browser session, so moving between screens, or a reload, re-announces nothing.
 *   - the first sight of the session seeds that memory silently: opening the viewer onto
 *     eleven standing asks is not eleven pieces of news.
 *
 * A run is forgotten when a screen that can see it says it is no longer waiting, so the SAME
 * run asking again later is news again. Screens differ in what they can see: the runs list
 * and the inbox see every run (`cleared: "others"`), a run's own page sees one.
 *
 * ONE DECISION, TWO SURFACES (DESIGN.md "Notifications and sound"). What is news is decided
 * once, by `decideNews`, and it names WHICH runs are new. The sound asks only "is there any,
 * and is it wanted" (`decideRing`); the browser notification (lib/notify.ts) is posted per new
 * run, with its name and what it is asking, under its own gate (permission, and the page not
 * already being looked at). Two rules for "new" would be two chances to announce navigation.
 */
import { notifyRuns } from "./notify";

export interface Observation {
  /** run ids this screen sees waiting on a human right now */
  waiting: string[];
  /** run ids this screen KNOWS are not waiting: named ones, or everything it did not list */
  cleared: string[] | "others";
  /**
   * What a notification about each waiting run would say: its name, and one sentence of what
   * it is asking (`parkSummary().title`). Optional and per run — a screen that knows less
   * still drives the sound, and its runs are announced by id.
   */
  info?: Record<string, RunNote>;
}

export interface RunNote {
  name: string;
  body: string;
}

/** Which of the waiting runs are NEWS, and what is known after this sighting. Pure. */
export function decideNews(seen: string[] | null, o: Observation): { fresh: string[]; seen: string[] } {
  const waiting = [...new Set(o.waiting)];
  if (seen === null) return { fresh: [], seen: waiting };
  const known = new Set(seen);
  const kept = o.cleared === "others" ? [] : seen.filter((id) => !o.cleared.includes(id));
  return { fresh: waiting.filter((id) => !known.has(id)), seen: [...new Set([...kept, ...waiting])] };
}

export function decideRing(seen: string[] | null, o: Observation, enabled: boolean): { ring: boolean; seen: string[] } {
  const news = decideNews(seen, o);
  return { ring: enabled && news.fresh.length > 0, seen: news.seen };
}

const SEEN_KEY = "howdah-asks-seen";
/** fired by Settings after a save, so a change takes effect without a reload */
export const SETTINGS_CHANGED = "howdah:settings-changed";

function readSeen(): string[] | null {
  try {
    const raw = sessionStorage.getItem(SEEN_KEY);
    const v: unknown = raw === null ? null : JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch { return null; }
}

let enabled: Promise<boolean> | null = null;
function chimeEnabled(): Promise<boolean> {
  enabled ??= fetch("/api/settings")
    .then((r) => (r.ok ? r.json() : null))
    .then((s: unknown) => !!s && typeof s === "object" && (s as { chime?: unknown }).chime === true)
    .catch(() => false);
  return enabled;
}
if (typeof window !== "undefined") window.addEventListener(SETTINGS_CHANGED, () => { enabled = null; });

/**
 * Record what a screen sees; play the sound if it is news and wanted, and post a browser
 * notification for each run that is news (lib/notify.ts decides whether one may be shown).
 * The memory is read and written in ONE synchronous step, after the setting has loaded, so two
 * screens observing at once cannot both call the same run new.
 */
export async function observeAsks(o: Observation): Promise<void> {
  const on = await chimeEnabled();
  const news = decideNews(readSeen(), o);
  try { sessionStorage.setItem(SEEN_KEY, JSON.stringify(news.seen)); } catch { /* private window: nothing to remember */ }
  if (on && news.fresh.length > 0) void new Audio("/chime.wav").play().catch(() => {});
  notifyRuns(news.fresh, o.info ?? {});
}
