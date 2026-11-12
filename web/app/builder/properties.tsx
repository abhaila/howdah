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
 *
 * HOW-68 (DESIGN.md). The panel was a column of `Card`s; it is now the sections of ONE pane —
 * a label, a sentence, the controls, a hairline — and the pane's chrome (its heading, its
 * scroller, and whether it is docked or a drawer) belongs to the shell, which is why this
 * returns the BODY only and exports `panelTitle` for the heading. Three things moved:
 *
 *   WHAT IS WRONG COMES FIRST. The graph's list of what blocks a save sat under the name, the
 *   fields and the model defaults — below the fold of the thing the bar's count sends you to.
 *   It is the first section now, and each row that names a step is a control that goes there.
 *
 *   A PROBLEM IS A GLYPH AND WORDS (builder/problem.tsx), and advice is visibly the quieter of
 *   the two. Neither is amber.
 *
 *   "REMOVE THIS STEP" IS AT THE FOOT, after the routes, as a destructive OUTLINE: it is the
 *   one control here that destroys something, so it is last and it is not the loudest thing on
 *   the panel. The graph's NAME moved to the bar (screens/graph-builder.tsx), where it is
 *   reachable while a step is selected; this panel says what the name becomes.
 */

import { ChevronLeft, CircleCheck, Play } from "lucide-react";
import { parseAgentConfig, promptIdFor, type SpecProblem } from "../../../core/graph-spec";
import { PRESETS, bySeverity, type Draft, type DraftAction } from "@/lib/spec-draft";
import { ConfigFields } from "../screens/graphs";
import { FieldsPane } from "./fields";
import { RemoveStep, StepFields } from "./step-form";
import { KIND_ICON, KIND_LABEL, stepSummary } from "./node-card";
import { ConditionEditor, StepRoutes } from "./branching";
import { Problem, ProblemGlyph, ProblemText } from "./problem";
import { Section } from "./section";
import type { Selection } from "./canvas";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Row } from "@/components/ui/row";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/** A problem belongs to the step it NAMES; one that names none belongs to the graph (D3). */
export const problemsOfStep = (problems: SpecProblem[], id: string) => problems.filter((p) => p.node === id);

/** What the pane is showing, as its heading — the shell draws it (docked header or drawer). */
export function panelTitle(draft: Draft, selection: Selection): string {
  if (selection?.kind === "edge") return "This route";
  if (selection?.kind === "step") {
    const node = draft.spec.nodes.find((n) => n.id === selection.id);
    if (node) return node.title?.trim() || node.id;
  }
  return "The graph";
}

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
    const Icon = KIND_ICON[node.kind];
    const kindLine = (
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span>{KIND_LABEL[node.kind]}</span>
        {spec.entry === node.id && <span className="inline-flex items-center gap-1"><span aria-hidden>·</span><Play aria-hidden className="size-3 fill-current" />the run starts here</span>}
      </div>
    );
    // HOW-73: a parallel step is opened and drawn, not edited here yet — say what it does, say
    // where it is changed, and still list what is wrong with it
    if (node.kind === "parallel")
      return (
        <div className="flex flex-col">
          <BackToGraph onSelect={onSelect} />
          <Section title="This step" hint={`Runs these steps at the same time, then continues at ${node.join || "—"}.`}>
            {kindLine}
            <p className="m-0 text-base">{stepSummary(spec, node)}</p>
            <p className="m-0 text-base text-muted-foreground">Editing a step that runs others at once is not supported here yet — edit the graph's source.</p>
          </Section>
          {mine.length > 0 && (
            <Section title="Problems with this step">
              {mine.map((p, i) => <Problem key={i} problem={p} />)}
            </Section>
          )}
        </div>
      );
    // by SEVERITY (HOW-26): advice describes a step that RUNS and is merely not what was
    // probably meant, and printing it in the refusal colour would say the save is blocked
    // when it is not. The branching ones are printed with the routes they are about.
    const own = mine.filter((p) => p.where !== "branching");
    return (
      <div className="flex flex-col">
        <BackToGraph onSelect={onSelect} />
        {own.length > 0 && (
          <Section title="Problems with this step">
            {own.map((p, i) => <Problem key={i} problem={p} />)}
          </Section>
        )}
        <Section title="This step" hint="What this step does, and what happens after it.">
          {kindLine}
          <StepFields
            draft={draft} id={node.id} dispatch={dispatch} removeControl={false}
            // a rename moves the id the selection is keyed by, so the panel follows it
            // rather than emptying itself on an id that no longer exists (HOW-26)
            onRenamed={(to) => onSelect({ kind: "step", id: to })}
          />
          {spec.entry !== node.id && node.kind !== "terminal" && (
            <div className="flex">
              <Button variant="outline" size="sm" onClick={() => dispatch({ type: "set-entry", id: node.id })}>
                <Play />Start the run here
              </Button>
            </div>
          )}
        </Section>
        {node.kind !== "terminal" && (
          <Section title="Goes to" hint="The same routes as the wires on the canvas — set here when you would rather not draw one.">
            <StepRoutes draft={draft} from={node.id} problems={mine.filter((p) => p.where === "branching")} dispatch={dispatch} />
          </Section>
        )}
        <Section title="Remove" hint="Takes the step and every route into and out of it. There is no undo.">
          <div className="flex">
            <RemoveStep draft={draft} id={node.id} dispatch={dispatch} onRemoved={() => onSelect(null)} />
          </div>
        </Section>
      </div>
    );
  }

  if (selection?.kind === "edge") {
    return (
      <div className="flex flex-col">
        <BackToGraph onSelect={onSelect} />
        <Section title="When the run takes it, and where it goes">
          {/* removing an edge renumbers every later one, so the panel that removed it closes
              itself rather than silently retargeting to whatever slid into that index — the
              same wiring `RemoveStep` has above (HOW-24 review, finding 1) */}
          <ConditionEditor draft={draft} index={selection.index} dispatch={dispatch} onRemoved={() => onSelect(null)} />
        </Section>
      </div>
    );
  }

  return <GraphPanel draft={draft} dispatch={dispatch} problems={problems} onSelect={onSelect} onPreset={onPreset} />;
}

/** Clicking empty canvas deselects too, but "click nothing" is not an affordance — and the
 *  graph's own settings, its fields and the list of everything outstanding all live behind it. */
function BackToGraph({ onSelect }: { onSelect: (sel: Selection) => void }) {
  return (
    <div className="-ml-2 flex pb-2">
      <Button variant="ghost" size="sm" onClick={() => onSelect(null)}><ChevronLeft />The graph itself</Button>
    </div>
  );
}

/** One row of a problem list: a control that goes to the step it names, or plain words. */
function ProblemRow({ problem, onSelect }: { problem: SpecProblem; onSelect: (sel: Selection) => void }) {
  const node = problem.node;
  if (!node) return <Problem problem={problem} />;
  return (
    <Row
      className="-mx-2 flex w-auto min-h-8 items-start gap-2 rounded-[var(--radius-sm)] px-2 py-1.5"
      aria-label={`Go to the step this is about: ${problem.message}`}
      onClick={() => onSelect({ kind: "step", id: node })}
    >
      <ProblemGlyph problem={problem} />
      <span className={`${problem.severity === "advice" ? "field-advice" : "field-error"} min-w-0`}><ProblemText message={problem.message} /></span>
    </Row>
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
  const { blocking, advice } = bySeverity(problems);
  return (
    <div className="flex flex-col">
      {/* asked FIRST for a new graph (HOW-26). It used to sit below the name box, so the
          ticket's operator typed a name, started on `blank` without ever seeing the list, and
          hand-built — step by step, with no worktree — the graph the `code` and `pr` presets
          already are. It is the biggest decision on this panel and it was the third thing on it. */}
      {!saved && (
        <Section title="Start from" hint="A starting point, not a cage — every step, field and branch stays editable.">
          <div className="flex flex-col gap-2">
            {PRESETS.map((p) => (
              <div key={p.id} className="flex flex-col items-start gap-0.5">
                <Button variant="outline" size="sm" onClick={() => onPreset(p.id)}>{p.label}</Button>
                <span className="field-hint">{p.description}</span>
              </div>
            ))}
          </div>
          <div className="field-hint">
            Picking one replaces the steps and fields you have now, so pick it first. Each one
            is a graph that already works: nothing in it is advised against, and every agent
            step is told what it needs.
          </div>
        </Section>
      )}

      {/* HOW-26 splits the verdict in two, and the split is the whole point of the ticket.
          What BLOCKS is what `validate()` refuses — "Ready to save" still means exactly that,
          so the sentence keeps its meaning. What is ADVICE is a graph that will load, validate
          and run and still not do what was meant: an agent told nothing, a branch on free
          text, a loop with no limit. None of it is refused, here or at the server, because the
          operator is the authority on their own graph — but it is counted and printed, because
          the graph in the ticket said "Ready to save" and then spun forever on an
          unconditional edge to itself. */}
      <Section
        title={blocking.length === 0 ? "Ready to save" : `${blocking.length} thing${blocking.length === 1 ? "" : "s"} to sort out`}
        hint={blocking.length === 0
          ? "Every step is reachable, every field a step reads is written before it gets there, and every branch goes somewhere."
          : "Saving is still allowed — the server checks again and keeps the last good version if it refuses."}
      >
        {blocking.length === 0 ? (
          <div className="flex items-center gap-2 text-base text-muted-foreground"><CircleCheck aria-hidden className="size-3.5 shrink-0" />Nothing outstanding.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {blocking.map((p, i) => <ProblemRow key={i} problem={p} onSelect={onSelect} />)}
          </div>
        )}
      </Section>

      {advice.length > 0 && (
        <Section
          title={`${advice.length} thing${advice.length === 1 ? "" : "s"} worth a second look`}
          hint="None of these stop the graph running, and none of them stop the save. They are the things a graph can do and still not be the graph you meant."
        >
          <div className="flex flex-col gap-1">
            {advice.map((p, i) => <ProblemRow key={i} problem={p} onSelect={onSelect} />)}
          </div>
        </Section>
      )}

      <Section
        title="What is it called?"
        hint={<>The name is the file name under <code>$HOWDAH_HOME/graphs</code>, and it is how you launch a run.</>}
      >
        <div className="text-base">
          {spec.name
            ? <code className="[overflow-wrap:anywhere]">graphs/{spec.name}.ts</code>
            : <span className="text-muted-foreground">Not named yet — type a name in the bar above the canvas.</span>}
        </div>
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
      </Section>

      <FieldsPane draft={draft} dispatch={dispatch} />

      <Section title="Which model the steps use" hint="The graph's default. A step can still say otherwise in its own form.">
        <ConfigFields value={spec.defaults ?? {}} onChange={(config) => dispatch({ type: "set-defaults", config: parseAgentConfig(config) ?? {} })} />
      </Section>

      <Section
        title="What saving writes"
        hint={<>Under <code>$HOWDAH_HOME</code> — never in the Howdah repo, so updating Howdah leaves it alone.</>}
      >
        <div className="flex flex-col gap-1 font-mono text-xs [overflow-wrap:anywhere]">
          <div>graphs/{spec.name || "…"}.ts</div>
          {agents.map((n) => (
            <div key={n.id}>prompts/{n.kind === "agent" ? n.prompt : promptIdFor(spec.name, n.id)}.md</div>
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
      </Section>
    </div>
  );
}
