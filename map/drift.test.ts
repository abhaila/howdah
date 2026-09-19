import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemble } from "./assemble";
import { computeDrift, DRIFT_CAP, DRIFT_OUTCOMES, sameExtractor, type DriftItem, type DriftReport } from "./drift";
import type { GhostEdge, GhostEntity, GhostSet, Op } from "./ghosts";
import { extract } from "./extract";
import { MapStore } from "./store";
import { commitAll, fixtureRepo, sliceFixture, type SliceFixture } from "./testkit";
import type { AssembledMap, EntityKind } from "./types";

const API = "api/src/main/kotlin/com/example/api/";
const APP = API + "App.kt";
const HANDLERS = API + "Handlers.kt";
const ORDERS = API + "Orders.kt";
const AUDIT = API + "Audit.kt";
const MAIN = API + "Main.kt";
const API_TS = "web/src/api.ts";
const USERS_TSX = "web/src/Users.tsx";
const KT = ":api/com.example.api";

const fn = (name: string) => `com.example.api.<top>.${name}`;

function ent(id: string, op: Op, file: string, kind: EntityKind = "function", block = file.startsWith("web/") ? "web" : KT): GhostEntity {
  return { id, op, block, kind, expected_file: file };
}
function gs(p: Partial<GhostSet>): GhostSet {
  return { blocks: [], entities: [], edges: [], trace: [], ...p };
}
function edge(from: string, to: string, kind: GhostEdge["kind"], op: Op): GhostEdge {
  return { from, to, kind, op };
}
/** The ghost's own item (op !== null), or the trace item. */
function item(r: DriftReport, key: string): DriftItem {
  const it = r.items.find((i) => i.key === key && (i.op !== null || i.kind === "trace"));
  if (it === undefined) throw new Error(`no drift item for ${key}: ${JSON.stringify(r.items.map((i) => i.key))}`);
  return it;
}
const clone = (m: AssembledMap): AssembledMap => structuredClone(m);

let fx: SliceFixture;
let base: AssembledMap;
let after: AssembledMap;
beforeAll(async () => {
  fx = await sliceFixture();
  base = fx.base;
  after = fx.after;
});

const one = (g: GhostEntity, a: AssembledMap = after, b: AssembledMap = base) => item(computeDrift(gs({ entities: [g] }), b, a), g.id);

describe("entity ghosts: every op × outcome cell (real base/after extraction)", () => {
  test("add → verified when absent in base and present after", () => {
    const it = one(ent(fn("ping(Request)"), "add", HANDLERS));
    expect(it).toMatchObject({ outcome: "verified", kind: "function", op: "add" });
    expect(it.evidence).toStartWith(HANDLERS + ":");
  });

  test("add → missing when the expected file was fully searched (function, route, fetch-site)", () => {
    const f = one(ent(fn("pong(Request)"), "add", HANDLERS));
    expect(f.outcome).toBe("missing");
    expect(f.reason).toContain(`searched ${HANDLERS} with full coverage`);
    // Orders.kt has full http4k coverage: a route that is not there is provably missing
    expect(one(ent("GET /shop/refunds", "add", ORDERS, "route")).outcome).toBe("missing");
    // Users.tsx has full fetch coverage
    expect(one(ent("web/src/Users#UserCard|GET /api/avatars", "add", USERS_TSX, "fetch-site")).outcome).toBe("missing");
  });

  test("add → missing when the expected file does not exist after (nothing can hide in it)", () => {
    const it = one(ent("web/src/orders#listOrders", "add", "web/src/orders.ts"));
    expect(it.outcome).toBe("missing");
    expect(it.reason).toContain("web/src/orders.ts is not in the after snapshot (never created, deleted, or git-ignored)");
  });

  test("add of a key already in base → not-checked (cannot be told apart from keep)", () => {
    expect(one(ent(fn("main()"), "add", MAIN))).toMatchObject({ outcome: "not-checked", reason: expect.stringContaining("already present in the base") as unknown as string });
  });

  test("modify → verified when the content hash changed, unchanged when it did not", () => {
    expect(one(ent(fn("createUser(Request)"), "modify", APP)).outcome).toBe("verified");
    const u = one(ent(fn("adminRoutes()"), "modify", APP));
    expect(u.outcome).toBe("unchanged");
    expect(u.evidence).toStartWith(APP + ":");
  });

  test("modify → missing when the entity is gone and its file was searched", () => {
    expect(one(ent("web/src/api#listThings", "modify", API_TS)).outcome).toBe("missing");
  });

  test("remove → verified when absent after; still-present when it is still there", () => {
    const v = one(ent("web/src/api#listThings", "remove", API_TS));
    expect(v.outcome).toBe("verified");
    expect(v.evidence).toStartWith(API_TS + ":"); // where it was
    expect(one(ent("web/src/api#pick", "remove", API_TS)).outcome).toBe("still-present");
  });

  test("keep → verified when unchanged, changed-unexpectedly when edited, missing when gone", () => {
    expect(one(ent(fn("deleteOrder(Request)"), "keep", APP)).outcome).toBe("verified");
    expect(one(ent(fn("health(Request)"), "keep", HANDLERS)).outcome).toBe("changed-unexpectedly");
    expect(one(ent("web/src/api#listThings", "keep", API_TS)).outcome).toBe("missing");
  });

  test("an op that needs a base entity, without one → not-checked", () => {
    for (const op of ["modify", "remove", "keep"] as const) {
      expect(one(ent(fn("nothing()"), op, HANDLERS))).toMatchObject({ outcome: "not-checked", reason: expect.stringContaining("not in the base snapshot") as unknown as string });
    }
  });
});

describe("missing needs proof: not-checked for every reason", () => {
  test("partial adapter coverage of the expected file", () => {
    const it = one(ent("GET /api/things", "add", APP, "route"));
    expect(it.outcome).toBe("not-checked");
    expect(it.reason).toContain(`partial http4k coverage of ${APP}`);
    expect(it.reason).toContain("bind path is not a string literal");
    // a remove of a fetch site in a partially covered file is not proven either
    const r = one(ent("web/src/api#listThings|GET /api/{*}/list", "remove", API_TS, "fetch-site"));
    expect(r.outcome).toBe("not-checked");
    expect(r.reason).toContain(`partial fetch coverage of ${API_TS}`);
  });

  test("an unparsed region in the expected file", () => {
    const it = one(ent(fn("auditAll(String)"), "add", AUDIT));
    expect(it.outcome).toBe("not-checked");
    expect(it.reason).toContain(`${AUDIT} has unparsed region(s) at lines 7-12`);
  });

  test("an ambiguous key, in base or in after", () => {
    const b = one(ent(fn("helper(Int)"), "keep", APP));
    expect(b.outcome).toBe("not-checked");
    expect(b.reason).toContain("ambiguous in the base snapshot: 2 entities share this key");
    const a = clone(after);
    const ping = a.entities.find((e) => e.key === fn("ping(Request)"));
    if (ping === undefined) throw new Error("fixture: ping missing");
    a.entities.push({ ...ping, file: API + "Other.kt", evidence: API + "Other.kt:1" });
    const it = one(ent(fn("ping(Request)"), "add", HANDLERS), a);
    expect(it.outcome).toBe("not-checked");
    expect(it.reason).toContain("ambiguous in the after snapshot: 2 entities");
  });

  test("a skipped expected file", () => {
    const it = one(ent("web/src/generated/client#makeClient", "add", "web/src/generated/client.ts"));
    expect(it.outcome).toBe("not-checked");
    expect(it.reason).toContain("web/src/generated/client.ts was skipped (generated path");
  });

  test("a not-checked expected file (grammar unavailable / worker error)", () => {
    const a = clone(after);
    a.files = a.files.filter((f) => f.path !== ORDERS);
    a.entities = a.entities.filter((e) => e.file !== ORDERS);
    a.coverage = a.coverage.filter((c) => c.file !== ORDERS);
    a.notChecked.push({ path: ORDERS, reason: "grammar unavailable: kotlin" });
    const it = one(ent("GET /shop/refunds", "add", ORDERS, "route"), a);
    expect(it.outcome).toBe("not-checked");
    expect(it.reason).toContain(`${ORDERS} was not checked (grammar unavailable: kotlin)`);
  });

  test("no adapter covers the ghost's kind in the file's language", () => {
    const it = one(ent("GET /x", "add", API_TS, "route"));
    expect(it.outcome).toBe("not-checked");
    expect(it.reason).toContain("no adapter covers routes in typescript files");
    const j = one(ent("com.example.core.Greeter.load()|GET /x", "add", "shared/core/src/main/java/com/example/core/Greeter.java", "fetch-site", ":shared:core/com.example.core"));
    expect(j.reason).toContain("no adapter covers fetch-sites in java files");
  });

  test("the covering adapter reported nothing for the file", () => {
    const a = clone(after);
    a.coverage = a.coverage.filter((c) => !(c.file === ORDERS && c.adapter === "http4k"));
    expect(one(ent("GET /shop/refunds", "add", ORDERS, "route"), a).reason).toContain(`adapter http4k reported no coverage for ${ORDERS}`);
  });

  test("present only below the syntactic tier never verifies", () => {
    const a = clone(after);
    for (const e of a.entities) if (e.key === fn("ping(Request)")) e.tier = "unresolved";
    const it = one(ent(fn("ping(Request)"), "add", HANDLERS), a);
    expect(it.outcome).toBe("not-checked");
    expect(it.reason).toContain("only at tier unresolved");
  });

  test("remove: a deleted file proves absence; a skipped one does not", () => {
    const LEGACY = "web/src/legacy.ts";
    const gone = clone(after);
    gone.files = gone.files.filter((f) => f.path !== LEGACY);
    gone.entities = gone.entities.filter((e) => e.file !== LEGACY);
    gone.coverage = gone.coverage.filter((c) => c.file !== LEGACY);
    expect(one(ent("web/src/legacy#unbox", "remove", LEGACY), gone).outcome).toBe("verified");
    const hidden = clone(gone);
    hidden.skipped.push({ path: LEGACY, reason: "too large" });
    expect(one(ent("web/src/legacy#unbox", "remove", LEGACY), hidden)).toMatchObject({ outcome: "not-checked", reason: expect.stringContaining(`${LEGACY} was skipped (too large)`) as unknown as string });
  });

  test("an existing entity's base file is searched too, not only expected_file", () => {
    // the ghost names Handlers.kt, but listThings lived in api.ts — both must be clean
    const a = clone(after);
    a.unparsed.push({ file: API_TS, evidence: API_TS + ":3", startLine: 3, endLine: 4, kind: "error" });
    const it = one(ent("web/src/api#listThings", "remove", "web/src/other.ts"), a);
    expect(it.outcome).toBe("not-checked");
    expect(it.reason).toContain(`${API_TS} has unparsed region(s) at lines 3-4`);
  });
});

describe("edges: verified or not-checked, never missing", () => {
  const MAIN_APP = [fn("main()"), fn("app(Greeter)")] as const;

  test("keep / add → verified when observed after", () => {
    const r = computeDrift(gs({ edges: [edge(...MAIN_APP, "call", "keep"), edge(fn("health(Request)"), fn("ping(Request)"), "call", "add")] }), base, after);
    expect(item(r, `${MAIN_APP[0]}→${MAIN_APP[1]}:call`).outcome).toBe("verified");
    expect(item(r, `${fn("health(Request)")}→${fn("ping(Request)")}:call`)).toMatchObject({ outcome: "verified", evidence: expect.stringContaining(HANDLERS) as unknown as string });
  });

  test("an unobserved add / keep edge is not-checked (extraction is conservative), never missing", () => {
    const r = computeDrift(gs({ edges: [edge(fn("ping(Request)"), fn("health(Request)"), "call", "add"), edge("web/src/Users#UserCard", "web/src/api#getUser", "call", "keep")] }), base, after);
    for (const i of r.items) {
      expect(i.outcome).toBe("not-checked");
      expect(i.reason).toContain("edge extraction is conservative");
    }
    expect(r.counts.missing).toBe(0);
  });

  test("an unobserved fe-be edge says what the join found", () => {
    const r = computeDrift(gs({ edges: [edge("web/src/api#deleteOrder|DELETE {*}/orders/{*}", "DELETE /api/v1/orders/{*}", "fe-be", "add")] }), base, after);
    expect(r.items[0]?.outcome).toBe("not-checked");
    expect(r.items[0]?.reason).toMatch(/the join is (pattern-match|unresolved)/);
  });

  test("an edge touching an ambiguous key → not-checked (ambiguous)", () => {
    const r = computeDrift(gs({ edges: [edge(fn("createUser(Request)"), fn("helper(Int)"), "call", "keep")] }), base, after);
    expect(r.items[0]).toMatchObject({ outcome: "not-checked", reason: expect.stringContaining("is ambiguous in the base snapshot") as unknown as string });
  });

  test("remove → verified only when an endpoint is proven gone", () => {
    const b = clone(base);
    const [from, to] = ["web/src/api#pick", "web/src/api#listThings"];
    b.edges.push({ key: `${from}→${to}:call`, from, to, kind: "call", tier: "syntactic", evidence: API_TS + ":39" });
    const r = computeDrift(gs({ edges: [edge(from, to, "call", "remove")] }), b, after);
    expect(r.items[0]).toMatchObject({ outcome: "verified", reason: expect.stringContaining(`endpoint ${to} is gone: searched ${API_TS} with full coverage`) as unknown as string });
  });

  test("remove → not-checked when both endpoints still exist (the edge may only have become invisible)", () => {
    // UserCard really stopped calling getUser — but an edge vanishing is not proof: both still exist
    const r = computeDrift(gs({ edges: [edge("web/src/Users#UserCard", "web/src/api#getUser", "call", "remove")] }), base, after);
    expect(r.items[0]).toMatchObject({ outcome: "not-checked", reason: expect.stringContaining("neither endpoint is proven gone") as unknown as string });
  });

  test("remove → still-present when observed after", () => {
    const r = computeDrift(gs({ edges: [edge(...MAIN_APP, "call", "remove")] }), base, after);
    expect(r.items[0]?.outcome).toBe("still-present");
  });

  test("remove → not-checked when the gone endpoint's absence is not proven (unparsed file)", () => {
    const b = clone(base);
    const from = "com.example.api.Logger.info(String)";
    b.edges.push({ key: `${from}→${fn("health(Request)")}:call`, from, to: fn("health(Request)"), kind: "call", tier: "syntactic", evidence: AUDIT + ":4" });
    const a = clone(after);
    a.entities = a.entities.filter((e) => e.key !== from);
    const r = computeDrift(gs({ edges: [edge(from, fn("health(Request)"), "call", "remove")] }), b, a);
    expect(r.items[0]?.outcome).toBe("not-checked");
  });

  test("remove fe-be → not-checked when the join merely went unresolved", () => {
    const site = "web/src/api#getUser|GET /api/users/{*}";
    const route = "GET /api/users/{*}";
    const a = clone(after);
    a.edges = a.edges.filter((e) => e.key !== `${site}→${route}:fe-be`);
    for (const j of a.joins) if (j.fetchSite === site) Object.assign(j, { status: "unresolved", candidates: [], reason: "base URL unknown", tier: "unresolved" });
    const r = computeDrift(gs({ edges: [edge(site, route, "fe-be", "remove")] }), base, a);
    expect(r.items[0]?.outcome).toBe("not-checked");
    expect(r.items[0]?.reason).toContain("the join is unresolved (base URL unknown)");
  });

  test("remove of an import edge → verified when its block endpoint is proven gone", () => {
    const b = clone(after);
    const [from, to] = [":api/com.example.api.v2", KT];
    b.edges.push({ key: `${from}→${to}:import`, from, to, kind: "import", tier: "syntactic", evidence: API + "v2/Status.kt:1" });
    const r = computeDrift(gs({ edges: [edge(from, to, "import", "remove")] }), b, base);
    expect(r.items[0]).toMatchObject({ outcome: "verified", reason: expect.stringContaining(`no file of the after snapshot is in block ${from}`) as unknown as string });
  });

  test("remove of an edge the base never had → not-checked", () => {
    const r = computeDrift(gs({ edges: [edge(fn("ping(Request)"), fn("health(Request)"), "call", "remove")] }), base, after);
    expect(r.items[0]).toMatchObject({ outcome: "not-checked", reason: expect.stringContaining("not in the base snapshot") as unknown as string });
  });
});

describe("traces", () => {
  const trace = (scenario: string, steps: string[], a = after) => item(computeDrift(gs({ trace: [{ scenario, steps }] }), base, a), scenario);

  test("verified when every consecutive pair is an observed edge", () => {
    expect(trace("boot", [fn("main()"), fn("app(Greeter)"), fn("orderRoutes()")])).toMatchObject({ outcome: "verified", kind: "trace", op: null });
  });

  test("partial when some pairs are", () => {
    const it = trace("orders", [fn("main()"), fn("app(Greeter)"), fn("listOrders(Request)")]);
    expect(it.outcome).toBe("partial");
    expect(it.reason).toContain(`1 of 2 links verified; not observed: ${fn("app(Greeter)")} → ${fn("listOrders(Request)")}`);
  });

  test("not-checked when none are", () => {
    const it = trace("none", [fn("deleteOrder(Request)"), fn("health(Request)")]);
    expect(it.outcome).toBe("not-checked");
    expect(it.reason).toContain("no link observed");
  });

  test("not-checked when a step's file is not fully covered", () => {
    const it = trace("create", ["web/src/Users#UserCard", "web/src/api#createUser", "web/src/api#createUser|POST /api/users", "POST /api/users"]);
    expect(it.outcome).toBe("not-checked");
    expect(it.reason).toContain(`partial fetch coverage of ${API_TS}`);
  });

  test("not-checked when a step is ambiguous", () => {
    expect(trace("amb", [fn("createUser(Request)"), fn("helper(Int)")]).reason).toContain("ambiguous in the after snapshot");
  });

  test("a fetch site inside its enclosing function is a verified link", () => {
    const a = clone(after);
    for (const c of a.coverage) if (c.file === API_TS) Object.assign(c, { status: "full", reasons: [] });
    expect(trace("fetch", ["web/src/api#getUser", "web/src/api#getUser|GET /api/users/{*}"], a).outcome).toBe("verified");
  });
});

describe("block ghosts", () => {
  const blk = (id: string, op: Op) => ({ id, op, responsibility: "prose" });
  const run = (id: string, op: Op, b = base, a = after) => item(computeDrift(gs({ blocks: [blk(id, op)] }), b, a), id);

  test("add → verified when the block appears; not-checked when it does not (a new block's absence is unproven)", () => {
    expect(run(":api/com.example.api.v3", "add").outcome).toBe("not-checked");
    expect(run(":api/com.example.api.v2", "add").outcome).toBe("verified");
  });

  test("keep → verified; modify → verified when something in it changed, else unchanged", () => {
    expect(run(KT, "keep").outcome).toBe("verified");
    expect(run("web", "modify").outcome).toBe("verified");
    expect(run(":shared:core/com.example.core", "modify", base, base).outcome).toBe("unchanged");
  });

  test("remove → still-present / verified; unproven when a former file was not extracted", () => {
    expect(run("web", "remove").outcome).toBe("still-present");
    // after → base: the v2 block (Status.kt) disappears
    expect(run(":api/com.example.api.v2", "remove", after, base).outcome).toBe("verified");
    expect(run(":api/com.example.api.v2", "keep", after, base).outcome).toBe("missing");
    const b = clone(base);
    b.skipped.push({ path: API + "v2/Status.kt", reason: "binary content" });
    const it = run(":api/com.example.api.v2", "remove", after, b);
    expect(it.outcome).toBe("not-checked");
    expect(it.reason).toContain("Status.kt was not extracted (skipped: binary content)");
  });
});

describe("unexpected: changes with no ghost, scoped to what the ghost set touches", () => {
  test("a same-file change with no ghost is unexpected; a ghosted key is not", () => {
    const r = computeDrift(gs({ entities: [ent(fn("createUser(Request)"), "modify", APP)] }), base, after);
    const unexpected = r.items.filter((i) => i.op === null);
    expect(unexpected.find((i) => i.key === fn("getUser(Request)"))).toMatchObject({ outcome: "unexpected", reason: expect.stringContaining("content changed") as unknown as string });
    expect(unexpected.find((i) => i.key === fn("ping(Request)"))).toMatchObject({ outcome: "unexpected", reason: expect.stringContaining("added") as unknown as string });
    expect(unexpected.some((i) => i.key === fn("createUser(Request)"))).toBe(false);
  });

  test("churn in blocks the ghost set does not touch is not reported", () => {
    const r = computeDrift(gs({ entities: [ent(fn("createUser(Request)"), "modify", APP)] }), base, after);
    expect(r.items.some((i) => i.key.startsWith("com.example.core.") || i.key.startsWith("web/"))).toBe(false);
    // …but it is once a ghost touches that block
    const core = computeDrift(gs({ blocks: [{ id: ":shared:core/com.example.core", op: "keep", responsibility: "x" }] }), base, after);
    expect(core.items.find((i) => i.key === "com.example.core.Greeter.format(int,int)")?.outcome).toBe("unexpected");
    expect(core.items.some((i) => i.key.startsWith(fn("")))).toBe(false);
  });

  test("a removal with no ghost is unexpected when proven, not-checked when not", () => {
    const r = computeDrift(gs({ entities: [ent("web/src/api#pick", "keep", API_TS)] }), base, after);
    expect(r.items.find((i) => i.key === "web/src/api#listThings" && i.op === null)).toMatchObject({ outcome: "unexpected", reason: expect.stringContaining("removed") as unknown as string });
    const site = r.items.find((i) => i.key === "web/src/api#listThings|GET /api/{*}/list");
    expect(site).toMatchObject({ outcome: "not-checked", op: null, kind: "fetch-site" });
    expect(site?.reason).toContain("partial fetch coverage");
    expect(r.items.find((i) => i.key === "web/src/Users#UserCard")?.outcome).toBe("unexpected");
  });
});

describe("the report", () => {
  const mixed = (): GhostSet =>
    gs({
      blocks: [{ id: KT, op: "keep", responsibility: "api" }],
      entities: [
        ent(fn("ping(Request)"), "add", HANDLERS),
        ent(fn("pong(Request)"), "add", HANDLERS),
        ent(fn("health(Request)"), "keep", HANDLERS),
        ent(fn("adminRoutes()"), "modify", APP),
        ent("web/src/api#pick", "remove", API_TS),
      ],
      edges: [edge(fn("main()"), fn("app(Greeter)"), "call", "keep")],
      trace: [{ scenario: "boot", steps: [fn("main()"), fn("app(Greeter)")] }],
    });

  test("stamps the after commit (what 'verified' refers to) and both manifests", () => {
    const r = computeDrift(mixed(), base, after);
    expect(r.commit).toBe(fx.afterCommit);
    expect(r.baseCommit).toBe(fx.repo.commit);
    expect(r.manifestHash).toBe(after.manifestHash);
    expect(r.baseManifestHash).toBe(base.manifestHash);
  });

  test("counts cover every outcome and every item; ordered worst outcome first", () => {
    const r = computeDrift(mixed(), base, after);
    expect(Object.keys(r.counts).sort()).toEqual([...DRIFT_OUTCOMES].sort());
    expect(Object.values(r.counts).reduce((a, b) => a + b, 0)).toBe(r.items.length + r.truncated);
    const ranks = r.items.map((i) => DRIFT_OUTCOMES.indexOf(i.outcome));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(r.items[0]?.outcome).toBe("missing");
    expect(r.items.at(-1)?.outcome).toBe("verified");
  });

  test("deterministic: ghost order does not matter, output is byte-identical", () => {
    const g = mixed();
    const shuffled = { ...g, entities: [...g.entities].reverse(), edges: [...g.edges].reverse() };
    expect(JSON.stringify(computeDrift(shuffled, base, after))).toBe(JSON.stringify(computeDrift(g, base, after)));
  });

  test(`capped at ${DRIFT_CAP} items with a truncation count; problems survive truncation`, () => {
    const many = Array.from({ length: 250 }, (_, i) => ent(fn(`gen${String(i).padStart(3, "0")}()`), "add", HANDLERS));
    const r = computeDrift(gs({ entities: [...many, ent(fn("deleteOrder(Request)"), "keep", APP)] }), base, after);
    expect(r.items).toHaveLength(DRIFT_CAP);
    const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(DRIFT_CAP);
    expect(r.truncated).toBe(total - DRIFT_CAP);
    expect(r.counts.missing).toBe(250);
    expect(r.counts.verified).toBe(1);
    expect(r.items.every((i) => i.outcome === "missing")).toBe(true);
    const small = computeDrift(mixed(), base, after, { cap: 2 });
    expect(small.items).toHaveLength(2);
    expect(small.truncated).toBe(Object.values(small.counts).reduce((a, b) => a + b, 0) - 2);
  });
});

/**
 * Review regressions (1c-A): each case below once produced a false `verified` / `missing` /
 * `unexpected` from real extractions. A second implementation commit on a fresh fixture repo:
 *   - Main.kt     `app(Greeter(…))` wrapped in `run { … }` → the main→app call edge goes invisible
 *   - App.kt      adminRoutes gets a LOCAL `crudPath` → the adminRoutes→crudPath edge goes invisible
 *   - Orders.kt   listOrders re-wrapped + trailing comment; a comment inside orderRoutes' routes(…)
 *   - Status.kt   `val statusRoutes: HttpHandler = routes("/status" …)` — a property, unmounted route
 *   - api.ts      `export const api = { getThing() {…} }` — an object-literal method; a class
 *                 field `handler = debounce(…)` holding a value
 *   - Users.tsx   loadAvatar fetches `${BASE}/api/avatars/${id}` — a `{*}`-prefixed fetch site
 */
describe("regressions: things the map keys differently are never verified or missing", () => {
  let b2: AssembledMap;
  let a2: AssembledMap;
  beforeAll(async () => {
    const repo = fixtureRepo();
    const store = new MapStore(repo.storeDir);
    const mapAt = async (commit: string) => assemble((await extract({ repoDir: repo.dir, store, workers: 0, commit })).manifest, store);
    b2 = await mapAt(repo.commit);
    const edit = (p: string, f: (s: string) => string) => {
      const before = readFileSync(join(repo.dir, p), "utf8");
      const next = f(before);
      if (next === before) throw new Error(`edit to ${p} changed nothing`);
      writeFileSync(join(repo.dir, p), next);
    };
    edit(MAIN, (s) => s.replace('app(Greeter("hi ")).asServer', 'run { app(Greeter("hi ")) }.asServer'));
    edit(APP, (s) => s.replace('fun adminRoutes(): HttpHandler = routes(\n    crudPath("/admin") bind GET to ::health,\n)', 'fun adminRoutes(): HttpHandler {\n    val crudPath = { base: String -> base + "/items" }\n    return routes(crudPath("/admin") bind GET to ::health)\n}'));
    edit(ORDERS, (s) => s.replace("fun listOrders(req: Request): Response = Response(OK)", "fun listOrders(req: Request): Response =\n    Response(OK) // reformatted").replace('    "/orders" bind GET', '    // list every order\n    "/orders" bind GET'));
    writeFileSync(join(repo.dir, API, "Status.kt"), 'package com.example.api\n\nimport org.http4k.core.HttpHandler\nimport org.http4k.core.Method.GET\nimport org.http4k.routing.bind\nimport org.http4k.routing.routes\n\nval statusRoutes: HttpHandler = routes("/status" bind GET to ::listOrders)\n');
    edit(API_TS, (s) => s + "\nexport const api = { getThing() { return 1; } };\nexport class Poller {\n  handler = debounce(() => 1);\n}\n");
    edit(USERS_TSX, (s) => s + "\nexport function loadAvatar(id: string) {\n  return fetch(`${BASE}/api/avatars/${id}`);\n}\n");
    a2 = await mapAt(commitAll(repo.dir, "implementation"));
  });
  const run2 = (g: GhostSet) => computeDrift(g, b2, a2);

  test("item 1: an edge hidden by wrapping the call in a lambda is not a verified removal", () => {
    expect(a2.edges.some((e) => e.from === fn("main()"))).toBe(false); // the precondition: it went invisible
    const r = run2(gs({ edges: [edge(fn("main()"), fn("app(Greeter)"), "call", "remove")] }));
    expect(r.items[0]).toMatchObject({ outcome: "not-checked", reason: expect.stringContaining("neither endpoint is proven gone") as unknown as string });
  });

  test("item 1: an edge hidden by a same-named local is not a verified removal", () => {
    expect(a2.edges.some((e) => e.key === `${fn("adminRoutes()")}→${fn("crudPath(String)")}:call`)).toBe(false);
    expect(run2(gs({ edges: [edge(fn("adminRoutes()"), fn("crudPath(String)"), "call", "remove")] })).items[0]?.outcome).toBe("not-checked");
  });

  test("item 4: whitespace-only and comment-only edits are not content changes", () => {
    const listOrders = ent(fn("listOrders(Request)"), "modify", ORDERS);
    expect(item(run2(gs({ entities: [listOrders] })), listOrders.id).outcome).toBe("unchanged");
    expect(item(run2(gs({ entities: [{ ...listOrders, op: "keep" }] })), listOrders.id).outcome).toBe("verified");
    const orderRoutes = ent(fn("orderRoutes()"), "keep", ORDERS);
    expect(item(run2(gs({ entities: [orderRoutes] })), orderRoutes.id).outcome).toBe("verified");
    // …while a real token change still is one
    expect(item(run2(gs({ entities: [ent(fn("adminRoutes()"), "modify", APP)] })), fn("adminRoutes()")).outcome).toBe("verified");
  });

  test("item 3a: a TS object-literal method is a possible match, never missing", () => {
    const it = item(run2(gs({ entities: [ent("web/src/api#api.getThing", "add", API_TS)] })), "web/src/api#api.getThing");
    expect(it.outcome).toBe("not-checked");
    expect(it.reason).toContain("a possible match exists in a form the map keys differently");
    expect(it.reason).toContain(`property api @ ${API_TS}:`);
  });

  test("re-review item 3: a TS class field holding a value is a possible match for a method of that name", () => {
    const it = item(run2(gs({ entities: [ent("web/src/api#Poller.handler", "add", API_TS)] })), "web/src/api#Poller.handler");
    expect(it.outcome).toBe("not-checked");
    expect(it.reason).toContain(`property Poller.handler @ ${API_TS}:`);
  });

  test("item 3a: a Kotlin property holding a handler is a possible match for a function of that name", () => {
    const it = item(run2(gs({ entities: [ent(fn("statusRoutes()"), "add", API + "Status.kt")] })), fn("statusRoutes()"));
    expect(it.outcome).toBe("not-checked");
    expect(it.reason).toContain(`property statusRoutes @ ${API}Status.kt:8`);
  });

  test("item 3b: a route whose mount prefix is unknown ({*}/…) is a possible match", () => {
    // Handlers.kt has full http4k coverage, so only the near match stands between this and `missing`
    const it = item(run2(gs({ entities: [ent("GET /api/status", "add", HANDLERS, "route")] })), "GET /api/status");
    expect(it.outcome).toBe("not-checked");
    expect(it.reason).toContain("route GET {*}/status @");
  });

  test("item 3b: a route re-keyed to {*}/… (its server root went unresolvable) is not missing", () => {
    // wrapping main's app(…) in run { } un-roots every route: GET /shop/orders is now GET {*}/shop/orders
    expect(a2.entities.some((e) => e.key === "GET {*}/shop/orders")).toBe(true);
    const it = item(run2(gs({ entities: [ent("GET /shop/orders", "keep", ORDERS, "route")] })), "GET /shop/orders");
    expect(it.outcome).toBe("not-checked");
    const moved = item(run2(gs({ entities: [ent("GET /shop/orders", "keep", HANDLERS, "route")] })), "GET /shop/orders");
    expect(moved.outcome).toBe("not-checked");
  });

  test("item 3c: a `{*}`-templated fetch site is a possible match", () => {
    const id = "web/src/Users#loadAvatar|GET /api/avatars/{*}";
    const it = item(run2(gs({ entities: [ent(id, "add", USERS_TSX, "fetch-site")] })), id);
    expect(it.outcome).toBe("not-checked");
    expect(it.reason).toContain("fetch-site web/src/Users#loadAvatar|GET {*}/api/avatars/{*}");
  });

  test("control: something genuinely absent from a fully covered file is still missing", () => {
    expect(item(run2(gs({ entities: [ent(fn("pong(Request)"), "add", ORDERS)] })), fn("pong(Request)"))).toMatchObject({ outcome: "missing" });
    expect(item(run2(gs({ entities: [ent("GET /shop/refunds", "add", HANDLERS, "route")] })), "GET /shop/refunds").outcome).toBe("missing");
  });
});

describe("regressions: absence in BASE needs proof too (item 2)", () => {
  const ORD = ORDERS;
  /** Base where Orders.kt hit a transient worker error. */
  const baseWithout = (why: "notChecked" | "skipped") => {
    const b = clone(base);
    b.files = b.files.filter((f) => f.path !== ORD);
    b.entities = b.entities.filter((e) => e.file !== ORD);
    b.coverage = b.coverage.filter((c) => c.file !== ORD);
    b.edges = b.edges.filter((e) => !e.evidence.startsWith(ORD));
    if (why === "notChecked") b.notChecked.push({ path: ORD, reason: "worker error: boom" });
    else b.skipped.push({ path: ORD, reason: "too large (1100000 bytes > 1048576)" });
    return b;
  };

  test("add is not verified when the base never saw the file (not-checked / skipped)", () => {
    for (const why of ["notChecked", "skipped"] as const) {
      const it = one(ent(fn("orderRoutes()"), "add", ORD), after, baseWithout(why));
      expect(it.outcome).toBe("not-checked");
      expect(it.reason).toContain("present after, but absence in the base snapshot is not proven");
    }
  });

  test("add is not verified when an unparsed region in base could have hidden it", () => {
    const b = clone(base);
    b.unparsed.push({ file: HANDLERS, evidence: HANDLERS + ":40", startLine: 40, endLine: 44, kind: "error" });
    expect(one(ent(fn("ping(Request)"), "add", HANDLERS), after, b).reason).toContain(`${HANDLERS} has unparsed region(s) at lines 40-44`);
  });

  test("add is not verified when the base had it under an open ({*}) route key", () => {
    const b = clone(base);
    for (const e of b.entities) if (e.key === "GET /shop/orders") Object.assign(e, { key: "GET {*}/orders", route: { ...e.route, template: "{*}/orders" } });
    const a = clone(base);
    const it = one(ent("GET /shop/orders", "add", ORD, "route"), a, b);
    expect(it.outcome).toBe("not-checked");
    expect(it.reason).toContain("route GET {*}/orders @");
  });

  test("unexpected 'added since base' needs the same proof", () => {
    const r = computeDrift(gs({ entities: [ent(fn("main()"), "keep", MAIN)] }), baseWithout("notChecked"), after);
    const orders = r.items.filter((i) => i.op === null && i.evidence?.startsWith(ORD));
    expect(orders.length).toBeGreaterThan(0);
    for (const i of orders) {
      expect(i.outcome).toBe("not-checked");
      expect(i.reason).toContain("absence in the base snapshot is not proven");
    }
  });
});

describe("regressions: block outcomes need proven entity changes (item 5)", () => {
  test("modify is not verified when the only difference is a file that went not-checked", () => {
    const a = clone(base);
    a.files = a.files.filter((f) => f.path !== ORDERS);
    a.entities = a.entities.filter((e) => e.file !== ORDERS);
    a.notChecked.push({ path: ORDERS, reason: "worker error: boom" });
    const it = item(computeDrift(gs({ blocks: [{ id: KT, op: "modify", responsibility: "x" }] }), base, a), KT);
    expect(it.outcome).toBe("not-checked");
    expect(it.reason).toContain("no change is proven");
  });

  test("a block is not proven gone while a file in its directory went unextracted", () => {
    const a = clone(base);
    a.notChecked.push({ path: API + "v2/Other.kt", reason: "worker error: boom" });
    const it = item(computeDrift(gs({ blocks: [{ id: ":api/com.example.api.v2", op: "remove", responsibility: "x" }] }), after, a), ":api/com.example.api.v2");
    expect(it.outcome).toBe("not-checked");
    expect(it.reason).toContain("in the block's directory, was not extracted");
  });

  test("a new block is not verified while its directory was unextracted in base", () => {
    const b = clone(base);
    b.skipped.push({ path: API + "v2/Status.kt", reason: "binary content" });
    const it = item(computeDrift(gs({ blocks: [{ id: ":api/com.example.api.v2", op: "add", responsibility: "x" }] }), b, after), ":api/com.example.api.v2");
    expect(it.outcome).toBe("not-checked");
    expect(it.reason).toContain("absence in the base snapshot is not proven");
  });
});

describe("regressions: absent / ignored expected files (item 6) and where things landed (item 7)", () => {
  const ghost = ent("web/src/local/x#foo", "add", "web/src/local/x.ts");

  test("an expected file absent from the snapshot says so — not 'searched with full coverage'", () => {
    const it = one(ghost);
    expect(it.outcome).toBe("missing");
    expect(it.reason).toBe("not found in the after snapshot; web/src/local/x.ts is not in the after snapshot (never created, deleted, or git-ignored)");
  });

  test("ignoredOnDisk marks a git-ignored expected file not-checked", () => {
    const it = item(computeDrift(gs({ entities: [ghost] }), base, after, { ignoredOnDisk: ["web/src/local/x.ts"] }), ghost.id);
    expect(it).toMatchObject({ outcome: "not-checked", reason: expect.stringContaining("web/src/local/x.ts is git-ignored on disk, so it was never extracted") as unknown as string });
  });

  test("an entity that landed in another file or block is not verified", () => {
    const wrongFile = one(ent(fn("ping(Request)"), "add", APP));
    expect(wrongFile.outcome).toBe("not-checked");
    expect(wrongFile.reason).toContain(`landed at ${HANDLERS}:`);
    const wrongBlock = one(ent(fn("createUser(Request)"), "modify", APP, "function", ":api/com.example.api.v2"));
    expect(wrongBlock.outcome).toBe("not-checked");
    expect(wrongBlock.reason).toContain(`in block ${KT}, not in ${APP} / block :api/com.example.api.v2`);
  });
});

describe("re-review regressions", () => {
  test("item 1: snapshots from different extractor versions → every ghost not-checked, no unexpected", () => {
    expect(sameExtractor(base, after)).toBe(true);
    const old = { ...clone(base), extractorVersion: "map-1b.000000000000" };
    expect(sameExtractor(old, after)).toBe(false);
    const g = gs({
      blocks: [{ id: KT, op: "modify", responsibility: "x" }],
      entities: [ent(fn("createUser(Request)"), "modify", APP), ent(fn("deleteOrder(Request)"), "keep", APP), ent(fn("pong(Request)"), "add", HANDLERS)],
      edges: [edge(fn("main()"), fn("app(Greeter)"), "call", "keep")],
      trace: [{ scenario: "boot", steps: [fn("main()"), fn("app(Greeter)")] }],
    });
    const r = computeDrift(g, old, after);
    expect(r.items).toHaveLength(6);
    for (const i of r.items) {
      expect(i.outcome).toBe("not-checked");
      expect(i.reason).toBe(`snapshots extracted by different extractor versions (map-1b.000000000000 vs ${after.extractorVersion}) — re-extract base with the current extractor`);
    }
    expect(r.items.some((i) => i.op === null && i.kind !== "trace")).toBe(false);
  });

  test("item 6: an ambiguous key losing an instance whose file went not-checked is not a proven change", () => {
    const a = clone(after);
    a.entities = a.entities.filter((e) => !(e.key === fn("helper(Int)") && e.file === HANDLERS));
    a.notChecked.push({ path: HANDLERS, reason: "worker error: boom" });
    const r = computeDrift(gs({ entities: [ent(fn("deleteOrder(Request)"), "keep", APP)] }), base, a);
    const helper = r.items.find((i) => i.key === fn("helper(Int)"));
    expect(helper).toMatchObject({ outcome: "not-checked", op: null });
    expect(helper?.reason).toContain(`an instance of this ambiguous key is not seen after, but its absence is not proven: ${HANDLERS} was not checked`);
    // …and so it proves nothing for a block modify either
    const b = item(computeDrift(gs({ blocks: [{ id: KT, op: "modify", responsibility: "x" }] }), base, (() => {
      const only = clone(base);
      only.entities = only.entities.filter((e) => !(e.key === fn("helper(Int)") && e.file === HANDLERS));
      only.notChecked.push({ path: HANDLERS, reason: "worker error: boom" });
      return only;
    })()), KT);
    expect(b.outcome).toBe("not-checked");
  });

  test("item 6: an ambiguous key whose instances' content changed in place is still a proven change", () => {
    const a = clone(after);
    for (const e of a.entities) if (e.key === fn("helper(Int)") && e.file === APP) e.contentHash = "0".repeat(16);
    const r = computeDrift(gs({ entities: [ent(fn("deleteOrder(Request)"), "keep", APP)] }), base, a);
    expect(r.items.find((i) => i.key === fn("helper(Int)"))).toMatchObject({ outcome: "unexpected", reason: "content changed (ambiguous key) since base, with no ghost for it" });
  });
});
