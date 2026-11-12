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
 *
 * HOW-68 (DESIGN.md) rebuilt the SHELL around those three, and changed none of them:
 *
 *   A SCREEN IS A COLUMN: ONE HEADER ROW, THEN THREE PANES. The bar holds the graph's name, the
 *   live verdict as a glyph and words, Save — the one primary action, with its key — and a
 *   More menu for everything secondary. Under it the palette, the canvas and the panel each
 *   own their height and their own scroller; the page never scrolls and nothing is clipped.
 *
 *   THE CANVAS KEEPS ITS WIDTH. At 1024px the old three-column grid left it 106px (audit
 *   3.1.10). Below 1200px the palette folds to a 48px strip of the same six controls; below
 *   1100px the panel stops being a column and becomes the `Drawer` — in the layout, not over
 *   it — which opens when something is selected, or from "Graph settings", and closes on Esc.
 *   The breakpoints read the document's own width, and an environment that cannot measure one
 *   (a test DOM) is treated as wide rather than guessed narrow.
 *
 *   KEYBOARD FIRST. ⌘S saves; 1, 2 and 3 move focus to the palette, the canvas and the panel;
 *   Esc deselects (or closes the drawer). All of it is registered through `useShortcuts`, so it
 *   is in the `?` sheet and the palette. Nothing is bound to Delete or Backspace, on purpose
 *   (builder/canvas.tsx).
 *
 *   THE NAME LIVES IN THE BAR. It was a box in the graph panel, which is not on screen while a
 *   step is selected — so the one fact every unsaved draft is blocked on could not be fixed
 *   from where the count was shown. A saved graph's name is its file name and is not editable,
 *   so there it is the heading instead.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { RunDraft } from "../../draft";
import { ReactFlowProvider } from "@xyflow/react";
import { CircleAlert, CircleCheck, Ellipsis, Lightbulb, Save, SlidersHorizontal } from "lucide-react";
import type { GraphCatalog } from "@/lib/types";
import { navigate } from "@/lib/nav";
import { useDocumentTitle } from "@/lib/page";
import { getJSON } from "@/lib/net";
import { autoLayout } from "@/lib/layout";
import { useEscapeLayer, useShortcuts } from "@/lib/shortcuts";
import type { GraphSpec, Point } from "../../../core/graph-spec";
import { parseGraphSpec } from "../../../core/graph-spec";
import { DRAFT_GRAPH } from "../../../core/catalog";
import {
  PRESETS, bySeverity, draftProblems, draftReducer, newStep, pickPrompts, type Draft, type PaletteKind,
} from "@/lib/spec-draft";
import { GraphCanvas, type Selection } from "../builder/canvas";
import { Palette } from "../builder/palette";
import { PROBLEMS_SLOT, Properties, panelTitle } from "../builder/properties";
import { plainProblem } from "../builder/problem";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Menu, type MenuEntry } from "@/components/ui/menu";
import { ScrollPane } from "@/components/ui/scroll-pane";
import { LoadingBlock } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { Truncate } from "@/components/ui/truncate";

/** A brand-new draft. `blank` is the preset the ticket's core demo starts from. */
const freshDraft = (name: string): Draft => PRESETS[0]!.build(name);

/** below this the palette is a strip of glyphs; the six controls and the name box all stay */
const PALETTE_FULL_FROM = 1200;
/** below this the panel is a drawer that opens on a selection, so the canvas keeps its width */
const PANEL_DOCKED_FROM = 1100;
/** the panel's width, docked or as a drawer: wide enough for a route's sentence on two lines */
const PANEL_WIDTH = 360;

/**
 * How wide the document is, live — or 0 where that cannot be measured.
 *
 * `documentElement.clientWidth` rather than a media query on purpose: it is what the layout
 * actually has (a scrollbar is not canvas), and a DOM with no layout engine answers 0, which
 * the callers read as "do not fold anything" instead of folding a screen nobody measured.
 */
function useDocumentWidth(): number {
  const read = () => (typeof document === "undefined" ? 0 : document.documentElement.clientWidth);
  const [width, setWidth] = useState(read);
  useEffect(() => {
    const on = () => setWidth(read());
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return width;
}

/** the first thing in a pane that can take focus — where a "focus this pane" key lands */
const FOCUSABLE = "input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), a[href], [tabindex='0']";
const focusFirst = (within: Element | null, selector = FOCUSABLE) => within?.querySelector<HTMLElement>(selector)?.focus();

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
  // reframe what just arrived without reframing on every ordinary edit
  const [generation, setGeneration] = useState(0);
  const [loading, setLoading] = useState(!!name || !!fromRun);
  const [unopenable, setUnopenable] = useState<string | null>(null);
  const [taken, setTaken] = useState<string[]>([]);
  useDocumentTitle(draft.saved && draft.spec.name ? `Editing ${draft.spec.name}` : "Build a graph");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  // HOW-68: what folds, and when. 0 = unmeasured = nothing folds.
  const width = useDocumentWidth();
  const compactPalette = width > 0 && width < PALETTE_FULL_FROM;
  const drawer = width > 0 && width < PANEL_DOCKED_FROM;
  // only meaningful while the panel IS a drawer: docked, it is always there
  const [panelOpen, setPanelOpen] = useState(false);
  const paletteRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const settingsRef = useRef<HTMLButtonElement | null>(null);

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
  // HOW-26: the bar's alarm counts what BLOCKS; advice is counted beside it, quieter, so
  // "Ready to save" keeps meaning "validate() is happy" and the builder's own opinion never
  // reads as a refusal
  const { blocking, advice } = useMemo(() => bySeverity(problems), [problems]);

  // a selection that no longer exists is not an error to report but a panel to close: a step
  // can be deleted from the canvas and an edge renumbered by a reorder
  const live: Selection =
    selection?.kind === "step" && !draft.spec.nodes.some((n) => n.id === selection.id) ? null
    : selection?.kind === "edge" && selection.index >= draft.spec.edges.length ? null
    : selection;

  /** From the PANEL: "the graph itself" and a removal both mean "show the graph", so a drawer
   *  stays open on it; picking a step out of a problem list opens it, as any selection does. */
  const onSelect = useCallback((sel: Selection) => {
    setSelection(sel);
    if (sel) setPanelOpen(true);
  }, []);
  /** From the CANVAS: selecting something opens the panel on it, and a click on empty canvas is
   *  "I am done with that" — which, when the panel is a drawer, also gives the canvas its width back. */
  // HOW-68 confirming review: a selection that ENDS takes its form with it — "Remove this step",
  // a removed route, Esc from a field in the panel — and the control that had focus is unmounted,
  // so focus fell to <body> and the next Tab started from the top of the page. It goes to the
  // canvas, where the graph that is left is. Only when focus was actually lost: a click on the
  // canvas, or anything that focused something itself, is left alone.
  const hadSelection = useRef(false);
  useEffect(() => {
    const had = hadSelection.current;
    hadSelection.current = live !== null;
    if (!had || live !== null) return;
    const frame = requestAnimationFrame(() => {
      const now = document.activeElement;
      if (now && now !== document.body && now.isConnected) return;
      focusFirst(canvasRef.current, ".react-flow__node");
    });
    return () => cancelAnimationFrame(frame);
  }, [live]);

  const onCanvasSelect = useCallback((sel: Selection) => {
    setSelection(sel);
    setPanelOpen(sel !== null);
  }, []);
  const closePanel = useCallback(() => { setSelection(null); setPanelOpen(false); }, []);
  // Esc deselects. Docked, that is this layer; as a drawer, the Drawer registers its own and
  // `closePanel` is what it calls — one Escape, one meaning, either way.
  useEscapeLayer(() => setSelection(null), { active: !drawer && live !== null, kind: "panel" });

  /** One way to add a step, whichever gesture asked for it (D7) — palette click or drop. */
  const addStep = useCallback((kind: PaletteKind, at?: Point) => {
    // the OPERATOR'S name seeds the id, not the palette's label (HOW-26). It is passed raw:
    // `newStep` and the palette's preview both hand it to the same `nextNodeId`, so what the
    // box promised is what the step gets — including for a box left empty.
    const made = newStep(draft.spec, kind, stepName.trim());
    dispatch({ type: "add-step", ...made, ...(at ? { position: at } : {}) });
    // the box has been spent; leaving it filled would name the next step the same thing and
    // hand it `<id>-2`, which is the id shape this all exists to remove
    setStepName("");
    setSelection({ kind: "step", id: made.node.id });
    setPanelOpen(true);
  }, [draft.spec, stepName]);

  /**
   * D25: where Save sends you when it will not save — the panel's problem list, opened (it may
   * be a closed drawer), scrolled to and focused. ONE place; no banner, no toast.
   */
  const showProblems = useCallback(() => {
    setSelection(null);
    setPanelOpen(true);
    const land = (tries: number) => {
      const list = panelRef.current?.querySelector<HTMLElement>(`[data-slot="${PROBLEMS_SLOT}"]`);
      if (list) { list.scrollIntoView({ block: "start" }); list.focus({ preventScroll: true }); }
      else if (tries > 0) requestAnimationFrame(() => land(tries - 1)); // the drawer is still mounting
    };
    requestAnimationFrame(() => land(10));
  }, []);

  const save = useCallback(async () => {
    // A draft with no name has no address to be sent to: `/api/graphs//builder` matches no
    // route, the server answers the request with the app's own page and a 200, and the builder
    // announced " saved — it is in the catalog and ready to launch" for a graph that does not
    // exist (found by pressing Save on a fresh draft, HOW-68 fix pass). The missing name is
    // already the first problem in the list — go there.
    if (!draft.spec.name.trim()) { setError(null); showProblems(); return; }
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
      const body = (await r.json().catch(() => null)) as { error?: string; ok?: boolean } | null;
      // a 2xx that is not the builder route's own JSON was answered by something else: not a save
      if (r.ok && body?.ok !== true) throw new Error("the server did not confirm it");
      if (!r.ok) {
        // The PUT is still sent with problems standing — the server is the authority and this
        // is the same save it always was — but a refusal is SAID ONCE (D25). When the browser
        // already lists what blocks the save, the server's 422 is one of those sentences: the
        // operator is taken to the list and nothing is added. Only a refusal the browser could
        // NOT predict (the server is stronger only where it must be) is new information: it is
        // kept as the list's first row, where it can be re-read, and announced by ONE toast —
        // plain text, so core's `**title**` and `` `key` `` markers come out.
        const why = body?.error ?? "The save was refused.";
        showProblems();
        if (blocking.length === 0) {
          setError(why);
          toast(plainProblem(why), "error");
        }
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
      const why = `The save did not reach the server: ${e instanceof Error ? e.message : String(e)}`;
      setError(why);
      showProblems();
      toast(plainProblem(why), "error");
    } finally {
      setSaving(false);
    }
  }, [draft, toast, fromRun, blocking.length, showProblems]);
  // a refusal is about the draft that was sent: the next edit makes it history
  useEffect(() => { setError(null); }, [draft.spec, draft.prompts]);

  const ready = !loading && !unopenable;
  const showGraph = useCallback(() => {
    setSelection(null);
    setPanelOpen(true);
    // the panel may be mounting right now (a drawer that was closed): focus it once it exists
    requestAnimationFrame(() => focusFirst(panelRef.current));
  }, []);
  useShortcuts([
    { id: "builder.save", scope: "Graph builder", label: draft.saved ? "Save changes" : "Save the graph", keys: "mod+s", run: () => { if (!saving) void save(); }, disabled: !ready },
    { id: "builder.palette", scope: "Graph builder", label: "Focus the step palette", keys: "1", run: () => focusFirst(paletteRef.current), disabled: !ready },
    {
      id: "builder.canvas", scope: "Graph builder", label: "Focus the canvas", keys: "2", disabled: !ready,
      // the selected step's card if there is one, else the first card: from there Tab walks the
      // steps and the arrow keys move the selected one
      run: () => {
        const at = live?.kind === "step" ? canvasRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(live.id)}"]`) : null;
        if (at) at.focus(); else focusFirst(canvasRef.current, ".react-flow__node");
      },
    },
    {
      id: "builder.panel", scope: "Graph builder", label: "Focus the panel", keys: "3", disabled: !ready,
      run: () => { setPanelOpen(true); requestAnimationFrame(() => focusFirst(panelRef.current)); },
    },
    { id: "builder.graph", scope: "Graph builder", label: "Show the graph's own settings and problems", run: showGraph, disabled: !ready },
    { id: "builder.deselect", scope: "Graph builder", label: "Deselect, or close the panel", keys: "escape", passive: true },
    { id: "builder.move", scope: "Graph builder", label: "Move the selected step (Shift for 4×)", keys: ["arrowup", "arrowdown", "arrowleft", "arrowright"], passive: true, palette: false },
  ]);

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col p-6">
        <LoadingBlock label={`Opening ${name ?? `the draft from run ${fromRun}`}`} rows={6} />
      </div>
    );
  }
  if (unopenable) {
    return (
      <ScrollPane label="Graph builder">
        <EmptyState
          title="The builder cannot open this graph"
          actions={
            <>
              {/* a graph written or edited by hand still has a home: its source, on the Graphs screen */}
              <Button onClick={() => navigate("/graphs")}>Edit its source on the Graphs screen</Button>
              {fromRun && <Button variant="outline" onClick={() => navigate(`/run/${encodeURIComponent(fromRun)}`)}>Back to the run</Button>}
            </>
          }
        >
          <span className="wrap-pre">{unopenable}</span>
        </EmptyState>
      </ScrollPane>
    );
  }

  const heading = panelTitle(draft, live);
  const more: MenuEntry[] = [
    { label: "Graph settings and problems", onSelect: showGraph },
    { separator: true },
    ...(fromRun && !draft.saved ? [
      { label: "Open the run this draft came from", href: `/run/${encodeURIComponent(fromRun)}` },
      { label: "Back to the draft's review", href: `/runs/${encodeURIComponent(fromRun)}/draft` },
    ] : []),
    ...(!name && !fromRun && !draft.saved ? [
      { label: "Describe it instead — draft a graph", href: `/new?${new URLSearchParams({ graph: DRAFT_GRAPH })}` },
    ] : []),
    { label: draft.saved ? "Edit the source, on the Graphs screen" : "Back to Graphs", href: "/graphs" },
  ];
  const panel = (
    <Properties
      draft={draft} dispatch={dispatch} problems={problems} selection={live} onSelect={onSelect} refusal={error}
      onPreset={(id) => {
        const preset = PRESETS.find((x) => x.id === id);
        if (preset) {
          dispatch({ type: "load", draft: preset.build(draft.spec.name) });
          setSelection(null);
          setGeneration((g) => g + 1);
        }
      }}
    />
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* one row at every supported width. Below 800px — which is 200% browser zoom on a 1280px
          window (WCAG 1.4.4), not a supported window — the bar WRAPS: its controls do not shrink,
          so on one row Save and More were pushed past `main`'s edge, where nothing scrolls. */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4 max-[799px]:h-auto max-[799px]:flex-wrap max-[799px]:gap-y-1.5 max-[799px]:py-1.5">
        <h1 className="m-0 flex min-w-0 shrink items-center text-lg font-semibold leading-6">
          <Truncate>{draft.saved ? `Editing ${draft.spec.name}` : "Build a graph"}</Truncate>
        </h1>
        {!draft.saved && (
          <Input
            mono className="w-44 shrink-0" value={draft.spec.name} placeholder="my-review"
            aria-label="the graph's name — its file name, and how you launch it"
            onChange={(e) => dispatch({ type: "set-name", name: e.target.value })}
          />
        )}
        <span
          role="status"
          aria-label={blocking.length ? `${blocking.length} ${blocking.length === 1 ? "problem" : "problems"} to fix before saving` : "nothing outstanding"}
          className={`inline-flex shrink-0 items-center gap-1.5 text-base ${blocking.length ? "font-medium text-destructive" : "text-muted-foreground"}`}
        >
          {blocking.length
            ? <><CircleAlert aria-hidden className="size-3.5" />{blocking.length} {blocking.length === 1 ? "problem" : "problems"}<span className="max-[1199px]:sr-only"> to fix before saving</span></>
            : <><CircleCheck aria-hidden className="size-3.5" />Ready to save</>}
        </span>
        {advice.length > 0 && (
          <span role="status" aria-label={`${advice.length} worth a second look`} className="inline-flex shrink-0 items-center gap-1.5 text-base text-muted-foreground">
            <Lightbulb aria-hidden className="size-3.5" />{advice.length} worth a look
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {drawer && (
            <Tooltip content={panelOpen ? "Close the panel" : "The graph's settings, fields and problems"} side="bottom" align="end">
              <Button
                ref={settingsRef} variant="outline" size="icon" aria-expanded={panelOpen} aria-label="Graph settings"
                onClick={() => (panelOpen ? closePanel() : showGraph())}
              >
                <SlidersHorizontal />
              </Button>
            </Tooltip>
          )}
          {/* the key is printed BESIDE the action, not inside it: the button's name stays exactly
              what it does, for assistive tech and for the tests that find it by that name */}
          <Kbd keys="mod+s" decorative />
          <Button onClick={save} loading={saving}>
            {!saving && <Save />}{saving ? "Saving…" : draft.saved ? "Save changes" : "Save and add to the catalog"}
          </Button>
          <Menu label="More" items={more} trigger={<Button variant="outline" size="icon" aria-label="More"><Ellipsis /></Button>} />
        </div>
      </header>
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

      <ReactFlowProvider>
        <div className="flex min-h-0 flex-1">
          <aside ref={paletteRef} aria-label="Step palette" className={`flex shrink-0 flex-col border-r border-border ${compactPalette ? "w-12" : "w-[200px]"}`}>
            <Palette draft={draft} name={stepName} onName={setStepName} onAdd={addStep} compact={compactPalette} />
          </aside>
          <section ref={canvasRef} aria-label="Canvas" className="flex min-w-[320px] flex-1">
            <GraphCanvas
              draft={draft} dispatch={dispatch} problems={problems} generation={generation}
              selection={live} onSelect={onCanvasSelect} onAdd={addStep}
            />
          </section>
          {drawer ? (
            <Drawer
              open={panelOpen} onClose={closePanel} label="Graph builder panel" title={<Truncate>{heading}</Truncate>}
              width={PANEL_WIDTH} returnFocus={settingsRef}
            >
              <div ref={panelRef as React.RefObject<HTMLDivElement>}>{panel}</div>
            </Drawer>
          ) : (
            <aside ref={panelRef} aria-label="Graph builder panel" className="flex w-[360px] shrink-0 flex-col border-l border-border">
              <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
                <h2 className="m-0 flex min-w-0 flex-1 text-base font-semibold"><Truncate>{heading}</Truncate></h2>
              </header>
              <ScrollPane label={heading} className="p-4">{panel}</ScrollPane>
            </aside>
          )}
        </div>
      </ReactFlowProvider>
    </div>
  );
}
