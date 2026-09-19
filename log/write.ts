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
 *
 * Locked append (system-map 0.5 / eng review outside voice #2). A run log has several
 * writers in different processes — the engine runner, `cli/main.ts reply|jump`, and the web
 * server answering an ask — each with its own EventLog instance. `seq` used to be read once
 * at construction and then counted in memory, so two writers stamped duplicate seqs, and a
 * check-then-append ("no decision yet → append one") could land twice. Now every write:
 *   1. takes `<path>.lock`, created O_EXCL holding the writer's PID. A lock whose PID is dead
 *      (or that is empty and older than `staleLockMs`) is broken — a runner killed while
 *      holding it must not wedge the run. A live holder is waited on with a growing backoff
 *      until `lockTimeoutMs`, then we throw naming the lock and holder rather than hang;
 *   2. reads the tail seq from the FILE, scanning only its last few KB (chunk streams append
 *      many times a second and run.jsonl reaches MBs, so a full read per append is O(n²));
 *   3. stamps seq = tail + 1, appends, fsyncs, releases.
 * `appendIf(build)` runs `build` over the whole log inside the same critical section, so a
 * decision that depends on what the log already holds is atomic across processes.
 *
 * A torn tail is repaired under the lock before appending: its bytes are cut (they were
 * never an event — readLog already drops them), or a complete final line that only lost its
 * "\n" is terminated. Without this the next event fuses onto the torn bytes and turns a
 * legal torn tail into mid-file corruption that readLog rejects forever.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { LoggedEvent, RunEvent } from "./events";

export interface EventLogOptions {
  /** How long a writer waits on a live lock holder before throwing. Default 5s. */
  lockTimeoutMs?: number;
  /** Age after which a lock with no readable PID (holder died mid-create) is broken. Default 2s. */
  staleLockMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 2_000;
const MAX_BACKOFF_MS = 20;
/** First tail window; doubles until it holds a complete line. Most events are well under this. */
const TAIL_WINDOW = 16 * 1024;
const NL = 0x0a;

/** Lock paths this process holds right now — catches a write from inside appendIf's build. */
const held = new Set<string>();

export class EventLog {
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  constructor(
    readonly path: string,
    private readonly clock: () => Date = () => new Date(),
    opts: EventLogOptions = {},
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.lockPath = `${resolve(path)}.lock`;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = opts.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    // Resume-safe by construction: there is no in-memory seq to seed — every write reads the
    // tail from the file under the lock, so an instance never goes stale behind other writers.
  }

  /** Append one event durably. Returns the stamped event as written. */
  append(event: RunEvent): LoggedEvent {
    return this.withLock(() => this.appendLocked(event));
  }

  /**
   * Atomic check-then-append: `build` sees every event currently in the log, under the same
   * lock every other writer takes. Returns the stamped event, or null if `build` declined.
   * `build` must not write to this log itself (that throws — it would deadlock otherwise).
   */
  appendIf(build: (events: LoggedEvent[]) => RunEvent | null): LoggedEvent | null {
    return this.withLock(() => {
      const next = build(readLog(this.path));
      return next === null ? null : this.appendLocked(next);
    });
  }

  read(): LoggedEvent[] {
    return readLog(this.path);
  }

  /** Events after a given seq — the SSE/tail primitive for the viewer. */
  since(seq: number): LoggedEvent[] {
    return this.read().filter((e) => e.seq > seq);
  }

  private withLock<T>(fn: () => T): T {
    if (held.has(this.lockPath)) {
      throw new Error(
        `${this.lockPath}: re-entrant log write — append/appendIf called while this process already holds the lock (writing from inside an appendIf build?)`,
      );
    }
    acquireLock(this.lockPath, this.lockTimeoutMs, this.staleLockMs);
    held.add(this.lockPath);
    try {
      return fn();
    } finally {
      held.delete(this.lockPath);
      releaseLock(this.lockPath);
    }
  }

  /** The one write path. Caller holds the lock. */
  private appendLocked(event: RunEvent): LoggedEvent {
    const fd = openSync(this.path, "a+");
    try {
      const tail = scanTail(fd, this.path);
      if (tail.truncateTo !== undefined) ftruncateSync(fd, tail.truncateTo);
      const stamped: LoggedEvent = { ...event, seq: tail.seq + 1, ts: this.clock().toISOString() };
      appendFileSync(fd, (tail.unterminated ? "\n" : "") + JSON.stringify(stamped) + "\n");
      fsyncSync(fd);
      return stamped;
    } finally {
      closeSync(fd);
    }
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

// ---------------------------------------------------------------------------------------
// tail scan

interface Tail {
  /** seq of the last complete event, 0 for an empty log. */
  seq: number;
  /** Byte offset to cut the file to: the final line failed to parse (torn write). */
  truncateTo?: number;
  /** The final line parsed but lacks its "\n" — the next write must start a new line. */
  unterminated: boolean;
}

/** Find the tail seq reading only the end of the file, growing the window as needed. */
function scanTail(fd: number, path: string): Tail {
  const size = fstatSync(fd).size;
  for (let window = TAIL_WINDOW; ; window *= 2) {
    const start = Math.max(0, size - window);
    const buf = Buffer.alloc(size - start);
    const got = readSync(fd, buf, 0, buf.length, start);
    const tail = parseTail(buf.subarray(0, got), start, path);
    if (tail !== undefined) return tail;
  }
}

/**
 * Walk lines backwards from the end of `buf` (the file's bytes from `start`). Same rules as
 * readLog: blank lines are ignored, the final non-blank line is dropped iff it fails to
 * parse, and any other unparseable line is corruption. Returns undefined when the window
 * does not reach back to a line start and `start > 0` — the caller widens and retries.
 */
function parseTail(buf: Buffer, start: number, path: string): Tail | undefined {
  const endsWithNewline = buf.length > 0 && buf[buf.length - 1] === NL;
  let lineEnd = endsWithNewline ? buf.length - 1 : buf.length; // exclusive, excludes "\n"
  let isFinal = true;
  let truncateTo: number | undefined;
  for (;;) {
    const prevNl = lineEnd === 0 ? -1 : buf.lastIndexOf(NL, lineEnd - 1);
    if (prevNl === -1 && start > 0) return undefined; // this line may begin before the window
    const lineStart = prevNl + 1;
    if (lineStart < lineEnd) {
      const seq = parseSeq(buf.subarray(lineStart, lineEnd), path, start + lineStart);
      if (seq !== undefined) {
        return { seq, truncateTo, unterminated: isFinal && !endsWithNewline };
      }
      if (!isFinal) throw new Error(`${path}: corrupt event line before the tail (byte ${start + lineStart})`);
      truncateTo = start + lineStart; // torn tail: cut it, never append after it
      isFinal = false;
    }
    if (prevNl === -1) return { seq: 0, truncateTo, unterminated: false }; // reached file start
    lineEnd = prevNl;
  }
}

/**
 * undefined = not JSON (a torn write, which readLog would drop too). Valid JSON without an
 * integer seq is not torn — it is a line readLog would keep — so it throws rather than being
 * cut: truncation only ever removes bytes readLog already ignores.
 */
function parseSeq(line: Buffer, path: string, offset: number): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.toString("utf8"));
  } catch {
    return undefined;
  }
  const seq = typeof parsed === "object" && parsed !== null ? (parsed as { seq?: unknown }).seq : undefined;
  if (typeof seq === "number" && Number.isInteger(seq)) return seq;
  throw new Error(`${path}: event line at byte ${offset} has no integer seq`);
}

// ---------------------------------------------------------------------------------------
// lockfile

function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String(err.code) : undefined;
}

/** Create `lockPath` exclusively, holding our PID. Returns false if it already exists. */
function tryCreate(lockPath: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if (errCode(err) === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, String(process.pid));
  } catch (err) {
    closeSync(fd);
    unlinkQuiet(lockPath); // never leave an empty lock behind on our own failure
    throw err;
  }
  closeSync(fd);
  return true;
}

function unlinkQuiet(p: string): void {
  try {
    unlinkSync(p);
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errCode(err) !== "ESRCH"; // EPERM = exists under another user: alive
  }
}

type LockState = { kind: "gone" } | { kind: "held"; pid: number | undefined; stale: boolean };

function inspectLock(lockPath: string, staleMs: number): LockState {
  let content: string;
  let mtimeMs: number;
  try {
    content = readFileSync(lockPath, "utf8").trim();
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch (err) {
    if (errCode(err) === "ENOENT") return { kind: "gone" };
    throw err;
  }
  const pid = /^\d+$/.test(content) ? Number(content) : undefined;
  if (pid === undefined) {
    // empty/garbled: a holder between open("wx") and writing its PID, or one that died there
    return { kind: "held", pid, stale: Date.now() - mtimeMs > staleMs };
  }
  // our own PID on a lock we do not hold (withLock checked) can only be a leftover
  const stale = pid === process.pid ? !held.has(lockPath) : !pidAlive(pid);
  return { kind: "held", pid, stale };
}

/**
 * Break a stale lock. Guarded by `<lock>.break` so two waiters that both judged the same
 * lock stale cannot race: the second re-inspects under the guard, finds the first one's
 * fresh (live) lock, and leaves it alone. Returns false when another live process is mid-
 * break, so the caller backs off instead of spinning.
 */
function breakStaleLock(lockPath: string, staleMs: number): boolean {
  const guard = `${lockPath}.break`;
  if (!tryCreate(guard)) {
    const g = inspectLock(guard, staleMs);
    if (g.kind === "held" && g.stale) {
      unlinkQuiet(guard); // a breaker died mid-break
      return true;
    }
    return g.kind === "gone"; // a live breaker is on it — back off like any other wait
  }
  try {
    const again = inspectLock(lockPath, staleMs);
    if (again.kind === "held" && again.stale) unlinkQuiet(lockPath);
    return true;
  } finally {
    unlinkQuiet(guard);
  }
}

function acquireLock(lockPath: string, timeoutMs: number, staleMs: number): void {
  const deadline = Date.now() + timeoutMs;
  let backoff = 1;
  for (;;) {
    if (tryCreate(lockPath)) return;
    const state = inspectLock(lockPath, staleMs);
    if (state.kind === "gone") continue; // released between our create and our read
    if (state.stale && breakStaleLock(lockPath, staleMs)) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for log lock ${lockPath} (held by pid ${state.pid ?? "unknown — lock file has no PID yet"})`,
      );
    }
    Bun.sleepSync(Math.min(backoff, remaining));
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

/**
 * Release only a lock that is still ours. If a waiter wrongly judged ours stale and took
 * the lock (a frozen holder past staleLockMs, or PID reuse), unlinking by path would delete
 * THEIR live lock and let a third writer in — the loss of exclusion would cascade. Reading
 * then unlinking is itself check-then-act, but it bounds the damage to one overlapping pair.
 */
function releaseLock(lockPath: string): void {
  let holder: string;
  try {
    holder = readFileSync(lockPath, "utf8").trim();
  } catch {
    return; // already gone
  }
  if (holder === String(process.pid)) unlinkQuiet(lockPath);
}
