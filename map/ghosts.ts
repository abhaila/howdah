/**
 * Ghost sets — system-map slice 1c ("Ghosts and drift", eng review D19/D20, SM-D8/7A keys).
 *
 * A `GhostSet` is the proposer's design for a slice, written in the map's own vocabulary: every id
 * is an identity key (`map/keys.ts`), so it can be checked against the base snapshot now and
 * against the after snapshot by drift later. It is proposed by `slice.propose` and checked here
 * BEFORE anyone sees it — the engine's `validateProposal` hook turns `{ ok: false, errors }` into
 * an attempt-failed reason that is fed back to the proposer, so every message says what is wrong
 * AND what to do instead.
 *
 * Rules (the doc's three, plus the ones that keep drift honest):
 *   - ids with op modify / remove / keep must exist in the base snapshot, and must not be
 *     AMBIGUOUS there (a shared key can never verify — drift would only ever say not-checked);
 *   - ids with op add must parse under the key grammar (`parseKey`), name the declared kind, and
 *     must not already exist;
 *   - every entity declares `expected_file` (D20): repo-relative, no `..`, a source file the map
 *     extracts, and for a TS key the file its module path implies — it is where drift looks for
 *     proof that an entity is `missing`;
 *   - edges `from→to:kind` join endpoints that exist (in the ghost set or the base) and have the
 *     kinds the edge kind implies; edges carry no content, so `modify` is meaningless for them;
 *   - trace steps are entity ids present in the ghost set or the base, at least two per trace.
 * `responsibility` and `names` are prose: shown, never verified, and labelled that way (1d).
 *
 * Comments pin to ghost ids (`comment-pinned.entity_id`); `orphanedComments` lists those whose
 * key a redraw dropped — they are shown as orphaned, never discarded.
 */

import { edgeKey, EDGE_KINDS, parseKey, tsModulePath, type ParsedKey } from "./keys";
import { familyOf, languageOf } from "./languages";
import type { AssembledMap, EdgeKind, EntityKind } from "./types";
import { cmpStr } from "./util";

export type Op = "add" | "modify" | "remove" | "keep";
export const OPS: readonly Op[] = ["add", "modify", "remove", "keep"];
export const GHOST_ENTITY_KINDS: readonly EntityKind[] = ["route", "function", "fetch-site"];

export interface GhostBlock {
  id: string;
  op: Op;
  plane?: string;
  /** Prose — shown, never verified. */
  responsibility: string;
}

export interface GhostEntity {
  id: string;
  op: Op;
  block: string;
  kind: EntityKind;
  /** Repo-relative path where the entity lives (or will live) — where drift searches for proof. */
  expected_file: string;
  /** Prose — shown, never verified. */
  names?: string[];
}

export interface GhostEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  op: Op;
}

export interface GhostTrace {
  scenario: string;
  /** Entity ids, in order. */
  steps: string[];
}

export interface GhostSet {
  blocks: GhostBlock[];
  entities: GhostEntity[];
  edges: GhostEdge[];
  trace: GhostTrace[];
}

export type GhostValidation = { ok: true; ghosts: GhostSet } | { ok: false; errors: string[] };

/** Enough errors to fix a bad draft in one round; more only floods the proposer's context. */
export const MAX_ERRORS = 40;

/** The kinds of endpoint each edge kind joins (import edges are block → block). */
const EDGE_ENDPOINTS: Record<EdgeKind, [EntityKind | "block", EntityKind | "block"]> = {
  import: ["block", "block"],
  call: ["function", "function"],
  "route-handler": ["route", "function"],
  "fe-be": ["fetch-site", "route"],
};

export function ghostEdgeId(e: Pick<GhostEdge, "from" | "to" | "kind">): string {
  return edgeKey(e.from, e.to, e.kind);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const q = (s: string) => JSON.stringify(s);

/**
 * Why `path` is not a usable repo-relative source path, or null. Exported so the drift / UI layers
 * can reuse the exact rule.
 */
export function expectedFileProblem(path: string): string | null {
  if (path.trim() === "") return "is empty";
  if (path !== path.trim()) return "has surrounding whitespace";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "must be repo-relative, not absolute";
  if (path.includes("\\")) return "must use forward slashes";
  const segs = path.split("/");
  if (segs.includes("..")) return "must not contain `..`";
  if (segs.some((s) => s === "" || s === ".")) return "must be a normalised path (no `./`, `//` or trailing `/`)";
  if (languageOf(path) === null) return "is not a source file the map extracts (.kt, .java, .ts, .tsx, .js, .jsx, .mts, .cts, .mjs, .cjs)";
  return null;
}

/** The TS module a parsed function key lives in, or null for a JVM key. */
function tsModuleOf(k: ParsedKey): string | null {
  if (k.kind === "function") return k.lang === "ts" ? k.module : null;
  if (k.kind === "fetch-site") return k.enclosing.lang === "ts" ? k.enclosing.module : null;
  return null;
}

function jvmKey(k: ParsedKey): boolean {
  return (k.kind === "function" && k.lang === "jvm") || (k.kind === "fetch-site" && k.enclosing.lang === "jvm");
}

class Errors {
  readonly list: string[] = [];
  private dropped = 0;
  add(msg: string): void {
    if (this.list.length < MAX_ERRORS) this.list.push(msg);
    else this.dropped++;
  }
  result(): string[] {
    return this.dropped === 0 ? this.list : [...this.list, `… and ${this.dropped} more error(s) — fix the ones above and resubmit`];
  }
}

function checkFields(errs: Errors, where: string, o: Record<string, unknown>, allowed: string[]): void {
  for (const k of Object.keys(o).sort()) if (!allowed.includes(k)) errs.add(`${where}: unknown field ${q(k)} (allowed: ${allowed.join(", ")})`);
}

function str(errs: Errors, where: string, o: Record<string, unknown>, field: string): string | undefined {
  const v = o[field];
  if (typeof v !== "string" || v.trim() === "") {
    errs.add(`${where}: ${q(field)} must be a non-empty string${v === undefined ? " (it is missing)" : ""}`);
    return undefined;
  }
  return v;
}

function op(errs: Errors, where: string, o: Record<string, unknown>): Op | undefined {
  const v = o.op;
  if (typeof v === "string" && (OPS as readonly string[]).includes(v)) return v as Op;
  errs.add(`${where}: "op" must be one of ${OPS.join(" | ")} (got ${JSON.stringify(v) ?? "nothing"})`);
  return undefined;
}

function ambiguityHint(base: AssembledMap, key: string): string {
  const where = base.entities.filter((e) => e.key === key).map((e) => e.evidence);
  return (
    `is ambiguous in the base snapshot (${where.length} entities share this key: ${where.join(", ")}), so drift can never verify it — ` +
    `leave it out of the ghost set and pin the change to something unambiguous next to it (its caller, its route or its fetch site)`
  );
}

/**
 * Validate an untrusted proposer output against the base snapshot. Hand-written (no schema
 * library): shape and type first, then the key rules. All errors are collected (up to
 * MAX_ERRORS), each prefixed with where it is (`entities[2] "…"`), so one round can fix them all.
 */
export function validateGhostSet(value: unknown, base: AssembledMap): GhostValidation {
  const errs = new Errors();
  if (!isObj(value)) return { ok: false, errors: ["the ghost set must be a JSON object with arrays: blocks, entities, edges, trace"] };
  checkFields(errs, "ghost set", value, ["blocks", "entities", "edges", "trace"]);
  const arr = (field: string): unknown[] => {
    const v = value[field];
    if (Array.isArray(v)) return v;
    errs.add(`ghost set: ${q(field)} must be an array${v === undefined ? " (use [] if there are none)" : ""}`);
    return [];
  };
  const rawBlocks = arr("blocks");
  const rawEntities = arr("entities");
  const rawEdges = arr("edges");
  const rawTrace = arr("trace");

  const baseEntities = new Map<string, { kind: EntityKind; ambiguous: boolean; file: string }>();
  for (const e of base.entities) {
    const prev = baseEntities.get(e.key);
    baseEntities.set(e.key, { kind: e.kind, ambiguous: prev !== undefined || e.ambiguous === true, file: e.file });
  }
  const baseBlocks = new Set(base.blocks.map((b) => b.key));
  const baseBlockFamily = new Map(base.blocks.map((b) => [b.key, b]));
  const baseFiles = new Map(base.files.map((f) => [f.path, f]));
  const removedBlocks = new Set<string>();
  /** A block's family: from the base snapshot, else from its key's grammar. */
  const blockFamily = (id: string): "jvm" | "ts" | null => {
    const b = baseBlockFamily.get(id);
    if (b !== undefined) return b.family;
    const p = parseKey(id);
    return p.ok && p.key.kind === "block" ? p.key.lang : null;
  };
  /** JVM add: the key's package must be the package of an existing expected_file. */
  const jvmPackageProblem = (k: ParsedKey, file: string): string | null => {
    const f = baseFiles.get(file);
    const pkg = f === undefined ? undefined : baseBlockFamily.get(f.block)?.package;
    const fnKey = k.kind === "function" ? k : k.kind === "fetch-site" ? k.enclosing : null;
    if (pkg === undefined || fnKey === null || fnKey.lang !== "jvm") return null;
    // top-level: the qualifier IS the package; members and extensions (`pkg.Cls.<ext R>.f()`) may add a class chain
    const ok = fnKey.scope === "top" ? fnKey.qualifier === pkg : pkg === "" || fnKey.qualifier === pkg || fnKey.qualifier.startsWith(`${pkg}.`);
    return ok ? null : `the key's package does not match ${q(file)}, which declares package ${q(pkg === "" ? "<default>" : pkg)} — a JVM key starts with its file's package`;
  };
  const baseEdges = new Map(base.edges.map((e) => [e.key, e]));

  // ── blocks ──
  const blocks: GhostBlock[] = [];
  const blockIds = new Set<string>();
  rawBlocks.forEach((raw, i) => {
    let where = `blocks[${i}]`;
    if (!isObj(raw)) return errs.add(`${where}: must be an object {id, op, responsibility, plane?}`);
    const id = str(errs, where, raw, "id");
    if (id !== undefined) where += ` ${q(id)}`;
    checkFields(errs, where, raw, ["id", "op", "plane", "responsibility"]);
    const o = op(errs, where, raw);
    const responsibility = str(errs, where, raw, "responsibility");
    const plane = raw.plane === undefined ? undefined : typeof raw.plane === "string" ? raw.plane : (errs.add(`${where}: "plane" must be a string`), undefined);
    if (id === undefined || o === undefined || responsibility === undefined) return;
    if (blockIds.has(id)) return errs.add(`${where}: duplicate block id — each block appears once`);
    blockIds.add(id);
    if (o === "remove") removedBlocks.add(id);
    if (o === "add") {
      const p = parseKey(id);
      if (!p.ok) errs.add(`${where}: op "add" needs a valid block key (${p.error}); JVM blocks look like ":api/com.example.api", TS blocks are the package.json dir ("web")`);
      else if (p.key.kind !== "block") errs.add(`${where}: ${q(id)} parses as a ${p.key.kind} key, not a block key`);
      else if (baseBlocks.has(id)) errs.add(`${where}: op "add" but the block already exists in the base snapshot — use "modify" or "keep"`);
    } else if (!baseBlocks.has(id)) {
      errs.add(`${where}: op ${q(o)} needs a block that exists in the base snapshot; ${q(id)} does not — use a block key from the map neighbourhood, or op "add" for a new block`);
    }
    blocks.push({ id, op: o, responsibility, ...(plane !== undefined ? { plane } : {}) });
  });

  // ── entities ──
  const entities: GhostEntity[] = [];
  const entityIds = new Map<string, GhostEntity>();
  const declared = new Map<string, { kind: EntityKind; removed: boolean }>();
  rawEntities.forEach((raw, i) => {
    let where = `entities[${i}]`;
    if (!isObj(raw)) return errs.add(`${where}: must be an object {id, op, block, kind, expected_file, names?}`);
    const id = str(errs, where, raw, "id");
    if (id !== undefined) where += ` ${q(id)}`;
    checkFields(errs, where, raw, ["id", "op", "block", "kind", "expected_file", "names"]);
    const o = op(errs, where, raw);
    const block = str(errs, where, raw, "block");
    const kindRaw = raw.kind;
    const kind = typeof kindRaw === "string" && (GHOST_ENTITY_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as EntityKind) : undefined;
    if (kind === undefined) errs.add(`${where}: "kind" must be one of ${GHOST_ENTITY_KINDS.join(" | ")} (got ${JSON.stringify(kindRaw) ?? "nothing"})`);
    let file: string | undefined;
    if (raw.expected_file === undefined) errs.add(`${where}: "expected_file" is required (D20) — the repo-relative file this entity lives in, or will live in`);
    else if (typeof raw.expected_file !== "string") errs.add(`${where}: "expected_file" must be a string`);
    else {
      const problem = expectedFileProblem(raw.expected_file);
      if (problem !== null) errs.add(`${where}: expected_file ${q(raw.expected_file)} ${problem}`);
      else file = raw.expected_file;
    }
    let names: string[] | undefined;
    if (raw.names !== undefined) {
      if (Array.isArray(raw.names) && raw.names.every((n) => typeof n === "string")) names = raw.names as string[];
      else errs.add(`${where}: "names" must be an array of strings`);
    }
    // a declared id is known to edges / trace even when another field is wrong: one mistake, one error
    if (id !== undefined && kind !== undefined && !declared.has(id)) declared.set(id, { kind, removed: o === "remove" });
    if (id === undefined || o === undefined || block === undefined || kind === undefined || file === undefined) return;
    if (entityIds.has(id)) return errs.add(`${where}: duplicate entity id — each entity appears once`);

    if (!blockIds.has(block) && !baseBlocks.has(block)) {
      errs.add(`${where}: block ${q(block)} is neither in the base snapshot nor declared in blocks[] — use an existing block key, or add the block with op "add"`);
    } else {
      const lang = languageOf(file);
      const fileFamily = lang === null ? null : familyOf(lang);
      const bf = blockFamily(block);
      const inBase = baseFiles.get(file);
      if (bf !== null && fileFamily !== null && bf !== fileFamily) {
        errs.add(`${where}: block ${q(block)} is a ${bf === "jvm" ? "JVM (Gradle project/package)" : "TS (package.json dir)"} block, but expected_file ${q(file)} is a ${fileFamily === "jvm" ? "Kotlin/Java" : "TS/JS"} file`);
      } else if (inBase !== undefined && inBase.block !== block) {
        errs.add(`${where}: expected_file ${q(file)} is in block ${q(inBase.block)} in the base snapshot, not ${q(block)} — use that block, or a different file`);
      }
    }
    const existing = baseEntities.get(id);
    if (o === "add") {
      const p = parseKey(id);
      if (!p.ok) errs.add(`${where}: op "add" needs an id in the identity-key grammar (${p.error})`);
      else if (p.key.kind !== kind) errs.add(`${where}: the id parses as a ${p.key.kind} key but "kind" says ${kind}`);
      else {
        const lang = languageOf(file);
        const family = lang === null ? null : familyOf(lang);
        const mod = tsModuleOf(p.key);
        if (jvmKey(p.key) && family === "ts") errs.add(`${where}: a JVM function key cannot live in ${q(file)} (a TS/JS file)`);
        if (mod !== null && family === "jvm") errs.add(`${where}: a TS function key (module#name) cannot live in ${q(file)} (a JVM file)`);
        else if (mod !== null && mod !== tsModulePath(file)) {
          errs.add(`${where}: the key's module ${q(mod)} implies file ${mod}.ts/.tsx/…, but expected_file is ${q(file)} — make them agree`);
        }
        const pkgProblem = jvmPackageProblem(p.key, file);
        if (pkgProblem !== null) errs.add(`${where}: ${pkgProblem}`);
      }
      if (existing !== undefined) errs.add(`${where}: op "add" but this key already exists in the base snapshot (${existing.file}) — use "modify" or "keep", or pick the new key`);
    } else if (existing === undefined) {
      errs.add(`${where}: op ${q(o)} needs an entity that exists in the base snapshot, and this key does not — copy the exact key from the map neighbourhood, or use op "add" for a new entity`);
    } else if (existing.ambiguous) {
      errs.add(`${where}: ${ambiguityHint(base, id)}`);
    } else if (existing.kind !== kind) {
      errs.add(`${where}: "kind" says ${kind} but the base snapshot has this key as a ${existing.kind}`);
    } else if (o === "keep" && existing.file !== file) {
      errs.add(`${where}: op "keep" but the base snapshot has this entity in ${q(existing.file)} — set expected_file to ${q(existing.file)} (keep means it stays where it is)`);
    }
    const g: GhostEntity = { id, op: o, block, kind, expected_file: file, ...(names !== undefined ? { names } : {}) };
    entityIds.set(id, g);
    entities.push(g);
  });

  /** An id's kind as the ghost set or base knows it (ghost wins), or null when unknown. */
  const kindOf = (id: string): EntityKind | "block" | null => declared.get(id)?.kind ?? baseEntities.get(id)?.kind ?? (blockIds.has(id) || baseBlocks.has(id) ? "block" : null);

  // ── edges ──
  const edges: GhostEdge[] = [];
  const edgeIds = new Set<string>();
  rawEdges.forEach((raw, i) => {
    let where = `edges[${i}]`;
    if (!isObj(raw)) return errs.add(`${where}: must be an object {from, to, kind, op}`);
    checkFields(errs, where, raw, ["from", "to", "kind", "op"]);
    const from = str(errs, where, raw, "from");
    const to = str(errs, where, raw, "to");
    const kindRaw = raw.kind;
    const kind = typeof kindRaw === "string" && (EDGE_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as EdgeKind) : undefined;
    if (kind === undefined) errs.add(`${where}: "kind" must be one of ${EDGE_KINDS.join(" | ")} (got ${JSON.stringify(kindRaw) ?? "nothing"})`);
    const o = op(errs, where, raw);
    if (from === undefined || to === undefined || kind === undefined || o === undefined) return;
    const id = ghostEdgeId({ from, to, kind });
    where += ` ${q(id)}`;
    if (edgeIds.has(id)) return errs.add(`${where}: duplicate edge — each edge appears once`);
    edgeIds.add(id);
    const p = parseKey(id);
    if (!p.ok) errs.add(`${where}: not a valid edge key (${p.error})`);
    if (from === to) errs.add(`${where}: an edge must join two different ids`);
    const [wantFrom, wantTo] = EDGE_ENDPOINTS[kind];
    for (const [end, id2, want] of [["from", from, wantFrom], ["to", to, wantTo]] as const) {
      const k = kindOf(id2);
      if (k === null) errs.add(`${where}: ${end} ${q(id2)} is not a block or entity in the ghost set or the base snapshot — declare it in ${want === "block" ? "blocks" : "entities"}[] first`);
      else if (k !== want) errs.add(`${where}: a ${kind} edge goes ${wantFrom} → ${wantTo}, but ${end} ${q(id2)} is a ${k}`);
    }
    if (o === "modify") errs.add(`${where}: edges have no content to modify — use "add", "remove" or "keep"`);
    if (o === "add" || o === "keep") {
      for (const end of [from, to]) {
        if (declared.get(end)?.removed === true || removedBlocks.has(end)) errs.add(`${where}: op ${q(o)} but ${q(end)} is removed by this ghost set — an edge cannot survive its endpoint; use "remove" or drop the edge`);
      }
    }
    const inBase = baseEdges.get(id);
    if (o === "add" && inBase !== undefined) errs.add(`${where}: op "add" but the base snapshot already has this edge — use "keep"`);
    if ((o === "remove" || o === "keep") && inBase === undefined) {
      errs.add(`${where}: op ${q(o)} needs an edge the base snapshot has, and it does not (edge extraction is conservative) — omit it, or use "add" if it is a new dependency`);
    }
    if ((o === "remove" || o === "keep") && inBase?.ambiguous === true) errs.add(`${where}: an endpoint of this edge is ambiguous in the base snapshot, so it can never verify — leave the edge out`);
    edges.push({ from, to, kind, op: o });
  });

  // ── trace ──
  const trace: GhostTrace[] = [];
  rawTrace.forEach((raw, i) => {
    let where = `trace[${i}]`;
    if (!isObj(raw)) return errs.add(`${where}: must be an object {scenario, steps}`);
    checkFields(errs, where, raw, ["scenario", "steps"]);
    const scenario = str(errs, where, raw, "scenario");
    if (scenario !== undefined) where += ` ${q(scenario)}`;
    if (!Array.isArray(raw.steps) || !raw.steps.every((s) => typeof s === "string")) return errs.add(`${where}: "steps" must be an array of entity ids (strings), in order`);
    const steps = raw.steps as string[];
    if (steps.length < 2) errs.add(`${where}: a trace needs at least two steps (it is verified edge by edge)`);
    steps.forEach((s, j) => {
      const g = declared.get(s);
      if (g === undefined && !baseEntities.has(s)) errs.add(`${where}: steps[${j}] ${q(s)} is not an entity in the ghost set or the base snapshot — add it to entities[] or use an existing key`);
      else if (g?.removed === true) errs.add(`${where}: steps[${j}] ${q(s)} is removed by this ghost set, so no trace can pass through it`);
    });
    if (scenario === undefined) return;
    trace.push({ scenario, steps });
  });

  if (errs.list.length === 0 && blocks.length === 0 && entities.length === 0 && edges.length === 0) {
    errs.add("the ghost set proposes nothing — declare at least one block, entity or edge");
  }
  const errors = errs.result();
  return errors.length > 0 ? { ok: false, errors } : { ok: true, ghosts: { blocks, entities, edges, trace } };
}

/** Every id a comment can be pinned to: block, entity and edge (`from→to:kind`) ids, sorted. */
export function ghostEntityIds(g: GhostSet): string[] {
  const ids = new Set<string>([...g.blocks.map((b) => b.id), ...g.entities.map((e) => e.id), ...g.edges.map(ghostEdgeId)]);
  return [...ids].sort(cmpStr);
}

/**
 * Comments whose pinned key a redraw no longer contains. They are shown as orphaned, never
 * dropped (1c "Comments across redraws"); input order is kept.
 */
export function orphanedComments<C extends { entity_id: string }>(comments: readonly C[], ghosts: GhostSet): C[] {
  const ids = new Set(ghostEntityIds(ghosts));
  return comments.filter((c) => !ids.has(c.entity_id));
}
