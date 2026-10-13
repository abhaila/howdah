/**
 * Value metrics over run logs (system-map "Success Criteria", eng review D24, T16) —
 * `bun cli/main.ts metrics [--json]`.
 *
 * Does designing on the map pay for itself? Each `implement-slice` run is measured against
 * the `implement-ticket` baseline, from the run logs alone (the log is the only storage):
 *
 *   review time      ghost-proposed → that round's decision (slice-approved / slice-feedback-sent)
 *   redraws          proposal rounds after the first
 *   reject loops     local_review → reject edges taken after the first approval (baseline: all)
 *   drift at publish the counts of the last drift-detected before the last delivery.publish start
 *   abandonment      runs aborted after a proposal (baseline: aborted runs) — a PR closed on
 *                    the forge ends `aborted` too, through the `closed` terminal: that is not
 *                    an abandoned design and is reported as `pr_closed` instead
 *   cost             HOW-34: each run's usage rollup (log/usage.ts); the summary's median and
 *                    total are over PRICED runs only, and say how many runs were partial
 *
 * Success (the design doc): fewer reject loops and less structural rework than the baseline over
 * the next 5 tickets, with at most 1 abandoned. The functions are pure over events so they are
 * tested on fixture logs; readRunMetrics is the only part that touches disk.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readLog } from "../log/write";
import type { LoggedEvent } from "../log/events";
import type { DriftOutcome } from "../map/drift";
import { PROBLEM_OUTCOMES } from "../engine/slice-map";
import { describeCost, rollupRun, type UsageRollup } from "../log/usage";

export const SLICE_GRAPH = "implement-slice";
export const BASELINE_GRAPH = "implement-ticket";
const LOCAL_REVIEW = "implementation.local_review";
const PUBLISH = "delivery.publish";
/** the delivery terminal a closed PR ends in (graphs/delivery.ts) — an outcome, not an abandonment */
const CLOSED_TERMINAL = "closed";

export interface RunMetrics {
  run: string;
  graph: string;
  status: "success" | "failed" | "aborted" | "running";
  started_at: string;
  /** proposal rounds (ghost-proposed events) */
  proposals: number;
  redraws: number;
  /** per DECIDED round, milliseconds from proposal to decision */
  review_ms: number[];
  reject_loops: number;
  /** drift counts of the code as last published; null when nothing was published with a drift check */
  drift_at_publish: Record<DriftOutcome, number> | null;
  abandoned: boolean;
  /** the run ended because its PR was closed (terminal `closed`), not because it was abandoned */
  pr_closed: boolean;
  /** HOW-34: the run's usage — `cost_usd` read with `partial` */
  usage: UsageRollup;
}

/** One run's metrics, or null for a log with no run-started. */
export function runMetrics(run: string, events: readonly LoggedEvent[]): RunMetrics | null {
  const started = events.find((e) => e.type === "run-started");
  if (!started || started.type !== "run-started") return null;
  const finished = events.findLast((e) => e.type === "run-finished");
  const status = finished?.type === "run-finished" ? finished.outcome : "running";

  const rounds = events.filter((e) => e.type === "ghost-proposed");
  const review_ms: number[] = [];
  for (const r of rounds) {
    if (r.type !== "ghost-proposed") continue;
    const decision = events.find((e) => (e.type === "slice-approved" || e.type === "slice-feedback-sent") && e.proposal_id === r.proposal_id);
    if (decision) review_ms.push(Date.parse(decision.ts) - Date.parse(r.ts));
  }

  const firstApproval = events.find((e) => e.type === "slice-approved")?.seq ?? 0;
  const reject_loops = events.filter(
    (e) => e.type === "edge-taken" && e.from === LOCAL_REVIEW && /reject/.test(e.label ?? "") && e.seq > firstApproval,
  ).length;

  const lastPublish = events.findLast((e) => e.type === "node-started" && e.node === PUBLISH);
  const drift = lastPublish ? events.findLast((e) => e.type === "drift-detected" && e.seq < lastPublish.seq) : undefined;

  const isSlice = started.graph === SLICE_GRAPH;
  const prClosed = status === "aborted" && events.some((e) => e.type === "edge-taken" && e.to === CLOSED_TERMINAL);
  return {
    run,
    graph: started.graph,
    status,
    started_at: started.ts,
    proposals: rounds.length,
    redraws: Math.max(0, rounds.length - 1),
    review_ms,
    reject_loops,
    drift_at_publish: drift?.type === "drift-detected" ? { ...drift.counts } : null,
    abandoned: status === "aborted" && !prClosed && (!isSlice || rounds.length > 0),
    pr_closed: prClosed,
    usage: rollupRun(events),
  };
}

export interface MetricsSummary {
  runs: number;
  finished: number;
  median_review_ms: number | null;
  mean_redraws: number | null;
  mean_reject_loops: number | null;
  /** PROBLEM_OUTCOMES (missing, changed-unexpectedly, still-present, unchanged), summed over runs' drift at publish */
  drift_problems_at_publish: number;
  abandoned: number;
  /**
   * HOW-34: median and total cost over the runs whose cost is COMPLETE. A partial run (a turn
   * on an unpriced harness) is counted, not averaged in as if its figure were the whole cost.
   */
  median_cost_usd: number | null;
  total_cost_usd: number | null;
  priced_runs: number;
  partial_cost_runs: number;
}

export interface MetricsReport {
  slice: MetricsSummary;
  baseline: MetricsSummary;
  runs: RunMetrics[];
}

const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export function summarise(runs: readonly RunMetrics[]): MetricsSummary {
  return {
    runs: runs.length,
    finished: runs.filter((r) => r.status !== "running").length,
    median_review_ms: median(runs.flatMap((r) => r.review_ms)),
    mean_redraws: mean(runs.map((r) => r.redraws)),
    mean_reject_loops: mean(runs.map((r) => r.reject_loops)),
    drift_problems_at_publish: runs.reduce((n, r) => n + (r.drift_at_publish ? PROBLEM_OUTCOMES.reduce((m, o) => m + (r.drift_at_publish?.[o] ?? 0), 0) : 0), 0),
    abandoned: runs.filter((r) => r.abandoned).length,
    ...costSummary(runs),
  };
}

function costSummary(runs: readonly RunMetrics[]): Pick<MetricsSummary, "median_cost_usd" | "total_cost_usd" | "priced_runs" | "partial_cost_runs"> {
  const complete = runs.filter((r) => r.usage.turns > 0 && !r.usage.partial && r.usage.cost_usd !== null).map((r) => r.usage.cost_usd!);
  const med = (() => {
    if (!complete.length) return null;
    const s = [...complete].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  })();
  return {
    median_cost_usd: med === null ? null : Math.round(med * 1e4) / 1e4,
    total_cost_usd: complete.length ? Math.round(complete.reduce((a, b) => a + b, 0) * 1e4) / 1e4 : null,
    priced_runs: complete.length,
    partial_cost_runs: runs.filter((r) => r.usage.turns > 0 && r.usage.partial).length,
  };
}

/** Slice runs vs the implement-ticket baseline; other graphs are ignored. Newest first. */
export function metricsReport(all: readonly RunMetrics[]): MetricsReport {
  const runs = all.filter((r) => r.graph === SLICE_GRAPH || r.graph === BASELINE_GRAPH).sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0));
  return {
    slice: summarise(runs.filter((r) => r.graph === SLICE_GRAPH)),
    baseline: summarise(runs.filter((r) => r.graph === BASELINE_GRAPH)),
    runs,
  };
}

/** Every run under `runsDir` with a readable log (a torn tail is tolerated by readLog). */
export function readRunMetrics(runsDir: string): RunMetrics[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((d) => existsSync(join(runsDir, d, "run.jsonl")))
    .flatMap((d) => {
      const m = runMetrics(d, readLog(join(runsDir, d, "run.jsonl")));
      return m ? [m] : [];
    });
}

const fmtMs = (ms: number | null) => (ms === null ? "—" : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);
const fmt = (n: number | null) => (n === null ? "—" : String(n));
const fmtUsd = (n: number | null) => (n === null ? "—" : `$${n.toFixed(4)}`);
/** a summary's cost cell: "$0.0420" or "$0.0420 +2 partial" — a partial run is never averaged in */
const fmtCost = (s: MetricsSummary) => `${fmtUsd(s.median_cost_usd)}${s.partial_cost_runs ? ` +${s.partial_cost_runs} partial` : ""}`;

export function formatMetrics(report: MetricsReport): string {
  const row = (label: string, s: MetricsSummary) =>
    `${label.padEnd(24)} ${String(s.runs).padStart(4)} ${String(s.finished).padStart(8)} ${fmtMs(s.median_review_ms).padStart(12)} ${fmt(s.mean_redraws).padStart(8)} ${fmt(s.mean_reject_loops).padStart(13)} ${String(s.drift_problems_at_publish).padStart(15)} ${String(s.abandoned).padStart(9)} ${fmtCost(s).padStart(22)}`;
  const lines = [
    `${"".padEnd(24)} ${"runs".padStart(4)} ${"finished".padStart(8)} ${"review(med)".padStart(12)} ${"redraws".padStart(8)} ${"reject loops".padStart(13)} ${"drift@publish".padStart(15)} ${"abandoned".padStart(9)} ${"cost(med)".padStart(22)}`,
    row(SLICE_GRAPH, report.slice),
    row(`${BASELINE_GRAPH} (base)`, report.baseline),
  ];
  if (report.runs.length) {
    lines.push("", "per run (newest first):");
    for (const r of report.runs) {
      const drift = r.drift_at_publish ? PROBLEM_OUTCOMES.map((o) => `${o} ${r.drift_at_publish?.[o] ?? 0}`).join(", ") : "no drift check";
      lines.push(
        `  ${r.run}  ${r.graph}  ${r.status}${r.abandoned ? " (abandoned)" : r.pr_closed ? " (PR closed)" : ""}  rounds ${r.proposals}  review ${r.review_ms.map((ms) => fmtMs(ms)).join("/") || "—"}  rejects ${r.reject_loops}  ${drift}  cost ${describeCost(r.usage)}`,
      );
    }
  }
  lines.push("", "success = fewer reject loops and less drift at publish than the baseline over the next 5 tickets, at most 1 abandoned");
  return lines.join("\n");
}
