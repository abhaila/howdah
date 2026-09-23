/**
 * Pure derivations from a run's event log — everything the web app renders (R3).
 * The log is the only storage; these functions are the read model.
 *
 * Status rules (design review): ONE canonical enum, one renderer, and
 * needs-input OUTRANKS failed — a parked run needing a human is never shown as merely
 * "failed", because the human is the unblock.
 *
 * system-map 1a (D17): an `awaiting-approval` ask closes as soon as a decision for its
 * current proposal round exists (engine/slice-decision.ts decisionAnswers) — the same rule
 * replay uses, so the viewer never shows needs-input for a run `howdah up` will resume.
 *
 * HOW-3: `ambiguous_effects` is the read model behind the effect card — the pending
 * side-effect intents of a run parked on `ambiguous-effect`, straight from engine/replay.ts
 * so the viewer and the engine agree on what is still ambiguous.
 *
 * system-map 1d: `deriveSlice` is the read model behind the approval card, the drift view and
 * the map-progress line — proposal rounds, decisions, pinned comments (orphans included),
 * redesign requests, extraction progress and drift reports, all folded from the log.
 */
import type { LoggedEvent, RunOutcome } from "../log/events";
import { currentProposal, decisionAnswers, decisionKind, findDecision } from "../engine/slice-decision";
import { replayState } from "../engine/replay";
import type { Scope } from "../core/context";
import { coalesce, outcomesByHash, type CoalescedTurn, type JoinedOutcome } from "../log/coalesce";
import { ghostEdgeId, orphanedComments, OPS, type GhostSet, type GhostTrace, type Op } from "../map/ghosts";
import { DRIFT_OUTCOMES, type DriftItem, type DriftOutcome } from "../map/drift";
import { PROBLEM_OUTCOMES, snapshotStamp } from "../engine/slice-map";
import type { AssembledMap, EntityKind, Tier } from "../map/types";

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
  /** HOW-18: the operator's label from run-started; null for an unnamed (or older) run */
  name: string | null;
  /**
   * HOW-23: the run that launched this one (a `plan-feature` fan-out), or null for a run an
   * operator started. Lineage only — a child is an ordinary independent run.
   */
  parent: string | null;
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
  persistence?: { home: string; run_dir: string; log_path: string; worktree_path: string | null; runner_alive: boolean };
  /** system-map 1d: proposal rounds, comments, map progress and drift — null for runs with none */
  slice: SliceView | null;
  /**
   * HOW-3: the still-ambiguous side-effect intents, filled ONLY while the run is parked on
   * `ambiguous-effect` (empty otherwise, so the common path pays for no extra fold). Each one
   * is a row the operator can attest to in the viewer.
   */
  ambiguous_effects: Array<{ node: string; visit: number; effect: string; attempt_id: string }>;
  /**
   * HOW-23: the runs this one launched, in launch order, folded from `run-spawned`. Empty for
   * every run that is not a `plan-feature` parent. What each child DID is its own log's to
   * say — this is only the link, so the viewer never invents a status for a run it is not
   * reading.
   */
  children: Array<{ run_id: string; slice_id: string; ticket: string | null; graph: string; workspace: string | null; at: string }>;
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
    } else if (e.type === "attention-resolved" || e.type === "operator-jump") ask = null; // a jump supersedes the park (replay.ts does the same)
    else if (e.type === "run-paused") paused = true;
    else if (e.type === "run-resumed") paused = false;
    else if (e.type === "node-finished") {
      if (e.status === "failed") {
        lastFailed = { node: e.node, visit: e.visit, at: e.ts };
        failure = { node: e.node, visit: e.visit, reason: null, at: e.ts }; // reason may follow
      } else lastFailed = null;
    } else if (e.type === "node-started") {
      lastFailed = null;
      if (ask) ask = null;
    }
  }
  if (ask && decisionAnswers(events, ask)) ask = null; // D17: the decision alone answers it
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
    name: started?.type === "run-started" ? started.name ?? null : null,
    parent: started?.type === "run-started" ? started.parent ?? null : null,
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
      for (const previous of open.values()) {
        previous.finished_at = e.ts;
        previous.status = "failed";
        previous.duration_ms = new Date(e.ts).getTime() - new Date(previous.started_at).getTime();
      }
      open.clear();
      const key = `${e.node}@${e.visit}`;
      const row: TimelineRow = { node: e.node, visit: e.visit, started_at: e.ts, finished_at: null, status: "running", duration_ms: null, offset_ms: 0, run_span_ms: 0, waiting_ms: 0 };
      rows.push(row);
      open.set(key, row);
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
      else if (e.type === "attention-resolved" || e.type === "operator-jump" || e.type === "run-finished") open = false;
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
    } else if (e.type === "operator-jump") {
      // the jump closes every open ask, exactly as replay clears `parked` (system-map 0.3).
      // Without this a maxVisits park — raised at visit N+1, which never ran — stays open,
      // and the real post-jump attempt N+1 gets charged as time waiting on a human.
      const at = new Date(e.ts).getTime();
      for (const [key, from] of asks) charge(key, from, at);
      asks.clear();
    }
  }
  for (const [key, from] of asks) charge(key, from, end); // still waiting: measure to now
  for (const r of rows) r.waiting_ms = waiting.get(`${r.node}@${r.visit}`) ?? 0;

  return rows;
}

export function deriveDetail(
  id: string,
  events: LoggedEvent[],
  declarations: Declarations = {},
  opts: { snapshot?: SnapshotIndex | null } = {},
): RunDetail {
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
    slice: deriveSlice(events, opts.snapshot ?? null),
    children: events.flatMap((e) =>
      e.type === "run-spawned"
        ? [{ run_id: e.child, slice_id: e.slice_id, ticket: e.ticket ?? null, graph: e.graph, workspace: e.workspace ?? null, at: e.ts }]
        : [],
    ),
    ambiguous_effects:
      ask?.code === "ambiguous-effect"
        ? replayState(events).pendingIntents.map((i) => ({ node: i.node, visit: i.visit, effect: i.effect, attempt_id: i.attempt_id }))
        : [],
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
  /**
   * How many stored chunk events this row folds. 1 for everything else.
   *
   * A streaming delta is not a unit anyone reads: one real run stored 12,609 `text` chunks
   * averaging 13 characters, so a single sentence arrived as six rows, and 2,252 `thinking`
   * chunks carried no text at all. Contiguous deltas of the same kind, in the same turn, fold
   * into one row whose summary is the reassembled prose. `raw` still points at a REAL stored
   * event — the first of the run — because the Raw pane's whole job is fidelity; the count is
   * what says the row stands for more than itself.
   */
  merged: number;
}

type Chunky = Extract<LoggedEvent, { type: "chunk" }>;
const isChunk = (e: LoggedEvent): e is Chunky => e.type === "chunk";
/** a streaming delta — the kinds that arrive in pieces and mean nothing one piece at a time */
const streams = (e: Chunky) => e.kind === "text" || e.kind === "thinking";

/**
 * Fold contiguous streaming deltas of one kind, in one turn, into a single entry carrying the
 * reassembled text. Anything else passes through untouched, and a tool call between two runs
 * of text ends the first run — the order the log recorded is the order the rows keep.
 */
function foldStreamedChunks(events: LoggedEvent[]): Array<{ e: LoggedEvent; merged: number; text?: string }> {
  const out: Array<{ e: LoggedEvent; merged: number; text?: string }> = [];
  for (const e of events) {
    const last = out.at(-1);
    if (
      isChunk(e) && streams(e) && last && isChunk(last.e) && streams(last.e) &&
      last.e.kind === e.kind && last.e.node === e.node && last.e.visit === e.visit && last.e.turn === e.turn
    ) {
      last.merged += 1;
      last.text = (last.text ?? "") + e.content;
      continue;
    }
    out.push({ e, merged: 1, text: isChunk(e) && streams(e) ? e.content : undefined });
  }
  return out;
}

export function deriveLogRows(events: LoggedEvent[]): LogRow[] {
  return foldStreamedChunks(events).map(({ e, merged, text }): LogRow => {
    const base = { seq: e.seq, ts: e.ts, type: e.type, raw: e, merged };
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
      case "chunk": {
        const body = (text ?? e.content).trim();
        const count = merged > 1 ? ` ×${merged}` : "";
        return { ...base, ...at(e.node, e.visit), kind: e.kind === "tool_call" || e.kind === "tool_result" ? "tool" : "agent", depth: 1,
          // an empty fold still gets a row: "it thought for 2,252 deltas and said nothing" is
          // a fact about the run, and deleting it would make the log lie by omission
          summary: `${e.kind}${count}${e.tool_name ? ` · ${e.tool_name}` : ""}${body ? ` · ${body.slice(0, 200)}` : ""}` };
      }
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
      case "side-effect-resolved":
        return { ...base, ...at(e.node, e.visit), kind: "operator", depth: 1, summary: `resolved · ${e.effect} · ${e.verdict}` };
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
      case "ghost-proposed":
        return { ...base, node: e.node, visit: null, kind: "agent", depth: 0,
          summary: `proposal #${e.proposal_id} for ${e.approval} · ${e.proposal_hash}` };
      case "comment-pinned":
        return { ...base, node: null, visit: null, kind: "operator", depth: 0,
          summary: `comment on ${e.entity_id} (proposal #${e.proposal_id}) · ${e.text.slice(0, 120)}` };
      case "slice-feedback-sent":
        return { ...base, node: null, visit: null, kind: "operator", depth: 0,
          summary: `feedback sent on proposal #${e.proposal_id} · ${e.comment_ids.length} comment${e.comment_ids.length === 1 ? "" : "s"}` };
      case "slice-approved":
        return { ...base, node: null, visit: null, kind: "operator", depth: 0, summary: `approved proposal #${e.proposal_id}` };
      case "slice-redesign-requested":
        return { ...base, node: null, visit: null, kind: "operator", depth: 0, summary: `redesign · ${e.message.slice(0, 120)}` };
      case "map-extracted":
        return { ...base, ...at(e.node, e.visit), kind: "engine", depth: 0,
          summary: `map ${e.manifest_hash.slice(0, 12)} @ ${e.commit?.slice(0, 12) ?? "(no commit)"}${e.dirty ? " + uncommitted changes" : ""} · ${e.files} files · ${e.skipped} skipped · ${e.not_checked} not-checked · ${e.unparsed} unparsed` };
      case "run-spawned":
        return { ...base, ...at(e.node, e.visit), kind: "engine", depth: 0,
          summary: `launched ${e.graph} run ${e.child} for slice ${e.slice_id}${e.ticket ? ` (${e.ticket})` : ""}${e.workspace ? ` in ${e.workspace}` : ""}` };
      case "map-progress":
        return { ...base, ...at(e.node, e.visit), kind: "engine", depth: 1, summary: `extracting ${e.done}/${e.total} (skipped ${e.skipped})` };
      case "drift-detected": {
        const counts = Object.entries(e.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(" · ");
        return { ...base, ...at(e.node, e.visit), kind: "engine", depth: 0,
          summary: `drift @ ${e.stamp ?? e.commit?.slice(0, 12) ?? "(no commit)"} · ${counts || "nothing to check"}${e.truncated ? ` · ${e.truncated} more not listed` : ""}${e.extractor_mismatch ? ` · extractor mismatch ${e.extractor_mismatch.base} vs ${e.extractor_mismatch.after}` : ""}` };
      }
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
 * The slice read model (system-map 1d) — what the approval card, the drift view and the
 * map-progress line render. Pure: a fold over the log, plus an optional index of the base
 * snapshot for tier glyphs (the server loads it; the log carries only the manifest hash).
 *
 * The decision rules are NOT re-implemented here: the current round and its first decision
 * come from engine/slice-decision.ts (the only place that answers them), and orphaned comments
 * from map/ghosts.ts orphanedComments — the same rule 1c uses.
 */

/** Tier + block membership of every key in the base snapshot — enough to label ghost rows. */
export interface SnapshotIndex {
  tier: Map<string, Tier>;
  /** entity key → its block key (edges from existing entities group under that block) */
  blockOf: Map<string, string>;
}

export function snapshotIndex(map: Pick<AssembledMap, "blocks" | "entities" | "edges">): SnapshotIndex {
  const tier = new Map<string, Tier>();
  const blockOf = new Map<string, string>();
  for (const b of map.blocks) tier.set(b.key, b.tier);
  for (const e of map.entities) {
    if (!tier.has(e.key)) tier.set(e.key, e.tier); // an ambiguous key keeps its first tier
    blockOf.set(e.key, e.block);
  }
  for (const e of map.edges) if (!tier.has(e.key)) tier.set(e.key, e.tier);
  return { tier, blockOf };
}

export interface GhostRow {
  /** the identity key a comment pins to — edges use `from→to:kind` (ghostEdgeId) */
  id: string;
  subject: "block" | EntityKind | "edge";
  op: Op;
  /** the base snapshot's tier for this key; null when unknown (an `add`, or no snapshot) */
  tier: Tier | null;
  edge?: { from: string; to: string; kind: string };
  expected_file?: string;
  /** responsibility / names — prose the proposer wrote: shown, never verified */
  prose?: string;
}

export interface GhostGroup {
  /** block key; "" collects edges whose source block is unknown */
  block: string;
  /** the block's own ghost row, when the proposal declares one */
  row: GhostRow | null;
  entities: GhostRow[];
  edges: GhostRow[];
}

export interface SliceComment {
  id: string;
  entity_id: string;
  text: string;
  proposal_id: number;
  /** 1-based round number of the proposal it was pinned on */
  round: number;
  at: string;
  /** it went to the proposer with a feedback decision */
  sent: boolean;
}

/** The current round's state, in the precedence the card explains it. */
export type SliceDecision =
  | { kind: "awaiting" } // parked on this round, nothing decided — the needs-you moment
  /**
   * The approval node parked for ANOTHER reason (attempt-failed, max-visits, …): a human is
   * needed, but the answer is a reply in the Ask pane, not a decision. `decided` keeps the
   * round's decision (if any) so the card can still say it and keep Approve closed.
   */
  | { kind: "parked-other"; code: string | null; reason: string; decided: { kind: "approved" | "feedback"; at: string } | null }
  | { kind: "undecided" } // open, but the run is not (yet) parked on it
  | { kind: "approved"; at: string }
  | { kind: "feedback"; at: string; comments: number }
  | { kind: "stale"; at: string; reason: string | null }
  | { kind: "redesigning"; at: string; message: string }
  | { kind: "closed"; outcome: RunOutcome };

export interface SliceRound {
  proposal_id: number;
  round: number;
  at: string;
  outcome: "approved" | "feedback" | "stale" | null;
  decided_at: string | null;
}

export interface SliceProposal {
  proposal_id: number;
  proposal_hash: string;
  manifest_hash: string | null;
  round: number;
  at: string;
  /** the proposer node */
  node: string;
  /** null when the proposal is not a ghost set (another graph's opaque proposal) */
  ghosts: GhostSet | null;
  raw: unknown;
  groups: GhostGroup[];
  traces: GhostTrace[];
  /** how many rows carry each known tier, and how many carry none */
  tier_counts: Partial<Record<Tier, number>>;
  untiered: number;
  /** false when the base snapshot could not be read, so no existing key has a tier */
  tiers_known: boolean;
}

export interface SliceMapProgress {
  node: string;
  visit: number;
  done: number;
  total: number;
  skipped: number;
}

export type SliceMapSnapshot = Pick<
  Extract<LoggedEvent, { type: "map-extracted" }>,
  "node" | "visit" | "manifest_hash" | "commit" | "dirty" | "tiers_run" | "files" | "skipped" | "unparsed" | "not_checked"
> & { at: string; stamp: string };

export interface SliceDrift {
  node: string;
  visit: number;
  at: string;
  /** the after snapshot's commit — what every `verified` refers to (D21) */
  commit: string | null;
  /** the engine's name for that snapshot: "<sha>" or "<sha> + uncommitted changes" */
  stamp: string;
  /** the after snapshot had uncommitted changes, so nothing in it is reported verified */
  dirty: boolean;
  base_commit: string | null;
  counts: Record<DriftOutcome, number>;
  /**
   * Worst outcome first (map/drift DRIFT_OUTCOMES); only outcomes that occurred. `problem`
   * marks engine/slice-map PROBLEM_OUTCOMES — the one list of outcomes where the code
   * disagrees with the approved design (routing, prompts and metrics read it too).
   */
  groups: Array<{ outcome: DriftOutcome; count: number; items: DriftItem[]; problem: boolean }>;
  truncated: number;
  base_reextracted: boolean;
  /** base and after come from different extractors: every ghost item is not-checked */
  extractor_mismatch: { base: string; after: string } | null;
  /** the newest HEAD the reconciler observed after this check, if any */
  head_now: string | null;
  /** HEAD moved after the check: its `verified` does not cover the latest code */
  outdated: boolean;
}

export interface SliceView {
  /** the approval node of the current round */
  approval: string | null;
  proposal: SliceProposal | null;
  decision: SliceDecision | null;
  /** every round of this approval node, oldest first */
  rounds: SliceRound[];
  /** comments on keys the current proposal contains, by key (earlier rounds' included) */
  comments: Record<string, SliceComment[]>;
  /** comments whose key the current proposal no longer contains — shown, never dropped */
  orphaned: SliceComment[];
  redesigns: Array<{ message: string; at: string; after_current: boolean }>;
  /** the extraction still in progress, if any */
  mapping: SliceMapProgress | null;
  maps: SliceMapSnapshot[];
  drifts: SliceDrift[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isOp = (v: unknown): v is Op => typeof v === "string" && (OPS as readonly string[]).includes(v);

/**
 * A tolerant read of a proposal as a ghost set. The slice graph's validator already accepted
 * it; another graph's approval node may propose anything, so a non-ghost-set is null (the
 * card then shows it raw) and malformed entries are dropped rather than crashing the view.
 */
export function asGhostSet(v: unknown): GhostSet | null {
  if (!isRecord(v) || !Array.isArray(v.blocks) || !Array.isArray(v.entities) || !Array.isArray(v.edges)) return null;
  const str = (x: unknown): x is string => typeof x === "string";
  return {
    blocks: v.blocks.filter((b): b is GhostSet["blocks"][number] => isRecord(b) && str(b.id) && isOp(b.op)),
    entities: v.entities.filter((e): e is GhostSet["entities"][number] => isRecord(e) && str(e.id) && isOp(e.op) && str(e.block) && str(e.kind)),
    edges: v.edges.filter((e): e is GhostSet["edges"][number] => isRecord(e) && str(e.from) && str(e.to) && str(e.kind) && isOp(e.op)),
    trace: Array.isArray(v.trace)
      ? v.trace.filter((t): t is GhostTrace => isRecord(t) && str(t.scenario) && Array.isArray(t.steps) && t.steps.every(str))
      : [],
  };
}

/** Group a ghost set block → entities → edges, in declaration order. */
export function groupGhosts(g: GhostSet, snapshot: SnapshotIndex | null): GhostGroup[] {
  const groups = new Map<string, GhostGroup>();
  const group = (block: string): GhostGroup => {
    let x = groups.get(block);
    if (!x) groups.set(block, (x = { block, row: null, entities: [], edges: [] }));
    return x;
  };
  const tier = (id: string, op: Op): Tier | null => (op === "add" ? null : snapshot?.tier.get(id) ?? null);
  const blockIds = new Set(g.blocks.map((b) => b.id));
  const entityBlock = new Map(g.entities.map((e) => [e.id, e.block]));

  for (const b of g.blocks)
    group(b.id).row = { id: b.id, subject: "block", op: b.op, tier: tier(b.id, b.op), ...(b.responsibility ? { prose: b.responsibility } : {}) };
  for (const e of g.entities)
    group(e.block).entities.push({
      id: e.id,
      subject: e.kind,
      op: e.op,
      tier: tier(e.id, e.op),
      expected_file: e.expected_file,
      ...(e.names?.length ? { prose: e.names.join(", ") } : {}),
    });
  for (const e of g.edges) {
    const id = ghostEdgeId(e);
    const from = blockIds.has(e.from) ? e.from : entityBlock.get(e.from) ?? snapshot?.blockOf.get(e.from) ?? "";
    group(from).edges.push({ id, subject: "edge", op: e.op, tier: tier(id, e.op), edge: { from: e.from, to: e.to, kind: e.kind } });
  }
  // the unknown-source group reads last
  return [...groups.values()].sort((a, b) => Number(a.block === "") - Number(b.block === ""));
}

/** Did the approval node write `outcome: "stale"` for this round? (No event: the key says it.) */
function staleWrite(e: LoggedEvent, approval: string, proposalId: number): { reason: string | null } | null {
  if (e.type !== "node-finished" || e.node !== approval || e.status !== "succeeded") return null;
  for (const v of Object.values(e.writes))
    if (isRecord(v) && v.outcome === "stale" && v.proposal_id === proposalId) return { reason: typeof v.reason === "string" ? v.reason : null };
  return null;
}

export function deriveSlice(events: LoggedEvent[], snapshot: SnapshotIndex | null = null): SliceView | null {
  const touched = events.some((e) =>
    e.type === "ghost-proposed" || e.type === "map-progress" || e.type === "map-extracted" || e.type === "drift-detected");
  if (!touched) return null;

  const finished = events.find((e): e is Extract<LoggedEvent, { type: "run-finished" }> => e.type === "run-finished") ?? null;
  const current = currentProposal(events);
  const approval = current?.approval ?? null;
  const roundEvents = current
    ? events.filter((e): e is Extract<LoggedEvent, { type: "ghost-proposed" }> => e.type === "ghost-proposed" && e.approval === approval)
    : [];
  const roundOf = new Map(roundEvents.map((r, i) => [r.proposal_id, i + 1]));

  const rounds: SliceRound[] = roundEvents.map((r, i) => {
    const d = findDecision(events, r.proposal_id);
    const stale = d ? null : events.find((e) => e.seq > r.seq && staleWrite(e, r.approval, r.proposal_id));
    return {
      proposal_id: r.proposal_id,
      round: i + 1,
      at: r.ts,
      outcome: d ? decisionKind(d) : stale ? "stale" : null,
      decided_at: d?.ts ?? stale?.ts ?? null,
    };
  });

  let proposal: SliceProposal | null = null;
  let decision: SliceDecision | null = null;
  const comments: Record<string, SliceComment[]> = {};
  let orphaned: SliceComment[] = [];
  const redesigns: SliceView["redesigns"] = [];

  if (current) {
    const ghosts = asGhostSet(current.proposal);
    const groups = ghosts ? groupGhosts(ghosts, snapshot) : [];
    const rows = groups.flatMap((g) => [...(g.row ? [g.row] : []), ...g.entities, ...g.edges]);
    const tier_counts: Partial<Record<Tier, number>> = {};
    for (const r of rows) if (r.tier) tier_counts[r.tier] = (tier_counts[r.tier] ?? 0) + 1;
    proposal = {
      proposal_id: current.proposal_id,
      proposal_hash: current.proposal_hash,
      manifest_hash: current.manifest_hash,
      round: roundOf.get(current.proposal_id) ?? 1,
      at: current.ts,
      node: current.node,
      ghosts,
      raw: current.proposal,
      groups,
      traces: ghosts?.trace ?? [],
      tier_counts,
      untiered: rows.filter((r) => r.tier === null).length,
      tiers_known: snapshot !== null,
    };

    // comments on every round of this approval node — a redraw keeps them on keys it kept
    const sentIds = new Set(events.flatMap((e) => (e.type === "slice-feedback-sent" ? e.comment_ids : [])));
    const all: SliceComment[] = events.flatMap((e) =>
      e.type === "comment-pinned" && roundOf.has(e.proposal_id)
        ? [{ id: e.id, entity_id: e.entity_id, text: e.text, proposal_id: e.proposal_id, round: roundOf.get(e.proposal_id)!, at: e.ts, sent: sentIds.has(e.id) }]
        : [],
    );
    orphaned = ghosts ? orphanedComments(all, ghosts) : [];
    const orphanIds = new Set(orphaned.map((c) => c.id));
    for (const c of all) if (!orphanIds.has(c.id)) (comments[c.entity_id] ??= []).push(c);

    for (const e of events)
      if (e.type === "slice-redesign-requested" && e.approval === approval)
        redesigns.push({ message: e.message, at: e.ts, after_current: e.seq > current.seq });

    const d = findDecision(events, current.proposal_id);
    const stale = d ? null : events.find((e) => e.seq > current.seq && staleWrite(e, current.approval, current.proposal_id));
    const pendingRedesign = redesigns.filter((r) => r.after_current).at(-1);
    const { ask } = deriveStatus(events);
    if (ask && ask.node === current.approval && ask.code !== "awaiting-approval" && !finished) {
      // the needs-you fact of the moment outranks the round's own state (needs-input > everything)
      decision = {
        kind: "parked-other",
        code: ask.code ?? null,
        reason: ask.reason,
        decided: d ? { kind: decisionKind(d), at: d.ts } : null,
      };
    } else if (d) {
      decision = d.type === "slice-approved"
        ? { kind: "approved", at: d.ts }
        : { kind: "feedback", at: d.ts, comments: d.comment_ids.length };
    } else if (stale) {
      decision = { kind: "stale", at: stale.ts, reason: staleWrite(stale, current.approval, current.proposal_id)?.reason ?? null };
    } else if (pendingRedesign) {
      decision = { kind: "redesigning", at: pendingRedesign.at, message: pendingRedesign.message };
    } else if (finished) {
      decision = { kind: "closed", outcome: finished.outcome };
    } else if (ask?.code === "awaiting-approval" && ask.node === current.approval) {
      decision = { kind: "awaiting" };
    } else {
      decision = { kind: "undecided" };
    }
  }

  // map progress: the latest map-progress of a node@visit that has not finished extracting
  const open = new Map<string, SliceMapProgress>();
  const maps: SliceMapSnapshot[] = [];
  const drifts: SliceDrift[] = [];
  for (const e of events) {
    if (e.type === "map-progress") {
      const key = `${e.node}@${e.visit}`;
      open.delete(key); // re-insert so Map order tracks the most recent progress
      open.set(key, { node: e.node, visit: e.visit, done: e.done, total: e.total, skipped: e.skipped });
    } else if (e.type === "map-extracted" || e.type === "node-finished") {
      open.delete(`${e.node}@${e.visit}`);
      if (e.type === "map-extracted")
        maps.push({
          node: e.node, visit: e.visit, at: e.ts, manifest_hash: e.manifest_hash, commit: e.commit, tiers_run: e.tiers_run,
          files: e.files, skipped: e.skipped, unparsed: e.unparsed, not_checked: e.not_checked,
          // required on the event; passed through as-is so a malformed log never reads as a clean commit
          dirty: e.dirty, stamp: snapshotStamp(e.commit, e.dirty),
        });
    } else if (e.type === "drift-detected") {
      const head_now = events.findLast((x): x is Extract<LoggedEvent, { type: "reconciled" }> => x.type === "reconciled" && x.seq > e.seq)?.git.head ?? null;
      drifts.push({
        node: e.node,
        visit: e.visit,
        at: e.ts,
        commit: e.commit,
        // events written before `stamp`/`dirty` existed are named the way the engine names them now
        stamp: e.stamp ?? snapshotStamp(e.commit, e.dirty === true),
        dirty: e.dirty === true,
        base_commit: e.base_commit,
        counts: e.counts,
        groups: DRIFT_OUTCOMES.map((outcome) => {
          const items = e.items.filter((i) => i.outcome === outcome);
          return { outcome, count: Math.max(e.counts[outcome] ?? 0, items.length), items, problem: PROBLEM_OUTCOMES.includes(outcome) };
        }).filter((g) => g.count > 0),
        truncated: e.truncated,
        base_reextracted: e.base_reextracted === true,
        extractor_mismatch: e.extractor_mismatch ?? null,
        head_now,
        outdated: head_now !== null && e.commit !== null && head_now !== e.commit,
      });
    }
  }

  return {
    approval,
    proposal,
    decision,
    rounds,
    comments,
    orphaned,
    redesigns,
    mapping: finished ? null : [...open.values()].at(-1) ?? null,
    maps,
    drifts,
  };
}

/** Chat citations (T24, story 12) live in ./cite so the browser bundle can import them without
 *  pulling this module's server-side imports (engine/, map/) into app.js. */
export { citeParts, type CitePart } from "./cite";

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
