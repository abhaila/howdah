/**
 * The implement-slice fixture (system-map 1c, E2E D11/10A) — shared by the map built-in tests,
 * the implement-slice graph tests, the E2E and the slice.propose eval, so they all design
 * against the same repo and the same ghost sets.
 *
 *   graphs/fixtures/slice-repo/   one http4k route (`GET /api/users/{id}` → getUser, mounted by
 *                                 Main.kt's asServer) and one web fetch calling it
 *                                 (`web/src/api.ts` getUser)
 *
 * The ticket: add `DELETE /api/users/{id}` and a web `deleteUser` that calls it.
 *   GHOSTS_V1   the backend half only (route + handler, app() mounts it, keep the GET route)
 *   COMMENT_V1  the operator's pin on v1: "the web client needs the call too"
 *   GHOSTS_V2   v1 plus the web function, its fetch site and the fe-be edge
 *   IMPLEMENT_V2 the file edits that build v2 exactly
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhostSet } from "../map/ghosts";

export const SLICE_FIXTURE_DIR = join(import.meta.dir, "fixtures", "slice-repo");

export const APP_KT = "api/src/main/kotlin/com/example/api/App.kt";
export const API_TS = "web/src/api.ts";
export const KT_BLOCK = ":api/com.example.api";

export const GET_ROUTE = "GET /api/users/{*}";
export const GET_USER_KT = "com.example.api.<top>.getUser(Request)";
export const APP_FN = "com.example.api.<top>.app()";
export const DELETE_ROUTE = "DELETE /api/users/{*}";
export const DELETE_USER_KT = "com.example.api.<top>.deleteUser(Request)";
export const DELETE_USER_TS = "web/src/api#deleteUser";
export const DELETE_FETCH = "web/src/api#deleteUser|DELETE /api/users/{*}";

export const SLICE_GOAL = "Let users delete their account: add `DELETE /api/users/{id}` next to `getUser`";
export const SLICE_WORK = "Backend route in `api/src/main/kotlin/com/example/api/App.kt`; the web client lives in `web/src/api.ts`.";

export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=slice-test", "-c", "user.email=slice@test", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

export function commitAll(dir: string, message: string): string {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

/** A fresh git repo holding the fixture, on branch main, one commit. */
export function sliceRepo(): { dir: string; commit: string } {
  const dir = join(mkdtempSync(join(tmpdir(), "howdah-slice-fixture-")), "repo");
  cpSync(SLICE_FIXTURE_DIR, dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  return { dir, commit: commitAll(dir, "fixture") };
}

export const GHOSTS_V1: GhostSet = {
  blocks: [],
  entities: [
    { id: GET_ROUTE, op: "keep", block: KT_BLOCK, kind: "route", expected_file: APP_KT },
    { id: APP_FN, op: "modify", block: KT_BLOCK, kind: "function", expected_file: APP_KT, names: ["app — mounts the new route"] },
    { id: DELETE_ROUTE, op: "add", block: KT_BLOCK, kind: "route", expected_file: APP_KT },
    { id: DELETE_USER_KT, op: "add", block: KT_BLOCK, kind: "function", expected_file: APP_KT, names: ["deleteUser"] },
  ],
  edges: [{ from: DELETE_ROUTE, to: DELETE_USER_KT, kind: "route-handler", op: "add" }],
  trace: [],
};

export const COMMENT_V1 = { entity_id: DELETE_ROUTE, text: "the web client needs a deleteUser call to this route too" };

export const GHOSTS_V2: GhostSet = {
  blocks: [],
  entities: [
    ...GHOSTS_V1.entities,
    { id: DELETE_USER_TS, op: "add", block: "web", kind: "function", expected_file: API_TS },
    { id: DELETE_FETCH, op: "add", block: "web", kind: "fetch-site", expected_file: API_TS },
  ],
  edges: [...GHOSTS_V1.edges, { from: DELETE_FETCH, to: DELETE_ROUTE, kind: "fe-be", op: "add" }],
  trace: [{ scenario: "a user deletes their account", steps: [DELETE_USER_TS, DELETE_FETCH, DELETE_ROUTE, DELETE_USER_KT] }],
};

/** The source of App.kt / api.ts after v2 is built — the GET route and getUser untouched. */
export function implementedV2(repoDir: string): Array<{ path: string; content: string }> {
  const app = readFileSync(join(repoDir, APP_KT), "utf8")
    .replace("import org.http4k.core.Method.GET\n", "import org.http4k.core.Method.DELETE\nimport org.http4k.core.Method.GET\n")
    .replace('"/users/{id}" bind GET to ::getUser,\n', '"/users/{id}" bind GET to ::getUser,\n        "/users/{id}" bind DELETE to ::deleteUser,\n')
    .concat('\nfun deleteUser(req: Request): Response {\n    val id = req.path("id") ?: "anon"\n    return Response(OK).body("deleted:$id")\n}\n');
  const api = readFileSync(join(repoDir, API_TS), "utf8").concat(
    "\nexport async function deleteUser(id: string): Promise<void> {\n  await fetch(`/api/users/${id}`, { method: \"DELETE\" });\n}\n",
  );
  return [
    { path: APP_KT, content: app },
    { path: API_TS, content: api },
  ];
}

/** Apply edits to a checkout (what the fake implement agent does in-process). */
export function applyEdits(dir: string, edits: Array<{ path: string; content: string }>): void {
  for (const e of edits) writeFileSync(join(dir, e.path), e.content);
}
