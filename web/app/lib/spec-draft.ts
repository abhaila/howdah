/**
 * The graph builder's draft (HOW-22) — one GraphSpec plus the prompt bodies its agent steps
 * own, and every edit to them as a pure reducer.
 *
 * It is a reducer rather than a dozen setState closures because the edits are COUPLED, and
 * quietly so: removing a step also removes the edges that named it, the instructions it owned
 * and may orphan the entry; renaming the graph (before its first save) moves every agent
 * step's prompt id and the bodies with it; renaming a FIELD has to follow the key into the
 * prompt bodies that reference it and re-type the operands that compare against it; removing
 * one has to take the branch rows that tested it. Each of those is one action here, and one
 * test, instead of a rule that has to be remembered at four call sites.
 *
 * Two invariants every action must leave standing, because they are what stops the browser's
 * verdict and the server's gate from disagreeing (HOW-22 review):
 *
 *   For every agent step, `reads` === templateReads(the body it names). graphs/builder.ts
 *   derives exactly that when it writes the file, so any action that edits one without the
 *   other ships a draft that looks clean here and is refused there.
 *
 *   For every step, `writes` ⊆ emittableWrites(step) — what its executor can actually
 *   publish. That is normalised HERE rather than in a form, because there are two forms and
 *   only one of them used to remember.
 *
 * Nothing here touches the network. The draft is validated in the browser by
 * `specProblems()` (core/graph-spec.ts is node-free precisely so it can be), and the server
 * runs the real gate again at save — so the builder can answer on every keystroke without a
 * round trip, and still cannot be the thing that decides a graph is legal.
 */
import {
  emittableWrites, predicateLabel, promptIdFor, recoercePredicate, specProblems, stepTitle,
  type FieldKind, type FieldSpec, type GraphSpec, type NodeSpec, type Predicate, type ProblemPane, type SpecProblem,
} from "../../../core/graph-spec";
import { renameTemplateRef, templateReads } from "../../../core/template-refs";
import type { AgentConfig } from "../../../core/graph";
import type { Scope } from "../../../core/context";
import type { GraphShapeDto } from "../graph-dag";

export interface Draft {
  spec: GraphSpec;
  /** prompt id → body, for the agent steps; only what the operator has opened or written */
  prompts: Record<string, string>;
  /** false until the graph exists on disk: the name is the file name, so it stops moving */
  saved: boolean;
}

export type StepKind = NodeSpec["kind"];

/** The Add-a-step menu, in the operator's words rather than the schema's. */
export const STEP_KINDS: Array<{ kind: StepKind; label: string; help: string }> = [
  { kind: "agent", label: "Ask an agent", help: "Give an agent instructions and collect what it produces." },
  { kind: "command", label: "Run a command", help: "Run a script, or one of Howdah's built-in probes." },
  { kind: "worktree", label: "Make or clean up a worktree", help: "An isolated checkout on its own branch." },
  { kind: "wait", label: "Wait", help: "Pause for a while — let CI settle, let a review land." },
  { kind: "approval", label: "Get my approval", help: "Stop and wait for you to approve or ask for changes." },
  { kind: "terminal", label: "Finish", help: "End the run with an outcome." },
];

/** Freshness, asked once per field, in plain language (core/context.ts owns the semantics). */
export const SCOPE_CHOICES: Array<{ scope: Scope; label: string; help: string }> = [
  { scope: "sticky", label: "Keep the last good value", help: "Until a newer one lands. The usual answer." },
  { scope: "cleared", label: "Redo it when the step runs again", help: "Hidden while the step retries; restored if the retry fails." },
  { scope: "per-visit", label: "Always fresh", help: "Re-entering the step that writes it throws the old value away for good." },
];

export const FIELD_KINDS: Array<{ kind: FieldKind; label: string }> = [
  { kind: "text", label: "Text" },
  { kind: "choice", label: "One of a few choices" },
  { kind: "number", label: "Number" },
  { kind: "boolean", label: "Yes / no" },
  { kind: "json", label: "Structured (JSON)" },
];

// ---- ids -------------------------------------------------------------------------------

const slug = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

/**
 * A step id, derived ONCE from whatever the step is called when it is added, then frozen.
 * Visit identity is `${node}#${visit}`, so an id that moved would rewrite history; the title
 * is what an operator renames.
 */
export function nextNodeId(spec: GraphSpec, seed: string): string {
  const base = slug(seed) || "step";
  const taken = new Set(spec.nodes.map((n) => n.id));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

function uniqueFieldKey(spec: GraphSpec, seed: string): string {
  const base = seed.replace(/[^A-Za-z0-9_.]/g, "_").replace(/^[^A-Za-z_]+/, "") || "value";
  const taken = new Set(spec.fields.map((f) => f.key));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

// ---- actions ---------------------------------------------------------------------------

export type DraftAction =
  | { type: "load"; draft: Draft }
  | { type: "set-name"; name: string }
  | { type: "set-description"; description: string }
  | { type: "set-entry"; id: string }
  | { type: "set-defaults"; config: AgentConfig }
  | { type: "add-field"; seed?: string; patch?: Partial<FieldSpec> }
  | { type: "update-field"; key: string; patch: Partial<FieldSpec> }
  | { type: "remove-field"; key: string }
  | { type: "toggle-input"; key: string }
  | { type: "add-step"; node: NodeSpec; body?: string; fields?: FieldSpec[] }
  | { type: "update-step"; id: string; node: NodeSpec }
  | { type: "remove-step"; id: string }
  | { type: "move-step"; id: string; by: 1 | -1 }
  | { type: "set-branching"; from: string; edges: Array<{ to: string; when?: Predicate }> }
  | { type: "set-prompt"; id: string; body: string };

const withoutKey = (keys: string[], key: string) => keys.filter((k) => k !== key);

function renameGraph(draft: Draft, name: string): Draft {
  const old = draft.spec.name;
  const prompts = { ...draft.prompts };
  const nodes = draft.spec.nodes.map((n) => {
    if (n.kind !== "agent" || n.prompt !== promptIdFor(old, n.id)) return n;
    const next = promptIdFor(name, n.id);
    if (prompts[n.prompt] !== undefined) {
      prompts[next] = prompts[n.prompt]!;
      delete prompts[n.prompt];
    }
    return { ...n, prompt: next };
  });
  return { ...draft, spec: { ...draft.spec, name, nodes }, prompts };
}

export function draftReducer(draft: Draft, action: DraftAction): Draft {
  const spec = draft.spec;
  switch (action.type) {
    case "load":
      return action.draft;
    case "set-name":
      // the name is the FILE name; once the file exists it stops being editable here
      return draft.saved ? draft : renameGraph(draft, action.name);
    case "set-description":
      return { ...draft, spec: { ...spec, description: action.description } };
    case "set-entry":
      return { ...draft, spec: { ...spec, entry: action.id } };
    case "set-defaults":
      return { ...draft, spec: { ...spec, defaults: action.config } };

    case "add-field": {
      const key = uniqueFieldKey(spec, action.patch?.key ?? action.seed ?? "value");
      const field: FieldSpec = { key, kind: "text", scope: "sticky", ...action.patch, ...(action.patch?.key ? { key } : {}) };
      return spec.fields.some((f) => f.key === key) ? draft : { ...draft, spec: { ...spec, fields: [...spec.fields, field] } };
    }
    case "update-field": {
      const patch = action.patch;
      const was = spec.fields.find((f) => f.key === action.key);
      const renamed = patch.key !== undefined && patch.key !== action.key ? patch.key : null;
      const kind = patch.kind !== undefined && patch.kind !== was?.kind ? patch.kind : null;
      // a rename has to follow the key everywhere it is used, or the draft silently breaks
      const rename = (k: string) => (renamed && k === action.key ? renamed : k);
      const fields = spec.fields.map((f) => (f.key === action.key ? { ...f, ...patch } : f));
      if (!renamed && !kind) return { ...draft, spec: { ...spec, fields } };

      // THE BODIES FOLLOW THE RENAME. An agent's `reads` is read out of its instructions, so
      // swapping the declaration without the text would leave the two contradicting each
      // other — the draft would look clean here and be refused at save. renameTemplateRef()
      // rewrites through the template grammar, never by string replace, so `goalkeeper` and
      // the word "goal" in prose are untouched (core/template-refs.ts).
      const prompts = renamed
        ? Object.fromEntries(Object.entries(draft.prompts).map(([id, body]) => [id, renameTemplateRef(body, action.key, renamed)]))
        : draft.prompts;
      const renamedNodes = renamed ? spec.nodes.map((n) => renameInNode(n, action.key, renamed)) : spec.nodes;
      return {
        ...draft,
        prompts,
        spec: {
          ...spec,
          fields,
          inputs: renamed ? spec.inputs.map(rename) : spec.inputs,
          // ...and `reads` comes back off the rewritten body, not off the swap above, so the
          // invariant holds after every action: reads === templateReads(its body)
          nodes: renamedNodes.map((n) => (n.kind === "agent" ? withDerivedReads(n, prompts[n.prompt]) : n)),
          edges: spec.edges.map((e) => {
            if (!e.when || e.when.key !== action.key) return e;
            // a field flipped to Yes/no leaves `value: "reject"` comparing a string against a
            // boolean — displayed as "is yes", never matching. The kind owns its operands.
            const keyed = renamed ? { ...e.when, key: renamed } : e.when;
            return { ...e, when: kind ? recoercePredicate(keyed, kind) : keyed };
          }),
        },
      };
    }
    case "remove-field": {
      const key = action.key;
      return {
        ...draft,
        spec: {
          ...spec,
          fields: spec.fields.filter((f) => f.key !== key),
          inputs: withoutKey(spec.inputs, key),
          nodes: spec.nodes.map((n) => dropKeyFromNode(n, key)),
          // a branch that tested a field that no longer exists is removed rather than left
          // dangling: the step may then dead-end, which the rail says in so many words
          edges: spec.edges.filter((e) => !(e.when && e.when.key === key)),
        },
      };
    }
    case "toggle-input": {
      const has = spec.inputs.includes(action.key);
      return { ...draft, spec: { ...spec, inputs: has ? withoutKey(spec.inputs, action.key) : [...spec.inputs, action.key] } };
    }

    case "add-step": {
      const nodes = [...spec.nodes, withEmittableWrites(withDerivedReads(action.node, action.body))];
      const entry = spec.nodes.length === 0 ? action.node.id : spec.entry;
      const prompts = action.body !== undefined && action.node.kind === "agent"
        ? { ...draft.prompts, [action.node.prompt]: action.body }
        : draft.prompts;
      // an approval step brings its own four keys: they are structural, not a choice, so the
      // operator is never asked to invent them (core/graph.ts ApprovalNodeDef)
      const taken = new Set(spec.fields.map((f) => f.key));
      const fields = [...spec.fields, ...(action.fields ?? []).filter((f) => !taken.has(f.key))];
      return { ...draft, prompts, spec: { ...spec, nodes, entry, fields } };
    }
    case "update-step":
      return { ...draft, spec: { ...spec, nodes: spec.nodes.map((n) => (n.id === action.id ? withEmittableWrites(action.node) : n)) } };
    case "remove-step": {
      const nodes = spec.nodes.filter((n) => n.id !== action.id);
      // the step's instructions go with it. graphs/builder.ts refuses a prompt body no step
      // names — rightly, since the id is a file path — so a body left behind here blocked
      // every later save with a message naming a step that was already gone. Two steps MAY
      // share one prompt id, so the body only goes when nothing still names it.
      const gone = spec.nodes.find((n) => n.id === action.id);
      const prompts = { ...draft.prompts };
      if (gone?.kind === "agent" && !nodes.some((n) => n.kind === "agent" && n.prompt === gone.prompt))
        delete prompts[gone.prompt];
      return {
        ...draft,
        prompts,
        spec: {
          ...spec,
          nodes,
          edges: spec.edges.filter((e) => e.from !== action.id && e.to !== action.id),
          entry: spec.entry === action.id ? (nodes[0]?.id ?? "") : spec.entry,
          // an approval step pointing at the removed one is left to say so in the rail
        },
      };
    }
    case "move-step": {
      const i = spec.nodes.findIndex((n) => n.id === action.id);
      const j = i + action.by;
      if (i < 0 || j < 0 || j >= spec.nodes.length) return draft;
      const nodes = [...spec.nodes];
      [nodes[i], nodes[j]] = [nodes[j]!, nodes[i]!];
      return { ...draft, spec: { ...spec, nodes } };
    }

    case "set-branching": {
      // the rows REPLACE this step's outgoing edges, in order: first conditional row wins
      const others = spec.edges.filter((e) => e.from !== action.from);
      const mine = action.edges.map((e) => ({ from: action.from, to: e.to, ...(e.when ? { when: e.when } : {}) }));
      return { ...draft, spec: { ...spec, edges: [...others, ...mine] } };
    }
    case "set-prompt":
      return {
        ...draft,
        prompts: { ...draft.prompts, [action.id]: action.body },
        // writing the instructions IS declaring what the step is given — see below
        spec: { ...spec, nodes: spec.nodes.map((n) => (n.kind === "agent" && n.prompt === action.id ? withDerivedReads(n, action.body) : n)) },
      };
  }
}

/**
 * An agent's `reads` comes from its prompt body and from nowhere else — the same
 * `templateReads()` graphs/builder.ts runs when it writes the file (and core/template.ts
 * re-exports). Doing it here as well is not duplication but the POINT: the draft must be the
 * same graph the server will build, or the browser's live verdict would quietly never report
 * the one problem that matters most — "this step is given `summary`, but nothing writes it on
 * every path that reaches it". That check reads `node.reads`.
 */
function withDerivedReads(n: NodeSpec, body: string | undefined): NodeSpec {
  return n.kind === "agent" && body !== undefined ? { ...n, reads: templateReads(body) } : n;
}

/**
 * The writes a step is allowed to declare, applied on every step edit. It is the REDUCER's
 * job rather than a form's because a form fix leaves the next call site to remember: the
 * command form had this filter and the worktree form did not, so flipping a clean-up step to
 * "make" kept a fact the create branch never publishes — and the form then hid it, because it
 * only offered the keys the NEW action emits (HOW-22 review, finding 3).
 */
function withEmittableWrites(n: NodeSpec): NodeSpec {
  const only = emittableWrites(n);
  if (!only || !("writes" in n)) return n;
  const writes = n.writes.filter((k) => only.includes(k));
  return writes.length === n.writes.length ? n : { ...n, writes };
}

/** The same rule over a whole draft — what a preset is normalised through. */
export function deriveDraftReads(draft: Draft): Draft {
  return {
    ...draft,
    spec: {
      ...draft.spec,
      nodes: draft.spec.nodes.map((n) => withDerivedReads(n, n.kind === "agent" ? draft.prompts[n.prompt] : undefined)),
    },
  };
}

function renameInNode(n: NodeSpec, from: string, to: string): NodeSpec {
  const swap = (keys: string[]) => keys.map((k) => (k === from ? to : k));
  const one = (k: string) => (k === from ? to : k);
  switch (n.kind) {
    case "agent":
    case "command":
      return { ...n, reads: swap(n.reads), writes: swap(n.writes) };
    case "worktree":
      return { ...n, writes: swap(n.writes) };
    case "approval":
      return { ...n, proposal: one(n.proposal), base: one(n.base), decision: one(n.decision), feedback: one(n.feedback) };
    default:
      return n;
  }
}

function dropKeyFromNode(n: NodeSpec, key: string): NodeSpec {
  switch (n.kind) {
    case "agent":
      // an agent's `reads` is the instructions' own list and is not ours to edit. There is no
      // correct rewrite of a body that asks for a field that no longer exists, so it is a
      // problem to REPORT (specProblems, in the steps pane) rather than one to paper over by
      // quietly disagreeing with the text the server will read.
      return { ...n, writes: withoutKey(n.writes, key) };
    case "command":
      return { ...n, reads: withoutKey(n.reads, key), writes: withoutKey(n.writes, key) };
    case "worktree":
      return { ...n, writes: withoutKey(n.writes, key) };
    default:
      // an approval step's four keys are structural: removing one is a problem to REPORT,
      // not to paper over by quietly emptying the step
      return n;
  }
}

// ---- reading the draft -------------------------------------------------------------------

/**
 * Problems per builder pane, so the rail can show a count and each pane can print only what
 * it can fix. The pane comes from `SpecProblem.where`, which core/graph-spec.ts sets at every
 * report site — this never sniffs it back out of the wording.
 */
export function problemsByPane(problems: SpecProblem[]): Record<ProblemPane, SpecProblem[]> {
  const out: Record<ProblemPane, SpecProblem[]> = { basics: [], fields: [], steps: [], branching: [] };
  for (const p of problems) out[p.where].push(p);
  return out;
}

/**
 * The bodies the spec's own agent steps name — what a save POSTS, rather than `draft.prompts`
 * wholesale. graphs/builder.ts refuses an id no step names (the id is a file path, so an id
 * from the network that nothing asked for has no business existing); deriving the payload
 * from the spec makes that refusal structurally unreachable instead of merely defended
 * against, whatever a future reducer path leaves in the map.
 */
export function pickPrompts(draft: Draft): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of draft.spec.nodes)
    if (n.kind === "agent" && draft.prompts[n.prompt] !== undefined) out[n.prompt] = draft.prompts[n.prompt]!;
  return out;
}

export function draftProblems(draft: Draft): SpecProblem[] {
  // a prompt is "known" if the operator has written one here or it already exists on disk;
  // the builder seeds every agent step with a body, so an empty map means "do not check"
  const known = Object.keys(draft.prompts);
  return specProblems(draft.spec, known.length ? { knownPrompts: known } : {});
}

/** The DAG's DTO, straight off the draft — no fetch, so the picture moves with the typing. */
export function specToShape(spec: GraphSpec): GraphShapeDto {
  return {
    name: spec.name || "untitled",
    description: spec.description,
    entry: spec.entry,
    inputs: [...spec.inputs],
    defaults: spec.defaults,
    nodes: spec.nodes.map((n) => ({
      id: n.id,
      // the builder's picture speaks in TITLES; the id stays what the run DAG and the log say
      title: stepTitle(spec, n.id),
      kind: n.kind,
      ...(n.kind === "agent" ? { prompt: n.prompt, harness: n.config?.harness, model: n.config?.model, effort: n.config?.effort } : {}),
      ...(n.kind === "command" ? { run: n.run } : {}),
      ...(n.kind === "wait" ? { duration: n.duration } : {}),
      ...(n.kind === "terminal" ? { outcome: n.outcome } : {}),
      ...("maxVisits" in n && n.maxVisits !== undefined ? { maxVisits: n.maxVisits } : {}),
      ...(n.kind !== "terminal" && n.class ? { class: n.class } : {}),
    })),
    // the caption is the SAME label the compiled graph carries (core/graph-spec.ts), so the
    // preview and the run's own DAG cannot read differently
    edges: spec.edges.map((e) => ({ from: e.from, to: e.to, ...(e.when ? { label: predicateLabel(e.when) } : {}) })),
  };
}

// ---- starting points ---------------------------------------------------------------------

/** A preset's agent step. `reads` is deliberately absent: deriveDraftReads() fills it from
 *  the body below, so a preset cannot ship a declaration its own instructions contradict. */
const agent = (name: string, id: string, title: string, writes: string[], over: Partial<Extract<NodeSpec, { kind: "agent" }>> = {}): NodeSpec =>
  ({ id, kind: "agent", title, prompt: promptIdFor(name, id), reads: [], writes, ...over });

export interface Preset {
  id: string;
  label: string;
  description: string;
  build(name: string): Draft;
}

const PRESET_DEFS: Preset[] = [
  {
    id: "blank",
    label: "Blank",
    description: "One step and a finish. Grow it from there.",
    build: (name) => ({
      saved: false,
      prompts: { [promptIdFor(name, "work")]: "Do the work.\n\nGoal: {{ context.goal }}\n\nReturn a summary of what you did." },
      spec: {
        version: 1, name, description: "",
        fields: [
          { key: "goal", kind: "text", scope: "sticky", description: "what this run is for" },
          { key: "summary", kind: "text", scope: "sticky" },
        ],
        inputs: ["goal"],
        defaults: { permissionMode: "auto" },
        entry: "work",
        nodes: [agent(name, "work", "Do the work", ["summary"]), { id: "done", kind: "terminal", outcome: "success" }],
        edges: [{ from: "work", to: "done" }],
      },
    }),
  },
  {
    id: "doc",
    label: "Draft, review, revise",
    description: "An agent drafts, another reviews, and the loop closes when the review passes.",
    build: (name) => ({
      saved: false,
      prompts: {
        [promptIdFor(name, "draft")]: "Write the deliverable.\n\nGoal: {{ context.goal }}\n\nWork item: {{ context.work }}\n\nProduce it in the working folder and return a summary.",
        [promptIdFor(name, "review")]: "Review the work against the goal.\n\nGoal: {{ context.goal }}\n\nSummary so far: {{ context.summary }}\n\nSay \"pass\" only if the goal is met; otherwise \"reject\" with specific findings.",
        [promptIdFor(name, "revise")]: "Resolve the review findings.\n\nGoal: {{ context.goal }}\n\nCurrent summary: {{ context.summary }}\n\nFindings: {{ context.review_findings }}\n\nEdit the deliverable and return an updated summary.",
      },
      spec: {
        version: 1, name, description: "",
        fields: [
          { key: "goal", kind: "text", scope: "sticky", description: "what this run is for" },
          { key: "work", kind: "text", scope: "sticky", description: "the thing being worked on" },
          { key: "summary", kind: "text", scope: "sticky" },
          { key: "review_verdict", kind: "choice", scope: "cleared", choices: ["pass", "reject"] },
          { key: "review_findings", kind: "json", scope: "cleared" },
        ],
        inputs: ["goal", "work"],
        defaults: { permissionMode: "auto" },
        entry: "draft",
        nodes: [
          agent(name, "draft", "Draft it", ["summary"]),
          agent(name, "review", "Review it", ["review_verdict", "review_findings"]),
          agent(name, "revise", "Revise it", ["summary"], { maxVisits: 3 }),
          { id: "done", kind: "terminal", outcome: "success" },
        ],
        edges: [
          { from: "draft", to: "review" },
          { from: "review", to: "revise", when: { op: "equals", key: "review_verdict", value: "reject" } },
          { from: "review", to: "done", when: { op: "equals", key: "review_verdict", value: "pass" } },
          { from: "revise", to: "review" },
        ],
      },
    }),
  },
  {
    id: "code",
    label: "Change some code",
    description: "A worktree, an agent that changes code, a review loop, and a clean-up that refuses to destroy local work.",
    build: (name) => ({
      saved: false,
      prompts: {
        [promptIdFor(name, "implement")]: "Make the change.\n\nGoal: {{ context.goal }}\n\nWork item: {{ context.work }}\n\nRun the project's checks and return a summary of what you changed.",
        [promptIdFor(name, "review")]: "Review the change against the goal.\n\nGoal: {{ context.goal }}\n\nSummary: {{ context.summary }}\n\nSay \"pass\" only if it is right; otherwise \"reject\" with specific findings.",
      },
      spec: {
        version: 1, name, description: "",
        fields: [
          { key: "goal", kind: "text", scope: "sticky", description: "what this run is for" },
          { key: "work", kind: "text", scope: "sticky", description: "the ticket or work item" },
          { key: "summary", kind: "text", scope: "sticky" },
          { key: "review_verdict", kind: "choice", scope: "cleared", choices: ["pass", "reject"] },
          { key: "review_findings", kind: "json", scope: "cleared" },
          { key: "worktree.clean", kind: "boolean", scope: "per-visit" },
        ],
        inputs: ["goal", "work"],
        defaults: { permissionMode: "auto" },
        entry: "make-worktree",
        nodes: [
          { id: "make-worktree", kind: "worktree", title: "Make a worktree", action: "create", writes: [] },
          agent(name, "implement", "Make the change", ["summary"], { maxVisits: 4 }),
          agent(name, "review", "Review the change", ["review_verdict", "review_findings"]),
          { id: "clean-up", kind: "worktree", title: "Clean up the worktree", action: "remove", writes: ["worktree.clean"] },
          { id: "done", kind: "terminal", outcome: "success" },
          { id: "retained", kind: "terminal", outcome: "failed", label: "Worktree kept — it still has local work" },
        ],
        edges: [
          { from: "make-worktree", to: "implement" },
          { from: "implement", to: "review" },
          { from: "review", to: "implement", when: { op: "equals", key: "review_verdict", value: "reject" } },
          { from: "review", to: "clean-up", when: { op: "equals", key: "review_verdict", value: "pass" } },
          { from: "clean-up", to: "done", when: { op: "is-true", key: "worktree.clean" } },
          { from: "clean-up", to: "retained" },
        ],
      },
    }),
  },
];

/**
 * The starting points, each one passed through deriveDraftReads() so what its agent steps
 * are GIVEN is read out of the instructions it ships with — the same rule the wizard applies
 * to every keystroke and graphs/builder.ts applies when it writes the file.
 */
export const PRESETS: Preset[] = PRESET_DEFS.map((p) => ({ ...p, build: (name: string) => deriveDraftReads(p.build(name)) }));

/** A new step of one kind, with the defaults its form would otherwise make you fill in. */
export function newStep(spec: GraphSpec, kind: StepKind, title: string): { node: NodeSpec; body?: string; fields?: FieldSpec[] } {
  const id = nextNodeId(spec, title);
  switch (kind) {
    case "agent":
      return {
        node: { id, kind: "agent", title, prompt: promptIdFor(spec.name, id), reads: [], writes: [] },
        body: "Do the work.\n\nReturn a summary of what you did.",
      };
    case "command":
      return { node: { id, kind: "command", title, run: "probe:pr", reads: [], writes: [] } };
    case "worktree":
      return { node: { id, kind: "worktree", title, action: "create", writes: [] } };
    case "wait":
      return { node: { id, kind: "wait", title, duration: "30 s" } };
    case "approval": {
      // the decision and comments keys are the step's own and belong to nobody else; the
      // proposal and base keys name what ANOTHER step drew, so the form asks for those
      const stem = id.replace(/-/g, "_");
      const decision = `${stem}_decision`;
      const feedback = `${stem}_feedback`;
      return {
        node: { id, kind: "approval", title, proposal: "", base: "", decision, feedback, redesignTo: "" },
        fields: [
          { key: decision, kind: "json", scope: "per-visit", description: "what you decided on the current round" },
          { key: feedback, kind: "json", scope: "sticky", description: "the comments sent with your decision" },
        ],
      };
    }
    case "terminal":
      return { node: { id, kind: "terminal", title, outcome: "success" } };
  }
}
