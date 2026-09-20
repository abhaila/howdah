/**
 * The content-addressed map store and snapshot manifests — system-map 1b, eng review D14/13A.
 *
 *   <storeDir>/objects/<key>.json   immutable per-file facts (StoredObject); doubles as the parse
 *                                   cache — an object that exists is never re-parsed
 *   <storeDir>/blobs/<sha256>       raw bytes of build/package manifests, so assembly can read
 *                                   settings.gradle(.kts) / package.json from the manifest alone
 *
 * key = sha256(content sha256 + language + grammar version + query-file hash + adapter version
 * + extractor version). Any of those changing gives a different key, so a stale object is never
 * read — it just stops being referenced. Objects are never pruned while a manifest references
 * them; GC is TODOS P3.
 *
 * Writes are durable and first-writer-wins: the bytes go to a unique tmp file, are fsynced, and
 * are then hard-LINKED into place (`link` fails if the name exists — it never overwrites), so
 * concurrent extractions (two runs racing on identical bytes) cannot tear or replace an object.
 * Reads are validated: a truncated, corrupt or mis-keyed object reads as `null` — the caller
 * re-parses (extract) or reports the file `not-checked` (assemble), never crashes.
 *
 * A manifest's hash is sha256 of its canonical JSON (sorted keys, no whitespace) — the
 * `manifest_hash` that decisions bind to in 1a (D15).
 */

import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { howdahHome } from "../config/config";
import { sha256 } from "./ast";
import type { Language, Manifest, StoredObject } from "./types";

export function defaultStoreDir(): string {
  return join(howdahHome(), "maps");
}

export function objectKey(parts: {
  contentSha256: string;
  language: Language;
  grammar: string;
  queryHash: string;
  adapterVersion: string;
  extractorVersion: string;
}): string {
  return sha256(JSON.stringify([parts.contentSha256, parts.language, parts.grammar, parts.queryHash, parts.adapterVersion, parts.extractorVersion]));
}

function writeTmp(path: string, data: string | Uint8Array): string {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const fd = openSync(tmp, "wx");
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return tmp;
}

/** Durable, never-overwriting create. Returns false if something already holds the name. */
function createExclusive(path: string, data: string | Uint8Array): boolean {
  const tmp = writeTmp(path, data);
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    unlinkSync(tmp);
  }
}

/** Durable replace (manifests: the path is chosen by the caller and may be rewritten). */
function durableReplace(path: string, data: string | Uint8Array): void {
  renameSync(writeTmp(path, data), path);
}

function isStoredObject(v: unknown): v is StoredObject {
  if (v === null || typeof v !== "object") return false;
  const o = v as Partial<StoredObject>;
  const f = o.facts as Record<string, unknown> | undefined;
  if (o.schema !== 1 || typeof o.language !== "string" || typeof o.contentSha256 !== "string" || f === undefined || f === null || typeof f !== "object") return false;
  return ["decls", "imports", "calls", "casts", "locals", "routes", "mounts", "serverRoots", "groups", "unparsedNames", "fetches", "queryHooks", "coverage", "unparsed"].every((k) => Array.isArray(f[k]));
}

export class MapStore {
  /**
   * Objects validated during this process, by key. Objects are immutable, so a validated read
   * never goes stale: the cache hit check in extract and the read in assemble parse each object
   * once per run instead of twice.
   */
  private readonly validated = new Map<string, StoredObject>();

  constructor(readonly dir: string = defaultStoreDir()) {}

  objectPath(key: string): string {
    return join(this.dir, "objects", `${key}.json`);
  }

  /** A cache hit only if the object is present AND valid (a torn object is a miss, re-parsed). */
  hasObject(key: string, expectSha256?: string): boolean {
    return (this.validated.has(key) || existsSync(this.objectPath(key))) && this.readObject(key, expectSha256) !== null;
  }

  /**
   * Write once: an existing VALID object with this key is identical by construction and kept;
   * an existing invalid one (torn by a crash) is removed and replaced.
   */
  writeObject(key: string, obj: StoredObject): void {
    const path = this.objectPath(key);
    const text = JSON.stringify(obj);
    if (createExclusive(path, text)) {
      this.validated.set(key, obj);
      return;
    }
    if (this.readObject(key) !== null) return;
    try {
      unlinkSync(path);
    } catch {
      // raced with another repairer
    }
    createExclusive(path, text);
  }

  /** The object, or null if missing / unreadable / not a valid StoredObject. */
  readObject(key: string, expectSha256?: string): StoredObject | null {
    let v: unknown = this.validated.get(key);
    if (v === undefined) {
      try {
        v = JSON.parse(readFileSync(this.objectPath(key), "utf8"));
      } catch {
        return null;
      }
      if (!isStoredObject(v)) return null;
      this.validated.set(key, v);
    }
    const obj = v as StoredObject;
    if (expectSha256 !== undefined && obj.contentSha256 !== expectSha256) return null;
    return obj;
  }

  writeBlob(bytes: Uint8Array): string {
    const sha = sha256(bytes);
    const path = join(this.dir, "blobs", sha);
    if (!createExclusive(path, bytes) && this.readBlob(sha) === null) {
      unlinkSync(path);
      createExclusive(path, bytes);
    }
    return sha;
  }

  /** Blob text, or null if missing or its bytes no longer hash to `sha`. */
  readBlob(sha: string): string | null {
    let b: Buffer;
    try {
      b = readFileSync(join(this.dir, "blobs", sha));
    } catch {
      return null;
    }
    return sha256(b) === sha ? b.toString("utf8") : null;
  }
}

/** JSON with object keys sorted at every level — the input to every hash in this module. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  });
}

export function manifestHash(m: Manifest): string {
  return sha256(canonicalJson(m));
}

/** Write a manifest (canonical JSON) to `path`; returns its hash. */
export function writeManifest(m: Manifest, path: string): string {
  const text = canonicalJson(m);
  durableReplace(path, text);
  return sha256(text);
}

/** Write to `<dir>/<manifest-hash>.json` — the `runs/<run-id>/maps/` layout from the design. */
export function writeManifestTo(m: Manifest, dir: string): { path: string; hash: string } {
  const hash = manifestHash(m);
  const path = join(dir, `${hash}.json`);
  writeManifest(m, path);
  return { path, hash };
}

export function readManifest(path: string): Manifest {
  const m = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  if (m.schema !== 1) throw new Error(`unsupported map manifest schema ${String(m.schema)} in ${path}`);
  return m;
}
