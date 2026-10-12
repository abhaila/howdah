/**
 * HOW-46 / HOW-49 / HOW-50: "is it still making progress?" — ONE rule, shared by the live
 * turn note, the progress panel and the runs board, so the three cannot disagree about when a
 * run has gone quiet.
 *
 * The clock is the time since the agent last produced anything (`last_agent_event_at`, derived
 * from the log). It is the human counterpart of a stuck detector: it says how long it has been,
 * and past `QUIET_MS` it turns amber. It never says the agent is stuck — a long build or test
 * run is silent and fine — so it is a colour, not a park.
 */

/** five minutes of silence from the agent is worth a glance; it is not, by itself, a failure */
export const QUIET_MS = 5 * 60_000;

/** an age in the shortest honest unit: 12s / 4m / 1h 05m */
export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export interface Liveness {
  /** ms since the agent last produced anything; null when it never has */
  ageMs: number | null;
  /** silent for at least QUIET_MS */
  quiet: boolean;
}

export function liveness(lastAt: string | null, now: number, quietMs = QUIET_MS): Liveness {
  if (!lastAt) return { ageMs: null, quiet: false };
  const t = new Date(lastAt).getTime();
  if (!Number.isFinite(t)) return { ageMs: null, quiet: false };
  const ageMs = Math.max(0, now - t);
  return { ageMs, quiet: ageMs >= quietMs };
}
