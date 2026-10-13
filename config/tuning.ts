/**
 * Graph tuning overlay (UI-editable agent config).
 *
 * The TS graph file stays the source of truth for STRUCTURE (nodes, edges, reads/writes —
 * the validated part); tuning is the fine-dial layer the UI edits without touching code:
 * per-node and per-graph AgentConfig stored in $HOWDAH_HOME/tuning.json.
 *
 * Resolution order (extends T17's): run override → UI node tuning → TS node setting →
 * UI graph tuning → TS graph default. Tuning applies to NEW runs and re-attempts; a
 * running attempt keeps what it launched with.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasTools, type AgentConfig } from "../core/graph";
import { howdahHome } from "./config";

export interface GraphTuning {
  defaults?: AgentConfig;
  nodes?: Record<string, AgentConfig>;
}

export type TuningFile = Record<string, GraphTuning>;

export function tuningPath(base = howdahHome()): string {
  return join(base, "tuning.json");
}

export function loadTuning(base = howdahHome()): TuningFile {
  const p = tuningPath(base);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as TuningFile;
  } catch {
    return {};
  }
}

export function saveTuning(tuning: TuningFile, base = howdahHome()): void {
  mkdirSync(base, { recursive: true });
  writeFileSync(tuningPath(base), JSON.stringify(tuning, null, 2) + "\n");
}

/** drop empty strings / empty objects so cleared fields fall back to the TS baseline */
export function pruneTuning(t: GraphTuning): GraphTuning {
  const cleanCfg = (c: AgentConfig | undefined): AgentConfig | undefined => {
    if (!c) return undefined;
    const out: AgentConfig = {};
    for (const [k, v] of Object.entries(c) as [keyof AgentConfig, unknown][]) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (k === "tools" && !hasTools(v as AgentConfig["tools"])) continue; // HOW-41: {} is no restriction
      (out as any)[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  };
  const nodes: Record<string, AgentConfig> = {};
  for (const [id, c] of Object.entries(t.nodes ?? {})) {
    const cleaned = cleanCfg(c);
    if (cleaned) nodes[id] = cleaned;
  }
  const result: GraphTuning = {};
  const defaults = cleanCfg(t.defaults);
  if (defaults) result.defaults = defaults;
  if (Object.keys(nodes).length) result.nodes = nodes;
  return result;
}
