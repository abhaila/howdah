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
 *   A DRAG IS ONE EDIT, AND THIS CANVAS HOLDS THE FRAMES IN BETWEEN. `nodes` is a controlled
 *   prop, and React Flow's `triggerNodeChanges` APPLIES a change only when it owns the nodes
 *   (`hasDefaultNodes`) — given a controlled `nodes` it does nothing but call
 *   `onNodesChange`. So a canvas that passes `nodes` and no handler discards every node
 *   change: the card does not follow the pointer and the arrow-key nudge moves nothing. That
 *   was HOW-24's review finding 1, and the fix is the handler below — `inFlight` keeps the
 *   positions of whatever is under the pointer, and the DRAFT is still changed exactly ONCE
 *   per gesture (drag end, or one arrow press), so the live verdict is not recomputed sixty
 *   times a second while a box is in the air.
 *
 *   AND THERE IS NO DELETE KEY. `deleteKeyCode` defaults to Backspace, bound on `document`,
 *   and exempts only form controls — not the Button that is the documented way into a step —
 *   so one stray keystroke used to destroy a step AND its instructions with no undo (review
 *   finding 2). Removing a step is a named control in the panel that says what it is about to
 *   destroy.
 *
 * HOW-68 (DESIGN.md), all of it presentation:
 *
 *   THE CANVAS OPENS AT 100%, NOT "FITTED". It used to `fitView` whatever arrived, so a
 *   five-step graph in a short pane was drawn at 40% and its 13px labels at 5px (audit
 *   3.1.11). A canvas pans; text that cannot be read does not. So a draft is FRAMED instead:
 *   at zoom 1, centred where it fits and pinned to its top-left corner — where the run starts —
 *   where it does not. Zooming out is the operator's own act (the controls, the wheel), never
 *   the default.
 *
 *   A CARD IS A FOCUS STOP YOU CAN SEE. React Flow makes every node's wrapper focusable and
 *   its own sheet removes the outline (audit 3.6). howdah.css puts the 2px ring back on that
 *   wrapper (`:focus-visible:has(> .gb-node)`), and pressing Enter or Space there SELECTS the
 *   step — React Flow reports that as a `select` change, which used to be dropped with every
 *   other one.
 *
 *   THE CONTROLS ARE OURS. React Flow's own are bare 26px buttons with no ring and no names a
 *   tooltip could show; these are `Button`s, so they get the focus ring, the press and the
 *   tooltip every other control has. Edges are not focus stops at all: the caption `Button`
 *   on each wire is the control, and a second ringless stop on the hairline was noise.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background, ConnectionMode, Panel, ReactFlow, useReactFlow, useStore,
  MarkerType, type Edge, type Node, type NodeChange, type OnConnect, type OnNodesChange,
} from "@xyflow/react";
import { Maximize, Minus, Plus } from "lucide-react";
import { isBlocking, point, predicateLabel, specFlowEdges, type GraphSpec, type Point, type SpecProblem } from "../../../core/graph-spec";
import { autoLayout } from "@/lib/layout";
import type { Draft, DraftAction, PaletteKind } from "@/lib/spec-draft";
import { STEP_KINDS } from "@/lib/spec-draft";
import { KIND_LABEL, StepNode, stepSummary, type StepNodeData } from "./node-card";
import { ConditionEdge, type ConditionEdgeData } from "./edge";
import { edgeSides, type Box, type Side } from "./routing";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Tooltip } from "@/components/ui/tooltip";

/** What the right-hand panel is showing. `null` is the graph itself. */
export type Selection = { kind: "step"; id: string } | { kind: "edge"; index: number } | null;

/** What a dragged palette item carries. A plain string, because that is all a drop needs.
 *  It lives with the RECEIVER: the canvas is what reads a drop, and the palette importing the
 *  protocol from here rather than the other way round is what lets the palette ask this module
 *  where the middle of the view is. */
export const STEP_KIND_MIME = "application/howdah-step-kind";

const nodeTypes = { step: StepNode };
const edgeTypes = { condition: ConditionEdge };

/** The card's width. Wider than the read-only picture's 180px box since HOW-68: the card
 *  prints a name, an id and a summary at 12-13px, and 180 cut all three. The PLACEMENT is
 *  still the shared one (lib/layout.ts), so it is the same shape, drawn roomier. The HEIGHT is
 *  not declared: a titled step has an id line the untitled one does not — React Flow measures
 *  what it renders. */
const NODE_WIDTH = 220;
/** ...and its rough height, for the things that have to guess: centring a card on a point,
 *  and framing a draft before anything has been measured. */
const NODE_HEIGHT = 72;
/** how much air the framed draft keeps from the pane's edge */
const FRAME_PAD = 32;
/** what the operator may zoom to. The DEFAULT is always 1 — see `frameOf`. */
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 1.5;

const isStepKind = (v: string): v is PaletteKind => STEP_KINDS.some((k) => k.kind === v);

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
  // the card's count and the wire's flag are about what BLOCKS (HOW-26). `--attention` is the
  // only saturated colour in this palette and it means "a human is needed"; advice is not that
  // — it is counted in the bar and printed in the panel, and tinting the picture with it would
  // make the builder's own opinion read as a refusal on every box it has one about.
  const blocking = problems.filter(isBlocking);
  const countOf = (id: string) => blocking.filter((p) => p.node === id).length;
  // advice IS counted on the card since HOW-68, as a neutral glyph and a number: that is not a
  // tint and not the alarm, and it is what lets "2 worth a second look" in the bar be found on
  // the picture. The card's `needs-input` class and the wire's flag stay about what BLOCKS.
  const adviceOf = (id: string) => problems.filter((p) => !isBlocking(p) && p.node === id).length;
  const nodes: Node[] = laid.nodes.map((n) => {
    const title = n.title?.trim() || n.id;
    return {
      id: n.id,
      type: "step",
      position: n.position ?? { x: 0, y: 0 },
      width: NODE_WIDTH,
      ariaLabel: `Step ${title} — ${KIND_LABEL[n.kind]}. Enter selects it; the arrow keys then move it.`,
      data: {
        id: n.id,
        // the canvas speaks in TITLES; the id stays what the run DAG, the log and `node@visit` say
        title,
        kind: n.kind,
        summary: stepSummary(spec, n),
        isEntry: spec.entry === n.id,
        problems: countOf(n.id),
        advice: adviceOf(n.id),
        wired: [],
        onOpen: () => open({ kind: "step", id: n.id }),
      } satisfies StepNodeData,
    };
  });
  // HOW-68: each route leaves and enters by the sides that face each other (routing.ts)
  const routes = routeSides(laid.edges, new Map(laid.nodes.map((n) => [n.id, n.position ?? { x: 0, y: 0 }])));
  for (const n of nodes) (n.data as StepNodeData).wired = [...(routes.wired.get(n.id) ?? [])];
  const edges: Edge[] = laid.edges.map((e, i) => ({
    id: `e${i}`,
    source: e.from,
    target: e.to,
    sourceHandle: routes.sides[i]!.source,
    targetHandle: routes.sides[i]!.target,
    type: "condition",
    markerEnd: { type: MarkerType.ArrowClosed },
    data: {
      index: i,
      // the SAME label the compiled graph's Condition carries, so picture and log agree
      label: e.when ? predicateLabel(e.when) : "",
      nth: routes.nth[i]!,
      siblings: routes.siblings[i]!,
      flagged: blocking.some((p) => p.where === "branching" && p.node === e.from),
      onOpen: () => open({ kind: "edge", index: i }),
    } satisfies ConditionEdgeData,
  }));
  // HOW-73: the fork and join wires a parallel step implies. They belong to that step, not to
  // `spec.edges`, so they carry no index, no caption and cannot be selected or removed — the
  // picture draws them (dashed) and the source is where they are edited, for now.
  const implied: Edge[] = specFlowEdges(laid).filter((e) => e.kind).map((e, i) => ({
    id: `${e.kind}${i}`,
    source: e.from,
    target: e.to,
    markerEnd: { type: MarkerType.ArrowClosed },
    deletable: false,
    selectable: false,
    focusable: false,
    style: { strokeDasharray: "4 3" },
  }));
  return { nodes, edges: [...edges, ...implied] };
}

/**
 * The sides every route uses, in `spec.edges` order, for a set of card positions. One function
 * for the draft's own positions (`specToFlow`) and for the frames of a drag (`GraphCanvas`), so
 * a wire re-attaches as the card it belongs to is carried past its neighbour. `nth`/`siblings`
 * count the routes leaving the SAME SIDE of the same step — the ones whose captions share a gap.
 */
export function routeSides(
  edges: ReadonlyArray<{ from: string; to: string }>,
  positions: ReadonlyMap<string, Point>,
): { sides: Array<{ source: Side; target: Side }>; nth: number[]; siblings: number[]; wired: Map<string, Set<Side>> } {
  const box = (id: string): Box => ({ ...(positions.get(id) ?? { x: 0, y: 0 }), width: NODE_WIDTH, height: NODE_HEIGHT });
  const sides = edges.map((e) =>
    edgeSides(box(e.from), box(e.to), { self: e.from === e.to, reverse: edges.some((o) => o.from === e.to && o.to === e.from) }));
  const group = (i: number) => `${edges[i]!.from}\u0000${sides[i]!.source}`;
  const count = new Map<string, number>();
  const nth = edges.map((_, i) => { const at = count.get(group(i)) ?? 0; count.set(group(i), at + 1); return at; });
  const siblings = edges.map((_, i) => count.get(group(i)) ?? 1);
  const wired = new Map<string, Set<Side>>();
  const mark = (id: string, side: Side) => { let set = wired.get(id); if (!set) wired.set(id, (set = new Set())); set.add(side); };
  edges.forEach((e, i) => { mark(e.from, sides[i]!.source); mark(e.to, sides[i]!.target); });
  return { sides, nth, siblings, wired };
}

/**
 * Where the view starts for a draft that has just arrived: ALWAYS at zoom 1 (HOW-68).
 *
 * `fitView` answered "show all of it", and for anything taller than the pane that meant
 * shrinking the type until it was not type (audit 3.1.11). The question worth answering is
 * "show the start of it, readable": centred on an axis where the draft fits, and pinned to its
 * top-left — the entry step, in every layout `autoLayout` produces — on an axis where it does
 * not. The rest is a pan away, which is what a canvas is for.
 *
 * Pure, and it reasons from the SPEC's positions with the card's nominal size rather than from
 * measured nodes: the positions are the artifact, and waiting for React Flow to measure would
 * frame one tick late.
 */
export function frameOf(spec: GraphSpec, pane: { width: number; height: number }): { x: number; y: number; zoom: number } {
  const placed = autoLayout(spec).nodes.map((n) => n.position).filter((p): p is Point => !!p);
  if (!placed.length || !pane.width || !pane.height) return { x: FRAME_PAD, y: FRAME_PAD, zoom: 1 };
  const left = Math.min(...placed.map((p) => p.x));
  const top = Math.min(...placed.map((p) => p.y));
  const width = Math.max(...placed.map((p) => p.x)) + NODE_WIDTH - left;
  const height = Math.max(...placed.map((p) => p.y)) + NODE_HEIGHT - top;
  const along = (start: number, size: number, room: number) =>
    Math.round(size + FRAME_PAD * 2 <= room ? (room - size) / 2 - start : FRAME_PAD - start);
  return { x: along(left, width, pane.width), y: along(top, height, pane.height), zoom: 1 };
}

/**
 * The middle of what is on screen, in flow space — where a step lands when the palette is
 * CLICKED rather than dragged (review finding 3; the palette has always said "in the middle").
 *
 * `undefined` where there is nothing to measure: an unmeasured pane answers a 0x0 rect, and a
 * confident wrong answer is worse than the reducer's own "below everything" fallback. It goes
 * through the SAME `screenToFlowPosition` the drop path uses, so a click and a drop cannot
 * disagree about where the middle is.
 */
export function useCanvasCentre(): () => Point | undefined {
  const { screenToFlowPosition } = useReactFlow();
  const domNode = useStore((s) => s.domNode);
  return useCallback(() => {
    if (!domNode) return undefined;
    const r = domNode.getBoundingClientRect();
    if (!r.width || !r.height) return undefined;
    const at = screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    // the CARD is centred, not its top-left corner
    return point({ x: at.x - NODE_WIDTH / 2, y: at.y - NODE_HEIGHT / 2 });
  }, [domNode, screenToFlowPosition]);
}

/**
 * One batch of React Flow node changes, split into "still under the pointer" and "settled".
 *
 * Returns the in-flight positions this batch carries, or `null` when it carries none — so a
 * batch of `dimensions` or `select` changes (both ignored, exactly as they were when every
 * change was being discarded) leaves the overlay alone rather than clearing it.
 *
 * A settled change — drag END, and every arrow-key nudge, which React Flow reports with
 * `dragging` unset — is the one that reaches the draft. That is what keeps one gesture to one
 * edit and therefore to one `draftProblems()` run.
 */
export function applyNodeChangesToDraft(
  changes: NodeChange[],
  dispatch: (a: DraftAction) => void,
): Map<string, Point> | null {
  let flying: Map<string, Point> | null = null;
  for (const c of changes) {
    if (c.type !== "position" || !c.position) continue;
    // point() rather than the raw reading, for the reason the drop path gives: NaN serialises
    // to null, and a spec that cannot round-trip through JSON is not a spec
    const at = point(c.position);
    if (!at) continue;
    if (c.dragging) (flying ??= new Map()).set(c.id, at);
    else dispatch({ type: "move-node", id: c.id, position: at });
  }
  return flying;
}

export function GraphCanvas({ draft, dispatch, problems, selection, onSelect, onAdd, generation }: {
  draft: Draft;
  dispatch: (a: DraftAction) => void;
  problems: SpecProblem[];
  selection: Selection;
  onSelect: (sel: Selection) => void;
  onAdd: (kind: PaletteKind, at?: Point) => void;
  /** bumped when the WHOLE draft is replaced (a preset, a graph read back) — see below */
  generation: number;
}) {
  const { screenToFlowPosition, fitView, setViewport, zoomIn, zoomOut } = useReactFlow();
  const paneWidth = useStore((s) => s.width);
  const paneHeight = useStore((s) => s.height);
  const zoom = useStore((s) => s.transform[2]);
  const measured = paneWidth > 0 && paneHeight > 0;
  // A preset or a load replaces every step at once, and leaving the viewport where it was shows
  // an arrangement that is mostly off-screen — so each `generation` is framed once, as soon as
  // the pane has a size. Adding ONE step deliberately does not reframe, and neither does the
  // pane changing width when the panel opens: moving the view under someone mid-edit is worse
  // than a box just outside it, and a clicked step is already placed inside the view.
  const spec = useRef(draft.spec);
  spec.current = draft.spec;
  const frame = useCallback(
    () => { void setViewport(frameOf(spec.current, { width: paneWidth, height: paneHeight })); },
    [setViewport, paneWidth, paneHeight],
  );
  const framed = useRef(-1);
  useEffect(() => {
    if (!measured || framed.current === generation) return;
    framed.current = generation;
    frame();
  }, [generation, measured, frame]);
  const { nodes, edges } = useMemo(
    () => specToFlow(draft.spec, problems, onSelect),
    [draft.spec, problems, onSelect],
  );

  // The frames of a drag, and nothing else. Keyed on `draft.spec` for the clear rather than
  // cleared inline: the overlay only drops once the draft already holds the same position, so
  // there is no frame in which the card is drawn back where it started.
  const [inFlight, setInFlight] = useState<Map<string, Point> | null>(null);
  useEffect(() => { setInFlight(null); }, [draft.spec]);
  const onNodesChange = useCallback<OnNodesChange>(
    (changes) => {
      const flying = applyNodeChangesToDraft(changes, dispatch);
      if (flying) setInFlight(flying);
      // Enter or Space on a focused card is React Flow's own "select this node", and it says so
      // with a `select` change rather than a click. Selection is the SHELL's, so it is handed
      // over — a deselect is not: the shell decides what Escape and an empty-canvas click mean.
      for (const c of changes) if (c.type === "select" && c.selected) onSelect({ kind: "step", id: c.id });
    },
    [dispatch, onSelect],
  );

  // selection is the SHELL's, so it survives a step being renamed or an edge being re-indexed
  const shown = nodes.map((n) => ({
    ...n,
    selected: selection?.kind === "step" && selection.id === n.id,
    position: inFlight?.get(n.id) ?? n.position,
  }));
  // mid-drag the wires follow the card being carried: the sides are worked out again from the
  // positions on screen, for the routes only (the implied fork/join wires have no handles)
  const live = useMemo(() => {
    if (!inFlight) return null;
    const at = new Map(nodes.map((n) => [n.id, inFlight.get(n.id) ?? n.position]));
    return routeSides(draft.spec.edges, at);
  }, [inFlight, nodes, draft.spec.edges]);
  const selectedEdges = edges.map((e, i) => {
    const sides = live?.sides[i];
    return {
      ...e,
      ...(sides && e.type === "condition" ? { sourceHandle: sides.source, targetHandle: sides.target } : {}),
      selected: selection?.kind === "edge" && selection.index === i,
    };
  });

  const onConnect = useCallback<OnConnect>(
    (c) => {
      if (!c.source || !c.target) return;
      dispatch({ type: "add-edge", from: c.source, to: c.target });
      // ...and the new route is the last one, so its condition is already open to be typed
      onSelect({ kind: "edge", index: draft.spec.edges.length });
    },
    [dispatch, onSelect, draft.spec.edges.length],
  );

  // while a wire is being drawn every card shows where it can land (howdah.css `.gb-handle`)
  const [connecting, setConnecting] = useState(false);

  return (
    <div
      className="gb-canvas"
      data-connecting={connecting || undefined}
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
        nodes={shown}
        edges={selectedEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_, n) => onSelect({ kind: "step", id: n.id })}
        onEdgeClick={(_, e) => onSelect({ kind: "edge", index: (e.data as ConditionEdgeData).index })}
        onPaneClick={() => onSelect(null)}
        onConnect={onConnect}
        // every dot on a card is a `source` handle (node-card.tsx), so a wire may start at any
        // side and end on any side of another card; `onConnect` still reads source → target as
        // "the card the drag started on → the card it was dropped on"
        connectionMode={ConnectionMode.Loose}
        onConnectStart={() => setConnecting(true)}
        onConnectEnd={() => setConnecting(false)}
        onNodesChange={onNodesChange}
        // the panel follows what you just took hold of, which is what a click already does —
        // and `moveSelectedNodes` only moves a SELECTED node, so without this "drag a card,
        // then nudge it with the arrows" would silently do nothing
        onNodeDragStart={(_, n) => onSelect({ kind: "step", id: n.id })}
        // NO delete key. The default is Backspace, bound on `document` by React Flow's own
        // `useGlobalKeyHandler`, and `isInputDOMNode` exempts INPUT/SELECT/TEXTAREA and
        // `contenteditable` — NOT the `Button` that is the documented keyboard way into a
        // step. So Tab to a card, Enter, Backspace destroyed the step and its instructions,
        // with no undo. Removal is a named control in the panel that says what goes. Turning
        // this back on is not a one-line change: `onEdgesDelete` would have to remove edges by
        // DESCENDING index, because an edge is addressed by its index in `spec.edges` and
        // removing one renumbers the rest.
        deleteKeyCode={null}
        // zoom 1 until `frame()` has a pane to measure: never a fitted, shrunken first paint
        defaultViewport={{ x: FRAME_PAD, y: FRAME_PAD, zoom: 1 }}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        // the caption Button on each wire is the control; the hairline is not a second stop
        edgesFocusable={false}
        // what a screen reader is told about a card. React Flow's default promises "press
        // delete to remove it", which this canvas deliberately does not do.
        ariaLabelConfig={{
          // React Flow's two keys are named the wrong way round: `keyboardDisabled` is the one
          // it reads while the keyboard IS enabled, which it always is here
          "node.a11yDescription.keyboardDisabled": "Press Enter or Space to select this step, then the arrow keys to move it. Its Edit button opens it in the panel.",
          "node.a11yDescription.default": "Press Enter or Space to select this step. Its Edit button opens it in the panel.",
          "edge.a11yDescription.default": "Each route has a button on its wire that opens it in the panel.",
        }}
        // its 10px "React Flow" link is under the type floor and one more focus stop on every
        // pass through the canvas; the library is credited in CLAUDE.md and package.json
        proOptions={{ hideAttribution: true }}
        aria-label={`${draft.spec.name || "untitled"} — ${nodes.length} steps`}
      >
        <Background />
        {nodes.length === 0 && (
          <Panel position="top-center" className="gb-canvas-empty">
            <EmptyState title="No steps yet">
              Drag a kind of step from the palette onto the canvas, or press one to drop it in
              the middle. A run needs a step to start at and a Finish step to end on.
            </EmptyState>
          </Panel>
        )}
        {/* no minimap: the graphs this builds are five to ten steps, so one would cover a
            corner of the thing it is a map of, and pan/zoom already reaches everything */}
        <Panel position="bottom-left" className="nodrag nopan flex items-center gap-1 rounded-[var(--radius)] border border-border bg-card p-1">
          <Tooltip content="Zoom out" side="top">
            <Button variant="ghost" size="icon-sm" aria-label="Zoom out" disabled={zoom <= MIN_ZOOM} onClick={() => void zoomOut()}><Minus /></Button>
          </Tooltip>
          <Tooltip content="Back to 100%, at the start of the graph" side="top">
            <Button variant="ghost" size="sm" className="h-6 min-w-12 px-1.5 text-xs tabular-nums" aria-label={`Zoom ${Math.round(zoom * 100)}% — back to 100%`} onClick={frame}>
              {Math.round(zoom * 100)}%
            </Button>
          </Tooltip>
          <Tooltip content="Zoom in" side="top">
            <Button variant="ghost" size="icon-sm" aria-label="Zoom in" disabled={zoom >= MAX_ZOOM} onClick={() => void zoomIn()}><Plus /></Button>
          </Tooltip>
          <Tooltip content="Show the whole graph" side="top">
            <Button variant="ghost" size="icon-sm" aria-label="Show the whole graph" onClick={() => void fitView({ maxZoom: 1, minZoom: MIN_ZOOM, padding: 0.1 })}><Maximize /></Button>
          </Tooltip>
        </Panel>
      </ReactFlow>
    </div>
  );
}
