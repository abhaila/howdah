/**
 * Stuck detection (HOW-38) — notice an agent reissuing the same failing call, inside its turn.
 *
 * Nothing used to watch a live turn. An agent re-running one failing command spent the
 * subscription allowance until it gave up on its own, and nobody was told: that case does not
 * dead-end, it burns, which breaks "nothing dead-ends silently" from the other side.
 *
 * The rule is the harness-design study's (arXiv 2609.20804, HOW-32), held fixed in all its
 * conditions:
 *   - a STREAK is consecutive calls with the same tool name and byte-identical arguments
 *     (adapter/tools.ts argumentsHash, over the FULL arguments — before the log's 400-char
 *     clip). Any different call ends it; a streak broken once and resumed is a new streak. A
 *     paginated read at a new offset has different arguments, so it never trips.
 *   - WARN once per streak at `warn` identical calls, failing or not — a polling loop
 *     (`gh pr checks` while CI runs) is legitimately repetitive, so successes count toward the
 *     warning only, never toward the stop.
 *   - STOP at `stop` identical FAILING calls in a row (a success resets that count).
 *   - permission DENIALS count for nothing: a call the operator (or the CLI's own classifier)
 *     refused is not the agent spinning, so it neither extends nor fails a streak.
 *
 * The thresholds come from config.json `stuck` (engine/executors/index.ts), not constants
 * scattered across executors; a node opts out with `stuckDetection: false` (AgentConfig), for
 * a step whose whole job is polling.
 *
 * SPIKE (claude 2.1.296, 2026-10-12, adapter/fixtures/claude-midturn-user.jsonl): a stream-json
 * user message written to stdin MID-TURN is delivered at the next tool boundary — but claude
 * attaches it to the pending tool result, not as a user turn, and it does not start a turn of
 * its own (one `result` for the whole exchange). In the spike the model noticed it and said it
 * "came back inside the tool result, not as a message from you, so I didn't treat it as one".
 * So the paper's reminder IS sent to claude at the warn threshold, and it is phrased as coming
 * from the harness; it is a nudge the model may discount, which is why the stop threshold and
 * the park exist regardless. codex and cursor get the logged warning only.
 */
import { argumentsHash } from "../../adapter/tools";
import type { EventLog } from "../../log/write";

export interface StuckThresholds {
  warn: number;
  stop: number;
}

export const DEFAULT_STUCK_THRESHOLDS: StuckThresholds = { warn: 5, stop: 8 };

export interface StuckSignal {
  kind: "warn" | "stop";
  tool: string;
  /** the call's arguments as logged — clipped, for a human to recognise */
  summary: string;
  /** identical non-denied calls in the streak so far */
  count: number;
  /** identical FAILING calls in a row so far */
  failing: number;
  /** the latest error text, clipped */
  last_error?: string;
}

interface Streak {
  key: string;
  tool: string;
  summary: string;
  ids: Set<string>;
  count: number;
  failing: number;
  warned: boolean;
  lastError?: string;
}

/**
 * Feed it every tool_call and tool_result of ONE turn, in stream order; a result may return a
 * signal. Pure bookkeeping — the executor decides what a signal does (log, remind, stop).
 */
export class StreakTracker {
  private streak: Streak | null = null;

  constructor(private readonly thresholds: StuckThresholds = DEFAULT_STUCK_THRESHOLDS) {}

  /** a call was issued; `hash` is adapter/tools.ts argumentsHash over its full arguments */
  call(id: string, tool: string, hash: string, summary: string): void {
    const key = `${tool}\u0000${hash}`;
    if (this.streak && this.streak.key === key) {
      this.streak.ids.add(id);
      return;
    }
    this.streak = { key, tool, summary, ids: new Set([id]), count: 0, failing: 0, warned: false };
  }

  /**
   * a call's result arrived. `denied`: the call was refused permission, so it counts for
   * nothing. A result for a call outside the current streak (an older streak's late result)
   * is ignored.
   */
  result(id: string, isError: boolean, content: string, denied: boolean): StuckSignal | null {
    const s = this.streak;
    if (!s || !s.ids.has(id)) return null;
    if (denied) {
      s.ids.delete(id);
      return null;
    }
    s.count++;
    if (isError) {
      s.failing++;
      s.lastError = content.slice(0, 400);
    } else {
      s.failing = 0;
    }
    const signal = (kind: StuckSignal["kind"]): StuckSignal => ({
      kind, tool: s.tool, summary: s.summary, count: s.count, failing: s.failing,
      ...(s.lastError !== undefined ? { last_error: s.lastError } : {}),
    });
    if (s.failing >= this.thresholds.stop) return signal("stop");
    if (!s.warned && s.count >= this.thresholds.warn) {
      s.warned = true;
      return signal("warn");
    }
    return null;
  }
}

/**
 * The CLI's own words for a refused tool call, for a denial the executor did not answer itself
 * (claude's auto-mode classifier refuses without asking). Deliberately narrow: a miss only
 * means a denial is counted as an ordinary failure, which needs `stop` of them in a row.
 * Unverified live — written from the phrasings claude uses; pin a fixture when one is captured.
 */
const DENIAL_TEXT = /\bpermission\b[^\n]{0,60}\b(denied|rejected)\b|\bdoesn't want to proceed\b|\bwas blocked\b/i;

export function looksLikeDenial(content: string): boolean {
  return DENIAL_TEXT.test(content);
}

/** the paper's reminder, sent mid-turn to claude at the warn threshold (see the SPIKE note) */
export function stuckReminder(s: StuckSignal): string {
  return (
    `[Howdah harness notice] You have called ${s.tool} with the SAME arguments ${s.count} times in a row` +
    (s.failing > 0 ? ` and it has failed the last ${s.failing} times` : "") +
    `. Repeating it will not change the result. Stop and try a different approach: read the error, ` +
    `inspect the code or inputs it depends on, or change the command. If you are blocked, say so ` +
    `in your reply instead of retrying.`
  );
}

/** the park reason for a stopped streak — it quotes the call and the error, so a human can act */
export function stuckReason(s: StuckSignal): string {
  return (
    `stuck: ${s.tool} was called ${s.count} times in a row with identical arguments and failed the last ${s.failing}` +
    ` — call: ${s.summary.slice(0, 200)}` +
    (s.last_error ? ` — last error: ${s.last_error.slice(0, 200)}` : "")
  );
}


export interface ToolWatchOpts {
  harness: string;
  log: EventLog;
  node: string;
  visit: number;
  thresholds?: StuckThresholds;
  /** AgentConfig.stuckDetection — `false` hashes calls (the profile still wants them) but never warns or stops */
  enabled?: boolean;
  /** send the reminder into the live turn (claude only — see the SPIKE note); absent: log only */
  remind?: (text: string) => void;
  /** a line in the transcript, so the warning is seen where the agent's work is read */
  note?: (text: string) => void;
}

/**
 * The one piece every agent executor wires in: hash each call before its clip, pair results,
 * log the warning, and say when to stop. Executors differ only in how they interrupt a turn.
 */
export class ToolWatch {
  private readonly tracker: StreakTracker;
  private readonly denied = new Set<string>();
  /** set when a streak hit the stop threshold — the executor ends the turn and parks `stuck` */
  stopped: StuckSignal | null = null;

  constructor(private readonly opts: ToolWatchOpts) {
    this.tracker = new StreakTracker(opts.thresholds ?? DEFAULT_STUCK_THRESHOLDS);
  }

  /** a tool_call: returns its arguments hash, for the chunk's `input_hash` */
  call(id: string, name: string, input: unknown, summary: string): string {
    const hash = argumentsHash(this.opts.harness, name, input);
    this.tracker.call(id, name, hash, summary);
    return hash;
  }

  /** the executor answered this call's permission request with a deny */
  markDenied(toolUseId: string | undefined): void {
    if (toolUseId) this.denied.add(toolUseId);
  }

  /** a tool_result: logs a warning, reminds, or records the stop */
  result(id: string, isError: boolean, content: string): StuckSignal | null {
    if (this.opts.enabled === false) return null;
    const denied = this.denied.has(id) || (isError && looksLikeDenial(content));
    const signal = this.tracker.result(id, isError, content, denied);
    if (!signal) return null;
    if (signal.kind === "warn") {
      const reminded = this.opts.remind !== undefined;
      this.opts.remind?.(stuckReminder(signal));
      this.opts.note?.(`\n[stuck? ${signal.tool} called ${signal.count}× with identical arguments${signal.failing ? `, failing ${signal.failing}× in a row` : ""}${reminded ? " — the agent was reminded" : ""}]`);
      this.opts.log.append({
        type: "stuck-warning", node: this.opts.node, visit: this.opts.visit,
        tool_name: signal.tool, input_summary: signal.summary, count: signal.count, failing: signal.failing, reminded,
      });
    } else {
      this.stopped = signal;
    }
    return signal;
  }
}

/**
 * HOW-38: a wall-clock ceiling on one turn that does NOT run while a human is being asked
 * something — a park waits as long as the operator needs (HOW-25), so the ceiling measures
 * the agent's own time only.
 */
export class TurnCeiling {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private remaining: number;
  private since = 0;
  fired = false;

  constructor(private readonly ms: number | undefined, private readonly onFire: () => void) {
    this.remaining = ms ?? Infinity;
  }

  start(): void {
    if (this.ms === undefined || this.fired || this.timer) return;
    this.since = Date.now();
    this.timer = setTimeout(() => {
      this.fired = true;
      this.timer = null;
      this.onFire();
    }, Math.max(0, this.remaining));
  }

  pause(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.remaining -= Date.now() - this.since;
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export function turnTimeoutReason(ms: number): string {
  return `turn-timeout: the agent's turn ran past its ${Math.round(ms / 1000)}s ceiling (turnTimeoutMs) and was stopped`;
}
