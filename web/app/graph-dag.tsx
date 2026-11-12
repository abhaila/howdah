/**
 * GraphDag — the read-only picture of a graph: the run's Graph tab, the Graphs screen's tuner
 * and the draft review page (T20; redrawn on React Flow in HOW-68).
 *
 * WHY IT MOVED. It was a hand-drawn SVG over a layered-BFS placement, and the operator's first
 * hands-on verdict was three sentences: "the graphs are not so neat, not possible to see the
 * full text of the node on hover, and cannot use mouse to move the canvas". Each was structural.
 * The placement never looked at an edge once the layers were made; the box cut an id at 18
 * characters and its only "tooltip" was an SVG `<title>`; and the canvas was a scroller, so a
 * drag panned only what overflowed and a wheel did nothing unless ⌘ was held. So:
 *
 *   IT IS A REACT FLOW CANVAS, the one the builder already is (`builder/canvas.tsx`), wearing
 *   the same theme (`.gb-canvas`) and the same card (`.gb-node`: kind glyph, name, one line of
 *   what it does, the "Start" tab, the dashed Finish pill). A graph is drawn ONE way whether you
 *   are building it or watching it run. What React Flow gives here is the viewport — drag to
 *   pan, wheel and pinch to zoom, the minimap — and nothing else: a step cannot be dragged,
 *   wired, selected into React Flow's own store or deleted, because this picture edits nothing.
 *
 *   THE PLACEMENT IS A REAL LAYERED LAYOUT (`lib/dag-layout.ts`, dagre): crossings minimised,
 *   every wire routed through the gaps, a loop back curving round the cards between, and each
 *   condition given a box of its own between two ranks. The WIRES are drawn here, in one SVG
 *   inside the viewport, from the points that layout made — not as React Flow edges, which
 *   would be re-routed from handle to handle by a second opinion that knows nothing of the lanes
 *   the layout kept clear.
 *
 *   A NAME IS NEVER CUT IN THE MIDDLE. A card is wide enough for 24 characters and wraps a
 *   longer id onto a second line at a `.` or `_`; the group every step of a graph shares
 *   (`quick-task.`) is still omitted, and a group that tells steps apart is dimmed, not dropped.
 *   EVERYTHING ELSE IS A HOVER OR A FOCUS AWAY: every card is a `Tooltip` trigger carrying the
 *   full id, its kind, what it runs on, and — in a run — how often it ran, for how long, and
 *   how that went. A condition too long for its caption is a `Truncate`, which is the same rule.
 *
 * WHAT DID NOT CHANGE, because each was learned the hard way:
 *
 *   IT IS REACHABLE WITHOUT A MOUSE (HOW-16 P2.10). The steps are ONE tab stop with a roving
 *   tabindex; the arrow keys walk them in LAYOUT order (down the ranks, then across), Home and
 *   End jump, and a step that is walked to is panned into view. Every step is in the walk now,
 *   not only the selectable ones: a step you cannot act on still has a tooltip to read, and
 *   focus is how a keyboard reads one. Enter or Space on a selectable step selects it — it is a
 *   real `Button`. The canvas itself is a focus stop too: there the arrows pan, `+` and `−`
 *   zoom, `0` shows the whole graph. Those keys are listed in `?` (passive rows in
 *   `lib/shortcuts.ts`).
 *
 *   THE PICTURE NEVER ASSERTS (HOW-22). It draws a DRAFT too, and a draft is being typed: an
 *   edge naming a step that does not exist is skipped by the layout and by the loop below, never
 *   dereferenced — `web/app` has no error boundary, and one `!` once took the builder and the
 *   unsaved draft down with it.
 *
 *   A DRAFT AGAINST ITS BASE (HOW-65): a step the draft removes is still drawn — dashed, struck
 *   through, the word "removed" — and `highlight` rings the step whose row has focus in the
 *   list beside the picture. (That ring was amber. Amber means a run is waiting on you and
 *   nothing else, so it is the accent now.)
 *
 *   AMBER IS SAID ONCE: the step a run is parked on, waiting on you, carries the triangle and
 *   the amber outline. The step it is merely ON carries the running half-disc in the accent.
 *
 *   NOTHING ANIMATES. The picture is there or it is not (DESIGN.md Motion).
 *
 * IT OPENS AT 100%, like the builder: centred where it fits, and otherwise placed so the step
 * the run is on (or the entry) is in view. A 25-step graph fitted to a pane is 5px type; "Show
 * the whole graph" is one press away, and the minimap is there for a graph over a dozen steps.
 *
 * `wheel` says who owns a bare mouse wheel. In the run's Graph tab the canvas IS the pane, so
 * the wheel zooms. On the Graphs screen and the draft review the picture is one object on a
 * page that scrolls, and a wheel that zoomed whenever the pointer crossed it would trap the
 * page — there the wheel scrolls the page and ⌘/Ctrl + wheel (or a pinch) zooms.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { MiniMap, Panel, ReactFlow, ReactFlowProvider, ViewportPortal, useReactFlow, useStore, useStoreApi, type Node, type NodeProps } from "@xyflow/react";
import { Maximize, Minus, Play, Plus, SlidersHorizontal, Circle } from "lucide-react";
import { StatusGlyph } from "./status";
import { KIND_ICON, KIND_LABEL } from "./builder/node-card";
import { dagLayout, wirePath, type Box, type DagLayout } from "@/lib/dag-layout";
import { useShortcuts } from "@/lib/shortcuts";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip } from "@/components/ui/tooltip";
import { Truncate } from "@/components/ui/truncate";

export interface AgentConfigDto {
  harness?: string;
  model?: string;
  effort?: string;
  /** HOW-33: resolved configs only — why the set effort does not reach this harness */
  effortInert?: string;
  permissionMode?: string;
  maxTurns?: number;
  skills?: string[];
  /** HOW-41: the node's action space */
  tools?: { allow?: string[]; deny?: string[] };
  /** HOW-39: run the workspace's diagnosticsCommand after every edit (claude only) */
  diagnostics?: boolean;
}

export interface GraphShapeDto {
  name: string;
  description: string;
  entry: string;
  inputs?: string[];
  defaults?: AgentConfigDto;
  /** HOW-17: what an unset harness resolves to for this operator (config.json defaultHarness) */
  default_harness?: string;
  tuning?: { defaults?: AgentConfigDto; nodes?: Record<string, AgentConfigDto> };
  nodes: Array<{
    id: string;
    /**
     * HOW-22: what to CALL this node in the picture. The graph builder sets it, because a
     * step there carries an editable title while its id — which is run identity,
     * `${node}#${visit}` — is frozen at creation. Everywhere else it is absent and the id is
     * the name, unchanged.
     */
    title?: string;
    kind: string; class?: string; prompt?: string; run?: string;
    model?: string; harness?: string; effort?: string; maxVisits?: number; outcome?: string; duration?: string;
    baseline?: AgentConfigDto; node_tuning?: AgentConfigDto; effective?: AgentConfigDto;
    /** HOW-73: a parallel step's branches, join and how many run at once */
    branches?: string[]; join?: string; concurrency?: number;
  }>;
  /** `kind` (HOW-73): an edge a parallel step implies — fork (to a branch) or join (from one) */
  edges: Array<{ from: string; to: string; label?: string; weight?: number; kind?: "fork" | "join" }>;
}

type ShapeNode = GraphShapeDto["nodes"][number];

/** What a run knows about one step, for its tooltip. All of it is derived from the timeline. */
export interface StepRunInfo {
  /** time spent in visits that have finished, already formatted ("4m 38s") */
  took?: string;
  /** how its latest visit stands: "done", "failed", "running", "waiting on you" */
  state?: string;
}

// ---- the card's geometry: decided BEFORE layout, because the layout needs every box --------

/** the card. Wider than the builder's 220: a read-only card has no drag handle to leave room for */
export const CARD_WIDTH = 248;
/** characters of DM Mono 13px a name line holds (0.6em advance, beside the kind glyph and the status glyph) */
const NAME_CHARS = 24;
/** a title is sans, whose advance varies — fewer, so the widest of them still fits */
const TITLE_CHARS = 26;
const SUB_CHARS = 30;
const LINE = 18;
const SUB_LINE = 16;
const PAD = 16;
/** a caption: 12px mono in a 22px box, cut (with the full text one hover away) past this width */
const CAPTION_MAX = 232;
const CAPTION_HEIGHT = 22;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
/** how much air the opening view keeps from the pane's edge */
const FRAME_PAD = 28;
/** a graph over this many steps gets a minimap (and a pane wide enough not to be covered by one) */
const MINIMAP_FROM = 12;
const MINIMAP_MIN_PANE = 640;

/** the one group every dotted id shares, when every node has a dotted id in it — else null */
export function sharedGroupOf(ids: readonly string[]): string | null {
  if (ids.length < 2) return null;
  const groups = new Set(ids.map((id) => { const dot = id.lastIndexOf("."); return dot > 0 ? id.slice(0, dot) : null; }));
  if (groups.size !== 1) return null;
  const [only] = [...groups];
  return only ?? null;
}

/**
 * A name as the card prints it: whole, on as many lines as it needs (three at most), broken
 * where a reader would break it. Pure — the card's HEIGHT is `lines.length`, and the layout has
 * to know that before anything is drawn.
 *
 * An id breaks after a `.`, `_` or `-`; a title breaks at a space. Only a single run longer
 * than a line is split mid-word, and only a name longer than three lines loses its tail — to
 * the tooltip, which always has all of it.
 */
export function wrapName(name: string, perLine: number, maxLines = 3): string[] {
  const lines: string[] = [];
  let rest = name;
  while (rest.length > perLine && lines.length < maxLines - 1) {
    const head = rest.slice(0, perLine);
    // the strongest joint that fits: a space, else the group's dot, else a word joint inside the step
    const at = [head.lastIndexOf(" "), head.lastIndexOf("."), Math.max(head.lastIndexOf("_"), head.lastIndexOf("-"))].find((i) => i > 0) ?? -1;
    const cut = at > 0 ? at + 1 : perLine;
    lines.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  lines.push(rest.length > perLine ? `${rest.slice(0, perLine - 1)}…` : rest);
  return lines;
}

/**
 * What a card calls its step (D23): the part that TELLS STEPS APART, in full. When every step
 * of the graph is in one group (`quick-task.work`, `quick-task.review`) the group says nothing
 * and is omitted; otherwise it is printed, dimmed. A builder's title is printed as it is.
 */
export function nameOf(node: Pick<ShapeNode, "id" | "title">, sharedGroup: string | null): { lines: string[]; dim: number; mono: boolean } {
  const title = node.title?.trim();
  if (title && title !== node.id) return { lines: wrapName(title, TITLE_CHARS), dim: 0, mono: false };
  const dot = node.id.lastIndexOf(".");
  const group = dot > 0 && dot < node.id.length - 1 ? node.id.slice(0, dot) : null;
  if (group !== null && group === sharedGroup) return { lines: wrapName(node.id.slice(dot + 1), NAME_CHARS), dim: 0, mono: true };
  // `dim` counts the leading characters that are the group and its dot
  return { lines: wrapName(node.id, NAME_CHARS), dim: group === null ? 0 : group.length + 1, mono: true };
}

/** what the node's second line says — one reading, used by the card, its tooltip AND its spoken label */
function subtitle(n: ShapeNode): string {
  if (n.kind === "agent") return `${n.harness ?? "claude"}${n.model ? ` · ${n.model}` : ""}${n.effort ? ` · ${n.effort}` : ""}`;
  if (n.kind === "command") return (n.run ?? "").split("\n")[0] ?? "";
  if (n.kind === "wait") return n.duration ?? "";
  if (n.kind === "terminal") return n.outcome ?? "";
  if (n.kind === "parallel") {
    const count = n.branches?.length ?? 0;
    return `parallel · ${Math.min(n.concurrency ?? count, count)} at once`;
  }
  return n.kind;
}

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const kindLabel = (kind: string) => (KIND_LABEL as Record<string, string | undefined>)[kind] ?? kind;
const edgeKey = (from: string, to: string) => `${from}\u0000${to}`;

/** how wide a caption is drawn: 12px DM Mono is 7.2px a character, plus its padding */
const captionWidth = (label: string, mono: boolean) => Math.min(CAPTION_MAX, Math.ceil(label.length * (mono ? 7.2 : 6.4)) + 14);

export interface DagCard {
  node: ShapeNode;
  box: Box;
  name: { lines: string[]; dim: number; mono: boolean };
  sub: string;
}
export interface DagWire {
  /** the index in `shape.edges` */
  index: number;
  from: string;
  to: string;
  path: string;
  kind?: "fork" | "join";
  back: boolean;
  /** the condition as the log prints it, or "otherwise" for the fallback beside conditions */
  caption?: { text: string; x: number; y: number; width: number; otherwise: boolean };
}

/**
 * The shape as cards and wires. PURE, and the only place the graph meets the layout — so "an
 * edge to a step that is not there is skipped" is a property a test can read off the result,
 * with no canvas and no DOM.
 */
export function dagFlow(shape: GraphShapeDto, opts: { removed?: ReadonlySet<string> } = {}): { cards: DagCard[]; wires: DagWire[]; layout: DagLayout } {
  const sharedGroup = sharedGroupOf(shape.nodes.map((n) => n.id));
  const drawn = shape.nodes.map((node) => {
    const name = nameOf(node, sharedGroup);
    const gone = opts.removed?.has(node.id) ?? false;
    const sub = gone ? `removed · ${subtitle(node)}`.replace(/ · $/, "") : subtitle(node);
    return { node, name, sub, height: PAD + name.lines.length * LINE + (sub ? SUB_LINE : 0) };
  });
  // a fallback route is named only where it stands beside a condition; alone it is just "next"
  const conditional = new Set(shape.edges.filter((e) => e.label).map((e) => e.from));
  const captions = shape.edges.map((e) => (e.kind ? null : e.label ? { text: e.label, otherwise: false } : conditional.has(e.from) ? { text: "otherwise", otherwise: true } : null));
  const layout = dagLayout(
    shape.entry,
    drawn.map((d) => ({ id: d.node.id, width: CARD_WIDTH, height: d.height })),
    shape.edges.map((e, i) => {
      const c = captions[i];
      return { from: e.from, to: e.to, ...(c ? { label: { width: captionWidth(c.text, !c.otherwise), height: CAPTION_HEIGHT } } : {}) };
    }),
  );
  const cards = drawn.flatMap((d) => {
    const box = layout.nodes.get(d.node.id);
    // the layout places every node it is given, so this holds — read, not asserted (see header)
    return box ? [{ node: d.node, box, name: d.name, sub: d.sub }] : [];
  });
  const wires = shape.edges.flatMap((e, i) => {
    const laid = layout.edges[i];
    if (!laid) return [];
    const c = captions[i];
    return [{
      index: i, from: e.from, to: e.to, path: wirePath(laid), back: laid.back,
      ...(e.kind ? { kind: e.kind } : {}),
      ...(c && laid.label ? { caption: { ...c, x: laid.label.x, y: laid.label.y, width: captionWidth(c.text, !c.otherwise) } } : {}),
    }];
  });
  return { cards, wires, layout };
}

/** Where the view opens: at 100%, centred on an axis the graph fits, else with `focus` in view. Pure. */
export function openingView(layout: Pick<DagLayout, "width" | "height">, pane: { width: number; height: number }, focus: Box | undefined): { x: number; y: number; zoom: number } {
  const along = (size: number, room: number, at: number, extent: number) => {
    if (size <= room) return Math.round((room - size) / 2);
    // the focus box centred, but never past either end of the graph
    const want = room / 2 - (at + extent / 2);
    return Math.round(Math.min(FRAME_PAD, Math.max(room - size - FRAME_PAD, want)));
  };
  if (!pane.width || !pane.height) return { x: FRAME_PAD, y: FRAME_PAD, zoom: 1 };
  return {
    x: along(layout.width, pane.width, focus?.x ?? 0, focus?.width ?? pane.width),
    y: along(layout.height, pane.height, focus?.y ?? 0, focus?.height ?? pane.height),
    zoom: 1,
  };
}

/** the least pan that brings `box` wholly into view at the zoom in use, or null when it already is. Pure. */
export function revealBox(view: { x: number; y: number; zoom: number }, pane: { width: number; height: number }, box: Box): { x: number; y: number; zoom: number } | null {
  if (!pane.width || !pane.height || !view.zoom) return null;
  const along = (t: number, pos: number, size: number, room: number) => {
    const start = pos * view.zoom + t;
    const end = start + size * view.zoom;
    if (start < FRAME_PAD || size * view.zoom + FRAME_PAD * 2 > room) return FRAME_PAD - pos * view.zoom;
    if (end > room - FRAME_PAD) return t - (end - (room - FRAME_PAD));
    return t;
  };
  const x = Math.round(along(view.x, box.x, box.width, pane.width));
  const y = Math.round(along(view.y, box.y, box.height, pane.height));
  return x === Math.round(view.x) && y === Math.round(view.y) ? null : { x, y, zoom: view.zoom };
}

// ---- the card ---------------------------------------------------------------------------------

interface CardData extends Record<string, unknown> {
  card: DagCard;
  label: string;
  isEntry: boolean;
  isCurrent: boolean;
  waiting: boolean;
  selected: boolean;
  selectable: boolean;
  gone: boolean;
  lit: boolean;
  visits: number;
  info?: StepRunInfo;
  /** the picture is of a RUN, so a step with no visits is one the run has not reached */
  inRun: boolean;
  /** the roving tab stop */
  tabStop: boolean;
  onSelect: () => void;
  onFocus: () => void;
  onWalk: (e: React.KeyboardEvent) => void;
}

/** everything the card cannot print, and what it cut: read on hover and on focus */
function CardTip({ data }: { data: CardData }) {
  const { card, visits, info, inRun, isCurrent, waiting, gone } = data;
  const n = card.node;
  const titled = n.title?.trim() && n.title.trim() !== n.id ? n.title.trim() : null;
  const what = subtitle(n);
  const ran = visits > 0 ? `${visits} visit${visits === 1 ? "" : "s"}` : inRun ? "not reached" : null;
  const state = isCurrent && waiting ? "waiting on you" : info?.state;
  return (
    <span className="flex flex-col gap-0.5">
      {titled && <span className="font-medium">{titled}</span>}
      <span className="font-mono text-code">{n.id}</span>
      <span className="text-muted-foreground">{kindLabel(n.kind)}{what && what !== n.kind ? ` · ${what}` : ""}</span>
      {(ran || state) && <span className="tabular-nums">{[ran, info?.took, state].filter(Boolean).join(" · ")}</span>}
      {n.maxVisits !== undefined && <span className="text-muted-foreground tabular-nums">at most {n.maxVisits} visits</span>}
      {n.node_tuning && <span className="text-muted-foreground">has its own settings</span>}
      {gone && <span className="text-muted-foreground">removed by this draft</span>}
    </span>
  );
}

function DagStep({ data }: NodeProps & { data: CardData }) {
  const { card, label, isEntry, isCurrent, waiting, selected, selectable, gone, lit, visits, tabStop } = data;
  const n = card.node;
  const Icon = (KIND_ICON as Record<string, typeof Circle | undefined>)[n.kind] ?? Circle;
  let seen = 0;
  const body = (
    <>
      {isEntry && <span className="gb-node-entry"><Play aria-hidden className="size-3 fill-current" />Start</span>}
      {visits > 0 && <span className="dag-visits" aria-hidden>×{visits}</span>}
      <span className="flex min-w-0 items-start gap-1.5">
        <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className={`dag-name min-w-0 flex-1 ${card.name.mono ? "font-mono text-code" : "text-base"}`} aria-hidden>
          {card.name.lines.map((line, i) => {
            // the group (`implementation.`) is dimmed wherever it falls, even across a line break
            const dim = Math.max(0, Math.min(line.length, card.name.dim - seen));
            seen += line.length;
            return <span key={i} className="block whitespace-nowrap">{dim > 0 && <span className="dag-name-group">{line.slice(0, dim)}</span>}{line.slice(dim)}</span>;
          })}
        </span>
        {n.node_tuning && <SlidersHorizontal aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
        {isCurrent && <StatusGlyph status={waiting ? "needs-input" : "running"} size={14} className="mt-0.5" />}
      </span>
      {card.sub && <span className="dag-sub block whitespace-nowrap pl-5 text-xs text-muted-foreground" aria-hidden>{cut(card.sub, SUB_CHARS)}</span>}
    </>
  );
  const shared = {
    "aria-label": label,
    "data-dag-step": n.id,
    tabIndex: tabStop ? 0 : -1,
    onFocus: data.onFocus,
    onKeyDown: data.onWalk,
  };
  return (
    <Tooltip content={<CardTip data={data} />} side="right" align="start" className="flex h-full w-full items-stretch">
      {selectable
        ? <Button variant="outline" aria-pressed={selected} onClick={data.onSelect} className={`gb-node dag-card clickable kind-${n.kind} ${selected || lit ? "selected" : ""} ${isCurrent ? "current" : ""} ${isCurrent && waiting ? "waiting" : ""} ${gone ? "removed" : ""}`} {...shared}>{body}</Button>
        // not a control: there is nothing to do to this step here. It is still a focus stop,
        // because focus is how a keyboard reads the tooltip that holds the rest of it
        : <div role="group" className={`gb-node dag-card kind-${n.kind} ${selected || lit ? "selected" : ""} ${isCurrent ? "current" : ""} ${isCurrent && waiting ? "waiting" : ""} ${gone ? "removed" : ""}`} {...shared}>{body}</div>}
    </Tooltip>
  );
}

const nodeTypes = { dagstep: DagStep };

// ---- the canvas -------------------------------------------------------------------------------

export interface GraphDagProps {
  shape: GraphShapeDto;
  current?: string;
  visits?: Record<string, number>;
  onSelect?: (id: string) => void;
  selected?: string;
  canSelect?: (node: ShapeNode) => boolean;
  /** HOW-65: steps a draft removes — drawn dashed and struck through, labelled "removed" */
  removed?: ReadonlySet<string>;
  /** HOW-65: the step whose row has focus in the list beside the picture */
  highlight?: string | null;
  /** the run is parked on `current`, waiting on the operator — the one amber mark in the picture */
  waiting?: boolean;
  /** a run's own facts per step, for the tooltip */
  info?: Record<string, StepRunInfo>;
  /** the routes a run has taken, as `from\u0000to` — drawn stronger; the rest stay faint */
  taken?: ReadonlySet<string>;
  /** who owns a bare wheel: the canvas ("zoom") or the page around it ("page") — see the header */
  wheel?: "zoom" | "page";
}

export const takenKey = edgeKey;

export function GraphDag(props: GraphDagProps) {
  return (
    <ReactFlowProvider>
      <DagCanvas {...props} />
    </ReactFlowProvider>
  );
}

/** the default: only an agent step has settings to select it for (the Graphs screen's tuner) */
const AGENTS_ONLY = (node: ShapeNode) => node.kind === "agent";

function DagCanvas({ shape, current, visits, onSelect, selected, canSelect = AGENTS_ONLY, removed, highlight, waiting = false, info, taken, wheel = "zoom" }: GraphDagProps) {
  const { setViewport, getViewport, zoomIn, zoomOut, fitView } = useReactFlow();
  const store = useStoreApi();
  const paneWidth = useStore((s) => s.width);
  const paneHeight = useStore((s) => s.height);
  const zoom = useStore((s) => s.transform[2]);
  const marker = `dag-arrow-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const root = useRef<HTMLDivElement | null>(null);

  const flow = useMemo(() => dagFlow(shape, { removed }), [shape, removed]);
  /** layout order — down the ranks, then across each — which is the order the arrows walk */
  const order = useMemo(() => [...flow.cards].sort((a, b) => a.box.y + a.box.height / 2 - (b.box.y + b.box.height / 2) || a.box.x - b.box.x).map((c) => c.node.id), [flow]);
  const boxes = useMemo(() => new Map(flow.cards.map((c) => [c.node.id, c.box])), [flow]);

  // the roving stop: where the operator last was, else the step the run is on, else the start
  const [rover, setRover] = useState<string | null>(null);
  const stop = rover !== null && boxes.has(rover) ? rover : current && boxes.has(current) ? current : selected && boxes.has(selected) ? selected : boxes.has(shape.entry) ? shape.entry : order[0] ?? null;

  const reveal = useCallback((id: string) => {
    const box = boxes.get(id);
    const { width, height } = store.getState();
    if (!box) return;
    const to = revealBox(getViewport(), { width, height }, box);
    if (to) void setViewport(to); // instant: a walk is a keyboard action (DESIGN.md Motion)
  }, [boxes, store, getViewport, setViewport]);

  const focusStep = useCallback((id: string | undefined) => {
    if (id === undefined) return;
    reveal(id);
    [...(root.current?.querySelectorAll<HTMLElement>("[data-dag-step]") ?? [])].find((el) => el.dataset.dagStep === id)?.focus({ preventScroll: true });
  }, [reveal]);

  const walk = useCallback((id: string, e: React.KeyboardEvent) => {
    const at = order.indexOf(id);
    const n = order.length;
    if (at < 0 || e.metaKey || e.ctrlKey || e.altKey) return;
    // wraps, so End → ArrowRight lands on the first step rather than nowhere
    const to = e.key === "ArrowDown" || e.key === "ArrowRight" ? order[(at + 1) % n]
      : e.key === "ArrowUp" || e.key === "ArrowLeft" ? order[(at - 1 + n) % n]
      : e.key === "Home" ? order[0]
      : e.key === "End" ? order[n - 1]
      : undefined;
    if (to === undefined) return;
    e.preventDefault();
    e.stopPropagation(); // the canvas's own arrows pan; on a step they walk
    focusStep(to);
  }, [order, focusStep]);

  // callers pass these inline, and the run view re-renders every second: read through a ref so a
  // fresh closure is not a fresh set of nodes for React Flow to reconcile
  const handlers = useRef({ onSelect, canSelect });
  handlers.current = { onSelect, canSelect };
  const canAct = !!onSelect;
  const nodes = useMemo<Node[]>(() => flow.cards.map((card) => {
    const n = card.node;
    const selectable = canAct && handlers.current.canSelect(n);
    const isCurrent = n.id === current;
    const gone = removed?.has(n.id) ?? false;
    const v = visits?.[n.id] ?? 0;
    const shown = n.title?.trim() || n.id;
    const label = [
      // the id is spoken too when a title stands in for it: the id is what every other
      // surface (the log, node@visit) calls this step
      shown === n.id ? `${n.kind} node ${n.id}` : `${n.kind} step ${shown}, id ${n.id}`,
      card.sub,
      v > 0 ? `${v} visit${v === 1 ? "" : "s"}` : "",
      n.node_tuning ? "has a node override" : "",
      isCurrent ? (waiting ? "current, waiting on you" : "current") : "",
      selected === n.id ? "selected" : "",
      highlight === n.id ? "highlighted" : "",
    ].filter(Boolean).join(", ");
    return {
      id: n.id,
      type: "dagstep",
      position: { x: card.box.x, y: card.box.y },
      width: card.box.width,
      height: card.box.height,
      draggable: false,
      connectable: false,
      selectable: false,
      focusable: false,
      data: {
        card, label, isEntry: n.id === shape.entry, isCurrent, waiting, selected: selected === n.id, selectable, gone,
        lit: highlight === n.id, visits: v, info: info?.[n.id], inRun: info !== undefined, tabStop: stop === n.id,
        onSelect: () => handlers.current.onSelect?.(n.id),
        onFocus: () => setRover(n.id),
        onWalk: (e: React.KeyboardEvent) => walk(n.id, e),
      } satisfies CardData,
    };
  }), [flow, canAct, current, removed, visits, waiting, selected, highlight, info, stop, shape.entry, walk]);

  // Framed once per graph, as soon as the pane has a size — never again, so a tuning edit or a
  // run's next event does not move the view under the operator.
  const framed = useRef<string | null>(null);
  const frame = useCallback(() => {
    void setViewport(openingView(flow.layout, { width: paneWidth, height: paneHeight }, boxes.get(current ?? shape.entry)));
  }, [setViewport, flow.layout, paneWidth, paneHeight, boxes, current, shape.entry]);
  useEffect(() => {
    if (!(paneWidth > 0 && paneHeight > 0) || framed.current === shape.name) return;
    framed.current = shape.name;
    frame();
  }, [paneWidth, paneHeight, shape.name, frame]);

  const showAll = useCallback(() => { void fitView({ padding: 0.06, minZoom: MIN_ZOOM, maxZoom: 1 }); }, [fitView]);
  const pan = useCallback((dx: number, dy: number) => {
    const v = getViewport();
    void setViewport({ x: v.x + dx, y: v.y + dy, zoom: v.zoom });
  }, [getViewport, setViewport]);

  /** the canvas's own keys. On a step the arrows have already been taken by the walk. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const step = e.shiftKey ? 240 : 60;
    const done = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === "+" || e.key === "=") { void zoomIn(); done(); }
    else if (e.key === "-" || e.key === "_") { void zoomOut(); done(); }
    else if (e.key === "0") { showAll(); done(); }
    else if (e.key === "ArrowLeft") { pan(step, 0); done(); }
    else if (e.key === "ArrowRight") { pan(-step, 0); done(); }
    else if (e.key === "ArrowUp") { pan(0, step); done(); }
    else if (e.key === "ArrowDown") { pan(0, -step); done(); }
  };
  // listed, not handled, by the registry: the keys act where focus is, on this canvas
  useShortcuts([
    { id: "graph.walk", scope: "A graph", label: "Move between steps (on a step)", keys: ["arrowdown", "arrowup"], passive: true },
    { id: "graph.pan", scope: "A graph", label: "Pan the picture (on the canvas; Shift for more)", keys: ["arrowleft", "arrowright"], passive: true },
    { id: "graph.zoom-in", scope: "A graph", label: "Zoom in", keys: "+", passive: true },
    { id: "graph.zoom-out", scope: "A graph", label: "Zoom out", keys: "-", passive: true },
    { id: "graph.fit", scope: "A graph", label: "Show the whole graph", keys: "0", passive: true },
  ]);

  // a map of what is off screen: no use — and in the way — once the whole graph is on screen
  const allInView = useStore((st) => {
    const [x, y, z] = st.transform;
    return x >= 0 && y >= 0 && x + flow.layout.width * z <= st.width && y + flow.layout.height * z <= st.height;
  });
  const minimap = flow.cards.length > MINIMAP_FROM && paneWidth >= MINIMAP_MIN_PANE && !allInView;
  const anyTaken = taken !== undefined && taken.size > 0;

  return (
    <div className="dag-view">
      <div
        ref={root}
        className="gb-canvas dag-canvas"
        role="region"
        tabIndex={0}
        aria-label={`${shape.name} graph — ${shape.nodes.length} steps. Arrow keys pan, plus and minus zoom, 0 shows all of it.`}
        onKeyDown={onKeyDown}
      >
        <ReactFlow
          nodes={nodes}
          edges={NO_EDGES}
          nodeTypes={nodeTypes}
          // read-only: nothing is dragged, wired, selected into React Flow's store, or deleted
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          panOnDrag
          zoomOnScroll={wheel === "zoom"}
          preventScrolling={wheel === "zoom"}
          zoomOnPinch
          zoomOnDoubleClick={false}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          // 100% until `frame()` has a pane to measure: never a fitted, shrunken first paint
          defaultViewport={{ x: FRAME_PAD, y: FRAME_PAD, zoom: 1 }}
          // the wrapper above is the named region; the library's own node descriptions promise
          // keys (move, delete) this picture does not have
          disableKeyboardA11y
          proOptions={{ hideAttribution: true }}
        >
          <ViewportPortal>
            <svg className="dag-wires" width={Math.max(1, flow.layout.width)} height={Math.max(1, flow.layout.height)} aria-hidden>
              <defs>
                {(["", "-on"] as const).map((suffix) => (
                  <marker key={suffix} id={`${marker}${suffix}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M0,0 L8,4 L0,8 z" className={suffix ? "dag-arrow-on" : "dag-arrow"} />
                  </marker>
                ))}
              </defs>
              {flow.wires.map((w) => {
                const on = anyTaken && taken.has(edgeKey(w.from, w.to));
                return (
                  <path
                    key={w.index} d={w.path}
                    className={`dag-wire ${on ? "taken" : ""}`}
                    markerEnd={`url(#${marker}${on ? "-on" : ""})`}
                    /* HOW-73: a fork/join edge is the parallel step's, not a route — drawn dashed */
                    strokeDasharray={w.kind ? "4 3" : undefined}
                    data-edge-kind={w.kind}
                    data-back={w.back || undefined}
                  />
                );
              })}
            </svg>
            {flow.wires.map((w) => w.caption && (
              <div
                key={w.index}
                className={`dag-caption ${w.caption.otherwise ? "otherwise" : ""}`}
                // a DOM label at a point of the viewport: centred on the spot the layout kept for it
                style={{ transform: `translate(-50%, -50%) translate(${w.caption.x}px, ${w.caption.y}px)`, maxWidth: CAPTION_MAX }}
              >
                <Truncate mono={!w.caption.otherwise}>{w.caption.text}</Truncate>
              </div>
            ))}
          </ViewportPortal>
          {minimap && (
            <MiniMap
              pannable zoomable position="bottom-right" ariaLabel={`${shape.name} graph, in miniature`}
              className="dag-minimap" nodeBorderRadius={6}
              // the step the run is on is the accent in the map too
              nodeColor={(n) => (n.id === current ? "var(--primary)" : "var(--border-strong)")}
            />
          )}
          <Panel position="bottom-left" className="nodrag nopan flex items-center gap-1 rounded-[var(--radius)] border border-border bg-card p-1">
            <Tooltip content={<span className="inline-flex items-center gap-2">Zoom out <Kbd keys="-" /></span>} side="top">
              <Button variant="ghost" size="icon-sm" aria-label="Zoom out" disabled={zoom <= MIN_ZOOM} onClick={() => void zoomOut()}><Minus /></Button>
            </Tooltip>
            <Tooltip content="Back to 100%" side="top">
              <Button variant="ghost" size="sm" className="h-6 min-w-12 px-1.5 text-xs tabular-nums" aria-label={`Zoom ${Math.round(zoom * 100)}% — back to 100%`} onClick={frame}>
                {Math.round(zoom * 100)}%
              </Button>
            </Tooltip>
            <Tooltip content={<span className="inline-flex items-center gap-2">Zoom in <Kbd keys="+" /></span>} side="top">
              <Button variant="ghost" size="icon-sm" aria-label="Zoom in" disabled={zoom >= MAX_ZOOM} onClick={() => void zoomIn()}><Plus /></Button>
            </Tooltip>
            <Tooltip content={<span className="inline-flex items-center gap-2">Show the whole graph <Kbd keys="0" /></span>} side="top">
              <Button variant="ghost" size="icon-sm" aria-label="Show the whole graph" onClick={showAll}><Maximize /></Button>
            </Tooltip>
          </Panel>
        </ReactFlow>
      </div>
      <p className="dag-hint">
        Drag to pan · {wheel === "zoom" ? "scroll to zoom" : <><Kbd decorative>⌘</Kbd> or <Kbd decorative>Ctrl</Kbd> + scroll to zoom</>} · hover or focus a step for the rest of it
      </p>
    </div>
  );
}

const NO_EDGES: never[] = [];

export function useGraphShape(name: string | undefined): GraphShapeDto | null {
  const [shape, setShape] = useState<GraphShapeDto | null>(null);
  useEffect(() => {
    if (!name) return;
    fetch(`/api/graphs/${name}`).then((r) => (r.ok ? r.json() : null)).then(setShape).catch(() => {});
  }, [name]);
  return shape;
}
