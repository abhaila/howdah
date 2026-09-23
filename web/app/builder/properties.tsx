/**
 * The panel beside the canvas (HOW-24) — the reference project's `sidebar-switch-panel`.
 *
 * It shows whatever is selected, and there are exactly three things to select:
 *
 *   NOTHING → the graph itself. Its name, what it is for, where it starts, what it works with,
 *   which model its steps default to, and the one list of everything still outstanding.
 *   Clicking an issue that names a step selects that step — which is the wizard rail's
 *   per-pane count, made direct: the count told you a pane owed something, this takes you to it.
 *
 *   A STEP → its form (builder/step-form.tsx) and its outgoing routes (builder/branching.tsx),
 *   which is the whole of what the wizard spread across Steps and Branching. One step, one
 *   place.
 *
 *   A ROUTE → its condition and its target.
 *
 * `SpecProblem.where` is untouched by all this. Its four values are named in ~40 messages in
 * core/graph-spec.ts and consumed by graphs/builder.ts; re-spelling them for a new set of UI
 * regions would edit core for a presentation reason. The mapping is here instead, and it is
 * one line: a problem that names a step belongs to that step, and one that does not belongs
 * to the graph.
 */
import { CheckCircle2, ChevronLeft } from "lucide-react";
import { parseAgentConfig, promptIdFor, type SpecProblem } from "../../../core/graph-spec";
import { PRESETS, type Draft, type DraftAction } from "@/lib/spec-draft";
import { ConfigFields } from "../screens/graphs";
import { FieldsPane } from "./fields";
import { StepFields } from "./step-form";
import { ConditionEditor, StepRoutes } from "./branching";
import type { Selection } from "./canvas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Row } from "@/components/ui/row";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/** A problem belongs to the step it NAMES; one that names none belongs to the graph (D3). */
export const problemsOfStep = (problems: SpecProblem[], id: string) => problems.filter((p) => p.node === id);

export function Properties({ draft, dispatch, problems, selection, onSelect, onPreset }: {
  draft: Draft;
  dispatch: (a: DraftAction) => void;
  /** ALL of them: the panel decides which ones belong to what is selected */
  problems: SpecProblem[];
  selection: Selection;
  onSelect: (sel: Selection) => void;
  onPreset: (presetId: string) => void;
}) {
  const { spec } = draft;

  if (selection?.kind === "step") {
    const node = spec.nodes.find((n) => n.id === selection.id);
    if (!node) return <GraphPanel draft={draft} dispatch={dispatch} problems={problems} onSelect={onSelect} onPreset={onPreset} />;
    const mine = problemsOfStep(problems, node.id);
    return (
      <div className="gb-panel">
        <BackToGraph onSelect={onSelect} />
        <Card>
          <CardHeader>
            <CardTitle>{node.title?.trim() || node.id}</CardTitle>
            <CardDescription>What this step does, and what happens after it.</CardDescription>
          </CardHeader>
          <CardContent>
            <StepFields draft={draft} id={node.id} dispatch={dispatch} onRemoved={() => onSelect(null)} />
          </CardContent>
        </Card>
        {node.kind !== "terminal" && (
          <Card>
            <CardHeader>
              <CardTitle>Goes to</CardTitle>
              <CardDescription>
                The same routes as the wires on the canvas — set here when you would rather not draw one.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <StepRoutes draft={draft} from={node.id} problems={mine.filter((p) => p.where === "branching")} dispatch={dispatch} />
            </CardContent>
          </Card>
        )}
        {mine.filter((p) => p.where !== "branching").map((p, i) => (
          <div key={i} className="field-error builder-problem">{p.message}</div>
        ))}
        {spec.entry !== node.id && node.kind !== "terminal" && (
          <div className="actions">
            <Button variant="outline" size="sm" onClick={() => dispatch({ type: "set-entry", id: node.id })}>
              Start the run here
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (selection?.kind === "edge") {
    return (
      <div className="gb-panel">
        <BackToGraph onSelect={onSelect} />
        <Card>
          <CardHeader>
            <CardTitle>This route</CardTitle>
            <CardDescription>When the run takes it, and where it goes.</CardDescription>
          </CardHeader>
          <CardContent>
            <ConditionEditor draft={draft} index={selection.index} dispatch={dispatch} />
          </CardContent>
        </Card>
      </div>
    );
  }

  return <GraphPanel draft={draft} dispatch={dispatch} problems={problems} onSelect={onSelect} onPreset={onPreset} />;
}

/** Clicking empty canvas deselects too, but "click nothing" is not an affordance — and the
 *  graph's own settings, its fields and the list of everything outstanding all live behind it. */
function BackToGraph({ onSelect }: { onSelect: (sel: Selection) => void }) {
  return (
    <div className="actions">
      <Button variant="ghost" size="sm" onClick={() => onSelect(null)}><ChevronLeft />The graph itself</Button>
    </div>
  );
}

function GraphPanel({ draft, dispatch, problems, onSelect, onPreset }: {
  draft: Draft;
  dispatch: (a: DraftAction) => void;
  problems: SpecProblem[];
  onSelect: (sel: Selection) => void;
  onPreset: (presetId: string) => void;
}) {
  const { spec, saved } = draft;
  const agents = spec.nodes.filter((n) => n.kind === "agent");
  return (
    <div className="gb-panel">
      <Card>
        <CardHeader>
          <CardTitle>What is it called?</CardTitle>
          <CardDescription>
            The name is the file name under <code>$HOWDAH_HOME/graphs</code>, and it is how you launch a run.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Label>
            Name
            <Input value={spec.name} disabled={saved} placeholder="my-review" onChange={(e) => dispatch({ type: "set-name", name: e.target.value })} />
          </Label>
          {saved && <div className="field-hint">Saved graphs keep their name — the runs that already happened are filed under it.</div>}
          <Label>
            What it does, in one line
            <Textarea rows={2} value={spec.description} placeholder="Draft a document, review it, and revise until the review passes" onChange={(e) => dispatch({ type: "set-description", description: e.target.value })} />
          </Label>
          <Label>
            Which step runs first
            <Select value={spec.entry} aria-label="the step the run starts at" onChange={(e) => dispatch({ type: "set-entry", id: e.target.value })}>
              <option value="">pick a step</option>
              {spec.nodes.filter((n) => n.kind !== "terminal").map((n) => <option key={n.id} value={n.id}>{n.title || n.id}</option>)}
            </Select>
          </Label>
        </CardContent>
      </Card>

      {!saved && (
        <Card>
          <CardHeader>
            <CardTitle>Start from</CardTitle>
            <CardDescription>A starting point, not a cage — every step, field and branch stays editable.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-2">
              {PRESETS.map((p) => (
                <div key={p.id} className="flex items-center gap-3">
                  <Button variant="outline" size="sm" onClick={() => onPreset(p.id)}>{p.label}</Button>
                  <span className="field-hint">{p.description}</span>
                </div>
              ))}
            </div>
            <div className="field-hint">Picking one replaces the steps and fields you have now.</div>
          </CardContent>
        </Card>
      )}

      <FieldsPane draft={draft} dispatch={dispatch} />

      <Card>
        <CardHeader>
          <CardTitle>Which model the steps use</CardTitle>
          <CardDescription>The graph's default. A step can still say otherwise in its own form.</CardDescription>
        </CardHeader>
        <CardContent>
          <ConfigFields value={spec.defaults ?? {}} onChange={(config) => dispatch({ type: "set-defaults", config: parseAgentConfig(config) ?? {} })} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{problems.length === 0 ? "Ready to save" : `${problems.length} thing${problems.length === 1 ? "" : "s"} to sort out`}</CardTitle>
          <CardDescription>
            {problems.length === 0
              ? "Every step is reachable, every field a step reads is written before it gets there, and every branch goes somewhere."
              : "Saving is still allowed — the server checks again and keeps the last good version if it refuses."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {problems.length === 0 ? (
            <div className="builder-verdict"><CheckCircle2 size={15} /> Nothing outstanding.</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {problems.map((p, i) =>
                p.node ? (
                  <Row
                    key={i} className="builder-problem" needsInput
                    aria-label={`Go to the step this is about: ${p.message}`}
                    onClick={() => onSelect({ kind: "step", id: p.node! })}
                  >
                    <Badge variant="outline">{p.where}</Badge> {p.message}
                  </Row>
                ) : (
                  <div key={i} className="field-error builder-problem">
                    <Badge variant="outline">{p.where}</Badge> {p.message}
                  </div>
                ),
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What saving writes</CardTitle>
          <CardDescription>Under <code>$HOWDAH_HOME</code> — never in the Howdah repo, so updating Howdah leaves it alone.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-1">
            <div className="font-mono text-sm">graphs/{spec.name || "…"}.ts</div>
            {agents.map((n) => (
              <div key={n.id} className="font-mono text-sm">prompts/{n.kind === "agent" ? n.prompt : promptIdFor(spec.name, n.id)}.md</div>
            ))}
          </div>
          <div className="field-hint">
            Removing a step removes its instructions too, and there is no undo — re-adding a
            step with the same name starts from an empty box.
          </div>
          <div className="field-hint">
            Need a condition this vocabulary cannot say? Save, then edit the file under
            "Advanced — source" on the Graphs screen. Hand-editing it means the builder can no
            longer re-open it, and it says so rather than guessing.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
