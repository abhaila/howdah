import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fixtureRepo } from "./testkit";
import type { AssembledMap } from "./types";

const CLI = join(import.meta.dir, "cli.ts");

function run(args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

test("prints counts per entity kind, skips, unparsed, not-checked and coverage", () => {
  const repo = fixtureRepo();
  const manifests = join(repo.storeDir, "..", "manifests");
  const r = run([repo.dir, "--commit", repo.commit, "--store", repo.storeDir, "--workers", "0", "--manifest-out", manifests]);
  expect(r.code).toBe(0);
  expect(r.out).toContain(`commit ${repo.commit.slice(0, 12)}`);
  expect(r.out).toContain("entities    47  (function=36 fetch-site=6 route=5)  ambiguous=2");
  expect(r.out).toContain("edges       17  (call=8 route-handler=5 fe-be=3 import=1)");
  expect(r.out).toContain("fe→be joins 6  (exact=3 pattern-match=2 unresolved=1)");
  expect(r.out).toMatch(/skipped {5}4 {2}\(/);
  expect(r.out).toContain("unparsed    1 regions in 1 files");
  expect(r.out).toContain("not-checked 0");
  expect(r.out).toContain("coverage    http4k@3: 3 full, 2 partial (covers route)");
  expect(r.out).toContain("partial api/src/main/kotlin/com/example/api/App.kt: mounted `adminRoutes` has a routes group but no route with a literal path (+1)");
  expect(r.out).toMatch(/timing {6}extract \d+ ms \(10 parsed, 0 cached\)/);
  expect(readdirSync(manifests)).toHaveLength(1);
  // second run is fully cached
  expect(run([repo.dir, "--commit", repo.commit, "--store", repo.storeDir, "--workers", "0"]).out).toContain("(0 parsed, 10 cached)");
});

test("--json prints the assembled map", () => {
  const repo = fixtureRepo();
  const r = run([repo.dir, "--store", repo.storeDir, "--workers", "0", "--json"]);
  expect(r.code).toBe(0);
  const map = JSON.parse(r.out) as AssembledMap;
  expect(map.entities.length).toBe(47);
  expect(map.commit).toBe(repo.commit);
});

test("bad arguments exit 2 with usage", () => {
  expect(run([]).code).toBe(2);
  expect(run(["x", "--workers", "-1"]).err).toContain("--workers must be a non-negative integer");
  expect(run(["x", "--bogus"]).err).toContain("unknown argument --bogus");
});
