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
 *   terminal   ends the run with an outcome
 *
 * Routing: edges carry an optional typed condition + weight. Highest-weight passing
 * condition wins; an unconditional edge is the weight-0 fallback. A node whose conditional
 * edges all fail AND has no fallback does not dead-end: the run PARKS as needs-attention
 * (Orbital semantics: stages without a matching edge await the operator). Exhaustive
 * conditional sets over closed choice types are therefore legal and common.
 */
import { validateGraph, formatViolations, type GraphShape, type Violation } from "./validate";
import type { Scope } from "./context";
import type { PromptId } from "./prompt-ids";

/** The generated union from prompts/codegen.ts — an unknown id is a compile error. */
export type PromptRef = PromptId;

export type Harness = "claude" | "codex" | "opencode";

export type Effort = "low" | "medium" | "high" | "xhigh";
export type PermissionMode = "manual" | "acceptEdits" | "auto" | "plan";

/** per-agent execution config — resolution order: run override → node → graph default */
export interface AgentConfig {
  harness?: Harness;
  model?: string;
  effort?: Effort;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  /** skills the node expects available; surfaced to the agent and asserted by doctor */
  skills?: string[];
}

export interface OutputSpec {
  scope: Scope;
  /** doc string surfaced in the UI and to the reviser */
  description?: string;
}

type Keys<C> = keyof C & string;

export type NodeDef<C extends object> =
  | ({
      kind: "agent";
      prompt: PromptRef;
      reads?: Keys<C>[];
      writes?: Partial<Record<Keys<C>, OutputSpec>>;
      maxVisits?: number;
      class?: string;
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
  | { kind: "terminal"; outcome: "success" | "failed" | "aborted"; label?: string };

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
}

export class GraphError extends Error {}

export class Graph<C extends object> {
  constructor(readonly def: GraphDef<C>) {}

  /** writers per key, derived from node declarations — feeds ContextStore's constructor. */
  declarations(): Record<string, { scope: Scope; writer: string[] }> {
    const out: Record<string, { scope: Scope; writer: string[] }> = {};
    for (const [id, node] of Object.entries(this.def.nodes)) {
      const writes = "writes" in node ? node.writes : undefined;
      if (!writes) continue;
      for (const [key, spec] of Object.entries(writes) as [string, OutputSpec][]) {
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
      nodes[id] = {
        reads: "reads" in n && n.reads ? [...n.reads] : [],
        writes: "writes" in n && n.writes ? Object.keys(n.writes) : [],
      };
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
   *   2. terminal nodes have no outgoing edges
   *   3. non-terminal nodes have at least one outgoing edge (no silent dead-ends)
   *   4. at most one unconditional fallback edge per node (ambiguity)
   *   5. conflicting scope declarations (declarations() throws)
   *   6. every read has a writer on every path — incl. edge-condition reads (validateGraph)
   */
  validate(): { structural: string[]; paths: Violation[] } {
    const structural: string[] = [];
    const d = this.def;

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

    this.declarations(); // throws GraphError on scope conflicts

    const paths = validateGraph(this.toShape());
    return { structural, paths };
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
