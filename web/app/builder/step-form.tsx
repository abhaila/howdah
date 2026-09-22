/**
 * One step's form (HOW-22) — a blocking `<dialog>`, one shape per node kind.
 *
 * The forms are where "no TypeScript, and no JSON either" is actually won, and each one wins
 * it by CONSTRAINING rather than validating after the fact:
 *
 *   - an agent's `reads` is never typed. It is read out of the prompt body with the engine's
 *     own templateReads(), and shown as "This step will be given: …" — so the declaration
 *     and the instructions cannot disagree, and there is nothing to keep in sync by hand.
 *   - a worktree step offers exactly the two facts its executor emits, because a declared
 *     fact the executor never writes fails the attempt at run time.
 *   - a built-in command offers exactly what that built-in produces. A shell script cannot
 *     be constrained, so the form does not pretend to: it says, in those words, that the
 *     script's last line of output must be JSON with these keys.
 *   - a wait's unit is a select, so parseDuration can never be handed something it refuses.
 *   - an approval step's decision and comments keys are its own and are shown read-only;
 *     the redesign target never offers the step that owns the feedback key, because there it
 *     is engine-owned (core/graph.ts approvalProblems).
 */
import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { templateReads } from "../../../core/template-refs";
import { parseAgentConfig, SPEC_FIELD_KEY, type FieldSpec, type GraphSpec, type NodeSpec } from "../../../core/graph-spec";
import { COMMAND_BUILTINS, WORKTREE_FACTS, type Draft, type DraftAction } from "@/lib/spec-draft";
import { ConfigFields } from "../screens/graphs";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

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
  const candidates = only ? [...only] : spec.fields.map((f) => f.key);
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

export function StepForm({ draft, id, dispatch, onClose }: {
  draft: Draft;
  id: string;
  dispatch: (a: DraftAction) => void;
  onClose: () => void;
}) {
  const spec = draft.spec;
  const node = spec.nodes.find((n) => n.id === id);
  const set = (next: NodeSpec) => dispatch({ type: "update-step", id, node: next });
  const addField = (key: string, patch: Partial<FieldSpec> = {}) => dispatch({ type: "add-field", patch: { key, ...patch } });
  const body = node?.kind === "agent" ? draft.prompts[node.prompt] ?? "" : "";
  const given = useMemo(() => templateReads(body), [body]);
  const approvals = spec.nodes.filter((n) => n.kind === "approval");

  if (!node) return null;
  const title = node.title ?? "";

  return (
    <Dialog open onClose={onClose} title={title || node.id} description={`Step id ${node.id} — it never changes, because a run's history is written against it.`} className="w-[min(94vw,680px)]">
      <div className="flex max-h-[68vh] flex-col gap-3 overflow-y-auto pr-1">
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
          const builtin = COMMAND_BUILTINS.find((b) => node.run.trim().split(/\s+/)[0] === b.run);
          return (
            <>
              <Label>
                What to run
                <Select
                  value={builtin?.run ?? "shell"}
                  onChange={(e) => {
                    const next = COMMAND_BUILTINS.find((b) => b.run === e.target.value);
                    // switching kinds drops produced keys the new one cannot emit, rather
                    // than keeping a declaration that would fail the attempt at run time
                    set({ ...node, run: next ? next.run : "", writes: next ? node.writes.filter((k) => next.produces.includes(k)) : node.writes });
                  }}
                >
                  {COMMAND_BUILTINS.map((b) => <option key={b.run} value={b.run}>{b.label} ({b.run})</option>)}
                  <option value="shell">a shell script of my own</option>
                </Select>
              </Label>
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
      </div>

      <div className="flex justify-between gap-2 pt-1">
        <Button
          variant="destructive" size="sm"
          onClick={() => { dispatch({ type: "remove-step", id }); onClose(); }}
        >
          <Trash2 />Remove this step
        </Button>
        <Button size="sm" onClick={onClose}>Done</Button>
      </div>
    </Dialog>
  );
}
