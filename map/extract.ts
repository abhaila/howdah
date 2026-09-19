/**
 * Extraction — system-map slice 1b: repo snapshot → content-addressed facts → manifest.
 *
 *   openRepo (git ls-tree / ls-files, D9/8A) → selectFiles (skips recorded)
 *     → per source file: key = content + grammar + queries + adapter + extractor versions
 *       → object exists? reuse (the store IS the parse cache, D14/13A)
 *       → else parse (worker pool, D13/12A) and write the object
 *     → Manifest {commit, files: path→key, buildManifests: path→sha256, skipped, notChecked}
 *
 * The manifest is small and path-aware; the objects are large and path-free. Assembly
 * (`assemble.ts`) joins them. A file that could not be checked (grammar unavailable, worker
 * crash) is listed in `notChecked` with its reason and is NOT cached, so the next extraction
 * tries again.
 *
 * Memory is bounded: pass 1 reads files in batches only to hash them (bytes dropped), pass 2
 * re-reads just the cold files, again in batches, for parsing. A cache hit requires the object
 * to be present AND valid for these bytes; a torn object is re-parsed.
 */

import { adapterFingerprint } from "./adapters";
import { sha256 } from "./ast";
import { EXTRACTOR_VERSION } from "./facts";
import { grammarVersion, type GrammarOverrides } from "./languages";
import { createParser, type Parse, type PoolOptions } from "./pool";
import { openRepo, selectFiles } from "./select";
import { MapStore, manifestHash, objectKey } from "./store";
import type { Language, Manifest, NotCheckedFile, Progress, SkippedFile, StoredObject } from "./types";
import { byPath, cmpStr } from "./util";
import type { WorkerFaults } from "./worker";

export interface ExtractOptions {
  repoDir: string;
  /** Extract this commit from git objects; omit to extract the working tree. */
  commit?: string;
  /** Store directory (default `$HOWDAH_HOME/maps`). */
  storeDir?: string;
  store?: MapStore;
  /** Parse workers; 0 = in-process. Default: work-proportional, ≤ one per core (pool.ts). */
  workers?: number;
  grammarOverrides?: GrammarOverrides;
  /** Pool tuning (per-file timeout, startup-failure cap). */
  fileTimeoutMs?: PoolOptions["fileTimeoutMs"];
  maxStartupFailures?: PoolOptions["maxStartupFailures"];
  /** Test hook: see worker.ts. */
  faults?: WorkerFaults;
  /** Files per read batch (bounds memory). */
  batchSize?: number;
  /** Inject a parser (tests spy on cold parses with it). */
  parser?: Parse;
  onProgress?: (p: Progress) => void;
}

export interface ExtractStats {
  sources: number;
  parsed: number;
  cached: number;
  skipped: number;
  notChecked: number;
  ms: number;
}

export interface ExtractResult {
  manifest: Manifest;
  manifestHash: string;
  stats: ExtractStats;
}

const decoder = new TextDecoder("utf-8");
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Binary = not valid UTF-8, or NUL-dense. A single NUL is legal source (engine/replay.ts has one
 * in a template literal), so one NUL alone does not make a file binary.
 */
function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  let nul = 0;
  for (let i = 0; i < n; i++) if (bytes[i] === 0) nul++;
  if (nul > Math.max(1, n / 100)) return true;
  try {
    strictDecoder.decode(bytes);
    return false;
  } catch {
    return true;
  }
}

function sortedRecord<V>(entries: [string, V][]): Record<string, V> {
  return Object.fromEntries([...entries].sort((a, b) => cmpStr(a[0], b[0])));
}

const DEFAULT_BATCH = 200;

export async function extract(opts: ExtractOptions): Promise<ExtractResult> {
  const t0 = performance.now();
  const store = opts.store ?? new MapStore(opts.storeDir);
  const snap = openRepo(opts.repoDir, opts.commit);
  const sel = selectFiles(snap.entries);
  const skipped: SkippedFile[] = [...sel.skipped];
  const notChecked: NotCheckedFile[] = [];
  const batch = Math.max(1, opts.batchSize ?? DEFAULT_BATCH);

  const buildManifests: [string, string][] = [];
  const mBytes = await snap.read(sel.manifests.map((m) => m.path));
  for (const m of sel.manifests) {
    const b = mBytes.get(m.path);
    if (b !== undefined) buildManifests.push([m.path, store.writeBlob(b)]);
  }

  const fingerprints = new Map<Language, { grammar: string; queryHash: string; adapterVersion: string }>();
  const fp = (lang: Language) => {
    let f = fingerprints.get(lang);
    if (f === undefined) {
      f = { grammar: grammarVersion(lang, opts.grammarOverrides), ...adapterFingerprint(lang) };
      fingerprints.set(lang, f);
    }
    return f;
  };

  // Pass 1: hash every source (in batches), sort into cache hits and cold files.
  const files: [string, string][] = [];
  const cold: { path: string; language: Language; key: string; contentSha256: string }[] = [];
  for (let i = 0; i < sel.sources.length; i += batch) {
    const chunk = sel.sources.slice(i, i + batch);
    const bytes = await snap.read(chunk.map((s) => s.path));
    for (const s of chunk) {
      const b = bytes.get(s.path);
      if (b === undefined) continue;
      if (looksBinary(b)) {
        skipped.push({ path: s.path, reason: "binary content" });
        continue;
      }
      const contentSha256 = sha256(b);
      const f = fp(s.language);
      const key = objectKey({ contentSha256, language: s.language, grammar: f.grammar, queryHash: f.queryHash, adapterVersion: f.adapterVersion, extractorVersion: EXTRACTOR_VERSION });
      if (store.hasObject(key, contentSha256)) files.push([s.path, key]);
      else cold.push({ path: s.path, language: s.language, key, contentSha256 });
    }
  }
  skipped.sort(byPath);
  const cached = files.length;

  const total = cached + cold.length;
  let done = cached;
  const progress = () => opts.onProgress?.({ done, total, skipped: skipped.length });
  progress();

  // Pass 2: parse the cold files, re-read in batches.
  let parsed = 0;
  if (cold.length > 0) {
    const parser =
      opts.parser ??
      (await createParser({
        jobs: cold.length,
        ...(opts.workers !== undefined ? { size: opts.workers } : {}),
        ...(opts.grammarOverrides !== undefined ? { grammarOverrides: opts.grammarOverrides } : {}),
        ...(opts.faults !== undefined ? { faults: opts.faults } : {}),
        ...(opts.fileTimeoutMs !== undefined ? { fileTimeoutMs: opts.fileTimeoutMs } : {}),
        ...(opts.maxStartupFailures !== undefined ? { maxStartupFailures: opts.maxStartupFailures } : {}),
      }));
    try {
      for (let i = 0; i < cold.length; i += batch) {
        const chunk = cold.slice(i, i + batch);
        const bytes = await snap.read(chunk.map((j) => j.path));
        await Promise.all(
          chunk.map(async (job) => {
            const b = bytes.get(job.path);
            const outcome = b === undefined ? ({ ok: false, reason: "file vanished during extraction" } as const) : await parser.parse(job.language, decoder.decode(b));
            parsed++;
            if (outcome.ok) {
              const f = fp(job.language);
              const obj: StoredObject = {
                schema: 1,
                language: job.language,
                contentSha256: job.contentSha256,
                grammar: f.grammar,
                queryHash: f.queryHash,
                adapterVersion: f.adapterVersion,
                extractorVersion: EXTRACTOR_VERSION,
                facts: outcome.facts,
              };
              store.writeObject(job.key, obj);
              files.push([job.path, job.key]);
            } else notChecked.push({ path: job.path, reason: outcome.reason });
            done++;
            progress();
          }),
        );
      }
    } finally {
      if (opts.parser === undefined) await parser.close();
    }
  }
  notChecked.sort(byPath);

  const manifest: Manifest = {
    schema: 1,
    extractorVersion: EXTRACTOR_VERSION,
    commit: snap.commit,
    source: snap.source,
    files: sortedRecord(files),
    buildManifests: sortedRecord(buildManifests),
    skipped,
    notChecked,
  };
  return {
    manifest,
    manifestHash: manifestHash(manifest),
    stats: { sources: sel.sources.length, parsed, cached, skipped: skipped.length, notChecked: notChecked.length, ms: Math.round(performance.now() - t0) },
  };
}
