/**
 * GraphDag (T20) — the live graph picture (Orbital's Graph tab / autoresearcherUI's
 * board). Layered BFS layout from the entry node; back edges (loops) curve around the
 * left. Visit counts render as ×N badges so revisits are never a linear lie. Nothing here
 * animates (HOW-68): the picture used to draw itself in every time its tab was opened, and a
 * tab switch is a keyboard action that DESIGN.md says is instant.
 *
 * HOW-16 P2.10: this was the one component in the app with NO accessibility at all — zero
 * aria-label, zero role, zero tabIndex, and an `onClick` on an SVG `<g>`, which is not a
 * control on any platform. An SVG is a picture to assistive tech unless it is told
 * otherwise, so the graph is a `role="list"` of `role="listitem"` nodes; every selectable
 * node is a focus stop with a spoken label built from what its box actually says (kind, id,
 * harness/model, visit count, whether it carries an override); Enter and Space select it,
 * and the arrow keys walk the nodes in layout order so reaching the tenth node does not
 * cost ten Tabs. The geometry is untouched — layout() is the same function.
 *
 * HOW-22: this component now draws a DRAFT as well as a run. A run's shape is derived by the
 * server and is internally consistent; a draft is being TYPED, so an edge may name a step that
 * is not there yet ("go to [pick a step]") and a re-opened hand-edited module may name one
 * that never was. The edge and node loops below therefore SKIP what they cannot place instead
 * of asserting it with `!` — a picture is not a gate, and the assertion took the whole app
 * down with it, unsaved draft included, because web/app has no error boundary. The missing
 * step is reported in words by specProblems(), in the pane that fixes it.
 *
 * HOW-65: it also draws a DRAFT AGAINST ITS BASE on the review page. A step the draft removes
 * is still drawn — dashed, struck through, marked − with the word "removed" — because a
 * removal is the change the operator is least likely to notice from a list; the caller passes
 * it with no edges into it. `highlight` lights the box whose row has focus in the list beside it.
 *
 * The box truncates a node id at 20 characters, and what carries the full one is the node's
 * OWN aria-label rather than a tooltip. A Tooltip here would have to live in a
 * `foreignObject`, whose overflow Safari clips — so the floating panel would be cut off
 * exactly when the id is long enough to need it. The label is read on focus by the same
 * assistive tech a tooltip would be for, and it cannot be clipped.
 *
 * HOW-68: every label is 12px or more (edge conditions were 9px), a node's id is DM Mono and
 * its second line DM Sans; a route's condition is printed nearer its TARGET, alternating two
 * heights among the routes leaving one step, with a halo of the canvas ground behind it — at
 * the midpoint every condition out of a branching step landed on its siblings. A node's kind
 * is a drawn icon, not a dingbat character. The step the run is ON carries the status glyph
 * (half-disc running; the triangle, and the only amber in the picture, when it is parked
 * waiting on you — `waiting`). A focused node shows the same 2px ring every other focus stop
 * does. The picture keeps ITS OWN scroller, which is a focus stop while it overflows.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ZoomIn, ZoomOut, Maximize2, RotateCcw, Sparkles, Terminal, GitBranch, Clock, Split, CircleDot, Circle } from "lucide-react";
import { StatusGlyph } from "./status";
import { Kbd } from "@/components/ui/kbd";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
// HOW-24: the layered-BFS placement moved to lib/layout.ts, because the builder's canvas
// places the same boxes and two copies of it would draw one graph two ways.
import { layout } from "@/lib/layout";

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

/** a node's kind, as a drawn icon (never a dingbat character: DESIGN.md "Status is a shape") */
const KIND_ICON: Record<string, typeof Sparkles> = { agent: Sparkles, command: Terminal, worktree: GitBranch, wait: Clock, parallel: Split, terminal: CircleDot };

/**
 * An id cut to fit its box, keeping BOTH ends: step ids share their prefix
 * (`implementation.plan`, `implementation.implement`) and differ at the tail, which a trailing
 * ellipsis throws away.
 */
const fitId = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, Math.ceil((max - 1) / 2) - 1)}…${s.slice(-(Math.floor((max - 1) / 2) + 1))}`);

/**
 * A step id as a box prints it (D23): the part that TELLS STEPS APART, in full.
 *
 * `fitId` cut the middle of every long id, which for `implementation.local_review` among
 * `implementation.plan_review` and `implementation.implement_review` gave three boxes reading
 * "implemen…al_review", "implemen…an_review", "implemen…nt_review" — the shared prefix kept, the
 * word that differs lost. A dotted id is `<group>.<step>`, so:
 *
 *   - when EVERY step of the graph is in one group (`quick-task.work`, `quick-task.review`),
 *     the group says nothing and is omitted;
 *   - otherwise the group is printed dimmed, and when the whole id does not fit it is the GROUP
 *     that is shortened (`impl….local_review`), never the step;
 *   - only a step name that cannot fit on its own is cut, both ends kept, as before.
 *
 * The full id is never lost: it is the node's `aria-label` and its hover `<title>`. Pure.
 */
export function idParts(id: string, max: number, sharedGroup: string | null): { dim: string; main: string } {
  const dot = id.lastIndexOf(".");
  if (dot <= 0 || dot === id.length - 1) return { dim: "", main: fitId(id, max) };
  const group = id.slice(0, dot);
  const step = id.slice(dot + 1);
  if (sharedGroup !== null && group === sharedGroup) return { dim: "", main: fitId(step, max) };
  if (id.length <= max) return { dim: `${group}.`, main: step };
  // room for the group once the step and its dot are in: at least two letters and the ellipsis
  const room = max - step.length - 1;
  if (room >= 3) return { dim: `${group.slice(0, room - 1)}….`, main: step };
  return { dim: "", main: fitId(step, max) };
}

/** the one group every dotted id shares, when every node has a dotted id in it — else null */
export function sharedGroupOf(ids: readonly string[]): string | null {
  if (ids.length < 2) return null;
  const groups = new Set(ids.map((id) => { const dot = id.lastIndexOf("."); return dot > 0 ? id.slice(0, dot) : null; }));
  if (groups.size !== 1) return null;
  const [only] = [...groups];
  return only ?? null;
}

/** a point on the cubic the forward edges are drawn with */
const cubic = (t: number, a: number, b: number, c: number, d: number) => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};

/** what the node's second line says — one reading, used by the box AND by its spoken label */
function subtitle(n: GraphShapeDto["nodes"][number]): string {
  if (n.kind === "agent") return `${n.harness ?? "claude"}${n.model ? ` · ${n.model}` : ""}${n.effort ? ` · ${n.effort}` : ""}`;
  if (n.kind === "command") return n.run ?? "";
  if (n.kind === "wait") return n.duration ?? "";
  if (n.kind === "terminal") return n.outcome ?? "";
  if (n.kind === "parallel") {
    const count = n.branches?.length ?? 0;
    return `parallel · ${Math.min(n.concurrency ?? count, count)} at once`;
  }
  return n.kind;
}

export function GraphDag({
  shape,
  current,
  visits,
  onSelect,
  selected,
  canSelect = (node) => node.kind === "agent",
  removed,
  highlight,
  waiting = false,
}: {
  shape: GraphShapeDto;
  current?: string;
  visits?: Record<string, number>;
  onSelect?: (id: string) => void;
  selected?: string;
  canSelect?: (node: GraphShapeDto["nodes"][number]) => boolean;
  /** HOW-65: steps a draft removes — drawn dashed and struck through, labelled "removed" */
  removed?: ReadonlySet<string>;
  /** HOW-65: the step whose row has focus in the list beside the picture */
  highlight?: string | null;
  /** the run is parked on `current`, waiting on the operator — the one amber mark in the picture */
  waiting?: boolean;
}) {
  const pos = layout(shape);
  const sharedGroup = sharedGroupOf(shape.nodes.map((n) => n.id));
  const width = Math.max(...[...pos.values()].map((p) => p.x)) + 230;
  const height = Math.max(...[...pos.values()].map((p) => p.y)) + 90;
  /**
   * Zoom and pan. A graph of any size used to be a fixed-size SVG in a box that grew to fit
   * it, which the page scroll happened to make reachable; once the shell owned the viewport
   * there was no page scroll left and the bottom of a tall graph was simply unreachable.
   * The canvas scrolls in its own pane now, and the scale is the operator's.
   *
   * The controls sit ABOVE the canvas rather than floating on it — a zoom button parked over
   * the top-left of a graph covers the entry node, which is the one you most want to see.
   */
  const view = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  // the canvas is a focus stop exactly while there is something to scroll to (as ScrollPane is)
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const box = view.current;
    if (!box) return;
    const measure = () => setOverflows(box.scrollWidth > box.clientWidth + 1 || box.scrollHeight > box.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [scale, width, height]);
  const zoom = useCallback((to: number) => setScale(Math.min(2, Math.max(0.3, Math.round(to * 20) / 20))), []);
  const fit = useCallback(() => {
    const box = view.current;
    if (!box || width === 0) return;
    // the padding the pane already carries, so "fit" does not tuck the graph under its border
    zoom((box.clientWidth - 24) / width);
  }, [width, zoom]);

  /** drag the empty canvas to pan; a drag that starts on a node is that node's, not the canvas's */
  const onPanStart = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = view.current;
    if (!box || e.button !== 0) return;
    if ((e.target as Element).closest?.(".dag-node")) return;
    const from = { x: e.clientX, y: e.clientY, left: box.scrollLeft, top: box.scrollTop };
    box.setPointerCapture(e.pointerId);
    box.dataset.panning = "1"; // an attribute, not a class: nothing reads it but CSS
    const move = (ev: PointerEvent) => {
      box.scrollLeft = from.left - (ev.clientX - from.x);
      box.scrollTop = from.top - (ev.clientY - from.y);
    };
    const up = (ev: PointerEvent) => {
      box.releasePointerCapture(ev.pointerId);
      delete box.dataset.panning;
      box.removeEventListener("pointermove", move);
      box.removeEventListener("pointerup", up);
      box.removeEventListener("pointercancel", up);
    };
    box.addEventListener("pointermove", move);
    box.addEventListener("pointerup", up);
    box.addEventListener("pointercancel", up);
  };

  /** ctrl/cmd+wheel zooms, like every other canvas; a bare wheel still scrolls the pane */
  useEffect(() => {
    const box = view.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setScale((s) => Math.min(2, Math.max(0.3, Math.round((s - e.deltaY * 0.002) * 20) / 20)));
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, []);
  const depthOf = (id: string) => pos.get(id)?.y ?? 0;
  const nodeRefs = useRef<Array<SVGGElement | null>>([]);
  /**
   * The nodes the arrows walk: the SELECTABLE ones, in LAYOUT order (down the layers, then
   * across each one). Both halves are load-bearing. Only a selectable node carries a
   * tabIndex, so focusing any other `<g>` is a silent no-op — walking every node meant an
   * ArrowDown that met a command or worktree node between two agent nodes simply died, which
   * on the Graphs screen (canSelect defaults to `kind === "agent"`) is the common case, not
   * the edge one. And declaration order is not what the operator sees: the arrows have to
   * follow the picture.
   */
  const walk = shape.nodes
    .map((n, i) => ({ i, p: pos.get(n.id)!, ok: !!onSelect && canSelect(n) }))
    .filter((e) => e.ok)
    .sort((a, b) => a.p.y - b.p.y || a.p.x - b.p.x)
    .map((e) => e.i);
  // wraps, so End→ArrowRight lands on the first node rather than nowhere
  const focusNode = (ordinal: number) => {
    const n = walk.length;
    if (n === 0) return;
    nodeRefs.current[walk[((ordinal % n) + n) % n]!]?.focus();
  };

  return (
    <div className="dag-view">
      {/* in flow, above the canvas: a control that covers the graph is not a graph control */}
      <div className="dag-controls">
        <Tooltip content="Zoom out">
          <Button variant="outline" size="icon" aria-label="Zoom out" disabled={scale <= 0.3} onClick={() => zoom(scale - 0.1)}>
            <ZoomOut />
          </Button>
        </Tooltip>
        <span className="dag-zoom" aria-live="polite">{Math.round(scale * 100)}%</span>
        <Tooltip content="Zoom in">
          <Button variant="outline" size="icon" aria-label="Zoom in" disabled={scale >= 2} onClick={() => zoom(scale + 0.1)}>
            <ZoomIn />
          </Button>
        </Tooltip>
        <Tooltip content="Fit the graph to the pane">
          <Button variant="outline" size="icon" aria-label="Fit the graph to the pane" onClick={fit}><Maximize2 /></Button>
        </Tooltip>
        <Tooltip content="Reset to 100%">
          <Button variant="outline" size="icon" aria-label="Reset zoom to 100%" onClick={() => zoom(1)}><RotateCcw /></Button>
        </Tooltip>
        <span className="dag-hint">Drag to pan · <Kbd decorative>⌘</Kbd> or <Kbd decorative>Ctrl</Kbd> + scroll to zoom</span>
      </div>
      <div
        className="dag-scroll" ref={view} onPointerDown={onPanStart}
        role={overflows ? "region" : undefined} aria-label={overflows ? `${shape.name} graph canvas` : undefined} tabIndex={overflows ? 0 : undefined}
      >
      <svg
        width={Math.round(width * scale)}
        height={Math.round(height * scale)}
        viewBox={`0 0 ${width} ${height}`}
        className="dag"
        role="list"
        aria-label={`${shape.name} graph — ${shape.nodes.length} nodes`}
      >
        <defs>
          <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" fill="var(--fg-faint)" />
          </marker>
        </defs>
        {/* Two passes: every wire first, then every condition — a condition drawn with its own
            wire was struck through by each wire drawn after it, halo or no halo. */}
        {(["wire", "label"] as const).map((pass) => shape.edges.map((e, i) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          // layout() places the steps that EXIST, so an edge naming one that does not has no
          // position to draw between. Skip it rather than dereference nothing (see header).
          if (!a || !b) return null;
          const back = depthOf(e.to) <= depthOf(e.from) && e.from !== e.to;
          const x1 = a.x + 90, y1 = a.y + 52, x2 = b.x + 90, y2 = b.y - 2;
          if (pass === "wire") {
            const d = back
              ? `M ${a.x} ${a.y + 26} C ${a.x - 90} ${a.y + 26}, ${b.x - 90} ${b.y + 26}, ${b.x} ${b.y + 26}`
              : `M ${x1} ${y1} C ${x1} ${y1 + 34}, ${x2} ${y2 - 34}, ${x2} ${y2}`;
            return (
              <path
                key={`w${i}`} aria-hidden
                d={d} className="dag-edge"
                fill="none" stroke="var(--fg-faint)" strokeWidth="1.2" markerEnd="url(#arrow)" opacity={back ? 0.7 : 1}
                /* HOW-73: a fork/join edge is the parallel step's, not a route — drawn dashed */
                strokeDasharray={e.kind ? "4 3" : undefined}
                data-edge-kind={e.kind}
              />
            );
          }
          if (!e.label) return null;
          // A forward route's condition is printed just above its TARGET: the routes out of one
          // step fan apart there, where at the midpoint they all sat on each other. Two routes
          // into the same step (or two loops round the same side) step apart by a line.
          const twin = shape.edges.slice(0, i).filter((o) => o.label && o.to === e.to && (depthOf(o.to) <= depthOf(o.from)) === back).length;
          const midX = back ? Math.min(a.x, b.x) - 66 : cubic(0.82, x1, x1, x2, x2);
          // …and the routes out of ONE step alternate two heights: neighbouring targets are a
          // box apart, which is less than a long condition is wide
          const sibling = back ? 0 : shape.edges.slice(0, i).filter((o) => o.label && o.from === e.from && depthOf(o.to) > depthOf(o.from)).length;
          const midY = (back ? (a.y + b.y) / 2 + 26 : cubic(0.82, y1, y1 + 34, y2 - 34, y2) - 2) - (twin + (sibling % 2)) * 14;
          return <text key={`l${i}`} aria-hidden x={midX} y={midY} className="dag-edge-label" textAnchor="middle">{e.label}</text>;
        }))}
        {shape.nodes.map((n, i) => {
          const p = pos.get(n.id);
          // layout() gives every node in `shape.nodes` a position, an unreached one included
          // (its trailing layer), so this holds today — it is read rather than asserted so the
          // node loop cannot become the next edge loop if that ever changes
          if (!p) return null;
          const isCurrent = n.id === current;
          const v = visits?.[n.id];
          const selectable = !!onSelect && canSelect(n);
          const gone = removed?.has(n.id) ?? false;
          const sub = gone ? `removed · ${subtitle(n)}` : subtitle(n);
          const shown = n.title?.trim() || n.id;
          const label = [
            // the id is spoken too when a title stands in for it: the id is what every other
            // surface (the run DAG, the log, node@visit) calls this step
            shown === n.id ? `${n.kind} node ${n.id}` : `${n.kind} step ${shown}, id ${n.id}`,
            sub,
            v !== undefined && v > 0 ? `${v} visit${v === 1 ? "" : "s"}` : "",
            n.node_tuning ? "has a node override" : "",
            isCurrent ? (waiting ? "current, waiting on you" : "current") : "",
            selected === n.id ? "selected" : "",
            highlight === n.id ? "highlighted" : "",
          ].filter(Boolean).join(", ");
          return (
            <g
              key={n.id}
              ref={(el) => { nodeRefs.current[i] = el; }}
              transform={`translate(${p.x}, ${p.y})`}
              className={`dag-node ${isCurrent ? "current" : ""} ${isCurrent && waiting ? "waiting" : ""} ${selected === n.id ? "selected" : ""} ${selectable ? "clickable" : ""} ${gone ? "removed" : ""} ${highlight === n.id ? "highlight" : ""} kind-${n.kind}`}
              role={selectable ? "button" : "listitem"}
              aria-label={label}
              aria-pressed={selectable ? selected === n.id : undefined}
              tabIndex={selectable ? 0 : undefined}
              onClick={() => selectable && onSelect?.(n.id)}
              onKeyDown={(e) => {
                if (!selectable) return;
                // where this node sits in the walk — never -1 here, since only a selectable
                // node is focusable and every selectable node is in it
                const at = walk.indexOf(i);
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect?.(n.id); }
                // arrows walk the nodes in layout order, so the tenth node is not ten Tabs away
                else if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); focusNode(at + 1); }
                else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); focusNode(at - 1); }
                else if (e.key === "Home") { e.preventDefault(); focusNode(0); }
                else if (e.key === "End") { e.preventDefault(); focusNode(walk.length - 1); }
              }}
            >
              {/* the box cuts a long id; hovering it reads the whole label, as focusing it does */}
              <title>{label}</title>
              <rect width="180" height="52" rx="8" />
              {/* a kind is an icon; a removed step keeps its minus sign as text (it is the word) */}
              {!gone && (() => { const Icon = KIND_ICON[n.kind] ?? Circle; return <g transform="translate(10, 11)" className="dag-kind" aria-hidden><Icon size={13} /></g>; })()}
              <text x={gone ? 12 : 29} y="22" className="dag-title" aria-hidden>
                {gone ? "− " : ""}
                {shown === n.id
                  ? (() => { const parts = idParts(n.id, isCurrent || gone ? 16 : 18, sharedGroup); return <>{parts.dim && <tspan className="dag-title-group">{parts.dim}</tspan>}{parts.main}</>; })()
                  : fitId(shown, isCurrent || gone ? 16 : 18)}
              </text>
              <text x="12" y="40" className="dag-sub" aria-hidden>{sub.length > 26 ? sub.slice(0, 25) + "…" : sub}</text>
              {isCurrent && <g transform="translate(158, 11)" aria-hidden><StatusGlyph status={waiting ? "needs-input" : "running"} size={13} /></g>}
              {v !== undefined && v > 0 && <g aria-hidden><rect x="150" y="-9" width="30" height="18" rx="9" className="dag-visits" /><text x="165" y="4" textAnchor="middle" className="dag-visits-text">×{v}</text></g>}
              {n.node_tuning && <circle cx="8" cy="8" r="3.5" className="dag-tuned" aria-hidden />}
            </g>
          );
        })}
      </svg>
      </div>
    </div>
  );
}

export function useGraphShape(name: string | undefined): GraphShapeDto | null {
  const [shape, setShape] = useState<GraphShapeDto | null>(null);
  useEffect(() => {
    if (!name) return;
    fetch(`/api/graphs/${name}`).then((r) => (r.ok ? r.json() : null)).then(setShape).catch(() => {});
  }, [name]);
  return shape;
}
