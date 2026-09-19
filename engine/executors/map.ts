/**
 * Map built-ins (system-map 1c, "Map built-ins") — `map:extract`, `map:reextract` and
 * `map:drift` run IN-PROCESS behind the command executor, beside `probe:pr`, not as shell
 * commands: a shell command ignores the node's reads, streams all stdout as chunks and cannot
 * append typed events. These read the node's declared reads, write manifests and objects,
 * append `map-extracted` / `map-progress` / `drift-detected`, and return BOUNDED writes only.
 *
 *   map:extract    fingerprint(worktree) → extract (throttled map-progress) → fingerprint again
 *                  (moved during extraction → the attempt fails) → runs/<id>/maps/<hash>.json →
 *                  map-extracted → assemble → ticketEntities(goal, work + pending redesign
 *                  messages) → neighbourhood → render. Writes, as the node declares them:
 *                    map.base          {manifest_hash, fingerprint, commit}   (BaseSnapshot)
 *                    map.neighbourhood the rendered, size-capped neighbourhood text
 *                    slice.drift       []    (seeded: implement reads it on the entry path)
 *                    review_findings   null  (seeded: implement reads it on the entry path)
 *                  No entity named by the ticket (needsEntryPoint) is never a dead end: the
 *                  neighbourhood falls back to a bounded block-level overview plus a note
 *                  telling the operator how to name an entry point (ticket text, or
 *                  `redesign <run> <entry point>` — redesign messages are seed text).
 *   map:reextract  extract the worktree again → manifest + map-extracted → `map.after`
 *                  {manifest_hash, commit, dirty, uncommitted}. `dirty`: uncommitted or
 *                  untracked changes to files the snapshot EXTRACTS (source files, manifest
 *                  entries) were on top of the commit — a stray log or scratch file is not one.
 *   map:drift      base + after manifests from the run dir (each assembled from the store its
 *                  map-extracted event recorded) → computeDrift over the approved ghosts →
 *                  `slice.drift` (SliceDrift, capped) + drift-detected.
 *                  - A dirty after snapshot verifies NOTHING: every `verified` becomes
 *                    `not-checked (verified only in uncommitted changes)` and the report is
 *                    stamped "<sha> + uncommitted changes" — nothing reaches publish as verified
 *                    that is not in a commit.
 *                  - Base and after from different extractor versions: the base is re-extracted
 *                    at its commit when that reproduces it exactly (base_reextracted); otherwise
 *                    computeDrift reports every ghost not-checked and the event records
 *                    extractor_mismatch.
 *                  - `map:drift --since <node>`: `new_problems` counts only the problems the code
 *                    did not already have when <node> last started (delivery: the drift the
 *                    published code was checked with) — a repair is judged on what IT broke.
 *
 * Failure policy: a fingerprint that cannot be computed (FingerprintError), a folder that is
 * not a git work tree, or a worktree that moved during extraction FAILS the attempt with the
 * reason — the run parks rather than binding a design to a snapshot nobody can verify.
 * Anything else that throws (git missing, a corrupt manifest) parks as executor-threw.
 *
 * Entry-point seed text: EVERY redesign message that jumped to this node in the run
 * (redesignSeedText) — an entry point the operator picked stays picked across later stale →
 * re-extract loops. Which messages must still reach the proposer is the engine's job
 * (engine/slice-decision.ts pendingRedesigns seeds the approval's feedback key).
 *
 * Snapshot types, loading and git facts shared with graphs and the web read model live in
 * engine/slice-map.ts (no graph imports an executor).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Executor, ExecArgs, AttemptResult } from "../run";
import type { Fingerprint, LoggedEvent } from "../../log/events";
import { FingerprintError, describeFingerprintChange, fingerprint } from "../reconcile";
import { effectiveCwd } from "./worktree-record";
import type { BaseSnapshot } from "../slice-decision";
import {
  PROBLEM_OUTCOMES, uncommittedSourcePaths, UNCOMMITTED_LIST_CAP, ignoredExpectedFiles, loadSnapshot, mapsDir, rememberSnapshot, snapshotStamp, storeFor,
  type MapAfter, type SliceDrift,
} from "../slice-map";
import { extract } from "../../map/extract";
import { assemble } from "../../map/assemble";
import { MapStore, readManifest, writeManifestTo } from "../../map/store";
import { ticketEntities, neighbourhood, renderNeighbourhood, RENDER_MAX_CHARS, type TicketEntities } from "../../map/neighbourhood";
import { computeDrift, emptyCounts, sameExtractor, DRIFT_CAP, type DriftItem, type DriftOptions, type DriftReport } from "../../map/drift";
import { validateGhostSet } from "../../map/ghosts";
import type { AssembledMap, Manifest, Progress } from "../../map/types";

// moved to engine/slice-map.ts (graphs and the web read model must not import an executor);
// re-exported so existing importers keep working
export { loadSnapshot, mapsDir, PROBLEM_OUTCOMES, type MapAfter, type SliceDrift } from "../slice-map";

export const MAP_BUILTINS = ["map:extract", "map:reextract", "map:drift"] as const;
export type MapBuiltin = (typeof MAP_BUILTINS)[number];

export interface MapBuiltinOpts {
  /** the content-addressed object store new extractions write to (default $HOWDAH_HOME/maps) */
  storeDir?: string;
  /** parse workers; 0 = in-process (tests); default: the pool's own sizing */
  workers?: number;
  /** at most one map-progress event per this many ms (the final one always lands); default 1000 */
  progressIntervalMs?: number;
  /** injectable clock for the throttle */
  now?: () => number;
  /** slice.drift / drift-detected item cap (default DRIFT_CAP = 200) */
  driftCap?: number;
}

export function isMapBuiltin(run: string): boolean {
  const name = run.trim().split(/\s+/)[0] ?? "";
  return (MAP_BUILTINS as readonly string[]).includes(name);
}

/** `map:drift --since delivery.publish` → { name, since }. Unknown arguments throw (a graph bug). */
export function parseMapRun(run: string): { name: MapBuiltin; since?: string } {
  const [name, ...args] = run.trim().split(/\s+/);
  if (!(MAP_BUILTINS as readonly string[]).includes(name ?? "")) throw new Error(`not a map built-in: "${run}"`);
  let since: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--since" && name === "map:drift" && args[i + 1] !== undefined) since = args[++i];
    else throw new Error(`${name}: unknown argument "${args[i]}" in "${run}"`);
  }
  return { name: name as MapBuiltin, ...(since !== undefined ? { since } : {}) };
}

// ---- the executor --------------------------------------------------------------------------

type Failed = AttemptResult & { status: "failed" };
const failed = (reason: string): Failed => ({ status: "failed", writes: {}, reason });

/** The live fingerprint, or why there is none — never a value that could compare equal. */
async function liveFingerprint(workDir: string, what: string): Promise<Fingerprint | Failed> {
  try {
    const fp = await fingerprint(workDir);
    return fp ?? failed(`${what} needs a git work tree to bind the snapshot to, and ${workDir} is not one`);
  } catch (err) {
    if (err instanceof FingerprintError) return failed(`${what}: cannot fingerprint the worktree — ${err.message}`);
    throw err;
  }
}

const isFailed = (v: Fingerprint | Failed): v is Failed => "status" in v;

/**
 * Every redesign message that jumped to `node` in this run (D22: `redesign` appends the request
 * and its operator-jump in ONE append, so the jump is the next seq). ALL of them, not only the
 * unconsumed ones: an entry point the operator picked stays picked across later stale →
 * re-extract loops. (Which messages still have to reach the proposer is a different question,
 * answered by engine/slice-decision.ts pendingRedesigns — the engine seeds those.)
 */
export function redesignSeedText(events: readonly LoggedEvent[], node: string): string[] {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  return events.flatMap((e) => {
    if (e.type !== "slice-redesign-requested") return [];
    const jump = bySeq.get(e.seq + 1);
    return jump?.type === "operator-jump" && jump.to === node ? [e.message] : [];
  });
}

/** Only the declared keys, and every declared key: a node asking for something unknown is a graph bug. */
function declaredWrites(builtin: string, def: ExecArgs["def"], produced: Record<string, unknown>): Record<string, unknown> {
  const declared = Object.keys(("writes" in def && def.writes) || {});
  const unknown = declared.filter((k) => !(k in produced));
  if (unknown.length) throw new Error(`${builtin} cannot produce ${unknown.join(", ")} (it produces ${Object.keys(produced).join(", ")})`);
  return Object.fromEntries(declared.map((k) => [k, produced[k]]));
}

export function mapBuiltinExecutor(opts: MapBuiltinOpts = {}): Executor {
  return async (args) => {
    const { def } = args;
    if (def.kind !== "command") throw new Error("map built-in on a non-command node");
    const run = parseMapRun(def.run);
    const store = new MapStore(opts.storeDir);
    const workDir = effectiveCwd(args.log.path, args.cwd);
    const runDir = dirname(args.log.path);
    if (run.name === "map:drift") return driftStep(args, runDir, store, workDir, run.since, opts);
    if (!workDir) return failed(`${run.name} needs a working directory (the run has no folder)`);
    const snap = await extractStep(args, run.name, workDir, runDir, store, opts);
    if ("status" in snap) return snap;
    if (run.name === "map:reextract") {
      const after: MapAfter = {
        manifest_hash: snap.hash,
        commit: snap.manifest.commit,
        dirty: snap.uncommitted.length > 0,
        uncommitted: snap.uncommitted.slice(0, UNCOMMITTED_LIST_CAP),
        uncommitted_count: snap.uncommitted.length,
      };
      return { status: "succeeded", writes: declaredWrites(run.name, def, { "map.after": after }) };
    }
    return extractWrites(args, snap, store);
  };
}

interface Snapshot {
  manifest: Manifest;
  hash: string;
  fingerprint: Fingerprint;
  /** uncommitted source changes the snapshot contains (on top of the commit), sorted */
  uncommitted: string[];
}

/** extract the worktree, bound to a fingerprint that held for the whole extraction */
async function extractStep(
  args: ExecArgs,
  name: MapBuiltin,
  workDir: string,
  runDir: string,
  store: MapStore,
  opts: MapBuiltinOpts,
): Promise<Snapshot | Failed> {
  const { nodeId, visit, log } = args;
  const before = await liveFingerprint(workDir, name);
  if (isFailed(before)) return before;

  const now = opts.now ?? Date.now;
  const interval = opts.progressIntervalMs ?? 1000;
  let last = -Infinity;
  let finalSent = false;
  const onProgress = (p: Progress) => {
    const final = p.done >= p.total;
    if (final ? finalSent : now() - last < interval) return;
    last = now();
    finalSent = final;
    log.append({ type: "map-progress", node: nodeId, visit, done: p.done, total: p.total, skipped: p.skipped });
  };
  const res = await extract({ repoDir: workDir, store, onProgress, ...(opts.workers !== undefined ? { workers: opts.workers } : {}) });

  const after = await liveFingerprint(workDir, name);
  if (isFailed(after)) return after;
  const moved = describeFingerprintChange(before, after);
  if (moved) return failed(`${name}: the worktree changed during extraction (${moved}) — the snapshot would match neither state; retry once it is quiet`);

  // build/package manifests count too: they decide block keys (Gradle project path, TS package dir)
  const uncommitted = uncommittedSourcePaths(workDir, new Set([...Object.keys(res.manifest.files), ...Object.keys(res.manifest.buildManifests)]));
  const dirty = uncommitted.length > 0;
  const { hash } = writeManifestTo(res.manifest, mapsDir(runDir));
  const map = rememberSnapshot(store, hash, assemble(res.manifest, store));
  log.append({
    type: "map-extracted",
    node: nodeId,
    visit,
    manifest_hash: hash,
    commit: res.manifest.commit,
    dirty,
    store: store.dir,
    fingerprint: before,
    tiers_run: ["syntactic"],
    unparsed: map.unparsed.length,
    skipped: res.manifest.skipped.length,
    not_checked: res.manifest.notChecked.length,
    files: Object.keys(res.manifest.files).length,
  });
  return { manifest: res.manifest, hash, fingerprint: before, uncommitted };
}

/** Room kept for the notes appended after the rendered neighbourhood. */
const NOTE_RESERVE = 1200;

/**
 * What the proposer sees of `map` for this ticket (`map.neighbourhood`): the rendered 2-hop
 * neighbourhood of the entities the ticket names, or — when it names none — the block-level
 * overview with the entry-point note. Redesign messages count as ticket text. Shared with the
 * slice.propose eval, so the eval scores the prompt a run would send.
 */
export function proposerMapText(map: AssembledMap, goal: string, work: string, redesigns: readonly string[] = []): { text: string; named: TicketEntities } {
  const named = ticketEntities(goal, [work, ...redesigns].join("\n\n"), map);
  const text = named.needsEntryPoint
    ? renderOverview(map, named, RENDER_MAX_CHARS)
    : renderNeighbourhood(neighbourhood(map, named.seeds), RENDER_MAX_CHARS - NOTE_RESERVE) + tooBroadNote(named);
  return { text, named };
}

function extractWrites(args: ExecArgs, snap: Snapshot, store: MapStore): AttemptResult {
  const { nodeId, visit, log, reads, def } = args;
  const map = loadSnapshot(dirname(log.path), snap.hash, store);
  const { text, named } = proposerMapText(map, String(reads["goal"] ?? ""), String(reads["work"] ?? ""), redesignSeedText(log.read(), nodeId));
  // the operator reads the thread, not the prompt: say it there too
  if (named.needsEntryPoint) log.append({ type: "chunk", node: nodeId, visit, turn: 1, index: 0, kind: "text", content: entryPointNote(named) });
  const base: BaseSnapshot = { manifest_hash: snap.hash, fingerprint: snap.fingerprint, commit: snap.manifest.commit };
  return {
    status: "succeeded",
    writes: declaredWrites("map:extract", def, { "map.base": base, "map.neighbourhood": text, "slice.drift": [], review_findings: null }),
  };
}

function tooBroadNote(named: TicketEntities): string {
  if (named.tooBroad.length === 0) return "";
  const list = named.tooBroad.slice(0, 10).map((t) => `\`${t.token}\` (${t.candidates} candidates)`).join(", ");
  return `\n\nToo broad to seed (name them more precisely to include them): ${list}${named.tooBroad.length > 10 ? `, … ${named.tooBroad.length - 10} more` : ""}.`;
}

/** What the operator is told when the ticket names nothing the map knows. */
export function entryPointNote(named: TicketEntities): string {
  return (
    `No entry point: the ticket names no file path, route or symbol this snapshot knows, so the proposer sees a block-level overview only.` +
    tooBroadNote(named) +
    `\nTo focus the design, put file paths (\`web/src/api.ts\`), routes (\`GET /api/users/{id}\`) or symbols (\`getUser\`) in the ticket, ` +
    `or run \`redesign <run> <entry point>\` — redesign messages are matched like ticket text.`
  );
}

/** Per-block entity lines shown in the overview (routes first — they are the usual entry points). */
const OVERVIEW_PER_BLOCK = 8;
const KIND_ORDER = { route: 0, "fetch-site": 1, function: 2 } as const;

/**
 * The needsEntryPoint fallback: every block with a few of its entities, bounded by `maxChars`.
 * Deterministic (the map is sorted), and it says where it was cut.
 */
export function renderOverview(map: AssembledMap, named: TicketEntities, maxChars: number): string {
  const head = [
    `Map overview — commit ${map.commit === null ? "(none)" : map.commit.slice(0, 12)}, manifest ${map.manifestHash.slice(0, 12)}`,
    entryPointNote(named),
    `Design against the blocks below; use exact keys from this list for modify/remove/keep. Tier in [brackets]; absence from this list is NOT evidence of absence in the code.`,
  ];
  const lines: string[] = [];
  for (const b of map.blocks) {
    const ents = map.entities.filter((e) => e.block === b.key).sort((x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    lines.push("", `## block \`${b.key}\` (${b.family}, ${b.files.length} file${b.files.length === 1 ? "" : "s"}) [${b.tier}]`);
    for (const e of ents.slice(0, OVERVIEW_PER_BLOCK)) lines.push(`- ${e.kind} \`${e.key}\` [${e.tier}] ${e.evidence}${e.ambiguous ? " AMBIGUOUS" : ""}`);
    if (ents.length > OVERVIEW_PER_BLOCK) lines.push(`- … ${ents.length - OVERVIEW_PER_BLOCK} more entities in this block`);
  }
  const out = [...head];
  let used = head.join("\n").length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (used + l.length + 1 > maxChars - 80) {
      out.push(`- … overview cut at the size cap (${map.blocks.length} blocks, ${map.entities.length} entities in the snapshot)`);
      break;
    }
    out.push(l);
    used += l.length + 1;
  }
  return out.join("\n");
}

// ---- map:drift -----------------------------------------------------------------------------

const problemId = (i: Pick<DriftItem, "outcome" | "key">) => `${i.outcome} ${i.key}`;

function problemsOf(items: readonly DriftItem[]): string[] {
  return items.filter((i) => PROBLEM_OUTCOMES.includes(i.outcome)).map(problemId);
}

/** The problems of the last drift-detected before `since` last started (none → empty). */
function baselineProblems(events: readonly LoggedEvent[], since: string): Set<string> {
  const started = events.findLast((e) => e.type === "node-started" && e.node === since);
  if (!started) return new Set();
  const drift = events.findLast((e) => e.type === "drift-detected" && e.seq < started.seq);
  return new Set(drift?.type === "drift-detected" ? problemsOf(drift.items) : []);
}

function readManifestHash(value: unknown, key: string): string {
  const hash = typeof value === "object" && value !== null ? (value as { manifest_hash?: unknown }).manifest_hash : undefined;
  if (typeof hash !== "string") throw new Error(`map:drift: "${key}" carries no manifest_hash (${JSON.stringify(value)})`);
  return hash;
}

function readUncommitted(value: unknown): { dirty: boolean; paths: string[]; count: number } {
  const v = (typeof value === "object" && value !== null ? value : {}) as { dirty?: unknown; uncommitted?: unknown; uncommitted_count?: unknown };
  if (typeof v.dirty !== "boolean" || !Array.isArray(v.uncommitted) || typeof v.uncommitted_count !== "number")
    throw new Error(`map:drift: "map.after" does not say which uncommitted changes its snapshot holds (${JSON.stringify(value)})`);
  return { dirty: v.dirty, paths: v.uncommitted.map(String), count: v.uncommitted_count };
}

/** Why a verified item on a dirty snapshot is not-checked — naming what to commit. */
export function uncommittedReason(paths: readonly string[], count: number): string {
  const listed = paths.join(", ") + (count > paths.length ? `, … ${count - paths.length} more` : "");
  return `verified only in uncommitted changes (${listed}) — commit them, then drift can verify it against a commit`;
}

/**
 * D21 + review: `verified` names a COMMIT. On a snapshot with uncommitted source changes nothing
 * is verified — it would be published as verified without being in any commit — so each
 * `verified` becomes `not-checked (verified only in uncommitted changes: <paths>)`.
 */
export function withoutUncommittedVerification(report: DriftReport, reason: string): DriftReport {
  const items = report.items.map((i): DriftItem => (i.outcome === "verified" ? { ...i, outcome: "not-checked", reason } : i));
  const counts = { ...emptyCounts(), ...report.counts };
  counts["not-checked"] += counts.verified;
  counts.verified = 0;
  return { ...report, items, counts };
}

async function driftStep(
  args: ExecArgs,
  runDir: string,
  store: MapStore,
  workDir: string | undefined,
  since: string | undefined,
  opts: MapBuiltinOpts,
): Promise<AttemptResult> {
  const { nodeId, visit, log, reads, def } = args;
  const note = (content: string) => log.append({ type: "chunk", node: nodeId, visit, turn: 1, index: 0, kind: "text", content });
  const baseHash = readManifestHash(reads["map.base"], "map.base");
  const recorded = loadSnapshot(runDir, baseHash, storeFor(runDir, baseHash));
  const afterHash = readManifestHash(reads["map.after"], "map.after");
  const after = loadSnapshot(runDir, afterHash, storeFor(runDir, afterHash));
  const { dirty, paths: uncommitted, count: uncommittedCount } = readUncommitted(reads["map.after"]);
  // validated when proposed; re-checked here for the typed value (a failure is an engine bug)
  const checked = validateGhostSet(reads["slice.ghosts"], recorded);
  if (!checked.ok) throw new Error(`map:drift: the approved ghosts no longer validate against their base: ${checked.errors.slice(0, 3).join("; ")}`);

  // base and after must come from the same extractor, or content hashes and presence are not
  // comparable: re-extract the base at its commit with this extractor when that reproduces it.
  // If it cannot, computeDrift itself reports every ghost item not-checked (sameExtractor).
  let base = recorded;
  let baseReextracted = false;
  if (!sameExtractor(recorded, after)) {
    const redone = workDir ? await reextractBase(runDir, recorded, workDir, store, opts) : { ok: false as const, reason: "the run has no working directory" };
    const fits = redone.ok && validateGhostSet(checked.ghosts, redone.map).ok;
    if (redone.ok && fits) {
      base = redone.map;
      baseReextracted = true;
      note(`the base was extracted by ${recorded.extractorVersion}, the code now by ${after.extractorVersion}: re-extracted the base at ${short(recorded.commit)} with the current extractor`);
    } else {
      note(
        `the base was extracted by ${recorded.extractorVersion}, the code now by ${after.extractorVersion}, and the base could not be re-extracted ` +
          `(${redone.ok ? "the approved ghosts do not fit the re-extracted base" : redone.reason}) — every ghost is not-checked`,
      );
    }
  }
  const mismatch = sameExtractor(base, after) ? undefined : { base: base.extractorVersion, after: after.extractorVersion };

  const ignored = workDir ? ignoredExpectedFiles(workDir, checked.ghosts).filter((f) => existsSync(join(workDir, f))) : [];
  const computed = computeDrift(checked.ghosts, base, after, driftOptions(opts.driftCap ?? DRIFT_CAP, ignored));
  const report = dirty ? withoutUncommittedVerification(computed, uncommittedReason(uncommitted, uncommittedCount)) : computed;
  const stamp = snapshotStamp(report.commit, dirty);

  const problems = problemsOf(report.items);
  const baseline = since ? baselineProblems(log.read(), since) : new Set<string>();
  const extra = {
    ...(baseReextracted ? { base_reextracted: true as const } : {}),
    ...(mismatch ? { extractor_mismatch: mismatch } : {}),
  };
  const drift: SliceDrift = {
    commit: report.commit,
    stamp,
    dirty,
    base_commit: report.baseCommit,
    manifest_hash: report.manifestHash,
    base_manifest_hash: report.baseManifestHash,
    counts: report.counts,
    items: report.items,
    truncated: report.truncated,
    problems,
    new_problems: problems.filter((p) => !baseline.has(p)),
    ...extra,
  };
  log.append({
    type: "drift-detected",
    node: nodeId,
    visit,
    commit: report.commit,
    stamp,
    dirty,
    base_commit: report.baseCommit,
    manifest_hash: report.manifestHash,
    base_manifest_hash: report.baseManifestHash,
    counts: report.counts,
    items: report.items,
    truncated: report.truncated,
    ...extra,
  });
  return { status: "succeeded", writes: declaredWrites("map:drift", def, { "slice.drift": drift }) };
}

const short = (sha: string | null) => (sha === null ? "(no commit)" : sha.slice(0, 12));

/**
 * Re-extract a base recorded by another extractor version, at its commit, with this one. Only a
 * FAITHFUL re-extraction counts: the same files with the same contents as the recorded base —
 * a base drawn on a dirty worktree (uncommitted changes) cannot be reproduced from its commit.
 * Fails CLOSED: a file whose object (old or new) cannot be read is a failure, never a match.
 * The new manifest is recorded in the run dir.
 */
async function reextractBase(
  runDir: string,
  recorded: AssembledMap,
  workDir: string,
  store: MapStore,
  opts: MapBuiltinOpts,
): Promise<{ ok: true; map: AssembledMap } | { ok: false; reason: string }> {
  if (recorded.commit === null) return { ok: false, reason: "the base has no commit to re-extract" };
  const was = readManifest(join(mapsDir(runDir), `${recorded.manifestHash}.json`));
  const wasStore = storeFor(runDir, recorded.manifestHash);
  let res;
  try {
    res = await extract({ repoDir: workDir, commit: recorded.commit, store, ...(opts.workers !== undefined ? { workers: opts.workers } : {}) });
  } catch (err) {
    return { ok: false, reason: `re-extraction at ${short(recorded.commit)} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const contents = (m: Manifest, from: MapStore): string[] | string => {
    const out: string[] = [];
    for (const [path, key] of Object.entries(m.files)) {
      const sha = from.readObject(key)?.contentSha256;
      if (sha === undefined) return `the object for ${path} is missing or unreadable`;
      out.push(`${path}\0${sha}`);
    }
    return out.sort();
  };
  const before = contents(was, wasStore);
  const now = contents(res.manifest, store);
  if (typeof before === "string" || typeof now === "string") return { ok: false, reason: typeof before === "string" ? before : (now as string) };
  if (before.join("\n") !== now.join("\n"))
    return { ok: false, reason: `the base's files differ from commit ${short(recorded.commit)} (it was drawn on uncommitted changes)` };
  const { hash } = writeManifestTo(res.manifest, mapsDir(runDir));
  return { ok: true, map: rememberSnapshot(store, hash, assemble(res.manifest, store)) };
}

/**
 * computeDrift's options. `ignored`: expected_files that exist on disk but git ignores — never
 * extracted, so their absence proves nothing (reported not-checked, never missing).
 */
function driftOptions(cap: number, ignored: string[]): DriftOptions {
  return { cap, ...(ignored.length ? { ignoredOnDisk: ignored } : {}) };
}
