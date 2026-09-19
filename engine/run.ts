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
 * Approval (system-map 1a):
 *   - Proposal rounds (D15): when a node's successful write lands on an approval node's
 *     `proposal` key, the graph's validateProposal hook checks it (a refusal fails the
 *     attempt with the validator's message), then `ghost-proposed` is appended BEFORE that
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
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nodeReads, resolveAgentConfigLayers, type Graph, type NodeDef, type EdgeDef, type AgentConfig, type ApprovalNodeDef, type Harness } from "../core/graph";
import { basename } from "node:path";
import { ContextStore, type Scope } from "../core/context";
import { SUFFIX_VERSION, assemblePrompt, renderTemplate, renderedHash, skillsForHarness, splitFrontMatter } from "../core/template";
import { EventLog } from "../log/write";
import type { LoggedEvent, ParkCode } from "../log/events";
import { replayState, effectKey } from "./replay";
import type { PromptId } from "../core/prompt-ids";
import { proposalHash } from "../core/proposal";
import { describeFingerprintChange, fingerprint, type Fingerprint } from "./reconcile";
import { effectiveCwd } from "./executors/worktree";
import { currentProposal, findDecision, isApproved, nextSeq, pendingRedesigns, readBase } from "./slice-decision";
import { claimRunner, releaseRunner, type RunnerHolder } from "./control";

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
}

export interface AttemptResult {
  /** "awaiting" (approval nodes only, system-map 1a): undecided — park without finishing */
  status: "succeeded" | "failed" | "awaiting";
  writes: Record<string, unknown>;
  /** why: the park reason for failed/awaiting, a thread note for a succeeded stale outcome */
  reason?: string;
}

export type Executor = (args: ExecArgs) => Promise<AttemptResult>;

export type ProbeVerdict = "happened" | "not-happened" | "unknown";

export interface EngineOpts {
  /** run directory: run.jsonl + pinned prompts/ live here */
  dir: string;
  executors: Partial<Record<"agent" | "command" | "worktree" | "wait" | "approval", Executor>>;
  /** source prompt dir to pin from (defaults to repo prompts/) */
  promptsDir?: string;
  /** resolve an ambiguous side effect on resume: did it actually happen? */
  probe?: (node: string, effect: string, attemptId: string) => Promise<ProbeVerdict>;
  /** loop guard — perpetual graphs park here instead of spinning forever */
  maxSteps?: number;
  clock?: () => Date;
  /** where the run works (worktree or plain folder) — stamped on run-started */
  cwd?: string;
  folderKind?: "repo" | "plain";
  /** runs before every non-terminal node — the reconciler's seat (A6.1) */
  beforeNode?: (nodeId: string, def: NodeDef<any>) => Promise<void>;
  /** run-level agent overrides — beat node settings, which beat graph defaults */
  overrides?: AgentConfig;
  /** UI tuning overlay: per-node beats TS node; graph-level beats TS defaults */
  tuning?: { defaults?: AgentConfig; nodes?: Record<string, AgentConfig> };
  /** operator control, read at every node boundary — pause/abort land between attempts */
  control?: () => "pause" | "abort" | null;
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
 * one that fits the resolved harness; claude runs in auto). On top of it:
 *   - `fallbackHarness` is the engine's Claude→Codex fallback (f8c8d96): it outranks every
 *     layer, because the run has observed Claude's allowance is gone;
 *   - `readOnly` (system-map 1a, D6/5A) is a hard constraint applied LAST: no layer, and no
 *     fallback, can raise it above "plan" (the codex executor maps plan to its read-only
 *     sandbox, so a readOnly node stays read-only after a fallback to codex).
 */
export function resolveAgentConfig(
  graph: Graph<any>,
  def: Extract<NodeDef<any>, { kind: "agent" }>,
  nodeId: string,
  layers: { overrides?: AgentConfig; tuning?: EngineOpts["tuning"]; fallbackHarness?: Harness } = {},
): AgentConfig {
  const node: AgentConfig = {
    harness: def.harness, model: def.model, effort: def.effort,
    permissionMode: def.permissionMode, maxTurns: def.maxTurns, skills: def.skills,
  };
  const resolved = resolveAgentConfigLayers([
    layers.fallbackHarness ? { harness: layers.fallbackHarness } : undefined,
    layers.overrides,
    layers.tuning?.nodes?.[nodeId],
    node,
    layers.tuning?.defaults,
    graph.def.defaults,
  ]);
  // system-map 1a (D6/5A): a hard constraint — no layer above the node can raise it
  return def.readOnly ? { ...resolved, permissionMode: "plan" } : resolved;
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
  /** set when Claude fails in a way that should move the rest of this run to Codex */
  private codexFallbackAfterClaudeLimit = false;
  /** nodes granted one extra visit for the immediate Claude→Codex fallback retry */
  private pendingCodexFallbackNodes = new Set<string>();
  /** system-map 0.2: operator reply awaiting the parked node's next attempt */
  private replyNote: { node: string; message: string } | null = null;

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
    const pinned = this.pinPrompts();
    this.log.append({
      type: "run-started",
      graph: this.graph.def.name,
      inputs,
      pinned_prompts: pinned,
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

    // OV-1: ambiguous executions are probed BEFORE any retry
    for (const intent of replayed.pendingIntents) {
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
      // not-happened: nothing recorded; the retry will claim() it again
    }

    // resume() IS the operator action: a standing park is resolved by resuming. Parks whose
    // cause still holds (maxVisits, exhausted conditions) simply re-park deterministically.
    this.jumpNote = replayed.jumpNote;
    if (replayed.paused) this.log.append({ type: "run-resumed", by: "operator" });
    // system-map 0.2: an operator reply may have landed since the replay above (the probes
    // are async). Re-read under the log lock: if it did, the park is already answered and
    // its replyNote is adopted; if not, resume's own resolution goes in atomically — source
    // "resume", bookkeeping that never renders into a prompt.
    let replyNote = replayed.replyNote;
    // system-map 1a (D17): a decided awaiting-approval park is closed here too, in case the
    // route that decided died before resolving it — the log then reads as answered
    this.log.appendIf((events) => {
      const now = replayState(events);
      replyNote = now.replyNote;
      const open = now.parked ?? now.awaitingDecided;
      return open ? { type: "attention-resolved", node: open.node, visit: open.visit, reply: "resume", source: "resume" } : null;
    });
    this.replyNote = replyNote;

    const position = replayed.position ?? { node: this.graph.def.entry, midFlight: false };
    // a mid-flight node re-attempts on the SAME visit number (the attempt never finished)
    if (position.midFlight) this.visits[position.node] = (this.visits[position.node] ?? 1) - 1;
    return this.loop(position.node);
  }

  // ---- the loop --------------------------------------------------------------

  private async loop(startAt: string): Promise<RunState> {
    let current = startAt;
    const maxSteps = this.opts.maxSteps ?? 1000;
    for (let step = 0; step < maxSteps; step++) {
      const def = this.graph.def.nodes[current];
      if (!def) throw new EngineError(`unknown node: ${current}`);

      const command = this.opts.control?.() ?? null;
      if (command === "abort") {
        this.log.append({ type: "run-finished", outcome: "aborted" });
        this.attributeTerminal("aborted");
        return { state: "finished", outcome: "aborted" };
      }
      if (command === "pause") {
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
      const fallbackVisit = this.pendingCodexFallbackNodes.delete(current);
      const maxVisits = "maxVisits" in def ? def.maxVisits : undefined;
      const floor = this.floors[current] ?? 0;
      // the codex-fallback retry (f8c8d96) is the same attempt on another harness: not charged
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
      this.log.append({ type: "node-finished", node: current, visit, status: result.status, writes: result.writes });

      if (result.status === "failed") {
        const fallback = def.kind === "agent" && this.shouldFallbackToCodex(current, visit);
        if (fallback) {
          this.codexFallbackAfterClaudeLimit = true;
          this.pendingCodexFallbackNodes.add(current);
          this.log.append({
            type: "chunk",
            node: current,
            visit,
            turn: 1,
            index: 10000,
            kind: "text",
            content: "\n[claude allowance exhausted: retrying this node with codex]",
          });
          continue;
        }
        return this.park(current, visit, "attempt-failed", result.reason ?? "attempt failed");
      }

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
    });
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
    if (def.kind !== "agent" || !def.requires) return null;
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
      const refusal = this.graph.def.validateProposal?.(proposal, approvalId) ?? null;
      if (refusal !== null)
        return { result: { status: "failed", writes: {}, reason: `proposal for "${approvalId}" refused: ${refusal}` }, rounds: [] };
      // the base the round binds to: readable at the proposer's exit on any legal graph
      const base = this.ctx.has(approval.base) ? readBase(this.ctx.get(approval.base, { node: nodeId, visit }), approval.base) : null;
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

  private pinPrompts(): Partial<Record<PromptId, number>> {
    const source = this.opts.promptsDir ?? join(import.meta.dir, "..", "prompts");
    mkdirSync(this.pinDir(), { recursive: true });
    const pinned: Partial<Record<PromptId, number>> = {};
    for (const node of Object.values(this.graph.def.nodes)) {
      if (node.kind !== "agent") continue;
      const dest = join(this.pinDir(), `${node.prompt}.md`);
      if (!existsSync(dest)) copyFileSync(join(source, `${node.prompt}.md`), dest);
      const vm = readFileSync(dest, "utf8").match(/^version:\s*(\d+)\s*$/m);
      pinned[node.prompt] = vm && vm[1] !== undefined ? Number(vm[1]) : 1;
    }
    return pinned;
  }

  private resolveAgentConfig(def: Extract<NodeDef<any>, { kind: "agent" }>, nodeId: string): AgentConfig {
    return resolveAgentConfig(this.graph, def, nodeId, {
      overrides: this.opts.overrides,
      tuning: this.opts.tuning,
      fallbackHarness: this.shouldForceCodexFallback() ? "codex" : undefined,
    });
  }

  private shouldForceCodexFallback(): boolean {
    return (this.codexFallbackAfterClaudeLimit || this.latestAllowanceState("claude") === "exhausted" || this.hasPriorClaudeLimitFailure()) &&
      this.latestAllowanceState("codex") !== "exhausted";
  }

  private shouldFallbackToCodex(node: string, visit: number): boolean {
    const rendered = this.log.read()
      .filter((e) => e.type === "prompt-rendered" && e.node === node && e.visit === visit)
      .at(-1);
    if (!rendered || rendered.type !== "prompt-rendered" || rendered.harness !== "claude") return false;
    if (this.latestAllowanceState("codex") === "exhausted") return false;
    return this.latestAllowanceState("claude") === "exhausted" || this.attemptLooksRateLimited(node, visit);
  }

  private latestAllowanceState(harness: "claude" | "codex"): "ok" | "exhausted" | "unreachable" | "unavailable" | undefined {
    const event = this.log.read()
      .filter((e) => e.type === "allowance" && e.harness === harness)
      .at(-1);
    return event?.type === "allowance" ? event.state : undefined;
  }

  private attemptLooksRateLimited(node: string, visit: number): boolean {
    const text = this.log.read()
      .filter((e) => e.type === "chunk" && e.node === node && e.visit === visit)
      .map((e) => e.type === "chunk" ? e.content : "")
      .join("\n");
    return /\b(rate.?limit|usage limit|session limit|quota|allowance|exhausted)\b/i.test(text);
  }

  private hasPriorClaudeLimitFailure(): boolean {
    const events = this.log.read();
    const claudeAttempts = events
      .filter((e) => e.type === "prompt-rendered" && e.harness === "claude")
      .map((e) => e.type === "prompt-rendered" ? `${e.node}\0${e.visit}` : "");
    if (claudeAttempts.length === 0) return false;
    const failed = new Set(events
      .filter((e) => e.type === "node-finished" && e.status === "failed")
      .map((e) => e.type === "node-finished" ? `${e.node}\0${e.visit}` : ""));
    return claudeAttempts.some((key) => {
      if (!failed.has(key)) return false;
      const [node, rawVisit] = key.split("\0");
      return node !== undefined && rawVisit !== undefined && this.attemptLooksRateLimited(node, Number(rawVisit));
    });
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
    const { text: rendered, read: contextRead } = renderTemplate(body, (key) =>
      key in reads ? reads[key] : this.ctx.get(key, { node: nodeId, visit }),
    );
    // system-map 0.1: every suffix goes in BEFORE hashing, so the hash covers what is sent
    const skills = skillsForHarness(config?.harness, config?.skills);
    const finalRendered = assemblePrompt({
      body: rendered,
      jumpMessage,
      replyMessage,
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
      skills,
      output_keys: outputKeys,
      suffix_version: SUFFIX_VERSION,
    });
    return finalRendered;
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
