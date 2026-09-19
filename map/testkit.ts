/**
 * Test helpers for map/ — system-map 1b golden-fixture tests.
 *
 * `fixtureRepo()` copies map/fixtures/repo into a mkdtemp dir, adds the >1 MB file (generated
 * here rather than checked in), `git init`s and commits it, so every test extracts a real git
 * snapshot exactly as a run would. `git()` commits further changes for move/share tests.
 */

import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FILE_BYTES } from "./select";

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
