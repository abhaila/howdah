/**
 * Engine assembly (T8): routing, visits/maxVisits, exactly-once side effects (OV-1),
 * run pinning (OV-2), resume-by-replay (R7).
 *
 * The engine owns the loop; EXECUTORS own the work. An executor gets the node, its
 * declared reads (already resolved through the ContextStore), the rendered prompt for
 * agent nodes, and an `effects` handle for side-effecting steps:
 *
 *   if (!(await effects.claim("create-pr"))) { const pr = await openPr(); effects.done("create-pr", pr); }
 *
 * claim() durably records the INTENT before the effect runs and answers "has this effect
 * already been proven done?". A crash between intent and done leaves an AMBIGUOUS record;
 * resume() probes it (did the PR appear?) before any retry — the effect never runs twice.
 *
 * Pinning: at start the engine snapshots every prompt this graph consumes into
 * <dir>/prompts/ and renders ONLY from that snapshot. Accepting a revision mid-run
 * changes nothing for this run — revisions apply to new runs (OV-2).
 *
 * Render proof (system-map 0.1): renderPrompt() assembles the COMPLETE prompt — template,
 * operator suffixes, skill hint, outputs contract (core/template.ts assemblePrompt) —
 * before hashing, and logs the suffix inputs (skills, output_keys, suffix_version) so
 * reconstruction can rebuild it. Executors send `renderedPrompt` unchanged.
 *
 * Visit budgets (system-map 0.3): maxVisits counts visits above a per-node floor that a
 * reset_budgets operator-jump sets (engine/replay.ts). Visit numbers themselves never reset.
 *
 * Park codes + replies (system-map 0.2): every park carries a machine-readable `code`
 * alongside its free-text reason; engine/control.ts decides per code what an operator
 * reply may do. A reply to a failed agent attempt reaches the retried prompt through the
 * replay-derived replyNote, assembled after the jump suffix (core/template.ts).
 *
 * Context exhaustion (HOW-14): an agent attempt that died because its context window filled
 * parks `context-exhausted` and NEVER takes the allowance hop — another harness does not make
 * a context window bigger, and its own fresh visit would start from nothing. The next attempt
 * of that node is rendered with a re-entry briefing (suffix v4) derived from the log
 * (reentryAfterVisit), so it holds across a resume in a fresh process.
 *
 * Approval (system-map 1a):
 *   - Proposal rounds (D15): when a node's successful write lands on an approval node's
 *     `proposal` key, the graph's validateProposal hook checks it (a refusal fails the
 *     attempt with the validator's message, logged as node-finished.refused, and the node's
 *     next attempt renders it — suffix v3, system-map 1c), then `ghost-proposed` is appended BEFORE that
 *     node's node-finished, with proposal_id = the event's own seq.
 *   - Awaiting (D4/3A): an approval executor returns `awaiting` while nobody has decided.
 *     The attempt ends "failed" in the ContextStore (veiled cleared keys come back), NO
 *     node-finished is logged, and the run parks `awaiting-approval`. Replay therefore keeps
 *     the node mid-flight and resume re-attempts the same visit — logging node-finished here
 *     would let a restart route onward on the previous visit's decision.
 *   - The `requires` gate (D3/2A, D18) is a pre-start check beside maxVisits: before
 *     node-started, so a refusal consumes no visit. `jump` can move a stopped run straight
 *     past the approval node; this is what stops it. It reads decision EVENTS only
 *     (engine/slice-decision.ts), never attention-resolved, because resume() auto-resolves.
 *   - Redesign seeding (D22): when an approval node's `redesignTo` node succeeds, the engine
 *     sets that approval's feedback key to the unconsumed redesign messages (else []). The
 *     key is engine-owned on that node — a value the executor wrote for it is replaced.
 *   - readOnly (D6/5A) is a hard constraint in resolveAgentConfig: always "plan".
 *   - One runner per run: start()/resume() hold `runner.pid` as a lockfile for the whole
 *     loop (engine/control.ts claimRunner) and return `busy` if another live runner has it —
 *     `up`, a decision route and a manual resume racing on one run start exactly one loop.
 *   - A graph with an approval node only runs in a git work tree: the fingerprint is what
 *     an approval binds to, and "no fingerprint" must never compare equal.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentConfigOf, hasTools, nodeReads, resolveAgentConfigLayers, type Graph, type NodeDef, type EdgeDef, type AgentConfig, type ApprovalNodeDef, type Harness } from "../core/graph";
import { basename } from "node:path";
import { ContextStore, type Scope } from "../core/context";
import { DEFAULT_CONTEXT_CAP, RENDER_VERSION, SUFFIX_VERSION, assemblePrompt, renderTemplate, renderedHash, skillsForHarness, splitFrontMatter } from "../core/template";
import { defaultHarness, fallbackChain, harnessNames, harnessSpec, isHarness } from "../core/harnesses";
import { EventLog } from "../log/write";
import type { LoggedEvent, ParkCode } from "../log/events";
import { ACCEPTANCE_KEY, asAcceptance, evidenceSources, unmetCriteria, unprovable, type AcceptanceRow } from "../core/acceptance";
import { waivedCriteria } from "./acceptance-decision";
import { repairScope } from "./repair-scope";
import { softStopState, stopResumeFor, undeliveredSteers } from "./steer-state";
import { previousTree } from "./no-progress";
import { replayState, effectKey } from "./replay";
import type { PromptId } from "../core/prompt-ids";
import { proposalHash } from "../core/proposal";
import { describeFingerprintChange, fingerprint, worktreeTree, type Fingerprint } from "./reconcile";
import { effectiveCwd } from "./executors/worktree-record";
import { pinnableText, promptReader } from "../prompts/pin";
import { currentProposal, findDecision, isApproved, nextSeq, pendingRedesigns, readBase } from "./slice-decision";
import { claimRunner, releaseRunner, type RunnerHolder } from "./control";
import { RATE_LIMIT_TEXT } from "./executors/harness-failure";
import { ForgeUnreachableError } from "./executors/git";
import { deriveHandoff } from "./handoff";

/** thread chunks the engine writes itself sort after an attempt's own output */
const ENGINE_NOTE_INDEX = 9998;
const ENGINE_FAILURE_INDEX = 9999;

export interface EffectsHandle {
  /** record intent; returns true if this effect is already proven done (skip it) */
  claim(effect: string): boolean;
  done(effect: string, result?: unknown): void;
}

export interface ExecArgs {
  nodeId: string;
  def: NodeDef<any>;
  visit: number;
  attemptId: string;
  /** the run's working directory, when it has one */
  cwd?: string;
  /** the run id (the run directory's name) */
  runId: string;
  /** the run's event log — executors append chunk/allowance events as they stream */
  log: EventLog;
  /** declared reads, resolved */
  reads: Record<string, unknown>;
  /**
   * agent nodes: the COMPLETE prompt to send, byte-for-byte what rendered_hash covers
   * (already logged as prompt-rendered). Send it unchanged — never append (system-map 0.1).
   */
  renderedPrompt?: string;
  /** agent nodes: resolved execution config (run override → node → graph default) */
  agentConfig?: AgentConfig;
  effects: EffectsHandle;
  /**
   * wait nodes with a `backoff` (HOW-57, G5): how many polls in a row the node that led here
   * reported nothing new — derived from the log by waitStreak(), so a resume backs off the same
   */
  waitStreak?: number;
}

export interface AttemptResult {
  /** "awaiting" (approval nodes only, system-map 1a): undecided — park without finishing */
  status: "succeeded" | "failed" | "awaiting";
  writes: Record<string, unknown>;
  /** why: the park reason for failed/awaiting, a thread note for a succeeded stale outcome */
  reason?: string;
  /**
   * the park code for a failed attempt, when the executor knows something the engine cannot
   * see — an auth failure is the harness's problem, not the attempt's, and the operator needs
   * a different verb for it. Defaults to "attempt-failed".
   */
  code?: ParkCode;
  /** engine-set (system-map 1c): the graph refused this attempt's proposal — logged on node-finished */
  refused?: string;
}

export type Executor = (args: ExecArgs) => Promise<AttemptResult>;

export type ProbeVerdict = "happened" | "not-happened" | "unknown";

export interface EngineOpts {
  /** run directory: run.jsonl + pinned prompts/ live here */
  dir: string;
  executors: Partial<Record<"agent" | "command" | "worktree" | "wait" | "approval", Executor>>;
  /** source prompt dir to pin from (defaults to repo prompts/) */
  /**
   * Where prompts are read from at pin time. An ARRAY is a search path, tried in order, so a
   * local graph's prompts (`$HOWDAH_HOME/prompts`) resolve before the repo's without the
   * engine knowing which graphs are local.
   */
  promptsDir?: string | string[];
  /** resolve an ambiguous side effect on resume: did it actually happen? */
  probe?: (node: string, effect: string, attemptId: string) => Promise<ProbeVerdict>;
  /** loop guard — perpetual graphs park here instead of spinning forever */
  maxSteps?: number;
  clock?: () => Date;
  /** where the run works (worktree or plain folder) — stamped on run-started */
  cwd?: string;
  folderKind?: "repo" | "plain";
  /** HOW-18: the operator's display label, already normalized — stamped on run-started */
  name?: string;
  /** HOW-23: the run that launched this one — stamped on run-started as lineage, never routed on */
  parent?: string;
  /** runs before every non-terminal node — the reconciler's seat (A6.1) */
  beforeNode?: (nodeId: string, def: NodeDef<any>) => Promise<void>;
  /** run-level agent overrides — beat node settings, which beat graph defaults */
  overrides?: AgentConfig;
  /** HOW-39: the workspace's diagnostics command for a repo path (config.json, read by the caller) */
  diagnosticsCommandFor?: (repoPath: string) => string | undefined;
  /** UI tuning overlay: per-node beats TS node; graph-level beats TS defaults */
  tuning?: { defaults?: AgentConfig; nodes?: Record<string, AgentConfig> };
  /**
   * HOW-17: the operator's harness settings from config.json, read from disk by the caller
   * (cli/main.ts) so core/ and the engine stay free of config loading. `default` is the
   * harness a node with no declared one runs on; `fallbackChain` is the order an exhausted
   * harness hands off along. Both are names, validated in core/harnesses.ts — a typo in
   * config.json is ignored rather than fatal.
   */
  harnesses?: { default?: string; fallbackChain?: string[] };
  /** operator control, read at every node boundary — pause/abort land between attempts */
  control?: () => "pause" | "abort" | null;
  /** HOW-69: how the forge-read retry waits out its backoff — injectable so tests do not sleep */
  sleep?: (ms: number) => Promise<void>;
  /**
   * runs with the loop's result while the runner lock is STILL held (system-map 1a review) —
   * where the CLI raises a park's durable attention, so a runner that starts right after
   * this one (a decision's wake) always sees, and can clear, that attention
   */
  whileHeld?: (result: RunState) => Promise<void>;
}

export type RunState =
  | { state: "finished"; outcome: "success" | "failed" | "aborted" }
  | { state: "parked"; node: string; reason: string; code: ParkCode }
  | { state: "paused"; node: string }
  /** another live runner holds this run (engine/control.ts claimRunner): nothing was done */
  | { state: "busy"; holder: RunnerHolder };

export class EngineError extends Error {}

/** a proposal a node just wrote, validated, waiting to be logged as a round */
interface ProposalRound {
  approvalId: string;
  approval: ApprovalNodeDef<any>;
  proposal: unknown;
  manifestHash: string | null;
  fingerprint: Fingerprint;
}

/**
 * THE agent-config resolution — run override → UI node tuning → TS node → UI graph tuning →
 * TS graph default — shared by the engine and the viewer's graph API (which passes no run
 * override), so the effective config the UI shows is the one a run gets. The layering itself
 * is core/graph.ts resolveAgentConfigLayers (first set value wins; the model is the first
 * one that fits the resolved harness; a harness that declares a permission mode always runs
 * in it). On top of it:
 *   - `fallbackHarness` is the engine's exhausted-allowance fallback (f8c8d96, generalised to
 *     an ordered chain by HOW-17): it outranks every layer, because the run has OBSERVED that
 *     harness's allowance is gone. It is any Harness the chain reached, no longer the literal
 *     "codex";
 *   - `readOnly` (system-map 1a, D6/5A) is a hard constraint applied LAST: no layer, and no
 *     fallback, can raise it above "plan" (codex maps plan to its read-only sandbox and
 *     cursor drops its auto-approve flag, so a readOnly node stays read-only wherever the
 *     chain lands it);
 *   - `defaultHarness` is config.json's `defaultHarness`, read from disk by the caller — the
 *     bottom of the stack, under the graph's own default.
 */
/**
 * Where an operator pin takes over. Allowance hops and exhausted-allowance events before
 * the latest `harness-pinned` do not count: that event is the operator putting the run
 * back on a harness the chain had left. Events after it count as usual, so a fresh
 * limit still hops.
 */
export function eventsSinceHarnessPin(events: readonly LoggedEvent[]): readonly LoggedEvent[] {
  let at = -1;
  for (let i = 0; i < events.length; i++) if (events[i]?.type === "harness-pinned") at = i;
  return at < 0 ? events : events.slice(at + 1);
}

/** the harness the operator last pinned, if they have */
export function pinnedHarness(events: readonly LoggedEvent[]): Harness | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "harness-pinned") return e.harness;
  }
  return undefined;
}

export function resolveAgentConfig(
  graph: Graph<any>,
  def: Extract<NodeDef<any>, { kind: "agent" }>,
  nodeId: string,
  layers: { overrides?: AgentConfig; tuning?: EngineOpts["tuning"]; fallbackHarness?: Harness; defaultHarness?: string } = {},
): AgentConfig {
  const node: AgentConfig = agentConfigOf(def);
  const resolved = resolveAgentConfigLayers([
    layers.fallbackHarness ? { harness: layers.fallbackHarness } : undefined,
    layers.overrides,
    layers.tuning?.nodes?.[nodeId],
    node,
    layers.tuning?.defaults,
    graph.def.defaults,
  ], { configuredDefaultHarness: layers.defaultHarness });
  // system-map 1a (D6/5A): a hard constraint — no layer above the node can raise it. HOW-41: nor
  // can a tool ALLOWANCE (an allow list pre-approves tools, which would raise a plan-mode node);
  // a deny list only narrows, so it stays
  if (!def.readOnly) return resolved;
  // HOW-39: and a read-only node never gets the post-edit hook — it makes no edits to check
  const { tools, diagnostics: _diagnostics, ...rest } = resolved;
  return { ...rest, permissionMode: "plan", ...(tools?.deny?.length ? { tools: { deny: tools.deny } } : {}) };
}

/**
 * HOW-57 (G5): how many times in a row a wait node has been reached after its predecessor
 * reported EXACTLY what it reported the time before — 0 when the latest report is new. The
 * predecessor is whatever routed here last (`edge-taken`), and only its succeeded finishes
 * that were followed by a visit of this wait count as "in a row": anything else in between,
 * or a change in what it published, starts the streak again. Read from the log alone.
 */
export function waitStreak(events: readonly LoggedEvent[], waitNode: string): number {
  const entered = events.findLast((e) => e.type === "edge-taken" && e.to === waitNode);
  if (entered?.type !== "edge-taken") return 0;
  const from = entered.from;
  const finishes = events.filter((e) => e.type === "node-finished" && (e.node === from || e.node === waitNode));
  // newest first: from, wait, from, wait, … — the newest `from` is the report being waited on
  let streak = -1;
  let latest: string | undefined;
  let expectFrom = true;
  for (let i = finishes.length - 1; i >= 0; i--) {
    const e = finishes[i]!;
    if (e.type !== "node-finished") continue;
    if (expectFrom) {
      if (e.node !== from || e.status !== "succeeded") break;
      const writes = stableJson(e.writes);
      if (latest === undefined) latest = writes;
      else if (writes !== latest) break;
      streak++;
      expectFrom = false;
    } else {
      if (e.node !== waitNode) break;
      expectFrom = true;
    }
  }
  return Math.max(0, streak);
}

/** JSON with object keys sorted, so two equal reports compare equal whatever their key order. */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );
}

/** did the run arrive at `node`'s current visit through an operator-jump (not graph routing)? */
function enteredByJump(events: readonly LoggedEvent[], node: string): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "operator-jump") return e.to === node;
    if (e.type === "edge-taken") return false;
  }
  return false;
}

const INPUTS_NODE = "__inputs__";

/**
 * Failures that are never evidence of a spent allowance, whatever the transcript says, so
 * they never hop harnesses and never mark a harness spent (HOW-14, HOW-38).
 */
const NO_HOP_CODES: ReadonlySet<string> = new Set(["context-exhausted", "stuck", "turn-timeout", "paused-by-operator"]);

/**
 * HOW-43: automatic continuations of `node` in the current streak — the context-continued
 * events since its last SUCCEEDED visit or the operator's last jump. Derived from the log, so
 * a resume in a fresh process reaches the same budget state.
 */
export function contextRetriesUsed(events: readonly LoggedEvent[], node: string): number {
  let used = 0;
  for (const e of events) {
    if (e.type === "context-continued" && e.node === node) used++;
    else if (e.type === "node-finished" && e.node === node && e.status === "succeeded") used = 0;
    else if (e.type === "operator-jump") used = 0;
  }
  return used;
}

/**
 * HOW-69: the command built-ins that only READ the forge, and so may be retried when it cannot
 * be reached. `runs:await` is not here because it never throws for that — it already treats an
 * unreachable forge as "not yet" and waits (engine/executors/await.ts).
 */
const FORGE_READ_BUILTINS: ReadonlySet<string> = new Set(["probe:pr"]);
/** HOW-69: the waits before each automatic forge-read retry — 30s, 2m, 5m, then park */
export const FORGE_RETRY_BACKOFF_MS: readonly number[] = [30_000, 120_000, 300_000];

/**
 * HOW-69: automatic forge-read retries of `node` in the current streak — `forge-retried`
 * events since its last SUCCEEDED visit, the operator's last jump, or its last park (a park
 * the operator resumed starts a fresh budget). Derived from the log, like contextRetriesUsed.
 */
export function forgeRetriesUsed(events: readonly LoggedEvent[], node: string): number {
  let used = 0;
  for (const e of events) {
    if (e.type === "forge-retried" && e.node === node) used++;
    else if (e.type === "node-finished" && e.node === node && e.status === "succeeded") used = 0;
    else if (e.type === "attention-raised" && e.node === node) used = 0;
    else if (e.type === "operator-jump") used = 0;
  }
  return used;
}

/** "30s", "2m" — the forge-retry note's wording */
function formatDelay(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`;
}

/** A prompt file's front-matter version (1 when absent — the pre-versioning default). */
function promptVersion(raw: string): number {
  const vm = raw.match(/^version:\s*(\d+)\s*$/m);
  return vm && vm[1] !== undefined ? Number(vm[1]) : 1;
}

export class Engine {
  readonly log: EventLog;
  private readonly graph: Graph<any>;
  private readonly opts: EngineOpts;
  private ctx!: ContextStore<any>;
  private inputs: Record<string, unknown> = {};
  private visits: Record<string, number> = {};
  /**
   * system-map 0.3: per-node maxVisits floor from the latest reset_budgets operator-jump.
   * Only resume() sets it — jumps are refused while a runner is live, so a jump always
   * reaches the engine through replay.
   */
  private floors: Record<string, number> = {};
  private completedEffects = new Set<string>();
  /** rendered_hash per agent node's latest render — outcome attribution joins here */
  private lastRender = new Map<string, string>();
  /** operator-jump instruction awaiting the target node's next attempt */
  private jumpNote: { node: string; message: string } | null = null;
  /**
   * HOW-17: harnesses this run has HOPPED OFF because their allowance ran out. It holds what
   * the log cannot always say: a hop triggered by an attempt that merely READ as rate-limited
   * leaves no allowance event behind. The chain never hands work back to one of these.
   */
  private hoppedAwayFrom = new Set<Harness>();
  /** nodes granted one extra visit for the immediate fallback retry (not charged to maxVisits) */
  private pendingFallbackNodes = new Set<string>();
  /** system-map 0.2: operator reply awaiting the parked node's next attempt */
  private replyNote: { node: string; message: string } | null = null;
  /** system-map 1c review: per pinned includer, the version of each prompt it included */
  private pinnedIncludes: Record<string, Record<string, number>> = {};
  /** system-map 1c: why the node's last proposal was refused, for its next attempt (suffix v3) */
  private refusalNote: { node: string; message: string } | null = null;

  constructor(graph: Graph<any>, opts: EngineOpts) {
    graph.validateOrThrow();
    this.graph = graph;
    this.opts = opts;
    this.log = new EventLog(join(opts.dir, "run.jsonl"), opts.clock);
  }

  // ---- lifecycle -------------------------------------------------------------

  async start(inputs: Record<string, unknown>): Promise<RunState> {
    return this.asRunner(() => this.startOwned(inputs));
  }

  /** Rebuild state from the log, probe ambiguous side effects, continue. */
  async resume(): Promise<RunState> {
    return this.asRunner(() => this.resumeOwned());
  }

  /** hold the run's runner lock for the whole loop; a live holder elsewhere → busy */
  private async asRunner(body: () => Promise<RunState>): Promise<RunState> {
    const busy = claimRunner(this.opts.dir);
    if (busy) return { state: "busy", holder: busy };
    try {
      const result = await body();
      // still holding the lock: a park's attention lands before any other runner can start
      // (and before a decision's wake can clear it), so it never outlives a decided round
      await this.opts.whileHeld?.(result);
      return result;
    } finally {
      releaseRunner(this.opts.dir);
    }
  }

  private async startOwned(inputs: Record<string, unknown>): Promise<RunState> {
    // an approval binds to a git fingerprint: refuse before anything is logged
    if (this.graph.approvalNodes().length > 0 && (await fingerprint(this.workCwd())) === null)
      throw new EngineError(
        `graph "${this.graph.def.name}" has an approval step, which binds the design to a git fingerprint — ` +
          `${this.opts.cwd ?? "(no folder)"} is not a git work tree`,
      );
    this.inputs = inputs;
    const { pinned, includes } = this.pinPrompts();
    this.pinnedIncludes = includes;
    this.log.append({
      type: "run-started",
      graph: this.graph.def.name,
      ...(this.opts.name ? { name: this.opts.name } : {}),
      ...(this.opts.parent ? { parent: this.opts.parent } : {}),
      inputs,
      pinned_prompts: pinned,
      ...(Object.keys(includes).length ? { pinned_includes: includes } : {}),
      cwd: this.opts.cwd,
      folder_kind: this.opts.folderKind,
      overrides: this.opts.overrides,
    });
    this.freshContext();
    this.seedInputs(inputs);
    return this.loop(this.graph.def.entry);
  }

  private async resumeOwned(): Promise<RunState> {
    const replayed = replayState(this.log.read());
    if (!replayed.started) throw new EngineError("resume() before start(): empty log");
    if (replayed.finished) return { state: "finished", outcome: replayed.finished.outcome };

    this.inputs = replayed.started.inputs;
    this.pinnedIncludes = replayed.started.pinned_includes ?? {};
    this.visits = { ...replayed.visits };
    this.floors = { ...replayed.floors };
    this.completedEffects = new Set(replayed.completedEffects);
    this.freshContext();
    this.seedInputs(this.inputs);
    // re-apply every published write in log order — scope semantics replay exactly
    for (const f of replayed.finishes) {
      this.ctx.beginAttempt(f.node, f.visit);
      for (const [k, v] of Object.entries(f.writes)) this.ctx.set(k, v);
      this.ctx.endAttempt(f.status);
    }

    // OV-1: ambiguous executions are probed BEFORE any retry (not-happened: the retry claims it again)
    const ambiguous = await this.probeIntents(replayed.pendingIntents);
    if (ambiguous) return ambiguous;

    // resume() IS the operator action: a standing park is resolved by resuming. Parks whose
    // cause still holds (maxVisits, exhausted conditions) simply re-park deterministically.
    this.jumpNote = replayed.jumpNote;
    if (replayed.paused) this.log.append({ type: "run-resumed", by: "operator" });
    // system-map 0.2: an operator reply may have landed since the replay above (the probes
    // are async). Re-read under the log lock: if it did, the park is already answered and
    // its replyNote is adopted; if not, resume's own resolution goes in atomically — source
    // "resume", bookkeeping that never renders into a prompt.
    let replyNote = replayed.replyNote;
    // system-map 1a (D17) / HOW-3: a park an operator action already answered — a decided
    // approval round, or an ambiguous effect the operator resolved — is closed here too, in
    // case the route that answered it died before resolving it: the log then reads as answered
    this.log.appendIf((events) => {
      const now = replayState(events);
      replyNote = now.replyNote;
      const open = now.parked ?? now.answeredPark;
      return open ? { type: "attention-resolved", node: open.node, visit: open.visit, reply: "resume", source: "resume" } : null;
    });
    this.replyNote = replyNote;
    this.refusalNote = replayed.refusalNote;

    const position = replayed.position ?? { node: this.graph.def.entry, midFlight: false };
    // a mid-flight node re-attempts on the SAME visit number (the attempt never finished)
    if (position.midFlight) this.visits[position.node] = (this.visits[position.node] ?? 1) - 1;
    return this.loop(position.node);
  }

  // ---- the loop --------------------------------------------------------------

  /** HOW-54: the steps whose visits must change the worktree (Graph.progressChecked), computed once */
  private get progressChecked(): Set<string> {
    return (this._progressChecked ??= this.graph.progressChecked());
  }
  private _progressChecked: Set<string> | undefined;

  /** HOW-48: a moot soft stop — pause at the next node boundary (set after the step, read at the loop top) */
  private pauseAtBoundary = false;

  private async loop(startAt: string): Promise<RunState> {
    let current = startAt;
    const maxSteps = this.opts.maxSteps ?? 1000;
    // HOW-57 (G5): a WAIT is time passing, not work — counting it would park a stack that waits
    // days on a reviewer (1000 steps at 5m is ~41h). Every other node still counts, so a
    // loop of real work (or a poll, whose command step is real) still stops at maxSteps.
    let steps = 0;
    for (;;) {
      const def = this.graph.def.nodes[current];
      if (!def) throw new EngineError(`unknown node: ${current}`);
      if (def.kind !== "wait") {
        if (steps >= maxSteps) break;
        steps++;
      }

      const command = this.opts.control?.() ?? null;
      if (command === "abort") {
        this.log.append({ type: "run-finished", outcome: "aborted" });
        this.attributeTerminal("aborted");
        return { state: "finished", outcome: "aborted" };
      }
      // HOW-48: a soft stop the step finished before reaching is not dropped — the run holds at
      // this boundary exactly as a pause would, so "stop" still means stop. Not before a terminal:
      // the run is done, and holding it one step short of finishing would only cost a resume.
      if (command === "pause" || (this.pauseAtBoundary && def.kind !== "terminal")) {
        this.pauseAtBoundary = false;
        this.log.append({ type: "run-paused", by: "operator" });
        return { state: "paused", node: current };
      }

      if (def.kind === "terminal") {
        this.log.append({ type: "run-finished", outcome: def.outcome });
        this.attributeTerminal(def.outcome);
        return { state: "finished", outcome: def.outcome };
      }

      // visit numbers only climb (they are attempt identity); the BUDGET is counted above the
      // floor an operator jump set (system-map 0.3), so a jump buys exactly maxVisits more
      const visit = (this.visits[current] = (this.visits[current] ?? 0) + 1);
      const fallbackVisit = this.pendingFallbackNodes.delete(current);
      const maxVisits = "maxVisits" in def ? def.maxVisits : undefined;
      const floor = this.floors[current] ?? 0;
      // the fallback retry (f8c8d96) is the same attempt on another harness: not charged
      if (maxVisits !== undefined && visit - floor > maxVisits && !fallbackVisit)
        return this.park(
          current,
          visit,
          "max-visits",
          floor > 0
            ? `maxVisits exceeded (${visit - floor} > ${maxVisits} since the operator jump at visit ${floor})`
            : `maxVisits exceeded (${visit} > ${maxVisits})`,
        );

      // system-map 1a: pre-start, like maxVisits — a refusal logs no node-started, consumes no visit
      const gate = await this.requiresGate(current, def, visit);
      if (gate) return this.park(current, visit, gate.code, gate.reason);
      // HOW-41: a tool restriction the resolved harness cannot honour refuses the node — this
      // also catches a fallback hop onto such a harness, because the hop re-resolves first
      const tools = this.toolsGate(current, def);
      if (tools) return this.park(current, visit, "tools-unsupported", tools);

      if (this.opts.beforeNode) await this.opts.beforeNode(current, def);
      const attemptId = `${current}#${visit}`;
      this.log.append({ type: "node-started", node: current, visit, attempt_id: attemptId });
      this.ctx.beginAttempt(current, visit);

      let result: AttemptResult;
      let rounds: ProposalRound[] = [];
      try {
        result = await this.execute(current, def, visit, attemptId);
        if (result.status === "awaiting" && def.kind !== "approval")
          throw new EngineError(`a ${def.kind} executor returned "awaiting" — only approval nodes wait for a decision`);
        if (result.status === "succeeded") {
          const checked = await this.checkProposals(current, visit, result);
          result = checked.result;
          rounds = checked.rounds;
        }
        if (result.status === "succeeded") result = this.seedRedesignFeedback(current, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.ctx.endAttempt("failed");
        // the reason must be readable in the thread, not only in the (resolvable) ask
        this.log.append({ type: "chunk", node: current, visit, turn: 1, index: ENGINE_FAILURE_INDEX, kind: "text", content: `\n[attempt failed: ${message}]` });
        this.log.append({ type: "node-finished", node: current, visit, status: "failed", writes: {} });
        if (def.kind === "command" && FORGE_READ_BUILTINS.has(def.run.trim()) && err instanceof ForgeUnreachableError) {
          const decision = await this.retryForgeRead(current, visit, message);
          if (decision.continue) continue;
          return decision.state;
        }
        return this.park(current, visit, "executor-threw", `executor threw: ${message}`);
      }

      if (result.status === "awaiting") {
        // D4/3A: no node-finished — replay keeps this node mid-flight and resume re-attempts
        // the SAME visit; the failed end restores any cleared keys this attempt veiled
        this.ctx.endAttempt("failed");
        return this.park(current, visit, "awaiting-approval", result.reason ?? "awaiting a decision");
      }
      if (result.reason)
        this.log.append({ type: "chunk", node: current, visit, turn: 1, index: ENGINE_NOTE_INDEX, kind: "text", content: `\n[${result.status}: ${result.reason}]` });

      for (const [k, v] of Object.entries(result.writes)) this.ctx.set(k, v);
      this.ctx.endAttempt(result.status);
      for (const round of rounds) this.openRound(current, round);
      // HOW-54: what the worktree holds now, for the steps whose visits must make progress
      const tree = this.progressChecked.has(current) ? worktreeTree(this.workCwd()) ?? undefined : undefined;
      this.log.append({
        type: "node-finished", node: current, visit, status: result.status, writes: result.writes,
        ...(result.refused !== undefined ? { refused: result.refused } : {}),
        ...(tree !== undefined ? { tree } : {}),
      });
      if (result.status === "succeeded" && tree !== undefined) {
        const stalled = this.noProgress(current, visit, tree);
        if (stalled) return this.park(current, visit, "no-progress", stalled);
      }

      if (result.status === "failed") {
        // HOW-14: a full context window is not an allowance problem, whatever the attempt's
        // text happens to say — hopping would start a fresh harness from nothing and still
        // overflow. Park instead; the retry gets the re-entry briefing.
        // HOW-38: nor is a stuck call or a hung turn — another harness would not unstick it
        const hop = def.kind === "agent" && !NO_HOP_CODES.has(result.code ?? "attempt-failed") ? this.nextFallbackHarness(current, visit) : undefined;
        if (hop) {
          this.hoppedAwayFrom.add(hop.from);
          this.pendingFallbackNodes.add(current);
          this.log.append({
            type: "chunk",
            node: current,
            visit,
            turn: 1,
            index: 10000,
            kind: "text",
            content: `\n[${hop.from} allowance exhausted: retrying this node with ${hop.to}]`,
          });
          continue;
        }
        if (def.kind === "agent" && result.code === "context-exhausted") {
          const decision = await this.continueAfterExhaustion(current, def, visit, result.reason ?? "attempt failed");
          if (decision.continue) continue;
          return decision.state;
        }
        return this.park(current, visit, result.code ?? "attempt-failed", result.reason ?? "attempt failed");
      }

      if (def.kind === "agent" && softStopState(this.log.read(), current, visit)) this.pauseAtBoundary = true;
      const next = this.route(current, visit);
      if (!next) return this.park(current, visit, "no-edge", "no edge matched (conditions exhausted)");
      this.log.append({ type: "edge-taken", from: current, to: next.to, label: next.condition?.label });
      this.attributeVerdict(current, next);
      current = next.to;
    }
    return this.park(current, this.visits[current] ?? 0, "max-steps", `maxSteps reached (${maxSteps})`);
  }

  private async execute(nodeId: string, def: NodeDef<any>, visit: number, attemptId: string): Promise<AttemptResult> {
    const executor = this.opts.executors[def.kind as keyof EngineOpts["executors"]];
    if (!executor) throw new EngineError(`no executor for kind "${def.kind}"`);

    const reads: Record<string, unknown> = {};
    for (const k of nodeReads(def)) reads[k] = this.ctx.get(k, { node: nodeId, visit });

    let renderedPrompt: string | undefined;
    let agentConfig: AgentConfig | undefined;
    if (def.kind === "agent") {
      agentConfig = this.resolveAgentConfig(def, nodeId);
      renderedPrompt = this.renderPrompt(nodeId, def.prompt, visit, reads, Object.keys(def.writes ?? {}), agentConfig);
    }

    const effects: EffectsHandle = {
      claim: (effect) => {
        const key = effectKey(nodeId, effect);
        if (this.completedEffects.has(key)) return true;
        this.log.append({ type: "side-effect-intent", node: nodeId, visit, attempt_id: attemptId, effect });
        return false;
      },
      done: (effect, result) => {
        this.log.append({ type: "side-effect-done", node: nodeId, visit, attempt_id: attemptId, effect, result });
        this.completedEffects.add(effectKey(nodeId, effect));
      },
    };

    return executor({
      nodeId, def, visit, attemptId,
      cwd: this.opts.cwd,
      runId: basename(this.opts.dir),
      log: this.log,
      reads, renderedPrompt, agentConfig, effects,
      ...(def.kind === "wait" && def.backoff?.length ? { waitStreak: waitStreak(this.log.read(), nodeId) } : {}),
    });
  }

  /** HOW-41: why this agent node cannot start on its resolved harness, or null */
  private toolsGate(nodeId: string, def: NodeDef<any>): string | null {
    if (def.kind !== "agent") return null;
    const config = this.resolveAgentConfig(def, nodeId);
    if (!hasTools(config.tools) || !config.harness || !isHarness(config.harness)) return null;
    if (harnessSpec(config.harness).toolFlags) return null;
    const asked = [
      ...(config.tools.allow?.length ? [`allow ${config.tools.allow.join(", ")}`] : []),
      ...(config.tools.deny?.length ? [`deny ${config.tools.deny.join(", ")}`] : []),
    ].join("; ");
    return `"${nodeId}" restricts its tools (${asked}) but ${config.harness} cannot restrict tools, so it would run unrestricted — ` +
      `move the node to a harness that can (claude), or remove the restriction in tuning, then resume`;
  }

  // ---- context exhaustion: continue once before parking (HOW-43) ----------------

  /**
   * A visit filled its context window. Before HOW-43 that always parked, and the human's only
   * move was to press resume — adding no information. Now the engine continues the node itself
   * when every one of these holds, in this order, and parks (saying which one failed) otherwise:
   *   (a) the operator has not asked to pause or abort — their control wins;
   *   (b) no side effect of this attempt is ambiguous — it goes through resume()'s probe, the
   *       same path, so an unknown verdict parks FOR THE EFFECT;
   *   (c) the node's `contextRetries` budget (default 1) is not spent — counted from the log, so
   *       a fresh process reaches the same answer;
   *   (d) a continuation that exhausted again made progress — a new commit or an edited file;
   *       looping on nothing is worse than asking.
   * The continuation is a NORMAL visit (charged to maxVisits — the same harness re-attempting
   * the same work, unlike a fallback hop) rendered with the HOW-36 handoff.
   */
  private async continueAfterExhaustion(
    node: string,
    def: Extract<NodeDef<any>, { kind: "agent" }>,
    visit: number,
    reason: string,
  ): Promise<{ continue: true } | { continue: false; state: RunState }> {
    const park = (why = reason) => ({ continue: false as const, state: this.park(node, visit, "context-exhausted", why) });
    const command = this.opts.control?.() ?? null;
    if (command === "pause" || command === "abort") return park();

    // (b) the same probe resume() runs, over this node's still-ambiguous intents
    const pending = replayState(this.log.read()).pendingIntents.filter((i) => i.node === node);
    const ambiguous = await this.probeIntents(pending);
    if (ambiguous) return { continue: false, state: ambiguous };

    const events = this.log.read();
    const budget = this.resolveAgentConfig(def, node).contextRetries ?? 1;
    const used = contextRetriesUsed(events, node);
    if (used >= budget)
      return park(`${reason} — exhausted context ${used + 1} time${used === 0 ? "" : "s"} in a row; consider splitting this step`);

    const head = (await fingerprint(this.workCwd()).catch(() => null))?.head ?? null;
    const previous = events.findLast((e) => e.type === "context-continued" && e.node === node);
    if (previous?.type === "context-continued" && previous.visit === visit - 1) {
      const handoff = deriveHandoff(events, node, visit, []);
      if (handoff.filesEdited.length === 0 && head === previous.head)
        return park(`${reason} — the automatic continuation exhausted its context again with no new commit and no edited file, so it is not being continued again; consider splitting this step`);
    }

    this.log.append({ type: "context-continued", node, visit, retry: used + 1, budget, head });
    this.log.append({
      type: "chunk", node, visit, turn: 1, index: ENGINE_NOTE_INDEX + 2, kind: "text",
      content: `\n[context window filled — continuing automatically (${used + 1} of ${budget}) on a fresh visit, briefed with what this one had done]`,
    });
    return { continue: true };
  }

  // ---- an unreachable forge on a read-only probe: back off and retry (HOW-69) --------

  /**
   * `probe:pr` threw "forge unreachable" (a GraphQL timeout, in the run that filed HOW-69).
   * That parked, and the operator's only move was to press resume: a network blip asked a human
   * a question with one answer. The probe only READS, so re-running it is free of side effects;
   * the engine now retries it after 30s, 2m and 5m, logging `forge-retried` each time, and
   * parks (exactly as before, saying how many times it tried) once that is spent, or at once if
   * the operator has asked to pause or abort. Each retry is a new visit, like any re-entry.
   * Shaped like continueAfterExhaustion (HOW-43): the budget is counted from the log, so a
   * runner that dies mid-sleep leaves a failed, unparked visit that resume() simply re-attempts.
   */
  private async retryForgeRead(node: string, visit: number, message: string): Promise<{ continue: true } | { continue: false; state: RunState }> {
    const reason = `executor threw: ${message}`;
    const park = (why = reason) => ({ continue: false as const, state: this.park(node, visit, "executor-threw", why) });
    const command = this.opts.control?.() ?? null;
    if (command === "pause" || command === "abort") return park();
    const budget = FORGE_RETRY_BACKOFF_MS.length;
    const used = forgeRetriesUsed(this.log.read(), node);
    const delay = FORGE_RETRY_BACKOFF_MS[used];
    if (delay === undefined) return park(`${reason} — forge unreachable ${used + 1} times in a row`);
    this.log.append({ type: "forge-retried", node, visit, retry: used + 1, budget, delay_ms: delay, reason: message });
    this.log.append({
      type: "chunk", node, visit, turn: 1, index: ENGINE_NOTE_INDEX + 3, kind: "text",
      content: `\n[forge unreachable — retrying automatically in ${formatDelay(delay)} (${used + 1} of ${budget})]`,
    });
    await (this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(delay);
    return { continue: true };
  }

  /**
   * OV-1's probe over ambiguous intents — resume()'s and the automatic continuation's one path.
   * Returns the park for the first intent the probe cannot decide, or null when every one was
   * settled (a `happened` is recorded as done; a `not-happened` is left for the retry to claim).
   */
  private async probeIntents(intents: readonly Extract<LoggedEvent, { type: "side-effect-intent" }>[]): Promise<RunState | null> {
    for (const intent of intents) {
      const verdict = this.opts.probe
        ? await this.opts.probe(intent.node, intent.effect, intent.attempt_id)
        : ("unknown" as const);
      if (verdict === "happened") {
        this.log.append({
          type: "side-effect-done",
          node: intent.node,
          visit: intent.visit,
          attempt_id: intent.attempt_id,
          effect: intent.effect,
          result: { probed: true },
        });
        this.completedEffects.add(effectKey(intent.node, intent.effect));
      } else if (verdict === "unknown") {
        return this.park(intent.node, intent.visit, "ambiguous-effect", `ambiguous side effect "${intent.effect}" — probe could not decide`);
      }
    }
    return null;
  }

  // ---- approval (system-map 1a) -------------------------------------------------

  /** where the run works now: its worktree once one exists, else the run cwd */
  private workCwd(): string | undefined {
    return effectiveCwd(this.log.path, this.opts.cwd);
  }

  /**
   * The `requires` gate (D3/2A, D18). Passes only while the approval node's CURRENT round is
   * approved for the proposal and base now in context, and — on the first attempt of this
   * node after that approval — the live worktree still matches the fingerprint recorded for
   * the APPROVED ROUND (ghost-proposed). Later attempts after the same approval are exempt,
   * including a re-attempt of a first attempt that died mid-flight: every one of them started
   * after the approval, and the node's own changes are what the approval authorised. A
   * fingerprint that cannot be computed parks stale-base — never a pass.
   */
  private async requiresGate(nodeId: string, def: NodeDef<any>, visit: number): Promise<{ code: ParkCode; reason: string } | null> {
    if (def.kind !== "agent") return null;
    if (def.requiresAcceptance) {
      const unmet = this.acceptanceGate(nodeId, visit);
      if (unmet) return unmet;
    }
    if (!def.requires) return null;
    const approvalId = def.requires.approvalOf;
    const approval = this.graph.def.nodes[approvalId];
    if (!approval || approval.kind !== "approval") throw new EngineError(`"${nodeId}" requires unknown approval node "${approvalId}"`);
    const missing = (why: string) => ({ code: "approval-missing" as const, reason: `"${nodeId}" requires an approval from "${approvalId}": ${why}` });

    const events = this.log.read();
    const round = currentProposal(events, approvalId);
    if (!round) return missing("nothing has been proposed yet");
    const decision = findDecision(events, round.proposal_id);
    if (!decision) return missing(`proposal #${round.proposal_id} is undecided`);
    if (decision.type !== "slice-approved") return missing(`proposal #${round.proposal_id} was sent back with feedback, not approved`);

    const reader = { node: `${nodeId}(requires)`, visit };
    let proposal: unknown;
    let base: ReturnType<typeof readBase>;
    try {
      if (!this.ctx.has(approval.proposal) || !this.ctx.has(approval.base))
        return missing(`"${approval.proposal}" / "${approval.base}" are not readable in context`);
      proposal = this.ctx.get(approval.proposal, reader);
      base = readBase(this.ctx.get(approval.base, reader), approval.base);
    } catch (err) {
      return missing(err instanceof Error ? err.message : String(err));
    }
    if (!isApproved(events, proposal, base.manifest_hash, approvalId))
      return missing(`the approval of proposal #${round.proposal_id} does not match the proposal and base now in context`);

    const firstAttempt = !events.some((e) => e.type === "node-started" && e.node === nodeId && e.seq > decision.seq);
    if (firstAttempt) {
      const stale = (why: string) => ({ code: "stale-base" as const, reason: `the worktree changed since proposal #${round.proposal_id} was approved: ${why}` });
      if (!round.fingerprint) return stale("the approved round recorded no fingerprint to compare against");
      let live: Fingerprint | null;
      try {
        live = await fingerprint(this.workCwd());
      } catch (err) {
        return { code: "stale-base", reason: `cannot verify the worktree against approved proposal #${round.proposal_id}: ${err instanceof Error ? err.message : String(err)}` };
      }
      const moved = describeFingerprintChange(round.fingerprint, live);
      if (moved) return stale(moved);
    }
    return null;
  }

  /**
   * HOW-54: a step on a cycle that is expected to change files finished with the worktree exactly
   * as its previous visit left it. The review → repair loop would go round again on the same code
   * for the same verdict, spending a visit and an allowance on nothing, until maxVisits parked it
   * with a generic reason — so it parks NOW, saying why and quoting the findings it was answering.
   * Decided from the trees on the log's node-finished events, so a fresh process replaying the
   * same log decides the same way. A first visit has nothing to compare with.
   *
   * Out of scope, by construction: changes outside this worktree (another repo, a tracker, a PR
   * comment) are invisible to a tree id — a repair that only did those reads as no progress.
   */
  private noProgress(node: string, visit: number, tree: string): string | null {
    const previous = previousTree(this.log.read(), node, visit);
    if (!previous || previous.tree !== tree) return null;
    let findings = "";
    try {
      if (this.ctx.has("review_findings")) {
        const f = this.ctx.get("review_findings", { node: `${node}(no-progress)`, visit });
        const text = typeof f === "string" ? f : JSON.stringify(f);
        if (text && text !== "[]") findings = ` The findings it was answering: ${text.length > 600 ? `${text.slice(0, 597)}…` : text}`;
      }
    } catch { /* unreadable: the park still says what happened */ }
    return `${node}@${visit} changed nothing in the worktree since visit ${previous.visit} — another review would judge the same code.${findings}`;
  }

  /**
   * HOW-51: the acceptance gate. Every live criterion must pass, or have been WAIVED by an
   * operator decision event — never a flag, and never `attention-resolved`: resume() resolves
   * every standing park, so a gate that trusted it would let any resume through. A plain resume
   * therefore re-checks here and parks again until the contract is met or waived.
   */
  private acceptanceGate(nodeId: string, visit: number): { code: ParkCode; reason: string } | null {
    const unmet = (why: string) => ({ code: "acceptance-unmet" as const, reason: `"${nodeId}" requires the acceptance criteria to be met: ${why}` });
    if (!this.ctx.has(ACCEPTANCE_KEY)) return unmet("no acceptance criteria were recorded");
    let rows: AcceptanceRow[] | null;
    try {
      rows = asAcceptance(this.ctx.get(ACCEPTANCE_KEY, { node: `${nodeId}(requires)`, visit }));
    } catch (err) {
      return unmet(err instanceof Error ? err.message : String(err));
    }
    if (!rows) return unmet(`"${ACCEPTANCE_KEY}" is not a list of criteria`);
    const events = this.log.read();
    const left = unmetCriteria(rows, waivedCriteria(events));
    if (left.length === 0) return null;
    const short = (r: AcceptanceRow) => `"${r.id}" (${r.text.length > 80 ? `${r.text.slice(0, 77)}…` : r.text})`;
    // HOW-59: say which rows THIS run could never prove, and why, before the ones that are
    // merely not met yet — the first kind is settled by one waiver, not by another review
    const sources = evidenceSources(events);
    const cannot = left.flatMap((r) => { const why = unprovable(r, sources); return why ? [{ r, why }] : []; });
    const open = left.filter((r) => !cannot.some((c) => c.r === r));
    const parts: string[] = [];
    if (cannot.length)
      parts.push(
        `${cannot.length} this run cannot prove — ${cannot.map((c) => `${short(c.r)}: ${c.why}`).join("; ")}. ` +
          `Waive them together with \`howdah waive ${basename(this.opts.dir)} --unprovable "<reason>"\` (or "Waive all unprovable" on the Acceptance card), or configure the missing evidence and jump back to the review`,
      );
    if (open.length)
      parts.push(`${open.length} not met yet — ${open.map(short).join("; ")}. Jump back to the review once met, or waive one that cannot be checked`);
    return unmet(`${left.length} unmet. ${parts.join(". ")}.`);
  }

  /**
   * approval nodes whose proposal key this node just wrote, validated by the graph's hook,
   * with the base and live fingerprint the round binds to. Runs inside the attempt, so a
   * malformed base or a fingerprint failure fails the proposer attempt (parks) instead of
   * opening a round nobody can verify.
   */
  private async checkProposals(nodeId: string, visit: number, result: AttemptResult): Promise<{ result: AttemptResult; rounds: ProposalRound[] }> {
    const rounds: ProposalRound[] = [];
    for (const [approvalId, approval] of this.graph.approvalNodes()) {
      if (!(approval.proposal in result.writes)) continue;
      const proposal = result.writes[approval.proposal];
      // the base the round binds to: readable at the proposer's exit on any legal graph
      const baseValue = this.ctx.has(approval.base) ? this.ctx.get(approval.base, { node: nodeId, visit }) : undefined;
      const refusal = this.graph.def.validateProposal?.(proposal, approvalId, { dir: this.opts.dir, base: baseValue, cwd: this.workCwd() }) ?? null;
      if (refusal !== null)
        return { result: { status: "failed", writes: {}, reason: `proposal for "${approvalId}" refused: ${refusal}`, refused: refusal }, rounds: [] };
      const base = baseValue === undefined ? null : readBase(baseValue, approval.base);
      const live = await fingerprint(this.workCwd());
      if (live === null) throw new EngineError(`a proposal round binds to a git fingerprint, and ${this.workCwd() ?? "(no folder)"} is not a git work tree`);
      rounds.push({ approvalId, approval, proposal, manifestHash: base?.manifest_hash ?? null, fingerprint: live });
    }
    return { result, rounds };
  }

  /** D15: open a proposal round — proposal_id is this event's own seq, under the log lock */
  private openRound(nodeId: string, round: ProposalRound): void {
    const stamped = this.log.appendIf((events) => ({
      type: "ghost-proposed",
      node: nodeId,
      approval: round.approvalId,
      proposal_id: nextSeq(events),
      proposal_hash: proposalHash(round.proposal),
      manifest_hash: round.manifestHash,
      fingerprint: round.fingerprint,
      proposal: round.proposal,
    }));
    if (!stamped || stamped.type !== "ghost-proposed" || stamped.proposal_id !== stamped.seq)
      throw new EngineError(`ghost-proposed was stamped seq ${stamped?.seq} but carries a different proposal_id`);
  }

  /**
   * D22: the redesignTo node's success publishes the approval's feedback key (engine-owned
   * there — core/graph.ts writesOf):
   *   - the unconsumed redesign messages, when there are any;
   *   - [] when the key was never published (the proposer's first read), or when this visit
   *     was entered by an operator JUMP (a plain `jump` restarts the design conversation — the
   *     proposer must not re-read comments from a round the operator walked away from);
   *   - otherwise NOTHING, so feedback the graph routes through this node
   *     (approve → extract → propose) is not wiped.
   */
  private seedRedesignFeedback(nodeId: string, result: AttemptResult): AttemptResult {
    let writes = result.writes;
    for (const [approvalId, approval] of this.graph.approvalNodes()) {
      if (approval.redesignTo !== nodeId) continue;
      const events = this.log.read();
      const pending = pendingRedesigns(events, approvalId, nodeId, approval.feedback);
      if (pending.length > 0 || !this.ctx.has(approval.feedback) || enteredByJump(events, nodeId))
        writes = { ...writes, [approval.feedback]: pending };
    }
    return writes === result.writes ? result : { ...result, writes };
  }

  private route(from: string, visit: number): EdgeDef<any> | null {
    const outgoing = this.graph.def.edges.filter((e) => e.from === from);
    let best: EdgeDef<any> | null = null;
    let bestWeight = -Infinity;
    let fallback: EdgeDef<any> | null = null;
    for (const e of outgoing) {
      if (!e.condition) {
        fallback = e;
        continue;
      }
      const values: Record<string, unknown> = {};
      for (const k of e.condition.reads) values[k] = this.ctx.get(k, { node: `${from}(condition)`, visit });
      if (e.condition.test(values as never) && (e.weight ?? 0) > bestWeight) {
        best = e;
        bestWeight = e.weight ?? 0;
      }
    }
    return best ?? fallback;
  }

  // ---- prompts (pinning + rendering) ------------------------------------------

  private pinDir(): string {
    return join(this.opts.dir, "prompts");
  }

  /**
   * Pin every consumed prompt (OV-2). `{{> id }}` includes are expanded HERE (system-map 1c
   * review): the pinned file holds the text the run renders, so rendered_hash and
   * reconstruction never see an include; a prompt with no include is copied byte for byte.
   * EVERY prompt is read and expanded before anything is written — a broken include refuses the
   * start without leaving a half-pinned run dir behind. Returns the pinned versions and, per
   * includer, the version of every prompt it included (the include closure).
   */
  private pinPrompts(): { pinned: Partial<Record<PromptId, number>>; includes: Record<string, Record<string, number>> } {
    const dirs = this.opts.promptsDir === undefined
      ? [join(import.meta.dir, "..", "prompts")]
      : Array.isArray(this.opts.promptsDir) ? this.opts.promptsDir : [this.opts.promptsDir];
    const rawOf = promptReader(dirs);
    const plans: Array<{ id: PromptId; pinned: string; version: number; includes: Record<string, number> }> = [];
    for (const node of Object.values(this.graph.def.nodes)) {
      if (node.kind !== "agent" || plans.some((p) => p.id === node.prompt)) continue;
      const { raw, pinned, included } = pinnableText(node.prompt, rawOf);
      plans.push({
        id: node.prompt,
        pinned,
        version: promptVersion(raw),
        includes: Object.fromEntries(included.map((id) => [id, promptVersion(rawOf(id))])),
      });
    }
    mkdirSync(this.pinDir(), { recursive: true });
    const pinned: Partial<Record<PromptId, number>> = {};
    const includes: Record<string, Record<string, number>> = {};
    for (const plan of plans) {
      const dest = join(this.pinDir(), `${plan.id}.md`);
      if (!existsSync(dest)) writeFileSync(dest, plan.pinned);
      pinned[plan.id] = promptVersion(readFileSync(dest, "utf8"));
      if (Object.keys(plan.includes).length) includes[plan.id] = plan.includes;
    }
    return { pinned, includes };
  }

  private resolveAgentConfig(def: Extract<NodeDef<any>, { kind: "agent" }>, nodeId: string): AgentConfig {
    const resolved = resolveAgentConfig(this.graph, def, nodeId, {
      overrides: this.opts.overrides,
      tuning: this.opts.tuning,
      fallbackHarness: this.forcedFallbackHarness(),
      defaultHarness: this.opts.harnesses?.default,
    });
    // HOW-39: the diagnostics hook needs all three — a node that asked, a harness that can, and
    // a workspace command. Any one missing is no hook and no error.
    if (!resolved.diagnostics || resolved.permissionMode === "plan" || !resolved.harness || !isHarness(resolved.harness)) return resolved;
    if (!harnessSpec(resolved.harness).editHooks || !this.opts.cwd) return resolved;
    const command = this.opts.diagnosticsCommandFor?.(this.opts.cwd);
    return command ? { ...resolved, diagnosticsCommand: command } : resolved;
  }

  /**
   * HOW-17: the harness EVERY subsequent node is forced onto once this run has run out of
   * allowance somewhere (it replaces shouldForceCodexFallback, which could only answer
   * whether — a boolean cannot express a three-harness chain). Returns which harness, so the
   * layer handed to resolveAgentConfig is no longer codex-shaped.
   */
  private forcedFallbackHarness(): Harness | undefined {
    const spent = this.spentHarnesses(this.log.read());
    // WHICH spent harness we hand off from does not change the answer — the chain skips every
    // one of them — so any member will do as the `from` the chain is asked about
    const [anySpent] = spent;
    return anySpent === undefined ? undefined : this.hopFrom(anySpent, spent);
  }

  /** the first harness in the chain that this run has not already spent */
  private hopFrom(from: Harness, spent: ReadonlySet<Harness>): Harness | undefined {
    return fallbackChain({ from, tried: [...spent], exhausted: (h) => spent.has(h), configured: this.opts.harnesses?.fallbackChain });
  }

  /**
   * HOW-17: the next harness to retry THIS failed attempt on, with the one it ran on — or
   * undefined when the attempt did not fail for allowance, or the chain has nowhere left to
   * go. It replaces shouldFallbackToCodex, and it is keyed off the attempt's OWN
   * prompt-rendered harness (not a guess at what the node declares), so the chain never
   * re-tries a harness it has already spent. The retry stays a fresh visit that is NOT
   * charged to maxVisits, exactly as the codex fallback always was.
   */
  private nextFallbackHarness(node: string, visit: number): { from: Harness; to: Harness } | undefined {
    const events = this.log.read();
    const from = this.renderedHarness(events, node, visit);
    if (!from) return undefined;
    const limited = this.latestAllowanceState(events, from) === "exhausted" || this.attemptLooksRateLimited(events, node, visit);
    if (!limited) return undefined;
    const spent = this.spentHarnesses(events);
    spent.add(from);
    const to = this.hopFrom(from, spent);
    return to ? { from, to } : undefined;
  }

  /** the harness an attempt actually ran on, per its own prompt-rendered */
  private renderedHarness(events: readonly LoggedEvent[], node: string, visit: number): Harness | undefined {
    const rendered = events.filter((e) => e.type === "prompt-rendered" && e.node === node && e.visit === visit).at(-1);
    if (!rendered || rendered.type !== "prompt-rendered") return undefined;
    return rendered.harness ?? defaultHarness(this.opts.harnesses?.default);
  }

  /**
   * Every harness this run has run out on: one it already hopped off, one the log says is
   * exhausted, and one whose failed attempt READ as rate-limited (the harness may die before
   * it emits an allowance event, which is why the text is evidence too). Derived from the
   * log, so it survives a resume in another process.
   */
  private spentHarnesses(events: readonly LoggedEvent[]): Set<Harness> {
    // a harness-pinned event is a line: the operator took the run back, so only spend
    // after that line can force it off again. Hops this process already made are the
    // same evidence, and the pin cancels them too.
    const sincePin = eventsSinceHarnessPin(events);
    const spent = new Set<Harness>();
    if (sincePin === events) for (const h of this.hoppedAwayFrom) spent.add(h);
    events = sincePin;
    for (const h of harnessNames()) if (this.latestAllowanceState(events, h) === "exhausted") spent.add(h);
    for (const h of this.priorLimitFailureHarnesses(events)) spent.add(h);
    return spent;
  }

  private latestAllowanceState(
    events: readonly LoggedEvent[],
    harness: Harness,
  ): "ok" | "exhausted" | "unreachable" | "unavailable" | undefined {
    const event = events.filter((e) => e.type === "allowance" && e.harness === harness).at(-1);
    return event?.type === "allowance" ? event.state : undefined;
  }

  private attemptLooksRateLimited(events: readonly LoggedEvent[], node: string, visit: number): boolean {
    const text = events
      .filter((e) => e.type === "chunk" && e.node === node && e.visit === visit)
      .map((e) => e.type === "chunk" ? e.content : "")
      .join("\n");
    return RATE_LIMIT_TEXT.test(text);
  }

  /**
   * HOW-14: the `node\0visit` of every attempt that parked `context-exhausted`. Such an
   * attempt is never evidence of a spent harness, whatever its transcript says — the agent's
   * own text may well mention a "rate limit" it was writing code about.
   */
  private contextExhaustedAttempts(events: readonly LoggedEvent[]): Set<string> {
    // HOW-43: an exhaustion the engine continued itself raised no park, but it is one all the same
    const out = this.parkedAttempts(events, new Set(["context-exhausted"]));
    for (const e of events) if (e.type === "context-continued") out.add(`${e.node}\0${e.visit}`);
    return out;
  }

  /** the `node\0visit` of every attempt that parked with one of `codes` */
  private parkedAttempts(events: readonly LoggedEvent[], codes: ReadonlySet<string>): Set<string> {
    return new Set(events
      .filter((e) => e.type === "attention-raised" && e.code !== undefined && codes.has(e.code))
      .map((e) => e.type === "attention-raised" ? `${e.node}\0${e.visit}` : ""));
  }

  /**
   * HOW-14: the visit whose context window filled, when THIS render of the node is its
   * re-entry — i.e. the node's most recent FINISHED visit before this one failed and parked
   * `context-exhausted`. Read from the log rather than remembered, so a resume in a fresh
   * process briefs the retry exactly as this one would have; a visit that succeeded since
   * (or failed for any other reason) ends the briefing.
   */
  private reentryAfterVisit(events: readonly LoggedEvent[], node: string, visit: number): number | undefined {
    const last = events
      .filter((e): e is Extract<LoggedEvent, { type: "node-finished" }> => e.type === "node-finished" && e.node === node && e.visit < visit)
      .at(-1);
    if (!last || last.status !== "failed") return undefined;
    return this.contextExhaustedAttempts(events).has(`${node}\0${last.visit}`) ? last.visit : undefined;
  }

  /**
   * The harnesses a FAILED attempt of this run read as rate-limited on. This is what carries
   * a hop across a resume: the hop itself is in-memory, but the attempt that caused it is in
   * the log, and a fresh process must reach the same conclusion. (HOW-17 generalised it from
   * hasPriorClaudeLimitFailure — the same read, over every harness rather than claude.)
   */
  private priorLimitFailureHarnesses(events: readonly LoggedEvent[]): Harness[] {
    const failed = new Set(events
      .filter((e) => e.type === "node-finished" && e.status === "failed")
      .map((e) => e.type === "node-finished" ? `${e.node}\0${e.visit}` : ""));
    // HOW-14/HOW-38: an exhausted, stuck or timed-out attempt is never a rate-limit witness
    for (const k of this.parkedAttempts(events, NO_HOP_CODES)) failed.delete(k);
    for (const k of this.contextExhaustedAttempts(events)) failed.delete(k);
    const out = new Set<Harness>();
    for (const e of events) {
      if (e.type !== "prompt-rendered") continue;
      const harness = e.harness ?? defaultHarness(this.opts.harnesses?.default);
      if (out.has(harness) || !failed.has(`${e.node}\0${e.visit}`)) continue;
      if (this.attemptLooksRateLimited(events, e.node, e.visit)) out.add(harness);
    }
    return [...out];
  }

  private renderPrompt(
    nodeId: string,
    prompt: PromptId,
    visit: number,
    reads: Record<string, unknown>,
    outputKeys: string[],
    config?: AgentConfig,
  ): string {
    const raw = readFileSync(join(this.pinDir(), `${prompt}.md`), "utf8");
    const { frontmatter, body } = splitFrontMatter(raw);
    const version = Number(frontmatter?.match(/^version:\s*(\d+)\s*$/m)?.[1] ?? 1);

    let jumpMessage: string | undefined;
    if (this.jumpNote && this.jumpNote.node === nodeId) {
      jumpMessage = this.jumpNote.message;
      this.jumpNote = null; // consumed by this attempt
    }
    let replyMessage: string | undefined;
    if (this.replyNote && this.replyNote.node === nodeId) {
      replyMessage = this.replyNote.message;
      this.replyNote = null; // consumed by this attempt (replay: at node-started)
    }
    let refusalMessage: string | undefined;
    if (this.refusalNote && this.refusalNote.node === nodeId) {
      refusalMessage = this.refusalNote.message;
      this.refusalNote = null; // consumed by this attempt (replay: at node-started)
    }
    const logged = this.log.read();
    const reentryAfterVisit = this.reentryAfterVisit(logged, nodeId, visit);
    // HOW-47: a steer whose turn ended before another tool call never reached it. The executor
    // that could have delivered it has returned by now, so it is carried into THIS render —
    // the run's next agent prompt — and its seq is logged so reconstruction reads the same text
    const carried = undeliveredSteers(logged);
    // HOW-48: the previous visit stopped where the operator asked — brief this one from its words
    const stopResume = stopResumeFor(logged, nodeId, visit);
    // HOW-36: what that visit had done, derived from the log — reconstruction re-derives it
    const handoff = reentryAfterVisit === undefined ? undefined : deriveHandoff(logged, nodeId, reentryAfterVisit, outputKeys);
    // HOW-37: render rules v2 — an oversized value is elided around a stub naming where the
    // whole of it lives; the run's own inputs (the operator's words) are never elided
    const contextCap = config?.contextCap ?? DEFAULT_CONTEXT_CAP;
    const priorEvents = logged;
    const { text: rendered, read: contextRead, elided } = renderTemplate(
      body,
      (key) => (key in reads ? reads[key] : this.ctx.get(key, { node: nodeId, visit })),
      { version: RENDER_VERSION, cap: contextCap, exempt: new Set(this.graph.def.inputs), sourceOf: (key) => this.valueSource(priorEvents, key) },
    );
    // HOW-57 (G8): a stacked run's every agent step judges only its own range
    const stackedOn = this.stackedOn(nodeId, visit);
    // a review of repairs judges only the repairs' range (core/graph.ts reviewsWorkOf)
    const def = this.graph.def.nodes[nodeId];
    const reviewed = def?.kind === "agent" ? def.reviewsWorkOf : undefined;
    const scope = reviewed && reviewed.length > 0 ? repairScope(logged, nodeId, reviewed) : undefined;
    // system-map 0.1: every suffix goes in BEFORE hashing, so the hash covers what is sent
    const skills = skillsForHarness(config?.harness, config?.skills);
    const finalRendered = assemblePrompt({
      body: rendered,
      ...(stackedOn ? { stackedOn } : {}),
      ...(scope ? { repairScope: scope } : {}),
      jumpMessage,
      replyMessage,
      refusalMessage,
      reentryAfterVisit,
      ...(handoff ? { handoff } : {}),
      steerMessages: carried.map((c) => c.text),
      stopResumeMessage: stopResume?.last_message,
      skills,
      outputKeys,
      suffixVersion: SUFFIX_VERSION,
    });
    const hash = renderedHash(finalRendered);
    this.lastRender.set(nodeId, hash);
    this.log.append({
      type: "prompt-rendered",
      node: nodeId,
      visit,
      prompt,
      prompt_version: version,
      rendered_hash: hash,
      context_read: contextRead,
      harness: config?.harness,
      model: config?.model,
      effort: config?.effort,
      ...(config?.effortInert !== undefined ? { effort_inert: config.effortInert } : {}),
      ...(hasTools(config?.tools) ? { tools: config!.tools } : {}),
      ...(config?.diagnosticsCommand !== undefined ? { diagnostics_command: config.diagnosticsCommand } : {}),
      skills,
      output_keys: outputKeys,
      suffix_version: SUFFIX_VERSION,
      ...(this.pinnedIncludes[prompt] ? { includes: this.pinnedIncludes[prompt] } : {}),
      ...(reentryAfterVisit !== undefined ? { reentry_after_visit: reentryAfterVisit } : {}),
      render_version: RENDER_VERSION,
      context_cap: contextCap,
      ...(Object.keys(elided).length ? { context_sources: elided } : {}),
      ...(carried.length ? { steers_carried: carried.map((c) => c.seq) } : {}),
      ...(stopResume ? { resumed_after_stop: stopResume.seq } : {}),
      ...(stackedOn ? { stacked_on: stackedOn } : {}),
      ...(scope ? { repair_scope: scope } : {}),
    });
    return finalRendered;
  }

  /**
   * HOW-57 (G8): what this run's branch is stacked on — `deps.base` @ `deps.base_tip`, when the
   * graph publishes them and both are non-empty. A graph that never writes them (every graph but
   * implement-stacked) is never stacked; neither is a run whose base merged and was replayed
   * onto the default branch (`git:restack` publishes "" then).
   */
  private stackedOn(nodeId: string, visit: number): { branch: string; sha: string } | undefined {
    const reader = { node: `${nodeId}(stacked)`, visit };
    try {
      if (!this.ctx.has("deps.base") || !this.ctx.has("deps.base_tip")) return undefined;
      const branch = this.ctx.get("deps.base", reader);
      const sha = this.ctx.get("deps.base_tip", reader);
      return typeof branch === "string" && branch !== "" && typeof sha === "string" && sha !== "" ? { branch, sha } : undefined;
    } catch {
      return undefined; // unreadable here (veiled mid-attempt): not stacked, rather than a crash
    }
  }

  /**
   * HOW-37: where the whole value of `key` is, for an elision stub — the latest SUCCEEDED
   * attempt that published it, and the log it is recorded in. Derived from the log, so it is
   * the same sentence however often the node is rendered, and it is logged with the render.
   */
  private valueSource(events: readonly LoggedEvent[], key: string): string {
    const writer = events.findLast((e) => e.type === "node-finished" && e.status === "succeeded" && key in e.writes);
    const where = writer?.type === "node-finished" ? `the output of ${writer.node}@${writer.visit}` : `the value of ${key}`;
    return `${where}, recorded in full in ${this.log.path}`;
  }

  // ---- attribution (A5.3) ------------------------------------------------------

  private attributeVerdict(node: string, edge: EdgeDef<any>): void {
    const hash = this.lastRender.get(node);
    if (!hash || !edge.condition) return;
    const visit = this.visits[node] ?? 1;
    this.log.append({ type: "prompt-outcome", rendered_hash: hash, node, visit, verdict_downstream: edge.condition.label });
  }

  private attributeTerminal(outcome: "success" | "failed" | "aborted"): void {
    for (const [node, hash] of this.lastRender)
      this.log.append({ type: "prompt-outcome", rendered_hash: hash, node, visit: this.visits[node] ?? 1, terminal_outcome: outcome });
  }

  // ---- plumbing ----------------------------------------------------------------

  private freshContext(): void {
    const declared = this.graph.declarations() as Record<string, { scope: Scope; writer: string[] }>;
    for (const k of this.graph.def.inputs) {
      const existing = declared[k];
      if (existing) existing.writer.push(INPUTS_NODE);
      else declared[k] = { scope: "sticky", writer: [INPUTS_NODE] };
    }
    this.ctx = new ContextStore(declared);
  }

  private seedInputs(inputs: Record<string, unknown>): void {
    this.ctx.beginAttempt(INPUTS_NODE, 0);
    for (const k of this.graph.def.inputs) {
      if (!(k in inputs)) throw new EngineError(`missing run input: ${k}`);
      this.ctx.set(k, inputs[k]);
    }
    this.ctx.endAttempt("succeeded");
  }

  private park(node: string, visit: number, code: ParkCode, reason: string): RunState {
    this.log.append({ type: "attention-raised", node, visit, reason, code });
    return { state: "parked", node, reason, code };
  }
}
