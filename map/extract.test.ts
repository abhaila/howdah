import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { assemble } from "./assemble";
import { extract } from "./extract";
import { FILES_PER_WORKER, defaultPoolSize, inlineParser, type Parse } from "./pool";
import { MapStore, canonicalJson, defaultStoreDir, manifestHash, readManifest, writeManifest, writeManifestTo } from "./store";
import { commitAll, fixtureRepo } from "./testkit";
import { EXTRACTOR_VERSION, VERSIONED_SOURCES, computeExtractorVersion } from "./version";
import type { Language, Progress } from "./types";

/** A parser that counts cold parses — the spy for "the store is the parse cache". */
async function spyParser(): Promise<Parse & { calls: string[] }> {
  const inner = await inlineParser();
  const calls: string[] = [];
  return {
    calls,
    parse: (language: Language, content: string) => {
      calls.push(`${language}:${content.length}`);
      return inner.parse(language, content);
    },
    close: () => inner.close(),
  };
}

function objectFiles(storeDir: string): string[] {
  const d = join(storeDir, "objects");
  return existsSync(d) ? readdirSync(d).sort() : [];
}

const savedHome = process.env.HOWDAH_HOME;
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOWDAH_HOME;
  else process.env.HOWDAH_HOME = savedHome;
});

describe("store", () => {
  test("defaults to $HOWDAH_HOME/maps", () => {
    process.env.HOWDAH_HOME = "/tmp/howdah-home-test";
    expect(defaultStoreDir()).toBe("/tmp/howdah-home-test/maps");
  });

  test("canonical JSON sorts keys at every level, so the manifest hash ignores key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}');
  });
});

describe("extract", () => {
  test("manifest: commit, path → object key, build manifests, skips; files sorted", async () => {
    const repo = fixtureRepo();
    const res = await extract({ repoDir: repo.dir, commit: repo.commit, storeDir: repo.storeDir, workers: 0 });
    const m = res.manifest;
    expect(m.commit).toBe(repo.commit);
    expect(m.source).toBe("commit");
    expect(m.extractorVersion).toBe(EXTRACTOR_VERSION);
    expect(Object.keys(m.files)).toEqual([
      "api/src/main/kotlin/com/example/api/App.kt",
      "api/src/main/kotlin/com/example/api/Audit.kt",
      "api/src/main/kotlin/com/example/api/Handlers.kt",
      "api/src/main/kotlin/com/example/api/Main.kt",
      "api/src/main/kotlin/com/example/api/Orders.kt",
      "shared/core/src/main/java/com/example/core/Greeter.java",
      "web/src/Users.tsx",
      "web/src/api.ts",
      "web/src/config.ts",
      "web/src/legacy.ts",
    ]);
    expect(Object.keys(m.buildManifests)).toEqual(["api/build.gradle.kts", "build.gradle.kts", "settings.gradle.kts", "shared/core/build.gradle.kts", "web/package.json", "web/tsconfig.json"]);
    expect(new MapStore(repo.storeDir).readBlob(m.buildManifests["settings.gradle.kts"] ?? "")).toContain('include(":shared:core")');
    expect(m.skipped.map((s) => s.path)).toEqual(["web/dist/bundle.min.js", "web/package-lock.json", "web/src/generated/client.ts", "web/src/huge-data.ts"]);
    expect(m.notChecked).toEqual([]);
    expect(res.manifestHash).toBe(manifestHash(m));
    expect(res.stats).toMatchObject({ sources: 10, parsed: 10, cached: 0, skipped: 4, notChecked: 0 });
    // every object is immutable JSON keyed by the manifest's key
    const store = new MapStore(repo.storeDir);
    for (const key of Object.values(m.files)) expect(store.readObject(key)?.schema).toBe(1);
  });

  test("the object store is the parse cache: an unchanged second extraction parses nothing", async () => {
    const repo = fixtureRepo();
    const spy = await spyParser();
    const first = await extract({ repoDir: repo.dir, storeDir: repo.storeDir, parser: spy });
    expect(spy.calls.length).toBe(10);
    const second = await extract({ repoDir: repo.dir, storeDir: repo.storeDir, parser: spy });
    expect(spy.calls.length).toBe(10);
    expect(second.stats).toMatchObject({ parsed: 0, cached: 10 });
    expect(second.manifest).toEqual(first.manifest);
    expect(second.manifestHash).toBe(first.manifestHash);
  });

  test("two extractions (two commits) share objects; only the changed file is re-parsed", async () => {
    const repo = fixtureRepo();
    const spy = await spyParser();
    const a = await extract({ repoDir: repo.dir, commit: repo.commit, storeDir: repo.storeDir, parser: spy });
    const before = objectFiles(repo.storeDir);
    writeFileSync(join(repo.dir, "web", "src", "legacy.ts"), readFileSync(join(repo.dir, "web", "src", "legacy.ts"), "utf8") + "\nexport const extra = 1;\n");
    const c2 = commitAll(repo.dir, "change legacy");
    const b = await extract({ repoDir: repo.dir, commit: c2, storeDir: repo.storeDir, parser: spy });
    expect(spy.calls.length).toBe(11);
    expect(b.stats).toMatchObject({ parsed: 1, cached: 9 });
    const changed = Object.keys(a.manifest.files).filter((p) => a.manifest.files[p] !== b.manifest.files[p]);
    expect(changed).toEqual(["web/src/legacy.ts"]);
    expect(objectFiles(repo.storeDir).length).toBe(before.length + 1);
    expect(a.manifestHash).not.toBe(b.manifestHash);
  });

  test("progress reports {done, total, skipped} and ends at done === total", async () => {
    const repo = fixtureRepo();
    const seen: Progress[] = [];
    await extract({ repoDir: repo.dir, storeDir: repo.storeDir, workers: 0, onProgress: (p) => seen.push({ ...p }) });
    expect(seen[0]).toEqual({ done: 0, total: 10, skipped: 4 });
    expect(seen.at(-1)).toEqual({ done: 10, total: 10, skipped: 4 });
    expect(seen.map((p) => p.done)).toEqual([...seen.map((p) => p.done)].sort((x, y) => x - y));
  });

  test("a grammar that fails to load: every file of that language is not-checked, others extract, nothing is cached for it", async () => {
    const repo = fixtureRepo();
    const res = await extract({ repoDir: repo.dir, storeDir: repo.storeDir, workers: 0, grammarOverrides: { kotlin: "/nonexistent/kotlin.wasm" } });
    expect(res.manifest.notChecked.map((n) => n.path)).toEqual([
      "api/src/main/kotlin/com/example/api/App.kt",
      "api/src/main/kotlin/com/example/api/Audit.kt",
      "api/src/main/kotlin/com/example/api/Handlers.kt",
      "api/src/main/kotlin/com/example/api/Main.kt",
      "api/src/main/kotlin/com/example/api/Orders.kt",
    ]);
    for (const n of res.manifest.notChecked) expect(n.reason).toStartWith("grammar unavailable:");
    expect(Object.keys(res.manifest.files)).toHaveLength(5);
    // the next extraction with a working grammar parses exactly the not-checked files
    const spy = await spyParser();
    const again = await extract({ repoDir: repo.dir, storeDir: repo.storeDir, parser: spy });
    expect(spy.calls.length).toBe(5);
    expect(again.manifest.notChecked).toEqual([]);
  });

  test("binary content under a source extension is skipped, not parsed; a lone NUL in real source is not binary", async () => {
    const repo = fixtureRepo();
    writeFileSync(join(repo.dir, "web", "src", "blob.ts"), new Uint8Array([0x65, 0x00, 0x00, 0x00, 0xff, 0xfe, 0x66]));
    // one raw NUL inside a template literal, as in engine/replay.ts
    writeFileSync(join(repo.dir, "web", "src", "nul.ts"), "export const key = (a: string, b: string) => `${a}\u0000${b}`;\n");
    const res = await extract({ repoDir: repo.dir, storeDir: repo.storeDir, workers: 0 });
    expect(res.manifest.skipped).toContainEqual({ path: "web/src/blob.ts", reason: "binary content" });
    expect(res.manifest.files["web/src/blob.ts"]).toBeUndefined();
    expect(res.manifest.files["web/src/nul.ts"]).toBeDefined();
  });
});

describe("worker pool", () => {
  test("default size is work-proportional: in-process for small batches, at most one worker per core", () => {
    expect(defaultPoolSize(0)).toBe(0);
    expect(defaultPoolSize(FILES_PER_WORKER)).toBe(0);
    const cores = availableParallelism();
    expect(defaultPoolSize(FILES_PER_WORKER * 2 + 1)).toBe(cores >= 3 ? 3 : cores <= 1 ? 0 : cores);
    expect(defaultPoolSize(1_000_000)).toBe(cores <= 1 ? 0 : cores);
  });

  test("pool results are identical to single-threaded (manifest and every object)", async () => {
    const repo = fixtureRepo();
    const root = mkdtempSync(join(tmpdir(), "howdah-map-pool-"));
    const single = await extract({ repoDir: repo.dir, commit: repo.commit, storeDir: join(root, "single"), workers: 0 });
    const pooled = await extract({ repoDir: repo.dir, commit: repo.commit, storeDir: join(root, "pool"), workers: 3 });
    expect(pooled.manifest).toEqual(single.manifest);
    expect(pooled.manifestHash).toBe(single.manifestHash);
    const s = new MapStore(join(root, "single"));
    const p = new MapStore(join(root, "pool"));
    for (const key of Object.values(single.manifest.files)) expect(p.readObject(key)).toEqual(s.readObject(key));
    expect(objectFiles(join(root, "pool"))).toEqual(objectFiles(join(root, "single")));
  });

  test("a worker crash on one file → that file is not-checked (worker error); the rest continue", async () => {
    const repo = fixtureRepo();
    const marker = "__HOWDAH_MAP_CRASH__";
    writeFileSync(join(repo.dir, "web", "src", "config.ts"), `// ${marker}\nexport const BASE_URL = "";\n`);
    const res = await extract({ repoDir: repo.dir, storeDir: repo.storeDir, workers: 2, faults: { crashMarker: marker } });
    expect(res.manifest.notChecked).toEqual([{ path: "web/src/config.ts", reason: expect.stringMatching(/^worker error: /) as unknown as string }]);
    expect(Object.keys(res.manifest.files)).toHaveLength(9);
    expect(res.stats.notChecked).toBe(1);
  });
});

describe("manifest round trip", () => {
  test("a manifest written to disk reconstructs an identical assembled map", async () => {
    const repo = fixtureRepo();
    const store = new MapStore(repo.storeDir);
    const res = await extract({ repoDir: repo.dir, commit: repo.commit, store, workers: 0 });
    const runMaps = join(repo.storeDir, "..", "runs", "r1", "maps");
    const { path, hash } = writeManifestTo(res.manifest, runMaps);
    expect(hash).toBe(res.manifestHash);
    expect(path).toBe(join(runMaps, `${hash}.json`));
    const reread = readManifest(path);
    expect(reread).toEqual(res.manifest);
    expect(assemble(reread, store)).toEqual(assemble(res.manifest, store));
    // and a fresh extraction of the same commit reconstructs it too
    const again = await extract({ repoDir: repo.dir, commit: repo.commit, store, workers: 0 });
    expect(assemble(again.manifest, store)).toEqual(assemble(reread, store));
    expect(writeManifest(res.manifest, join(runMaps, "copy.json"))).toBe(hash);
  });

  test("an unsupported manifest schema is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-map-bad-"));
    writeFileSync(join(dir, "m.json"), JSON.stringify({ schema: 2 }));
    expect(() => readManifest(join(dir, "m.json"))).toThrow(/unsupported map manifest schema 2/);
  });
});

describe("review item 13: the extractor version is derived from the fact-shaping sources", () => {
  test("it is a hash of facts/ast/adapters/keys/types/util, and any edit to them changes it", () => {
    expect(EXTRACTOR_VERSION).toBe(computeExtractorVersion());
    expect(EXTRACTOR_VERSION).toMatch(/^map-1b\.[0-9a-f]{12}$/);
    expect(VERSIONED_SOURCES).toContain("keys.ts");
    // the comparator decides fact ordering, so it is versioned too (re-review low item)
    expect(VERSIONED_SOURCES).toContain("util.ts");
    const dir = mkdtempSync(join(tmpdir(), "howdah-map-ver-"));
    for (const f of VERSIONED_SOURCES) cpSync(join(import.meta.dir, f), join(dir, f));
    expect(computeExtractorVersion(dir)).toBe(EXTRACTOR_VERSION);
    writeFileSync(join(dir, "keys.ts"), readFileSync(join(dir, "keys.ts"), "utf8") + "\n// a normaliser tweak\n");
    expect(computeExtractorVersion(dir)).not.toBe(EXTRACTOR_VERSION);
  });
});

describe("review item 14: the pool never loops or hangs", () => {
  test("workers that keep dying before ready: capped, then every file is not-checked", async () => {
    const repo = fixtureRepo();
    const t0 = Date.now();
    const res = await extract({ repoDir: repo.dir, storeDir: repo.storeDir, workers: 2, maxStartupFailures: 2, faults: { failInit: true } });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(Object.keys(res.manifest.files)).toHaveLength(0);
    expect(res.manifest.notChecked).toHaveLength(10);
    for (const n of res.manifest.notChecked) expect(n.reason).toStartWith("worker error:");
    expect(res.manifest.notChecked.some((n) => n.reason.includes("failed to start 2 times in a row"))).toBe(true);
  });

  test("a file that never answers times out: its worker is terminated, the file is not-checked, the rest finish", async () => {
    const repo = fixtureRepo();
    const marker = "__HOWDAH_MAP_HANG__";
    writeFileSync(join(repo.dir, "web", "src", "config.ts"), `// ${marker}\nexport const BASE_URL = "";\n`);
    const res = await extract({ repoDir: repo.dir, storeDir: repo.storeDir, workers: 2, fileTimeoutMs: 1500, faults: { hangMarker: marker } });
    expect(res.manifest.notChecked).toEqual([{ path: "web/src/config.ts", reason: "worker error: timed out after 1500 ms" }]);
    expect(Object.keys(res.manifest.files)).toHaveLength(9);
  });
});

describe("review item 15: the store survives torn objects and blobs", () => {
  test("a truncated object is a cache miss (re-parsed and repaired), never a crash", async () => {
    const repo = fixtureRepo();
    const store = new MapStore(repo.storeDir);
    const first = await extract({ repoDir: repo.dir, store, workers: 0 });
    const key = first.manifest.files["web/src/api.ts"] ?? "";
    truncateSync(store.objectPath(key), 10);
    // a later run (a fresh store handle — validated objects are cached per process)
    const later = new MapStore(repo.storeDir);
    expect(later.readObject(key)).toBeNull();
    expect(later.hasObject(key)).toBe(false);
    const spy = await spyParser();
    const again = await extract({ repoDir: repo.dir, store: later, parser: spy });
    expect(spy.calls).toHaveLength(1);
    expect(again.manifest).toEqual(first.manifest);
    expect(new MapStore(repo.storeDir).readObject(key)).not.toBeNull();
  });

  test("assemble reports an unreadable object or blob as not-checked instead of throwing", async () => {
    const repo = fixtureRepo();
    const store = new MapStore(repo.storeDir);
    const res = await extract({ repoDir: repo.dir, store, workers: 0 });
    truncateSync(store.objectPath(res.manifest.files["web/src/legacy.ts"] ?? ""), 5);
    writeFileSync(join(repo.storeDir, "blobs", res.manifest.buildManifests["settings.gradle.kts"] ?? ""), "tampered");
    const map = assemble(res.manifest, new MapStore(repo.storeDir));
    expect(map.notChecked.map((n) => n.path)).toEqual(["settings.gradle.kts", "web/src/legacy.ts"]);
    expect(map.files.map((f) => f.path)).not.toContain("web/src/legacy.ts");
  });

  test("writes are first-writer-wins: an existing valid object is never replaced", async () => {
    const repo = fixtureRepo();
    const store = new MapStore(repo.storeDir);
    const res = await extract({ repoDir: repo.dir, store, workers: 0 });
    const key = res.manifest.files["web/src/api.ts"] ?? "";
    const original = readFileSync(store.objectPath(key), "utf8");
    const obj = store.readObject(key);
    if (obj === null) throw new Error("object missing");
    store.writeObject(key, { ...obj, grammar: "someone-else" });
    expect(readFileSync(store.objectPath(key), "utf8")).toBe(original);
    expect(readdirSync(join(repo.storeDir, "objects")).some((f) => f.includes(".tmp-"))).toBe(false);
  });
});

test("low: one store handle validates each object once — extract's cache check is reused by assemble", async () => {
  const repo = fixtureRepo();
  const warm = new MapStore(repo.storeDir);
  await extract({ repoDir: repo.dir, store: new MapStore(repo.storeDir), workers: 0 });
  const res = await extract({ repoDir: repo.dir, store: warm, workers: 0 });
  // delete the files: assemble must be served from the objects validated during extract
  Bun.spawnSync(["rm", "-rf", join(repo.storeDir, "objects")]);
  const map = assemble(res.manifest, warm);
  expect(map.notChecked.filter((n) => n.reason.startsWith("map object"))).toEqual([]);
  expect(map.files).toHaveLength(10);
});

describe("review item 18: extraction reads in bounded batches", () => {
  test("a tiny batch size gives the identical manifest", async () => {
    const repo = fixtureRepo();
    const root = mkdtempSync(join(tmpdir(), "howdah-map-batch-"));
    const a = await extract({ repoDir: repo.dir, commit: repo.commit, storeDir: join(root, "a"), workers: 0 });
    const b = await extract({ repoDir: repo.dir, commit: repo.commit, storeDir: join(root, "b"), workers: 0, batchSize: 3 });
    expect(b.manifest).toEqual(a.manifest);
  });
});
