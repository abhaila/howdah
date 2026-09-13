/**
 * Durable append-only run log (shaping A5.2 / D10).
 *
 * One JSONL file per run. Every append hits disk synchronously before returning — the
 * durability contract is "if append() returned, a crash cannot lose it". No buffering,
 * no batch flush: chunk events during streaming are exactly the writes a crash must
 * preserve, so they are exactly the writes that cannot sit in memory.
 *
 * Reading tolerates a torn final line (the one legal corruption for an append-only file
 * killed mid-write): the last line is dropped iff it fails to parse.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LoggedEvent, RunEvent } from "./events";

export class EventLog {
  private seq: number;

  constructor(
    readonly path: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    mkdirSync(dirname(path), { recursive: true });
    // resume-safe: continue the sequence from whatever the file already holds
    this.seq = existsSync(path) ? (readLog(path).at(-1)?.seq ?? 0) : 0;
  }

  /** Append one event durably. Returns the stamped event as written. */
  append(event: RunEvent): LoggedEvent {
    const stamped: LoggedEvent = { ...event, seq: ++this.seq, ts: this.clock().toISOString() };
    const fd = openSync(this.path, "a");
    try {
      appendFileSync(fd, JSON.stringify(stamped) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return stamped;
  }

  read(): LoggedEvent[] {
    return readLog(this.path);
  }

  /** Events after a given seq — the SSE/tail primitive for the viewer. */
  since(seq: number): LoggedEvent[] {
    return this.read().filter((e) => e.seq > seq);
  }
}

export function readLog(path: string): LoggedEvent[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
  const events: LoggedEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      events.push(JSON.parse(lines[i]!) as LoggedEvent);
    } catch (err) {
      if (i === lines.length - 1) break; // torn tail from a mid-write crash — legal
      throw new Error(`${path}:${i + 1}: corrupt event line`);
    }
  }
  return events;
}
