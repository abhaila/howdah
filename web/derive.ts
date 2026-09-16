/**
 * Pure derivations from a run's event log — everything the web app renders (R3).
 * The log is the only storage; these functions are the read model.
 *
 * Status rules (design review): ONE canonical enum, one renderer, and
 * needs-input OUTRANKS failed — a parked run needing a human is never shown as merely
 * "failed", because the human is the unblock.
 */
import type { LoggedEvent } from "../log/events";
import type { Scope } from "../core/context";
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
  /** the most recent failure, kept visible even after its ask was resolved */
  failure: { node: string; visit: number; reason: string | null; at: string } | null;
  /** paused by the operator (status shows waiting) */
  paused: boolean;
  outcome: "success" | "failed" | "aborted" | null;
}

export interface TimelineRow {
  node: string;
  visit: number;
  started_at: string;
  finished_at: string | null;
  status: "running" | "succeeded" | "failed";
  duration_ms: number | null;
  /** ms from the run's first step to this one — a bar can be placed without rescanning */
  offset_ms: number;
  /** the run's whole span, repeated per row so the view needs no second pass. A step still
   *  running measures to the last event, which is the only "now" the log knows about. */
  run_span_ms: number;
  /**
   * Of this attempt's duration, how much was spent waiting on a HUMAN (R3.3). Derived by
   * overlapping each attention-raised → attention-resolved window with the attempt's own
   * interval, so a run parked AFTER a step failed does not charge that wait to the step.
   * No new event type: both events already exist.
   */
  waiting_ms: number;
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
  /** the Logs tab's rows, derived once here so the view never re-walks the log */
  log_rows: LogRow[];
  /** the Context tab: every declared key, written or not */
  context: ContextEntry[];
  identity: { cwd: string | null; folder_kind: "repo" | "plain" | null };
  events_seq: number;
}

export function deriveStatus(events: LoggedEvent[]): { status: RunStatus; ask: RunDetail["ask"]; failure: RunSummary["failure"]; paused: boolean; outcome: RunSummary["outcome"] } {
  let finished: Extract<LoggedEvent, { type: "run-finished" }> | null = null;
  let ask: RunDetail["ask"] = null;
  let sawStart = false;
  let lastFailed: { node: string; visit: number; at: string } | null = null;
  let failure: RunSummary["failure"] = null;
  let paused = false;
  for (const e of events) {
    if (e.type === "run-started") sawStart = true;
    else if (e.type === "run-finished") finished = e;
    else if (e.type === "attention-raised") {
      ask = e;
      // a park right after a failed attempt carries the WHY — keep it past resolution
      if (lastFailed && e.node === lastFailed.node && e.visit === lastFailed.visit)
        failure = { node: e.node, visit: e.visit, reason: e.reason, at: e.ts };
    } else if (e.type === "attention-resolved") ask = null;
    else if (e.type === "run-paused") paused = true;
    else if (e.type === "run-resumed") paused = false;
    else if (e.type === "node-finished") {
      if (e.status === "failed") {
        lastFailed = { node: e.node, visit: e.visit, at: e.ts };
        failure = { node: e.node, visit: e.visit, reason: null, at: e.ts }; // reason may follow
      } else lastFailed = null;
    } else if (e.type === "node-started") lastFailed = null;
  }
  // needs-input outranks everything except a completed run
  if (finished)
    return { status: finished.outcome === "success" ? "done" : "failed-terminal", ask: null, failure, paused: false, outcome: finished.outcome };
  if (ask) return { status: "needs-input", ask, failure, paused, outcome: null };
  if (paused) return { status: "waiting", ask: null, failure, paused, outcome: null };
  if (!sawStart) return { status: "queued", ask: null, failure, paused, outcome: null };
  if (lastFailed) return { status: "failed-recoverable", ask: null, failure, paused, outcome: null };
  return { status: "running", ask: null, failure: null, paused, outcome: null };
}

export function deriveSummary(id: string, events: LoggedEvent[]): RunSummary {
  const { status, ask, failure, paused, outcome } = deriveStatus(events);
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
    failure,
    paused,
    outcome,
  };
}

export function deriveTimeline(events: LoggedEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const open = new Map<string, TimelineRow>();
  for (const e of events) {
    if (e.type === "node-started") {
      const row: TimelineRow = { node: e.node, visit: e.visit, started_at: e.ts, finished_at: null, status: "running", duration_ms: null, offset_ms: 0, run_span_ms: 0, waiting_ms: 0 };
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
  // second pass: place every row on one shared axis
  if (rows.length === 0) return rows;
  const origin = new Date(rows[0]!.started_at).getTime();
  const lastEventAt = events.at(-1)?.ts;
  // a run still waiting on a human measures to NOW, not to its last event — otherwise the
  // waiting bar freezes the moment the ask was raised and the wait looks like nothing
  const openAsk = (() => {
    let open = false;
    for (const e of events) {
      if (e.type === "attention-raised") open = true;
      else if (e.type === "attention-resolved" || e.type === "run-finished") open = false;
    }
    return open;
  })();
  const end = Math.max(
    ...rows.map((r) => new Date(r.finished_at ?? r.started_at).getTime()),
    lastEventAt ? new Date(lastEventAt).getTime() : origin,
    openAsk ? Date.now() : origin,
  );
  const span = Math.max(1, end - origin); // never zero: a bar divides by this
  for (const r of rows) {
    r.offset_ms = new Date(r.started_at).getTime() - origin;
    r.run_span_ms = span;
  }

  // third pass: how much of each attempt was a human not looking
  const asks = new Map<string, number>(); // node@visit -> raised at
  const waiting = new Map<string, number>();
  const charge = (key: string, from: number, to: number) => {
    const row = rows.find((r) => `${r.node}@${r.visit}` === key);
    if (!row) return;
    const rowStart = new Date(row.started_at).getTime();
    const rowEnd = row.finished_at ? new Date(row.finished_at).getTime() : end;
    const overlap = Math.min(to, rowEnd) - Math.max(from, rowStart);
    if (overlap > 0) waiting.set(key, (waiting.get(key) ?? 0) + overlap);
  };
  for (const e of events) {
    if (e.type === "attention-raised") asks.set(`${e.node}@${e.visit}`, new Date(e.ts).getTime());
    else if (e.type === "attention-resolved") {
      const key = `${e.node}@${e.visit}`;
      const from = asks.get(key);
      if (from !== undefined) { charge(key, from, new Date(e.ts).getTime()); asks.delete(key); }
    }
  }
  for (const [key, from] of asks) charge(key, from, end); // still waiting: measure to now
  for (const r of rows) r.waiting_ms = waiting.get(`${r.node}@${r.visit}`) ?? 0;

  return rows;
}

export function deriveDetail(id: string, events: LoggedEvent[], declarations: Declarations = {}): RunDetail {
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
    log_rows: deriveLogRows(events),
    context: deriveContextTable(events, declarations),
    identity,
    events_seq: events.at(-1)?.seq ?? 0,
  };
}

/**
 * Logs (T24, story 7) — every event as one dense row, Logfire's shape.
 *
 * The switch is EXHAUSTIVE on purpose: the `never` fallthrough means adding a type to
 * log/events.ts fails the build here rather than rendering a blank row in the UI.
 */
export type LogKind = "engine" | "agent" | "tool" | "operator" | "attention";

export interface LogRow {
  seq: number;
  ts: string;
  node: string | null;
  visit: number | null;
  type: LoggedEvent["type"];
  kind: LogKind;
  summary: string;
  /** tool calls nest under the turn they belong to */
  depth: 0 | 1;
  /** the stored event, verbatim — the Raw tab must be faithful to run.jsonl, not re-rendered */
  raw: LoggedEvent;
}

export function deriveLogRows(events: LoggedEvent[]): LogRow[] {
  return events.map((e): LogRow => {
    const base = { seq: e.seq, ts: e.ts, type: e.type, raw: e };
    const at = (n: string, v: number) => ({ node: n, visit: v });
    switch (e.type) {
      case "run-started":
        return { ...base, ...at("", 0), node: null, visit: null, kind: "engine", depth: 0,
          summary: `graph ${e.graph} · ${e.folder_kind ?? "no folder"}${e.cwd ? ` · ${e.cwd}` : ""}` };
      case "node-started":
        return { ...base, ...at(e.node, e.visit), kind: "engine", depth: 0, summary: `attempt ${e.attempt_id}` };
      case "prompt-rendered":
        return { ...base, ...at(e.node, e.visit), kind: "agent", depth: 0,
          summary: `${e.prompt} v${e.prompt_version} · read ${Object.keys(e.context_read).join(", ") || "nothing"} · ${e.rendered_hash}` };
      case "chunk":
        return { ...base, ...at(e.node, e.visit), kind: e.kind === "tool_call" || e.kind === "tool_result" ? "tool" : "agent", depth: 1,
          summary: `${e.kind}${e.tool_name ? ` · ${e.tool_name}` : ""} · ${e.content.slice(0, 120)}` };
      case "turn-finalized":
        return { ...base, ...at(e.node, e.visit), kind: "agent", depth: 1,
          summary: `turn ${e.turn} · in ${e.usage?.input_tokens ?? "—"} · out ${e.usage?.output_tokens ?? "—"}${e.usage?.cost_usd !== undefined ? ` · $${e.usage.cost_usd.toFixed(4)}` : ""}` };
      case "prompt-outcome":
        return { ...base, ...at(e.node, e.visit), kind: "agent", depth: 1,
          summary: [e.verdict_downstream, e.terminal_outcome, e.error].filter(Boolean).join(" · ") || e.rendered_hash };
      case "node-finished":
        return { ...base, ...at(e.node, e.visit), kind: "engine", depth: 0,
          summary: `${e.status}${Object.keys(e.writes).length ? ` · wrote ${Object.keys(e.writes).join(", ")}` : ""}` };
      case "side-effect-intent":
        return { ...base, ...at(e.node, e.visit), kind: "engine", depth: 1, summary: `intent · ${e.effect}` };
      case "side-effect-done":
        return { ...base, ...at(e.node, e.visit), kind: "engine", depth: 1, summary: `done · ${e.effect}` };
      case "reconciled": {
        const forge = e.forge ? (e.forge.kind === "pr" ? `pr ${e.forge.state}` : e.forge.kind) : "no forge probe";
        return { ...base, node: e.node, visit: null, kind: "engine", depth: 1,
          summary: `${e.git.branch ?? "detached"} · ${e.git.uncommitted} uncommitted · ${forge}${e.disagreements.length ? ` · ⚠ ${e.disagreements.join("; ")}` : ""}` };
      }
      case "edge-taken":
        return { ...base, node: e.from, visit: null, kind: "engine", depth: 0, summary: `→ ${e.to}${e.label ? ` · ${e.label}` : ""}` };
      case "attention-raised":
        return { ...base, ...at(e.node, e.visit), kind: "attention", depth: 0, summary: e.reason };
      case "attention-resolved":
        return { ...base, ...at(e.node, e.visit), kind: "attention", depth: 0, summary: `answered${e.reply ? ` · ${e.reply}` : ""}` };
      case "operator-jump":
        return { ...base, node: e.to, visit: null, kind: "operator", depth: 0, summary: e.message ?? `jumped to ${e.to}` };
      case "run-paused":
        return { ...base, node: null, visit: null, kind: "operator", depth: 0, summary: `paused by ${e.by}` };
      case "run-resumed":
        return { ...base, node: null, visit: null, kind: "operator", depth: 0, summary: `resumed by ${e.by}` };
      case "allowance":
        return { ...base, node: null, visit: null, kind: e.state === "exhausted" ? "attention" : "engine", depth: 0,
          summary: `${e.harness} ${e.state}${e.remaining !== undefined ? ` · ${Math.round(e.remaining * 100)}% left` : ""}${e.resets_at ? ` · resets ${e.resets_at}` : ""}` };
      case "run-finished":
        return { ...base, node: null, visit: null, kind: "engine", depth: 0, summary: e.outcome };
      default: {
        const never: never = e;
        throw new Error(`unhandled event type in deriveLogRows: ${JSON.stringify(never)}`);
      }
    }
  });
}

/**
 * Context (T24, stories 9 + 10) — the run's whole context, which nothing surveyed in the
 * research shows. Orbital's was per-step and usually said "this step wrote nothing".
 *
 * Derived, never stored: `node-finished.writes` carries every PUBLISHED value in log order,
 * so publish-on-success is free — a failed attempt's writes never appear because the engine
 * never logged them. Scopes and declared writers come from the graph, so keys that no step
 * has reached yet are still listed rather than vanishing.
 */
export interface ContextWrite {
  node: string;
  visit: number;
  at: string;
  replaced: boolean;
}

export interface ContextEntry {
  key: string;
  /** the latest published value, or undefined when nothing has written it yet */
  value?: unknown;
  written: boolean;
  scope: Scope | null;
  /** every node the graph declares as a writer of this key */
  declared_writers: string[];
  /** who actually wrote it, in log order */
  writes: ContextWrite[];
  /** prompts that read it, from prompt-rendered.context_read */
  read_by: string[];
  /** a cleared key whose writer is mid-attempt is veiled: the old value must not be shown */
  veiled: boolean;
}

export type Declarations = Record<string, { scope: Scope; writer: string[] }>;

export function deriveContextTable(events: LoggedEvent[], declarations: Declarations = {}): ContextEntry[] {
  const entries = new Map<string, ContextEntry>();
  const entry = (key: string): ContextEntry => {
    let e = entries.get(key);
    if (!e) {
      const d = declarations[key];
      e = { key, written: false, scope: d?.scope ?? null, declared_writers: d?.writer ?? [], writes: [], read_by: [], veiled: false };
      entries.set(key, e);
    }
    return e;
  };
  for (const key of Object.keys(declarations)) entry(key); // declared-but-unwritten still shows

  const openAttempts = new Set<string>();
  for (const e of events) {
    if (e.type === "node-started") openAttempts.add(e.node);
    else if (e.type === "node-finished") {
      openAttempts.delete(e.node);
      for (const [key, value] of Object.entries(e.writes)) {
        const c = entry(key);
        c.writes.push({ node: e.node, visit: e.visit, at: e.ts, replaced: c.written });
        c.value = value;
        c.written = true;
      }
    } else if (e.type === "prompt-rendered") {
      for (const key of Object.keys(e.context_read)) {
        const c = entry(key);
        if (!c.read_by.includes(e.prompt)) c.read_by.push(e.prompt);
      }
    }
  }

  // a `cleared` key is veiled while any of its declared writers is mid-attempt
  for (const c of entries.values()) {
    if (c.scope === "cleared" && c.declared_writers.some((w) => openAttempts.has(w))) c.veiled = true;
  }
  return [...entries.values()];
}

/**
 * The run digest (T24, story 11) — what an agent is told when you ask about a run.
 *
 * BOUNDED on purpose: a 10,000-event run must not be pasted into a prompt. Steps are
 * summarised, the transcript is the tail only, and values are truncated. It is built from
 * the same derivations the screens use, so one fix improves both the view and the answer.
 *
 * Carries run events ONLY — never process env, never credentials.
 */
export interface DigestLimits {
  steps: number;
  transcript: number;
  valueChars: number;
}
const DIGEST_DEFAULTS: DigestLimits = { steps: 60, transcript: 40, valueChars: 300 };

export function runDigest(
  id: string,
  events: LoggedEvent[],
  declarations: Declarations = {},
  limits: Partial<DigestLimits> = {},
): string {
  const lim = { ...DIGEST_DEFAULTS, ...limits };
  const summary = deriveSummary(id, events);
  const timeline = deriveTimeline(events);
  const context = deriveContextTable(events, declarations);
  const { ask } = deriveStatus(events);
  const cut = (v: unknown) => {
    const t = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
    return t.length > lim.valueChars ? `${t.slice(0, lim.valueChars)}… (${t.length} chars)` : t;
  };
  const dur = (ms: number | null) => (ms === null ? "running" : ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`);

  const steps = timeline.slice(-lim.steps).map((t) => {
    const waited = t.waiting_ms > 0 ? ` · waited on a human ${dur(t.waiting_ms)}` : "";
    return `  ${t.node}@${t.visit} · ${t.status} · ${dur(t.duration_ms)}${waited}`;
  });

  const turns = coalesce(events).slice(-lim.transcript).flatMap((turn) =>
    turn.parts
      .filter((p) => p.kind === "text" || p.kind === "tool_call")
      .map((p) => `  ${turn.node}@${turn.visit} · ${p.kind === "tool_call" ? `tool ${p.tool_name ?? ""}` : "said"}: ${cut(p.content)}`),
  ).slice(-lim.transcript);

  const ctx = context.map((c) =>
    `  ${c.key} (${c.scope ?? "undeclared"}) = ${c.written ? cut(c.value) : "— not written yet"}` +
    (c.writes.length ? ` · last written by ${c.writes.at(-1)!.node}@${c.writes.at(-1)!.visit}` : ""));

  const prompts = [...new Map(
    events.flatMap((e) => (e.type === "prompt-rendered" ? [[`${e.prompt}`, `  ${e.prompt} v${e.prompt_version} (${e.node}@${e.visit})`] as const] : [])),
  ).values()];

  return [
    `RUN ${id}`,
    `graph: ${summary.graph}`,
    `status: ${summary.status}${summary.outcome ? ` · ${summary.outcome}` : ""}`,
    summary.goal ? `goal: ${cut(summary.goal)}` : "",
    ask ? `WAITING ON A HUMAN since ${ask.ts}: ${ask.reason} (at ${ask.node}@${ask.visit})` : "not waiting on a human",
    "",
    `STEPS (last ${Math.min(lim.steps, timeline.length)} of ${timeline.length}):`,
    ...steps,
    "",
    "CONTEXT:",
    ...ctx,
    "",
    "PROMPTS RENDERED:",
    ...prompts,
    "",
    `TRANSCRIPT (tail):`,
    ...turns,
  ].filter((l) => l !== "").join("\n");
}

/**
 * Chat citations (T24, story 12). An answer is UNTRUSTED model output: a node@visit becomes
 * a clickable citation only when this run actually has that step, and every part is rendered
 * as text, never as markup.
 */
export interface CitePart {
  text: string;
  cite: boolean;
}

export function citeParts(answer: string, known: Set<string>): CitePart[] {
  const out: CitePart[] = [];
  const re = /([a-z_][\w.]*@\d+)/gi;
  let last = 0;
  for (const m of answer.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: answer.slice(last, at), cite: false });
    out.push({ text: m[1]!, cite: known.has(m[1]!) });
    last = at + m[1]!.length;
  }
  if (last < answer.length) out.push({ text: answer.slice(last), cite: false });
  return out;
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
