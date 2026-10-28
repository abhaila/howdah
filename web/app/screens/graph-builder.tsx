/**
 * The graph builder (HOW-22), rebuilt as a canvas (HOW-24).
 *
 * shaping.md's D2 said authoring stays TS-native because "there is no visual editor to drift
 * out of sync". This is the editor, and the way it avoids the drift is that there is still
 * only ONE artifact: a `.ts` file in `$HOWDAH_HOME/graphs` that `graphs/local.ts` imports,
 * validates and gates exactly as before. What changed in HOW-22 was what the file may contain
 * — a GraphSpec literal plus one `buildGraph()` call. What changed in HOW-24 is only how you
 * type it.
 *
 * HOW-24 replaced a five-pane wizard, and the complaint the ticket made about it was
 * structural. ONE step was split across three panes — its identity in Steps, the values it
 * passes in Fields, what happens after it in Branching — so every question about a step was
 * answered in three places and re-united by the operator. The picture could only be read. And
 * "this step, then that one" was said in a `<select>` row under the fourth tab. Here the
 * picture IS the editor, and a step is one thing in one place.
 *
 * The shell owns three things and delegates the rest:
 *
 *   THE DRAFT. One reducer (lib/spec-draft.ts), because the edits are coupled — removing a
 *   step takes its edges and its instructions, renaming the graph moves its prompt ids. Every
 *   canvas gesture dispatches one of those same actions; there is no second edit path.
 *
 *   THE VERDICT, LIVE. `draftProblems()` runs `Graph.validate()` IN THE BROWSER on every
 *   change (core/graph-spec.ts is node-free for this reason alone), and a problem is drawn on
 *   the step that owns it, so nothing is discovered only at Save. There is no validation route
 *   and no debounce to tune; the server still runs the same `specProblems()` when saving, so
 *   this is belt-and-braces rather than a second truth.
 *
 *   THE SELECTION. What the right-hand panel is showing: a step, a route, or the graph. It
 *   lives here rather than in React Flow's store, so it survives a re-render, a rename and an
 *   edge being renumbered.
 *
 * HOW-65: `/graphs/new?fromRun=<run>` opens a draft-graph run's draft as an UNSAVED draft —
 * copies already written out as text, laid out on the way in — under a header naming the run.
 * Its Save is the ordinary create, carrying `fromRun` so the SERVER stamps the provenance
 * (`drafted`, marked edited); nothing here sends a `drafted` of its own. A draft that is
 * already a graph opens that graph instead, so a second tab cannot save it twice.
 *
 * HOW-71: a blank `/graphs/new` offers drafting in one quiet line, since hand building is now
 * the secondary way in. Never on `/graphs/:name/build` or `?fromRun=`: both are deliberate
 * hand edits, and the line goes once the first save turns the route into `/build`.
 */
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { RunDraft } from "../../draft";
import { ReactFlowProvider } from "@xyflow/react";
import { CircleAlert, CircleCheck, Lightbulb, Save } from "lucide-react";
import type { GraphCatalog } from "@/lib/types";
import { navigate } from "@/lib/nav";
import { getJSON } from "@/lib/net";
import { autoLayout } from "@/lib/layout";
import type { GraphSpec, Point } from "../../../core/graph-spec";
import { parseGraphSpec } from "../../../core/graph-spec";
import { DRAFT_GRAPH } from "../../../core/catalog";
import {
  PRESETS, bySeverity, draftProblems, draftReducer, newStep, pickPrompts, type Draft, type StepKind,
} from "@/lib/spec-draft";
import { GraphCanvas, type Selection } from "../builder/canvas";
import { Palette } from "../builder/palette";
import { Properties } from "../builder/properties";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingBlock } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";

/** A brand-new draft. `blank` is the preset the ticket's core demo starts from. */
const freshDraft = (name: string): Draft => PRESETS[0]!.build(name);

/**
 * An existing builder graph, read back. The prompt bodies are fetched one per agent step —
 * they are not on the graph DTO, because a graph's shape and its prompt text are separate
 * read models everywhere else in this app and joining them here would be the only place.
 *
 * A graph built before HOW-24 carries no positions, so it is laid out on the way in. Nothing
 * is written by that: the arrangement becomes part of the spec at the next save.
 */
async function loadDraft(name: string): Promise<Draft | { unopenable: string }> {
  const dto = await getJSON<{ spec?: unknown; builder?: boolean }>(`/api/graphs/${name}`);
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
  return { spec: autoLayout(parsed.spec), prompts, saved: true };
}

/** A draft-graph run's draft → a builder Draft, or why it cannot be opened (HOW-65). */
async function loadRunDraft(run: string): Promise<Draft | { unopenable: string } | { savedAs: string }> {
  const got = (await fetch(`/api/runs/${encodeURIComponent(run)}/draft`).then((r) => r.json())) as RunDraft;
  if (got.state !== "ready") return { unopenable: got.reason };
  if (got.saved) return { savedAs: got.saved.name };
  return { spec: autoLayout(got.draft.spec), prompts: got.texts, saved: false };
}

export function GraphBuilder({ name, fromRun }: { name?: string; fromRun?: string }) {
  const [draft, dispatch] = useReducer(draftReducer, undefined, () => freshDraft(name ?? ""));
  const [selection, setSelection] = useState<Selection>(null);
  // what the NEXT step will be called. It lives here rather than in the palette because a drop
  // starts in the palette and lands on the canvas, and HOW-26's rule is that the id comes from
  // the operator's own words whichever gesture placed the step.
  const [stepName, setStepName] = useState("");
  // every wholesale replacement of the draft — a preset, a graph read back — so the canvas can
  // refit to what just arrived without refitting on every ordinary edit
  const [generation, setGeneration] = useState(0);
  const [loading, setLoading] = useState(!!name || !!fromRun);
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
        else { dispatch({ type: "load", draft: got }); setGeneration((g) => g + 1); }
      })
      .catch(() => live && setUnopenable(`Could not read ${name}.`))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [name]);

  useEffect(() => {
    if (name || !fromRun) return;
    let live = true;
    setLoading(true);
    loadRunDraft(fromRun)
      .then((got) => {
        if (!live) return;
        if ("savedAs" in got) navigate(`/graphs/${got.savedAs}/build`);
        else if ("unopenable" in got) setUnopenable(got.unopenable);
        else { dispatch({ type: "load", draft: got }); setGeneration((g) => g + 1); }
      })
      .catch(() => live && setUnopenable(`Could not read the draft from run ${fromRun}.`))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [name, fromRun]);

  // `taken` is the catalog, and the one fact a spec cannot carry: it turns a create that
  // would land on an existing graph into a counted problem rather than a silent save
  const problems = useMemo(() => draftProblems(draft, { taken }), [draft, taken]);
  // HOW-26: the bar's alarm counts what BLOCKS; advice is counted beside it in a quieter
  // badge, so "Ready to save" keeps meaning "validate() is happy" and the builder's own
  // opinion never reads as a refusal
  const { blocking, advice } = useMemo(() => bySeverity(problems), [problems]);

  // a selection that no longer exists is not an error to report but a panel to close: a step
  // can be deleted from the canvas and an edge renumbered by a reorder
  const live: Selection =
    selection?.kind === "step" && !draft.spec.nodes.some((n) => n.id === selection.id) ? null
    : selection?.kind === "edge" && selection.index >= draft.spec.edges.length ? null
    : selection;

  const onSelect = useCallback((sel: Selection) => setSelection(sel), []);

  /** One way to add a step, whichever gesture asked for it (D7) — palette click or drop. */
  const addStep = useCallback((kind: StepKind, at?: Point) => {
    // the OPERATOR'S name seeds the id, not the palette's label (HOW-26). It is passed raw:
    // `newStep` and the palette's preview both hand it to the same `nextNodeId`, so what the
    // box promised is what the step gets — including for a box left empty.
    const made = newStep(draft.spec, kind, stepName.trim());
    dispatch({ type: "add-step", ...made, ...(at ? { position: at } : {}) });
    // the box has been spent; leaving it filled would name the next step the same thing and
    // hand it `<id>-2`, which is the id shape this all exists to remove
    setStepName("");
    setSelection({ kind: "step", id: made.node.id });
  }, [draft.spec, stepName]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/graphs/${draft.spec.name}/builder`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        // pickPrompts, not draft.prompts: the payload is DERIVED from the spec, so a body
        // for a step that no longer exists cannot reach the server — which refuses one, and
        // used to refuse every save for the rest of the session over it (HOW-22 review).
        // `intent` is DECLARED rather than inferred server-side from a stat: an unsaved draft
        // is a create, and a create landing on an existing name must be refused, not written
        // over that graph (HOW-22 review).
        // HOW-65: `fromRun` asks the server to stamp this run's provenance; only on the create
        body: JSON.stringify({
          spec: draft.spec, prompts: pickPrompts(draft), intent: draft.saved ? "update" : "create",
          ...(fromRun && !draft.saved ? { fromRun } : {}),
        }),
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
  }, [draft, toast, fromRun]);

  if (loading) return <div className="runs"><LoadingBlock label={`Opening ${name ?? `the draft from run ${fromRun}`}`} rows={6} /></div>;
  if (unopenable) {
    return (
      <div className="runs">
        <h1>Graph builder</h1>
        <EmptyState>{unopenable}</EmptyState>
        <div className="actions"><Button variant="outline" onClick={() => navigate("/graphs")}>Back to Graphs</Button></div>
      </div>
    );
  }

  return (
    <div className="runs builder">
      <div className="gb-bar">
        <h1>{draft.saved ? `Editing ${draft.spec.name}` : "Build a graph"}</h1>
        <Badge
          variant={blocking.length ? "attention" : "outline"}
          aria-label={blocking.length ? `${blocking.length} to sort out` : "nothing outstanding"}
        >
          {blocking.length ? <><CircleAlert size={11} />{blocking.length} to sort out</> : <><CircleCheck size={11} />Ready to save</>}
        </Badge>
        {advice.length > 0 && (
          <Badge variant="outline" aria-label={`${advice.length} worth a second look`}>
            <Lightbulb size={11} />{advice.length} worth a second look
          </Badge>
        )}
        <Button className="ml-auto" onClick={save} disabled={saving}>
          <Save />{saving ? "Saving…" : draft.saved ? "Save changes" : "Save and add to the catalog"}
        </Button>
      </div>
      {fromRun && !draft.saved && (
        <p className="gb-from-run">
          Editing draft from run <a href={`/run/${encodeURIComponent(fromRun)}`}>{fromRun}</a>
          <span aria-hidden> · </span><a href={`/runs/${encodeURIComponent(fromRun)}/draft`}>back to review</a>
        </p>
      )}
      {!name && !fromRun && !draft.saved && (
        <p className="gb-draft-hint">
          Rather describe it? <a href={`/new?${new URLSearchParams({ graph: DRAFT_GRAPH })}`}>Draft a graph</a>
        </p>
      )}
      {error && <div className="field-error wrap-pre">{error}</div>}

      <ReactFlowProvider>
        <div className="gb">
          <Palette draft={draft} name={stepName} onName={setStepName} onAdd={addStep} />
          <GraphCanvas
            draft={draft} dispatch={dispatch} problems={problems} generation={generation}
            selection={live} onSelect={onSelect} onAdd={addStep}
          />
          <Properties
            draft={draft} dispatch={dispatch} problems={problems} selection={live} onSelect={onSelect}
            onPreset={(id) => {
              const preset = PRESETS.find((x) => x.id === id);
              if (preset) {
                dispatch({ type: "load", draft: preset.build(draft.spec.name) });
                setSelection(null);
                setGeneration((g) => g + 1);
              }
            }}
          />
        </div>
      </ReactFlowProvider>
    </div>
  );
}
