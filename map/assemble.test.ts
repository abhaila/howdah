import { beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assemble } from "./assemble";
import { extract } from "./extract";
import { parseKey } from "./keys";
import { gradleBuilds, jvmModuleOf, parseSettings, tsPackageDirOf } from "./modules";
import { MapStore } from "./store";
import { commitAll, fixtureRepo, git, type FixtureRepo } from "./testkit";
import type { AssembledMap } from "./types";

const GOLDEN = join(import.meta.dir, "fixtures", "golden", "assembled.json");

async function mapOf(repo: FixtureRepo, commit?: string): Promise<AssembledMap> {
  const store = new MapStore(repo.storeDir);
  const res = await extract({ repoDir: repo.dir, store, workers: 0, ...(commit !== undefined ? { commit } : {}) });
  return assemble(res.manifest, store);
}

const entity = (m: AssembledMap, key: string) => m.entities.filter((e) => e.key === key);
const keysOf = (m: AssembledMap, kind: string) => m.entities.filter((e) => e.kind === kind).map((e) => e.key);

let repo: FixtureRepo;
let map: AssembledMap;
beforeAll(async () => {
  repo = fixtureRepo();
  map = await mapOf(repo, repo.commit);
});

describe("golden", () => {
  test("the assembled fixture map matches the golden snapshot (UPDATE_GOLDEN=1 to rewrite)", () => {
    // commit, hashes and the derived extractor version change with every edit; the facts must not
    const { manifestHash: _h, commit: _c, extractorVersion: _v, files, ...rest } = map;
    const stable = { ...rest, files: files.map(({ objectKey: _k, ...f }) => f) };
    const text = JSON.stringify(stable, null, 2) + "\n";
    if (process.env.UPDATE_GOLDEN === "1") {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, text);
    }
    // a missing golden is a failure, never silently created
    if (!existsSync(GOLDEN)) throw new Error(`golden snapshot missing: ${GOLDEN} — run UPDATE_GOLDEN=1 bun test map/assemble.test.ts and review it`);
    expect(text).toBe(readFileSync(GOLDEN, "utf8"));
  });

  test("every assembled key — block, entity, edge — parses under the key grammar", () => {
    for (const k of [...map.blocks.map((b) => b.key), ...map.entities.map((e) => e.key), ...map.edges.map((e) => e.key)]) {
      const r = parseKey(k);
      if (!r.ok) throw new Error(`${k}: ${r.error}`);
    }
  });
});

describe("blocks and module membership", () => {
  test("JVM blocks are Gradle project + package; TS blocks are the package.json dir", () => {
    expect(map.blocks.map((b) => [b.key, b.files.length])).toEqual([
      [":api/com.example.api", 5],
      [":shared:core/com.example.core", 1],
      ["web", 4],
    ]);
    const api = map.blocks.find((b) => b.key === ":api/com.example.api");
    expect(api).toMatchObject({ family: "jvm", buildRoot: "", gradleProject: ":api", package: "com.example.api", tier: "syntactic" });
  });

  test("moving a file between Gradle modules changes its block, not its object", async () => {
    const r = fixtureRepo();
    const before = await mapOf(r);
    const from = "shared/core/src/main/java/com/example/core/Greeter.java";
    const to = "api/src/main/java/com/example/core/Greeter.java";
    mkdirSync(dirname(join(r.dir, to)), { recursive: true });
    renameSync(join(r.dir, from), join(r.dir, to));
    const c = commitAll(r.dir, "move Greeter into :api");
    const after = await mapOf(r, c);
    const b = before.files.find((f) => f.path === from);
    const a = after.files.find((f) => f.path === to);
    expect(b?.block).toBe(":shared:core/com.example.core");
    expect(a?.block).toBe(":api/com.example.core");
    expect(a?.objectKey).toBe(b?.objectKey);
    // the function key is package-based, so it survives the move; its block does not
    expect(entity(after, "com.example.core.Greeter.format(int,int)")[0]?.block).toBe(":api/com.example.core");
  });

  test("identical bytes at two paths are two entities sharing one object", async () => {
    const r = fixtureRepo();
    cpSync(join(r.dir, "web/src/legacy.ts"), join(r.dir, "web/src/legacy-copy.ts"));
    const c = commitAll(r.dir, "copy");
    const m = await mapOf(r, c);
    const orig = m.files.find((f) => f.path === "web/src/legacy.ts");
    const copy = m.files.find((f) => f.path === "web/src/legacy-copy.ts");
    expect(copy?.objectKey).toBe(orig?.objectKey);
    expect(entity(m, "web/src/legacy#unbox")).toHaveLength(1);
    expect(entity(m, "web/src/legacy-copy#unbox")).toHaveLength(1);
    expect(entity(m, "web/src/legacy-copy#unbox")[0]?.evidence).toBe("web/src/legacy-copy.ts:5");
  });
});

describe("identity keys", () => {
  test("JVM functions: overloads with the same arity are distinct; extension, top-level, nested, companion, generics", () => {
    const fns = keysOf(map, "function");
    for (const k of [
      "com.example.api.Renderer.render(User)",
      "com.example.api.Renderer.render(Order)",
      "com.example.api.<ext String>.slugify()",
      "com.example.api.<top>.health(Request)",
      "com.example.api.Renderer.Inner.describe(Map<String,Int>)",
      "com.example.api.Renderer.Companion.create()",
      "com.example.api.Renderer.page(List<T>,Int)",
      "com.example.core.Greeter.greet(Object)",
      "com.example.core.Greeter.greet(Map<String,List<Integer>>,int)",
      "com.example.core.Greeter.<init>(String)",
      "com.example.core.Greeter.Nested.run(String...)",
    ]) {
      expect(fns).toContain(k);
    }
    expect(entity(map, "com.example.api.Renderer.render(User)")[0]?.ambiguous).toBeUndefined();
  });

  test("TS functions: module#export and module#Class.member; default export", () => {
    const fns = keysOf(map, "function");
    for (const k of ["web/src/api#getUser", "web/src/api#createUser", "web/src/api#ApiClient.health", "web/src/Users#UserCard", "web/src/Users#default", "web/src/legacy#unbox"]) expect(fns).toContain(k);
  });

  test("routes and fetch sites", () => {
    expect(keysOf(map, "route")).toEqual(["DELETE /api/v1/orders/{*}", "GET /api/users/{*}", "GET /health", "GET /shop/orders", "POST /api/users"]);
    expect(keysOf(map, "fetch-site")).toEqual([
      "web/src/api#ApiClient.health|GET /health",
      "web/src/api#createUser|POST /api/users",
      "web/src/api#deleteOrder|DELETE {*}/orders/{*}",
      "web/src/api#fetchAnything|GET {*}",
      "web/src/api#getUser|GET /api/users/{*}",
      "web/src/api#listThings|GET /api/{*}/list",
    ]);
  });

  test("collisions: every duplicate is ambiguous, and so is every edge touching one", () => {
    const helpers = entity(map, "com.example.api.<top>.helper(Int)");
    expect(helpers.map((h) => h.file)).toEqual(["api/src/main/kotlin/com/example/api/App.kt", "api/src/main/kotlin/com/example/api/Handlers.kt"]);
    expect(helpers.every((h) => h.ambiguous === true)).toBe(true);
    const e = map.edges.find((x) => x.to === "com.example.api.<top>.helper(Int)");
    expect(e?.ambiguous).toBe(true);
    expect(map.entities.filter((x) => x.ambiguous === true)).toHaveLength(2);
  });

  test("duplicate fetch sites in one function collide too", async () => {
    const r = fixtureRepo();
    writeFileSync(join(r.dir, "web/src/dupe.ts"), `export function twice() {\n  fetch("/health");\n  fetch("/health");\n}\n`);
    const m = await mapOf(r, commitAll(r.dir, "dupe"));
    const sites = entity(m, "web/src/dupe#twice|GET /health");
    expect(sites.map((s) => [s.line, s.ambiguous])).toEqual([
      [2, true],
      [3, true],
    ]);
  });

  test("every entity carries tier `syntactic` and evidence file:line", () => {
    for (const e of map.entities) {
      expect(e.tier).toBe("syntactic");
      expect(e.evidence).toBe(`${e.file}:${e.line}`);
    }
    expect(entity(map, "GET /api/users/{*}")[0]?.evidence).toBe("api/src/main/kotlin/com/example/api/App.kt:16");
  });
});

describe("edges and joins", () => {
  test("route → handler, calls resolved by scope, TS calls through imports, react-query references, block imports", () => {
    const edges = map.edges.map((e) => e.key);
    for (const k of [
      "GET /health→com.example.api.<top>.health(Request):route-handler",
      "GET /api/users/{*}→com.example.api.<top>.getUser(Request):route-handler",
      "POST /api/users→com.example.api.<top>.createUser(Request):route-handler",
      "DELETE /api/v1/orders/{*}→com.example.api.<top>.deleteOrder(Request):route-handler",
      "GET /shop/orders→com.example.api.<top>.listOrders(Request):route-handler",
      "com.example.api.<top>.main()→com.example.api.<top>.app(Greeter):call",
      "com.example.core.Greeter.greet(Map<String,List<Integer>>,int)→com.example.core.Greeter.format(int,int):call",
      "web/src/Users#UserCard→web/src/api#getUser:call",
      "web/src/Users#UserCard→web/src/api#createUser:call",
      ":api/com.example.api→:shared:core/com.example.core:import",
    ]) {
      expect(edges).toContain(k);
    }
    // a receiver call we cannot resolve syntactically is NOT an edge
    expect(edges.some((k) => k.includes("Renderer.render"))).toBe(false);
    // nor is a call inside a Kotlin lambda (an implicit receiver may own it)
    expect(edges).not.toContain("com.example.api.<top>.app(Greeter)→com.example.api.<top>.getUser(Request):call");
    for (const e of map.edges) expect(e.tier).toBe("syntactic");
  });

  test("FE→BE join: exact becomes an fe-be edge; pattern-match(N) and unresolved never do", () => {
    const byStatus = (s: string) => map.joins.filter((j) => j.status === s).map((j) => j.fetchSite);
    expect(byStatus("exact")).toEqual(["web/src/api#ApiClient.health|GET /health", "web/src/api#createUser|POST /api/users", "web/src/api#getUser|GET /api/users/{*}"]);
    expect(map.joins.filter((j) => j.status === "pattern-match").map((j) => [j.fetchSite, j.candidates, j.reason])).toEqual([
      ["web/src/api#deleteOrder|DELETE {*}/orders/{*}", ["DELETE /api/v1/orders/{*}"], "base URL is non-literal (BASE_URL); 1 candidate"],
      ["web/src/api#listThings|GET /api/{*}/list", ["GET /api/users/{*}"], "dynamic path segments; 1 candidate"],
    ]);
    expect(map.joins.find((j) => j.status === "unresolved")).toMatchObject({ fetchSite: "web/src/api#fetchAnything|GET {*}", reason: "URL is a non-literal expression: url", tier: "unresolved" });
    const feBe = map.edges.filter((e) => e.kind === "fe-be").map((e) => e.key);
    expect(feBe).toEqual([
      "web/src/api#ApiClient.health|GET /health→GET /health:fe-be",
      "web/src/api#createUser|POST /api/users→POST /api/users:fe-be",
      "web/src/api#getUser|GET /api/users/{*}→GET /api/users/{*}:fe-be",
    ]);
    for (const j of map.joins) expect(j.tier).toBe(j.status === "exact" ? "syntactic" : "unresolved");
  });
});

describe("inventories carried into the map", () => {
  test("coverage per file per adapter, with evidence for partial reasons", () => {
    const partial = map.coverage.filter((c) => c.status === "partial").map((c) => [c.file, c.adapter, c.reasons.map((r) => r.evidence)]);
    expect(partial).toEqual([
      ["api/src/main/kotlin/com/example/api/App.kt", "http4k", ["api/src/main/kotlin/com/example/api/App.kt:22", "api/src/main/kotlin/com/example/api/App.kt:27"]],
      ["api/src/main/kotlin/com/example/api/Audit.kt", "http4k", ["api/src/main/kotlin/com/example/api/Audit.kt:7"]],
      ["web/src/api.ts", "fetch", ["web/src/api.ts:27"]],
    ]);
    // the cross-file mount resolved, so Orders.kt stays full
    expect(map.coverage.find((c) => c.file.endsWith("Orders.kt"))?.status).toBe("full");
    expect(map.coverage.find((c) => c.file === "api/src/main/kotlin/com/example/api/Handlers.kt")?.status).toBe("full");
    expect(map.adapters.map((a) => [a.name, a.covers])).toEqual([
      ["http4k", ["route"]],
      ["fetch", ["fetch-site"]],
      ["react-query", ["query-hook"]],
    ]);
  });

  test("unparsed regions, casts, names, skips", () => {
    expect(map.unparsed).toEqual([{ file: "api/src/main/kotlin/com/example/api/Audit.kt", evidence: "api/src/main/kotlin/com/example/api/Audit.kt:7", startLine: 7, endLine: 12, kind: "error" }]);
    expect(map.casts.map((c) => `${c.evidence} ${c.kind}`)).toContain("shared/core/src/main/java/com/example/core/Greeter.java:14 cast");
    expect(map.casts).toHaveLength(9);
    expect(map.names.find((n) => n.name === "maybe")).toEqual({ file: "api/src/main/kotlin/com/example/api/Handlers.kt", name: "maybe", line: 38, enclosing: "com.example.api.<top>.health(Request)" });
    expect(map.skipped.map((s) => s.path)).toContain("web/src/huge-data.ts");
  });
});

describe("modules", () => {
  test("settings.gradle(.kts): Kotlin and Groovy include forms, projectDir overrides, comments", () => {
    expect(parseSettings(`rootProject.name = "x"\ninclude(":a", ":b:c")\ninclude("d")\n// include(":commented")\nincludeBuild("tools")\n`)).toEqual({ includes: [":a", ":b:c", ":d"], projectDirs: new Map() });
    expect(parseSettings(`include ':a', ':b'\nproject(':b').projectDir = file('libs/b')\n`)).toEqual({ includes: [":a", ":b"], projectDirs: new Map([[":b", "libs/b"]]) });
  });

  test("deepest build root and longest project dir win; unknown files fall back to the root project", () => {
    const builds = gradleBuilds([
      { path: "settings.gradle.kts", text: `include(":api")` },
      { path: "backend/settings.gradle.kts", text: `include(":core", ":core:db")` },
    ]);
    expect(jvmModuleOf("api/src/A.kt", builds)).toEqual({ buildRoot: "", gradlePath: ":api" });
    expect(jvmModuleOf("tools/B.kt", builds)).toEqual({ buildRoot: "", gradlePath: ":" });
    expect(jvmModuleOf("backend/core/db/src/C.kt", builds)).toEqual({ buildRoot: "backend", gradlePath: ":core:db" });
    expect(jvmModuleOf("backend/core/src/D.kt", builds)).toEqual({ buildRoot: "backend", gradlePath: ":core" });
    expect(jvmModuleOf("x/E.kt", [])).toEqual({ buildRoot: "", gradlePath: ":" });
  });

  test("TS package dir is the nearest package.json", () => {
    const pj = ["package.json", "web/package.json", "web/packages/ui/package.json"];
    expect(tsPackageDirOf("web/packages/ui/src/a.ts", pj)).toBe("web/packages/ui");
    expect(tsPackageDirOf("web/src/a.ts", pj)).toBe("web");
    expect(tsPackageDirOf("scripts/a.ts", pj)).toBe("");
    expect(tsPackageDirOf("scripts/a.ts", [])).toBe("");
  });
});

// ── review fixes: cross-file facts ─────────────────────────────────────────

const KT_API = "api/src/main/kotlin/com/example/api";
const HTTP4K = "import org.http4k.core.Method.GET\nimport org.http4k.routing.bind\nimport org.http4k.routing.routes\n";

describe("review item 1: http4k mount prefixes across files", () => {
  test("a group mounted from another file gets the mounter's prefix; the fixture proves it (GET /shop/orders)", () => {
    const r = entity(map, "GET /shop/orders")[0];
    expect(r?.file).toBe(`${KT_API}/Orders.kt`);
    expect(r?.route?.path).toBe("/shop/orders");
  });

  test("an unmounted group in a separate file is keyed {*}/… and its file is partial with the reason", async () => {
    const r = fixtureRepo();
    writeFileSync(join(r.dir, KT_API, "Orphan.kt"), `package com.example.api\n\n${HTTP4K}\nfun orphanRoutes() = routes(\n    "/orphans" bind GET to ::health,\n)\n`);
    const m = await mapOf(r, commitAll(r.dir, "orphan"));
    expect(keysOf(m, "route")).toContain("GET {*}/orphans");
    expect(keysOf(m, "route")).not.toContain("GET /orphans");
    const cov = m.coverage.find((c) => c.file.endsWith("Orphan.kt"));
    expect(cov?.status).toBe("partial");
    expect(cov?.reasons[0]?.reason).toBe("route mount prefix unknown (keyed GET {*}/orphans): routes in `orphanRoutes` are not mounted under a server root (no .asServer(…) or mount resolves to this declaration)");
  });

  test("without a server root the whole app is {*}-prefixed, and a chained mount says why", async () => {
    const r = fixtureRepo();
    Bun.spawnSync(["rm", join(r.dir, KT_API, "Main.kt")]);
    const m = await mapOf(r, commitAll(r.dir, "no main"));
    expect(keysOf(m, "route")).toEqual(["DELETE {*}/api/v1/orders/{*}", "GET {*}/api/users/{*}", "GET {*}/health", "GET {*}/shop/orders", "POST {*}/api/users"]);
    expect(m.coverage.find((c) => c.file.endsWith("Orders.kt"))?.reasons[0]?.reason).toContain("mounted at /shop by `app`, whose prefix is unknown");
    expect(m.joins.every((j) => j.status !== "exact")).toBe(true);
    expect(m.edges.filter((e) => e.kind === "fe-be")).toEqual([]);
  });

  test("a group mounted twice, or by a non-literal prefix, has an unknown prefix", async () => {
    const r = fixtureRepo();
    writeFileSync(join(r.dir, KT_API, "Twice.kt"), `package com.example.api\n\n${HTTP4K}\nfun twice() = routes("/t" bind GET to ::health)\nfun mountA() = routes("/a" bind twice(), "/b" bind twice())\n`);
    const m = await mapOf(r, commitAll(r.dir, "twice"));
    expect(keysOf(m, "route")).toContain("GET {*}/t");
    expect(m.coverage.find((c) => c.file.endsWith("Twice.kt"))?.reasons.map((x) => x.reason)).toContain("route mount prefix unknown (keyed GET {*}/t): `twice` is mounted 2 times");
  });
});

describe("review item 4: call edges respect shadowing and implicit receivers", () => {
  test("inherited members, with(receiver) lambdas, local vals/functions and params produce no edge", async () => {
    const r = fixtureRepo();
    writeFileSync(
      join(r.dir, KT_API, "Shadow.kt"),
      `package com.example.api\n\nopen class Base {\n    fun g() {}\n}\n\nclass A : Base() {\n    fun f() { g() }\n    fun h(sb: StringBuilder) { with(sb) { append("x") } }\n    fun k() { val g = { 1 }; g() }\n    fun p(g: () -> Unit) { g() }\n}\n\nclass Plain {\n    fun own() {}\n    fun caller() { own() }\n}\n\nfun g() {}\nfun append(s: String) {}\n`,
    );
    writeFileSync(join(r.dir, "web/src/shadow.ts"), `export function outer() {\n  function fetchUsers() { return 1; }\n  return fetchUsers();\n}\nexport function other(unbox: () => number) { return unbox(); }\nexport function fetchUsers() { return 2; }\nexport function caller() { return fetchUsers(); }\n`);
    const m = await mapOf(r, commitAll(r.dir, "shadow"));
    const calls = m.edges.filter((e) => e.kind === "call").map((e) => e.key);
    expect(calls.filter((k) => k.startsWith("com.example.api.A."))).toEqual([]);
    expect(calls).toContain("com.example.api.Plain.caller()→com.example.api.Plain.own():call");
    expect(calls.filter((k) => k.startsWith("web/src/shadow#outer") || k.startsWith("web/src/shadow#other"))).toEqual([]);
    expect(calls).toContain("web/src/shadow#caller→web/src/shadow#fetchUsers:call");
  });
});

describe("review item 12: one join row per fetch-site key; ambiguous keys never exact", () => {
  test("duplicate fetch sites collapse to one ambiguous join row with all evidence", async () => {
    const r = fixtureRepo();
    writeFileSync(join(r.dir, "web/src/dupe.ts"), `export function twice() {\n  fetch("/health");\n  fetch("/health");\n}\n`);
    const m = await mapOf(r, commitAll(r.dir, "dupe"));
    const rows = m.joins.filter((j) => j.fetchSite === "web/src/dupe#twice|GET /health");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pattern-match", ambiguous: true, evidenceAll: ["web/src/dupe.ts:2", "web/src/dupe.ts:3"] });
    expect(m.edges.some((e) => e.from === "web/src/dupe#twice|GET /health")).toBe(false);
  });

  test("a fetch whose only matching route is ambiguous is not exact", async () => {
    const r = fixtureRepo();
    writeFileSync(join(r.dir, KT_API, "Dup.kt"), `package com.example.api\n\n${HTTP4K}\nfun main2() {\n    routes("/health" bind GET to ::health).asServer(Jetty(1)).start()\n}\n`);
    const m = await mapOf(r, commitAll(r.dir, "dup route"));
    expect(entity(m, "GET /health").every((e) => e.ambiguous === true)).toBe(true);
    const j = m.joins.find((x) => x.fetchSite === "web/src/api#ApiClient.health|GET /health");
    expect(j?.status).toBe("pattern-match");
    expect(j?.reason).toContain("route key is ambiguous (2 definitions)");
  });
});

// ── re-review: owners and references resolve by declaration, never by bare name ──

async function mapOfFiles(files: Record<string, string>): Promise<AssembledMap> {
  const root = mkdtempSync(join(tmpdir(), "howdah-map-scope-"));
  const dir = join(root, "repo");
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  git(dir, "init", "-q");
  const commit = commitAll(dir, "probe");
  return mapOf({ dir, commit, storeDir: join(root, "store") }, commit);
}

const H4K = "import org.http4k.core.Method.GET\nimport org.http4k.routing.bind\nimport org.http4k.routing.routes\nimport org.http4k.server.asServer\n";

describe("re-review HIGH: probe4 — two Gradle modules, same names", () => {
  let m: AssembledMap;
  beforeAll(async () => {
    m = await mapOfFiles({
      "settings.gradle.kts": 'include(":a")\ninclude(":b")\n',
      "a/src/main/kotlin/a/Main.kt": `package a\n\n${H4K}\nfun main() {\n    val app = createApp()\n    app.asServer(SunHttp(8000)).start()\n}\nfun createApp() = routes(\n    "/real" bind GET to ::h,\n    "/api" bind orderRoutes(),\n)\nfun orderRoutes(): RoutingHttpHandler = OrderController().handlers()\nfun h(r: Request): Response = TODO()\n`,
      "b/src/main/kotlin/b/Other.kt": `package b\n\n${H4K}\nfun app() = routes("/other" bind GET to ::h2)\nfun orderRoutes() = routes("/orders" bind GET to ::h2)\nfun h2(r: Request): Response = TODO()\n`,
      "web/api.ts": 'export function x() { return fetch("/other"); }\nexport function y() { return fetch("/api/orders"); }\n',
      "web/package.json": '{"name":"web"}\n',
    });
  });

  test("an unrelated, never-served `fun app()` in another module is NOT rooted by `app.asServer` (app is a local)", () => {
    expect(keysOf(m, "route")).toEqual(["GET {*}/orders", "GET {*}/other", "GET {*}/real"]);
    expect(m.joins.filter((j) => j.status === "exact")).toEqual([]);
    expect(m.edges.filter((e) => e.kind === "fe-be")).toEqual([]);
  });

  test(":a's mount of orderRoutes() resolves to a.orderRoutes (no routes group), never to b.orderRoutes", () => {
    const a = m.coverage.find((c) => c.file === "a/src/main/kotlin/a/Main.kt");
    expect(a?.status).toBe("partial");
    expect(a?.reasons.map((r) => r.reason)).toContain("mounted `orderRoutes` declares no routes(…) group (routes built another way): its routes are unseen");
    const b = m.coverage.find((c) => c.file === "b/src/main/kotlin/b/Other.kt");
    expect(b?.status).toBe("partial");
    const reasons = b?.reasons.map((r) => r.reason) ?? [];
    expect(reasons.some((r) => r.includes("mounted at /api"))).toBe(false);
    expect(reasons.some((r) => r.startsWith("route mount prefix unknown (keyed GET {*}/orders): routes in `orderRoutes` are not mounted under a server root"))).toBe(true);
    expect(reasons.some((r) => r.startsWith("route mount prefix unknown (keyed GET {*}/other): routes in `app` are not mounted under a server root"))).toBe(true);
    // an unresolved server root is listed only where its simple name could refer to the group
    expect(reasons.find((r) => r.includes("keyed GET {*}/other"))).toContain("unresolved .asServer receiver(s) named `app`: app (`app` is a local, parameter or local declaration");
    expect(reasons.find((r) => r.includes("keyed GET {*}/orders"))).not.toContain("unresolved .asServer");
    expect(a?.reasons.map((r) => r.reason).join("\n")).not.toContain("unresolved .asServer");
  });
});

describe("re-review HIGH: probe6 — one file, two classes with the same member name", () => {
  test("`A().api().asServer(…)` roots A.api only; B.api's /b is unknown-prefixed and the file partial", async () => {
    const m = await mapOfFiles({
      "src/T.kt": `package t\n\n${H4K}\nclass A {\n    fun api() = routes("/a" bind GET to ::h)\n}\n\nclass B {\n    fun api() = routes("/b" bind GET to ::h)\n}\n\nfun main() {\n    A().api().asServer(SunHttp(1)).start()\n}\n\nfun h(r: Request): Response = TODO()\n`,
    });
    expect(keysOf(m, "route")).toEqual(["GET /a", "GET {*}/b"]);
    const cov = m.coverage.find((c) => c.file === "src/T.kt");
    expect(cov?.status).toBe("partial");
    expect(cov?.reasons.map((r) => r.reason)).toEqual(["route mount prefix unknown (keyed GET {*}/b): routes in `api` are not mounted under a server root (no .asServer(…) or mount resolves to this declaration)"]);
  });
});

describe("re-review: scope rules for mounts and roots", () => {
  test("a name declared twice in scope is ambiguous: nothing is rooted through it", async () => {
    const m = await mapOfFiles({
      "src/p/One.kt": `package p\n\n${H4K}\nfun app() = routes("/one" bind GET to ::h)\nfun h(r: Request): Response = TODO()\n`,
      "src/p/Two.kt": `package p\n\n${H4K}\nfun app(x: Int) = routes("/two" bind GET to ::h)\n`,
      "src/p/Main.kt": `package p\n\n${H4K}\nfun main() { app().asServer(SunHttp(1)).start() }\n`,
    });
    expect(keysOf(m, "route")).toEqual(["GET {*}/one", "GET {*}/two"]);
    expect(m.coverage.find((c) => c.file === "src/p/One.kt")?.reasons[0]?.reason).toContain("unresolved .asServer receiver(s) named `app`: app() (`app` has 2 visible declarations (overload/scope resolution by applicability is not modelled))");
  });

  test("an explicit import across packages resolves; the same name in a non-imported package does not interfere", async () => {
    const m = await mapOfFiles({
      "src/lib/Routes.kt": `package lib\n\n${H4K}\nfun api() = routes("/lib" bind GET to ::h)\nfun h(r: Request): Response = TODO()\n`,
      "src/other/Routes.kt": `package other\n\n${H4K}\nfun api() = routes("/other" bind GET to ::h)\nfun h(r: Request): Response = TODO()\n`,
      "src/app/Main.kt": `package app\n\n${H4K}import lib.api\n\nfun main() { routes("/v1" bind api()).asServer(SunHttp(1)).start() }\n`,
    });
    expect(keysOf(m, "route")).toEqual(["GET /v1/lib", "GET {*}/other"]);
  });

  test("a private top-level group in another file of the same package is invisible", async () => {
    const m = await mapOfFiles({
      "src/p/Hidden.kt": `package p\n\n${H4K}\nprivate fun api() = routes("/hidden" bind GET to ::h)\nfun h(r: Request): Response = TODO()\n`,
      "src/p/Main.kt": `package p\n\n${H4K}\nfun main() { api().asServer(SunHttp(1)).start() }\n`,
    });
    expect(keysOf(m, "route")).toEqual(["GET {*}/hidden"]);
  });

  test("a local val holding a routes group in the same function is resolved; mounted through a local, it roots", async () => {
    const m = await mapOfFiles({
      "src/p/Main.kt": `package p\n\n${H4K}\nfun main() {\n    val api = routes("/x" bind GET to ::h)\n    routes("/v1" bind api).asServer(SunHttp(1)).start()\n}\nfun h(r: Request): Response = TODO()\n`,
    });
    expect(keysOf(m, "route")).toEqual(["GET /v1/x"]);
  });

  test("an object member (`Api.routes`) resolves through the object", async () => {
    const m = await mapOfFiles({
      "src/p/Main.kt": `package p\n\n${H4K}\nobject Api {\n    val routes = routes("/o" bind GET to ::h)\n}\nobject Other {\n    val routes = routes("/p" bind GET to ::h)\n}\nfun main() { Api.routes.asServer(SunHttp(1)).start() }\nfun h(r: Request): Response = TODO()\n`,
    });
    expect(keysOf(m, "route")).toEqual(["GET /o", "GET {*}/p"]);
  });
});

// ── round 3: Kotlin import priority, aliases, project scope (probe7 is the regression fixture) ──

const PROBE7 = join(import.meta.dir, "fixtures", "probe7");

describe("round 3: probe7 — decoys that must never be rooted", () => {
  let m: AssembledMap;
  beforeAll(async () => {
    const files: Record<string, string> = {};
    const walk = (dir: string, rel: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name), `${rel}${e.name}/`);
        else files[`${rel}${e.name}`] = readFileSync(join(dir, e.name), "utf8");
      }
    };
    walk(PROBE7, "");
    m = await mapOfFiles(files);
  });

  test("1: an explicit import (lib.app, outside the snapshot) beats the same-package decoy", () => {
    expect(keysOf(m, "route")).not.toContain("GET /decoyA");
    const cov = m.coverage.find((c) => c.file === "m1/src/a/Decoy.kt");
    expect(cov?.status).toBe("partial");
    expect(cov?.reasons.map((r) => r.reason)).toEqual([
      "route mount prefix unknown (keyed GET {*}/decoyA): routes in `app` are not mounted under a server root (no .asServer(…) or mount resolves to this declaration; unresolved .asServer receiver(s) named `app`: app() (`app` is imported from lib.app, which is not in this snapshot))",
    ]);
  });

  test("2: an aliased import binds the alias; the original name falls through to an out-of-snapshot star import", () => {
    expect(keysOf(m, "route")).not.toContain("GET /decoyB");
    expect(m.coverage.find((c) => c.file === "m1/src/b/B.kt")?.reasons.map((r) => r.reason)).toEqual([
      "route mount prefix unknown (keyed GET {*}/decoyB): routes in `svc` are not mounted under a server root (no .asServer(…) or mount resolves to this declaration; unresolved .asServer receiver(s) named `svc`: svc() (`svc` may come from star import lib2.* (not in this snapshot)))",
    ]);
  });

  test("3: same package in ANOTHER Gradle project (and `internal`) is invisible without an import", () => {
    expect(keysOf(m, "route")).not.toContain("GET /decoyC");
    expect(m.coverage.find((c) => c.file === "m3/src/c/Api.kt")?.reasons.map((r) => r.reason)).toEqual([
      "route mount prefix unknown (keyed GET {*}/decoyC): routes in `api` are not mounted under a server root (no .asServer(…) or mount resolves to this declaration; unresolved .asServer receiver(s) named `api`: api() (`api` resolves to no declaration in scope))",
    ]);
  });

  test("nothing is rooted at all", () => {
    expect(keysOf(m, "route")).toEqual(["GET {*}/decoyA", "GET {*}/decoyB", "GET {*}/decoyC"]);
  });
});

describe("round 3: the same rules resolve what they should", () => {
  const H = H4K;
  test("round 4 (U5): an explicit import AND a same-package declaration with the name → unknown (applicability not modelled)", async () => {
    const m = await mapOfFiles({
      "src/a/Decoy.kt": `package a\n\n${H}\nfun app() = routes("/decoyA" bind GET to ::h)\nfun h(r: Request): Response = TODO()\n`,
      "src/lib/Lib.kt": `package lib\n\n${H}\nfun app() = routes("/lib" bind GET to ::h)\nfun h(r: Request): Response = TODO()\n`,
      "src/a/Main.kt": `package a\n\n${H}import lib.app\n\nfun main() { app().asServer(SunHttp(1)).start() }\n`,
    });
    expect(keysOf(m, "route")).toEqual(["GET {*}/decoyA", "GET {*}/lib"]);
  });

  test("an alias resolves to the aliased declaration", async () => {
    const m = await mapOfFiles({
      "src/b/B.kt": `package b\n\n${H}\nfun svc() = routes("/b" bind GET to ::h)\nfun h(r: Request): Response = TODO()\n`,
      "src/a/Main.kt": `package a\n\n${H}import b.svc as other\n\nfun main() { other().asServer(SunHttp(1)).start() }\n`,
    });
    expect(keysOf(m, "route")).toEqual(["GET /b"]);
  });

  test("a same-package name aliased away by an import is not visible under its original name", async () => {
    const m = await mapOfFiles({
      "src/a/Api.kt": `package a\n\n${H}\nfun api() = routes("/a" bind GET to ::h)\nfun h(r: Request): Response = TODO()\n`,
      "src/a/Main.kt": `package a\n\n${H}import a.api as renamed\n\nfun main() { api().asServer(SunHttp(1)).start() }\n`,
    });
    expect(keysOf(m, "route")).toEqual(["GET {*}/a"]);
  });

  test("same package + same Gradle project resolves, `internal` included", async () => {
    const m = await mapOfFiles({
      "settings.gradle.kts": 'include(":m3")\n',
      "m3/src/c/Api.kt": `package c\n\n${H}\ninternal fun api() = routes("/c" bind GET to ::h)\nfun h(r: Request): Response = TODO()\n`,
      "m3/src/c/Main.kt": `package c\n\n${H}\nfun main() { api().asServer(SunHttp(1)).start() }\n`,
    });
    expect(keysOf(m, "route")).toEqual(["GET /c"]);
  });

  test("probe8 shapes: companion member, constructed member, star import in the snapshot, mount chains; extension/included build stay unknown", async () => {
    const m = await mapOfFiles({
      "settings.gradle.kts": 'includeBuild("inc")\n',
      "inc/settings.gradle.kts": 'rootProject.name="inc"\n',
      "inc/src/r/R.kt": `package p\n\n${H}\nfun incApi() = routes("/included" bind GET to ::hr)\nfun hr(r: Request): Response = TODO()\n`,
      "src/q/Q.kt": `package q\n\n${H}\nfun starApi() = routes("/star" bind GET to ::hq)\nfun hq(r: Request): Response = TODO()\n`,
      "src/p/Main.kt": `package p\n\n${H}import q.*\n\nfun main() {\n    starApi().asServer(SunHttp(1)).start()\n    Holder.api().asServer(SunHttp(2)).start()\n    Server().app().asServer(SunHttp(3)).start()\n    root().asServer(SunHttp(4)).start()\n    Cfg().extApp().asServer(SunHttp(5)).start()\n    incApi().asServer(SunHttp(6)).start()\n}\n\nclass Holder {\n    companion object {\n        fun api() = routes("/companion" bind GET to ::h)\n    }\n}\n\nfun app() = routes("/topApp" bind GET to ::h)\n\nclass Server {\n    fun app() = routes("/memberApp" bind GET to ::h)\n}\n\nclass Cfg\nfun Cfg.extApp() = routes("/ext" bind GET to ::h)\n\nfun root() = routes(\n    "/v1" bind mid(),\n)\nfun mid() = routes(\n    "/x" bind leaf(),\n)\nfun leaf() = routes("/leaf" bind GET to ::h)\n\nfun h(r: Request): Response = TODO()\n`,
    });
    expect(keysOf(m, "route")).toEqual(["GET /companion", "GET /memberApp", "GET /star", "GET /v1/x/leaf", "GET {*}/ext", "GET {*}/included", "GET {*}/topApp"]);
  });
});

// ── round 4: pessimistic by construction (probe9 is the regression fixture) ──

function filesUnder(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (d: string, rel: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`);
      else files[`${rel}${e.name}`] = readFileSync(join(d, e.name), "utf8");
    }
  };
  walk(dir, "");
  return files;
}

const reasonsOf = (m: AssembledMap, file: string) => m.coverage.find((c) => c.file === file && c.adapter === "http4k")?.reasons.map((r) => r.reason) ?? [];

describe("round 4: probe9 — false roots from imports and nested classifiers", () => {
  let m: AssembledMap;
  beforeAll(async () => {
    m = await mapOfFiles(filesUnder(join(import.meta.dir, "fixtures", "probe9")));
  });

  test("the exact outcome: only the three fully-modelled roots are rooted", () => {
    expect(keysOf(m, "route")).toEqual(["GET /api/x", "GET /nestedHolder", "GET {*}/aliasAndPlain", "GET {*}/aliasTarget", "GET {*}/fromFactory", "GET {*}/topHolder", "GET {*}/twoImports"]);
  });

  test("1: two explicit imports binding `app` (one outside the snapshot) → unknown, never the in-snapshot one", () => {
    expect(reasonsOf(m, "src/b/B.kt")[0]).toContain("unresolved .asServer receiver(s) named `app`: app(Config()) (2 imports bind `app` (lib.app, b.app))");
  });

  test("2: plain + aliased imports both binding `svc` → unknown; c.other is not rooted through the alias", () => {
    expect(reasonsOf(m, "src/c/C.kt")[0]).toBe("route mount prefix unknown (keyed GET {*}/aliasTarget): routes in `other` are not mounted under a server root (no .asServer(…) or mount resolves to this declaration)");
    expect(reasonsOf(m, "src/b/B.kt")[1]).toContain("unresolved .asServer receiver(s) named `svc`: svc() (2 imports bind `svc` (lib.svc, c.other as svc))");
  });

  test("3: `Holder` inside class X means the nested X.Holder, not the top-level Holder", () => {
    expect(keysOf(m, "route")).toContain("GET /nestedHolder");
    expect(reasonsOf(m, "src/c/C.kt")[1]).toBe("route mount prefix unknown (keyed GET {*}/topHolder): routes in `api` are not mounted under a server root (no .asServer(…) or mount resolves to this declaration)");
  });

  test("a function-typed property called like a function (`makeApp()`) → unknown (invoke not modelled)", () => {
    expect(reasonsOf(m, "src/d/Routes.kt")[0]).toContain("`makeApp` is a property, not a function (invoke/constructor not modelled)");
  });
});

describe("round 4: one test per audit rule that returns unknown", () => {
  const H = H4K;
  const T = (body: string) => `package p\n\n${H}\n${body}\nfun h(r: Request): Response = TODO()\n`;
  const unknownRoot = async (files: Record<string, string>, route: string, why: string) => {
    const m = await mapOfFiles(files);
    expect(keysOf(m, "route")).toContain(`GET {*}${route}`);
    const all = m.coverage.flatMap((c) => c.reasons.map((r) => r.reason)).join("\n");
    expect(all).toContain(why);
  };

  test("U1 lambdas: a server started inside `run { … }`", () =>
    unknownRoot({ "src/p/M.kt": T(`fun app() = routes("/r" bind GET to ::h)\nfun main() { run { app().asServer(SunHttp(1)).start() } }`) }, "/r", "referenced inside a lambda"));

  test("U2 opaque: `this.app()`", () =>
    // opaque receivers have no simple name, so they are not listed in the reason — the route stays unknown
    unknownRoot({ "src/p/M.kt": T(`class S {\n    fun app() = routes("/r" bind GET to ::h)\n    fun go() { this.app().asServer(SunHttp(1)).start() }\n}`) }, "/r", "routes in `app` are not mounted under a server root"));

  test("U3 locals: a local function shadows", () =>
    unknownRoot({ "src/p/M.kt": T(`fun app() = routes("/r" bind GET to ::h)\nfun main() {\n    fun app() = routes()\n    app().asServer(SunHttp(1)).start()\n}`) }, "/r", "is a local, parameter or local declaration"));

  test("U4 extensions: an extension with the same name exists", () =>
    unknownRoot({ "src/p/M.kt": T(`fun app() = routes("/r" bind GET to ::h)\nfun String.app() = routes()\nfun main() { app().asServer(SunHttp(1)).start() }`) }, "/r", "an extension named `app` exists"));

  test("U5 overloads: two declarations of `app` (default/named args could pick either)", () =>
    unknownRoot({ "src/p/M.kt": T(`fun app() = routes("/r" bind GET to ::h)\nfun app(debug: Boolean = false, x: Int) = routes()\nfun main() { app().asServer(SunHttp(1)).start() }`) }, "/r", "has 2 visible declarations"));

  test("U5 companion vs top-level with the same name", () =>
    unknownRoot({ "src/p/M.kt": T(`fun api() = routes("/r" bind GET to ::h)\nclass S {\n    companion object { fun api() = routes() }\n    fun go() { api().asServer(SunHttp(1)).start() }\n}`) }, "/r", "has 2 visible declarations"));

  test("U6 invoke: an object with the name", () =>
    unknownRoot({ "src/p/M.kt": T(`val appRoutes = routes("/r" bind GET to ::h)\nobject app\nfun main() { app().asServer(SunHttp(1)).start() }\nfun unused() = appRoutes`) }, "/r", "not mounted under a server root"));

  test("U7 supertypes: a caller class with supertypes", () =>
    unknownRoot({ "src/p/M.kt": T(`fun app() = routes("/r" bind GET to ::h)\nopen class Base\nclass S : Base() {\n    fun go() { app().asServer(SunHttp(1)).start() }\n}`) }, "/r", "has supertypes; `app` may be inherited"));

  test("U7 supertypes: a nested classifier looked up from a class with supertypes", () =>
    unknownRoot({ "src/p/M.kt": T(`object Holder { fun api() = routes("/r" bind GET to ::h) }\nopen class Base\nclass S : Base() {\n    fun go() { Holder.api().asServer(SunHttp(1)).start() }\n}`) }, "/r", "an inherited `Holder` may shadow"));

  test("U8 star import of a package outside the snapshot", () =>
    unknownRoot({ "src/p/M.kt": T(`fun app() = routes("/r" bind GET to ::h)`), "src/q/Main.kt": `package q\n\n${H}import p.*\nimport ext.*\n\nfun main() { app().asServer(SunHttp(1)).start() }\n` }, "/r", "may come from star import ext.*"));

  test("U9 modules: same package in another Gradle project", () =>
    unknownRoot(
      { "settings.gradle.kts": 'include(":x")\ninclude(":y")\n', "x/src/p/A.kt": T(`fun app() = routes("/r" bind GET to ::h)`), "y/src/p/M.kt": `package p\n\n${H}\nfun main() { app().asServer(SunHttp(1)).start() }\n` },
      "/r",
      "`app` is declared in project :x; cross-project resolution is out of scope for the syntactic tier (SCIP, slice 2)",
    ));

  test("U10 completeness: a same-project JVM file was skipped (generated)", () =>
    unknownRoot({ "src/p/M.kt": T(`fun app() = routes("/r" bind GET to ::h)\nfun main() { app().asServer(SunHttp(1)).start() }`), "src/generated/p/Gen.kt": "package p\nfun other() = 1\n" }, "/r", "project : may hide declarations: src/generated/p/Gen.kt was not extracted (generated path (generated/))"));

  test("U10 completeness: an unparsed region mentions the name", () =>
    unknownRoot({ "src/p/M.kt": T(`fun app() = routes("/r" bind GET to ::h)\nfun main() { app().asServer(SunHttp(1)).start() }`), "src/p/Ctx.kt": "package p\n\ncontext(l: Logger)\nfun app(x: Int) = 1\n" }, "/r", "an unparsed region in project : mentions `app`"));

  test("U11 expect/actual", () =>
    unknownRoot({ "src/p/M.kt": T(`actual fun app() = routes("/r" bind GET to ::h)\nfun main() { app().asServer(SunHttp(1)).start() }`) }, "/r", "has an expect/actual declaration"));

  test("U12 typealiases", () =>
    unknownRoot({ "src/p/M.kt": T(`object Real { fun api() = routes("/r" bind GET to ::h) }\ntypealias Holder = Real\nfun main() { Holder.api().asServer(SunHttp(1)).start() }`) }, "/r", "`Holder` is a typealias"));

  test("U13 classifiers: a value with the class name in scope", () =>
    unknownRoot({ "src/p/M.kt": T(`object Holder { fun api() = routes("/r" bind GET to ::h) }\nval Holder = 1\nfun main() { Holder.api().asServer(SunHttp(1)).start() }`) }, "/r", "a value or function named `Holder` is also visible"));

  test("U14 Java: a Java class member resolves to a non-owner (never a routes group)", async () => {
    const m = await mapOfFiles({
      "src/p/M.kt": T(`fun main() { Api.routes().asServer(SunHttp(1)).start() }\nfun app() = routes("/r" bind GET to ::h)`),
      "src/p/Api.java": "package p;\npublic class Api { public static Object routes() { return null; } }\n",
    });
    expect(keysOf(m, "route")).toEqual(["GET {*}/r"]);
  });
});

// ── round 5: dependency projects, arity, served-through wrappers, generated sources (probe10) ──

describe("round 5: probe10 — the exact outcome", () => {
  let m: AssembledMap;
  beforeAll(async () => {
    m = await mapOfFiles(filesUnder(join(import.meta.dir, "fixtures", "probe10")));
  });

  test("nothing is rooted", () => {
    expect(keysOf(m, "route")).toEqual(["GET {*}/a", "GET {*}/debug", "GET {*}/decoyApp", "GET {*}/realFromLib"]);
    expect(m.joins.filter((j) => j.status === "exact")).toEqual([]);
  });

  test("1: a same-package declaration in the dependency project :lib is counted — :app's decoy is not rooted", () => {
    const why = "unresolved .asServer receiver(s) named `api`: api(Cfg()) (`api` has 2 visible declarations (overload/scope resolution by applicability is not modelled))";
    expect(reasonsOf(m, "app/src/main/kotlin/c/Main.kt")[0]).toContain(why);
    expect(reasonsOf(m, "lib/src/main/kotlin/c/Lib.kt")[0]).toContain(why);
  });

  test("2+3: `.withBasePath(…)` and a group passed as a call argument do not root it; the wrapper is named", () => {
    expect(reasonsOf(m, "svc/src/main/kotlin/s/S.kt")).toEqual([
      "mounted `extra` could not be resolved (`extra` is a local, parameter or local declaration; what it holds is not visible to syntax): its routes are unseen",
      "route mount prefix unknown (keyed GET {*}/a): the group is served through `.withBasePath(…)`, which is not modelled",
      'route mount prefix unknown (keyed GET {*}/debug): the group is served as an argument of `createApp(routes("/debug" bind GET to :…`, which is not modelled',
    ]);
  });
});

describe("round 6: U9 — only same-project candidates resolve; cross-project candidates still count", () => {
  const H = H4K;
  const lib = (pkgLine: string, body: string) => `${pkgLine}\n\n${H}\n${body}\nfun h(r: Request): Response = TODO()\n`;
  const CROSS = (name: string, project: string) => `\`${name}\` is declared in project ${project}; cross-project resolution is out of scope for the syntactic tier (SCIP, slice 2)`;

  test("probe11: testImplementation and commented-out dependencies no longer matter — every cross-project root is {*}", async () => {
    const m = await mapOfFiles(filesUnder(join(import.meta.dir, "fixtures", "probe11")));
    expect(keysOf(m, "route")).toEqual(["GET {*}/commentedDep", "GET {*}/testOnlyDep"]);
    expect(reasonsOf(m, "lib/src/main/kotlin/c/Lib.kt")[0]).toContain(CROSS("api", ":lib"));
    expect(reasonsOf(m, "lib2/src/main/kotlin/d/Lib.kt")[0]).toContain(CROSS("api2", ":lib2"));
    expect(m.joins.filter((j) => j.status === "exact")).toEqual([]);
  });

  test("a unique same-package candidate in a real `implementation` dependency is still unknown (out of scope)", async () => {
    const m = await mapOfFiles({
      "settings.gradle.kts": 'include(":app")\ninclude(":lib")\n',
      "app/build.gradle.kts": 'dependencies { implementation(project(":lib")) }\n',
      "lib/src/c/Lib.kt": lib("package c", `fun api() = routes("/fromLib" bind GET to ::h)`),
      "app/src/c/Main.kt": `package c\n\n${H}\nfun main() { api().asServer(SunHttp(1)).start() }\n`,
    });
    expect(keysOf(m, "route")).toEqual(["GET {*}/fromLib"]);
    expect(reasonsOf(m, "lib/src/c/Lib.kt")[0]).toContain(CROSS("api", ":lib"));
  });

  test("an explicit import whose target is in another project is unknown", async () => {
    const m = await mapOfFiles({
      "settings.gradle.kts": 'include(":app")\ninclude(":lib")\n',
      "lib/src/q/Lib.kt": lib("package q", `fun api() = routes("/imported" bind GET to ::h)`),
      "app/src/c/Main.kt": `package c\n\n${H}import q.api\n\nfun main() { api().asServer(SunHttp(1)).start() }\n`,
    });
    expect(keysOf(m, "route")).toEqual(["GET {*}/imported"]);
    expect(reasonsOf(m, "lib/src/q/Lib.kt")[0]).toContain(CROSS("api", ":lib"));
  });

  test("a classifier (object/companion owner) in another project is unknown", async () => {
    const m = await mapOfFiles({
      "settings.gradle.kts": 'include(":app")\ninclude(":lib")\n',
      "lib/src/q/Lib.kt": lib("package q", `object Api { fun routes() = routes("/obj" bind GET to ::h) }`),
      "app/src/c/Main.kt": `package c\n\n${H}import q.Api\n\nfun main() { Api.routes().asServer(SunHttp(1)).start() }\n`,
    });
    expect(keysOf(m, "route")).toEqual(["GET {*}/obj"]);
    expect(reasonsOf(m, "lib/src/q/Lib.kt")[0]).toContain(CROSS("Api", ":lib"));
  });

  test("a same-project unique candidate still roots, in a multi-project build", async () => {
    const m = await mapOfFiles({
      "settings.gradle.kts": 'include(":app")\ninclude(":lib")\n',
      "app/src/c/Api.kt": lib("package c", `fun api() = routes("/own" bind GET to ::h)`),
      "lib/src/other/Unrelated.kt": lib("package other", `fun api() = routes("/elsewhere" bind GET to ::h)`),
      "app/src/c/Main.kt": `package c\n\n${H}\nfun main() { api().asServer(SunHttp(1)).start() }\n`,
    });
    expect(keysOf(m, "route")).toEqual(["GET /own", "GET {*}/elsewhere"]);
  });

  test("a cross-project duplicate in the same package still BLOCKS a same-project candidate (U5)", async () => {
    const m = await mapOfFiles({
      "settings.gradle.kts": 'include(":app")\ninclude(":lib")\n',
      "app/src/c/Api.kt": lib("package c", `fun api() = routes("/own" bind GET to ::h)`),
      "lib/src/c/Lib.kt": lib("package c", `fun api(x: Int) = routes("/fromLib" bind GET to ::h)`),
      "app/src/c/Main.kt": `package c\n\n${H}\nfun main() { api().asServer(SunHttp(1)).start() }\n`,
    });
    expect(keysOf(m, "route")).toEqual(["GET {*}/fromLib", "GET {*}/own"]);
    expect(reasonsOf(m, "app/src/c/Api.kt")[0]).toContain("`api` has 2 visible declarations");
  });

  test("an internal declaration in another project neither counts nor resolves (decoyC protection)", async () => {
    const m = await mapOfFiles({
      "settings.gradle.kts": 'include(":app")\ninclude(":other")\n',
      "other/src/c/O.kt": lib("package c", `internal fun api() = routes("/internalElsewhere" bind GET to ::h)`),
      "app/src/c/Api.kt": lib("package c", `fun api() = routes("/own" bind GET to ::h)`),
      "app/src/c/Main.kt": `package c\n\n${H}\nfun main() { api().asServer(SunHttp(1)).start() }\n`,
    });
    expect(keysOf(m, "route")).toEqual(["GET /own", "GET {*}/internalElsewhere"]);
  });
});

describe("round 5: U15 arity guard", () => {
  const H = H4K;
  const T = (body: string) => `package p\n\n${H}\n${body}\nfun h(r: Request): Response = TODO()\n`;
  test("a call whose argument count cannot match the lone candidate → unknown", async () => {
    const m = await mapOfFiles({ "src/p/M.kt": T(`fun api(cfg: Cfg) = routes("/r" bind GET to ::h)\nfun main() { api().asServer(SunHttp(1)).start() }`) });
    expect(keysOf(m, "route")).toEqual(["GET {*}/r"]);
    expect(reasonsOf(m, "src/p/M.kt")[0]).toContain("the call passes 0 argument(s); `api` takes 1");
  });
  test("defaults and vararg are accounted for", async () => {
    const m = await mapOfFiles({
      "src/p/A.kt": T(`fun a(x: Int = 1) = routes("/a" bind GET to ::h)\nfun b(vararg xs: Int) = routes("/b" bind GET to ::h)\nfun c(x: Int, y: Int = 2) = routes("/c" bind GET to ::h)`),
      "src/p/M.kt": `package p\n\n${H}\nfun main() {\n    a().asServer(SunHttp(1)).start()\n    b(1, 2, 3).asServer(SunHttp(2)).start()\n    c(1, 2, 3).asServer(SunHttp(3)).start()\n}\n`,
    });
    expect(keysOf(m, "route")).toEqual(["GET /a", "GET /b", "GET {*}/c"]);
    expect(reasonsOf(m, "src/p/A.kt").join("\n")).toContain("the call passes 3 argument(s); `c` takes 1..2");
  });
});

describe("round 5: U16 served-through wrappers", () => {
  const H = H4K;
  const T = (body: string) => `package p\n\n${H}\n${body}\nfun h(r: Request): Response = TODO()\n`;
  test("modelled wrappers root: parentheses, .then(x), .withFilter(f)", async () => {
    const m = await mapOfFiles({
      "src/p/M.kt": T(`fun main() {\n    (routes("/paren" bind GET to ::h)).asServer(SunHttp(1)).start()\n    filters.then(routes("/then" bind GET to ::h)).asServer(SunHttp(2)).start()\n    routes("/wf" bind GET to ::h).withFilter(f).asServer(SunHttp(3)).start()\n}`),
    });
    expect(keysOf(m, "route")).toEqual(["GET /paren", "GET /then", "GET /wf"]);
  });
  test("anything else in between does not: a member call, a call argument, a multi-argument then", async () => {
    const m = await mapOfFiles({
      "src/p/M.kt": T(`fun main() {\n    routes("/base" bind GET to ::h).withBasePath("/v2").asServer(SunHttp(1)).start()\n    wrap(routes("/arg" bind GET to ::h)).asServer(SunHttp(2)).start()\n    x.then(routes("/two" bind GET to ::h), y).asServer(SunHttp(3)).start()\n}`),
    });
    expect(keysOf(m, "route")).toEqual(["GET {*}/arg", "GET {*}/base", "GET {*}/two"]);
    const reasons = reasonsOf(m, "src/p/M.kt").join("\n");
    expect(reasons).toContain("served through `.withBasePath(…)`, which is not modelled");
    expect(reasons).toContain("served as an argument of `wrap(");
  });
});

describe("round 5: U10 generated sources", () => {
  test("a commented-out ksp plugin is not detected (build scripts are read with comments stripped)", async () => {
    const H = H4K;
    const m = await mapOfFiles({
      "settings.gradle.kts": 'include(":app")\n',
      "app/build.gradle.kts": '// id("com.google.devtools.ksp")\n/* kapt { } */\n',
      "app/src/p/M.kt": `package p\n\n${H}\nfun api() = routes("/r" bind GET to ::h)\nfun main() { api().asServer(SunHttp(1)).start() }\nfun h(r: Request): Response = TODO()\n`,
    });
    expect(keysOf(m, "route")).toEqual(["GET /r"]);
  });

  test("a project applying ksp (or kapt) is incomplete: nothing resolves into it", async () => {
    const H = H4K;
    const m = await mapOfFiles({
      "settings.gradle.kts": 'include(":app")\n',
      "app/build.gradle.kts": 'plugins { id("com.google.devtools.ksp") }\ndependencies { ksp(project(":proc")) }\n',
      "app/src/p/M.kt": `package p\n\n${H}\nfun api() = routes("/r" bind GET to ::h)\nfun main() { api().asServer(SunHttp(1)).start() }\nfun h(r: Request): Response = TODO()\n`,
    });
    expect(keysOf(m, "route")).toEqual(["GET {*}/r"]);
    expect(reasonsOf(m, "app/src/p/M.kt")[0]).toContain("project :app (app/build.gradle.kts) uses ksp: generated sources are not in the snapshot");
  });
});
