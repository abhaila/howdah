/**
 * The run page's incremental fold — the same idea as the board (web/board.ts), for one run.
 *
 * GET /api/runs/:id used to read the whole log, derive the whole view and stringify it on
 * every SSE tick. A live implement-ticket log is ~15 MB and ~60k events, almost all of them
 * streaming text; that derive took seconds and the response was ~16 MB, and the page
 * refetched it on every chunk. The one thread the server has did nothing else meanwhile.
 *
 * This fold reads only the bytes appended since last time. Streaming text and thinking are
 * merged into the turn they belong to and into one log row, then dropped — they are not
 * kept as events. Everything else is kept, because the shell (status, timeline, plan,
 * context) is derived from it, and it is the small fraction of the file. A log that shrank
 * is refolded from zero.
 *
 * The shell, the transcript window and the log page are three views of this one fold, so a
 * chunk appends to the open turn in memory and does not rebuild the shell.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { absorbTurnEvent, applyLiveEvent, type CoalescedTurn } from "../log/coalesce";
import type { LoggedEvent } from "../log/events";
import { deriveLogRows, type LogRow } from "./derive";

/** Chat reads only these rows out of the log (web/app/run/chat.tsx conversation). */
const NOTICE = new Set<LoggedEvent["type"]>(["attention-raised", "attention-resolved", "base-restacked"]);

const streams = (e: LoggedEvent): e is Extract<LoggedEvent, { type: "chunk" }> =>
  e.type === "chunk" && (e.kind === "text" || e.kind === "thinking");

interface Fold {
  size: number;
  /** bytes consumed — always at a line boundary */
  offset: number;
  /** an unterminated final line, held until its newline arrives */
  pending: string;
  /** every event that is not a streaming text/thinking delta */
  shellEvents: LoggedEvent[];
  turns: CoalescedTurn[];
  logRows: LogRow[];
  /** reassembled text of the log row currently being folded, so its summary stays whole */
  streamText: string;
  lastSeq: number;
  lastAt: string | null;
  lastAgentAt: string | null;
}

export interface RunViewSnapshot {
  shellEvents: LoggedEvent[];
  turns: CoalescedTurn[];
  logRows: LogRow[];
  /** attention and restack rows, raw included — a handful, and the chat quotes them */
  notices: LogRow[];
  lastSeq: number;
  /** timestamp of the latest event, streaming chunks included */
  lastAt: string | null;
  lastAgentAt: string | null;
  /** how many shell events are folded; a text-only append leaves this unchanged */
  shellCount: number;
}

const fresh = (): Fold => ({
  size: 0, offset: 0, pending: "", shellEvents: [], turns: [], logRows: [], streamText: "", lastSeq: 0, lastAt: null, lastAgentAt: null,
});

function noteLog(f: Fold, e: LoggedEvent): void {
  const last = f.logRows.at(-1);
  const prev = last?.raw.type === "chunk" ? last.raw : null;
  if (
    streams(e) && last && prev && streams(prev) &&
    prev.kind === e.kind && prev.node === e.node && prev.visit === e.visit && prev.turn === e.turn
  ) {
    last.merged += 1;
    f.streamText += e.content;
    const body = f.streamText.trim();
    const count = last.merged > 1 ? ` ×${last.merged}` : "";
    last.summary = `${e.kind}${count}${e.tool_name ? ` · ${e.tool_name}` : ""}${body ? ` · ${body.slice(0, 200)}` : ""}`;
    return;
  }
  f.streamText = streams(e) ? e.content : "";
  const row = deriveLogRows([e])[0];
  if (row) f.logRows.push(row);
}

function absorb(f: Fold, e: LoggedEvent): void {
  f.lastSeq = e.seq;
  f.lastAt = e.ts;
  if (e.type === "chunk" || e.type === "turn-finalized") f.lastAgentAt = e.ts;
  absorbTurnEvent(f.turns, e);
  noteLog(f, e);
  if (!streams(e)) f.shellEvents.push(e);
}

/** read [from, to) of a file as utf8 */
function readRange(path: string, from: number, to: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(to - from);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, from + got);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function snapshot(f: Fold, provisional: LoggedEvent | null): RunViewSnapshot {
  let turns = f.turns;
  let lastSeq = f.lastSeq;
  let lastAt = f.lastAt;
  let lastAgentAt = f.lastAgentAt;
  // a whole final line that has not been newline-terminated yet is a real event (readLog
  // parses it). It is not stored, so the next read that sees its newline absorbs it once.
  if (provisional) {
    turns = applyLiveEvent(f.turns, provisional);
    lastSeq = provisional.seq;
    lastAt = provisional.ts;
    if (provisional.type === "chunk" || provisional.type === "turn-finalized") lastAgentAt = provisional.ts;
  }
  return {
    shellEvents: f.shellEvents,
    turns,
    logRows: f.logRows,
    notices: f.logRows.filter((r) => NOTICE.has(r.type)),
    lastSeq,
    lastAt,
    lastAgentAt,
    shellCount: f.shellEvents.length,
  };
}

export interface TranscriptPage {
  turns: CoalescedTurn[];
  total: number;
  start: number;
  /** seq of the latest event folded into this page, so the client can tail the log after it */
  last_seq: number;
}

export interface LogPage {
  rows: Array<Omit<LogRow, "raw">>;
  total: number;
  oldest: number | null;
}

export class RunViewCache {
  private readonly folds = new Map<string, Fold>();

  /**
   * Bring one run's fold up to date. Reads only the bytes appended since the last call.
   */
  fold(path: string): RunViewSnapshot {
    let f = this.folds.get(path) ?? fresh();
    if (!existsSync(path)) {
      this.folds.delete(path);
      return snapshot(fresh(), null);
    }
    const fd = openSync(path, "r");
    let size: number;
    try { size = fstatSync(fd).size; } finally { closeSync(fd); }
    if (size < f.offset + Buffer.byteLength(f.pending)) f = fresh();
    if (size > f.offset + Buffer.byteLength(f.pending)) {
      const start = f.offset + Buffer.byteLength(f.pending);
      const text = f.pending + readRange(path, start, size);
      const lines = text.split("\n");
      const tail = lines.pop() ?? "";
      for (const line of lines) {
        f.offset += Buffer.byteLength(line) + 1;
        if (!line) continue;
        try { absorb(f, JSON.parse(line) as LoggedEvent); } catch { /* a corrupt middle line: skipped, so one bad line does not blank the run */ }
      }
      f.pending = tail;
    }
    f.size = size;
    this.folds.set(path, f);
    let provisional: LoggedEvent | null = null;
    if (f.pending) {
      try { provisional = JSON.parse(f.pending) as LoggedEvent; } catch { provisional = null; }
    }
    return snapshot(f, provisional);
  }

  /**
   * A window of the transcript. `before` is an index in the turn list (the start of the
   * window the caller already has); absent, the window is the tail. `node` + `visit` returns
   * that step's turns, for a step the window does not cover.
   */
  transcript(path: string, opts: { limit: number; before?: number; node?: string; visit?: number }): TranscriptPage {
    const { turns, lastSeq } = this.fold(path);
    if (opts.node !== undefined && opts.visit !== undefined) {
      return { turns: turns.filter((t) => t.node === opts.node && t.visit === opts.visit), total: turns.length, start: 0, last_seq: lastSeq };
    }
    const end = opts.before === undefined ? turns.length : Math.max(0, Math.min(turns.length, opts.before));
    const start = Math.max(0, end - opts.limit);
    return { turns: turns.slice(start, end), total: turns.length, start, last_seq: lastSeq };
  }

  /** A page of log rows, newest last, without the stored event. `before` is a seq. */
  logs(path: string, opts: { limit: number; before?: number }): LogPage {
    const { logRows } = this.fold(path);
    const eligible = opts.before === undefined ? logRows : logRows.filter((r) => r.seq < opts.before!);
    const page = eligible.slice(-opts.limit);
    return {
      rows: page.map(({ raw: _raw, ...rest }) => rest),
      total: logRows.length,
      oldest: page[0]?.seq ?? null,
    };
  }

  /** The stored event a log row's Raw pane asks for. Merged rows answer with their first event. */
  event(path: string, seq: number): LoggedEvent | null {
    const { logRows, shellEvents } = this.fold(path);
    return logRows.find((r) => r.seq === seq)?.raw ?? shellEvents.find((e) => e.seq === seq) ?? null;
  }
}
