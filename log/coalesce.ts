/**
 * View-time coalescing (shaping A5.2 / D10) — the reader's inverse of chunked writes.
 *
 * The log stores agent output as it streamed: many `chunk` events per turn. The viewer
 * wants Orbital-style messages: one block of text with tool calls in order. coalesce()
 * stitches chunks back into turns, preserving tool-call ordering inside the turn, and
 * marks turns the process died inside (`finalized: false` — no turn-finalized event).
 *
 * outcomesByHash() joins prompt-outcome events onto prompt-rendered by rendered_hash —
 * late follow-up writes (a PR merged days later) simply layer more fields onto the same
 * hash; the LAST write per field wins.
 */
import type { ChunkKind, LoggedEvent, RunEvent } from "./events";

export interface TurnPart {
  kind: ChunkKind;
  content: string;
  tool_id?: string;
  tool_name?: string;
}

export interface CoalescedTurn {
  node: string;
  visit: number;
  turn: number;
  /** contiguous same-kind text chunks merged; tool calls kept in stream order */
  parts: TurnPart[];
  finalized: boolean;
  usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number };
}

type ChunkEvent = Extract<RunEvent, { type: "chunk" }>;
type OutcomeEvent = Extract<RunEvent, { type: "prompt-outcome" }>;

export function coalesce(events: LoggedEvent[]): CoalescedTurn[] {
  const turns = new Map<string, CoalescedTurn>();
  const chunks = new Map<string, ChunkEvent[]>();

  const keyOf = (e: { node: string; visit: number; turn: number }) => `${e.node}\u0000${e.visit}\u0000${e.turn}`;

  for (const e of events) {
    if (e.type === "chunk") {
      const key = keyOf(e);
      if (!turns.has(key)) turns.set(key, { node: e.node, visit: e.visit, turn: e.turn, parts: [], finalized: false });
      let list = chunks.get(key);
      if (!list) chunks.set(key, (list = []));
      list.push(e);
    } else if (e.type === "turn-finalized") {
      const key = keyOf(e);
      const t = turns.get(key) ?? { node: e.node, visit: e.visit, turn: e.turn, parts: [], finalized: false };
      t.finalized = true;
      if (e.usage) t.usage = e.usage;
      turns.set(key, t);
    }
  }

  for (const [key, list] of chunks) {
    list.sort((a, b) => a.index - b.index);
    const t = turns.get(key)!;
    for (const c of list) {
      const last = t.parts.at(-1);
      // merge contiguous streaming deltas of the same kind; tool events stay discrete
      if (last && last.kind === c.kind && (c.kind === "text" || c.kind === "thinking")) {
        last.content += c.content;
      } else {
        t.parts.push({ kind: c.kind, content: c.content, tool_id: c.tool_id, tool_name: c.tool_name });
      }
    }
  }

  // stable order: by first appearance in the log (Map preserves insertion order)
  return [...turns.values()];
}

export interface JoinedOutcome {
  rendered_hash: string;
  node: string;
  visit: number;
  verdict_downstream?: string;
  terminal_outcome?: OutcomeEvent["terminal_outcome"];
  error?: string;
}

/** Fold all prompt-outcome writes per rendered_hash; last write per field wins. */
export function outcomesByHash(events: LoggedEvent[]): Map<string, JoinedOutcome> {
  const out = new Map<string, JoinedOutcome>();
  for (const e of events) {
    if (e.type !== "prompt-outcome") continue;
    const prev = out.get(e.rendered_hash) ?? { rendered_hash: e.rendered_hash, node: e.node, visit: e.visit };
    if (e.verdict_downstream !== undefined) prev.verdict_downstream = e.verdict_downstream;
    if (e.terminal_outcome !== undefined) prev.terminal_outcome = e.terminal_outcome;
    if (e.error !== undefined) prev.error = e.error;
    out.set(e.rendered_hash, prev);
  }
  return out;
}
