/**
 * Step 4 of the builder (HOW-22): what happens next.
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
 */
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import {
  NULLARY_OPS,
  type EdgeSpec, type FieldSpec, type GraphSpec, type Predicate, type PredicateOp, type SpecProblem,
} from "../../../core/graph-spec";
import type { Draft, DraftAction } from "@/lib/spec-draft";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

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

/**
 * A typed operand from a form control. The field's KIND decides the type, so `count is 3`
 * stores the number 3 and compares equal to what a command wrote — a string "3" would
 * silently never match, which is the sort of bug a builder exists to make impossible.
 */
function coerce(raw: string, field: FieldSpec | undefined): string | number | boolean {
  if (field?.kind === "number") return raw.trim() === "" ? 0 : Number(raw);
  if (field?.kind === "boolean") return raw === "true";
  return raw;
}

const operandText = (p: Predicate): string =>
  p.op === "one-of" ? p.values.join(", ") : p.op === "equals" || p.op === "not-equals" ? String(p.value) : "";

/** Rebuild a predicate when one control changes, keeping whatever the new shape can carry. */
function repredicate(p: Predicate, over: { op?: PredicateOp; key?: string; path?: string; text?: string }, fields: FieldSpec[]): Predicate {
  const op = over.op ?? p.op;
  const key = over.key ?? p.key;
  const path = over.path !== undefined ? over.path : p.path;
  const field = fields.find((f) => f.key === key);
  const text = over.text !== undefined ? over.text : operandText(p);
  const base = { key, ...(path ? { path } : {}) };
  if (op === "one-of")
    return { ...base, op, values: text.split(",").map((x) => x.trim()).filter(Boolean).map((x) => coerce(x, field)) };
  if (op === "equals" || op === "not-equals") return { ...base, op, value: coerce(text, field) };
  return { ...base, op };
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
  return (
    <Input
      value={text}
      aria-label={`what ${p.key} is compared with`}
      placeholder={p.op === "one-of" ? "pass, warn" : field?.kind === "number" ? "0" : "reject"}
      onChange={(e) => onText(e.target.value)}
    />
  );
}

function StepBranching({ spec, from, problems, onChange }: {
  spec: GraphSpec;
  from: string;
  problems: SpecProblem[];
  onChange: (edges: Array<{ to: string; when?: Predicate }>) => void;
}) {
  const mine = spec.edges.filter((e) => e.from === from);
  const conditional = mine.filter((e) => e.when) as Array<EdgeSpec & { when: Predicate }>;
  const fallback = mine.find((e) => !e.when);
  // every step is a legal target, a Finish included — that is what ends a run
  const targets = spec.nodes;
  const emit = (rows: Array<EdgeSpec & { when: Predicate }>, other: string | null) =>
    onChange([...rows.map((r) => ({ to: r.to, when: r.when })), ...(other ? [{ to: other }] : [])]);

  const setRow = (i: number, patch: Partial<EdgeSpec & { when: Predicate }>) =>
    emit(conditional.map((r, j) => (j === i ? { ...r, ...patch } : r)), fallback?.to ?? null);
  const move = (i: number, by: 1 | -1) => {
    const j = i + by;
    if (j < 0 || j >= conditional.length) return;
    const next = [...conditional];
    [next[i], next[j]] = [next[j]!, next[i]!];
    emit(next, fallback?.to ?? null);
  };

  const first = spec.fields[0]?.key ?? "";
  const addRow = () =>
    emit(
      [...conditional, { from, to: targets[0]?.id ?? "", when: { op: "equals", key: first, value: "" } }],
      fallback?.to ?? null,
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>After {spec.nodes.find((n) => n.id === from)?.title?.trim() || from}</CardTitle>
        <CardDescription>The first row that fits decides. Drag order is priority — the top one wins.</CardDescription>
      </CardHeader>
      <CardContent>
        {conditional.length === 0 && !fallback && <div className="field-hint">No routes yet.</div>}
        {conditional.map((e, i) => {
          const field = spec.fields.find((f) => f.key === e.when.key);
          return (
            <div key={i} className="builder-branch-row">
              <span className="field-hint">When</span>
              <Select
                value={e.when.key} aria-label={`the field row ${i + 1} tests`}
                onChange={(ev) => setRow(i, { when: repredicate(e.when, { key: ev.target.value, text: "" }, spec.fields) })}
              >
                {spec.fields.map((f) => <option key={f.key} value={f.key}>{f.key}</option>)}
                {!field && <option value={e.when.key}>{e.when.key} — no longer a field</option>}
              </Select>
              {field?.kind === "json" && (
                <Input
                  value={e.when.path ?? ""} placeholder="inside (e.g. outcome)"
                  aria-label={`which part of ${e.when.key} row ${i + 1} tests`}
                  onChange={(ev) => setRow(i, { when: repredicate(e.when, { path: ev.target.value }, spec.fields) })}
                />
              )}
              <Select
                value={e.when.op} aria-label={`how row ${i + 1} compares`}
                onChange={(ev) => setRow(i, { when: repredicate(e.when, { op: ev.target.value as PredicateOp }, spec.fields) })}
              >
                {OP_LABELS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
              </Select>
              <Operand p={e.when} field={field} onText={(text) => setRow(i, { when: repredicate(e.when, { text }, spec.fields) })} />
              <span className="field-hint">go to</span>
              <Select value={e.to} aria-label={`where row ${i + 1} goes`} onChange={(ev) => setRow(i, { to: ev.target.value })}>
                <option value="">pick a step</option>
                {targets.map((n) => <option key={n.id} value={n.id}>{n.title?.trim() || n.id}</option>)}
              </Select>
              <Button variant="ghost" size="icon" aria-label={`move row ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={13} /></Button>
              <Button variant="ghost" size="icon" aria-label={`move row ${i + 1} down`} disabled={i === conditional.length - 1} onClick={() => move(i, 1)}><ArrowDown size={13} /></Button>
              <Button
                variant="ghost" size="icon" aria-label={`remove row ${i + 1}`}
                onClick={() => emit(conditional.filter((_, j) => j !== i), fallback?.to ?? null)}
              ><Trash2 size={13} /></Button>
            </div>
          );
        })}
        <div className="builder-branch-row">
          <span className="field-hint">Otherwise</span>
          <Select
            value={fallback?.to ?? ""} aria-label={`where ${from} goes when no row fits`}
            onChange={(ev) => emit(conditional, ev.target.value || null)}
          >
            <option value="">pause and ask me</option>
            {targets.map((n) => <option key={n.id} value={n.id}>go to {n.title?.trim() || n.id}</option>)}
          </Select>
          {!fallback && (
            <span className="field-hint">
              With nothing else matching, the run stops here and waits for you. That is a real
              choice — leave it if there is no sensible default.
            </span>
          )}
        </div>
        <div className="actions">
          <Button variant="outline" size="sm" disabled={spec.fields.length === 0} onClick={addRow}><Plus />Add a condition</Button>
          {spec.fields.length === 0 && <span className="field-hint">Add a field first — a condition tests one.</span>}
        </div>
        {problems.map((p, i) => <div key={i} className="field-error builder-problem">{p.message}</div>)}
      </CardContent>
    </Card>
  );
}

export function BranchingPane({ draft, dispatch, problems }: {
  draft: Draft;
  dispatch: (a: DraftAction) => void;
  problems: SpecProblem[];
}) {
  const { spec } = draft;
  const routable = spec.nodes.filter((n) => n.kind !== "terminal");
  return (
    <div className="flex flex-col gap-3">
      {routable.length === 0 ? (
        <EmptyState>add a step first — branching is what happens after one</EmptyState>
      ) : (
        routable.map((n) => (
          <StepBranching
            key={n.id} spec={spec} from={n.id}
            problems={problems.filter((p) => p.node === n.id)}
            onChange={(edges) => dispatch({ type: "set-branching", from: n.id, edges })}
          />
        ))
      )}
      {problems.filter((p) => !p.node || !routable.some((n) => n.id === p.node)).map((p, i) => (
        <div key={i} className="field-error">{p.message}</div>
      ))}
    </div>
  );
}
