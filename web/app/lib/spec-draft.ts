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
 *   For every agent step, `reads` === derivedReads(step, the body it names) — the body's
 *   template refs plus the engine's structural reads (HOW-74). graphs/builder.ts
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
  SPEC_NODE_ID, coerceOperand, derivedReads, emittableWrites, isBlocking, nameTakenProblem, predicateLabel, promptIdFor, renameDraft,
  recoercePredicate, specProblems,
  type EdgeSpec, type FieldKind, type FieldSpec, type GraphSpec, type NodeSpec, type Point, type Predicate,
  type ProblemPane, type SpecProblem,
} from "../../../core/graph-spec";
import { renameTemplateRef, templateReads } from "../../../core/template-refs";
import { autoLayout, nextFreePosition } from "./layout";
import type { AgentConfig } from "../../../core/graph";
import type { Scope } from "../../../core/context";

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

/**
 * A step id out of whatever the operator called the step. It MUST satisfy SPEC_NODE_ID
 * (core/graph-spec.ts) — a leading letter, then [a-z0-9._-] — because everything downstream
 * treats an id as legal BY CONSTRUCTION: `specProblems` refuses a graph whose id is not,
 * `newStep`'s approval case derives two FIELD keys from it, and the prompt file is named
 * after it. Since HOW-26 the seed is operator free text rather than a menu label, so the
 * leading-letter rule has to be ENFORCED here rather than assumed.
 *
 * A leading non-letter is PREFIXED, not stripped: `step-1st-draft` keeps the operator's own
 * words — and the live preview under the name box shows it to them — where `st-draft` would
 * silently eat one. (`uniqueFieldKey` below strips instead, deliberately: a field key is
 * TYPED and echoed back verbatim, while a step id is DERIVED from prose.)
 */
const slug = (text: string): string => {
  const core = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!core) return "step";
  // the 32-character cut can leave a dangling hyphen — legal under the regex, but not a name
  // to hand anyone
  return (/^[a-z]/.test(core) ? core : `step-${core}`).slice(0, 32).replace(/-+$/, "") || "step";
};

/**
 * A step id, derived ONCE from whatever the step is called when it is added, then frozen.
 * Visit identity is `${node}#${visit}`, so an id that moved would rewrite history; the title
 * is what an operator renames.
 */
export function nextNodeId(spec: GraphSpec, seed: string): string {
  const base = slug(seed);                       // always satisfies SPEC_NODE_ID, by construction
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
  | { type: "add-step"; node: NodeSpec; body?: string; fields?: FieldSpec[]; position?: Point }
  | { type: "update-step"; id: string; node: NodeSpec }
  | { type: "rename-step"; id: string; to: string }
  | { type: "remove-step"; id: string }
  | { type: "move-step"; id: string; by: 1 | -1 }
  /** HOW-24: a step dragged on the canvas. Dispatched on drag END, never per frame — one
   *  drag is one draft change, so draftProblems() is not re-run sixty times a second. */
  | { type: "move-node"; id: string; position: Point }
  | { type: "set-branching"; from: string; edges: Array<{ to: string; when?: Predicate }> }
  /** HOW-24: the canvas's three edge edits. An edge has no identity of its own, so it is
   *  addressed by its index in `spec.edges` — which is also what makes row order, and
   *  therefore priority, directly editable. */
  | { type: "add-edge"; from: string; to: string }
  | { type: "update-edge"; index: number; patch: { to?: string; when?: Predicate | null } }
  | { type: "remove-edge"; index: number }
  | { type: "set-prompt"; id: string; body: string };

/** The one shape an edge is ever built in, so the panel path and the canvas path cannot
 *  produce two different things for the same route. */
const edgeOf = (from: string, to: string, when?: Predicate): EdgeSpec => ({ from, to, ...(when ? { when } : {}) });

/**
 * A CONDITION ROW IS BORN ABLE TO FIRE. The operand is seeded through `coerceOperand`, so a new
 * row on a yes/no field is `flag == false` and on a number field `count == 0` — never `== ''`,
 * which is a predicate no runtime value can satisfy and which saved clean (HOW-22 review,
 * finding 3). On a text or choice field it is still "", and `specProblems` says so.
 *
 * Exported because there are now TWO creation paths — "Add a condition" in a step's routes and
 * a wire drawn between two handles — and it was the CREATION path forgetting this rule that
 * produced the defect in the first place.
 */
export function seedPredicate(spec: GraphSpec): Predicate {
  const first = spec.fields[0];
  return { op: "equals", key: first?.key ?? "", value: coerceOperand("", first?.kind) };
}

const withoutKey = (keys: string[], key: string) => keys.filter((k) => k !== key);

/**
 * The starting step, kept RUNNABLE. A Finish step cannot be one — `core/graph.ts` validate()
 * refuses it and `specProblems` says so in Basics' words — so removing the entry falls through
 * to the first step that can actually run, rather than to `nodes[0]`, which may be the Finish
 * step an operator dragged to the top (HOW-22 review, finding 1). It also repairs an entry
 * left stale for any other reason, which is why `add-step` goes through it too.
 *
 * `set-entry` deliberately does NOT: an explicit operator choice is honoured, the picker
 * cannot offer a terminal, and anything arriving from elsewhere is REPORTED rather than moved
 * behind their back.
 */
function pickEntry(nodes: NodeSpec[], current: string): string {
  if (nodes.some((n) => n.id === current && n.kind !== "terminal")) return current;
  return nodes.find((n) => n.kind !== "terminal")?.id ?? "";
}

/** core/graph-spec.ts renameDraft: the one rename the draft card's Save runs too (HOW-65). */
function renameGraph(draft: Draft, name: string): Draft {
  const { spec, bodies } = renameDraft(draft.spec, draft.prompts, name);
  return { ...draft, spec, prompts: bodies };
}

/**
 * Whether `renameStep` below would actually land — the refusal, hoisted out so the BUTTON
 * that offers a rename and the reducer that performs one are held to ONE rule.
 *
 * They drifted before: the form computed its suggestion over the whole spec, so a correctly
 * named step was offered `<id>-2` and the refusal never fired; and a suggestion the reducer
 * DID refuse still moved the dialog's open step to an id that does not exist, so the form
 * returned null and the dialog vanished with nothing said. One predicate, two callers.
 */
export const canRenameStep = (spec: GraphSpec, id: string, to: string): boolean =>
  spec.nodes.some((n) => n.id === id) && to !== id
  && SPEC_NODE_ID.test(to) && !spec.nodes.some((n) => n.id === to);

/**
 * A step's ID, moved — and everything that names it moved with it (HOW-26).
 *
 * The id is FROZEN at add time everywhere else, and for a good reason: `${node}#${visit}` is
 * run identity, so an id that moves rewrites nothing but stops matching what already
 * happened. That reason survives here — a past run keeps the old id and its rows still read,
 * because `web/derive.ts` builds the run view from the LOG and never looks at the graph. What
 * it costs is a run PARKED at this step, which cannot be resumed afterwards ("unknown node",
 * engine/run.ts loop). That is exactly the cost of REMOVING a step, which the builder has
 * always allowed, so this is not a new hazard — and the form says it in those words.
 *
 * It exists because HOW-26's graph could not be repaired any other way: every step was named
 * after the MENU ITEM that added it (`ask-an-agent-8`), and the id is what the prompt file is
 * called, so the instructions were filed under a name that says nothing either. Remove-and-
 * re-add was the only fix, and it loses the step's branching and its text.
 *
 * The cascade mirrors renameGraph's: id → its own prompt id (and the body under it) → every
 * edge → the approval steps that redesign to it → the agent steps that wait on it → the
 * entry. A no-op, an illegal id and a taken id all leave the draft alone, because a reducer
 * that half-applies is worse than one that refuses.
 */
function renameStep(draft: Draft, id: string, to: string): Draft {
  const spec = draft.spec;
  const gone = spec.nodes.find((n) => n.id === id);
  if (!gone || !canRenameStep(spec, id, to)) return draft;

  // the instructions follow the step only when they are ITS OWN — two steps may legitimately
  // share one body (remove-step relies on it), and moving a shared id would take the other
  // step's text with it
  const prompts = { ...draft.prompts };
  const owned =
    gone.kind === "agent" && gone.prompt === promptIdFor(spec.name, id)
    && !spec.nodes.some((n) => n.kind === "agent" && n.id !== id && n.prompt === gone.prompt)
      ? promptIdFor(spec.name, to)
      : null;
  if (owned && prompts[(gone as Extract<NodeSpec, { kind: "agent" }>).prompt] !== undefined) {
    prompts[owned] = prompts[(gone as Extract<NodeSpec, { kind: "agent" }>).prompt]!;
    delete prompts[(gone as Extract<NodeSpec, { kind: "agent" }>).prompt];
  }

  const swap = (ref: string) => (ref === id ? to : ref);
  const nodes = spec.nodes.map((n) => {
    const moved = n.id === id ? { ...n, id: to, ...(owned ? { prompt: owned } : {}) } : n;
    if (moved.kind === "agent" && moved.requires) return { ...moved, requires: swap(moved.requires) };
    if (moved.kind === "approval") return { ...moved, redesignTo: swap(moved.redesignTo) };
    return moved;
  });
  return {
    ...draft,
    prompts,
    spec: {
      ...spec,
      nodes,
      edges: spec.edges.map((e) => ({ ...e, from: swap(e.from), to: swap(e.to) })),
      entry: swap(spec.entry),
    },
  };
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

      // A CLEARED NAME IS NOT A RENAME. The box is emptied on the way to typing a new one, and
      // "" is FALSY — so the guard below read it as "no rename" while the field's key was still
      // set to "", after which every later keystroke renamed FROM "" and matched nothing:
      // bodies, reads, edges and inputs were left naming the old key for good, and only a hand
      // edit could fix it (HOW-22 review, finding 5). The rename is DEFERRED instead: the field
      // keeps the name it had, the pane keeps showing what was typed (useTypedText), and the
      // first real character renames from the ORIGINAL key in one cascade. Cascading "" is not
      // the alternative — renameTemplateRef(body, "goal", "") writes `{{ context. }}`, which is
      // no longer a reference, so the next keystroke could not find it.
      //
      // Anything ELSE in the patch still applies, so a blank name cannot silently swallow a
      // kind or scope change that arrived with it.
      if (renamed !== null && !renamed.trim()) {
        const { key: _blank, ...rest } = patch;
        return Object.keys(rest).length ? draftReducer(draft, { ...action, patch: rest }) : draft;
      }

      // a rename has to follow the key everywhere it is used, or the draft silently breaks
      const rename = (k: string) => (renamed && k === action.key ? renamed : k);
      const fields = spec.fields.map((f) => (f.key === action.key ? { ...f, ...patch } : f));
      if (renamed === null && kind === null) return { ...draft, spec: { ...spec, fields } };

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
          // invariant holds after every action: reads === derivedReads(step, its body)
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
      // every step on the canvas has a place, so one arriving without a dropped position is
      // given one here rather than piling up at the origin (HOW-24)
      const placed = { ...action.node, position: action.position ?? action.node.position ?? nextFreePosition(spec.nodes) };
      const nodes = [...spec.nodes, withEmittableWrites(withDerivedReads(placed, action.body))];
      const entry = pickEntry(nodes, spec.entry);
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
      // a step edit can flip a structural read (requiresAcceptance → `acceptance`), so reads are
      // re-derived here too, from the body the step names after the edit
      return {
        ...draft,
        spec: {
          ...spec,
          nodes: spec.nodes.map((n) =>
            n.id === action.id
              ? withEmittableWrites(withDerivedReads(action.node, action.node.kind === "agent" ? draft.prompts[action.node.prompt] : undefined))
              : n,
          ),
        },
      };
    case "rename-step":
      return renameStep(draft, action.id, action.to);
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
          entry: pickEntry(nodes, spec.entry),
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

    case "move-node":
      return {
        ...draft,
        spec: { ...spec, nodes: spec.nodes.map((n) => (n.id === action.id ? { ...n, position: action.position } : n)) },
      };

    case "set-branching": {
      // the rows REPLACE this step's outgoing edges, in order: first conditional row wins
      const others = spec.edges.filter((e) => e.from !== action.from);
      const mine = action.edges.map((e) => edgeOf(action.from, e.to, e.when));
      return { ...draft, spec: { ...spec, edges: [...others, ...mine] } };
    }

    case "add-edge": {
      // A WIRE DRAWN ON THE CANVAS IS THE SAME ROUTE THE PANEL MAKES. The first route leaving a
      // step is its "Otherwise"; every later one is a condition, seeded through the rule above
      // so it can fire. Appending puts it AFTER that step's existing conditions, which is what
      // keeps row order — and therefore priority — meaning what the operator saw.
      const hasFallback = spec.edges.some((e) => e.from === action.from && !e.when);
      // with no fields there is no condition to seed, so the gesture still makes a route and
      // specProblems() names what is missing rather than the canvas refusing the drag
      const when = hasFallback && spec.fields.length ? seedPredicate(spec) : undefined;
      return { ...draft, spec: { ...spec, edges: [...spec.edges, edgeOf(action.from, action.to, when)] } };
    }
    case "update-edge": {
      const at = spec.edges[action.index];
      if (!at) return draft;
      // `null` CLEARS the condition (this route becomes the "Otherwise"); `undefined` means the
      // patch says nothing about it, which is not the same thing
      const when = action.patch.when === undefined ? at.when : (action.patch.when ?? undefined);
      const next = edgeOf(at.from, action.patch.to ?? at.to, when);
      return { ...draft, spec: { ...spec, edges: spec.edges.map((e, i) => (i === action.index ? next : e)) } };
    }
    case "remove-edge":
      return { ...draft, spec: { ...spec, edges: spec.edges.filter((_, i) => i !== action.index) } };
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
/**
 * What removing a field actually destroys (HOW-31 item 7).
 *
 * `remove-field` is one click on a trash icon and it cascades three ways, none of them
 * visible beforehand: every branch TESTING the field is deleted outright, every step that
 * DECLARED it as a write silently stops producing it, and every agent prompt that still NAMES
 * it in its body turns the draft blocking — because an agent's `reads` is derived from the
 * body (`withDerivedReads`), so dropping the key from `reads` is cosmetic and
 * `core/graph-spec.ts` reports it rather than editing the operator's text behind their back.
 *
 * That is the shape of the HOW-31 report: "I was trying to build a new graph for my coding
 * workflow and basically broke everything." The fields panel's own help text promised the
 * removal "removes it from the steps that used it", which is FALSE for agent steps.
 *
 * So the control asks first and says exactly what goes, which is the pattern HOW-24 already
 * set for destroying a step (`web/app/builder/properties.tsx`, `canvas.tsx:262`): a named
 * control that names the damage, rather than an undo stack for one action. Pure and
 * node-free, so the dialog and the tests share one answer.
 */
export interface FieldRemoval {
  /** routes that will be deleted outright: nothing else can test a field that is gone */
  branches: Array<{ from: string; to: string; label: string }>;
  /** agent steps whose instructions still name it — these turn the draft blocking */
  instructions: Array<{ node: string; prompt: string }>;
  /** steps that declared it as something they produce */
  producers: string[];
  /** was it asked for at launch */
  wasInput: boolean;
  /** steps left with no route out once the branches go: the dead ends the removal creates */
  strandedSteps: string[];
}

/** Empty when removing the field costs nothing; `anyCost` is the gate for asking first. */
export function fieldRemoval(draft: Draft, key: string): FieldRemoval {
  const { spec, prompts } = draft;
  const branches = spec.edges
    .filter((e) => e.when?.key === key)
    .map((e) => ({ from: titleFor(spec, e.from), to: titleFor(spec, e.to), label: predicateLabel(e.when!) }));

  const instructions: Array<{ node: string; prompt: string }> = [];
  const producers: string[] = [];
  for (const n of spec.nodes) {
    if ("writes" in n && n.writes?.includes(key)) producers.push(titleFor(spec, n.id));
    if (n.kind !== "agent") continue;
    const body = prompts[n.prompt];
    // Only a body the operator actually has can be checked. An unopened one is not claimed
    // to be clean: specProblems still reports it at save, which is the authority.
    if (body !== undefined && templateReads(body).includes(key)) instructions.push({ node: titleFor(spec, n.id), prompt: n.prompt });
  }

  // A step whose every outgoing route tested this field has nowhere to go once they are gone.
  const survives = new Set(spec.edges.filter((e) => e.when?.key !== key).map((e) => e.from));
  const strandedSteps = [...new Set(spec.edges.filter((e) => e.when?.key === key).map((e) => e.from))]
    .filter((from) => !survives.has(from))
    .map((from) => titleFor(spec, from));

  return { branches, instructions, producers, wasInput: spec.inputs.includes(key), strandedSteps };
}

/** Does removing this field destroy anything the operator should see first? */
export function removalHasCost(r: FieldRemoval): boolean {
  return r.branches.length > 0 || r.instructions.length > 0 || r.producers.length > 0 || r.strandedSteps.length > 0;
}

/** A step's editable title, falling back to its id — the name the operator gave it. */
function titleFor(spec: GraphSpec, id: string): string {
  return spec.nodes.find((n) => n.id === id)?.title?.trim() || id;
}

function withDerivedReads(n: NodeSpec, body: string | undefined): NodeSpec {
  return n.kind === "agent" && body !== undefined ? { ...n, reads: derivedReads(n, body) } : n;
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
 * The verdict, split by how hard it is (HOW-26). One list arrives from `specProblems()` so
 * that every pane keeps printing everything that belongs to it in one place — but "Ready to
 * save" and the rail's alarm are about `blocking` ALONE, because advice describes a graph
 * that loads, validates and runs and is merely not what was probably meant. Counting the two
 * together would make the builder's own opinion read as a refusal; hiding advice from the
 * panes would put it only at the end, which is the thing this ticket was filed against.
 */
export function bySeverity(problems: SpecProblem[]): { blocking: SpecProblem[]; advice: SpecProblem[] } {
  return { blocking: problems.filter(isBlocking), advice: problems.filter((p) => !isBlocking(p)) };
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

/**
 * `taken` is every name already in the catalog. It is passed in rather than looked up because
 * core/graph-spec.ts is node-free and a spec cannot carry the catalog — and it only counts
 * while the draft is UNSAVED, since a saved graph legitimately owns its own name. This used to
 * be a field-error the Basics pane rendered on its own, outside the verdict, so the rail
 * counted Basics clean and Save went through and replaced the other graph (HOW-22 review).
 */
export function draftProblems(draft: Draft, opts: { taken?: readonly string[] } = {}): SpecProblem[] {
  // a prompt is "known" if the operator has written one here or it already exists on disk;
  // the builder seeds every agent step with a body, so an empty map means "do not check".
  // HOW-60: the bodies go through too, and they are pickPrompts() — exactly what Save POSTS —
  // not draft.prompts, or a stray body the server never receives would block here alone and
  // the two verdicts would disagree (graphs/builder.ts saveVerdict).
  const collision = nameTakenProblem(draft.spec.name, draft.saved ? [] : (opts.taken ?? []));
  return [
    ...(collision ? [collision] : []),
    ...specProblems(draft.spec, Object.keys(draft.prompts).length ? { bodies: pickPrompts(draft) } : {}),
  ];
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
  {
    id: "pr",
    label: "Change some code and open a pull request",
    description: "The whole round trip: a worktree, a review loop, a PR, and repairs driven by what the PR actually says.",
    build: (name) => ({
      saved: false,
      prompts: {
        [promptIdFor(name, "implement")]: "Make the change.\n\nGoal: {{ context.goal }}\n\nWork item: {{ context.work }}\n\nRun the project's checks, then return a summary of what you changed.",
        [promptIdFor(name, "review")]:
          "Review the change against the goal.\n\nGoal: {{ context.goal }}\n\nWork item: {{ context.work }}\n\nSummary: {{ context.summary }}\n\n" +
          "Return review_verdict as exactly `reject` only when something must change before this is opened for review. Otherwise return exactly `pass`.",
        // every repair edge comes back HERE (maxVisits: 5 says a revisit is normal flow), and a
        // revisit is a fresh session with no memory of the last one. The guard is stated in PROSE
        // because `reads` is derived from the body: a `{{ context.publication_summary }}` reference
        // would be a key with no writer on the entry path, which validate() refuses. It is how the
        // built-in this mirrors says it too (prompts/delivery.publish.md).
        [promptIdFor(name, "publish")]:
          "Inspect the worktree, the current branch and any pull request already open for it.\n\n" +
          "Goal: {{ context.goal }}\n\nWork item: {{ context.work }}\n\nSummary: {{ context.summary }}\n\n" +
          "Commit the work and push the branch. Then update the pull request already open for this branch, " +
          "or open one if there is none — never open a second one.\n\nReturn the pull request's number and URL.",
        [promptIdFor(name, "fix-ci")]: "CI is failing on the pull request.\n\nGoal: {{ context.goal }}\n\nThe pull request: {{ context.publication_summary }}\n\nRead the failing checks, fix the cause, and push. Return what you changed.",
        [promptIdFor(name, "address-reviews")]: "A reviewer has asked for changes.\n\nGoal: {{ context.goal }}\n\nThe pull request: {{ context.publication_summary }}\n\nRead every unresolved comment, act on it, reply to it, and push. Return what you changed.",
        [promptIdFor(name, "resolve-conflicts")]: "The pull request no longer merges cleanly.\n\nGoal: {{ context.goal }}\n\nThe pull request: {{ context.publication_summary }}\n\nRebase on the base branch, resolve the conflicts, re-run the checks and push. Return what you changed.",
      },
      spec: {
        version: 1, name, description: "",
        fields: [
          { key: "goal", kind: "text", scope: "sticky", description: "what this run is for" },
          { key: "work", kind: "text", scope: "sticky", description: "the ticket or work item" },
          { key: "summary", kind: "text", scope: "sticky" },
          { key: "review_verdict", kind: "choice", scope: "cleared", choices: ["pass", "reject"] },
          { key: "review_findings", kind: "json", scope: "cleared" },
          { key: "publication_summary", kind: "text", scope: "sticky", description: "the pull request that was opened" },
          { key: "repair_summary", kind: "text", scope: "sticky" },
          // probe:pr publishes exactly this key, and exactly these values (graphs/delivery.ts)
          { key: "pr.state", kind: "choice", scope: "per-visit", choices: ["OPEN", "MERGED", "CLOSED", "CONFLICTS", "CI_FAILED", "CHANGES_REQUIRED"] },
          { key: "worktree.clean", kind: "boolean", scope: "per-visit" },
        ],
        inputs: ["goal", "work"],
        defaults: { permissionMode: "auto" },
        entry: "make-worktree",
        nodes: [
          { id: "make-worktree", kind: "worktree", title: "Make a worktree", action: "create", writes: [] },
          agent(name, "implement", "Make the change", ["summary"], { maxVisits: 4 }),
          agent(name, "review", "Review the change", ["review_verdict", "review_findings"]),
          agent(name, "publish", "Open the pull request", ["publication_summary"], { maxVisits: 5 }),
          { id: "probe", kind: "command", title: "Check the pull request", run: "probe:pr", reads: [], writes: ["pr.state"] },
          { id: "settle", kind: "wait", title: "Let CI and reviewers catch up", duration: "5 m" },
          agent(name, "fix-ci", "Fix the failing checks", ["repair_summary"]),
          agent(name, "address-reviews", "Address the review comments", ["repair_summary"]),
          agent(name, "resolve-conflicts", "Resolve the merge conflicts", ["repair_summary"]),
          { id: "clean-up", kind: "worktree", title: "Clean up the worktree", action: "remove", writes: ["worktree.clean"] },
          { id: "done", kind: "terminal", outcome: "success", title: "Merged" },
          { id: "closed", kind: "terminal", outcome: "failed", title: "Closed unmerged", label: "The pull request was closed — the worktree is kept so you can look at it" },
          { id: "retained", kind: "terminal", outcome: "failed", title: "Worktree kept", label: "Worktree kept — it still has local work" },
        ],
        edges: [
          { from: "make-worktree", to: "implement" },
          { from: "implement", to: "review" },
          { from: "review", to: "implement", when: { op: "equals", key: "review_verdict", value: "reject" } },
          { from: "review", to: "publish", when: { op: "equals", key: "review_verdict", value: "pass" } },
          { from: "publish", to: "probe" },
          // the probe's rows are in weight order: the outcomes first, the repairs next, and
          // "nothing has happened yet" as the Otherwise that waits and asks again
          { from: "probe", to: "clean-up", when: { op: "equals", key: "pr.state", value: "MERGED" } },
          { from: "probe", to: "closed", when: { op: "equals", key: "pr.state", value: "CLOSED" } },
          { from: "probe", to: "resolve-conflicts", when: { op: "equals", key: "pr.state", value: "CONFLICTS" } },
          { from: "probe", to: "fix-ci", when: { op: "equals", key: "pr.state", value: "CI_FAILED" } },
          { from: "probe", to: "address-reviews", when: { op: "equals", key: "pr.state", value: "CHANGES_REQUIRED" } },
          { from: "probe", to: "settle" },
          { from: "settle", to: "probe" },
          { from: "resolve-conflicts", to: "publish" },
          { from: "fix-ci", to: "publish" },
          { from: "address-reviews", to: "publish" },
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
export const PRESETS: Preset[] = PRESET_DEFS.map((p) => ({
  ...p,
  // ...and laid out, so a preset opens as an arrangement rather than a pile at the origin
  // (HOW-24). The positions are the spec's from that moment on, and the first save writes them.
  build: (name: string) => {
    const draft = deriveDraftReads(p.build(name));
    return { ...draft, spec: autoLayout(draft.spec) };
  },
}));

/** A new step of one kind, with the defaults its form would otherwise make you fill in. */
export function newStep(spec: GraphSpec, kind: StepKind, name: string): { node: NodeSpec; body?: string; fields?: FieldSpec[] } {
  const id = nextNodeId(spec, name);
  // a name that says nothing is stored as NO name rather than as an empty one: stepTitle()
  // falls back to the id, and an empty string would be rendered into the saved module as
  // `"title": ""` — noise that reads as a title the operator chose. The id is slug()'s answer
  // for the same empty seed (`step`), which is what the live preview under the name box shows.
  const title = name.trim() || undefined;
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
