/**
 * Step 2 of the builder (HOW-22): the field registry — every value the graph passes between
 * its steps, and how fresh each one has to be.
 *
 * Freshness lives HERE rather than on each producing step, and that is the whole reason this
 * pane exists as its own thing. Two steps declaring different scopes for one key is a
 * GraphError (core/graph.ts declarations()); asking once, per field, in plain language makes
 * that error unreachable instead of merely reported.
 */
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { FIELD_KINDS, SCOPE_CHOICES, fieldRemoval, removalHasCost, type Draft, type DraftAction, type FieldRemoval } from "@/lib/spec-draft";
import type { FieldKind, FieldSpec, GraphSpec } from "../../../core/graph-spec";
import type { Scope } from "../../../core/context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertDialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useTypedText } from "@/lib/hooks";

/**
 * One row of the registry. Its own component because both of its text boxes are controlled by
 * MEANING rather than by spelling (useTypedText), and a hook may not be called inside a `.map`
 * callback that returns early.
 *
 * THE NAME. Emptying the box is how an operator starts retyping a name, and the draft cannot
 * carry a field called "" — so the reducer DEFERS the rename (spec-draft.ts) and the box keeps
 * what was typed until a real character arrives. Before, the key was set to "" while the
 * cascade over bodies, reads, edges and inputs was skipped, and nothing could rename back
 * (HOW-22 review, finding 5).
 *
 * THE CHOICES. Stored as a LIST, shown as "a, b" — so a box fed straight back from it swallowed
 * the comma the instant it was typed and a second choice could never be started. A multi-value
 * choice field was unreachable from the wizard entirely (HOW-22 review, finding 2).
 */
function FieldRow({ f, spec, writers, dispatch, onRemove }: {
  f: FieldSpec;
  spec: GraphSpec;
  writers: string[];
  dispatch: (a: DraftAction) => void;
  /** the row reports the intent; the pane decides whether to ask first (HOW-31 item 7) */
  onRemove: (key: string) => void;
}) {
  const [name, setName] = useTypedText(f.key, (t) => (t.trim() ? t : f.key));
  const joined = (f.choices ?? []).join(", ");
  const [choices, setChoices] = useTypedText(joined, (t) => splitChoices(t).join(", "));
  return (
    <TableRow>
      <TableCell>
        <Input
          className="font-mono" value={name} aria-label={`the name of the ${f.key} field`}
          onChange={(e) => { setName(e.target.value); dispatch({ type: "update-field", key: f.key, patch: { key: e.target.value } }); }}
        />
        {f.kind === "choice" && (
          <Input
            value={choices} placeholder="pass, reject" aria-label={`the choices for ${f.key}`}
            onChange={(e) => { setChoices(e.target.value); dispatch({ type: "update-field", key: f.key, patch: { choices: splitChoices(e.target.value) } }); }}
          />
        )}
      </TableCell>
      <TableCell>
        <Select value={f.kind} aria-label={`the kind of ${f.key}`} onChange={(e) => dispatch({ type: "update-field", key: f.key, patch: { kind: e.target.value as FieldKind } })}>
          {FIELD_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
        </Select>
      </TableCell>
      <TableCell>
        <Select value={f.scope} aria-label={`how fresh ${f.key} has to be`} onChange={(e) => dispatch({ type: "update-field", key: f.key, patch: { scope: e.target.value as Scope } })}>
          {SCOPE_CHOICES.map((s) => <option key={s.scope} value={s.scope}>{s.label}</option>)}
        </Select>
        <div className="field-hint">{SCOPE_CHOICES.find((s) => s.scope === f.scope)?.help}</div>
      </TableCell>
      <TableCell>
        <Checkbox
          label="ask me" checked={spec.inputs.includes(f.key)}
          aria-label={`ask me for ${f.key} when a run starts`}
          onChange={() => dispatch({ type: "toggle-input", key: f.key })}
        />
      </TableCell>
      <TableCell>{writers.length ? writers.join(", ") : spec.inputs.includes(f.key) ? "you, at launch" : "— nothing yet"}</TableCell>
      <TableCell>
        <Button variant="ghost" size="icon" aria-label={`remove the ${f.key} field`} onClick={() => onRemove(f.key)}>
          <Trash2 size={13} />
        </Button>
      </TableCell>
    </TableRow>
  );
}

/**
 * What the operator is about to lose, in their own words. Every clause is something the old
 * one-click removal did silently — and the panel's help text used to claim the opposite, that
 * removal "removes it from the steps that used it", which was never true of an agent step.
 */
function RemovalCost({ field, cost }: { field: string; cost: FieldRemoval }) {
  return (
    <>
      {cost.branches.length > 0 && (
        <p>
          <strong>{cost.branches.length === 1 ? "One route is deleted" : `${cost.branches.length} routes are deleted`}</strong>, because
          nothing can test a field that is gone:{" "}
          {cost.branches.map((b) => `${b.from} → ${b.to} (${b.label})`).join("; ")}.
        </p>
      )}
      {cost.strandedSteps.length > 0 && (
        <p>
          That leaves <strong>{cost.strandedSteps.join(", ")}</strong> with nowhere to go next. Give{" "}
          {cost.strandedSteps.length === 1 ? "it" : "them"} a route or a Finish step afterwards.
        </p>
      )}
      {cost.instructions.length > 0 && (
        <p>
          <strong>{cost.instructions.map((i) => i.node).join(", ")}</strong>{" "}
          {cost.instructions.length === 1 ? "still asks" : "still ask"} for <code>{field}</code> in the
          instructions. That text is yours, so it is not edited for you — the graph cannot be saved until
          you take the reference out or add the field back.
        </p>
      )}
      {cost.producers.length > 0 && (
        <p>
          <strong>{cost.producers.join(", ")}</strong> will stop producing it.
        </p>
      )}
      {cost.wasInput && <p>It will no longer be asked for when a run starts.</p>}
      <p>There is no undo.</p>
    </>
  );
}

/** the one place "pass, reject" becomes ["pass","reject"] — the box's `means` reads it back */
const splitChoices = (text: string): string[] => text.split(",").map((x) => x.trim()).filter(Boolean);

export function FieldsPane({ draft, dispatch }: { draft: Draft; dispatch: (a: DraftAction) => void }) {
  const { spec } = draft;
  // HOW-31 item 7. Removing a field cascades: branches testing it are deleted outright, and an
  // agent step whose instructions still name it turns the draft blocking, because `reads` is
  // derived from the body and the reducer will not rewrite an operator's text. A free removal
  // goes straight through; a costly one names the damage first, the way destroying a step does
  // (web/app/builder/properties.tsx).
  const [pending, setPending] = useState<string | null>(null);
  const cost = pending === null ? null : fieldRemoval(draft, pending);
  const remove = (key: string) => { dispatch({ type: "remove-field", key }); setPending(null); };
  const askOrRemove = (key: string) => {
    const r = fieldRemoval(draft, key);
    if (removalHasCost(r)) setPending(key);
    else remove(key);
  };
  /** who writes this key — so removing a field can say what it would take with it */
  const writersOf = (key: string) =>
    spec.nodes.filter((n) => ("writes" in n && n.writes.includes(key))).map((n) => n.title || n.id);

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader>
          <CardTitle>What it works with</CardTitle>
          <CardDescription>
            Every value the steps pass between them. Tick "ask me" for the ones you type in when a run starts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {spec.fields.length === 0 ? (
            <EmptyState>no fields yet</EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Freshness</TableHead>
                  <TableHead>Ask me at launch</TableHead>
                  <TableHead>Written by</TableHead>
                  <TableHead>{""}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {spec.fields.map((f) => (
                  <FieldRow key={f.key} f={f} spec={spec} writers={writersOf(f.key)} dispatch={dispatch} onRemove={askOrRemove} />
                ))}
              </TableBody>
            </Table>
          )}
          <div className="actions">
            <Button variant="outline" size="sm" onClick={() => dispatch({ type: "add-field" })}><Plus />Add a field</Button>
          </div>
          <div className="field-hint">
            Removing a field deletes every branch that tested it, and any step whose instructions
            still name it will need its text fixed. You are told what goes before it happens.
          </div>
          <AlertDialog
            open={pending !== null}
            onClose={() => setPending(null)}
            onConfirm={() => remove(pending!)}
            title={`Remove ${pending ?? ""}?`}
            description={cost ? <RemovalCost field={pending ?? ""} cost={cost} /> : undefined}
            confirmLabel="Remove it anyway"
          />
        </CardContent>
      </Card>
    </div>
  );
}
