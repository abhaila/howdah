/**
 * GraphSpec (HOW-22) — a graph as DATA, so a human can build one from forms.
 *
 * shaping.md's D2 said authoring stays TS-native because "there is no visual editor to drift
 * out of sync". HOW-22 asks for the editor. The way to have it without the drift is to keep
 * the FILE as the artifact and change only what is inside it: a builder graph is still a
 * `.ts` module in `$HOWDAH_HOME/graphs` that `graphs/local.ts` imports, validates and gates
 * on exactly as before — but its whole body is a JSON-shaped literal plus one call to
 * `buildGraph()`. Nothing downstream of `Graph` knows the difference.
 *
 * Two properties fall out, and both are the point:
 *
 *   ROUND TRIP. `buildGraph` hangs the spec back on `GraphDef.spec`, so re-opening the
 *   builder reads the literal that was written — never a guess reverse-engineered from
 *   TypeScript. A file the builder cannot read back is reported as such (`builder: false`)
 *   and offered the source editor instead; it is never half-understood.
 *
 *   NO COMPILER IN THE LOOP. `defineGraph<C>`'s compile checks are for NAMES and TYPES: a
 *   context key that does not exist, a condition reading a key it did not declare, a prompt
 *   id that is not a prompt. In the builder none of those can be typed free-hand — keys come
 *   from a registry, predicates are data, prompt ids are generated from step ids — so what
 *   the compiler was protecting is gone rather than bypassed. What remains is STRUCTURE, and
 *   `Graph.validate()` proves that. `specProblems()` is that proof, rewritten into the
 *   operator's words and attributed to the step that owns it.
 *
 * This module is NODE-FREE on purpose: the viewer bundles it, so `buildGraph(draft).validate()`
 * runs on every keystroke in the browser with no validation route and no latency. The server
 * still runs the real gate at save — this is belt-and-braces, not a second truth.
 *
 * Three modelling choices carry most of the UX:
 *
 *   1. `scope` lives on the FIELD, not on each write. Two writers declaring different scopes
 *      for one key is a `GraphError` (core/graph.ts declarations()); hanging scope off the
 *      field makes that error structurally unreachable and asks the freshness question once,
 *      in plain language, instead of once per producing step.
 *   2. `nodes` is an ARRAY. Step order is the builder's spine, and a Record's key order is
 *      too fragile to be one. `buildGraph` converts.
 *   3. Edge WEIGHT is not stored. It is the row order: among the conditional edges leaving a
 *      step, the first listed wins. The operator orders rows; they never see a number.
 *
 * Deliberate limits, stated rather than hidden. There is no `validateProposal` (a closure
 * only implement-slice needs), and conditions come from the fixed predicate vocabulary
 * below. That vocabulary covers every condition in every built-in graph except
 * `graphs/delivery.ts`'s `newProblems` closure. A graph needing more drops to the source
 * editor and forfeits the round trip, which the builder says once, at the point of need.
 */
import { Graph, defineGraph, type AgentConfig, type Condition, type EdgeDef, type Effort, type NodeDef, type PermissionMode, type PromptRef } from "./graph";
import { isHarness } from "./harnesses";
import type { Scope } from "./context";
import type { Violation } from "./validate";

export const SPEC_VERSION = 1;

/** kebab-ish, and nothing that could escape a directory — matches graphs/local.ts LOCAL_NAME. */
export const SPEC_GRAPH_NAME = /^[a-z][a-z0-9-]*$/;
/** a step id: stable identity, assigned once, never renamed (the title is what an operator edits) */
export const SPEC_NODE_ID = /^[a-z][a-z0-9._-]*$/;
/** a context key: what `{{ context.x }}` can name (core/template-refs.ts TEMPLATE_REF) */
export const SPEC_FIELD_KEY = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
/** a prompt id: what findPromptFile() turns into `<id>.md`, with no path in it */
export const SPEC_PROMPT_ID = /^[a-z][a-z0-9._-]*$/;

/** how a field's value is offered in the launch form and read in a condition */
export type FieldKind = "text" | "choice" | "number" | "boolean" | "json";

export interface FieldSpec {
  key: string;
  kind: FieldKind;
  /** freshness, asked once per field — see core/context.ts for what each means */
  scope: Scope;
  /** `choice` only: the values the field can take, offered in condition rows */
  choices?: string[];
  description?: string;
}

/**
 * The condition vocabulary. `path` reaches INTO an object value (`slice.approval` +
 * `outcome`), which is the one shape built-in graphs need beyond a bare key compare.
 */
export type Predicate =
  | { op: "equals" | "not-equals"; key: string; path?: string; value: string | number | boolean }
  | { op: "one-of"; key: string; path?: string; values: Array<string | number | boolean> }
  | { op: "is-true" | "is-false" | "is-empty" | "is-not-empty"; key: string; path?: string };

export const PREDICATE_OPS = ["equals", "not-equals", "one-of", "is-true", "is-false", "is-empty", "is-not-empty"] as const;
export type PredicateOp = (typeof PREDICATE_OPS)[number];
/** ops that carry no operand — the form hides the value box for these */
export const NULLARY_OPS: readonly PredicateOp[] = ["is-true", "is-false", "is-empty", "is-not-empty"];

/**
 * A typed operand from a form control. The FIELD's kind decides the type, so `count is 3`
 * stores the number 3 and compares equal to what a command wrote — a string "3" would
 * silently never match, which is the sort of bug a builder exists to make impossible.
 *
 * It lives here rather than in the branching pane because the kind can change LATER: a field
 * flipped from text to Yes/no leaves every operand that named it at the old runtime type, and
 * the rule that fixes that (recoercePredicate, run by the draft reducer) has to be the same
 * rule the control uses. A number that will not parse becomes 0 rather than NaN — NaN
 * serialises to `null`, and a spec that cannot round-trip through JSON is not a spec.
 */
export function coerceOperand(raw: string, kind: FieldKind | undefined): string | number | boolean {
  if (kind === "number") {
    const n = Number(raw.trim() === "" ? 0 : raw);
    return Number.isFinite(n) ? n : 0;
  }
  if (kind === "boolean") return raw === "true";
  return raw;
}

/**
 * A `path` reaches INSIDE a structured value, so it means something only on a json field. Left
 * on any other kind it is both invisible (the inner-name box renders for json only) and fatal
 * (nothing that kind can hold has that path in it, so the row can never fire) — HOW-22 review,
 * finding 3.
 */
export function keepPath(path: string | undefined, kind: FieldKind | undefined): string | undefined {
  return kind === "json" && path ? path : undefined;
}

/**
 * Why this condition row can never fire, or null — the same rule as `coerceOperand`, read
 * backwards. A row that compiles to a predicate no runtime value can satisfy saves clean and
 * then silently never routes: `flag == ''` on a yes/no field, `count == '3'` as text on a
 * number field, `x in []`. The form seeds through `coerceOperand` so it cannot create one, but
 * a spec also arrives by PUT and by re-opening a hand-edited module, and it was the CREATION
 * path forgetting this rule that produced the defect in the first place (HOW-22 review,
 * finding 3) — so the spec, not the form, is where it is proven.
 *
 * Checked only when `path` is ABSENT: with a path the field's kind describes the CONTAINER and
 * the value at the path has no declared type, so `slice.approval` + `outcome` == "reject" on a
 * json field is legitimate.
 *
 * Deliberately NOT checked: whether a `choice` operand is one of the declared `choices`.
 * `probe:pr` can legitimately report `OPEN` for a `pr.state` an operator declared as
 * ["MERGED","CLOSED"], and refusing that branch would be refusing a true statement about run
 * time on the strength of a launch-form hint. `text` beyond the empty case and `json` without
 * a path are unchecked for the same reason — a command may write a number into a text field.
 */
export function unmatchableOperand(p: Predicate, field: FieldSpec | undefined): string | null {
  // a path the field's kind cannot carry is the one path case that IS decidable, and it was the
  // silent one: re-pointing a json row at a text field carried the path across, the inner-name
  // box stopped rendering so it could not be removed, and the row saved clean and never fired.
  // `field &&` is deliberate — an unknown key is already reported by the caller's own branch,
  // and this is a public export that must not invent a verdict about a field it cannot see.
  if (p.path && field && field.kind !== "json")
    return `reaches inside \`${p.key}\` for \`${p.path}\`, but \`${p.key}\` is not a structured (JSON) field — nothing it can hold has a \`${p.path}\` in it.`;
  if (p.path) return null;
  const operands: Array<string | number | boolean> =
    p.op === "one-of" ? p.values : p.op === "equals" || p.op === "not-equals" ? [p.value] : [];
  if (p.op === "one-of" && p.values.length === 0)
    return `has no values to match. Add at least one, or use a different test.`;
  for (const v of operands) {
    if (v === "") return `compares \`${p.key}\` with nothing. Type a value, or use "has a value" / "is empty".`;
    if (field?.kind === "boolean" && typeof v !== "boolean")
      return `compares \`${p.key}\` with \`${JSON.stringify(v)}\`, but \`${p.key}\` is a yes/no field — nothing it can hold will ever equal that.`;
    if (field?.kind === "number" && typeof v !== "number")
      return `compares \`${p.key}\` with \`${JSON.stringify(v)}\` as text, but \`${p.key}\` is a number field. Type a number.`;
  }
  return null;
}

/** Every operand a predicate carries, re-typed for its field's kind, and its `path` dropped when
 *  the kind can no longer carry one (keepPath). Nullary ops keep no operand — they compare
 *  against nothing, so there is nothing to coerce — but they can still carry a stale path. */
export function recoercePredicate(p: Predicate, kind: FieldKind | undefined): Predicate {
  const path = keepPath(p.path, kind);
  const base = { ...p, ...(path ? { path } : {}) };
  if (!path) delete (base as { path?: string }).path;
  if (base.op === "equals" || base.op === "not-equals") return { ...base, value: coerceOperand(String(base.value), kind) };
  if (base.op === "one-of") return { ...base, values: base.values.map((v) => coerceOperand(String(v), kind)) };
  return base;
}

interface NodeBase {
  id: string;
  /** the editable label; the ID never moves, because `${node}#${visit}` is run identity */
  title?: string;
  /** the tuner's bulk-update grouping (core/graph.ts NodeDef.class) */
  class?: string;
}

export type NodeSpec =
  | (NodeBase & {
      kind: "agent";
      prompt: string;
      /** DERIVED from the prompt body by templateReads() — never typed by hand */
      reads: string[];
      writes: string[];
      maxVisits?: number;
      /** plan mode no override can raise (core/graph.ts readOnly) */
      readOnly?: true;
      /** the id of an approval step this one may not start before (requires.approvalOf) */
      requires?: string;
      config?: AgentConfig;
    })
  | (NodeBase & { kind: "command"; run: string; reads: string[]; writes: string[]; timeoutMs?: number; maxVisits?: number })
  | (NodeBase & { kind: "worktree"; action: "create" | "remove"; writes: string[] })
  | (NodeBase & { kind: "wait"; duration: string })
  | (NodeBase & { kind: "approval"; proposal: string; base: string; decision: string; feedback: string; redesignTo: string })
  | (NodeBase & { kind: "terminal"; outcome: "success" | "failed" | "aborted"; label?: string });

export interface EdgeSpec {
  from: string;
  to: string;
  /** absent = the "Otherwise" fallback. Among conditional edges, FIRST LISTED WINS. */
  when?: Predicate;
}

export interface GraphSpec {
  version: typeof SPEC_VERSION;
  name: string;
  description: string;
  /** the context-key registry: every key any step reads, writes or asks for at launch */
  fields: FieldSpec[];
  /** the field keys asked for when a run starts */
  inputs: string[];
  defaults?: AgentConfig;
  entry: string;
  nodes: NodeSpec[];
  edges: EdgeSpec[];
}

// ---- what an executor can actually publish ----------------------------------------------

/**
 * What each built-in command produces — the executor emits exactly these and nothing else.
 * `probe:pr` DROPS an undeclared key silently (engine/executors/worktree.ts) and the `map:*`
 * built-ins throw (engine/executors/map.ts declaredWrites); either way a step declaring
 * something else is wrong before it ever runs, which is what emittableWrites() is for.
 */
export const COMMAND_BUILTINS: Array<{ run: string; label: string; produces: string[] }> = [
  { run: "probe:pr", label: "Check the pull request", produces: ["pr.state"] },
  { run: "map:extract", label: "Extract the system map", produces: ["map.base", "map.neighbourhood", "slice.drift", "review_findings"] },
  { run: "map:reextract", label: "Re-extract the system map", produces: ["map.after"] },
  { run: "map:drift", label: "Compare the map against the approved design", produces: ["slice.drift"] },
];

/** A worktree CLEAN-UP step emits these two facts and no others (engine/executors/worktree.ts). */
export const WORKTREE_FACTS = ["worktree.clean", "outcome"] as const;

/** The built-in a command step runs, by its first word — `map:drift --since X` is still map:drift. */
export function commandBuiltin(run: string): (typeof COMMAND_BUILTINS)[number] | undefined {
  const head = run.trim().split(/\s+/)[0];
  return COMMAND_BUILTINS.find((b) => b.run === head);
}

/**
 * The facts a step's executor can actually publish, or `undefined` when anything the operator
 * declares is legal.
 *
 * This is DATA in core/ rather than a filter in a form because it has four consumers that
 * must not drift: the step form's picker, the draft reducer (which normalises on every step
 * edit), specProblems() — the only one that also sees a spec arriving by PUT or hand-edited
 * on disk — and the test that checks it still matches the executors themselves. It used to be
 * one hand-written filter at ONE of the two call sites that needed it, and the one it missed
 * shipped a graph that raises a ContextError at run time (HOW-22 review, finding 3).
 *
 *   worktree "create"  → nothing: engine/executors/worktree.ts returns `writes: {}` on both
 *                        the fresh and the idempotent re-visit path.
 *   worktree "remove"  → WORKTREE_FACTS.
 *   command, built-in  → that built-in's `produces`.
 *   command, a script  → undefined: its LAST line of JSON decides, at run time.
 *   agent              → undefined: the outputs contract asks for whatever is declared.
 */
export function emittableWrites(n: NodeSpec): readonly string[] | undefined {
  switch (n.kind) {
    case "worktree":
      return n.action === "remove" ? WORKTREE_FACTS : [];
    case "command":
      return commandBuiltin(n.run)?.produces;
    default:
      return undefined;
  }
}

/** The keys a step declares that its executor could never publish. */
export function undeliverableWrites(n: NodeSpec): string[] {
  const only = emittableWrites(n);
  if (!only || !("writes" in n)) return [];
  return n.writes.filter((k) => !only.includes(k));
}

// ---- compiling a spec into a real Graph -------------------------------------------------

/** `{ a: { b: 1 } }`, "b" → 1. A missing hop is `undefined`, never a throw. */
function valueAt(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let cur: unknown = value;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

const literal = (v: string | number | boolean): string => (typeof v === "string" ? `'${v}'` : String(v));

/** "" / null / undefined / [] / {} are empty; 0 and false are NOT (they are answers). */
function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

/**
 * The label the DAG and the event log show. It matches the house style of the hand-written
 * graphs byte for byte (`review_verdict == 'reject'`, `worktree.clean == true`), so a built
 * graph reads like a written one rather than announcing itself.
 */
export function predicateLabel(p: Predicate): string {
  const ref = p.path ? `${p.key}.${p.path}` : p.key;
  switch (p.op) {
    case "equals": return `${ref} == ${literal(p.value)}`;
    case "not-equals": return `${ref} != ${literal(p.value)}`;
    case "one-of": return `${ref} in [${p.values.map(literal).join(", ")}]`;
    case "is-true": return `${ref} == true`;
    case "is-false": return `${ref} == false`;
    case "is-empty": return `${ref} is empty`;
    case "is-not-empty": return `${ref} is set`;
  }
}

/** A Predicate as the engine's Condition. `reads` is the bare key; `path` is applied in the test. */
export function compilePredicate(p: Predicate): Condition<any> {
  const at = (values: Record<string, unknown>) => valueAt(values[p.key], p.path);
  const test =
    p.op === "equals" ? (v: Record<string, unknown>) => at(v) === p.value
    : p.op === "not-equals" ? (v: Record<string, unknown>) => at(v) !== p.value
    : p.op === "one-of" ? (v: Record<string, unknown>) => p.values.includes(at(v) as string | number | boolean)
    : p.op === "is-true" ? (v: Record<string, unknown>) => at(v) === true
    : p.op === "is-false" ? (v: Record<string, unknown>) => at(v) === false
    : p.op === "is-empty" ? (v: Record<string, unknown>) => isEmptyValue(at(v))
    : (v: Record<string, unknown>) => !isEmptyValue(at(v));
  return { reads: [p.key], test: test as Condition<any>["test"], label: predicateLabel(p) };
}

/** Every declared field's scope, by key. An undeclared produced key falls back to `sticky`
 *  so a half-built draft still PREVIEWS; specProblems() is what reports it as a problem. */
function scopesOf(spec: GraphSpec): Record<string, Scope> {
  const out: Record<string, Scope> = {};
  for (const f of spec.fields) out[f.key] = f.scope;
  return out;
}

function writesOf(keys: string[], scopes: Record<string, Scope>, fields: FieldSpec[]): Record<string, { scope: Scope; description?: string }> {
  const out: Record<string, { scope: Scope; description?: string }> = {};
  for (const k of keys) {
    const description = fields.find((f) => f.key === k)?.description;
    out[k] = { scope: scopes[k] ?? "sticky", ...(description ? { description } : {}) };
  }
  return out;
}

function compileNode(n: NodeSpec, scopes: Record<string, Scope>, fields: FieldSpec[]): NodeDef<any> {
  const cls = n.class ? { class: n.class } : {};
  switch (n.kind) {
    case "agent":
      return {
        kind: "agent",
        prompt: n.prompt as PromptRef,
        reads: [...n.reads],
        writes: writesOf(n.writes, scopes, fields),
        ...(n.maxVisits !== undefined ? { maxVisits: n.maxVisits } : {}),
        ...(n.readOnly ? { readOnly: true as const } : {}),
        ...(n.requires ? { requires: { approvalOf: n.requires } } : {}),
        ...(n.config ?? {}),
        ...cls,
      };
    case "command":
      return {
        kind: "command",
        run: n.run,
        reads: [...n.reads],
        writes: writesOf(n.writes, scopes, fields),
        ...(n.timeoutMs !== undefined ? { timeoutMs: n.timeoutMs } : {}),
        ...(n.maxVisits !== undefined ? { maxVisits: n.maxVisits } : {}),
        ...cls,
      };
    case "worktree":
      return { kind: "worktree", action: n.action, writes: writesOf(n.writes, scopes, fields), ...cls };
    case "wait":
      return { kind: "wait", duration: n.duration, ...cls };
    case "approval":
      return { kind: "approval", proposal: n.proposal, base: n.base, decision: n.decision, feedback: n.feedback, redesignTo: n.redesignTo, ...cls };
    case "terminal":
      return { kind: "terminal", outcome: n.outcome, ...(n.label ? { label: n.label } : {}) };
  }
}

/**
 * Edges in spec order become edges with DERIVED weights: among the conditional edges leaving
 * one step, the first listed gets the highest weight, so "first matching row wins" is what
 * the operator sees and what the engine does. The unconditional edge keeps no weight at all —
 * it is the weight-0 fallback the engine already understands.
 */
function compileEdges(spec: GraphSpec): EdgeDef<any>[] {
  const conditionalCount = new Map<string, number>();
  for (const e of spec.edges) if (e.when) conditionalCount.set(e.from, (conditionalCount.get(e.from) ?? 0) + 1);
  const seen = new Map<string, number>();
  return spec.edges.map((e) => {
    if (!e.when) return { from: e.from, to: e.to };
    const i = seen.get(e.from) ?? 0;
    seen.set(e.from, i + 1);
    return { from: e.from, to: e.to, condition: compilePredicate(e.when), weight: (conditionalCount.get(e.from) ?? 0) - i };
  });
}

/**
 * Spec → the same `Graph` a hand-written `defineGraph` produces, with the spec hung back on
 * `def.spec` so the builder can read it out again. Does NOT validate — callers decide
 * (`validateOrThrow()` at load, `specProblems()` live in the browser).
 */
export function buildGraph(spec: GraphSpec): Graph<any> {
  const scopes = scopesOf(spec);
  const nodes: Record<string, NodeDef<any>> = {};
  for (const n of spec.nodes) nodes[n.id] = compileNode(n, scopes, spec.fields);
  return defineGraph<any>({
    name: spec.name,
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.defaults && Object.keys(spec.defaults).length ? { defaults: spec.defaults } : {}),
    entry: spec.entry,
    inputs: [...spec.inputs],
    nodes,
    edges: compileEdges(spec),
    spec,
  });
}

// ---- problems, in the operator's words ---------------------------------------------------

/**
 * Which pane of the builder fixes this problem. It is a required field rather than something
 * the UI sniffs back out of the message, so every site that reports a problem has to say
 * where the operator goes to answer it — and the rail's per-pane counts cannot drift from
 * the wording. A whole-graph problem (the name, the starting step, anything thrown) belongs
 * to `basics`, which is the pane that owns the graph itself.
 */
export type ProblemPane = "basics" | "fields" | "steps" | "branching";

export interface SpecProblem {
  /** the step that owns the problem, so the rail can count it; absent = whole-graph */
  node?: string;
  where: ProblemPane;
  message: string;
}

/**
 * The one refusal a spec cannot carry the evidence for: whether its NAME is already taken.
 * `specProblems()` cannot answer it — a spec does not know the catalog, and this module is
 * node-free so it cannot look at the filesystem. Each caller passes what it knows (the
 * browser the whole catalog, `graphs/builder.ts` this one file's existence) and the sentence
 * is written HERE so there is only ever one of it. A copy in the pane was the second rule
 * that could disagree, and it is how a create came to overwrite an existing graph silently
 * (HOW-22 review, finding 2).
 */
export function nameTakenProblem(name: string, taken: readonly string[]): SpecProblem | null {
  return taken.includes(name)
    ? { where: "basics", message: `There is already a graph called \`${name}\`. Pick another name.` }
    : null;
}

/** What a step is CALLED. The id is identity (`${node}#${visit}`) and never moves; the title
 *  is the label an operator edits, and it is what every message about the step uses. */
export const stepTitle = (spec: GraphSpec, id: string): string => {
  const n = spec.nodes.find((x) => x.id === id);
  return n?.title?.trim() ? n.title.trim() : id;
};
const titleOf = stepTitle;

/** Why a step cannot publish what it declared, in its own terms — the tail of the sentence
 *  undeliverableWrites() opens. Only reached for the kinds emittableWrites() constrains. */
function cannotEmit(n: NodeSpec): string {
  if (n.kind === "worktree")
    return n.action === "create"
      ? `making a worktree reports nothing — it either succeeds or the run parks. Untick it, or switch the step to cleaning up.`
      : `cleaning up a worktree only reports \`${WORKTREE_FACTS.join("` and `")}\`. Untick it.`;
  const builtin = n.kind === "command" ? commandBuiltin(n.run) : undefined;
  return builtin
    ? `\`${builtin.run}\` only reports \`${builtin.produces.join("`, `")}\`. Untick it.`
    : `its executor cannot report that. Untick it.`;
}

/** `node "step-two" has …` → `step-two`, so a structural string can be attributed to a step. */
function firstQuoted(message: string): string | undefined {
  return message.match(/"([^"]+)"/)?.[1];
}

/** an edge-condition violation is reported as `from → to (condition)`; the owner is `from`. */
const violationNode = (v: Violation): string => v.node.split(" ")[0] ?? v.node;

/**
 * Re-word one of `Graph.validate()`'s structural strings. Anything unrecognised is passed
 * through with its step attributed — a message we did not anticipate must still reach the
 * operator, never be swallowed for not matching a pattern.
 */
function rewriteStructural(spec: GraphSpec, raw: string): SpecProblem {
  const id = firstQuoted(raw);
  const who = id ? `**${titleOf(spec, id)}**` : "This graph";
  if (/has no outgoing edge/.test(raw))
    return { node: id, where: "branching", message: `${who} has nowhere to go next. Give it a "go to" in Branching, or make it a Finish step.` };
  if (/has outgoing edges/.test(raw))
    return { node: id, where: "branching", message: `${who} is a Finish step, so nothing can follow it. Remove its outgoing rows in Branching.` };
  if (/unconditional edges \(ambiguous fallback\)/.test(raw))
    return { node: id, where: "branching", message: `${who} has more than one "Otherwise" — only one is allowed. Keep one and give the others a condition.` };
  if (/redesigns to unknown node/.test(raw))
    return { node: id, where: "steps", message: `${who} sends "ask for changes" to a step that no longer exists. Pick a step that does.` };
  if (/redesigns to terminal node/.test(raw))
    return { node: id, where: "steps", message: `${who} sends "ask for changes" to a Finish step, which cannot redo anything. Pick a working step.` };
  if (/which is engine-owned there/.test(raw))
    return { node: firstQuoted(raw), where: "steps", message: `${who} produces the same field the approval step already hands it. Untick that field on this step — Howdah writes it.` };
  if (/both decide proposal key/.test(raw))
    return { node: id, where: "steps", message: `Two approval steps decide the same field. Give one of them its own.` };
  if (/requires approval of/.test(raw))
    return { node: id, where: "steps", message: `${who} waits for an approval step that is not one. Point it at a "Get my approval" step, or clear it.` };
  return { node: id, where: "steps", message: raw };
}

/**
 * Everything wrong with a draft, in the operator's terms, attributed to the step that owns
 * it. NEVER throws: this runs on every keystroke, over a half-built draft, and a throw would
 * take the whole builder down with it.
 *
 * Order matters. The cheap shape checks come first and, when they fail, `Graph.validate()`
 * is SKIPPED — its `validateGraph` throws on an unknown entry or a dangling edge, and a
 * thrown "entry node not in graph" would replace the readable version of the same problem.
 */
export function specProblems(spec: GraphSpec, opts: { knownPrompts?: readonly string[] } = {}): SpecProblem[] {
  const problems: SpecProblem[] = [];
  const ids = new Set<string>();
  const fieldKeys = new Set(spec.fields.map((f) => f.key));

  const namedYet = SPEC_GRAPH_NAME.test(spec.name);
  if (!namedYet)
    problems.push({ where: "basics", message: `The graph needs a name in kebab-case: a letter, then letters, digits or hyphens.` });
  if (spec.nodes.length === 0) problems.push({ where: "steps", message: `A graph needs at least one step.` });

  for (const f of spec.fields) {
    if (!SPEC_FIELD_KEY.test(f.key))
      problems.push({ where: "fields", message: `"${f.key}" is not a usable field name — use letters, digits and underscores, optionally dotted (\`pr.state\`).` });
    if (fieldKeys.has(f.key) && spec.fields.filter((x) => x.key === f.key).length > 1)
      problems.push({ where: "fields", message: `Two fields are both called \`${f.key}\`. Rename one.` });
  }
  for (const key of spec.inputs)
    if (!fieldKeys.has(key)) problems.push({ where: "fields", message: `\`${key}\` is asked for at launch but is not a field. Add it in "What it works with".` });

  const knownPrompts = opts.knownPrompts ? new Set(opts.knownPrompts) : null;
  for (const n of spec.nodes) {
    const who = `**${titleOf(spec, n.id)}**`;
    if (!SPEC_NODE_ID.test(n.id)) problems.push({ node: n.id, where: "steps", message: `"${n.id}" is not a usable step id.` });
    if (ids.has(n.id)) problems.push({ node: n.id, where: "steps", message: `Two steps share the id "${n.id}".` });
    ids.add(n.id);

    // an AGENT's reads come from its instructions and from nowhere else, so a read of a key
    // that is not a field is a sentence to take out of the TEXT, not a declaration to fix —
    // and the pane that holds the text is the one to send the operator to. Everything else a
    // step declares is a tick-box, and belongs to the fields pane.
    if (n.kind === "agent")
      for (const key of n.reads)
        if (!fieldKeys.has(key))
          problems.push({
            node: n.id, where: "steps",
            message: `${who} still asks for \`${key}\` in its instructions, but \`${key}\` is no longer a field. Take it out of the instructions, or add the field back.`,
          });
    const declared = [
      ...(n.kind !== "agent" && "reads" in n ? n.reads : []),
      ...("writes" in n ? n.writes : []),
      ...(n.kind === "approval" ? [n.proposal, n.base, n.decision, n.feedback] : []),
    ];
    for (const key of declared)
      if (!fieldKeys.has(key))
        problems.push({ node: n.id, where: "fields", message: `${who} uses \`${key}\`, which is not a field. Add it in "What it works with", or fix the step.` });

    // a declared fact the executor cannot publish is not a style question: the key is never
    // written, so a surviving condition on it raises a ContextError at run time — the throw
    // CLAUDE.md says means an engine bug, because the validator proved it cannot happen
    for (const key of undeliverableWrites(n))
      problems.push({ node: n.id, where: "steps", message: `${who} says it produces \`${key}\`, but ${cannotEmit(n)}` });

    if (n.kind === "agent") {
      // an agent's prompt id is DERIVED from the graph name (`<graph>.<step>`), so an unnamed
      // draft makes every one of them illegal at once. Saying so on each step would bury the
      // one thing to actually do — name the graph — under a pile of consequences, so the
      // consequence is held back until the cause is fixed.
      if (!SPEC_PROMPT_ID.test(n.prompt)) {
        if (namedYet) problems.push({ node: n.id, where: "steps", message: `${who} has no prompt file name.` });
      } else if (namedYet && !n.prompt.startsWith(`${spec.name}.`)) {
        // A GRAPH WRITES ONLY ITS OWN PROMPTS. Local prompts share one directory, so the
        // `<graph>.<step>` prefix is the ONLY thing keeping two graphs' instructions apart —
        // and nothing proved it, so a create naming another graph's id rewrote that graph's
        // prompt file and returned ok (HOW-22 review, finding 4). A graph name cannot contain a
        // dot (LOCAL_NAME / SPEC_GRAPH_NAME), so `a.` and `a-b.` cannot overlap. The prefix
        // rather than exact equality with promptIdFor(name, n.id), because two steps of ONE
        // graph sharing a body is legitimate and already supported (remove-step keeps a body
        // another step still names). Gated on `namedYet` for the same reason the id check is.
        problems.push({
          node: n.id, where: "steps",
          message: `${who}'s instructions are filed under "${n.prompt}", which belongs to another graph. A graph owns the prompts called \`${spec.name}.<step>\` and no others — rename the step, or give it its own instructions.`,
        });
      } else if (knownPrompts && !knownPrompts.has(n.prompt))
        problems.push({ node: n.id, where: "steps", message: `${who} names the prompt "${n.prompt}", which has no file yet. Write its instructions.` });
      if (n.requires && !spec.nodes.some((x) => x.id === n.requires && x.kind === "approval"))
        problems.push({ node: n.id, where: "steps", message: `${who} waits on an approval step that does not exist. Pick one, or clear it.` });
    }
    if (n.kind === "command" && !n.run.trim()) problems.push({ node: n.id, where: "steps", message: `${who} has no command to run.` });
    if (n.kind === "wait" && !/^\d+\s*(ms|s|m|h)$/.test(n.duration))
      problems.push({ node: n.id, where: "steps", message: `${who} needs a duration like "30 s" or "2 m".` });
    if (n.kind === "approval" && n.decision === n.feedback)
      problems.push({ node: n.id, where: "steps", message: `${who} uses one field for both the decision and the comments. Give them separate fields.` });
  }

  // The starting step, both halves of the same question. A Finish step as the entry saves
  // clean and ends every run immediately (HOW-22 review, finding 1); `core/graph.ts` validate()
  // refuses it too, which is what covers a hand-edited module, but the sentence the operator
  // reads is this one. It fires in the CHEAP block, which returns before anything else runs, so
  // a Finish-step entry is never buried under the consequences it would have for reachability.
  const entryNode = spec.nodes.find((n) => n.id === spec.entry);
  if (!entryNode)
    problems.push({ where: "basics", message: `The starting step is not in the graph. Pick which step runs first.` });
  else if (entryNode.kind === "terminal")
    problems.push({
      where: "basics",
      message: `**${titleOf(spec, entryNode.id)}** is a Finish step, so a run that starts there ends before it does anything. Pick the step that should do the work.`,
    });
  for (const e of spec.edges) {
    if (!ids.has(e.from)) problems.push({ where: "branching", message: `A "go to" starts from a step that no longer exists ("${e.from}"). Remove it.` });
    // an UNPICKED target and a target that was REMOVED are different things that happened, and
    // the second sentence read as the first ('points at a step that no longer exists ("")').
    // The row is kept either way: a row IS its edge, so dropping it would take the condition the
    // operator just typed with it (HOW-22 review, finding 1).
    else if (!e.to)
      problems.push({ node: e.from, where: "branching", message: `**${titleOf(spec, e.from)}** has a "go to" with no step picked. Choose where it goes, or remove the row.` });
    else if (!ids.has(e.to)) problems.push({ node: e.from, where: "branching", message: `**${titleOf(spec, e.from)}** points at a step that no longer exists ("${e.to}"). Pick a step that does.` });
    else if (e.when && !fieldKeys.has(e.when.key))
      problems.push({ node: e.from, where: "branching", message: `**${titleOf(spec, e.from)}** branches on \`${e.when.key}\`, which is not a field.` });
    else if (e.when) {
      const why = unmatchableOperand(e.when, spec.fields.find((f) => f.key === e.when!.key));
      if (why) problems.push({ node: e.from, where: "branching", message: `**${titleOf(spec, e.from)}** ${why}` });
    }
  }
  if (problems.length) return problems;

  // the real gate, in the browser: the same validate() the launcher runs at load
  let structural: string[];
  let paths: Violation[];
  try {
    ({ structural, paths } = buildGraph(spec).validate());
  } catch (err) {
    // a GraphError (conflicting scopes) or anything validateGraph refuses outright
    return [{ where: "basics", message: err instanceof Error ? err.message : String(err) }];
  }
  for (const s of structural) problems.push(rewriteStructural(spec, s));
  for (const v of paths) {
    const owner = violationNode(v);
    const trail = v.witness.length ? ` (${v.witness.map((id) => titleOf(spec, id)).join(" → ")})` : "";
    const where = v.node.endsWith("(condition)") ? `The branch leaving **${titleOf(spec, owner)}**` : `**${titleOf(spec, owner)}**`;
    problems.push({
      node: owner,
      where: v.node.endsWith("(condition)") ? "branching" : "steps",
      message:
        `${where} is given \`${v.key}\`, but nothing writes it on every path that reaches it${trail}. ` +
        `Add a step before it that produces \`${v.key}\`, or ask for it at launch.`,
    });
  }
  if (problems.length) return problems;

  // LAST, and only over an otherwise-clean draft. A step nothing reaches is dead work the
  // operator cannot see, and the review pane already tells them a clean verdict means "every
  // step is reachable" — `validate()` proves the other two clauses of that sentence and never
  // this one (HOW-22 review). It is reported last because unreachability is usually the
  // CONSEQUENCE of something else: with no edges at all, every step dead-ends and every step
  // but the entry is unreachable, and the dead end is the thing to fix. Same restraint the
  // prompt-id check practises for an unnamed graph.
  //
  // Builder-only on purpose: a repo-wide rule would judge every hand-written graph, which is a
  // bigger blast radius than this change earns (all seven built-ins are in fact clean).
  const seen = new Set([spec.entry]);
  const queue = [spec.entry];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of spec.edges) if (e.from === cur && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
  }
  for (const n of spec.nodes)
    if (!seen.has(n.id))
      problems.push({
        node: n.id, where: "branching",
        message: `**${titleOf(spec, n.id)}** is never reached — no step goes to it. Give some step a "go to" that lands on it, or remove it.`,
      });
  return problems;
}

// ---- parsing an untrusted spec -------------------------------------------------------------

/**
 * A spec arriving from the network (the builder's PUT) or from a `.ts` file someone may have
 * hand-edited. Every field is checked and COPIED — the result shares no structure with the
 * input and carries no key this module did not put there, so what gets written to disk and
 * embedded in a module is only ever what this function produced.
 */
export type ParseResult = { ok: true; spec: GraphSpec } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const posInt = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;

const SCOPES = ["sticky", "cleared", "per-visit"] as const;
const FIELD_KINDS = ["text", "choice", "number", "boolean", "json"] as const;
const OUTCOMES = ["success", "failed", "aborted"] as const;
const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const PERMISSION_MODES = ["manual", "acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan"] as const;

/**
 * An AgentConfig from anywhere untrusted — the network, or the builder's loose per-field DTO
 * (the viewer's ConfigFields works in strings, because a `<select>` does). Exported because
 * that widening/narrowing has to happen in ONE place: a harness or effort name the table
 * does not know is dropped here rather than written into a graph file.
 */
export function parseAgentConfig(v: unknown): AgentConfig | undefined {
  if (!isObj(v)) return undefined;
  const out: AgentConfig = {};
  // an unknown harness name is DROPPED rather than carried: core/ degrades one to the
  // configured default at run time, and a spec is the place to keep a typo out of the file
  const harness = str(v.harness);
  if (isHarness(harness)) out.harness = harness;
  if (str(v.model)) out.model = str(v.model)!;
  const effort = oneOf(v.effort, EFFORTS);
  if (effort) out.effort = effort as Effort;
  const mode = oneOf(v.permissionMode, PERMISSION_MODES);
  if (mode) out.permissionMode = mode as PermissionMode;
  const turns = posInt(v.maxTurns);
  if (turns !== undefined) out.maxTurns = turns;
  const skills = strArray(v.skills);
  if (skills.length) out.skills = skills;
  return Object.keys(out).length ? out : undefined;
}

function parsePredicate(v: unknown): Predicate | undefined {
  if (!isObj(v)) return undefined;
  const op = oneOf(v.op, PREDICATE_OPS);
  const key = str(v.key);
  if (!op || !key) return undefined;
  const path = str(v.path);
  const base = { key, ...(path ? { path } : {}) };
  const scalar = (x: unknown): string | number | boolean | undefined =>
    typeof x === "string" || typeof x === "number" || typeof x === "boolean" ? x : undefined;
  if (op === "equals" || op === "not-equals") {
    const value = scalar(v.value);
    return value === undefined ? undefined : { op, ...base, value };
  }
  if (op === "one-of") {
    const values = Array.isArray(v.values) ? v.values.map(scalar).filter((x): x is string | number | boolean => x !== undefined) : [];
    return values.length ? { op, ...base, values } : undefined;
  }
  return { op, ...base };
}

function parseNode(v: unknown): NodeSpec | undefined {
  if (!isObj(v)) return undefined;
  const id = str(v.id);
  if (!id || !SPEC_NODE_ID.test(id)) return undefined;
  const title = str(v.title);
  const cls = str(v.class);
  const base = { id, ...(title !== undefined ? { title } : {}), ...(cls ? { class: cls } : {}) };
  switch (str(v.kind)) {
    case "agent": {
      const prompt = str(v.prompt);
      if (!prompt || !SPEC_PROMPT_ID.test(prompt)) return undefined;
      const requires = str(v.requires);
      const config = parseAgentConfig(v.config);
      const maxVisits = posInt(v.maxVisits);
      return {
        ...base, kind: "agent", prompt, reads: strArray(v.reads), writes: strArray(v.writes),
        ...(maxVisits !== undefined ? { maxVisits } : {}),
        ...(v.readOnly === true ? { readOnly: true as const } : {}),
        ...(requires ? { requires } : {}),
        ...(config ? { config } : {}),
      };
    }
    case "command": {
      const run = str(v.run);
      if (run === undefined) return undefined;
      const timeoutMs = posInt(v.timeoutMs);
      const maxVisits = posInt(v.maxVisits);
      return {
        ...base, kind: "command", run, reads: strArray(v.reads), writes: strArray(v.writes),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(maxVisits !== undefined ? { maxVisits } : {}),
      };
    }
    case "worktree": {
      const action = oneOf(v.action, ["create", "remove"] as const);
      return action ? { ...base, kind: "worktree", action, writes: strArray(v.writes) } : undefined;
    }
    case "wait": {
      const duration = str(v.duration);
      return duration === undefined ? undefined : { ...base, kind: "wait", duration };
    }
    case "approval": {
      const [proposal, snapshot, decision, feedback, redesignTo] = [str(v.proposal), str(v.base), str(v.decision), str(v.feedback), str(v.redesignTo)];
      if (!proposal || !snapshot || !decision || !feedback || !redesignTo) return undefined;
      return { ...base, kind: "approval", proposal, base: snapshot, decision, feedback, redesignTo };
    }
    case "terminal": {
      const outcome = oneOf(v.outcome, OUTCOMES);
      const label = str(v.label);
      return outcome ? { id, kind: "terminal", outcome, ...(title !== undefined ? { title } : {}), ...(label ? { label } : {}) } : undefined;
    }
    default:
      return undefined;
  }
}

export function parseGraphSpec(value: unknown): ParseResult {
  if (!isObj(value)) return { ok: false, error: "the spec must be an object" };
  if (value.version !== SPEC_VERSION) return { ok: false, error: `unsupported spec version ${String(value.version)} (this Howdah speaks ${SPEC_VERSION})` };
  const name = str(value.name);
  if (!name || !SPEC_GRAPH_NAME.test(name)) return { ok: false, error: `graph name must be kebab-case: "${String(value.name)}"` };
  if (!Array.isArray(value.nodes)) return { ok: false, error: "the spec must carry a list of steps" };
  if (!Array.isArray(value.edges)) return { ok: false, error: "the spec must carry a list of edges" };
  if (!Array.isArray(value.fields)) return { ok: false, error: "the spec must carry a list of fields" };

  const fields: FieldSpec[] = [];
  for (const raw of value.fields) {
    if (!isObj(raw)) return { ok: false, error: "a field is not an object" };
    const key = str(raw.key);
    const kind = oneOf(raw.kind, FIELD_KINDS);
    const scope = oneOf(raw.scope, SCOPES);
    if (!key || !SPEC_FIELD_KEY.test(key)) return { ok: false, error: `"${String(raw.key)}" is not a usable field name` };
    if (!kind || !scope) return { ok: false, error: `field "${key}" needs a kind and a freshness` };
    const choices = strArray(raw.choices);
    const description = str(raw.description);
    fields.push({ key, kind, scope, ...(choices.length ? { choices } : {}), ...(description ? { description } : {}) });
  }

  const nodes: NodeSpec[] = [];
  for (const raw of value.nodes) {
    const n = parseNode(raw);
    if (!n) return { ok: false, error: `a step is malformed: ${JSON.stringify(raw).slice(0, 160)}` };
    nodes.push(n);
  }

  const edges: EdgeSpec[] = [];
  for (const raw of value.edges) {
    if (!isObj(raw)) return { ok: false, error: "an edge is not an object" };
    const from = str(raw.from);
    const to = str(raw.to);
    if (!from || !to) return { ok: false, error: "an edge is missing its from/to" };
    const when = raw.when === undefined || raw.when === null ? undefined : parsePredicate(raw.when);
    if (raw.when !== undefined && raw.when !== null && !when) return { ok: false, error: `the condition on ${from} → ${to} is malformed` };
    edges.push({ from, to, ...(when ? { when } : {}) });
  }

  const defaults = parseAgentConfig(value.defaults);
  return {
    ok: true,
    spec: {
      version: SPEC_VERSION,
      name,
      description: str(value.description) ?? "",
      fields,
      inputs: strArray(value.inputs),
      ...(defaults ? { defaults } : {}),
      entry: str(value.entry) ?? nodes[0]?.id ?? "",
      nodes,
      edges,
    },
  };
}

/** `my-review` + `draft` → `my-review.draft`: a prompt id no other graph can collide with —
 *  enforced by `specProblems` and again by `graphs/builder.ts`, because local prompts share one
 *  directory and the `<graph>.` prefix is the only thing keeping them apart (HOW-22 review). */
export function promptIdFor(graphName: string, nodeId: string): string {
  return `${graphName}.${nodeId}`;
}

/** The spec a loaded graph was built from, or null when it was not built here (R1). */
export function specOf(graph: Graph<any>): GraphSpec | null {
  const spec = graph.def.spec;
  if (spec === undefined) return null;
  const parsed = parseGraphSpec(spec);
  return parsed.ok ? parsed.spec : null;
}
