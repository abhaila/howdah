/**
 * Usage you can compare (HOW-34) — one rollup of `turn-finalized.usage`, per node@visit and per
 * run, shared by the viewer (web/derive.ts), `howdah metrics` (cli/metrics.ts) and the A/B
 * harness (reviser/eval/ab.ts). The harness-design study HOW-32 applies reports cost per task
 * beside every success rate; a comparison is only as honest as the figure it sums, so this
 * module's job is to never turn "unknown" into a number.
 *
 * Three rules, each one a way the old per-run sum (a `?? 0` over every turn) lied:
 *   - MISSING IS UNKNOWN, NOT ZERO. A turn that did not report a figure leaves it unknown; a
 *     figure no turn reported is `null`. A pre-HOW-34 claude event has `input_tokens` but no
 *     cache fields, so its cache figures read unknown rather than 0.
 *   - UNPRICED IS NOT FREE. codex and cursor report tokens and no price (`cost_source:
 *     "unpriced"`). A rollup that includes one is `partial`, and every rendering of it says so
 *     ("2 of 3 turns unpriced") — a run that fell back from claude to codex never shows a plain
 *     total that silently covers only the claude half.
 *   - THE UNIT IS node@visit. That is what a prompt or config comparison works in; the run total
 *     is the sum of visits, so the two can never disagree.
 *
 * Node-free and dependency-free (type imports only): the browser bundle imports it.
 */
import type { LoggedEvent } from "./events";
import type { TurnUsage } from "../adapter/events";

/** a summed figure: `null` when no turn reported it; `missing` counts turns that did not */
export interface Figure {
  total: number | null;
  missing: number;
}

export interface UsageRollup {
  /** turns finalized (a repair turn is its own turn, HOW-34) */
  turns: number;
  /** turns whose harness reported a price */
  priced_turns: number;
  /** turns whose harness reports no price at all (codex, cursor) */
  unpriced_turns: number;
  /** turns with no usage object whatsoever (a harness that died before reporting) */
  unknown_turns: number;
  input_tokens: Figure;
  cache_read_input_tokens: Figure;
  cache_creation_input_tokens: Figure;
  output_tokens: Figure;
  /** the sum of the PRICED turns — read it with `partial` */
  cost_usd: number | null;
  /** some turn of this rollup has no price: `cost_usd` covers only part of it */
  partial: boolean;
}

export interface VisitUsage extends UsageRollup {
  node: string;
  visit: number;
  /** the harness the visit ran on, from its own prompt-rendered (undefined for non-agent rows) */
  harness?: string;
}

const FIGURES = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"] as const;

export function emptyRollup(): UsageRollup {
  const fig = (): Figure => ({ total: null, missing: 0 });
  return {
    turns: 0, priced_turns: 0, unpriced_turns: 0, unknown_turns: 0,
    input_tokens: fig(), cache_read_input_tokens: fig(), cache_creation_input_tokens: fig(), output_tokens: fig(),
    cost_usd: null, partial: false,
  };
}

/** is this turn's cost known? An old event with a number and no source was claude's report. */
function priced(u: TurnUsage | undefined): boolean {
  if (!u) return false;
  if (u.cost_source === "unpriced") return false;
  return typeof u.cost_usd === "number";
}

/** fold one turn's usage into a rollup (mutates `into`) */
export function addTurn(into: UsageRollup, usage: TurnUsage | undefined): void {
  into.turns++;
  if (!usage) into.unknown_turns++;
  for (const k of FIGURES) {
    const v = usage?.[k];
    if (typeof v === "number") into[k].total = (into[k].total ?? 0) + v;
    else into[k].missing++;
  }
  if (priced(usage)) {
    into.priced_turns++;
    into.cost_usd = round6((into.cost_usd ?? 0) + (usage!.cost_usd as number));
  } else if (usage) {
    into.unpriced_turns++;
  }
  into.partial = into.priced_turns < into.turns;
}

/** fold a whole rollup into another (mutates `into`) — how visits sum to a run */
export function addRollup(into: UsageRollup, from: UsageRollup): void {
  into.turns += from.turns;
  into.priced_turns += from.priced_turns;
  into.unpriced_turns += from.unpriced_turns;
  into.unknown_turns += from.unknown_turns;
  for (const k of FIGURES) {
    if (from[k].total !== null) into[k].total = (into[k].total ?? 0) + from[k].total;
    into[k].missing += from[k].missing;
  }
  if (from.cost_usd !== null) into.cost_usd = round6((into.cost_usd ?? 0) + from.cost_usd);
  into.partial = into.priced_turns < into.turns;
}

/**
 * Per node@visit, in first-seen order. Every visit that FINALIZED a turn gets a row; the
 * harness comes from the visit's own prompt-rendered, which is what a fallback hop changes.
 */
export function usageByVisit(events: readonly LoggedEvent[]): VisitUsage[] {
  const rows = new Map<string, VisitUsage>();
  const harness = new Map<string, string>();
  for (const e of events) {
    if (e.type === "prompt-rendered" && e.harness) harness.set(`${e.node}@${e.visit}`, e.harness);
    if (e.type !== "turn-finalized") continue;
    const key = `${e.node}@${e.visit}`;
    let row = rows.get(key);
    if (!row) rows.set(key, (row = { node: e.node, visit: e.visit, ...emptyRollup() }));
    addTurn(row, e.usage);
  }
  for (const [key, row] of rows) {
    const h = harness.get(key);
    if (h !== undefined) row.harness = h;
  }
  return [...rows.values()];
}

/** the run's total — the sum of its visits, so the two never disagree */
export function rollupRun(events: readonly LoggedEvent[]): UsageRollup {
  const total = emptyRollup();
  for (const v of usageByVisit(events)) addRollup(total, v);
  return total;
}

/** a token figure in words: "1,234", "unknown", or "≥ 1,234 (1 of 3 turns unknown)" */
export function describeFigure(f: Figure): string {
  if (f.total === null) return "unknown";
  if (f.missing === 0) return f.total.toLocaleString("en-US");
  return `≥ ${f.total.toLocaleString("en-US")} (${f.missing} ${f.missing === 1 ? "turn" : "turns"} unknown)`;
}

/** the cost in words, never a plain number when it covers only part of the work */
export function describeCost(r: UsageRollup): string {
  if (r.turns === 0) return "—";
  if (r.cost_usd === null) return `unpriced (${r.turns} ${r.turns === 1 ? "turn" : "turns"})`;
  const money = `$${r.cost_usd.toFixed(4)}`;
  if (!r.partial) return money;
  const gap = r.turns - r.priced_turns;
  return `${money} (partial: ${gap} of ${r.turns} turns unpriced)`;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
