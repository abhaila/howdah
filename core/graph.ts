/**
 * Howdah graph schema — TypeScript-native workflow graphs (shaping A0.1/A0.2, eng review D2).
 *
 * The type-checker is the validator for NAMES AND TYPES: context keys are `keyof C`,
 * condition tests receive typed values, prompt refs are strings today and become the
 * generated `PromptId` union at T4. STRUCTURE (paths, fallbacks, terminals) is proven by
 * `validate()` before any run — a graph that loads is a graph that cannot fail a context
 * read at runtime.
 *
 * Node kinds (Orbital's shapes, made discriminated):
 *
 *   agent      runs a prompt through a harness; declares typed outputs
 *   command    runs a script/probe; declares the facts it emits
 *   worktree   create/remove an isolated checkout; emits facts (e.g. worktree.clean)
 *   wait       parks the run for a duration; writes nothing
 *   approval   a human decision on a proposal (system-map 1a) — see ApprovalNodeDef
 *   terminal   ends the run with an outcome
 *
 * Routing: edges carry an optional typed condition + weight. Highest-weight passing
 * condition wins; an unconditional edge is the weight-0 fallback. A node whose conditional
 * edges all fail AND has no fallback does not dead-end: the run PARKS as needs-attention
 * (Orbital semantics: stages without a matching edge await the operator). Exhaustive
 * conditional sets over closed choice types are therefore legal and common.
 */
import { validateGraph, formatViolations, type GraphShape, type Violation } from "./validate";
import { defaultHarness, effortFor, harnessNames, harnessSpec, isHarness, type HarnessName } from "./harnesses";
import type { Scope } from "./context";
import type { GraphSpec } from "./graph-spec";
import type { PromptId } from "./prompt-ids";

/** The generated union from prompts/codegen.ts — an unknown id is a compile error. */
export type PromptRef = PromptId;

/** HOW-17: the names, and every per-harness fact, live in core/harnesses.ts. */
export type Harness = HarnessName;

/** HOW-33: `max` is claude's; core/harnesses.ts says what each harness does with each level */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type PermissionMode = "manual" | "acceptEdits" | "auto" | "bypassPermissions" | "dontAsk" | "plan";

/** per-agent execution config — resolution order: run override → node → graph default */
export interface AgentConfig {
  harness?: Harness;
  model?: string;
  effort?: Effort;
  /**
   * HOW-33 — RESOLVED configs only: why the effort some layer set does not reach the harness
   * ("effort high: not supported by cursor"). Set by resolveAgentConfigLayers, never by a
   * layer; when it is set `effort` is undefined, so nothing downstream sends a value the
   * harness would refuse or silently ignore.
   */
  effortInert?: string;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  /** skills the node expects available; surfaced to the agent and asserted by doctor */
  skills?: string[];
  /**
   * HOW-38: a wall-clock ceiling for one agent turn. When it passes, the harness's whole
   * process group is killed and the run parks `turn-timeout`. Unset: no ceiling — a default
   * maxTurns is deliberately NOT set either, because stuck detection plus this ceiling cover
   * the burn case without truncating legitimately long builds.
   */
  turnTimeoutMs?: number;
  /**
   * HOW-38: `false` opts a node out of stuck detection (engine/executors/stuck.ts) — for a step
   * whose whole job is polling the same command. Default on.
   */
  stuckDetection?: boolean;
  /**
   * HOW-37: the most characters one context value's RENDERED text may take in this node's
   * prompt before it is elided around a stub (core/template.ts). Default DEFAULT_CONTEXT_CAP.
   * The stored value is never touched — edge conditions and the log keep the whole thing.
   */
  contextCap?: number;
}

/**
 * Every AgentConfig key a node or layer may set, in one list — what the engine and the
 * viewer's graph API copy off a node, so a new knob cannot be resolved in one and dropped by
 * the other. `effortInert` is absent on purpose: it is a RESOLUTION result, never a setting.
 */
export const AGENT_CONFIG_KEYS = [
  "harness", "model", "effort", "permissionMode", "maxTurns", "skills", "turnTimeoutMs", "stuckDetection", "contextCap",
] as const satisfies ReadonlyArray<Exclude<keyof AgentConfig, "effortInert">>;

/** the AgentConfig a node declares, copied key by key (undefined keys omitted) */
export function agentConfigOf(def: AgentConfig): AgentConfig {
  const out: Record<string, unknown> = {};
  for (const k of AGENT_CONFIG_KEYS) if (def[k] !== undefined) out[k] = def[k];
  return out as AgentConfig;
}

/**
 * Would this model name reach this harness intact? A model name is harness-specific and a
 * leaked one is an API 400, so a name that plainly belongs to ANOTHER harness is refused
 * here rather than at the API. A name no harness claims is still allowed through — that is
 * how a brand-new model works on the day it ships, before this table hears about it.
 *
 * HOW-17: the families are declared in core/harnesses.ts, not owned by a pair of regexes
 * here, so a third harness is one table entry rather than a third branch. A name the table
 * does not know (tuning.json is hand-editable and blind-cast on load) has no family to
 * check against, so the model is allowed through rather than dereferenced into a throw —
 * this function decides what to REFUSE, and it can only refuse on evidence.
 */
export function modelFitsHarness(harness: Harness, model: string): boolean {
  const spec = isHarness(harness) ? harnessSpec(harness) : undefined;
  if (!spec) return true;
  if (spec.modelFamily.test(model)) return true;
  if (spec.acceptsForeignModels) return true; // cursor serves sonnet and gpt alike
  return !harnessNames().some((other) => other !== harness && harnessSpec(other).modelFamily.test(model));
}

/**
 * First set value wins, layer by layer. Two rules are not "first wins":
 *   - the MODEL is the first one that fits the resolved harness, so a claude model in a lower
 *     layer does not follow a node onto codex;
 *   - the PERMISSION MODE is the harness's own when it declares one (claude always runs in
 *     `auto`), and otherwise the first layer that set one — HOW-17: read off harnessSpec, so
 *     cursor does not silently inherit claude's `auto`.
 *
 * `configuredDefaultHarness` is config.json's `defaultHarness` (the caller read it from
 * disk); with none set the default is still claude.
 */
export function resolveAgentConfigLayers(
  layers: Array<AgentConfig | undefined>,
  opts: { configuredDefaultHarness?: string } = {},
): AgentConfig {
  const pick = <K extends keyof AgentConfig>(k: K): AgentConfig[K] => {
    for (const layer of layers) {
      const value = layer?.[k];
      if (value !== undefined) return value;
    }
    return undefined;
  };
  // tuning.json is hand-editable and `loadTuning` blind-casts it, so `pick` can hand back a
  // string no harness table entry answers to. That degrades to the configured default the
  // way it did before the table existed: a typo must not make every graph unrunnable, and a
  // run parked as `executor-threw` would say nothing about which key to fix.
  const picked = pick("harness");
  const harness = isHarness(picked) ? picked : defaultHarness(opts.configuredDefaultHarness);
  let model: string | undefined;
  for (const layer of layers) {
    if (layer?.model && modelFitsHarness(harness, layer.model)) {
      model = layer.model;
      break;
    }
  }
  // HOW-33: effort is re-mapped for the harness that RESOLVED — which is what keeps a claude
  // level from leaking onto the fallback harness — and an effort it cannot take is said to be
  // inert rather than dropped
  const effort = effortFor(harness, pick("effort"));
  return {
    harness,
    model,
    effort: effort.effort,
    ...(effort.inert !== undefined ? { effortInert: effort.inert } : {}),
    permissionMode: harnessSpec(harness).forcedPermissionMode ?? pick("permissionMode"),
    maxTurns: pick("maxTurns"),
    skills: pick("skills"),
    turnTimeoutMs: pick("turnTimeoutMs"),
    stuckDetection: pick("stuckDetection"),
    contextCap: pick("contextCap"),
  };
}

export interface OutputSpec {
  scope: Scope;
  /** doc string surfaced in the UI and to the reviser */
  description?: string;
}

type Keys<C> = keyof C & string;

/**
 * system-map 1a (D3/2A, D6/5A, D15, D22) — a human gate on an agent's proposal.
 *
 *   proposal    the context key a proposer node writes; every successful write of it opens a
 *               new proposal ROUND (`ghost-proposed`, engine/run.ts) that a decision binds to
 *   base        the context key holding the snapshot the proposal was drawn against:
 *               { manifest_hash, fingerprint, commit } (engine/slice-decision.ts BaseSnapshot)
 *   decision    written every time the node finishes, scope `per-visit`:
 *               { outcome: "approved" | "feedback" | "stale", proposal_id, proposal_hash, manifest_hash }
 *   feedback    written every time the node finishes, scope `sticky`: the comments sent
 *               ([] on approve and on stale) — what the proposer reads for its redraw
 *   redesignTo  where `redesign <run> <msg>` jumps (budgets reset). On that node the
 *               `feedback` key is ENGINE-OWNED: the graph adds the write (Graph.writesOf) and
 *               the engine seeds it when the node succeeds (engine/run.ts
 *               seedRedesignFeedback). The node must NOT declare it itself — its executor
 *               never sees the key, so no outputs contract asks an agent for it and no
 *               command's facts check demands it.
 *
 * The node never finishes while it waits: its executor returns `awaiting` and the run parks
 * (`awaiting-approval`) until a decision event lands, so waiting never consumes a visit.
 * Scopes are fixed by the kind — nodeWrites() derives them — so a graph cannot declare a
 * decision that survives re-entry.
 */
export interface ApprovalNodeDef<C extends object> {
  kind: "approval";
  proposal: Keys<C>;
  base: Keys<C>;
  decision: Keys<C>;
  feedback: Keys<C>;
  redesignTo: string;
  class?: string;
}

export type NodeDef<C extends object> =
  | ({
      kind: "agent";
      prompt: PromptRef;
      reads?: Keys<C>[];
      writes?: Partial<Record<Keys<C>, OutputSpec>>;
      maxVisits?: number;
      class?: string;
      /**
       * system-map 1a (D3/2A): a pre-start gate — the node starts only while the named
       * approval node's CURRENT proposal is approved, and (first attempt after that approval)
       * the live worktree still matches the approved base. Checked before node-started, so a
       * refusal consumes no visit. It exists because `jump` can move a stopped run straight
       * past the approval node.
       */
      requires?: { approvalOf: string };
      /**
       * system-map 1a (D6/5A): a HARD constraint, not a default — the resolved permission
       * mode is always "plan", whatever a run override, UI tuning or graph default says. A
       * proposer that wrote files would move the fingerprint and invalidate its own proposal.
       */
      readOnly?: true;
    } & AgentConfig)
  | {
      kind: "command";
      /** shell script or named probe (e.g. "probe:pr") */
      run: string;
      reads?: Keys<C>[];
      writes?: Partial<Record<Keys<C>, OutputSpec>>;
      timeoutMs?: number;
      maxVisits?: number;
      class?: string;
    }
  | {
      kind: "worktree";
      action: "create" | "remove";
      writes?: Partial<Record<Keys<C>, OutputSpec>>;
      class?: string;
    }
  | { kind: "wait"; duration: string; class?: string }
  | ApprovalNodeDef<C>
  | { kind: "terminal"; outcome: "success" | "failed" | "aborted"; label?: string };

/** The context keys a node reads — the one answer the validator, engine and jump precheck share. */
export function nodeReads(node: NodeDef<any>): string[] {
  if (node.kind === "approval") return [node.proposal, node.base];
  return "reads" in node && node.reads ? [...node.reads] : [];
}

/** The context keys a node writes, with scopes. Approval scopes are fixed by the kind. */
export function nodeWrites(node: NodeDef<any>): Record<string, OutputSpec> {
  if (node.kind === "approval")
    return {
      [node.decision]: { scope: "per-visit", description: "the operator's decision on the current proposal round" },
      [node.feedback]: { scope: "sticky", description: "comments sent with the decision ([] on approve / stale)" },
    };
  return "writes" in node && node.writes ? ({ ...node.writes } as Record<string, OutputSpec>) : {};
}

export interface Condition<C extends object, K extends Keys<C> = Keys<C>> {
  /** the keys the test consumes — validated against out(from), and all the test may see */
  reads: K[];
  test: (values: Pick<C, K>) => boolean;
  /** human-readable form for the UI and the event log */
  label: string;
}

export interface EdgeDef<C extends object> {
  from: string;
  to: string;
  condition?: Condition<C>;
  /** higher wins among passing conditions; unconditional edges are the weight-0 fallback */
  weight?: number;
}

export interface GraphDef<C extends object> {
  name: string;
  description?: string;
  /** graph-wide agent defaults; node settings override these, run overrides beat both */
  defaults?: AgentConfig;
  entry: string;
  /** required run inputs — available in context at entry */
  inputs: Keys<C>[];
  nodes: Record<string, NodeDef<C>>;
  edges: EdgeDef<C>[];
  /**
   * system-map 1a (hook for 1c's GhostSet validator): checks a proposal before it becomes a
   * round. Called with the value a node wrote to an approval node's `proposal` key; a
   * non-null result is the reason the write is refused — the proposer's attempt fails and
   * the run parks `attempt-failed` with that message, so the agent can be told what to fix.
   *
   * system-map 1c: `run` says WHICH run the proposal belongs to, because a real validator
   * (graphs/implement-slice.ts: GhostSet ids against the base snapshot) must load that run's
   * base — `dir` is the run directory (manifests live in <dir>/maps/), `base` is the value of
   * the approval node's `base` key at the proposer's exit (undefined if unreadable) and `cwd`
   * is where the run works (its worktree once one exists).
   */
  validateProposal?: (proposal: unknown, approvalNode: string, run: ProposalRun) => string | null;
  /**
   * HOW-22: the declarative spec this graph was COMPILED from, when it was built in the
   * viewer's graph builder rather than written by hand (core/graph-spec.ts buildGraph).
   *
   * It is carried here so the builder can re-open exactly what it wrote instead of
   * reverse-engineering a spec out of TypeScript. Nothing in the engine reads it — a graph
   * with a spec and the same graph written by hand behave identically — and a hand-written
   * graph simply has none, which is how the viewer knows to offer the source editor instead.
   * The import is type-only, so core/graph-spec.ts may import this module at runtime.
   */
  spec?: GraphSpec;
}

/** Which run a proposal is validated for (GraphDef.validateProposal). */
export interface ProposalRun {
  dir: string;
  base: unknown;
  cwd: string | undefined;
}

export class GraphError extends Error {}

export class Graph<C extends object> {
  constructor(readonly def: GraphDef<C>) {}

  /**
   * Everything a node publishes: its own declared writes (nodeWrites) plus the ENGINE-OWNED
   * writes the graph adds — an approval node's feedback key on its redesignTo node. The
   * executor-facing declaration (`def.writes`) stays the node's own.
   */
  writesOf(nodeId: string): Record<string, OutputSpec> {
    const node = this.def.nodes[nodeId];
    const out = node ? nodeWrites(node) : {};
    for (const [, approval] of this.approvalNodes())
      if (approval.redesignTo === nodeId)
        out[approval.feedback] = { scope: "sticky", description: "engine-owned: unconsumed redesign messages (system-map D22)" };
    return out;
  }

  /** writers per key, derived from node declarations — feeds ContextStore's constructor. */
  declarations(): Record<string, { scope: Scope; writer: string[] }> {
    const out: Record<string, { scope: Scope; writer: string[] }> = {};
    for (const id of Object.keys(this.def.nodes)) {
      for (const [key, spec] of Object.entries(this.writesOf(id))) {
        const existing = out[key];
        if (existing) {
          // multi-writer is legal; conflicting scopes are not
          const prior = existing;
          if (prior.scope !== spec.scope)
            throw new GraphError(
              `context key "${key}" declared with scope "${spec.scope}" by ${id} but "${prior.scope}" by ${prior.writer.join(",")}`,
            );
          prior.writer.push(id);
        } else {
          out[key] = { scope: spec.scope, writer: [id] };
        }
      }
    }
    return out;
  }

  /** Project to the shape the path validator consumes. */
  toShape(): GraphShape {
    const nodes: GraphShape["nodes"] = {};
    for (const [id, n] of Object.entries(this.def.nodes)) {
      nodes[id] = { reads: nodeReads(n), writes: Object.keys(this.writesOf(id)) };
    }
    return {
      entry: this.def.entry,
      inputs: [...this.def.inputs],
      nodes,
      edges: this.def.edges.map((e) => ({ from: e.from, to: e.to, reads: e.condition ? [...e.condition.reads] : undefined })),
    };
  }

  /**
   * All structural checks. Returns [] for a legal graph; validateOrThrow() for load-time use.
   *   1. duplicate/unknown ids and entry (validateGraph throws on those)
   *   2. terminal nodes have no outgoing edges, and the ENTRY is not one
   *   3. non-terminal nodes have at least one outgoing edge (no silent dead-ends)
   *   4. at most one unconditional fallback edge per node (ambiguity)
   *   5. conflicting scope declarations (declarations() throws)
   *   6. every read has a writer on every path — incl. edge-condition reads (validateGraph)
   *   7. approval wiring (system-map 1a): distinct decision/feedback keys, a real
   *      redesignTo that does not itself declare the (engine-owned) feedback key, one
   *      approval per proposal key, and every `requires.approvalOf` names an approval node
   */
  validate(): { structural: string[]; paths: Violation[] } {
    const structural: string[] = [];
    const d = this.def;

    // a run that STARTS at a terminal ends before it does anything: vacuously consistent (every
    // read has a writer on the zero paths that reach anything) and completely useless. The
    // approval half of this rule was already here — `redesignTo` a terminal is refused below —
    // and the entry was the asymmetry (HOW-22 review, finding 1).
    if (d.nodes[d.entry]?.kind === "terminal") structural.push(`entry node "${d.entry}" is a terminal`);

    const outgoing = new Map<string, EdgeDef<C>[]>(Object.keys(d.nodes).map((id) => [id, []]));
    for (const e of d.edges) outgoing.get(e.from)?.push(e);

    for (const [id, node] of Object.entries(d.nodes)) {
      const outs = outgoing.get(id) ?? [];
      if (node.kind === "terminal") {
        if (outs.length > 0) structural.push(`terminal node "${id}" has outgoing edges`);
        continue;
      }
      if (outs.length === 0) structural.push(`non-terminal node "${id}" has no outgoing edge (dead end)`);
      // no-fallback is legal: all-conditions-fail parks the run as needs-attention
      const fallback = outs.filter((e) => !e.condition);
      if (fallback.length > 1) structural.push(`node "${id}" has ${fallback.length} unconditional edges (ambiguous fallback)`);
    }

    structural.push(...this.approvalProblems());

    this.declarations(); // throws GraphError on scope conflicts

    const paths = validateGraph(this.toShape());
    return { structural, paths };
  }

  private approvalProblems(): string[] {
    const problems: string[] = [];
    const nodes = this.def.nodes;
    const byProposal = new Map<string, string>();
    for (const [id, node] of Object.entries(nodes)) {
      if (node.kind === "approval") {
        if (node.decision === node.feedback)
          problems.push(`approval node "${id}" uses "${node.decision}" as both its decision and feedback key`);
        const other = byProposal.get(node.proposal);
        if (other) problems.push(`approval nodes "${other}" and "${id}" both decide proposal key "${node.proposal}"`);
        byProposal.set(node.proposal, id);
        const target = nodes[node.redesignTo];
        if (!target) problems.push(`approval node "${id}" redesigns to unknown node "${node.redesignTo}"`);
        else if (target.kind === "terminal") problems.push(`approval node "${id}" redesigns to terminal node "${node.redesignTo}"`);
        else if (node.feedback in nodeWrites(target))
          problems.push(
            `node "${node.redesignTo}" declares "${node.feedback}", which is engine-owned there (approval "${id}" redesigns to it) — remove it from its writes`,
          );
      }
      if (node.kind === "agent" && node.requires) {
        const gate = nodes[node.requires.approvalOf];
        if (!gate || gate.kind !== "approval")
          problems.push(`node "${id}" requires approval of "${node.requires.approvalOf}", which is not an approval node`);
      }
    }
    return problems;
  }

  /** The approval nodes of this graph, by id. */
  approvalNodes(): Array<[string, ApprovalNodeDef<any>]> {
    return Object.entries(this.def.nodes).filter((e): e is [string, ApprovalNodeDef<any>] => e[1].kind === "approval");
  }

  validateOrThrow(): void {
    const { structural, paths } = this.validate();
    const problems = [...structural, ...(paths.length ? [formatViolations(paths)] : [])];
    if (problems.length) throw new GraphError(`graph "${this.def.name}" is invalid:\n` + problems.join("\n"));
  }
}

/** Entry point: `defineGraph<Ctx>({ ... })` — C fixes every key and value type in the def. */
export function defineGraph<C extends object>(def: GraphDef<C>): Graph<C> {
  return new Graph(def);
}
