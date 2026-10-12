/**
 * HOW-50: which group a run sits in on the board. Node-free (the browser groups the rows), and
 * kept apart from web/board.ts, which reads logs and runs git.
 */
import type { RunSummary } from "../../derive";

/** the board's groups, in the order they are drawn — needs-you first, always */
export type BoardGroup = "needs-you" | "running" | "recent" | "older";

/** "recently finished" means within a day */
export const RECENT_MS = 24 * 60 * 60_000;

/**
 * NEEDS-INPUT OUTRANKS EVERYTHING (CLAUDE.md UI conventions): a run parked on a human is never
 * filed under "running" or "failed". A run whose harness died mid-step, or that failed and can
 * be retried, also needs a human to act — so it is grouped with them, not left among the
 * finished.
 */
export function boardGroup(r: Pick<RunSummary, "status" | "last_event_at">, now: number): BoardGroup {
  if (r.status === "needs-input" || r.status === "harness-dead" || r.status === "failed-recoverable") return "needs-you";
  if (r.status === "running" || r.status === "waiting" || r.status === "queued") return "running";
  const at = r.last_event_at ? new Date(r.last_event_at).getTime() : 0;
  return now - at <= RECENT_MS ? "recent" : "older";
}
