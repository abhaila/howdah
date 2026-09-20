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
 * The box truncates a node id at 20 characters, and what carries the full one is the node's
 * OWN aria-label rather than a tooltip. A Tooltip here would have to live in a
 * `foreignObject`, whose overflow Safari clips — so the floating panel would be cut off
 * exactly when the id is long enough to need it. The label is read on focus by the same
 * assistive tech a tooltip would be for, and it cannot be clipped.
 */
import { useEffect, useRef, useState } from "react";

export interface AgentConfigDto {
  harness?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  maxTurns?: number;
  skills?: string[];
}

export interface GraphShapeDto {
  name: string;
  description: string;
  entry: string;
  inputs?: string[];
  defaults?: AgentConfigDto;
  tuning?: { defaults?: AgentConfigDto; nodes?: Record<string, AgentConfigDto> };
  nodes: Array<{
    id: string; kind: string; class?: string; prompt?: string; run?: string;
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

function layout(shape: GraphShapeDto): Map<string, { x: number; y: number }> {
  // BFS layers from entry; unreached nodes go in a trailing layer
  const depth = new Map<string, number>([[shape.entry, 0]]);
  const queue = [shape.entry];
  while (queue.length) {
    const n = queue.shift()!;
    for (const e of shape.edges) {
      if (e.from === n && !depth.has(e.to)) {
        depth.set(e.to, (depth.get(n) ?? 0) + 1);
        queue.push(e.to);
      }
    }
  }
  for (const n of shape.nodes) if (!depth.has(n.id)) depth.set(n.id, (Math.max(0, ...depth.values()) + 1));

  const layers = new Map<number, string[]>();
  for (const n of shape.nodes) {
    const d = depth.get(n.id)!;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d)!.push(n.id);
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const [d, ids] of layers) {
    ids.forEach((id, i) => pos.set(id, { x: 40 + i * 210 + (d % 2) * 60, y: 40 + d * 92 }));
  }
  return pos;
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
    <div className="dag-scroll">
      <svg width={width} height={height} className="dag" role="list" aria-label={`${shape.name} graph — ${shape.nodes.length} nodes`}>
        <defs>
          <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" fill="var(--fg-faint)" />
          </marker>
        </defs>
        {shape.edges.map((e, i) => {
          const a = pos.get(e.from)!;
          const b = pos.get(e.to)!;
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
          const p = pos.get(n.id)!;
          const isCurrent = n.id === current;
          const v = visits?.[n.id];
          const selectable = !!onSelect && canSelect(n);
          const sub = subtitle(n);
          const label = [
            `${n.kind} node ${n.id}`,
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
                {KIND_GLYPH[n.kind] ?? "?"} {n.id.length > 20 ? n.id.slice(0, 19) + "…" : n.id}
              </text>
              <text x="12" y="40" className="dag-sub" aria-hidden>{sub}</text>
              {v !== undefined && v > 0 && <g aria-hidden><rect x="150" y="-9" width="30" height="18" rx="9" className="dag-visits" /><text x="165" y="4" textAnchor="middle" className="dag-visits-text">×{v}</text></g>}
              {n.node_tuning && <circle cx="8" cy="8" r="3.5" className="dag-tuned" aria-hidden />}
            </g>
          );
        })}
      </svg>
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
