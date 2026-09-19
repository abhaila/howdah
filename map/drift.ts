/**
 * Drift — system-map slice 1c (eng review D19/19A, D20, D21). Deterministic, base vs after: an LLM
 * may only EXPLAIN a drift report, never compute one. The rule throughout is the map's precision
 * promise: a claim (`verified`, `missing`, `unexpected`) is made only with PROOF on both sides;
 * anything the map cannot see is `not-checked (reason)`, never a guess shown as fact.
 *
 * | Ghost op | `verified` when                                          | otherwise                          |
 * |----------|----------------------------------------------------------|------------------------------------|
 * | add      | absence in base PROVEN, present after (where expected)   | `missing` (only with proof)        |
 * | modify   | present in both, content hash changed (where expected)   | `unchanged`; gone → missing*       |
 * | remove   | present in base, absence after PROVEN                    | `still-present`                    |
 * | keep     | present in both, content hash unchanged (where expected) | `changed-unexpectedly`; gone → missing* |
 *
 * "Present" = exactly one entity with the key, not ambiguous, at tier ≥ syntactic. An ambiguous key
 * on either side is `not-checked (ambiguous)`. "Where expected": an entity that exists but LANDED
 * in another file or block than the ghost declared is `not-checked (landed at …)`, never verified.
 * The content hash is the normalised token stream (`contentHash()` in ast.ts), so whitespace and
 * comment edits are not changes.
 *
 * ABSENCE NEEDS PROOF (D20) — for `missing`, a `remove`'s "absent after", and an `add`'s "absent
 * in base" alike. It is proven for the files the entity could be in (the ghost's `expected_file`,
 * plus for an existing entity the file(s) the base had it in) only when every one of them is:
 *   - not skipped, not `not-checked`, not git-ignored on disk (`ignoredOnDisk`), no unparsed region;
 *   - for a route / fetch-site, searched with `full` coverage by EVERY adapter covering that kind
 *     for the file's language (none covering it at all is itself a reason);
 *   - or absent from the snapshot altogether (never created, deleted, or git-ignored and not
 *     declared so) — nothing can hide in a file that is not there;
 * AND no NEAR MATCH exists — something the map keys differently that may be the same thing:
 *   - (functions) a function, declaration or local of the same simple name in those files;
 *   - (routes) a route anywhere whose mount prefix is unknown (`{*}/…`) and whose known tail aligns;
 *   - (fetch sites) a fetch site in the same enclosing function, or one in those files whose
 *     template has `{*}` and aligns with the ghost's.
 * Base-side proofs ("absent in base") use the route / `{*}`-fetch rules only: a same-named
 * sibling in base (an overload being added) is normal and must not block `verified`.
 *
 * FUNCTION COVERAGE. No adapter declares function coverage; functions come from the language
 * visitors (facts.ts), which KEY: Kotlin/Java top-level, member, nested-class, companion and
 * extension functions and Java constructors; TS function declarations, `const f = () => …` /
 * function-expression bindings, class methods and function-valued class fields. Forms NOT keyed
 * but RECORDED as names, so they are near matches (`not-checked (possible match)`), never
 * `missing`: Kotlin properties (`val x: HttpHandler = routes(…)`), local functions and anonymous
 * object members; Java fields (`Runnable handler = () -> …`) and anonymous-class methods; TS
 * top-level value bindings (incl. destructured), their object-literal members (one level),
 * class fields holding values (`handler = debounce(fn)`), namespaces and their members,
 * `export default <expression>` (as `default`), and functions nested in function bodies.
 * NOT recorded at all — a `missing` there is only as good as the ghost's key: object-literal
 * members below the first level (`api.users.get`; the outer binding `api` is recorded),
 * computed member names, re-exports from other modules, and runtime assignments
 * (`module.exports.x = …`, `obj[k] = fn`).
 *
 * EDGES are the syntactic tier and deliberately LOW RECALL: a lambda, a new local or extension of
 * the same name, a second candidate, a supertype, a `::ref` becoming a lambda, a join going
 * unresolved — all make an edge invisible without removing the dependency. So an absent edge is
 * never evidence: add/keep edges are `verified` when observed after, else `not-checked` — NEVER
 * `missing` — and a `remove` edge is `verified` ONLY when one of its endpoints is proven gone
 * (absence proven as above over the files it was in; a block endpoint gone per the block rule).
 *
 * BLOCKS derive from the files in them. An existing block is gone when none of its base files —
 * and no file in their directories — is skipped / not-checked after; a new block is verified only
 * when its after files were fully searched in base; `modify` is verified only by at least one
 * PROVEN entity change in the block (as for `unexpected`), `not-checked` when changes are only
 * unproven, `unchanged` when there are none.
 *
 * `unexpected`: a PROVEN add / removal / content change between base and after with no entity
 * ghost for its key, SCOPED to what the ghost set touches (files named by `expected_file` or
 * holding a ghosted entity, plus every block the ghost set names and those files' blocks) — churn
 * elsewhere would flood the report. An unproven one is `not-checked` with `op: null`.
 *
 * Traces: `verified` when every consecutive step pair is an observed link (an edge of any kind, or
 * a fetch site inside its enclosing function), `partial` when some are, `not-checked` when none
 * are or when any step's file was not fully covered.
 *
 * EXTRACTOR VERSION: hashes, keys, coverage and `declarations` are functions of it, so when base
 * and after were extracted by different versions (`sameExtractor`), every ghost item is
 * `not-checked (re-extract base)` and no `unexpected` is claimed.
 *
 * The report is capped (DRIFT_CAP items, `truncated` counts the rest), ordered worst outcome
 * first so a truncated report still carries the problems; `counts` covers every item. `commit`
 * is the after snapshot's commit — what "verified" refers to (D21).
 */

import { GHOST_ENTITY_KINDS, ghostEdgeId, type GhostEdge, type GhostEntity, type GhostSet, type GhostTrace, type Op } from "./ghosts";
import { parseKey } from "./keys";
import { languageOf } from "./languages";
import { routeMatch } from "./neighbourhood";
import type { AssembledMap, Block, Edge, EntityKind, Entity, FileCoverage, Join } from "./types";
import { cmpStr, tierAtLeast } from "./util";

export type DriftOutcome = "verified" | "missing" | "not-checked" | "unchanged" | "still-present" | "changed-unexpectedly" | "unexpected" | "partial";

/** Worst first — the report order, so truncation drops verified items before problems. */
export const DRIFT_OUTCOMES: readonly DriftOutcome[] = ["missing", "changed-unexpectedly", "still-present", "unchanged", "unexpected", "partial", "not-checked", "verified"];

export type DriftSubject = "block" | EntityKind | "edge" | "trace";
const SUBJECT_ORDER: readonly DriftSubject[] = ["block", "route", "function", "fetch-site", "edge", "trace"];

export interface DriftItem {
  /** Identity key (edges: `from→to:kind`; traces: the scenario). */
  key: string;
  kind: DriftSubject;
  /** The ghost's op; null for traces and `unexpected` entities (no ghost). */
  op: Op | null;
  outcome: DriftOutcome;
  reason?: string;
  /** `file:line` in the after snapshot when present there, else in the base. */
  evidence?: string;
}

export interface DriftReport {
  /** The after snapshot's commit — the commit every `verified` refers to (D21). */
  commit: string | null;
  baseCommit: string | null;
  manifestHash: string;
  baseManifestHash: string;
  items: DriftItem[];
  /** Items beyond the cap, not listed (still counted in `counts`). */
  truncated: number;
  counts: Record<DriftOutcome, number>;
}

export interface DriftOptions {
  /** Items listed (default DRIFT_CAP). */
  cap?: number;
  /**
   * Repo-relative paths the caller found on disk but git-ignored (so never extracted). A ghost
   * whose file is one of these is `not-checked (git-ignored)`, never `missing`.
   */
  ignoredOnDisk?: readonly string[];
}

export const DRIFT_CAP = 200;
/** Reasons quote at most this many sub-reasons (partial-coverage lines, evidence sites). */
const MAX_QUOTED = 3;

const uniqSorted = (xs: readonly string[]) => [...new Set(xs)].sort(cmpStr);
const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));

function quote(list: string[]): string {
  const shown = list.slice(0, MAX_QUOTED).join("; ");
  return list.length > MAX_QUOTED ? `${shown}; … ${list.length - MAX_QUOTED} more` : shown;
}

// ── snapshot index ──────────────────────────────────────────────────────────

type Search = { ok: true; note: string } | { ok: false; reason: string };

class Snapshot {
  readonly entities = new Map<string, Entity[]>();
  readonly edges = new Map<string, Edge>();
  readonly blocks = new Map<string, Block>();
  readonly files = new Map<string, AssembledMap["files"][number]>();
  readonly skipped = new Map<string, string>();
  readonly notChecked = new Map<string, string>();
  readonly unparsed = new Map<string, AssembledMap["unparsed"]>();
  readonly coverage = new Map<string, FileCoverage>();
  readonly joins = new Map<string, Join>();

  constructor(
    readonly map: AssembledMap,
    readonly side: "base" | "after",
    private readonly ignored: ReadonlySet<string> = new Set(),
  ) {
    for (const e of map.entities) this.entities.set(e.key, [...(this.entities.get(e.key) ?? []), e]);
    for (const e of map.edges) this.edges.set(e.key, e);
    for (const b of map.blocks) this.blocks.set(b.key, b);
    for (const f of map.files) this.files.set(f.path, f);
    for (const s of map.skipped) this.skipped.set(s.path, s.reason);
    for (const n of map.notChecked) this.notChecked.set(n.path, n.reason);
    for (const u of map.unparsed) this.unparsed.set(u.file, [...(this.unparsed.get(u.file) ?? []), u]);
    for (const c of map.coverage) this.coverage.set(`${c.file}\0${c.adapter}`, c);
    for (const j of map.joins) this.joins.set(j.fetchSite, j);
  }

  /** Skipped / not-checked paths, with why. */
  unextracted(): { path: string; reason: string }[] {
    return [...[...this.skipped].map(([path, r]) => ({ path, reason: `skipped: ${r}` })), ...[...this.notChecked].map(([path, r]) => ({ path, reason: `not checked: ${r}` }))];
  }

  /** The one entity with `key`, or why there is not exactly one usable one. */
  lookup(key: string): { entity: Entity } | { absent: true } | { reason: string } {
    const list = this.entities.get(key) ?? [];
    if (list.length === 0) return { absent: true };
    const first = list[0];
    if (list.length > 1 || first === undefined || first.ambiguous === true) {
      return { reason: `ambiguous in the ${this.side} snapshot: ${list.length} entities share this key (${quote(list.map((e) => e.evidence))})` };
    }
    if (!tierAtLeast(first.tier, "syntactic")) return { reason: `present in the ${this.side} snapshot only at tier ${first.tier} (below syntactic) — ${first.evidence}` };
    return { entity: first };
  }

  /** Was `path` searched well enough that `kind` being absent from it is PROOF (D20)? */
  private searched(path: string, kind: EntityKind | "any"): { ok: true; absent: boolean } | { ok: false; reason: string } {
    const skip = this.skipped.get(path);
    if (skip !== undefined) return { ok: false, reason: `${path} was skipped (${skip})` };
    const nc = this.notChecked.get(path);
    if (nc !== undefined) return { ok: false, reason: `${path} was not checked (${nc})` };
    const present = this.files.has(path);
    if (!present && this.ignored.has(path)) return { ok: false, reason: `${path} is git-ignored on disk, so it was never extracted` };
    const lang = this.files.get(path)?.language ?? languageOf(path);
    if (lang === null) return { ok: false, reason: `${path} is not a language the map extracts` };
    if (kind === "route" || kind === "fetch-site") {
      const adapters = this.map.adapters.filter((a) => a.covers.includes(kind) && a.languages.includes(lang));
      if (adapters.length === 0) return { ok: false, reason: `no adapter covers ${kind}s in ${lang} files, so ${path} cannot prove one absent` };
      if (!present) return { ok: true, absent: true };
      for (const a of adapters) {
        const c = this.coverage.get(`${path}\0${a.name}`);
        if (c === undefined) return { ok: false, reason: `adapter ${a.name} reported no coverage for ${path}` };
        if (c.status !== "full") return { ok: false, reason: `partial ${a.name} coverage of ${path}: ${quote(c.reasons.map((r) => `${r.reason} (${r.evidence})`))}` };
      }
    }
    if (!present) return { ok: true, absent: true };
    const regions = this.unparsed.get(path) ?? [];
    if (regions.length > 0) return { ok: false, reason: `${path} has unparsed region(s) at ${quote(regions.map((u) => (u.startLine === u.endLine ? `line ${u.startLine}` : `lines ${u.startLine}-${u.endLine}`)))}` };
    return { ok: true, absent: false };
  }

  /** Every file in `paths` searched for `kind` well enough that absence there is proof — or the first reason not. */
  fullySearched(paths: readonly string[], kind: EntityKind | "any"): Search {
    const notes: string[] = [];
    for (const p of uniqSorted(paths)) {
      const s = this.searched(p, kind);
      if (!s.ok) return s;
      notes.push(s.absent ? `${p} is not in the ${this.side} snapshot (never created, deleted, or git-ignored)` : `searched ${p} with full coverage`);
    }
    return { ok: true, note: notes.join("; ") };
  }

  /**
   * Things this snapshot keys differently that may be `key` (see the header). `sameName` adds the
   * function same-simple-name rule and the same-enclosing fetch rule (after-side absence proofs).
   */
  nearMatches(key: string, files: readonly string[], sameName: boolean): string[] {
    const p = parseKey(key);
    if (!p.ok) return [];
    const k = p.key;
    const fileSet = new Set(files);
    const out = new Set<string>();
    const meet = (a: string, b: string) => a === b || a === "*" || b === "*";
    if (sameName && k.kind === "function") {
      const names = new Set(k.lang === "jvm" ? [k.name] : [k.name, ...(k.member !== undefined ? [k.member] : [])]);
      for (const e of this.map.entities) if (e.key !== key && fileSet.has(e.file) && names.has(e.name)) out.add(`${e.kind} ${e.key} @ ${e.evidence}`);
      for (const d of this.map.declarations ?? []) if (fileSet.has(d.file) && names.has(d.name)) out.add(`${d.kind} ${[...d.container, d.name].join(".")} @ ${d.evidence}`);
      for (const n of this.map.names) if (fileSet.has(n.file) && names.has(n.name)) out.add(`local ${n.name} @ ${n.file}:${n.line}`);
    }
    if (k.kind === "route") {
      for (const e of this.map.entities) {
        if (e.key === key || e.route === undefined || !e.route.template.startsWith("{*}") || !meet(k.method, e.route.method)) continue;
        if (routeMatch(k.template, e.route.template, false) !== null) out.add(`route ${e.key} @ ${e.evidence} (its mount prefix is unknown)`);
      }
    }
    if (k.kind === "fetch-site") {
      const enclosing = key.slice(0, key.length - `|${k.method} ${k.template}`.length);
      for (const e of this.map.entities) {
        if (e.key === key || e.fetch === undefined || !meet(k.method, e.fetch.method)) continue;
        const sameFn = sameName && e.fetch.enclosing === enclosing;
        const aligned = fileSet.has(e.file) && e.fetch.template.includes("{*}") && routeMatch(k.template, e.fetch.template, true) !== null;
        if (sameFn || aligned) out.add(`fetch-site ${e.key} @ ${e.evidence}`);
      }
    }
    return [...out].sort(cmpStr);
  }

  /** Proof that `key` (of `kind`) is absent from every file in `files`: full search AND no near match. */
  absence(key: string, kind: EntityKind, files: readonly string[], sameName: boolean): Search {
    const s = this.fullySearched(files, kind);
    if (!s.ok) return s;
    const near = this.nearMatches(key, files, sameName);
    if (near.length > 0) return { ok: false, reason: `a possible match exists in a form the map keys differently: ${quote(near)}` };
    return s;
  }
}

// ── proven entity changes (shared by `unexpected` and block `modify`) ──────────

type Change = { key: string; kind: EntityKind; evidence: string } & ({ proven: true; what: "added" | "removed" | "content changed" | "content changed (ambiguous key)" } | { proven: false; why: string });

function changeOf(key: string, base: Snapshot, after: Snapshot): Change | null {
  const b = base.entities.get(key) ?? [];
  const a = after.entities.get(key) ?? [];
  const first = a[0] ?? b[0];
  if (first === undefined) return null;
  const at = { key, kind: first.kind, evidence: first.evidence };
  if (b.length === 0) {
    const p = base.absence(key, first.kind, a.map((e) => e.file), false);
    return p.ok ? { ...at, proven: true, what: "added" } : { ...at, proven: false, why: `present after, but absence in the base snapshot is not proven: ${p.reason}` };
  }
  if (a.length === 0) {
    const p = after.absence(key, first.kind, b.map((e) => e.file), true);
    return p.ok ? { ...at, proven: true, what: "removed" } : { ...at, proven: false, why: `was in the base snapshot and is not seen after, but absence is not proven: ${p.reason}` };
  }
  const hashes = (l: Entity[]) => l.map((e) => e.contentHash).sort(cmpStr).join(",");
  if (hashes(a) === hashes(b)) return null;
  if (a.length > 1 || b.length > 1) {
    // an ambiguous key: instances that appear or vanish need the same proof as any add / removal
    // Every file that held an instance on EITHER side is checked on BOTH sides: an instance can
    // vanish from (or appear in) a file that still holds another, and an unparsed region there
    // would otherwise go unexamined.
    const files = [...new Set([...a.map((e) => e.file), ...b.map((e) => e.file)])].sort(cmpStr);
    const pa = after.fullySearched(files, first.kind);
    if (!pa.ok) return { ...at, proven: false, why: `an instance of this ambiguous key is not seen after, but its absence is not proven: ${pa.reason}` };
    const pb = base.fullySearched(files, first.kind);
    if (!pb.ok) return { ...at, proven: false, why: `an instance of this ambiguous key is new after, but its absence in the base snapshot is not proven: ${pb.reason}` };
    return { ...at, proven: true, what: "content changed (ambiguous key)" };
  }
  return { ...at, proven: true, what: "content changed" };
}

// ── per-ghost outcomes ──────────────────────────────────────────────────────

function entityItem(g: GhostEntity, base: Snapshot, after: Snapshot): DriftItem {
  const item = (outcome: DriftOutcome, extra: { reason?: string; evidence?: string } = {}): DriftItem => ({ key: g.id, kind: g.kind, op: g.op, outcome, ...extra });
  const b = base.lookup(g.id);
  const a = after.lookup(g.id);
  if ("reason" in b) return item("not-checked", { reason: b.reason });
  if ("reason" in a) return item("not-checked", { reason: a.reason });
  const be = "entity" in b ? b.entity : undefined;
  const ae = "entity" in a ? a.entity : undefined;
  const files = [g.expected_file, ...(be !== undefined ? [be.file] : [])];
  const at = be !== undefined ? { evidence: be.evidence } : {};

  /** Absent after: `proven` if the absence is proven, else not-checked with the reason. */
  const absent = (proven: DriftOutcome, what: string): DriftItem => {
    const p = after.absence(g.id, g.kind, files, true);
    return p.ok ? item(proven, { reason: `${what}; ${p.note}`, ...at }) : item("not-checked", { reason: `${what}, but absence is not proven: ${p.reason}`, ...at });
  };
  /** Verified only where the ghost said it would be. */
  const verified = (e: Entity): DriftItem => {
    if (e.file === g.expected_file && e.block === g.block) return item("verified", { evidence: e.evidence });
    return item("not-checked", { reason: `landed at ${e.evidence} in block ${e.block}, not in ${g.expected_file} / block ${g.block} as proposed`, evidence: e.evidence });
  };

  if (g.op === "add") {
    if (be !== undefined) return item("not-checked", { reason: "already present in the base snapshot — an add cannot be told apart from a keep", evidence: be.evidence });
    if (ae !== undefined) {
      const p = base.absence(g.id, g.kind, [g.expected_file, ae.file], false);
      if (!p.ok) return item("not-checked", { reason: `present after, but absence in the base snapshot is not proven: ${p.reason}`, evidence: ae.evidence });
      return verified(ae);
    }
    return absent("missing", "not found in the after snapshot");
  }
  if (be === undefined) return item("not-checked", { reason: `not in the base snapshot, so op ${g.op} has nothing to compare against` });
  if (g.op === "remove") {
    if (ae !== undefined) return item("still-present", { evidence: ae.evidence });
    return absent("verified", "absent from the after snapshot");
  }
  if (ae === undefined) return absent("missing", "was in the base snapshot, not found in the after snapshot");
  const changed = ae.contentHash !== be.contentHash;
  if (g.op === "modify") return changed ? verified(ae) : item("unchanged", { reason: "content hash is the same as in the base snapshot (whitespace and comments are ignored)", evidence: ae.evidence });
  return changed ? item("changed-unexpectedly", { reason: "content hash differs from the base snapshot", evidence: ae.evidence }) : verified(ae);
}

const CONSERVATIVE = "edge extraction is conservative (lambdas, shadowing, overloads, supertypes and unresolved joins produce no edge), so an unobserved edge is not evidence of absence";

function joinNote(after: Snapshot, e: GhostEdge): string {
  if (e.kind !== "fe-be") return "";
  const j = after.joins.get(e.from);
  if (j === undefined) return "";
  if (j.status === "pattern-match") return `; the join is pattern-match (${j.candidates.length} candidates: ${quote(j.candidates)})`;
  if (j.status === "unresolved") return `; the join is unresolved (${j.reason ?? "no reason given"})`;
  return `; the join is exact to ${j.candidates[0] ?? "?"}`;
}

/** Why block `bb` (from base) may still hold files unseen in `after`, or null when its absence is proven. */
function blockGoneProblem(bb: Block, after: Snapshot): string | null {
  const files = new Set(bb.files);
  const dirs = new Set(bb.files.map(dirOf));
  for (const x of after.unextracted()) {
    if (files.has(x.path)) return `${x.path} was not extracted (${x.reason})`;
    if (dirs.has(dirOf(x.path))) return `${x.path}, in the block's directory, was not extracted (${x.reason})`;
  }
  return null;
}

/** Proof that edge endpoint `id` is gone from the after snapshot, or null. */
function endpointGone(id: string, base: Snapshot, after: Snapshot): string | null {
  const was = base.entities.get(id) ?? [];
  const first = was[0];
  if (first !== undefined) {
    if ((after.entities.get(id) ?? []).length > 0) return null;
    const p = after.absence(id, first.kind, was.map((e) => e.file), true);
    return p.ok ? p.note : null;
  }
  const bb = base.blocks.get(id);
  if (bb !== undefined && !after.blocks.has(id) && blockGoneProblem(bb, after) === null) return `no file of the after snapshot is in block ${id}`;
  return null;
}

function edgeItem(g: GhostEdge, base: Snapshot, after: Snapshot): DriftItem {
  const key = ghostEdgeId(g);
  const item = (outcome: DriftOutcome, extra: { reason?: string; evidence?: string } = {}): DriftItem => ({ key, kind: "edge", op: g.op, outcome, ...extra });
  const ae = after.edges.get(key);
  const be = base.edges.get(key);
  for (const s of [base, after]) {
    for (const end of [g.from, g.to]) {
      const l = s.entities.get(end) ?? [];
      if (l.length > 1 || l[0]?.ambiguous === true) return item("not-checked", { reason: `endpoint ${end} is ambiguous in the ${s.side} snapshot (${quote(l.map((e) => e.evidence))})` });
    }
  }
  if (ae?.ambiguous === true || be?.ambiguous === true) return item("not-checked", { reason: "the edge is marked ambiguous (an endpoint key is shared)" });

  if (g.op !== "remove") {
    if (ae !== undefined && tierAtLeast(ae.tier, "syntactic")) return item("verified", { evidence: ae.evidence });
    if (ae !== undefined) return item("not-checked", { reason: `observed only at tier ${ae.tier} (below syntactic)`, evidence: ae.evidence });
    return item("not-checked", { reason: `not observed in the after snapshot; ${CONSERVATIVE}${joinNote(after, g)}` });
  }
  if (ae !== undefined) return item("still-present", { evidence: ae.evidence });
  if (be === undefined) return item("not-checked", { reason: "not in the base snapshot, so its removal cannot be shown" });
  for (const end of [g.from, g.to]) {
    const gone = endpointGone(end, base, after);
    if (gone !== null) return item("verified", { reason: `endpoint ${end} is gone: ${gone}`, evidence: be.evidence });
  }
  return item("not-checked", { reason: `not observed after, but neither endpoint is proven gone, and ${CONSERVATIVE}${joinNote(after, g)}`, evidence: be.evidence });
}

function blockItem(g: GhostSet["blocks"][number], base: Snapshot, after: Snapshot, ghosts: GhostSet): DriftItem {
  const item = (outcome: DriftOutcome, extra: { reason?: string; evidence?: string } = {}): DriftItem => ({ key: g.id, kind: "block", op: g.op, outcome, ...extra });
  const bb = base.blocks.get(g.id);
  const ab = after.blocks.get(g.id);
  const gone = (proven: DriftOutcome): DriftItem => {
    const at = bb !== undefined ? { evidence: bb.evidence } : {};
    const problem = bb === undefined ? "not in the base snapshot" : blockGoneProblem(bb, after);
    if (problem !== null) return item("not-checked", { reason: `no file of the after snapshot is in this block, but its absence is not proven: ${problem}`, ...at });
    return item(proven, { reason: "no file of the after snapshot is in this block", ...at });
  };
  if (g.op === "add") {
    if (bb !== undefined) return item("not-checked", { reason: "already present in the base snapshot — an add cannot be told apart from a keep", evidence: bb.evidence });
    if (ab !== undefined) {
      const p = base.fullySearched(ab.files, "any");
      if (!p.ok) return item("not-checked", { reason: `present after, but absence in the base snapshot is not proven: ${p.reason}`, evidence: ab.evidence });
      const dirs = new Set(ab.files.map(dirOf));
      const hidden = base.unextracted().find((x) => dirs.has(dirOf(x.path)));
      if (hidden !== undefined) return item("not-checked", { reason: `present after, but in the base snapshot ${hidden.path} (in its directory) was not extracted (${hidden.reason})`, evidence: ab.evidence });
      return item("verified", { evidence: ab.evidence });
    }
    const expected = ghosts.entities.filter((e) => e.block === g.id).map((e) => e.expected_file);
    return item("not-checked", { reason: `no file of the after snapshot is in this block (blocks derive from files; a new block's absence is not proven)${expected.length > 0 ? `; expected files: ${quote(uniqSorted(expected))}` : ""}` });
  }
  if (bb === undefined) return item("not-checked", { reason: `not in the base snapshot, so op ${g.op} has nothing to compare against` });
  if (g.op === "remove") return ab !== undefined ? item("still-present", { evidence: ab.evidence }) : gone("verified");
  if (ab === undefined) return gone("missing");
  if (g.op === "keep") return item("verified", { evidence: ab.evidence });
  const keys = uniqSorted([...base.map.entities, ...after.map.entities].filter((e) => e.block === g.id).map((e) => e.key));
  const changes = keys.map((k) => changeOf(k, base, after)).filter((c): c is Change => c !== null);
  const proven = changes.filter((c) => c.proven);
  if (proven.length > 0) return item("verified", { reason: `proven changes: ${quote(proven.map((c) => `${c.key} ${c.proven ? c.what : ""}`))}`, evidence: ab.evidence });
  if (changes.length > 0) return item("not-checked", { reason: `entities in the block differ, but no change is proven: ${quote(changes.map((c) => `${c.key}: ${c.proven ? "" : c.why}`))}`, evidence: ab.evidence });
  return item("unchanged", { reason: "no entity in the block was added, removed or edited", evidence: ab.evidence });
}

function traceItem(t: GhostTrace, ghosts: GhostSet, base: Snapshot, after: Snapshot): DriftItem {
  const item = (outcome: DriftOutcome, reason?: string): DriftItem => ({ key: t.scenario, kind: "trace", op: null, outcome, ...(reason !== undefined ? { reason } : {}) });
  const ghostOf = new Map(ghosts.entities.map((e) => [e.id, e]));
  for (const step of t.steps) {
    const a = after.lookup(step);
    if ("reason" in a) return item("not-checked", `step ${step}: ${a.reason}`);
    const g = ghostOf.get(step);
    const be = base.entities.get(step)?.[0];
    const kind = "entity" in a ? a.entity.kind : (g?.kind ?? be?.kind);
    const files = "entity" in a ? [a.entity.file] : [...(g !== undefined ? [g.expected_file] : []), ...(be !== undefined ? [be.file] : [])];
    if (kind === undefined || files.length === 0) return item("not-checked", `step ${step} is in neither snapshot nor the ghost set`);
    const p = after.fullySearched(files, kind);
    if (!p.ok) return item("not-checked", `step ${step}: ${p.reason}`);
  }
  const unverified: string[] = [];
  let verified = 0;
  for (let i = 0; i + 1 < t.steps.length; i++) {
    const from = t.steps[i];
    const to = t.steps[i + 1];
    if (from === undefined || to === undefined) continue;
    if (linked(from, to, after)) verified++;
    else unverified.push(`${from} → ${to}`);
  }
  const pairs = verified + unverified.length;
  if (pairs > 0 && verified === pairs) return item("verified");
  if (verified > 0) return item("partial", `${verified} of ${pairs} links verified; not observed: ${quote(unverified)}`);
  return item("not-checked", `no link observed (${CONSERVATIVE}); not observed: ${quote(unverified)}`);
}

/** An observed edge of any kind from → to, or `to` is a fetch site inside function `from`. */
function linked(from: string, to: string, after: Snapshot): boolean {
  for (const e of after.map.edges) if (e.from === from && e.to === to && e.ambiguous !== true && tierAtLeast(e.tier, "syntactic")) return true;
  const t = after.lookup(to);
  return "entity" in t && t.entity.kind === "fetch-site" && t.entity.fetch?.enclosing === from;
}

// ── unexpected ──────────────────────────────────────────────────────────────

function unexpectedItems(ghosts: GhostSet, base: Snapshot, after: Snapshot): DriftItem[] {
  const ghosted = new Set(ghosts.entities.map((e) => e.id));
  const files = new Set<string>(ghosts.entities.map((e) => e.expected_file));
  for (const id of ghosted) for (const s of [base, after]) for (const e of s.entities.get(id) ?? []) files.add(e.file);
  const blocks = new Set<string>([...ghosts.blocks.map((b) => b.id), ...ghosts.entities.map((e) => e.block)]);
  for (const f of files) {
    for (const s of [base, after]) {
      const b = s.files.get(f)?.block;
      if (b !== undefined) blocks.add(b);
    }
  }
  const inScope = (e: Entity) => files.has(e.file) || blocks.has(e.block);
  const keys = new Set<string>();
  for (const s of [base, after]) for (const e of s.map.entities) if (!ghosted.has(e.key) && inScope(e)) keys.add(e.key);

  const out: DriftItem[] = [];
  for (const key of [...keys].sort(cmpStr)) {
    const c = changeOf(key, base, after);
    if (c === null) continue;
    out.push(
      c.proven
        ? { key, kind: c.kind, op: null, outcome: "unexpected", reason: `${c.what} since base, with no ghost for it`, evidence: c.evidence }
        : { key, kind: c.kind, op: null, outcome: "not-checked", reason: `no ghost for it; ${c.why}`, evidence: c.evidence },
    );
  }
  return out;
}

// ── report ──────────────────────────────────────────────────────────────────

function compareItems(a: DriftItem, b: DriftItem): number {
  return (
    DRIFT_OUTCOMES.indexOf(a.outcome) - DRIFT_OUTCOMES.indexOf(b.outcome) ||
    SUBJECT_ORDER.indexOf(a.kind) - SUBJECT_ORDER.indexOf(b.kind) ||
    cmpStr(a.key, b.key) ||
    cmpStr(a.op ?? "", b.op ?? "")
  );
}

/**
 * Were both snapshots extracted by the same extractor? Content hashes, keys, coverage and the
 * `declarations` inventory are all functions of the extractor version, so comparing across
 * versions would report every hash as changed (or unchanged) for reasons that are not the code.
 * The engine uses this to decide to re-extract base at its commit.
 */
export function sameExtractor(base: AssembledMap, after: AssembledMap): boolean {
  return base.extractorVersion === after.extractorVersion;
}

/** Every ghost item not-checked (each depends on hashes or presence); no `unexpected` claims. */
function versionMismatch(ghosts: GhostSet, base: AssembledMap, after: AssembledMap): DriftItem[] {
  const reason = `snapshots extracted by different extractor versions (${base.extractorVersion} vs ${after.extractorVersion}) — re-extract base with the current extractor`;
  return [
    ...ghosts.blocks.map((g): DriftItem => ({ key: g.id, kind: "block", op: g.op, outcome: "not-checked", reason })),
    ...ghosts.entities.map((g): DriftItem => ({ key: g.id, kind: g.kind, op: g.op, outcome: "not-checked", reason })),
    ...ghosts.edges.map((g): DriftItem => ({ key: ghostEdgeId(g), kind: "edge", op: g.op, outcome: "not-checked", reason })),
    ...ghosts.trace.map((t): DriftItem => ({ key: t.scenario, kind: "trace", op: null, outcome: "not-checked", reason })),
  ];
}

export function emptyCounts(): Record<DriftOutcome, number> {
  return Object.fromEntries(DRIFT_OUTCOMES.map((o) => [o, 0])) as Record<DriftOutcome, number>;
}

/**
 * Compare `base` and `after` through the lens of an (already validated) ghost set. Pure and
 * deterministic: same inputs, byte-identical report.
 */
export function computeDrift(ghosts: GhostSet, base: AssembledMap, after: AssembledMap, opts: DriftOptions = {}): DriftReport {
  const b = new Snapshot(base, "base");
  const a = new Snapshot(after, "after", new Set(opts.ignoredOnDisk ?? []));
  const items: DriftItem[] = (
    sameExtractor(base, after)
      ? [
          ...ghosts.blocks.map((g) => blockItem(g, b, a, ghosts)),
          ...ghosts.entities.filter((g) => GHOST_ENTITY_KINDS.includes(g.kind)).map((g) => entityItem(g, b, a)),
          ...ghosts.edges.map((g) => edgeItem(g, b, a)),
          ...ghosts.trace.map((t) => traceItem(t, ghosts, b, a)),
          ...unexpectedItems(ghosts, b, a),
        ]
      : versionMismatch(ghosts, base, after)
  ).sort(compareItems);
  const counts = emptyCounts();
  for (const i of items) counts[i.outcome]++;
  const cap = Math.max(0, opts.cap ?? DRIFT_CAP);
  return {
    commit: after.commit,
    baseCommit: base.commit,
    manifestHash: after.manifestHash,
    baseManifestHash: base.manifestHash,
    items: items.slice(0, cap),
    truncated: Math.max(0, items.length - cap),
    counts,
  };
}
