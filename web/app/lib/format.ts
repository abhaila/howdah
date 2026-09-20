/**
 * The viewer's readings of machine values — durations, waits, clock times, context values.
 * Moved out of main.tsx (HOW-16 P1) so a screen can import one without importing the app.
 */
import type { RunDetail } from "../../derive";

/** ms → the shortest honest reading: 0.9s / 3m 10s / 1h 04m */
export function fmtDur(ms: number | null): string {
  if (ms === null) return "…";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** how long an ask has been standing, in minutes and hours — never seconds */
export function fmtWait(sinceIso: string, now: number): string {
  const m = Math.floor(Math.max(0, now - new Date(sinceIso).getTime()) / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtWhen(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

export function fmtValue(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v) ?? String(v);
}

/** a step still running has no duration_ms yet, so its length is measured against `now` */
export function liveDuration(row: Pick<RunDetail["timeline"][number], "duration_ms" | "started_at">, now: number): number {
  return row.duration_ms ?? Math.max(0, now - new Date(row.started_at).getTime());
}
