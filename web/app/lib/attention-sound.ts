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
 */
export interface Observation {
  /** run ids this screen sees waiting on a human right now */
  waiting: string[];
  /** run ids this screen KNOWS are not waiting: named ones, or everything it did not list */
  cleared: string[] | "others";
}

export function decideRing(seen: string[] | null, o: Observation, enabled: boolean): { ring: boolean; seen: string[] } {
  if (seen === null) return { ring: false, seen: [...new Set(o.waiting)] };
  const known = new Set(seen);
  const fresh = o.waiting.some((id) => !known.has(id));
  const kept = o.cleared === "others" ? [] : seen.filter((id) => !o.cleared.includes(id));
  return { ring: enabled && fresh, seen: [...new Set([...kept, ...o.waiting])] };
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

/** Record what a screen sees and play the sound if, and only if, it is news and wanted. */
export async function observeAsks(o: Observation): Promise<void> {
  const on = await chimeEnabled();
  const next = decideRing(readSeen(), o, on);
  try { sessionStorage.setItem(SEEN_KEY, JSON.stringify(next.seen)); } catch { /* private window: nothing to remember */ }
  if (next.ring) void new Audio("/chime.wav").play().catch(() => {});
}
