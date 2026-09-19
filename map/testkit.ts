/**
 * Test helpers for map/ — system-map 1b golden-fixture tests.
 *
 * `fixtureRepo()` copies map/fixtures/repo into a mkdtemp dir, adds the >1 MB file (generated
 * here rather than checked in), `git init`s and commits it, so every test extracts a real git
 * snapshot exactly as a run would. `git()` commits further changes for move/share tests.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemble } from "./assemble";
import { extract } from "./extract";
import { MAX_FILE_BYTES } from "./select";
import { MapStore } from "./store";
import type { AssembledMap } from "./types";

export const FIXTURE_DIR = join(import.meta.dir, "fixtures", "repo");

export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=map-test", "-c", "user.email=map@test", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

export function commitAll(dir: string, message: string): string {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

export interface FixtureRepo {
  dir: string;
  commit: string;
  storeDir: string;
}

export function fixtureRepo(): FixtureRepo {
  const root = mkdtempSync(join(tmpdir(), "howdah-map-"));
  const dir = join(root, "repo");
  cpSync(FIXTURE_DIR, dir, { recursive: true });
  // >1 MB source file: skipped with a recorded reason, never parsed.
  const big = "export const blob = [\n" + '  "0123456789abcdef0123456789abcdef",\n'.repeat(Math.ceil((MAX_FILE_BYTES + 1024) / 38)) + "];\n";
  writeFileSync(join(dir, "web", "src", "huge-data.ts"), big);
  git(dir, "init", "-q");
  const commit = commitAll(dir, "fixture");
  return { dir, commit, storeDir: join(root, "store") };
}

export interface SliceFixture {
  repo: FixtureRepo;
  base: AssembledMap;
  after: AssembledMap;
  afterCommit: string;
}

const API = "api/src/main/kotlin/com/example/api/";

/**
 * 1c drift fixture: the fixture repo (base) plus one "implementation" commit (after), both really
 * extracted. The after commit, relative to base:
 *   - App.kt        createUser(Request) and getUser(Request) bodies edited
 *   - Handlers.kt   health(Request) edited to call a new top-level ping(Request)
 *   - api.ts        listThings (and its fetch site) deleted
 *   - Users.tsx     UserCard no longer calls getUser (its queryFn changed)
 *   - Greeter.java  format(int,int) edited (a different block: unrelated churn)
 *   - v2/Status.kt  new file in a new package → new block `:api/com.example.api.v2`
 * Memoised: every 1c test file shares one extraction.
 */
let slice: Promise<SliceFixture> | undefined;
export function sliceFixture(): Promise<SliceFixture> {
  slice ??= (async () => {
    const repo = fixtureRepo();
    const store = new MapStore(repo.storeDir);
    const mapAt = async (commit: string) => assemble((await extract({ repoDir: repo.dir, store, workers: 0, commit })).manifest, store);
    const base = await mapAt(repo.commit);
    const edit = (p: string, f: (s: string) => string) => {
      const before = readFileSync(join(repo.dir, p), "utf8");
      const next = f(before);
      if (next === before) throw new Error(`sliceFixture: edit to ${p} changed nothing`);
      writeFileSync(join(repo.dir, p), next);
    };
    edit(API + "App.kt", (s) => s.replace("helper(1).toString()", "helper(2).toString()").replace('User(id ?: "anon")', 'User(id ?: "nobody")'));
    edit(API + "Handlers.kt", (s) => s.replace('val raw: Any = "ok"', 'ping(req)\n    val raw: Any = "fine"') + "\nfun ping(req: Request): Response = Response(OK)\n");
    edit("web/src/api.ts", (s) => s.replace(/export function listThings[\s\S]*?\n}\n/, ""));
    edit("web/src/Users.tsx", (s) => s.replace("queryFn: () => getUser(id)", "queryFn: () => Promise.resolve(null)"));
    edit("shared/core/src/main/java/com/example/core/Greeter.java", (s) => s.replace(/(format\([^)]*\)\s*\{)/, "$1\n    int unused = 0;"));
    mkdirSync(join(repo.dir, API, "v2"), { recursive: true });
    writeFileSync(join(repo.dir, API, "v2/Status.kt"), 'package com.example.api.v2\n\nfun status(): String = "ok"\n');
    const afterCommit = commitAll(repo.dir, "after");
    return { repo, base, after: await mapAt(afterCommit), afterCommit };
  })();
  return slice;
}
