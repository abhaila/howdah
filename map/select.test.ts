import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FILE_BYTES, moduleRoots, openRepo, selectFiles, skipReason } from "./select";
import { git } from "./testkit";
import { commitAll, fixtureRepo } from "./testkit";

test("skip rules: generated dirs, minified bundles, lockfiles, .d.ts, size, symlinks, submodules", () => {
  const roots = new Set(["", "api", "web"]);
  const f = (path: string, size = 10) => skipReason({ path, size, type: "file" }, roots);
  expect(f("web/src/generated/client.ts")).toBe("generated path (generated/)");
  expect(f("api/build/classes/A.kt")).toBe("generated path (api/build/)");
  expect(f("api/build/generated-sources/A.kt")).toBe("generated path (generated-sources/)");
  expect(f("web/dist/app.js")).toBe("generated path (web/dist/)");
  expect(f("dist/x.js")).toBe("generated path (dist/)");
  expect(f("web/src/openapi-client/api.ts")).toBe("generated path (openapi-client/)");
  expect(f("node_modules/x/index.js")).toBe("generated path (node_modules/)");
  expect(f("web/public/app.min.js")).toBe("minified bundle");
  expect(f("web/package-lock.json")).toBe("lockfile");
  expect(f("bun.lock")).toBe("lockfile");
  expect(f("types/global.d.ts")).toBe("type declarations (.d.ts)");
  expect(f("web/src/big.ts", MAX_FILE_BYTES + 1)).toBe(`too large (${MAX_FILE_BYTES + 1} bytes > ${MAX_FILE_BYTES})`);
  expect(f("web/src/ok.ts", MAX_FILE_BYTES)).toBeNull();
  // a file merely NAMED like a generated dir is not skipped
  expect(f("web/src/build.ts")).toBeNull();
  // item 18: build/dist/target/out are output dirs only at a module root — a source package
  // named `build` deeper in the tree is kept
  expect(f("web/src/build/index.ts")).toBeNull();
  expect(f("api/src/main/kotlin/com/x/dist/Dist.kt")).toBeNull();
  expect(f("lib/target/Target.java")).toBeNull();
  expect(skipReason({ path: "d/a.ts", size: 1, type: "outside" })).toBe("symlink escapes the repository");
  expect(skipReason({ path: "vendor/lib", size: 0, type: "submodule" })).toBe("submodule");
  expect(skipReason({ path: "web/src/link.ts", size: 0, type: "symlink" })).toBe("symlink");
});

test("fixture selection: sources, build manifests, and every skip recorded with a reason", () => {
  const repo = fixtureRepo();
  const sel = selectFiles(openRepo(repo.dir).entries);
  expect(sel.sources.map((s) => `${s.path}:${s.language}`)).toEqual([
    "api/src/main/kotlin/com/example/api/App.kt:kotlin",
    "api/src/main/kotlin/com/example/api/Audit.kt:kotlin",
    "api/src/main/kotlin/com/example/api/Handlers.kt:kotlin",
    "api/src/main/kotlin/com/example/api/Main.kt:kotlin",
    "api/src/main/kotlin/com/example/api/Orders.kt:kotlin",
    "shared/core/src/main/java/com/example/core/Greeter.java:java",
    "web/src/Users.tsx:tsx",
    "web/src/api.ts:typescript",
    "web/src/config.ts:typescript",
    "web/src/legacy.ts:typescript",
  ]);
  expect(sel.manifests.map((m) => m.path)).toEqual(["api/build.gradle.kts", "build.gradle.kts", "settings.gradle.kts", "shared/core/build.gradle.kts", "web/package.json", "web/tsconfig.json"]);
  expect(sel.skipped).toEqual([
    { path: "web/dist/bundle.min.js", reason: "generated path (web/dist/)" },
    { path: "web/package-lock.json", reason: "lockfile" },
    { path: "web/src/generated/client.ts", reason: "generated path (generated/)" },
    { path: "web/src/huge-data.ts", reason: expect.stringMatching(/^too large \(\d+ bytes > 1048576\)$/) as unknown as string },
  ]);
});

test("working tree: untracked-not-ignored files are in, ignored files and deleted files are out", async () => {
  const repo = fixtureRepo();
  writeFileSync(join(repo.dir, ".gitignore"), "ignored/\n");
  mkdirSync(join(repo.dir, "ignored"));
  writeFileSync(join(repo.dir, "ignored", "Secret.kt"), "fun secret() = 1\n");
  writeFileSync(join(repo.dir, "web", "src", "new.ts"), "export const n = 1;\n");
  Bun.spawnSync(["rm", join(repo.dir, "web", "src", "legacy.ts")]);
  const snap = openRepo(repo.dir);
  const paths = snap.entries.map((e) => e.path);
  expect(paths).toContain("web/src/new.ts");
  expect(paths).not.toContain("ignored/Secret.kt");
  expect(paths).not.toContain("web/src/legacy.ts");
  expect(snap.source).toBe("worktree");
  expect(snap.commit).toBe(repo.commit);
  const bytes = await snap.read(["web/src/new.ts"]);
  expect(new TextDecoder().decode(bytes.get("web/src/new.ts"))).toBe("export const n = 1;\n");
});

test("--commit reads the committed bytes via git objects, not the working tree", async () => {
  const repo = fixtureRepo();
  writeFileSync(join(repo.dir, "web", "src", "config.ts"), "export const BASE_URL = 'changed';\n");
  writeFileSync(join(repo.dir, "web", "src", "untracked.ts"), "export const u = 1;\n");
  const snap = openRepo(repo.dir, repo.commit);
  expect(snap.source).toBe("commit");
  expect(snap.commit).toBe(repo.commit);
  expect(snap.entries.map((e) => e.path)).not.toContain("web/src/untracked.ts");
  const bytes = await snap.read(["web/src/config.ts", "web/src/api.ts"]);
  expect(new TextDecoder().decode(bytes.get("web/src/config.ts"))).toContain('?? ""');
  expect(new TextDecoder().decode(bytes.get("web/src/api.ts"))).toContain("export async function getUser");
  // a short ref resolves to the full sha
  expect(openRepo(repo.dir, "HEAD").commit).toBe(repo.commit);
});

test("symlinks are recorded as skipped in both modes", () => {
  const repo = fixtureRepo();
  symlinkSync("api.ts", join(repo.dir, "web", "src", "alias.ts"));
  const c = commitAll(repo.dir, "symlink");
  for (const snap of [openRepo(repo.dir), openRepo(repo.dir, c)]) {
    expect(selectFiles(snap.entries).skipped).toContainEqual({ path: "web/src/alias.ts", reason: "symlink" });
  }
});

test("a non-repo directory is a clear error", () => {
  const dir = join(fixtureRepo().storeDir, "not-a-repo");
  mkdirSync(dir, { recursive: true });
  expect(() => openRepo(dir)).toThrow(/git rev-parse --show-toplevel failed/);
});

test("module roots: the repo root plus every dir holding a build manifest", () => {
  const e = (path: string) => ({ path, size: 1, type: "file" as const });
  expect([...moduleRoots([e("package.json"), e("web/package.json"), e("api/build.gradle.kts"), e("svc/pom.xml"), e("web/src/a.ts")])].sort()).toEqual(["", "api", "svc", "web"]);
});

test("item 11: a tracked file reached through a symlinked dir that escapes the repo is skipped, never read", async () => {
  const root = mkdtempSync(join(tmpdir(), "howdah-map-escape-"));
  const outside = join(root, "outside");
  const repo = join(root, "repo");
  mkdirSync(outside);
  mkdirSync(join(repo, "d"), { recursive: true });
  writeFileSync(join(repo, "d", "a.ts"), "export const SECRET_INSIDE = 1;\n");
  writeFileSync(join(outside, "a.ts"), "export const SECRET_OUTSIDE = 1;\n");
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "x");
  // replace the tracked dir with a symlink to a directory outside the repo
  Bun.spawnSync(["rm", "-rf", join(repo, "d")]);
  symlinkSync(outside, join(repo, "d"));
  const sel = selectFiles(openRepo(repo).entries);
  expect(sel.sources.map((s) => s.path)).not.toContain("d/a.ts");
  expect(sel.skipped).toContainEqual({ path: "d/a.ts", reason: "symlink escapes the repository" });
  // a symlinked dir that stays INSIDE the repo is fine
  mkdirSync(join(repo, "real"));
  writeFileSync(join(repo, "real", "b.ts"), "export const b = 1;\n");
  symlinkSync(join(repo, "real"), join(repo, "alias"));
  git(repo, "add", "real/b.ts");
  expect(selectFiles(openRepo(repo).entries).sources.map((s) => s.path)).toContain("real/b.ts");
});
