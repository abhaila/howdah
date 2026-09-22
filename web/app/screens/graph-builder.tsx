/**
 * The graph builder (HOW-22) — build a complete, runnable Howdah graph from forms.
 *
 * shaping.md's D2 said authoring stays TS-native because "there is no visual editor to drift
 * out of sync". This is the editor, and the way it avoids the drift is that there is still
 * only ONE artifact: a `.ts` file in `$HOWDAH_HOME/graphs` that `graphs/local.ts` imports,
 * validates and gates exactly as before. What changed is what the file may contain — a
 * GraphSpec literal plus one `buildGraph()` call — which is why re-opening this reads the
 * spec that was written rather than guessing one back out of TypeScript.
 *
 * The shell owns three things and delegates the rest:
 *
 *   THE DRAFT. One reducer (lib/spec-draft.ts), because the edits are coupled — removing a
 *   step takes its edges, renaming the graph moves its prompt ids.
 *
 *   THE VERDICT, LIVE. `draftProblems()` runs `Graph.validate()` IN THE BROWSER on every
 *   keystroke (core/graph-spec.ts is node-free for this reason alone) and the rail counts
 *   them per pane, so nothing is discovered only at Save. There is no validation route and
 *   no debounce to tune; the server still runs the real gate when saving, so this is
 *   belt-and-braces rather than a second truth.
 *
 *   THE PICTURE. The same GraphDag the tuner and the run view draw, fed straight off the
 *   draft. It moves with the typing because it costs one pure function, not a fetch.
 */
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { ArrowLeft, ArrowRight, CircleAlert, CircleCheck } from "lucide-react";
import type { GraphCatalog } from "@/lib/types";
import { navigate } from "@/lib/nav";
import { getJSON } from "@/lib/net";
import { GraphDag, type GraphShapeDto } from "../graph-dag";
import type { GraphSpec, ProblemPane } from "../../../core/graph-spec";
import { parseGraphSpec } from "../../../core/graph-spec";
import {
  PRESETS, draftProblems, draftReducer, problemsByPane, specToShape, type Draft,
} from "@/lib/spec-draft";
import { BasicsPane } from "../builder/basics";
import { BranchingPane } from "../builder/branching";
import { FieldsPane } from "../builder/fields";
import { ReviewPane } from "../builder/review";
import { StepForm } from "../builder/step-form";
import { StepsPane } from "../builder/steps";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingBlock } from "@/components/ui/skeleton";
import { Row } from "@/components/ui/row";
import { useToast } from "@/components/ui/toast";

/** the wizard's five panes; the first four are where problems are ANSWERED, Review is where
 *  they are all counted once (which is why it carries no `pane` of its own) */
const PANES: Array<{ id: ProblemPane | "review"; label: string; blurb: string }> = [
  { id: "basics", label: "Basics", blurb: "name it and pick where it starts" },
  { id: "fields", label: "What it works with", blurb: "the values steps pass between them" },
  { id: "steps", label: "Steps", blurb: "what the run actually does" },
  { id: "branching", label: "Branching", blurb: "what happens after each step" },
  { id: "review", label: "Review & save", blurb: "the verdict, and what gets written" },
];

/** A brand-new draft. `blank` is the preset the ticket's core demo starts from. */
const freshDraft = (name: string): Draft => PRESETS[0]!.build(name);

/**
 * An existing builder graph, read back. The prompt bodies are fetched one per agent step —
 * they are not on the graph DTO, because a graph's shape and its prompt text are separate
 * read models everywhere else in this app and joining them here would be the only place.
 */
async function loadDraft(name: string): Promise<Draft | { unopenable: string }> {
  const dto = await getJSON<GraphShapeDto & { spec?: unknown; builder?: boolean }>(`/api/graphs/${name}`);
  const parsed = parseGraphSpec(dto.spec);
  if (!parsed.ok)
    return { unopenable: `${name} was not built here, so the builder cannot open it: ${parsed.error}` };
  const prompts: Record<string, string> = {};
  await Promise.all(
    parsed.spec.nodes
      .filter((n): n is Extract<GraphSpec["nodes"][number], { kind: "agent" }> => n.kind === "agent")
      .map(async (n) => {
        // a missing body is not an error here: specProblems already reports "has no file yet"
        // in the operator's words, and inventing text would hide that
        const got = await getJSON<{ body: string }>(`/api/local-prompts/${encodeURIComponent(n.prompt)}`).catch(() => null);
        if (got) prompts[n.prompt] = got.body;
      }),
  );
  return { spec: parsed.spec, prompts, saved: true };
}

export function GraphBuilder({ name }: { name?: string }) {
  const [draft, dispatch] = useReducer(draftReducer, undefined, () => freshDraft(name ?? ""));
  const [pane, setPane] = useState<(typeof PANES)[number]["id"]>("basics");
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!name);
  const [unopenable, setUnopenable] = useState<string | null>(null);
  const [taken, setTaken] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    getJSON<GraphCatalog>("/api/graphs")
      .then((c) => setTaken(c.graphs.map((g) => g.name)))
      .catch(() => setTaken([]));
  }, []);

  useEffect(() => {
    if (!name) return;
    let live = true;
    setLoading(true);
    loadDraft(name)
      .then((got) => {
        if (!live) return;
        if ("unopenable" in got) setUnopenable(got.unopenable);
        else dispatch({ type: "load", draft: got });
      })
      .catch(() => live && setUnopenable(`Could not read ${name}.`))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [name]);

  const problems = useMemo(() => draftProblems(draft), [draft]);
  const byPane = useMemo(() => problemsByPane(problems), [problems]);
  const shape = useMemo(() => specToShape(draft.spec), [draft.spec]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/graphs/${draft.spec.name}/builder`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spec: draft.spec, prompts: draft.prompts }),
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        setError(body.error ?? "the save was refused");
        toast(body.error ?? "the save was refused", "error");
        return;
      }
      toast(`${draft.spec.name} saved — it is in the catalog and ready to launch`);
      if (!draft.saved) {
        // the name is the file name and has just become one, so it stops being editable; the
        // URL follows, so a reload re-opens what was saved rather than a fresh draft
        dispatch({ type: "load", draft: { ...draft, saved: true } });
        navigate(`/graphs/${draft.spec.name}/build`);
      }
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setError(why);
      toast(why, "error");
    } finally {
      setSaving(false);
    }
  }, [draft, toast]);

  if (loading) return <div className="runs"><LoadingBlock label={`Opening ${name}`} rows={6} /></div>;
  if (unopenable) {
    return (
      <div className="runs">
        <h1>Graph builder</h1>
        <EmptyState>{unopenable}</EmptyState>
        <div className="actions"><Button variant="outline" onClick={() => navigate("/graphs")}>Back to Graphs</Button></div>
      </div>
    );
  }

  const index = PANES.findIndex((p) => p.id === pane);
  const countFor = (id: (typeof PANES)[number]["id"]) => (id === "review" ? problems.length : byPane[id].length);

  return (
    <div className="runs builder">
      <h1>{draft.saved ? `Editing ${draft.spec.name}` : "Build a graph"}</h1>
      <div className="builder-layout">
        <div className="builder-rail" role="list" aria-label="Builder steps">
          {PANES.map((p) => {
            const n = countFor(p.id);
            return (
              <Row
                key={p.id} role="listitem" className="builder-rail-item" selected={pane === p.id}
                aria-label={`${p.label}${n ? `, ${n} to sort out` : ", nothing outstanding"}`}
                onClick={() => setPane(p.id)}
              >
                <span className="flex flex-col">
                  <span className="builder-rail-label">{p.label}</span>
                  <span className="field-hint">{p.blurb}</span>
                </span>
                <Badge variant={n ? "attention" : "outline"} className="ml-auto">
                  {n ? <><CircleAlert size={11} />{n}</> : <CircleCheck size={11} />}
                </Badge>
              </Row>
            );
          })}
        </div>

        <div className="builder-main">
          {pane === "basics" && (
            <BasicsPane
              draft={draft} dispatch={dispatch} taken={taken}
              onPreset={(id) => {
                const preset = PRESETS.find((x) => x.id === id);
                if (preset) dispatch({ type: "load", draft: preset.build(draft.spec.name) });
              }}
            />
          )}
          {pane === "fields" && <FieldsPane draft={draft} dispatch={dispatch} />}
          {pane === "steps" && <StepsPane draft={draft} dispatch={dispatch} problems={byPane.steps} onOpen={setOpenStep} />}
          {pane === "branching" && <BranchingPane draft={draft} dispatch={dispatch} problems={byPane.branching} />}
          {pane === "review" && <ReviewPane draft={draft} problems={problems} saving={saving} error={error} onSave={save} />}

          {/* the basics pane owns the name, so its problems are printed with it */}
          {pane === "basics" && byPane.basics.map((p, i) => <div key={i} className="field-error">{p.message}</div>)}
          {pane === "fields" && byPane.fields.map((p, i) => <div key={i} className="field-error">{p.message}</div>)}

          <div className="actions">
            <Button variant="outline" size="sm" disabled={index === 0} onClick={() => setPane(PANES[index - 1]!.id)}><ArrowLeft />Back</Button>
            <Button variant="outline" size="sm" disabled={index === PANES.length - 1} onClick={() => setPane(PANES[index + 1]!.id)}>Next<ArrowRight /></Button>
          </div>
        </div>

        <div className="builder-preview">
          <div className="field-hint">What you have so far. Click a step to edit it.</div>
          {draft.spec.nodes.length === 0
            ? <EmptyState>nothing to draw yet</EmptyState>
            : (
              <GraphDag
                shape={shape}
                // the tuner only lets you click an agent, because only an agent has a model
                // to tune; here every step has a form, so every step is a way in
                canSelect={() => true}
                onSelect={(id) => { setPane("steps"); setOpenStep(id); }}
                selected={openStep ?? undefined}
              />
            )}
        </div>
      </div>

      {openStep && <StepForm draft={draft} id={openStep} dispatch={dispatch} onClose={() => setOpenStep(null)} />}
    </div>
  );
}
