/**
 * GraphDag (T20) — the live graph picture (Orbital's Graph tab / autoresearcherUI's
 * board). Layered BFS layout from the entry node; back edges (loops) curve around the
 * left. The current node pulses; visit counts render as ×N badges so revisits are never
 * a linear lie.
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
 * The box truncates a node id at 20 characters, and what carries the full one is the node's
 * OWN aria-label rather than a tooltip. A Tooltip here would have to live in a
 * `foreignObject`, whose overflow Safari clips — so the floating panel would be cut off
 * exactly when the id is long enough to need it. The label is read on focus by the same
 * assistive tech a tooltip would be for, and it cannot be clipped.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ZoomIn, ZoomOut, Maximize2, RotateCcw } from "lucide-react";
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
  }>;
  edges: Array<{ from: string; to: string; label?: string; weight?: number }>;
}

const KIND_GLYPH: Record<string, string> = { agent: "◆", command: "▮", worktree: "⎇", wait: "◔", terminal: "●" };

/** what the node's second line says — one reading, used by the box AND by its spoken label */
function subtitle(n: GraphShapeDto["nodes"][number]): string {
  if (n.kind === "agent") return `${n.harness ?? "claude"}${n.model ? ` · ${n.model}` : ""}${n.effort ? ` · ${n.effort}` : ""}`;
  if (n.kind === "command") return n.run ?? "";
  if (n.kind === "wait") return n.duration ?? "";
  if (n.kind === "terminal") return n.outcome ?? "";
  return n.kind;
}

export function GraphDag({
  shape,
  current,
  visits,
  onSelect,
  selected,
  canSelect = (node) => node.kind === "agent",
}: {
  shape: GraphShapeDto;
  current?: string;
  visits?: Record<string, number>;
  onSelect?: (id: string) => void;
  selected?: string;
  canSelect?: (node: GraphShapeDto["nodes"][number]) => boolean;
}) {
  const pos = layout(shape);
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
            <ZoomOut size={13} />
          </Button>
        </Tooltip>
        <span className="m dag-zoom" aria-live="polite">{Math.round(scale * 100)}%</span>
        <Tooltip content="Zoom in">
          <Button variant="outline" size="icon" aria-label="Zoom in" disabled={scale >= 2} onClick={() => zoom(scale + 0.1)}>
            <ZoomIn size={13} />
          </Button>
        </Tooltip>
        <Tooltip content="Fit the graph to the pane">
          <Button variant="outline" size="icon" aria-label="Fit the graph to the pane" onClick={fit}><Maximize2 size={13} /></Button>
        </Tooltip>
        <Tooltip content="Reset to 100%">
          <Button variant="outline" size="icon" aria-label="Reset zoom to 100%" onClick={() => zoom(1)}><RotateCcw size={13} /></Button>
        </Tooltip>
        <span className="dag-hint">drag to pan · ⌘/ctrl + scroll to zoom</span>
      </div>
      <div className="dag-scroll" ref={view} onPointerDown={onPanStart}>
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
        {shape.edges.map((e, i) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          // layout() places the steps that EXIST, so an edge naming one that does not has no
          // position to draw between. Skip it rather than dereference nothing (see header).
          if (!a || !b) return null;
          const back = depthOf(e.to) <= depthOf(e.from) && e.from !== e.to;
          const x1 = a.x + 90, y1 = a.y + 52, x2 = b.x + 90, y2 = b.y - 2;
          const d = back
            ? `M ${a.x} ${a.y + 26} C ${a.x - 90} ${a.y + 26}, ${b.x - 90} ${b.y + 26}, ${b.x} ${b.y + 26}`
            : `M ${x1} ${y1} C ${x1} ${y1 + 34}, ${x2} ${y2 - 34}, ${x2} ${y2}`;
          const midX = back ? Math.min(a.x, b.x) - 66 : (x1 + x2) / 2;
          const midY = back ? (a.y + b.y) / 2 + 26 : (y1 + y2) / 2;
          const delay = Math.min(depthOf(e.from), depthOf(e.to)) / 92 * 55;
          return (
            <g key={i} aria-hidden>
              <path
                d={d} pathLength={100} className="dag-edge"
                /* the draw-in delay IS this edge's depth in the layout — data, not style */
                style={{ ["--dag-delay" as string]: `${140 + delay}ms` }}
                fill="none" stroke="var(--fg-faint)" strokeWidth="1.2" markerEnd="url(#arrow)" opacity={back ? 0.7 : 1}
              />
              {e.label && (
                <text x={midX} y={midY} className="dag-edge-label" style={{ ["--dag-delay" as string]: `${300 + delay}ms` }} textAnchor="middle">{e.label}</text>
              )}
            </g>
          );
        })}
        {shape.nodes.map((n, i) => {
          const p = pos.get(n.id);
          // layout() gives every node in `shape.nodes` a position, an unreached one included
          // (its trailing layer), so this holds today — it is read rather than asserted so the
          // node loop cannot become the next edge loop if that ever changes
          if (!p) return null;
          const isCurrent = n.id === current;
          const v = visits?.[n.id];
          const selectable = !!onSelect && canSelect(n);
          const sub = subtitle(n);
          const shown = n.title?.trim() || n.id;
          const label = [
            // the id is spoken too when a title stands in for it: the id is what every other
            // surface (the run DAG, the log, node@visit) calls this step
            shown === n.id ? `${n.kind} node ${n.id}` : `${n.kind} step ${shown}, id ${n.id}`,
            sub,
            v !== undefined && v > 0 ? `${v} visit${v === 1 ? "" : "s"}` : "",
            n.node_tuning ? "has a node override" : "",
            isCurrent ? "current" : "",
            selected === n.id ? "selected" : "",
          ].filter(Boolean).join(", ");
          return (
            <g
              key={n.id}
              ref={(el) => { nodeRefs.current[i] = el; }}
              transform={`translate(${p.x}, ${p.y})`}
              className={`dag-node ${isCurrent ? "current" : ""} ${selected === n.id ? "selected" : ""} ${selectable ? "clickable" : ""} kind-${n.kind}`}
              style={{ ["--dag-delay" as string]: `${(p.y / 92) * 55}ms` }}
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
              <rect width="180" height="52" rx="9" />
              <text x="12" y="21" className="dag-title" aria-hidden>
                {KIND_GLYPH[n.kind] ?? "?"} {shown.length > 20 ? shown.slice(0, 19) + "…" : shown}
              </text>
              <text x="12" y="40" className="dag-sub" aria-hidden>{sub}</text>
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
