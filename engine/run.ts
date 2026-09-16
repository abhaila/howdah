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
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentConfigLayers, type Graph, type NodeDef, type EdgeDef, type AgentConfig } from "../core/graph";
import { basename } from "node:path";
import { ContextStore, type Scope } from "../core/context";
import { operatorInstructionSuffix, renderTemplate, renderedHash, splitFrontMatter } from "../core/template";
import { EventLog } from "../log/write";
import { replayState, effectKey } from "./replay";
import type { PromptId } from "../core/prompt-ids";

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
  /** agent nodes: the rendered prompt + its hash (already logged as prompt-rendered) */
  renderedPrompt?: string;
  /** agent nodes: resolved execution config (run override → node → graph default) */
  agentConfig?: AgentConfig;
  effects: EffectsHandle;
}

export interface AttemptResult {
  status: "succeeded" | "failed";
  writes: Record<string, unknown>;
}

export type Executor = (args: ExecArgs) => Promise<AttemptResult>;

export type ProbeVerdict = "happened" | "not-happened" | "unknown";

export interface EngineOpts {
  /** run directory: run.jsonl + pinned prompts/ live here */
  dir: string;
  executors: Partial<Record<"agent" | "command" | "worktree" | "wait", Executor>>;
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
}

export type RunState =
  | { state: "finished"; outcome: "success" | "failed" | "aborted" }
  | { state: "parked"; node: string; reason: string }
  | { state: "paused"; node: string };

export class EngineError extends Error {}

const INPUTS_NODE = "__inputs__";

export class Engine {
  readonly log: EventLog;
  private readonly graph: Graph<any>;
  private readonly opts: EngineOpts;
  private ctx!: ContextStore<any>;
  private inputs: Record<string, unknown> = {};
  private visits: Record<string, number> = {};
  private completedEffects = new Set<string>();
  /** rendered_hash per agent node's latest render — outcome attribution joins here */
  private lastRender = new Map<string, string>();
  /** operator-jump instruction awaiting the target node's next attempt */
  private jumpNote: { node: string; message: string } | null = null;

  constructor(graph: Graph<any>, opts: EngineOpts) {
    graph.validateOrThrow();
    this.graph = graph;
    this.opts = opts;
    this.log = new EventLog(join(opts.dir, "run.jsonl"), opts.clock);
  }

  // ---- lifecycle -------------------------------------------------------------

  async start(inputs: Record<string, unknown>): Promise<RunState> {
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

  /** Rebuild state from the log, probe ambiguous side effects, continue. */
  async resume(): Promise<RunState> {
    const replayed = replayState(this.log.read());
    if (!replayed.started) throw new EngineError("resume() before start(): empty log");
    if (replayed.finished) return { state: "finished", outcome: replayed.finished.outcome };

    this.inputs = replayed.started.inputs;
    this.visits = { ...replayed.visits };
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
        return this.park(intent.node, intent.visit, `ambiguous side effect "${intent.effect}" — probe could not decide`);
      }
      // not-happened: nothing recorded; the retry will claim() it again
    }

    // resume() IS the operator action: a standing park is resolved by resuming. Parks whose
    // cause still holds (maxVisits, exhausted conditions) simply re-park deterministically.
    this.jumpNote = replayed.jumpNote;
    if (replayed.paused) this.log.append({ type: "run-resumed", by: "operator" });
    if (replayed.parked)
      this.log.append({ type: "attention-resolved", node: replayed.parked.node, visit: replayed.parked.visit, reply: "resume" });

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

      const visit = (this.visits[current] = (this.visits[current] ?? 0) + 1);
      const maxVisits = "maxVisits" in def ? def.maxVisits : undefined;
      if (maxVisits !== undefined && visit > maxVisits)
        return this.park(current, visit, `maxVisits exceeded (${visit} > ${maxVisits})`);

      if (this.opts.beforeNode) await this.opts.beforeNode(current, def);
      const attemptId = `${current}#${visit}`;
      this.log.append({ type: "node-started", node: current, visit, attempt_id: attemptId });
      this.ctx.beginAttempt(current, visit);

      let result: AttemptResult;
      try {
        result = await this.execute(current, def, visit, attemptId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.ctx.endAttempt("failed");
        // the reason must be readable in the thread, not only in the (resolvable) ask
        this.log.append({ type: "chunk", node: current, visit, turn: 1, index: 9999, kind: "text", content: `\n[attempt failed: ${message}]` });
        this.log.append({ type: "node-finished", node: current, visit, status: "failed", writes: {} });
        return this.park(current, visit, `executor threw: ${message}`);
      }

      for (const [k, v] of Object.entries(result.writes)) this.ctx.set(k, v);
      this.ctx.endAttempt(result.status);
      this.log.append({ type: "node-finished", node: current, visit, status: result.status, writes: result.writes });

      if (result.status === "failed") return this.park(current, visit, "attempt failed");

      const next = this.route(current, visit);
      if (!next) return this.park(current, visit, "no edge matched (conditions exhausted)");
      this.log.append({ type: "edge-taken", from: current, to: next.to, label: next.condition?.label });
      this.attributeVerdict(current, next);
      current = next.to;
    }
    return this.park(current, this.visits[current] ?? 0, `maxSteps reached (${maxSteps})`);
  }

  private async execute(nodeId: string, def: NodeDef<any>, visit: number, attemptId: string): Promise<AttemptResult> {
    const executor = this.opts.executors[def.kind as keyof EngineOpts["executors"]];
    if (!executor) throw new EngineError(`no executor for kind "${def.kind}"`);

    const reads: Record<string, unknown> = {};
    if ("reads" in def && def.reads) for (const k of def.reads) reads[k] = this.ctx.get(k, { node: nodeId, visit });

    let renderedPrompt: string | undefined;
    let agentConfig: AgentConfig | undefined;
    if (def.kind === "agent") {
      agentConfig = this.resolveAgentConfig(def, nodeId);
      renderedPrompt = this.renderPrompt(nodeId, def.prompt, visit, reads, agentConfig);
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

  /** run override → UI node tuning → TS node → UI graph tuning → TS graph default */
  private resolveAgentConfig(def: Extract<NodeDef<any>, { kind: "agent" }>, nodeId: string): AgentConfig {
    const node: AgentConfig = {
      harness: def.harness, model: def.model, effort: def.effort,
      permissionMode: def.permissionMode, maxTurns: def.maxTurns, skills: def.skills,
    };
    return resolveAgentConfigLayers([
      this.opts.overrides,
      this.opts.tuning?.nodes?.[nodeId],
      node,
      this.opts.tuning?.defaults,
      this.graph.def.defaults,
    ]);
  }

  private renderPrompt(nodeId: string, prompt: PromptId, visit: number, reads: Record<string, unknown>, config?: AgentConfig): string {
    const raw = readFileSync(join(this.pinDir(), `${prompt}.md`), "utf8");
    const { frontmatter, body } = splitFrontMatter(raw);
    const version = Number(frontmatter?.match(/^version:\s*(\d+)\s*$/m)?.[1] ?? 1);

    let operatorSuffix = "";
    if (this.jumpNote && this.jumpNote.node === nodeId) {
      operatorSuffix = operatorInstructionSuffix(this.jumpNote.message);
      this.jumpNote = null; // consumed by this attempt
    }
    const { text: rendered, read: contextRead } = renderTemplate(body, (key) =>
      key in reads ? reads[key] : this.ctx.get(key, { node: nodeId, visit }),
    );
    const finalRendered = rendered + operatorSuffix;
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

  private park(node: string, visit: number, reason: string): RunState {
    this.log.append({ type: "attention-raised", node, visit, reason });
    return { state: "parked", node, reason };
  }
}
