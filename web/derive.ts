/**
 * Pure derivations from a run's event log — everything the web app renders (R3).
 * The log is the only storage; these functions are the read model.
 *
 * Status rules (design review): ONE canonical enum, one renderer, and
 * needs-input OUTRANKS failed — a parked run needing a human is never shown as merely
 * "failed", because the human is the unblock.
 */
import type { LoggedEvent } from "../log/events";
import { coalesce, outcomesByHash, type CoalescedTurn, type JoinedOutcome } from "../log/coalesce";

export type RunStatus =
  | "queued"
  | "running"
  | "needs-input"
  | "waiting"
  | "failed-recoverable"
  | "failed-terminal"
  | "done"
  | "harness-dead";

export interface RunSummary {
  id: string;
  graph: string;
  goal: string;
  status: RunStatus;
  started_at: string | null;
  last_event_at: string | null;
  /** set when status is needs-input — the product's most load-bearing number */
  waiting_since: string | null;
  needs_input_reason: string | null;
}

export interface TimelineRow {
  node: string;
  visit: number;
  started_at: string;
  finished_at: string | null;
  status: "running" | "succeeded" | "failed";
  duration_ms: number | null;
}

export interface RunDetail {
  summary: Omit<RunSummary, "id">;
  turns: CoalescedTurn[];
  timeline: TimelineRow[];
  /** rendered prompt + context per node@visit — R3.1's home ("Prompt & context") */
  renders: Extract<LoggedEvent, { type: "prompt-rendered" }>[];
  outcomes: JoinedOutcome[];
  usage: { input_tokens: number; output_tokens: number; cost_usd: number };
  /** latest allowance observation per harness — exhausted/unreachable/unavailable distinct */
  allowance: Extract<LoggedEvent, { type: "allowance" }>[];
  /** the unresolved ask, if any — drives the pinned banner + reply card */
  ask: Extract<LoggedEvent, { type: "attention-raised" }> | null;
  pinned_prompts: Record<string, number>;
  /** latest reconciler observation (repo runs) — the GIT rail section */
  git: Extract<LoggedEvent, { type: "reconciled" }> | null;
  /** every PR ever observed on this run, deduped by url, latest state wins */
  pull_requests: Array<{ url: string; state: string; observed_at: string }>;
  identity: { cwd: string | null; folder_kind: "repo" | "plain" | null };
  events_seq: number;
}

export function deriveStatus(events: LoggedEvent[]): { status: RunStatus; ask: RunDetail["ask"] } {
  let finished: Extract<LoggedEvent, { type: "run-finished" }> | null = null;
  let ask: RunDetail["ask"] = null;
  let sawStart = false;
  let lastFailed = false;
  for (const e of events) {
    if (e.type === "run-started") sawStart = true;
    else if (e.type === "run-finished") finished = e;
    else if (e.type === "attention-raised") ask = e;
    else if (e.type === "attention-resolved") ask = null;
    else if (e.type === "node-finished") lastFailed = e.status === "failed";
    else if (e.type === "node-started") lastFailed = false;
  }
  // needs-input outranks everything except a completed run
  if (finished) return { status: finished.outcome === "success" ? "done" : "failed-terminal", ask: null };
  if (ask) return { status: "needs-input", ask };
  if (!sawStart) return { status: "queued", ask: null };
  if (lastFailed) return { status: "failed-recoverable", ask: null };
  return { status: "running", ask: null };
}

export function deriveSummary(id: string, events: LoggedEvent[]): RunSummary {
  const { status, ask } = deriveStatus(events);
  const started = events.find((e) => e.type === "run-started");
  return {
    id,
    graph: started?.type === "run-started" ? started.graph : "?",
    goal: started?.type === "run-started" ? String((started.inputs as any)?.goal ?? "") : "",
    status,
    started_at: events[0]?.ts ?? null,
    last_event_at: events.at(-1)?.ts ?? null,
    waiting_since: ask?.ts ?? null,
    needs_input_reason: ask?.reason ?? null,
  };
}

export function deriveTimeline(events: LoggedEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const open = new Map<string, TimelineRow>();
  for (const e of events) {
    if (e.type === "node-started") {
      const row: TimelineRow = { node: e.node, visit: e.visit, started_at: e.ts, finished_at: null, status: "running", duration_ms: null };
      rows.push(row);
      open.set(`${e.node}@${e.visit}`, row);
    } else if (e.type === "node-finished") {
      const row = open.get(`${e.node}@${e.visit}`);
      if (row) {
        row.finished_at = e.ts;
        row.status = e.status;
        row.duration_ms = new Date(e.ts).getTime() - new Date(row.started_at).getTime();
        open.delete(`${e.node}@${e.visit}`);
      }
    }
  }
  return rows;
}

export function deriveDetail(id: string, events: LoggedEvent[]): RunDetail {
  const summary = deriveSummary(id, events);
  const usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  const allowanceByHarness = new Map<string, Extract<LoggedEvent, { type: "allowance" }>>();
  const renders: RunDetail["renders"] = [];
  let pinned: Record<string, number> = {};

  for (const e of events) {
    if (e.type === "turn-finalized" && e.usage) {
      usage.input_tokens += e.usage.input_tokens ?? 0;
      usage.output_tokens += e.usage.output_tokens ?? 0;
      usage.cost_usd += e.usage.cost_usd ?? 0;
    } else if (e.type === "allowance") {
      allowanceByHarness.set(e.harness, e); // latest wins — freshness matters
    } else if (e.type === "prompt-rendered") {
      renders.push(e);
    } else if (e.type === "run-started") {
      pinned = e.pinned_prompts as Record<string, number>;
    }
  }

  let git: RunDetail["git"] = null;
  const prs = new Map<string, { url: string; state: string; observed_at: string }>();
  let identity: RunDetail["identity"] = { cwd: null, folder_kind: null };
  for (const e of events) {
    if (e.type === "reconciled") {
      git = e;
      if (e.forge && e.forge.kind === "pr") prs.set(e.forge.url, { url: e.forge.url, state: e.forge.state, observed_at: e.ts });
    } else if (e.type === "run-started") {
      identity = { cwd: e.cwd ?? null, folder_kind: e.folder_kind ?? null };
    }
  }

  const { ask } = deriveStatus(events);
  const { id: _id, ...summaryRest } = summary;
  return {
    summary: summaryRest,
    turns: coalesce(events),
    timeline: deriveTimeline(events),
    renders,
    outcomes: [...outcomesByHash(events).values()],
    usage: { ...usage, cost_usd: Math.round(usage.cost_usd * 1e6) / 1e6 },
    allowance: [...allowanceByHarness.values()],
    ask,
    pinned_prompts: pinned,
    git,
    pull_requests: [...prs.values()],
    identity,
    events_seq: events.at(-1)?.seq ?? 0,
  };
}

/** runs list ordering: needs-input first (longest wait first), then running, then terminal */
export function sortRuns(runs: RunSummary[]): RunSummary[] {
  const rank = (s: RunStatus): number =>
    s === "needs-input" ? 0 : s === "harness-dead" ? 1 : s === "running" || s === "waiting" || s === "queued" ? 2 : s === "failed-recoverable" ? 3 : 4;
  return [...runs].sort((a, b) => {
    const r = rank(a.status) - rank(b.status);
    if (r !== 0) return r;
    if (a.status === "needs-input" && b.status === "needs-input")
      return (a.waiting_since ?? "").localeCompare(b.waiting_since ?? ""); // longest wait first
    return (b.last_event_at ?? "").localeCompare(a.last_event_at ?? "");
  });
}
