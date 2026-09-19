/**
 * The slice's view of the map (system-map 1c) — what the engine, the graphs and the CLI share
 * about map snapshots, without depending on an executor:
 *
 *   - the context values the map built-ins write: `map.after` (MapAfter) and `slice.drift`
 *     (SliceDrift), and PROBLEM_OUTCOMES — the ONE list of drift outcomes that mean the code
 *     disagrees with the approved design (routing, prompts and metrics all read it);
 *   - loadSnapshot(): a run's recorded snapshot, assembled from runs/<id>/maps/<hash>.json and
 *     the object store its `map-extracted` event names (so a validator in another process, or a
 *     run configured with its own store, reads the same objects the extraction wrote). Both
 *     values come from the log, so they are checked before touching disk: the hash must be a
 *     sha256, the store the default one or a directory under $HOWDAH_HOME;
 *   - git facts the map needs: which paths git ignores, and whether a worktree has changes that
 *     are not committed (a snapshot of such a tree is "commit + uncommitted changes").
 */
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { assemble } from "../map/assemble";
import { MapStore, readManifest } from "../map/store";
import type { DriftItem, DriftOutcome } from "../map/drift";
import type { GhostSet } from "../map/ghosts";
import type { AssembledMap } from "../map/types";
import { readLog } from "../log/write";
import { languageOf } from "../map/languages";
import { howdahHome } from "../config/config";

/** Drift outcomes that mean the code disagrees with the approved design (D19). */
export const PROBLEM_OUTCOMES: readonly DriftOutcome[] = ["missing", "changed-unexpectedly", "still-present", "unchanged"];

/** What `map:reextract` writes to `map.after`. */
export interface MapAfter {
  manifest_hash: string;
  commit: string | null;
  /** the snapshot contains uncommitted source changes: it is NOT the commit */
  dirty: boolean;
  /** those changed paths (at most UNCOMMITTED_LIST_CAP; `uncommitted_count` is the full number) */
  uncommitted: string[];
  uncommitted_count: number;
}

/** What `map:drift` writes to `slice.drift` — the DriftReport, bounded, plus its problems. */
export interface SliceDrift {
  /** the after snapshot's commit — what `verified` refers to (D21) */
  commit: string | null;
  /** how the UI and prompts should name that snapshot: "<sha>" or "<sha> + uncommitted changes" */
  stamp: string;
  /** the after snapshot had uncommitted changes: nothing in it is reported verified */
  dirty: boolean;
  base_commit: string | null;
  manifest_hash: string;
  base_manifest_hash: string;
  counts: Record<DriftOutcome, number>;
  /** worst outcome first, capped (DRIFT_CAP); `truncated` counts the rest */
  items: DriftItem[];
  truncated: number;
  /** `outcome key` of every PROBLEM_OUTCOMES item */
  problems: string[];
  /** the problems that are new since the `--since` node's last start (all of them without it) */
  new_problems: string[];
  /** the recorded base came from another extractor version and was re-extracted at its commit */
  base_reextracted?: true;
  /** base and after still come from different extractors: every ghost item is not-checked */
  extractor_mismatch?: { base: string; after: string };
}

/** "<sha12>" or "<sha12> + uncommitted changes" — what a drift report's verified refers to. */
export function snapshotStamp(commit: string | null, dirty: boolean): string {
  const sha = commit === null ? "(no commit)" : commit.slice(0, 12);
  return dirty ? `${sha} + uncommitted changes` : sha;
}

/** Where a run's snapshot manifests live: runs/<id>/maps/<manifest-hash>.json (D14/13A). */
export function mapsDir(runDir: string): string {
  return join(runDir, "maps");
}

const HASH = /^[0-9a-f]{64}$/;

/** A manifest hash as the log / context carry it — refused unless it is exactly a sha256 hex. */
export function checkManifestHash(hash: string): string {
  if (!HASH.test(hash)) throw new Error(`not a manifest hash: ${JSON.stringify(hash).slice(0, 80)}`);
  return hash;
}

/**
 * A store directory named by the log: only the default store or a directory under
 * $HOWDAH_HOME is honoured — log values never steer reads anywhere else on disk.
 */
export function checkStoreDir(dir: string): string {
  const home = resolve(howdahHome());
  const d = resolve(dir);
  if (d !== resolve(new MapStore().dir) && !d.startsWith(home + sep))
    throw new Error(`map store ${dir} is neither the default store nor under $HOWDAH_HOME (${home})`);
  return d;
}

/** The object store the run's extraction of `manifestHash` wrote to (its map-extracted event), else the default. */
export function storeFor(runDir: string, manifestHash: string): MapStore {
  checkManifestHash(manifestHash);
  const logPath = join(runDir, "run.jsonl");
  const extracted = existsSync(logPath) ? readLog(logPath).findLast((e) => e.type === "map-extracted" && e.manifest_hash === manifestHash) : undefined;
  return new MapStore(extracted?.type === "map-extracted" ? checkStoreDir(extracted.store) : undefined);
}

const CACHE_MAX = 4;
const cache = new Map<string, AssembledMap>();

/** Remember an assembled snapshot (manifests and objects are immutable: it never goes stale). */
export function rememberSnapshot(store: MapStore, manifestHash: string, map: AssembledMap): AssembledMap {
  const key = `${store.dir}\0${manifestHash}`;
  cache.delete(key);
  cache.set(key, map);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return map;
}

/**
 * The assembled snapshot a run recorded under `manifestHash`, from `store` (default: the store
 * its extraction recorded). The last few are memoised. Throws when the manifest is missing.
 */
export function loadSnapshot(runDir: string, manifestHash: string, store: MapStore = storeFor(runDir, manifestHash)): AssembledMap {
  checkManifestHash(manifestHash);
  const hit = cache.get(`${store.dir}\0${manifestHash}`);
  if (hit) return rememberSnapshot(store, manifestHash, hit);
  const path = join(mapsDir(runDir), `${manifestHash}.json`);
  if (!existsSync(path)) throw new Error(`map snapshot ${manifestHash} is not recorded in ${mapsDir(runDir)}`);
  return rememberSnapshot(store, manifestHash, assemble(readManifest(path), store));
}

function git(cwd: string, args: string[], stdin?: string): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", ...(stdin !== undefined ? { stdin: new TextEncoder().encode(stdin) } : {}) });
  return { code: r.exitCode ?? 1, stdout: new TextDecoder().decode(r.stdout), stderr: new TextDecoder().decode(r.stderr) };
}

/**
 * Which of `paths` (repo-relative) git ignores in `cwd`. Tracked files are never reported
 * (git's own rule — they are extracted regardless of ignore patterns). Throws if git fails.
 */
export function gitIgnored(cwd: string, paths: readonly string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const r = git(cwd, ["check-ignore", "-z", "--stdin"], paths.join("\0") + "\0");
  if (r.code === 1) return new Set(); // none ignored
  if (r.code !== 0) throw new Error(`git check-ignore failed in ${cwd}: ${r.stderr.trim().slice(0, 200)}`);
  return new Set(r.stdout.split("\0").filter((p) => p !== ""));
}

/** The expected_files of `ghosts` that git ignores in `cwd` (a design error: never extracted). */
export function ignoredExpectedFiles(cwd: string, ghosts: Pick<GhostSet, "entities">): string[] {
  const files = [...new Set(ghosts.entities.map((e) => e.expected_file))];
  const ignored = gitIgnored(cwd, files);
  return files.filter((f) => ignored.has(f));
}

/** How many uncommitted paths a MapAfter / reason names at most. */
export const UNCOMMITTED_LIST_CAP = 20;

/**
 * The uncommitted changes the SNAPSHOT actually contains: paths that differ from HEAD (staged,
 * unstaged, or untracked and not ignored) AND that the extraction reads — a source file the map
 * extracts (languageOf) or a file the manifest lists. A stray log or scratch file changes
 * nothing the map sees, so it must not make every `verified` disappear. Sorted. Throws if git
 * fails: an unknown state must never read as "clean".
 */
export function uncommittedSourcePaths(cwd: string, manifestFiles: ReadonlySet<string> = new Set()): string[] {
  const r = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (r.code !== 0) throw new Error(`git status failed in ${cwd}: ${r.stderr.trim().slice(0, 200)}`);
  const tokens = r.stdout.split("\0");
  const paths = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const rec = tokens[i]!;
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    paths.add(rec.slice(3));
    // a rename / copy record is followed by its source path
    if (xy.includes("R") || xy.includes("C")) {
      const from = tokens[++i];
      if (from) paths.add(from);
    }
  }
  return [...paths].filter((p) => languageOf(p) !== null || manifestFiles.has(p)).sort();
}
