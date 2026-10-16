/**
 * The drafter's catalog (HOW-56 T4, decision 2A) — what an agent drafting a graph may use,
 * computed from the live tables so a new built-in appears here automatically. Node-free on
 * purpose: core/graph-spec.ts (which the browser bundles) reads GRAPHS_CATALOG_PRODUCES, and
 * a graph never imports an executor.
 *
 * The drafter reads this value, sees the ids and shapes it can draw from, and writes a draft.
 * It carries PROMPT IDS only, never bodies: a drafter asking for a specific body in a repair
 * turn is fine, dumping all of them into one step's context is not — and the drafter's base
 * prompts are already pinned next to its own instructions.
 *
 * Shape: the result is JSON, so array order IS defined and sorted output is DETERMINISTIC —
 * two runs over the same registry publish the same value, which is what rendered_hash and
 * reconstructRender rely on.
 */

import type { GraphSpec } from "./graph-spec";

export const GRAPHS_CATALOG_BUILTIN = "graphs:catalog";
export const GRAPHS_CATALOG_KEY = "graphs.catalog";
export const GRAPHS_CATALOG_PRODUCES = [GRAPHS_CATALOG_KEY] as const;

/**
 * The context cap `graphs:catalog` trims to by default (render v2's contextCap default,
 * core/template.ts) — matches the per-step `agentConfig.contextCap` the engine passes when
 * the operator has not set one. 64k is enough to carry every built-in spec Howdah ships
 * today with room to spare; the omitted path is defensive.
 */
export const GRAPHS_CATALOG_DEFAULT_CAP = 64000;

export interface CatalogGraphEntry {
  /** the graph's name (its registry key) */
  name: string;
  /** the GraphSpec a drafter may stack on. Builder-readable only; see `broken` for the rest. */
  spec: GraphSpec;
  /** every prompt id the spec names (its agent steps' `prompt`), sorted — bodies are elsewhere */
  promptIds: string[];
}

export interface CatalogBrokenEntry {
  name: string;
  /** why the graph did not load, in the operator's terms — the same sentence the launcher shows */
  reason: string;
}

export interface GraphsCatalog {
  /** every kind a `NodeSpec` can have (NODE_KINDS); the drafter picks from these */
  nodeKinds: string[];
  /** every kind a `FieldSpec` can have (FIELD_KINDS); the drafter sets one per declared field */
  fieldKinds: string[];
  /**
   * The command built-ins the drafter may use, with their contracts. The row for
   * `runs:launch` is excluded here: a drafted graph may not fan out runs (draftRuleProblems),
   * so offering it would mislead the drafter about the shape it can propose.
   * `graphs:catalog` itself is included — a drafter never needs to call it, but the row IS
   * the drafter's declaration of what the built-ins look like.
   */
  commandBuiltins: Array<{ run: string; label: string; produces: readonly string[]; reads?: readonly string[] }>;
  /** every builder-readable graph in the registry, with its spec and its prompt ids. Sorted. */
  graphs: CatalogGraphEntry[];
  /**
   * Every name already claimed, built-in, local AND broken. The drafter picks a NEW name,
   * and `nameTakenProblem` quotes this to say which ones are taken.
   */
  takenNames: string[];
  /** every local graph that would not load, with its reason — the drafter cannot stack on one */
  broken: CatalogBrokenEntry[];
  /**
   * When the full catalog would overflow the per-step context cap, the LARGEST specs are
   * dropped one by one until the result fits, and each dropped name goes here with a sentence
   * saying why. Absent when nothing was dropped. Never silently truncated.
   */
  omitted?: string[];
}
