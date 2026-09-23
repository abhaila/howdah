/**
 * The canvas (HOW-24) — the reference project's `flow-builder`, over Howdah's own draft.
 *
 * The ticket's complaint was structural, not cosmetic: the wizard split ONE step across three
 * tabs (its identity in Steps, the values it passes in Fields, what happens after it in
 * Branching) and then had to keep re-uniting them, while the picture beside it could only be
 * read. Here the picture IS the editor. You drop a step where you want it, drag a wire from
 * one to the next, and edit whatever you selected in the panel beside it.
 *
 * What did NOT change is everything below the presentation layer, and that is the point:
 *
 *   THE DRAFT IS STILL THE ONLY TRUTH. `specToFlow` is a pure function from the draft; React
 *   Flow's own store is never asked what the graph is. Every gesture dispatches an EXISTING
 *   reducer action (or one that normalises through the same helpers), so the coupled edits —
 *   removing a step takes its edges and its instructions, a drawn route is born able to fire —
 *   cannot be forgotten by a new creation path. It was a creation path forgetting one that
 *   produced HOW-22's finding 3.
 *
 *   ONE VERDICT. `draftProblems()` still runs in the browser on every change and
 *   `graphs/builder.ts` still runs the same `specProblems()` over the spec it is about to
 *   write. A problem is drawn ON the step that owns it here instead of counted in a rail.
 *
 *   A DRAG IS ONE EDIT. `move-node` is dispatched on drag END, never per frame — React Flow
 *   owns the intermediate visual state, so the live verdict is not recomputed sixty times a
 *   second while a box is in the air.
 */
import { useCallback, useEffect, useMemo } from "react";
import {
  Background, Controls, ReactFlow, useReactFlow,
  MarkerType, type Edge, type Node, type OnConnect,
} from "@xyflow/react";
import { point, predicateLabel, type GraphSpec, type Point, type SpecProblem } from "../../../core/graph-spec";
import { autoLayout } from "@/lib/layout";
import type { Draft, DraftAction, StepKind } from "@/lib/spec-draft";
import { STEP_KINDS } from "@/lib/spec-draft";
import { StepNode, stepSummary, type StepNodeData } from "./node-card";
import { ConditionEdge, type ConditionEdgeData } from "./edge";
import { STEP_KIND_MIME } from "./palette";

/** What the right-hand panel is showing. `null` is the graph itself. */
export type Selection = { kind: "step"; id: string } | { kind: "edge"; index: number } | null;

const nodeTypes = { step: StepNode };
const edgeTypes = { condition: ConditionEdge };

/** The card's width is the SVG picture's box width, so one graph is one shape wherever it is
 *  drawn. The HEIGHT is not declared: an entry marker and a problem count are extra lines, and
 *  a fixed 52 would clip them — React Flow measures what it renders. */
const NODE_WIDTH = 180;

const isStepKind = (v: string): v is StepKind => STEP_KINDS.some((k) => k.kind === v);

/**
 * The draft as React Flow sees it. Pure, and the only place the two vocabularies meet.
 *
 * A step with no position is placed by `autoLayout` here as well as at load, so a spec that
 * arrived from anywhere — a hand-edited module, a PUT, a graph built before HOW-24 — still
 * draws as an arrangement rather than a pile at the origin.
 */
export function specToFlow(
  spec: GraphSpec,
  problems: SpecProblem[],
  open: (sel: Selection) => void,
): { nodes: Node[]; edges: Edge[] } {
  const laid = autoLayout(spec);
  const countOf = (id: string) => problems.filter((p) => p.node === id).length;
  const nodes: Node[] = laid.nodes.map((n) => ({
    id: n.id,
    type: "step",
    position: n.position ?? { x: 0, y: 0 },
    width: NODE_WIDTH,
    data: {
      // the canvas speaks in TITLES; the id stays what the run DAG, the log and `node@visit` say
      title: n.title?.trim() || n.id,
      kind: n.kind,
      summary: stepSummary(spec, n),
      isEntry: spec.entry === n.id,
      problems: countOf(n.id),
      onOpen: () => open({ kind: "step", id: n.id }),
    } satisfies StepNodeData,
  }));
  const leaving = new Map<string, number>();
  for (const e of laid.edges) leaving.set(e.from, (leaving.get(e.from) ?? 0) + 1);
  const nth = new Map<string, number>();
  const edges: Edge[] = laid.edges.map((e, i) => ({
    id: `e${i}`,
    source: e.from,
    target: e.to,
    type: "condition",
    markerEnd: { type: MarkerType.ArrowClosed },
    data: {
      index: i,
      // the SAME label the compiled graph's Condition carries, so picture and log agree
      label: e.when ? predicateLabel(e.when) : "",
      nth: (() => { const at = nth.get(e.from) ?? 0; nth.set(e.from, at + 1); return at; })(),
      siblings: leaving.get(e.from) ?? 1,
      flagged: problems.some((p) => p.where === "branching" && p.node === e.from),
      onOpen: () => open({ kind: "edge", index: i }),
    } satisfies ConditionEdgeData,
  }));
  return { nodes, edges };
}

export function GraphCanvas({ draft, dispatch, problems, selection, onSelect, onAdd, generation }: {
  draft: Draft;
  dispatch: (a: DraftAction) => void;
  problems: SpecProblem[];
  selection: Selection;
  onSelect: (sel: Selection) => void;
  onAdd: (kind: StepKind, at?: Point) => void;
  /** bumped when the WHOLE draft is replaced (a preset, a graph read back) — see below */
  generation: number;
}) {
  const { screenToFlowPosition, fitView } = useReactFlow();
  // `fitView` as a prop only fits at mount. A preset or a load replaces every step at once, and
  // leaving the viewport where it was shows an arrangement that is mostly off-screen. Adding
  // ONE step deliberately does not refit: moving the view under someone mid-edit is worse than
  // a box just outside it, and the fit control is right there.
  useEffect(() => { void fitView({ maxZoom: 1, padding: 0.25 }); }, [generation, fitView]);
  const { nodes, edges } = useMemo(
    () => specToFlow(draft.spec, problems, onSelect),
    [draft.spec, problems, onSelect],
  );
  // selection is the SHELL's, so it survives a step being renamed or an edge being re-indexed
  const selectedNodes = nodes.map((n) => ({ ...n, selected: selection?.kind === "step" && selection.id === n.id }));
  const selectedEdges = edges.map((e, i) => ({ ...e, selected: selection?.kind === "edge" && selection.index === i }));

  const onConnect = useCallback<OnConnect>(
    (c) => {
      if (!c.source || !c.target) return;
      dispatch({ type: "add-edge", from: c.source, to: c.target });
      // ...and the new route is the last one, so its condition is already open to be typed
      onSelect({ kind: "edge", index: draft.spec.edges.length });
    },
    [dispatch, onSelect, draft.spec.edges.length],
  );

  return (
    <div
      className="gb-canvas"
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
      onDrop={(e) => {
        const kind = e.dataTransfer.getData(STEP_KIND_MIME);
        if (!isStepKind(kind)) return;
        e.preventDefault();
        // point() rather than the raw reading: a viewport that has not been measured yet can
        // answer NaN, and NaN serialises to null — a spec that cannot round-trip is not a spec.
        // With no usable point the reducer places the step below everything instead.
        onAdd(kind, point(screenToFlowPosition({ x: e.clientX, y: e.clientY })));
      }}
    >
      <ReactFlow
        nodes={selectedNodes}
        edges={selectedEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_, n) => onSelect({ kind: "step", id: n.id })}
        onEdgeClick={(_, e) => onSelect({ kind: "edge", index: (e.data as ConditionEdgeData).index })}
        onPaneClick={() => onSelect(null)}
        onConnect={onConnect}
        onNodeDragStop={(_, n) => {
          const at = point(n.position);
          if (at) dispatch({ type: "move-node", id: n.id, position: at });
        }}
        onNodesDelete={(gone) => {
          for (const n of gone) dispatch({ type: "remove-step", id: n.id });
          onSelect(null);
        }}
        onEdgesDelete={(gone) => {
          // by DESCENDING index, so removing one does not renumber the next one still to go
          for (const i of gone.map((e) => (e.data as ConditionEdgeData).index).sort((a, b) => b - a))
            dispatch({ type: "remove-edge", index: i });
          onSelect(null);
        }}
        fitView
        // a two-step graph fitted to a wide pane would otherwise zoom to 2x, which is the
        // default ceiling and reads as a mistake rather than as a fit
        fitViewOptions={{ maxZoom: 1, padding: 0.25 }}
        aria-label={`${draft.spec.name || "untitled"} — ${nodes.length} steps`}
      >
        <Background />
        {/* no minimap: the graphs this builds are five to ten steps, so one would cover a
            corner of the thing it is a map of, and pan/zoom already reaches everything */}
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
