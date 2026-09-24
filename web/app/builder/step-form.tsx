/**
 * One step's form (HOW-22), docked beside the canvas rather than covering it (HOW-24).
 *
 * It was a blocking `<dialog>`: on a wizard tab that was fine, because the list behind it said
 * nothing the form did not. On a canvas it is not — you edit a step while looking at where it
 * sits, and a modal over the picture hides the only thing that tells you whether the edit was
 * right. So the body below is exported on its own and mounted in the right-hand panel; every
 * control, and every rule each one enforces, is unchanged.
 *
 * The forms are where "no TypeScript, and no JSON either" is actually won, and each one wins
 * it by CONSTRAINING rather than validating after the fact:
 *
 *   - an agent's `reads` is never typed. It is read out of the prompt body with the engine's
 *     own templateReads(), and shown as "This step will be given: …" — so the declaration
 *     and the instructions cannot disagree, and there is nothing to keep in sync by hand.
 *   - a worktree step offers exactly the two facts its executor emits, because a declared
 *     fact the executor never writes fails the attempt at run time. WHICH facts those are is
 *     core/graph-spec.ts's emittableWrites(), enforced by the draft reducer — the form only
 *     renders it, so the picker and the validator cannot say different things.
 *   - a built-in command offers exactly what that built-in produces. A shell script cannot
 *     be constrained, so the form does not pretend to: it says, in those words, that the
 *     script's last line of output must be JSON with these keys.
 *   - a wait's unit is a select, so parseDuration can never be handed something it refuses.
 *   - an approval step's decision and comments keys are its own and are shown read-only;
 *     the redesign target never offers the step that owns the feedback key, because there it
 *     is engine-owned (core/graph.ts approvalProblems).
 *
 * "Remove this step" is the one control here that destroys something, and since HOW-24's
 * review it is also the ONLY way to (the canvas has no delete key — see canvas.tsx). It asks
 * first in exactly the case where the answer cannot be got back: an agent step whose
 * instructions have been written and whose prompt file no other step shares. A wait step
 * dropped by mistake gets no dialog, deliberately — a confirmation that fires when nothing is
 * at stake is the kind that gets dismissed reflexively.
 */
import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { templateReads } from "../../../core/template-refs";
import {
  COMMAND_BUILTINS, WORKTREE_FACTS, commandBuiltin, parseAgentConfig, SPEC_FIELD_KEY,
  type FieldSpec, type GraphSpec, type NodeSpec,
} from "../../../core/graph-spec";
import type { Draft, DraftAction } from "@/lib/spec-draft";
import { ConfigFields } from "../screens/graphs";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { AlertDialog } from "@/components/ui/dialog";

const DURATION_UNITS = [
  { unit: "ms", label: "milliseconds" },
  { unit: "s", label: "seconds" },
  { unit: "m", label: "minutes" },
  { unit: "h", label: "hours" },
];

/**
 * The "It produces" picker. `only` narrows the candidates to what an executor can actually
 * emit; when it is absent (an agent, a shell script) any field will do and a new one can be
 * made here rather than sending the operator back to the fields pane.
 */
function Produces({
  spec, value, onChange, onAddField, only, hint,
}: {
  spec: GraphSpec;
  value: string[];
  onChange: (keys: string[]) => void;
  onAddField: (key: string) => void;
  only?: readonly string[];
  hint: string;
}) {
  const [fresh, setFresh] = useState("");
  // `only ∪ value`, never `only` alone: a key that is declared but not emittable must stay
  // VISIBLE so it can be unticked. The reducer keeps value ⊆ only, so this is a safety net
  // rather than a mechanism — and a net is exactly what was missing when a stale
  // `worktree.clean` became invisible-and-unremovable (HOW-22 review, finding 3).
  const candidates = only ? [...new Set([...only, ...value])] : spec.fields.map((f) => f.key);
  const toggle = (key: string) => onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key]);
  const legal = SPEC_FIELD_KEY.test(fresh) && !spec.fields.some((f) => f.key === fresh);
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs uppercase tracking-[0.06em] text-muted-foreground">It produces</div>
      <div className="flex flex-col gap-1.5">
        {candidates.length === 0 && <div className="field-hint">No fields yet — make one below.</div>}
        {candidates.map((key) => (
          <Checkbox key={key} label={<span className="font-mono text-base">{key}</span>} checked={value.includes(key)} onChange={() => toggle(key)} />
        ))}
      </div>
      <div className="field-hint">{hint}</div>
      {!only && (
        <div className="flex items-end gap-2">
          <Label className="flex-1">
            New field
            <Input value={fresh} placeholder="summary" onChange={(e) => setFresh(e.target.value)} />
          </Label>
          <Button
            variant="outline" size="sm" disabled={!legal}
            onClick={() => { onAddField(fresh); onChange([...value, fresh]); setFresh(""); }}
          >
            <Plus />Add
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * One step, as forms. `onRemoved` is how the surface that OWNS the selection learns the step
 * is gone — the panel cannot just stop rendering, because the canvas still has it selected.
 */
export function StepFields({ draft, id, dispatch, onRemoved }: {
  draft: Draft;
  id: string;
  dispatch: (a: DraftAction) => void;
  onRemoved?: () => void;
}) {
  const spec = draft.spec;
  const node = spec.nodes.find((n) => n.id === id);
  const set = (next: NodeSpec) => dispatch({ type: "update-step", id, node: next });
  const addField = (key: string, patch: Partial<FieldSpec> = {}) => dispatch({ type: "add-field", patch: { key, ...patch } });
  const body = node?.kind === "agent" ? draft.prompts[node.prompt] ?? "" : "";
  const given = useMemo(() => templateReads(body), [body]);
  const approvals = spec.nodes.filter((n) => n.kind === "approval");
  const [confirming, setConfirming] = useState(false);

  if (!node) return null;
  const title = node.title ?? "";
  const remove = () => { dispatch({ type: "remove-step", id }); onRemoved?.(); };
  // exactly when the removal destroys text nothing can give back: an agent step with
  // instructions written, filed under a prompt id no other step is also using
  const destroysText =
    node.kind === "agent" &&
    body.trim() !== "" &&
    spec.nodes.filter((n) => n.kind === "agent" && n.prompt === node.prompt).length === 1;

  return (
    <div className="flex flex-col gap-3">
      <div className="field-hint">Step id <code>{node.id}</code> — it never changes, because a run's history is written against it.</div>
      <Label>
        What this step is called
        <Input value={title} onChange={(e) => set({ ...node, title: e.target.value })} placeholder="Draft the document" />
      </Label>

      {node.kind === "agent" && (
        <>
          <Label>
            Instructions for the agent
            <Textarea
              rows={10} spellCheck={false} value={body}
              aria-label="the agent's instructions"
              onChange={(e) => dispatch({ type: "set-prompt", id: node.prompt, body: e.target.value })}
            />
          </Label>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="field-hint">Insert a field:</span>
            {spec.fields.map((f) => (
              <Button
                key={f.key} variant="outline" size="sm"
                onClick={() => dispatch({ type: "set-prompt", id: node.prompt, body: `${body}{{ context.${f.key} }}` })}
              >
                {f.key}
              </Button>
            ))}
          </div>
          <div className="field-hint">
            This step will be given:{" "}
            {given.length ? given.map((k) => <Badge key={k} variant="outline" className="mr-1 font-mono">{k}</Badge>) : "nothing — it reads no fields."}
            {" "}Whatever the instructions mention is what it gets; there is nothing else to declare.
          </div>
          <Produces
            spec={spec} value={node.writes} onChange={(writes) => set({ ...node, writes })} onAddField={(k) => addField(k)}
            hint="Howdah asks the agent for exactly these and refuses an answer that is missing one."
          />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Label>
              Retries before it parks
              <Input
                type="number" min="1" value={node.maxVisits ?? ""} placeholder="unlimited"
                onChange={(e) => set({ ...node, maxVisits: e.target.value ? Number(e.target.value) : undefined })}
              />
            </Label>
            <Label>
              Wait for an approval step first
              <Select value={node.requires ?? ""} onChange={(e) => set({ ...node, requires: e.target.value || undefined })}>
                <option value="">no — start whenever it is reached</option>
                {approvals.map((a) => <option key={a.id} value={a.id}>{a.title || a.id}</option>)}
              </Select>
            </Label>
          </div>
          <Checkbox
            label="Planning only — this step may read but never write files"
            checked={node.readOnly === true}
            onChange={(e) => set({ ...node, readOnly: e.target.checked ? true : undefined })}
          />
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">Which model runs this step</summary>
            <div className="flex flex-col gap-2 pt-2">
              <ConfigFields value={node.config ?? {}} onChange={(config) => set({ ...node, config: parseAgentConfig(config) })} />
            </div>
          </details>
        </>
      )}

      {node.kind === "command" && (() => {
        const builtin = commandBuiltin(node.run);
        return (
          <>
            <Label>
              What to run
              <Select
                value={builtin?.run ?? "shell"}
                onChange={(e) => {
                  // switching kinds drops produced keys the new one cannot emit — but that
                  // is the REDUCER's rule now (lib/spec-draft.ts withEmittableWrites), for
                  // both forms at once, rather than a filter only this one remembered.
                  // The READS are seeded here instead of in the reducer, because a rule
                  // broad enough to be total would strip `goal` / `work` off an imported
                  // `map:extract` step the moment anyone opened it. This is a convenience,
                  // not the gate: specProblems() reports a step missing what its built-in
                  // works from, in the browser on every keystroke and again at the save.
                  const next = COMMAND_BUILTINS.find((b) => b.run === e.target.value);
                  set({ ...node, run: next ? next.run : "", reads: next?.reads ?? [] });
                }}
              >
                {COMMAND_BUILTINS.map((b) => <option key={b.run} value={b.run}>{b.label} ({b.run})</option>)}
                <option value="shell">a shell script of my own</option>
              </Select>
            </Label>
            {builtin?.reads && (
              <div className="field-hint">
                It works from{" "}
                {builtin.reads.map((k) => <Badge key={k} variant="outline" className="mr-1 font-mono">{k}</Badge>)}
                {" "}— the built-in reads those by name, so the graph has to produce them before this step runs.
              </div>
            )}
            {!builtin && (
              <Label>
                The script
                <Textarea rows={5} spellCheck={false} aria-label="the shell script" value={node.run} onChange={(e) => set({ ...node, run: e.target.value })} />
              </Label>
            )}
            <Produces
              spec={spec} value={node.writes} onChange={(writes) => set({ ...node, writes })}
              onAddField={(k) => addField(k, { scope: "per-visit" })}
              only={builtin?.produces}
              hint={builtin
                ? "These are the only facts this built-in emits."
                : "Your script's LAST line of output must be a single JSON object with exactly these keys, or the attempt fails."}
            />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Label>
                Give up after (seconds)
                <Input
                  type="number" min="1" value={node.timeoutMs ? node.timeoutMs / 1000 : ""} placeholder="no limit"
                  onChange={(e) => set({ ...node, timeoutMs: e.target.value ? Number(e.target.value) * 1000 : undefined })}
                />
              </Label>
              <Label>
                Retries before it parks
                <Input
                  type="number" min="1" value={node.maxVisits ?? ""} placeholder="unlimited"
                  onChange={(e) => set({ ...node, maxVisits: e.target.value ? Number(e.target.value) : undefined })}
                />
              </Label>
            </div>
          </>
        );
      })()}

      {node.kind === "worktree" && (
        <>
          <Label>
            What it does
            <Select value={node.action} onChange={(e) => set({ ...node, action: e.target.value as "create" | "remove" })}>
              <option value="create">make a worktree on its own branch</option>
              <option value="remove">clean the worktree up afterwards</option>
            </Select>
          </Label>
          <Produces
            spec={spec} value={node.writes} onChange={(writes) => set({ ...node, writes })}
            onAddField={(k) => addField(k, { scope: "per-visit" })}
            only={node.action === "remove" ? WORKTREE_FACTS : []}
            hint={node.action === "remove"
              ? "These two are all a clean-up step reports. A dirty worktree is kept, and says so through them."
              : "Making a worktree reports nothing — it either succeeds or the run parks."}
          />
        </>
      )}

      {node.kind === "wait" && (() => {
        const m = node.duration.match(/^(\d+)\s*(ms|s|m|h)$/);
        const amount = m?.[1] ?? "30";
        const unit = m?.[2] ?? "s";
        return (
          <div className="grid grid-cols-2 gap-3">
            <Label>
              How long
              <Input type="number" min="1" value={amount} onChange={(e) => set({ ...node, duration: `${e.target.value || "0"} ${unit}` })} />
            </Label>
            <Label>
              Unit
              <Select value={unit} onChange={(e) => set({ ...node, duration: `${amount} ${e.target.value}` })}>
                {DURATION_UNITS.map((u) => <option key={u.unit} value={u.unit}>{u.label}</option>)}
              </Select>
            </Label>
          </div>
        );
      })()}

      {node.kind === "approval" && (
        <>
          <Label>
            What you are approving
            <Select value={node.proposal} onChange={(e) => set({ ...node, proposal: e.target.value })}>
              <option value="">pick the field that holds the proposal</option>
              {spec.fields.map((f) => <option key={f.key} value={f.key}>{f.key}</option>)}
            </Select>
          </Label>
          <Label>
            What it was drawn against
            <Select value={node.base} onChange={(e) => set({ ...node, base: e.target.value })}>
              <option value="">pick the field that holds the snapshot</option>
              {spec.fields.map((f) => <option key={f.key} value={f.key}>{f.key}</option>)}
            </Select>
          </Label>
          <Label>
            If you ask for changes, go back to
            <Select value={node.redesignTo} onChange={(e) => set({ ...node, redesignTo: e.target.value })}>
              <option value="">pick the step that redraws it</option>
              {spec.nodes.filter((n) => n.kind !== "terminal" && n.id !== node.id).map((n) => (
                <option key={n.id} value={n.id}>{n.title || n.id}</option>
              ))}
            </Select>
          </Label>
          <div className="field-hint">
            Howdah writes <code>{node.decision}</code> and <code>{node.feedback}</code> itself every time you decide —
            they are this step's, and no other step may produce them.
          </div>
        </>
      )}

      {node.kind === "terminal" && (
        <>
          <Label>
            How the run ends here
            <Select value={node.outcome} onChange={(e) => set({ ...node, outcome: e.target.value as "success" | "failed" | "aborted" })}>
              <option value="success">succeeded</option>
              <option value="failed">failed</option>
              <option value="aborted">aborted</option>
            </Select>
          </Label>
          <Label>
            Why, in one line (optional)
            <Input value={node.label ?? ""} placeholder="Worktree kept — it still has local work" onChange={(e) => set({ ...node, label: e.target.value || undefined })} />
          </Label>
        </>
      )}
      <div className="actions">
        <Button
          variant="destructive" size="sm"
          onClick={() => (destroysText ? setConfirming(true) : remove())}
        >
          <Trash2 />Remove this step
        </Button>
      </div>
      <AlertDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => { setConfirming(false); remove(); }}
        title={`Remove ${title.trim() || id}?`}
        description={
          <>
            This takes the step, every route into and out of it, and the instructions you wrote
            for it. There is no undo.
          </>
        }
        confirmLabel="Remove the step and its instructions"
      />
    </div>
  );
}
