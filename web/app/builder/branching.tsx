/**
 * What happens after a step (HOW-22), now docked beside the canvas rather than buried in a
 * wizard tab (HOW-24).
 *
 * This is the pane that has to replace an arrow function. A hand-written graph says
 * `condition: { reads: ["review_verdict"], test: (c) => c.review_verdict === "reject" }`;
 * here it is a row — When [review_verdict] [is] [reject] → go to [Revise it] — and the
 * Predicate it produces is DATA, which is what makes the round trip exact and the compiler
 * unnecessary (core/graph-spec.ts).
 *
 * Two things the operator never sees, on purpose:
 *
 *   WEIGHT. The engine routes by highest passing weight; the rows are ordered and the first
 *   one that passes wins, which is the same thing said in the only way anyone thinks about
 *   it. compileEdges() derives the numbers from the row order.
 *
 *   THE FALLBACK EDGE. "Otherwise" is one row with a step picker whose first option is
 *   "pause and ask me". Picking that emits NO unconditional edge, which is legal Orbital
 *   semantics — no matching edge parks the run — rather than an omission. The row says so in
 *   those words, because a graph that parks on purpose and one that forgot an edge look
 *   identical in the file.
 *
 * HOW-24 splits it in two, for the two things the operator can now have selected:
 *
 *   `StepRoutes` is a STEP's whole outgoing list, and edits it with `set-branching` — which
 *   replaces all of that step's edges at once, so reordering rows (= priority) is one action.
 *   This is the keyboard path to what dragging a wire does (D7). Replacing the lot is also why
 *   it must DRAW every route it will emit: a route it renders no row for is a route the next
 *   edit silently deletes, which is what a second "Otherwise" used to be (HOW-24 review,
 *   finding 2).
 *
 *   `ConditionEditor` is ONE edge, reached by clicking its wire, and edits it by INDEX
 *   (`update-edge` / `remove-edge`). Two things make that safe, and it needs both. The two
 *   panels are never on screen together — the right panel shows a step or an edge, never both —
 *   so nothing else renumbers `spec.edges` while one edge is selected. And `remove-edge` itself
 *   DOES renumber (an index list has no other way to shrink), so this panel tells the surface
 *   that owns the selection that the route is gone — `onRemoved`, the same callback the step
 *   form already has. Without it the panel stayed open on whatever slid into that index and a
 *   second press destroyed a route nobody selected (HOW-24 review, finding 1). `update-edge`
 *   alone cannot renumber, which is why editing a condition keeps the panel where it is.
 */
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import {
  // coerceOperand lives in core beside Predicate and FieldKind, because a field's kind can
  // change AFTER a row is written and the reducer has to re-type the operand with the very
  // same rule this control used (HOW-22 review, finding 4)
  NULLARY_OPS, keepPath, coerceOperand,
  type EdgeSpec, type FieldSpec, type GraphSpec, type Predicate, type PredicateOp, type SpecProblem,
} from "../../../core/graph-spec";
import { seedPredicate, type Draft, type DraftAction } from "@/lib/spec-draft";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useTypedText } from "@/lib/hooks";

/** the predicate vocabulary in the operator's words; the op itself is what gets stored */
const OP_LABELS: Array<{ op: PredicateOp; label: string }> = [
  { op: "equals", label: "is" },
  { op: "not-equals", label: "is not" },
  { op: "one-of", label: "is one of" },
  { op: "is-true", label: "is yes" },
  { op: "is-false", label: "is no" },
  { op: "is-not-empty", label: "has a value" },
  { op: "is-empty", label: "is empty" },
];

const isNullary = (op: PredicateOp) => NULLARY_OPS.includes(op);

const operandText = (p: Predicate): string =>
  p.op === "one-of" ? p.values.join(", ") : p.op === "equals" || p.op === "not-equals" ? String(p.value) : "";

/** Rebuild a predicate when one control changes, keeping whatever the new shape can carry. */
function repredicate(p: Predicate, over: { op?: PredicateOp; key?: string; path?: string; text?: string }, fields: FieldSpec[]): Predicate {
  const op = over.op ?? p.op;
  const key = over.key ?? p.key;
  const field = fields.find((f) => f.key === key);
  // the path is RESOLVED, not merely carried: re-pointing a json row at a text field used to
  // keep an inner name the form then stopped rendering, leaving a row that saved clean and could
  // never fire (HOW-22 review, finding 3). keepPath is the same rule recoercePredicate uses.
  const path = keepPath(over.path !== undefined ? over.path : p.path, field?.kind);
  const text = over.text !== undefined ? over.text : operandText(p);
  const base = { key, ...(path ? { path } : {}) };
  if (op === "one-of")
    return { ...base, op, values: text.split(",").map((x) => x.trim()).filter(Boolean).map((x) => coerceOperand(x, field?.kind)) };
  if (op === "equals" || op === "not-equals") return { ...base, op, value: coerceOperand(text, field?.kind) };
  return { ...base, op };
}

/** What this row will STORE for `text`, read back as the box's own text — `repredicate`'s own
 *  rule, CALLED rather than restated, so the two cannot drift. */
const storedText = (text: string, p: Predicate, field: FieldSpec | undefined): string =>
  operandText(repredicate(p, { text }, field ? [field] : []));

/**
 * The typed operand box. Its own component because a hook may not be called conditionally and
 * `Operand` returns early for the nullary and picker cases.
 *
 * It is controlled by MEANING, not by spelling (useTypedText): the stored operand is typed
 * data, so feeding it straight back destroyed `3.`, `-` and every comma on the way to a second
 * value (HOW-22 review, finding 2). Blur settles the box on what the draft actually holds, so
 * a `-` never sits on screen next to a stored 0.
 */
function OperandInput({ p, field, onText }: { p: Predicate; field: FieldSpec | undefined; onText: (text: string) => void }) {
  const stored = operandText(p);
  const [shown, setTyped] = useTypedText(stored, (t) => storedText(t, p, field));
  return (
    <Input
      value={shown}
      aria-label={`what ${p.key} is compared with`}
      placeholder={p.op === "one-of" ? "pass, warn" : field?.kind === "number" ? "0" : "reject"}
      onChange={(e) => { setTyped(e.target.value); onText(e.target.value); }}
      onBlur={() => setTyped(stored)}
    />
  );
}

/** The operand control — a picker wherever the field's kind knows the answers. */
function Operand({ p, field, onText }: { p: Predicate; field: FieldSpec | undefined; onText: (text: string) => void }) {
  if (isNullary(p.op)) return null;
  const text = operandText(p);
  if (p.op !== "one-of" && field?.kind === "choice" && field.choices?.length) {
    return (
      <Select value={text} aria-label={`what ${p.key} is compared with`} onChange={(e) => onText(e.target.value)}>
        <option value="">pick a value</option>
        {field.choices.map((c) => <option key={c} value={c}>{c}</option>)}
      </Select>
    );
  }
  if (p.op !== "one-of" && field?.kind === "boolean") {
    return (
      <Select value={text} aria-label={`what ${p.key} is compared with`} onChange={(e) => onText(e.target.value)}>
        <option value="true">yes</option>
        <option value="false">no</option>
      </Select>
    );
  }
  // the pickers above are fully controlled on purpose: their options ARE the stored values, so
  // there is no in-progress keystroke to keep
  return <OperandInput p={p} field={field} onText={onText} />;
}

/**
 * ONE condition, as the sentence it is: When <field> [inside <part>] <op> <value>. The `nth`
 * only names the controls — every aria-label in the suite says "row N" — so the same component
 * serves a row in a step's list and the single row of the selected-edge panel.
 */
function ConditionControls({ spec, when, nth, onChange }: {
  spec: GraphSpec;
  when: Predicate;
  nth: number;
  onChange: (next: Predicate) => void;
}) {
  const field = spec.fields.find((f) => f.key === when.key);
  return (
    <>
      <span className="field-hint">When</span>
      <Select
        value={when.key} aria-label={`the field row ${nth} tests`}
        onChange={(ev) => onChange(repredicate(when, { key: ev.target.value, text: "" }, spec.fields))}
      >
        {spec.fields.map((f) => <option key={f.key} value={f.key}>{f.key}</option>)}
        {!field && <option value={when.key}>{when.key} — no longer a field</option>}
      </Select>
      {field?.kind === "json" && (
        <Input
          value={when.path ?? ""} placeholder="inside (e.g. outcome)"
          aria-label={`which part of ${when.key} row ${nth} tests`}
          onChange={(ev) => onChange(repredicate(when, { path: ev.target.value }, spec.fields))}
        />
      )}
      <Select
        value={when.op} aria-label={`how row ${nth} compares`}
        onChange={(ev) => onChange(repredicate(when, { op: ev.target.value as PredicateOp }, spec.fields))}
      >
        {OP_LABELS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
      </Select>
      <Operand p={when} field={field} onText={(text) => onChange(repredicate(when, { text }, spec.fields))} />
    </>
  );
}

/** Every step is a legal target, a Finish included — that is what ends a run. */
function TargetPicker({ spec, value, label, onChange }: {
  spec: GraphSpec;
  value: string;
  label: string;
  onChange: (id: string) => void;
}) {
  return (
    <Select value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}>
      <option value="">pick a step</option>
      {spec.nodes.map((n) => <option key={n.id} value={n.id}>{n.title?.trim() || n.id}</option>)}
    </Select>
  );
}

/**
 * ONE edge, the panel a selected wire opens (HOW-24). Addressed by its index in `spec.edges`,
 * which is what `add-edge` appended and what the canvas draws as `e<i>`.
 *
 * `onRemoved` is how the surface that OWNS the selection learns the route is gone — the same
 * words `StepFields` uses, for the same reason, and here it is load-bearing: `remove-edge`
 * renumbers every later edge, so a panel that just kept rendering would be editing the route
 * that slid into this index.
 */
export function ConditionEditor({ draft, index, dispatch, onRemoved }: {
  draft: Draft;
  index: number;
  dispatch: (a: DraftAction) => void;
  onRemoved?: () => void;
}) {
  const { spec } = draft;
  const edge = spec.edges[index];
  if (!edge) return null;
  const from = spec.nodes.find((n) => n.id === edge.from);
  return (
    <div className="flex flex-col gap-2">
      <div className="field-hint">
        Leaving <strong>{from?.title?.trim() || edge.from}</strong>. The first condition that fits decides;
        "Otherwise" is what happens when none do.
      </div>
      <div className="builder-branch-row">
        {edge.when
          ? <ConditionControls spec={spec} when={edge.when} nth={1} onChange={(when) => dispatch({ type: "update-edge", index, patch: { when } })} />
          : <span className="field-hint">Otherwise</span>}
        <span className="field-hint">go to</span>
        <TargetPicker spec={spec} value={edge.to} label="where row 1 goes" onChange={(to) => dispatch({ type: "update-edge", index, patch: { to } })} />
      </div>
      <div className="actions">
        {edge.when
          ? (
            <Button
              variant="outline" size="sm"
              onClick={() => dispatch({ type: "update-edge", index, patch: { when: null } })}
            >
              Make this the "Otherwise"
            </Button>
          )
          : (
            <Button
              variant="outline" size="sm" disabled={spec.fields.length === 0}
              onClick={() => dispatch({ type: "update-edge", index, patch: { when: seedPredicate(spec) } })}
            >
              <Plus />Give it a condition
            </Button>
          )}
        <Button
          variant="destructive" size="sm" aria-label="remove this route"
          onClick={() => { dispatch({ type: "remove-edge", index }); onRemoved?.(); }}
        >
          <Trash2 />Remove this route
        </Button>
      </div>
    </div>
  );
}

/**
 * A STEP's whole outgoing list — the keyboard path to what dragging a wire does (D7), and the
 * only place row ORDER (= priority) can be changed. Edits with `set-branching`, which replaces
 * all of this step's edges at once, so a reorder is one action rather than two renumberings.
 */
export function StepRoutes({ draft, from, problems, dispatch }: {
  draft: Draft;
  from: string;
  problems: SpecProblem[];
  dispatch: (a: DraftAction) => void;
}) {
  const { spec } = draft;
  const mine = spec.edges.filter((e) => e.from === from);
  const conditional = mine.filter((e) => e.when) as Array<EdgeSpec & { when: Predicate }>;
  // PLURAL on purpose. `set-branching` replaces this step's whole outgoing list, so every
  // unconditional route has to survive the round trip through this component — and there can
  // legally be more than one: two wires drawn from one step on a draft with no fields yet make
  // a second (`add-edge`), and so does "Make this the 'Otherwise'" pressed twice. specProblems
  // refuses it in the operator's words and prints the refusal in this very panel.
  const fallbacks = mine.filter((e) => !e.when);
  const kept = fallbacks.map((f) => f.to);
  const emit = (rows: Array<EdgeSpec & { when: Predicate }>, others: string[]) =>
    dispatch({
      type: "set-branching",
      from,
      edges: [...rows.map((r) => ({ to: r.to, when: r.when })), ...others.map((to) => ({ to }))],
    });

  const setRow = (i: number, patch: Partial<EdgeSpec & { when: Predicate }>) =>
    emit(conditional.map((r, j) => (j === i ? { ...r, ...patch } : r)), kept);
  const move = (i: number, by: 1 | -1) => {
    const j = i + by;
    if (j < 0 || j >= conditional.length) return;
    const next = [...conditional];
    [next[i], next[j]] = [next[j]!, next[i]!];
    emit(next, kept);
  };

  // the operand is seeded by seedPredicate, the same rule a drawn wire goes through: a bare ""
  // is a row that can never fire on a yes/no or number field, and it saved clean while showing
  // a blank operand (HOW-22 review, finding 3).
  const addRow = () =>
    emit([...conditional, { from, to: spec.nodes[0]?.id ?? "", when: seedPredicate(spec) }], kept);

  // always at least one row: with no unconditional route at all, the row is the empty pick that
  // says the run pauses here, which is how that choice has always been made and unmade
  const shown = kept.length ? kept : [""];

  return (
    <div className="flex flex-col gap-2">
      <div className="field-hint">The first row that fits decides. Order is priority — the top one wins.</div>
      {conditional.length === 0 && fallbacks.length === 0 && <div className="field-hint">No routes yet.</div>}
      {conditional.map((e, i) => (
        <div key={i} className="builder-branch-row">
          <ConditionControls spec={spec} when={e.when} nth={i + 1} onChange={(when) => setRow(i, { when })} />
          <span className="field-hint">go to</span>
          <TargetPicker spec={spec} value={e.to} label={`where row ${i + 1} goes`} onChange={(to) => setRow(i, { to })} />
          <Button variant="ghost" size="icon" aria-label={`move row ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={13} /></Button>
          <Button variant="ghost" size="icon" aria-label={`move row ${i + 1} down`} disabled={i === conditional.length - 1} onClick={() => move(i, 1)}><ArrowDown size={13} /></Button>
          <Button
            variant="ghost" size="icon" aria-label={`remove row ${i + 1}`}
            onClick={() => emit(conditional.filter((_, j) => j !== i), kept)}
          ><Trash2 size={13} /></Button>
        </div>
      ))}
      {shown.map((to, i) => (
        <div key={`otherwise-${i}`} className="builder-branch-row">
          <span className="field-hint">{i === 0 ? "Otherwise" : "Otherwise, also"}</span>
          <Select
            value={to}
            aria-label={i === 0 ? `where ${from} goes when no row fits` : `where ${from} also goes when no row fits (${i + 1})`}
            // an unpicked target emits no unconditional edge at all — the same `|| null` this
            // row has always had, said once for however many rows there are
            onChange={(ev) => emit(conditional, shown.map((t, j) => (j === i ? ev.target.value : t)).filter(Boolean))}
          >
            {/* only the first row can be unmade by unpicking it; the rest have a control that
                says so, because that is the only way to act on core's "more than one
                'Otherwise'" where it is printed */}
            {i === 0 && <option value="">pause and ask me</option>}
            {spec.nodes.map((n) => <option key={n.id} value={n.id}>go to {n.title?.trim() || n.id}</option>)}
          </Select>
          {i > 0 && (
            <Button
              variant="ghost" size="icon" aria-label={`remove otherwise ${i + 1}`}
              onClick={() => emit(conditional, shown.filter((_, j) => j !== i))}
            ><Trash2 size={13} /></Button>
          )}
          {i === 0 && fallbacks.length === 0 && (
            <span className="field-hint">
              With nothing else matching, the run stops here and waits for you. That is a real
              choice — leave it if there is no sensible default.
            </span>
          )}
        </div>
      ))}
      <div className="actions">
        <Button variant="outline" size="sm" disabled={spec.fields.length === 0} onClick={addRow}><Plus />Add a condition</Button>
        {spec.fields.length === 0 && <span className="field-hint">Add a field first — a condition tests one.</span>}
      </div>
      {problems.map((p, i) => <div key={i} className="field-error builder-problem">{p.message}</div>)}
    </div>
  );
}
