/**
 * The viewer's readings of machine values — durations, waits, clock times, context values.
 * Moved out of main.tsx (HOW-16 P1) so a screen can import one without importing the app.
 */
import type { RunDetail } from "../../derive";

/**
 * ms → the shortest honest reading: 0.9s / 3m 10s / 1h 04m.
 * HOW-68: rounded ONCE, to whole seconds, before it is split — rounding the seconds on their
 * own printed "5m 60s" for 5m 59.6s, and "59.96s → 60.0s" beside a neighbour reading "1m 0s".
 */
export function fmtDur(ms: number | null): string {
  if (ms === null) return "…";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m ${total % 60}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** how long an ask has been standing, in minutes and hours — never seconds */
export function fmtWait(sinceIso: string, now: number): string {
  const m = Math.floor(Math.max(0, now - new Date(sinceIso).getTime()) / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  // the same shape as fmtDur's hours ("8h 00m", not "8h 0m"): one way to write a length of time
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/**
 * HOW-18: what a run is called wherever it is labelled — the operator's name, else the goal,
 * else the run id. One rule so the Runs list and the run heading cannot disagree.
 */
export function runLabel(s: { id: string; name?: string | null; goal?: string | null }): string {
  return s.name || s.goal || s.id;
}

/**
 * A moment, the ONE way the viewer writes it (HOW-68): the reader's own locale, a medium date
 * and the time to the minute — "12 Nov 2026, 10:11". It was `toLocaleString()` in some places
 * (with seconds: "11/12/2026, 10:11:37 AM"), `toLocaleDateString()` and `toLocaleTimeString()`
 * in others, so the same event read three ways depending on the screen.
 */
const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const DAY = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const CLOCK = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const valid = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};
export function fmtWhen(iso: string | null | undefined): string {
  const d = valid(iso);
  return d ? WHEN.format(d) : "—";
}
/** the day alone, for a history row where the time is noise */
export function fmtDay(iso: string | null | undefined): string {
  const d = valid(iso);
  return d ? DAY.format(d) : "—";
}
/** the time alone, for something that happens today (an allowance resetting) */
export function fmtClock(iso: string | null | undefined): string {
  const d = valid(iso);
  return d ? CLOCK.format(d) : "—";
}

export function fmtValue(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v) ?? String(v);
}

/** a step still running has no duration_ms yet, so its length is measured against `now` */
export function liveDuration(row: Pick<RunDetail["timeline"][number], "duration_ms" | "started_at">, now: number): number {
  return row.duration_ms ?? Math.max(0, now - new Date(row.started_at).getTime());
}
