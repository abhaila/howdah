/**
 * HOW-50: the runs list as a live BOARD — each run's vital signs on one screen, the way cwc's
 * tmux grid shows several runs at once: current step and how long it has been on it, when the
 * agent last did anything, what it has cost, what it has committed, and its PR.
 *
 * Everything is derived from the log (plus one read-only git count); nothing is stored. The
 * constraint is SPEED: the list re-derives on every SSE tick, and a real `$HOWDAH_HOME` has
 * runs of 2–3k events each, most of them streaming `chunk`s. So the fold is INCREMENTAL:
 *
 *   - each run's log is read from the byte offset the previous fold stopped at, so a tick that
 *     appended ten events parses ten events, not three thousand;
 *   - `chunk` events — the bulk of every log — are folded into three numbers (last activity,
 *     and nothing else) and never kept; every other event is kept, because the status rules
 *     (deriveStatus, decisionAnswers) need them and they are a small fraction of the file;
 *   - a log that SHRANK (the writer cut a torn tail) is refolded from zero, which is always
 *     correct and almost never happens.
 *
 * A torn final line is tolerated exactly as `readLog` tolerates it: an unterminated line is
 * held back until its newline arrives, and parsed provisionally if it is already whole.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { LoggedEvent } from "../log/events";
import { deriveSummary, deriveTimeline, type RunStatus, type RunSummary } from "./derive";

/** what one run looks like on the board — the summary plus its vital signs */
export interface RunBoardRow extends RunSummary {
  /** the step in flight (or the one the run is parked on), with when it began */
  current: { node: string; visit: number; since: string } | null;
  /** when the agent last produced anything — the quiet clock (lib/liveness.ts) */
  last_activity_at: string | null;
  /** summed from every finalised turn's reported cost */
  cost_usd: number;
  /**
   * the cost is a FLOOR, not a total: a finalised turn reported no cost (codex, HOW-34), or a
   * turn is still in flight and has not reported yet. The board marks it rather than implying
   * the number is the whole bill.
   */
  cost_partial: boolean;
  /** commits between the first and the latest HEAD the reconciler observed; null = unknown */
  commits: number | null;
  /** the latest PR observation, when one exists */
  pr: { url: string; state: string } | null;
}

/** the per-run fold: everything the row needs, kept small */
interface Fold {
  size: number;
  /** bytes consumed — always at a line boundary */
  offset: number;
  /** an unterminated final line, held until its newline arrives */
  pending: string;
  /** every non-chunk event, in order */
  events: LoggedEvent[];
  lastAt: string | null;
  lastAgentAt: string | null;
  cost: number;
  costPartial: boolean;
}

const fresh = (): Fold => ({ size: 0, offset: 0, pending: "", events: [], lastAt: null, lastAgentAt: null, cost: 0, costPartial: false });

function absorb(f: Fold, e: LoggedEvent): void {
  f.lastAt = e.ts;
  if (e.type === "chunk") {
    f.lastAgentAt = e.ts;
    return; // the bulk of every log: counted, never kept
  }
  if (e.type === "turn-finalized") {
    f.lastAgentAt = e.ts;
    if (typeof e.usage?.cost_usd === "number") f.cost += e.usage.cost_usd;
    else f.costPartial = true;
  }
  f.events.push(e);
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

export class BoardCache {
  private readonly folds = new Map<string, Fold>();
  /** `${cwd}\0${base}\0${head}` → count: commits between two fixed shas never change */
  private readonly commitCounts = new Map<string, number | null>();

  constructor(private readonly opts: { countCommits?: (cwd: string, base: string, head: string) => number | null } = {}) {}

  /**
   * Bring one run's fold up to date and return its events (non-chunk) plus the folded facts.
   * Reads only the bytes appended since the last call.
   */
  fold(path: string): Readonly<Fold> & { provisional: LoggedEvent | null } {
    let f = this.folds.get(path) ?? fresh();
    if (!existsSync(path)) {
      this.folds.delete(path);
      return { ...fresh(), provisional: null };
    }
    const fd = openSync(path, "r");
    let size: number;
    try { size = fstatSync(fd).size; } finally { closeSync(fd); }
    if (size < f.offset + Buffer.byteLength(f.pending)) f = fresh(); // the log shrank: refold
    if (size > f.offset + Buffer.byteLength(f.pending)) {
      const start = f.offset + Buffer.byteLength(f.pending);
      const text = f.pending + readRange(path, start, size);
      const lines = text.split("\n");
      const tail = lines.pop() ?? ""; // "" when the read ended on a newline
      for (const line of lines) {
        f.offset += Buffer.byteLength(line) + 1;
        if (!line) continue;
        try { absorb(f, JSON.parse(line) as LoggedEvent); } catch { /* a corrupt middle line: readLog would throw; the board skips it */ }
      }
      f.pending = tail;
    }
    f.size = size;
    this.folds.set(path, f);
    // a whole-but-unterminated final line is a real event (readLog parses it); a torn one is not
    let provisional: LoggedEvent | null = null;
    if (f.pending) {
      try { provisional = JSON.parse(f.pending) as LoggedEvent; } catch { provisional = null; }
    }
    return { ...f, provisional };
  }

  /** forget runs that no longer exist, so a long-lived viewer does not hold dead folds */
  retain(paths: Iterable<string>): void {
    const keep = new Set(paths);
    for (const p of this.folds.keys()) if (!keep.has(p)) this.folds.delete(p);
  }

  commitsBetween(cwd: string | undefined, base: string | null, head: string | null): number | null {
    if (!cwd || !base || !head) return null;
    if (base === head) return 0;
    const key = `${cwd}\0${base}\0${head}`;
    if (this.commitCounts.has(key)) return this.commitCounts.get(key)!;
    const n = (this.opts.countCommits ?? gitCount)(cwd, base, head);
    if (this.commitCounts.size > 2000) this.commitCounts.delete(this.commitCounts.keys().next().value!);
    this.commitCounts.set(key, n);
    return n;
  }
}

function gitCount(cwd: string, base: string, head: string): number | null {
  if (!existsSync(cwd)) return null;
  const r = spawnSync("git", ["--no-optional-locks", "rev-list", "--count", `${base}..${head}`], { cwd, encoding: "utf8", timeout: 5000 });
  const n = Number((r.stdout ?? "").trim());
  return r.status === 0 && Number.isFinite(n) ? n : null;
}

/**
 * One run's board row from its fold. `status` arrives already corrected for runner liveness
 * by the caller (the server's `withRunnerLiveness`), so a dead runner reads `harness-dead`
 * here exactly as it does on the run page.
 */
export function boardRow(
  id: string,
  fold: ReturnType<BoardCache["fold"]>,
  opts: { cwd?: string; commits?: (cwd: string | undefined, base: string | null, head: string | null) => number | null; liveness?: (s: RunSummary, events: LoggedEvent[]) => RunSummary } = {},
): RunBoardRow {
  const events = fold.provisional && fold.provisional.type !== "chunk" ? [...fold.events, fold.provisional] : fold.events;
  let summary = deriveSummary(id, events);
  // chunks were not kept, so the summary's "last event" must come from the fold
  const lastAt = fold.provisional?.ts ?? fold.lastAt;
  summary = { ...summary, last_event_at: lastAt };
  if (opts.liveness) summary = opts.liveness(summary, events);

  const timeline = deriveTimeline(events);
  const row = timeline.at(-1);
  const inFlight: RunStatus[] = ["running", "needs-input", "waiting", "harness-dead", "failed-recoverable", "queued"];
  const current = row && inFlight.includes(summary.status) ? { node: row.node, visit: row.visit, since: row.started_at } : null;

  const reconciled = events.filter((e): e is Extract<LoggedEvent, { type: "reconciled" }> => e.type === "reconciled");
  const base = reconciled.find((e) => e.git.head)?.git.head ?? null;
  const head = reconciled.findLast((e) => e.git.head)?.git.head ?? null;
  const prObs = reconciled.findLast((e) => e.forge?.kind === "pr")?.forge;
  const liveTurn = timeline.at(-1)?.status === "running" && summary.status === "running";

  return {
    ...summary,
    current,
    last_activity_at: fold.provisional?.type === "chunk" ? fold.provisional.ts : fold.lastAgentAt,
    cost_usd: Math.round(fold.cost * 1e6) / 1e6,
    cost_partial: fold.costPartial || liveTurn,
    commits: opts.commits ? opts.commits(opts.cwd, base, head) : null,
    pr: prObs && prObs.kind === "pr" ? { url: prObs.url, state: prObs.state } : null,
  };
}
