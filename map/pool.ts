/**
 * Parse worker pool — system-map 1b, eng review D13/12A.
 *
 * Cold parses fan out over Bun Workers (size is injectable; 0 means "parse in-process", which is
 * also the reference the pool is tested against — results must be identical, because facts
 * depend only on bytes).
 *
 * Default size is work-proportional, capped at one per core (D13 said "one per core"; measured
 * on a 4-physical/8-logical x64 Mac, each worker pays ~0.5 s to instantiate the WASM runtime and
 * grammars, so one-per-core was 2.7x SLOWER than in-process for this repo's 106 files, and 8
 * workers were slower than 4 even on 1,060 files):
 *
 *   files   in-process   2 workers   4 workers   8 workers      (cold, ms)
 *    106        830         827        1425        2239
 *   1060       5649        4566        4058        6342
 *
 * so: ≤ FILES_PER_WORKER cold files → in-process; otherwise ceil(files / FILES_PER_WORKER)
 * workers, at most one per core.
 *
 * Failure isolation: if a worker dies mid-file, or doesn't answer within `fileTimeoutMs` (it is
 * then terminated), that one file resolves as `{ok: false, reason: "worker error: …"}`
 * (→ `not-checked (worker error)` in the manifest), the worker is replaced lazily, and every
 * other file continues. If workers keep dying BEFORE they are ready (`maxStartupFailures` in a
 * row), the pool stops respawning and every remaining file is not-checked with that reason —
 * no infinite respawn loop. A failure is reported, never silent, and never takes the
 * extraction down. (The in-process parser cannot be interrupted, so it has no timeout.)
 */

import { availableParallelism } from "node:os";
import { FileParser, type ParseOutcome } from "./facts";
import type { GrammarOverrides } from "./languages";
import type { Language } from "./types";
import type { WorkerFaults, WorkerIn, WorkerOut } from "./worker";

export interface Parse {
  parse(language: Language, content: string): Promise<ParseOutcome>;
  close(): Promise<void>;
}

export interface PoolOptions {
  /** Worker count; 0 = in-process. Default: `defaultPoolSize(jobs)`. */
  size?: number;
  /** Number of cold parses expected — sizes the default pool. */
  jobs?: number;
  grammarOverrides?: GrammarOverrides;
  /** Per-file budget: a worker that hasn't answered is terminated and the file is not-checked. */
  fileTimeoutMs?: number;
  /** Consecutive workers that die before becoming ready before the pool gives up. */
  maxStartupFailures?: number;
  /** Fault injection for tests — see worker.ts. */
  faults?: WorkerFaults;
}

export const DEFAULT_FILE_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_STARTUP_FAILURES = 3;

export const FILES_PER_WORKER = 250;

/** Workers for `jobs` cold parses: 0 (in-process) for small batches, else ≤ one per core. */
export function defaultPoolSize(jobs: number): number {
  const n = Math.min(availableParallelism(), Math.ceil(jobs / FILES_PER_WORKER));
  return n <= 1 ? 0 : n;
}

/** In-process parser with the same interface as the pool. */
export async function inlineParser(grammarOverrides?: GrammarOverrides): Promise<Parse> {
  const p = await FileParser.create(grammarOverrides);
  return {
    parse: async (language, content) => {
      try {
        return await p.parse(content, language);
      } catch (e) {
        return { ok: false, reason: `parser error: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
    close: async () => {},
  };
}

interface Job {
  id: number;
  language: Language;
  content: string;
  resolve(o: ParseOutcome): void;
}

interface Slot {
  worker: Worker;
  ready: boolean;
  dead: boolean;
  /** Settles once the worker has loaded its WASM (or died trying). */
  settled: Promise<void>;
  job: Job | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Retire this worker: terminate, not-check its in-flight file, respawn lazily. */
  fail(why: string): void;
}

const notChecked = (why: string): ParseOutcome => ({ ok: false, reason: `worker error: ${why}` });

export class ParsePool implements Parse {
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private nextId = 1;
  private closed = false;
  private startupFailures = 0;
  /** Set once workers keep dying before they start: every queued/future file is not-checked. */
  private broken: string | null = null;
  private readonly timeoutMs: number;
  private readonly maxStartupFailures: number;

  constructor(private readonly opts: PoolOptions & { size: number }) {
    this.timeoutMs = opts.fileTimeoutMs ?? DEFAULT_FILE_TIMEOUT_MS;
    this.maxStartupFailures = opts.maxStartupFailures ?? DEFAULT_MAX_STARTUP_FAILURES;
    for (let i = 0; i < opts.size; i++) this.slots.push(this.spawn());
  }

  private spawn(): Slot {
    const worker = new Worker(new URL("./worker.ts", import.meta.url).href);
    let settle = (): void => {};
    const slot: Slot = { worker, ready: false, dead: false, settled: new Promise<void>((r) => (settle = r)), job: null, timer: undefined, fail: () => {} };
    worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
      const msg = ev.data;
      if (msg.type === "ready") {
        slot.ready = true;
        this.startupFailures = 0;
        settle();
      } else if (slot.job !== null && slot.job.id === msg.id) {
        clearTimeout(slot.timer);
        const job = slot.job;
        slot.job = null;
        job.resolve(msg.outcome);
      }
      this.dispatch();
    };
    const fail = (slot.fail = (why: string): void => {
      settle();
      if (slot.dead) return;
      slot.dead = true;
      clearTimeout(slot.timer);
      if (this.closed) return;
      const idx = this.slots.indexOf(slot);
      if (idx >= 0) this.slots.splice(idx, 1);
      try {
        worker.terminate();
      } catch {
        // already gone
      }
      if (!slot.ready && ++this.startupFailures >= this.maxStartupFailures) {
        this.broken = `workers failed to start ${this.startupFailures} times in a row (${why})`;
      }
      const job = slot.job;
      slot.job = null;
      job?.resolve(notChecked(why));
      this.dispatch();
    });
    worker.onerror = (ev: ErrorEvent) => fail(ev.message || "worker crashed");
    worker.addEventListener("close", () => {
      if (slot.job !== null || !slot.ready) fail("worker exited");
    });
    const init: WorkerIn = { type: "init", ...(this.opts.grammarOverrides !== undefined ? { grammarOverrides: this.opts.grammarOverrides } : {}), ...(this.opts.faults !== undefined ? { faults: this.opts.faults } : {}) };
    worker.postMessage(init);
    return slot;
  }

  private dispatch(): void {
    if (this.broken !== null) {
      for (const j of this.queue.splice(0)) j.resolve(notChecked(this.broken));
      return;
    }
    // Replace dead workers lazily: only while there is still work to hand out.
    while (this.slots.length < this.opts.size && this.queue.length > this.slots.filter((s) => s.job === null).length) this.slots.push(this.spawn());
    for (const slot of this.slots) {
      if (!slot.ready || slot.job !== null || slot.dead) continue;
      const job = this.queue.shift();
      if (job === undefined) return;
      slot.job = job;
      slot.timer = setTimeout(() => slot.fail(`timed out after ${this.timeoutMs} ms`), this.timeoutMs);
      const msg: WorkerIn = { type: "parse", id: job.id, language: job.language, content: job.content };
      slot.worker.postMessage(msg);
    }
  }

  parse(language: Language, content: string): Promise<ParseOutcome> {
    if (this.closed) return Promise.resolve(notChecked("pool closed"));
    if (this.broken !== null) return Promise.resolve(notChecked(this.broken));
    return new Promise((resolve) => {
      this.queue.push({ id: this.nextId++, language, content, resolve });
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    // Terminating a worker while it is still instantiating WASM can crash the Bun runtime, so let
    // any worker that is mid-start finish loading first (bounded).
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(this.slots.map((s) => s.settled)), new Promise<void>((r) => (timer = setTimeout(r, 5000)))]);
    clearTimeout(timer);
    for (const s of this.slots) {
      clearTimeout(s.timer);
      s.job?.resolve(notChecked("pool closed"));
      s.worker.terminate();
    }
    for (const j of this.queue.splice(0)) j.resolve(notChecked("pool closed"));
  }
}

export async function createParser(opts: PoolOptions = {}): Promise<Parse> {
  const size = opts.size ?? defaultPoolSize(opts.jobs ?? Number.POSITIVE_INFINITY);
  if (size <= 0) return inlineParser(opts.grammarOverrides);
  return new ParsePool({ ...opts, size });
}
