import { beforeAll, describe, expect, test } from "bun:test";
import { edgeKey } from "./keys";
import { MAX_SUFFIX_MATCHES, neighbourhood, NEIGHBOURHOOD_CAP, renderNeighbourhood, RENDER_MAX_CHARS, ticketEntities, type TicketMatch } from "./neighbourhood";
import { sliceFixture } from "./testkit";
import type { AssembledMap, Entity } from "./types";

const API = "api/src/main/kotlin/com/example/api/";
const fn = (name: string) => `com.example.api.<top>.${name}`;

let base: AssembledMap;
beforeAll(async () => {
  base = (await sliceFixture()).base;
});

const matchesFor = (goal: string, work = "") => ticketEntities(goal, work, base);
const pick = (ms: TicketMatch[], token: string) => ms.filter((m) => m.token === token).map((m) => [m.key, m.via, m.match]);

/** `n` TS functions `web/src/m<i>#doThing` in a call chain m0 → m1 → … (for caps and breadth). */
function chainMap(n: number): AssembledMap {
  const entities: Entity[] = Array.from({ length: n }, (_, i) => {
    const file = `web/src/m${String(i).padStart(3, "0")}.ts`;
    return { key: `web/src/m${String(i).padStart(3, "0")}#doThing`, kind: "function", name: "doThing", block: "web", file, line: 1, endLine: 2, tier: "syntactic", evidence: `${file}:1`, contentHash: `h${i}` };
  });
  const edges = entities.slice(1).map((e, i) => ({ key: edgeKey(entities[i]?.key ?? "", e.key, "call"), from: entities[i]?.key ?? "", to: e.key, kind: "call" as const, tier: "syntactic" as const, evidence: `${entities[i]?.file ?? ""}:2` }));
  return {
    manifestHash: "m".repeat(64),
    commit: "c".repeat(40),
    extractorVersion: "test",
    files: entities.map((e) => ({ path: e.file, language: "typescript", block: "web", objectKey: "o", module: e.file.replace(/\.ts$/, "") })),
    blocks: [{ key: "web", family: "ts", packageDir: "web", files: entities.map((e) => e.file), tier: "syntactic", evidence: "web/src/m000.ts:1" }],
    entities,
    edges,
    joins: [],
    coverage: [],
    unparsed: [],
    casts: [],
    names: [],
    skipped: [],
    notChecked: [],
    adapters: [],
  };
}

describe("ticketEntities: deterministic matching of ticket text to snapshot keys", () => {
  test("a file path: exact repo-relative path, else suffix; seeds every entity in the file", () => {
    const exact = matchesFor("see web/src/Users.tsx");
    expect(pick(exact.matches, "web/src/Users.tsx")).toEqual([
      ["web/src/Users#UserCard", "file", "exact"],
      ["web/src/Users#default", "file", "exact"],
    ]);
    const suffix = matchesFor("crash in Orders.kt:12, see [Users.tsx](web/src/Users.tsx)");
    expect(pick(suffix.matches, "Orders.kt")).toEqual([
      ["GET /shop/orders", "file", "suffix"],
      [fn("listOrders(Request)"), "file", "suffix"],
      [fn("orderRoutes()"), "file", "suffix"],
    ]);
    expect(pick(suffix.matches, "web/src/Users.tsx")).toHaveLength(2); // markdown link target
  });

  test("a symbol: exact full key first, else suffix at a boundary — functions only", () => {
    const m = matchesFor("getUser should 404", "and `com.example.api.<top>.main()` logs it");
    expect(pick(m.matches, "getUser")).toEqual([
      [fn("getUser(Request)"), "symbol", "suffix"],
      ["web/src/api#getUser", "symbol", "suffix"],
    ]);
    expect(pick(m.matches, fn("main()"))).toEqual([[fn("main()"), "symbol", "exact"]]);
    // dotted and overloads; `name()` means any parameters; routes ending in /health are not `health`
    expect(pick(matchesFor("Renderer.render is slow").matches, "Renderer.render").map((x) => x[0])).toEqual(["com.example.api.Renderer.render(Order)", "com.example.api.Renderer.render(User)"]);
    expect(pick(matchesFor("call health() please").matches, "health()").map((x) => x[0])).toEqual([fn("health(Request)"), "web/src/api#ApiClient.health"]);
    // a qualified-enough token narrows it
    expect(pick(matchesFor("fix api#getUser").matches, "api#getUser").map((x) => x[0])).toEqual(["web/src/api#getUser"]);
  });

  test("prose words never seed; only code-looking tokens (or backticked ones) do", () => {
    expect(matchesFor("the main app should report health").seeds).toEqual([]);
    expect(matchesFor("look at `health`").seeds).toEqual([fn("health(Request)"), "web/src/api#ApiClient.health"]);
  });

  test("a route string is normalised like a key: METHOD + path, bare paths, URLs, {id} placeholders", () => {
    const m = matchesFor("GET /api/users/42 returns 500", "and `DELETE /api/v1/orders/{orderId}` too");
    expect(pick(m.matches, "GET /api/users/42")).toEqual([
      ["GET /api/users/{*}", "route", "exact"],
      ["web/src/api#getUser|GET /api/users/{*}", "route", "exact"],
    ]);
    expect(pick(m.matches, "DELETE /api/v1/orders/{orderId}")).toEqual([["DELETE /api/v1/orders/{*}", "route", "exact"]]);
    // a placeholder never names a literal segment: /api/users/{id} is not /api/{*}/list
    expect(pick(matchesFor("`GET /api/users/{id}`").matches, "GET /api/users/{id}").map((x) => x[0])).toEqual(["GET /api/users/{*}", "web/src/api#getUser|GET /api/users/{*}"]);
    // a bare path suffix-matches; a wildcard alone is not a match (/orders is not /api/v1/orders/{*})
    expect(pick(matchesFor("/orders is slow").matches, "/orders")).toEqual([["GET /shop/orders", "route", "suffix"]]);
    // a pasted URL names our route whatever the host, but never an absolute fetch site on another origin
    expect(pick(matchesFor("https://example.com/api/users/1").matches, "https://example.com/api/users/1").map((x) => x[0])).toEqual(["GET /api/users/{*}"]);
  });

  test("a backticked block key seeds the block", () => {
    expect(pick(matchesFor("everything in `:api/com.example.api` and `web`").matches, "web")).toEqual([["web", "block", "exact"]]);
    expect(matchesFor("everything in `:api/com.example.api`").seeds).toEqual([":api/com.example.api"]);
  });

  test("a suffix token matching too many entities is reported, not seeded", () => {
    const map = chainMap(MAX_SUFFIX_MATCHES + 5);
    const r = ticketEntities("fix doThing()", "", map);
    expect(r.seeds).toEqual([]);
    expect(r.tooBroad).toEqual([{ token: "doThing()", via: "symbol", candidates: MAX_SUFFIX_MATCHES + 5 }]);
    expect(r.needsEntryPoint).toBe(true);
    // an exact key is never too broad
    expect(ticketEntities("fix `web/src/m003#doThing`", "", map).seeds).toEqual(["web/src/m003#doThing"]);
  });

  test("no match → needsEntryPoint (the operator picks)", () => {
    expect(matchesFor("make it faster", "nothing specific")).toEqual({ seeds: [], matches: [], tooBroad: [], needsEntryPoint: true });
  });

  test("deterministic: the same text always gives the same result; goal and work are both read", () => {
    const a = matchesFor("getUser and Orders.kt", "GET /health");
    expect(matchesFor("getUser and Orders.kt", "GET /health")).toEqual(a);
    expect(a.seeds).toEqual([...a.seeds].sort());
    expect(a.seeds).toContain("GET /health");
  });
});

describe("neighbourhood: bounded expansion", () => {
  test("hops expand along edges in both directions", () => {
    const one = neighbourhood(base, [fn("app(Greeter)")], 1);
    expect(one.entities.map((e) => [e.entity.key, e.hop])).toEqual([
      [fn("adminRoutes()"), 1],
      [fn("app(Greeter)"), 0],
      [fn("main()"), 1], // incoming
      [fn("orderRoutes()"), 1], // outgoing
    ]);
    const two = neighbourhood(base, [fn("main()")], 2).entities.map((e) => [e.entity.key, e.hop]);
    expect(two).toContainEqual([fn("orderRoutes()"), 2]);
    expect(two).not.toContainEqual([fn("crudPath(String)"), expect.anything()]);
  });

  test("a fetch site and its enclosing function are neighbours; so are join candidates", () => {
    const n = neighbourhood(base, ["web/src/api#getUser"], 1).entities.map((e) => e.entity.key);
    expect(n).toContain("web/src/api#getUser|GET /api/users/{*}");
    const site = neighbourhood(base, ["web/src/api#getUser|GET /api/users/{*}"], 1).entities.map((e) => e.entity.key);
    expect(site).toContain("GET /api/users/{*}");
  });

  test("a block seed brings its entities at hop 1; entities bring their block as context", () => {
    const n = neighbourhood(base, ["web"], 1);
    expect(n.entities.every((e) => e.entity.block === "web" || e.hop === 1)).toBe(true);
    expect(n.entities.filter((e) => e.entity.block === "web").length).toBe(base.entities.filter((e) => e.block === "web").length);
    expect(neighbourhood(base, [fn("main()")], 0).blocks.map((b) => b.key)).toEqual([":api/com.example.api"]);
  });

  test("capped, nearest first, with the truncation reported", () => {
    const map = chainMap(300);
    const n = neighbourhood(map, ["web/src/m150#doThing"], 200);
    expect(n.entities).toHaveLength(NEIGHBOURHOOD_CAP);
    expect(n.truncated).toBe(300 - NEIGHBOURHOOD_CAP);
    // from the middle of a chain: the seed, then two per hop — 150 entities reach hop 75
    expect(Math.max(...n.entities.map((e) => e.hop))).toBe(75);
    const small = neighbourhood(map, ["web/src/m150#doThing"], 2, 3);
    expect(small.entities.map((e) => e.entity.key)).toEqual(["web/src/m149#doThing", "web/src/m150#doThing", "web/src/m151#doThing"]);
    expect(small.truncated).toBe(2);
  });

  test("unknown seeds are reported and ignored; coverage notes cover the included files", () => {
    const n = neighbourhood(base, ["web/src/api#getUser", "web/src/api#nope"]);
    expect(n.unknownSeeds).toEqual(["web/src/api#nope"]);
    expect(n.notes.partial.map((c) => `${c.file} ${c.adapter}`)).toContain("web/src/api.ts fetch");
    expect(n.notes.notExtracted.map((x) => x.path)).toContain("web/src/huge-data.ts");
  });

  test("ambiguous keys are listed with every entity and flagged", () => {
    const n = neighbourhood(base, [fn("createUser(Request)")], 1);
    expect(n.entities.filter((e) => e.entity.key === fn("helper(Int)"))).toHaveLength(2);
    expect(n.notes.ambiguous).toEqual([{ key: fn("helper(Int)"), evidence: [API + "App.kt:32", API + "Handlers.kt:42"] }]);
  });
});

describe("renderNeighbourhood", () => {
  test("compact, deterministic text with tiers, evidence, edges and coverage notes", () => {
    const n = neighbourhood(base, ticketEntities("fix `web/src/api#getUser`", "", base).seeds);
    const text = renderNeighbourhood(n);
    expect(renderNeighbourhood(neighbourhood(base, ["web/src/api#getUser"]))).toBe(text);
    expect(text).toContain("- function `web/src/api#getUser` [syntactic] web/src/api.ts:9 (seed)");
    expect(text).toContain("## block `web` (ts, 4 files) [syntactic]");
    expect(text).toContain("- `web/src/Users#UserCard` → `web/src/api#getUser` (call) [syntactic] web/src/Users.tsx:5");
    expect(text).toContain("## coverage notes");
    expect(text).toContain("- partial fetch coverage of web/src/api.ts: fetch URL is a non-literal expression: url (web/src/api.ts:27)");
    expect(text).toContain("absence from this list is NOT evidence");
  });

  test("ambiguous entities and unresolved joins are labelled", () => {
    const text = renderNeighbourhood(neighbourhood(base, [fn("createUser(Request)"), "web/src/api#deleteOrder|DELETE {*}/orders/{*}"], 1));
    expect(text).toContain(`\`${fn("helper(Int)")}\` [syntactic] ${API}App.kt:32 AMBIGUOUS`);
    expect(text).toContain("do not use it as a ghost id");
    expect(text).toMatch(/## unresolved joins \(candidates, not facts\)\n- `web\/src\/api#deleteOrder\|DELETE \{\*\}\/orders\/\{\*\}`: (pattern-match|unresolved)/);
  });

  test(`bounded by maxChars (default ${RENDER_MAX_CHARS}) with explicit markers`, () => {
    const map = chainMap(300);
    for (const e of map.entities) map.coverage.push({ file: e.file, adapter: "fetch", status: "partial", candidates: 1, reasons: [{ line: 1, reason: "x".repeat(900), evidence: `${e.file}:1` }] });
    const n = neighbourhood(map, ["web/src/m150#doThing"], 200);
    const full = renderNeighbourhood(n);
    expect(full.length).toBeLessThanOrEqual(RENDER_MAX_CHARS);
    expect(full).toContain("more lines omitted (size cap)");
    for (const max of [600, 2000, 5000]) {
      const t = renderNeighbourhood(n, max);
      expect(t.length).toBeLessThanOrEqual(max);
      expect(t).toContain("(size cap)");
    }
  });

  test("no seeds → a one-line explanation, not an empty map", () => {
    const text = renderNeighbourhood(neighbourhood(base, []));
    expect(text).toContain("No entity was named by the ticket");
  });
});
