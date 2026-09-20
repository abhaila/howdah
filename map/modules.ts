/**
 * Module membership for assembly — system-map 1b, identity keys (eng review D8/7A).
 *
 * A block is a repo-relative MODULE, not a file: for JVM code that is the Gradle project that
 * owns the file (from settings.gradle(.kts) `include(":a:b")`, dir `a/b`, or an explicit
 * `project(":x").projectDir = file("dir")`) plus the package; for TS it is the nearest
 * package.json dir. Moving a file between Gradle modules therefore changes its block even when
 * its bytes (and so its object) are identical.
 *
 * Settings are read syntactically (regex over the script, comments stripped). Anything cleverer
 * (computed includes, `includeBuild` composites) falls back to the root project — the block is
 * still deterministic, just coarser.
 */

import { dirname, posix } from "node:path";

export interface GradleBuild {
  /** Repo-relative dir of the settings file; "" for the repo root. */
  root: string;
  /** Included projects: Gradle path (`:shared:core`) → repo-relative project dir. */
  projects: { path: string; dir: string }[];
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function normGradlePath(p: string): string {
  const t = p.trim();
  return t.startsWith(":") ? t : `:${t}`;
}

/** Parse a settings.gradle(.kts) script: included project paths and projectDir overrides. */
export function parseSettings(text: string): { includes: string[]; projectDirs: Map<string, string> } {
  const src = stripComments(text);
  const includes: string[] = [];
  const includeRe = /\binclude\s*(\(([^)]*)\)|((?:\s*["'][^"'\n]+["']\s*,?)+))/g;
  for (const m of src.matchAll(includeRe)) {
    const body = m[2] ?? m[3] ?? "";
    for (const s of body.matchAll(/["']([^"'\n]+)["']/g)) if (s[1] !== undefined) includes.push(normGradlePath(s[1]));
  }
  const projectDirs = new Map<string, string>();
  const dirRe = /project\s*\(\s*["']([^"']+)["']\s*\)\s*\.projectDir\s*=\s*(?:file\s*\(\s*)?["']([^"']+)["']/g;
  for (const m of src.matchAll(dirRe)) if (m[1] !== undefined && m[2] !== undefined) projectDirs.set(normGradlePath(m[1]), m[2].replace(/^\.\//, "").replace(/\/$/, ""));
  return { includes: [...new Set(includes)], projectDirs };
}

export function gradleBuilds(settings: { path: string; text: string }[]): GradleBuild[] {
  return settings
    .map(({ path, text }) => {
      const d = dirname(path);
      const root = d === "." ? "" : d;
      const { includes, projectDirs } = parseSettings(text);
      const projects = includes.map((p) => {
        const rel = projectDirs.get(p) ?? p.slice(1).split(":").join("/");
        return { path: p, dir: root === "" ? rel : posix.join(root, rel) };
      });
      return { root, projects };
    })
    .sort((a, b) => b.root.length - a.root.length);
}

function under(file: string, dir: string): boolean {
  return dir === "" || file.startsWith(dir + "/");
}

/** The Gradle build + project that owns a JVM file (deepest match wins). */
export function jvmModuleOf(file: string, builds: GradleBuild[]): { buildRoot: string; gradlePath: string } {
  const build = builds.find((b) => under(file, b.root));
  if (build === undefined) return { buildRoot: "", gradlePath: ":" };
  let best: { path: string; dir: string } | undefined;
  for (const p of build.projects) if (under(file, p.dir) && (best === undefined || p.dir.length > best.dir.length)) best = p;
  return { buildRoot: build.root, gradlePath: best?.path ?? ":" };
}

/** Nearest ancestor dir holding a package.json ("" for the repo root). */
export function tsPackageDirOf(file: string, packageJsonPaths: string[]): string {
  let best = "";
  let found = false;
  for (const p of packageJsonPaths) {
    const d = dirname(p);
    const dir = d === "." ? "" : d;
    if (under(file, dir) && (!found || dir.length > best.length)) {
      best = dir;
      found = true;
    }
  }
  return best;
}

// ── project identity and generated sources (MountResolver U10) ──────────────

export interface ProjectInfo {
  /** Build root + Gradle path (`:app`, `backend:lib`) — the key used across map/. */
  key: string;
  buildFile: string | null;
  /** Why generated sources may exist that the snapshot cannot see (ksp/kapt/generated srcDir). */
  generated: string | null;
}

/**
 * Per Gradle project: its build file and whether it generates sources. Build-script DEPENDENCIES
 * are deliberately not read: cross-project resolution is out of scope for slice 1 (SCIP, slice
 * 2), so nothing here needs the dependency graph. Comments are stripped before matching, and a
 * root script's `allprojects`/`subprojects` configuration counts for every project. Test source
 * sets share their project's key (a test declaration counts as a candidate for main code): that
 * costs recall, never precision.
 */
export function projectInfos(builds: GradleBuild[], buildFiles: Map<string, string | null>): Map<string, ProjectInfo> {
  const out = new Map<string, ProjectInfo>();
  const effective = builds.length > 0 ? builds : [{ root: "", projects: [] }];
  for (const b of effective) {
    const file = (dir: string) => {
      for (const name of ["build.gradle.kts", "build.gradle"]) {
        const p = dir === "" ? name : `${dir}/${name}`;
        if (buildFiles.has(p)) return p;
      }
      return null;
    };
    const textOf = (f: string | null) => (f === null ? "" : stripComments(buildFiles.get(f) ?? ""));
    const rootText = textOf(file(b.root));
    const shared = /\b(allprojects|subprojects)\s*\{/.test(rootText) ? rootText : "";
    for (const proj of [{ path: ":", dir: b.root }, ...b.projects]) {
      const key = `${b.root}${proj.path}`;
      const bf = file(proj.dir);
      const all = `${textOf(bf)}\n${shared}`;
      const gen = /\b(ksp|kapt)\b/.exec(all)?.[1] ?? (/srcDirs?\s*\(?[^\n)]*generated/.test(all) ? "a generated srcDir" : null);
      out.set(key, { key, buildFile: bf, generated: gen === null ? null : `project ${proj.path} (${bf ?? "build file"}) uses ${gen}: generated sources are not in the snapshot` });
    }
  }
  return out;
}
