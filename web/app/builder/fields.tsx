/**
 * Step 2 of the builder (HOW-22): the field registry — every value the graph passes between
 * its steps, and how fresh each one has to be.
 *
 * Freshness lives HERE rather than on each producing step, and that is the whole reason this
 * pane exists as its own thing. Two steps declaring different scopes for one key is a
 * GraphError (core/graph.ts declarations()); asking once, per field, in plain language makes
 * that error unreachable instead of merely reported.
 *
 * HOW-68 (DESIGN.md). The registry was a six-column table inside a card inside a 360px panel,
 * so it scrolled sideways under a second scrollbar and every name box was three characters
 * wide. A field is now a short stacked form — its name and kind on one line, its freshness
 * under it, "ask me" and who writes it under that — one hairline between fields. Every control
 * keeps its accessible name, and each one now has a visible label above it as well. The name
 * and the choices are machine text (they are matched exactly, in a prompt and in a condition),
 * so those two boxes are mono; nothing else is.
 */
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { FIELD_KINDS, SCOPE_CHOICES, fieldRemoval, removalHasCost, type Draft, type DraftAction, type FieldRemoval } from "@/lib/spec-draft";
import type { FieldKind, FieldSpec, GraphSpec } from "../../../core/graph-spec";
import type { Scope } from "../../../core/context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertDialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { Section } from "./section";
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
  const from = writers.length ? writers.join(", ") : spec.inputs.includes(f.key) ? "you, at launch" : "nothing yet";
  return (
    <div className="flex flex-col gap-2 border-b border-border pb-3 last:border-b-0 last:pb-0">
      <div className="flex items-end gap-2">
        <Label className="min-w-0 flex-1">
          Name
          <Input
            mono value={name} aria-label={`the name of the ${f.key} field`}
            onChange={(e) => { setName(e.target.value); dispatch({ type: "update-field", key: f.key, patch: { key: e.target.value } }); }}
          />
        </Label>
        <Label className="w-[7.5rem] shrink-0">
          Kind
          <Select value={f.kind} aria-label={`the kind of ${f.key}`} onChange={(e) => dispatch({ type: "update-field", key: f.key, patch: { kind: e.target.value as FieldKind } })}>
            {FIELD_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
          </Select>
        </Label>
        <Tooltip content={`Remove ${f.key}`} side="top" align="end">
          <Button variant="ghost" size="icon" aria-label={`remove the ${f.key} field`} onClick={() => onRemove(f.key)}>
            <Trash2 />
          </Button>
        </Tooltip>
      </div>
      {f.kind === "choice" && (
        <Label>
          Choices, separated by commas
          <Input
            mono value={choices} placeholder="pass, reject" aria-label={`the choices for ${f.key}`}
            onChange={(e) => { setChoices(e.target.value); dispatch({ type: "update-field", key: f.key, patch: { choices: splitChoices(e.target.value) } }); }}
          />
        </Label>
      )}
      <Label>
        When its step runs again
        <Select value={f.scope} aria-label={`how fresh ${f.key} has to be`} onChange={(e) => dispatch({ type: "update-field", key: f.key, patch: { scope: e.target.value as Scope } })}>
          {SCOPE_CHOICES.map((s) => <option key={s.scope} value={s.scope}>{s.label}</option>)}
        </Select>
      </Label>
      <div className="field-hint">{SCOPE_CHOICES.find((s) => s.scope === f.scope)?.help}</div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Checkbox
          label="Ask me at launch" checked={spec.inputs.includes(f.key)}
          aria-label={`ask me for ${f.key} when a run starts`}
          onChange={() => dispatch({ type: "toggle-input", key: f.key })}
        />
        <span className="text-xs text-muted-foreground">Written by {from}</span>
      </div>
    </div>
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
    <Section
      title="What it works with"
      hint={<>Every value the steps pass between them. Tick "Ask me at launch" for the ones you type in when a run starts.</>}
    >
      {spec.fields.length === 0 ? (
        <div className="field-hint">No fields yet. Add one for each value a step hands to the next.</div>
      ) : (
        <div className="flex flex-col gap-3">
          {spec.fields.map((f) => (
            <FieldRow key={f.key} f={f} spec={spec} writers={writersOf(f.key)} dispatch={dispatch} onRemove={askOrRemove} />
          ))}
        </div>
      )}
      <div className="flex">
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
    </Section>
  );
}
