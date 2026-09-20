/**
 * File selection — system-map 1b, eng review D9/8A.
 *
 * Input is what git says is in the snapshot, never a directory walk:
 *   --commit <sha>  `git ls-tree -r -l <sha>` + blob contents via `git cat-file --batch`
 *   working tree    `git ls-files` (tracked) + `git ls-files --others --exclude-standard`
 *                   (untracked, not ignored), contents read from disk
 * so an ignored build dir can never leak into the map and two extractions of the same commit
 * see the same bytes.
 *
 * Skips are part of the snapshot, never silent: each is `{path, reason}` in the manifest, and
 * drift (1c) reports a ghost in a skipped file as `not-checked (skipped)`, not `missing`.
 * Only source files, lockfiles and build manifests are considered; a PNG is not "skipped",
 * it simply isn't code.
 *
 * The generated-path list is deliberately small and documented here (1b spec):
 *   any depth:        generated/ __generated__/ node_modules/ .gradle/
 *                     OpenAPI client output: openapi-client/ openapi-generated/ generated-sources/
 *   module root only: build/ dist/ target/ out/ — only directly under the repo root or a dir
 *                     holding a build manifest (build.gradle*, settings.gradle*, package.json,
 *                     pom.xml), so a source package named `build` (`web/src/build/`) is kept
 *   files:            *.min.js / *.min.mjs / *.bundle.js, *.d.ts, lockfiles (below)
 * A worktree file whose real path escapes the repo (reached through a symlinked dir) is skipped:
 * the map must never contain bytes from outside the snapshot.
 */

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { languageOf } from "./languages";
import type { Language, SkippedFile } from "./types";
import { byPath } from "./util";

export const MAX_FILE_BYTES = 1024 * 1024;

/** Generated at any depth — these names are never hand-written source. */
export const GENERATED_DIRS = ["generated", "__generated__", "node_modules", ".gradle", "openapi-client", "openapi-generated", "generated-sources"] as const;

/** Build output — generated only directly under a module root (see header). */
export const BUILD_OUTPUT_DIRS = ["build", "dist", "target", "out"] as const;

const MODULE_ROOT_FILES = ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "package.json", "pom.xml"];

export const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "gradle.lockfile",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "composer.lock",
] as const;

export const BUILD_MANIFESTS = ["settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts", "package.json", "tsconfig.json"] as const;

export interface RepoEntry {
  path: string;
  /** Bytes; null when not knowable without reading (never for regular files). */
  size: number;
  type: "file" | "symlink" | "submodule" | "outside";
  /** git blob id when extracting a commit. */
  blob?: string;
}

export interface Selection {
  sources: { path: string; language: Language; size: number }[];
  manifests: { path: string; size: number }[];
  skipped: SkippedFile[];
}

function isManifest(path: string): boolean {
  return (BUILD_MANIFESTS as readonly string[]).includes(basename(path));
}

function isLockfile(path: string): boolean {
  return (LOCKFILES as readonly string[]).includes(basename(path));
}

/** Dirs that are module roots: "" (repo root) + every dir holding a build manifest. */
export function moduleRoots(entries: RepoEntry[]): Set<string> {
  const out = new Set<string>([""]);
  for (const e of entries) {
    if (!MODULE_ROOT_FILES.includes(basename(e.path))) continue;
    const d = dirname(e.path);
    out.add(d === "." ? "" : d);
  }
  return out;
}

/** Why a candidate path is skipped, or null if it is extracted. Size checked last. */
export function skipReason(entry: RepoEntry, roots: Set<string> = new Set([""])): string | null {
  const { path } = entry;
  if (entry.type === "submodule") return "submodule";
  if (entry.type === "symlink") return "symlink";
  if (entry.type === "outside") return "symlink escapes the repository";
  if (isLockfile(path)) return "lockfile";
  const segs = path.split("/").slice(0, -1);
  const gen = segs.find((s) => (GENERATED_DIRS as readonly string[]).includes(s));
  if (gen !== undefined) return `generated path (${gen}/)`;
  const out = segs.findIndex((s, i) => (BUILD_OUTPUT_DIRS as readonly string[]).includes(s) && roots.has(segs.slice(0, i).join("/")));
  if (out >= 0) return `generated path (${segs.slice(0, out + 1).join("/")}/)`;
  if (/\.(min\.m?js|bundle\.js)$/.test(path)) return "minified bundle";
  if (/\.d\.[mc]?ts$/.test(path)) return "type declarations (.d.ts)";
  if (entry.size > MAX_FILE_BYTES) return `too large (${entry.size} bytes > ${MAX_FILE_BYTES})`;
  return null;
}

/** Split repo entries into sources to parse, manifests to hash, and recorded skips. */
export function selectFiles(entries: RepoEntry[]): Selection {
  const out: Selection = { sources: [], manifests: [], skipped: [] };
  const roots = moduleRoots(entries.filter((e) => e.type === "file"));
  for (const e of [...entries].sort(byPath)) {
    const language = languageOf(e.path);
    const relevant = language !== null || isManifest(e.path) || isLockfile(e.path) || /\.d\.[mc]?ts$/.test(e.path) || e.type === "submodule";
    if (!relevant) continue;
    const reason = skipReason(e, roots);
    if (reason !== null) out.skipped.push({ path: e.path, reason });
    else if (isManifest(e.path)) out.manifests.push({ path: e.path, size: e.size });
    else if (language !== null) out.sources.push({ path: e.path, language, size: e.size });
  }
  return out;
}

// ── git access ──────────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): Buffer {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr.toString().trim()}`);
  return Buffer.from(r.stdout);
}

function gitOptional(cwd: string, args: string[]): string | null {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

function nulSplit(buf: Buffer): string[] {
  return buf.toString("utf8").split("\0").filter((s) => s !== "");
}

export interface RepoSnapshot {
  /** The repo's top-level dir. */
  root: string;
  commit: string | null;
  source: "commit" | "worktree";
  entries: RepoEntry[];
  /** Read the given paths' bytes (paths must come from `entries`). */
  read(paths: string[]): Promise<Map<string, Uint8Array>>;
}

/** Everything git says is in the snapshot: a commit's tree, or the working tree. */
export function openRepo(repoDir: string, commit?: string): RepoSnapshot {
  const root = git(repoDir, ["rev-parse", "--show-toplevel"]).toString().trim();
  if (commit !== undefined) {
    const sha = git(root, ["rev-parse", "--verify", `${commit}^{commit}`]).toString().trim();
    const entries: RepoEntry[] = [];
    for (const rec of nulSplit(git(root, ["ls-tree", "-r", "-l", "-z", sha]))) {
      const tab = rec.indexOf("\t");
      const [mode, type, blob, size] = rec.slice(0, tab).split(/\s+/);
      const path = rec.slice(tab + 1);
      if (type === "commit") entries.push({ path, size: 0, type: "submodule" });
      else if (mode === "120000") entries.push({ path, size: Number(size ?? 0), type: "symlink" });
      else if (type === "blob" && blob !== undefined) entries.push({ path, size: Number(size ?? 0), type: "file", blob });
    }
    const byPath = new Map(entries.map((e) => [e.path, e]));
    return {
      root,
      commit: sha,
      source: "commit",
      entries,
      read: (paths) => catFileBatch(root, paths.map((p) => ({ path: p, blob: byPath.get(p)?.blob ?? "" }))),
    };
  }
  const tracked = nulSplit(git(root, ["ls-files", "-z", "--cached"]));
  const untracked = nulSplit(git(root, ["ls-files", "-z", "--others", "--exclude-standard"]));
  const entries: RepoEntry[] = [];
  const realRoot = realpathSync(root);
  for (const path of new Set([...tracked, ...untracked])) {
    let st;
    try {
      st = lstatSync(join(root, path));
    } catch {
      continue; // tracked but deleted in the working tree: not part of this snapshot
    }
    if (st.isSymbolicLink()) {
      entries.push({ path, size: 0, type: "symlink" });
      continue;
    }
    // An intermediate dir may be a symlink (lstat only checks the last component).
    let real: string;
    try {
      real = realpathSync(join(root, path));
    } catch {
      continue;
    }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) entries.push({ path, size: 0, type: "outside" });
    else if (st.isDirectory()) entries.push({ path, size: 0, type: "submodule" });
    else if (st.isFile()) entries.push({ path, size: st.size, type: "file" });
  }
  return {
    root,
    commit: gitOptional(root, ["rev-parse", "--verify", "HEAD"]),
    source: "worktree",
    entries,
    read: async (paths) => new Map(paths.map((p) => [p, new Uint8Array(readFileSync(join(root, p)))])),
  };
}

/** Read blobs in batches through one `git cat-file --batch` per batch. */
async function catFileBatch(root: string, items: { path: string; blob: string }[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const BATCH = 500;
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const proc = Bun.spawn(["git", "cat-file", "--batch"], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(chunk.map((c) => c.blob + "\n").join(""));
    await proc.stdin.end();
    const buf = Buffer.from(await new Response(proc.stdout).arrayBuffer());
    const code = await proc.exited;
    if (code !== 0) throw new Error(`git cat-file --batch failed: ${await new Response(proc.stderr).text()}`);
    let pos = 0;
    for (const c of chunk) {
      const nl = buf.indexOf(0x0a, pos);
      const header = buf.subarray(pos, nl).toString("utf8");
      const [, type, sizeStr] = header.split(" ");
      if (type !== "blob" || sizeStr === undefined) throw new Error(`git cat-file: unexpected header for ${c.path}: ${header}`);
      const size = Number(sizeStr);
      out.set(c.path, new Uint8Array(buf.subarray(nl + 1, nl + 1 + size)));
      pos = nl + 1 + size + 1;
    }
  }
  return out;
}
