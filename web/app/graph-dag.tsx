/**
 * GraphDag (T20) — the live graph picture (Orbital's Graph tab / autoresearcherUI's
 * board). Layered BFS layout from the entry node; back edges (loops) curve around the
 * left. The current node pulses; visit counts render as ×N badges so revisits are never
 * a linear lie.
 */
import { useEffect, useState } from "react";

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

export function GraphDag({ shape, current, visits, onSelect, selected }: { shape: GraphShapeDto; current?: string; visits?: Record<string, number>; onSelect?: (id: string) => void; selected?: string }) {
  const pos = layout(shape);
  const width = Math.max(...[...pos.values()].map((p) => p.x)) + 230;
  const height = Math.max(...[...pos.values()].map((p) => p.y)) + 90;
  const depthOf = (id: string) => pos.get(id)?.y ?? 0;

  return (
    <div className="dag-scroll">
      <svg width={width} height={height} className="dag">
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
          return (
            <g key={i}>
              <path d={d} fill="none" stroke="var(--fg-faint)" strokeWidth="1.2" markerEnd="url(#arrow)" opacity={back ? 0.7 : 1} />
              {e.label && (
                <text x={midX} y={midY} className="dag-edge-label" textAnchor="middle">{e.label}</text>
              )}
            </g>
          );
        })}
        {shape.nodes.map((n) => {
          const p = pos.get(n.id)!;
          const isCurrent = n.id === current;
          const v = visits?.[n.id];
          return (
            <g
              key={n.id}
              transform={`translate(${p.x}, ${p.y})`}
              className={`dag-node ${isCurrent ? "current" : ""} ${selected === n.id ? "selected" : ""} ${onSelect && n.kind === "agent" ? "clickable" : ""} kind-${n.kind}`}
              onClick={() => n.kind === "agent" && onSelect?.(n.id)}
            >
              <rect width="180" height="52" rx="9" />
              <text x="12" y="21" className="dag-title">
                {KIND_GLYPH[n.kind] ?? "?"} {n.id.length > 20 ? n.id.slice(0, 19) + "…" : n.id}
              </text>
              <text x="12" y="40" className="dag-sub">
                {n.kind === "agent" ? `${n.harness ?? "claude"}${n.model ? ` · ${n.model}` : ""}${n.effort ? ` · ${n.effort}` : ""}` :
                 n.kind === "command" ? (n.run ?? "") :
                 n.kind === "wait" ? (n.duration ?? "") :
                 n.kind === "terminal" ? (n.outcome ?? "") : n.kind}
              </text>
              {v !== undefined && v > 0 && <g><rect x="150" y="-9" width="30" height="18" rx="9" className="dag-visits" /><text x="165" y="4" textAnchor="middle" className="dag-visits-text">×{v}</text></g>}
              {n.node_tuning && <circle cx="8" cy="8" r="3.5" className="dag-tuned" />}
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
