/**
 * HOW-50: which group a run sits in on the board. Node-free (the browser groups the rows), and
 * kept apart from web/board.ts, which reads logs and runs git.
 */
import type { RunSummary } from "../../derive";
import type { RunBoardRow } from "../../board";
import { parkSummary } from "../../../core/park-summary";
import { fmtAgo, liveness } from "./liveness";

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

// ---- HOW-68: what a row SAYS ------------------------------------------------------------

/**
 * One row's third column — what the run is waiting for, or doing, or how it ended — as parts
 * the row draws in order. The old row answered "what is it waiting for" with "waiting 12m":
 * the duration of a question it never showed. Now a waiting run says the question
 * (`parkSummary()`, the same sentence its ask card and its notification use), a running one
 * names its step, and a finished one says how it ended.
 *
 * Parts rather than a string because the three kinds of text are drawn three ways
 * (DESIGN.md Type): `strong` is the bold label that marks a waiting row, `mono` is a step id —
 * something you would paste — and `text` is everything read. Pure, so the wording is pinned
 * in a test without a DOM.
 */
export type LinePart = { kind: "strong" | "mono" | "text"; value: string };
export interface RunLine {
  parts: LinePart[];
  /** a live run that has produced nothing for QUIET_MS (lib/liveness.ts) — said in words, never in amber */
  quiet: boolean;
}

type LineRow = Pick<RunBoardRow, "status" | "current" | "park" | "needs_input_reason" | "failure" | "paused" | "outcome" | "pr" | "commits" | "last_activity_at">;

const strong = (value: string): LinePart => ({ kind: "strong", value });
const mono = (value: string): LinePart => ({ kind: "mono", value });
const text = (value: string): LinePart => ({ kind: "text", value });
/** a label reads as a sentence start: "Question." — but "Publish?" already ends itself */
const labelled = (label: string) => strong(/[.?!]$/.test(label) ? label : `${label}.`);
const firstLine = (s: string) => (s.split("\n").find((l) => l.trim() !== "") ?? "").trim();

export function runLine(r: LineRow, now: number): RunLine {
  const node = r.current?.node ?? null;
  const commits = r.commits ? ` · ${r.commits} commit${r.commits === 1 ? "" : "s"}` : "";
  if (r.status === "needs-input") {
    const s = parkSummary(r.park ?? { node });
    // a park this file's vocabulary does not know: the engine's own first line says more than "is waiting on you"
    const known = r.park != null && (r.park.code != null || r.park.ask != null);
    const title = !known && r.needs_input_reason ? firstLine(r.needs_input_reason) : s.title;
    return { parts: [labelled(s.label), text(title)], quiet: false };
  }
  if (r.status === "harness-dead") {
    return { parts: [strong("Runner died."), ...(node ? [text("It stopped at"), mono(node), text("— resume it to continue.")] : [text("Resume it to continue.")])], quiet: false };
  }
  if (r.status === "failed-recoverable") {
    return { parts: [strong("Step failed."), ...(r.failure ? [mono(r.failure.node), text("can be retried.")] : [text("It can be retried.")])], quiet: false };
  }
  if (r.status === "running") {
    const { ageMs, quiet } = liveness(r.last_activity_at, now);
    const said = [
      r.current ? `${fmtAgo(now - new Date(r.current.since).getTime())} on this step` : "",
      // under five seconds is "now": "active 0s ago" is a number nobody needed
      ageMs === null ? "" : quiet ? `no output for ${fmtAgo(ageMs)}` : ageMs < 5000 ? "active now" : `active ${fmtAgo(ageMs)} ago`,
      commits.replace(/^ · /, ""),
    ].filter(Boolean).join(" · ");
    return { parts: node ? [mono(node), ...(said ? [text(`· ${said}`)] : [])] : [text(said || "Starting")], quiet };
  }
  if (r.status === "waiting") {
    if (r.paused) return { parts: [text("Paused at"), ...(node ? [mono(node)] : [])], quiet: false };
    return { parts: [...(node ? [mono(node)] : []), text(node ? "· waiting, not on you" : "Waiting, not on you")], quiet: false };
  }
  if (r.status === "queued") return { parts: [text("Queued")], quiet: false };
  if (r.status === "done") return { parts: [text(`${r.pr?.state === "MERGED" ? "Merged" : "Done"}${commits}`)], quiet: false };
  // failed-terminal
  if (r.outcome === "aborted") return { parts: [text("Aborted"), ...(r.failure ? [text("after"), mono(r.failure.node), text("failed")] : [])], quiet: false };
  return { parts: r.failure ? [text("Failed at"), mono(r.failure.node)] : [text("Failed")], quiet: false };
}

/** the PR chip's words — the state, unless the row's own text already said "Merged" */
export function prChip(r: Pick<RunBoardRow, "status" | "pr">): string | null {
  if (!r.pr) return null;
  // the forge's enum is `CHANGES_REQUIRED`; a chip is read, so it says "changes required"
  return r.status === "done" && r.pr.state === "MERGED" ? "PR" : `PR ${r.pr.state.toLowerCase().replace(/_/g, " ")}`;
}

/**
 * The age column: how long it has been WAITING (needs you), RUNNING (in flight) or FINISHED.
 * `what` is the column's meaning in words, for the tooltip — a bare "2h 53m" is ambiguous.
 */
export function runAge(r: Pick<RunBoardRow, "status" | "waiting_since" | "started_at" | "last_event_at">, now: number): { text: string; what: string; at: string | null } {
  const since = (iso: string | null) => (iso ? Math.max(0, now - new Date(iso).getTime()) : null);
  if (r.status === "needs-input" && r.waiting_since) return { text: fmtAgo(since(r.waiting_since)!), what: "Waiting on you since", at: r.waiting_since };
  if (r.status === "running" || r.status === "waiting" || r.status === "queued") {
    const ms = since(r.started_at);
    return { text: ms === null ? "—" : fmtAgo(ms), what: "Started", at: r.started_at };
  }
  const ms = since(r.last_event_at);
  return { text: ms === null ? "—" : `${fmtAgo(ms)} ago`, what: r.status === "harness-dead" || r.status === "failed-recoverable" ? "Last event" : "Finished", at: r.last_event_at };
}

/** does a row match the list's filter box: every word, in its name, goal, id, graph, status or step */
export function matchesFilter(r: Pick<RunBoardRow, "id" | "name" | "goal" | "graph" | "status" | "current">, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [r.name ?? "", r.goal ?? "", r.id, r.graph, r.status.replace("-", " "), r.status, r.current?.node ?? ""].join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}
