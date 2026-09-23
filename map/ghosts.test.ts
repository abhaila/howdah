import { beforeAll, describe, expect, test } from "bun:test";
import { ghostEdgeId, ghostEntityIds, MAX_ERRORS, orphanedComments, validateGhostSet, type GhostSet } from "./ghosts";
import { sliceFixture } from "./testkit";
import type { AssembledMap } from "./types";

const API = "api/src/main/kotlin/com/example/api/";
const APP = API + "App.kt";
const HANDLERS = API + "Handlers.kt";
const KT = ":api/com.example.api";
const fn = (name: string) => `com.example.api.<top>.${name}`;

let base: AssembledMap;
beforeAll(async () => {
  base = (await sliceFixture()).base;
});

/** A valid ghost set touching every section — tests break one thing at a time. */
function valid(): GhostSet {
  return {
    blocks: [
      { id: KT, op: "modify", responsibility: "http4k API", plane: "backend" },
      { id: ":api/com.example.api.v2", op: "add", responsibility: "v2 status" },
    ],
    entities: [
      { id: fn("ping(Request)"), op: "add", block: KT, kind: "function", expected_file: HANDLERS, names: ["ping handler"] },
      { id: "GET /ping", op: "add", block: KT, kind: "route", expected_file: APP },
      { id: fn("health(Request)"), op: "modify", block: KT, kind: "function", expected_file: HANDLERS },
      { id: fn("deleteOrder(Request)"), op: "keep", block: KT, kind: "function", expected_file: APP },
      { id: "web/src/api#listThings", op: "remove", block: "web", kind: "function", expected_file: "web/src/api.ts" },
      { id: "web/src/status#useStatus", op: "add", block: "web", kind: "function", expected_file: "web/src/status.tsx" },
      { id: "web/src/status#useStatus|GET /ping", op: "add", block: "web", kind: "fetch-site", expected_file: "web/src/status.tsx" },
      { id: "com.example.api.v2.<top>.status()", op: "add", block: ":api/com.example.api.v2", kind: "function", expected_file: API + "v2/Status.kt" },
    ],
    edges: [
      { from: "GET /ping", to: fn("ping(Request)"), kind: "route-handler", op: "add" },
      { from: fn("main()"), to: fn("app(Greeter)"), kind: "call", op: "keep" },
      { from: "web/src/status#useStatus|GET /ping", to: "GET /ping", kind: "fe-be", op: "add" },
      { from: "web", to: KT, kind: "import", op: "add" },
    ],
    trace: [{ scenario: "status poll", steps: ["web/src/status#useStatus", "web/src/status#useStatus|GET /ping", "GET /ping", fn("ping(Request)")] }],
  };
}

/** Run the validator on a mutated copy of `valid()` and return its errors. */
function errorsOf(mutate: (g: GhostSet & Record<string, unknown>) => void): string[] {
  const g = structuredClone(valid()) as GhostSet & Record<string, unknown>;
  mutate(g);
  const r = validateGhostSet(g, base);
  if (r.ok) throw new Error("expected the ghost set to be rejected");
  return r.errors;
}
const entity = (g: GhostSet, i: number) => {
  const e = g.entities[i];
  if (e === undefined) throw new Error(`no entity ${i}`);
  return e as unknown as Record<string, unknown>;
};

describe("validateGhostSet: accepts", () => {
  test("a valid set touching every section, returned as given", () => {
    const r = validateGhostSet(valid(), base);
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(r.ghosts).toEqual(valid());
  });

  test("empty trace / edges arrays", () => {
    const g = { ...valid(), edges: [], trace: [] };
    expect(validateGhostSet(g, base).ok).toBe(true);
  });
});

describe("validateGhostSet: rejects, each with an actionable message", () => {
  test("a non-object, and missing arrays", () => {
    expect(validateGhostSet("[]", base)).toEqual({ ok: false, errors: [expect.stringContaining("must be a JSON object") as unknown as string] });
    expect(validateGhostSet(null, base).ok).toBe(false);
    expect(errorsOf((g) => delete (g as Partial<GhostSet>).trace)).toEqual(['ghost set: "trace" must be an array (use [] if there are none)']);
  });

  test("unknown fields (a typo never passes silently)", () => {
    expect(errorsOf((g) => (entity(g, 0).expectedFile = "x.kt"))).toContain(`entities[0] "${fn("ping(Request)")}": unknown field "expectedFile" (allowed: id, op, block, kind, expected_file, names)`);
    expect(errorsOf((g) => (g.notes = "hi"))).toEqual(['ghost set: unknown field "notes" (allowed: blocks, entities, edges, trace)']);
  });

  test("a bad op or kind", () => {
    expect(errorsOf((g) => (entity(g, 0).op = "create"))[0]).toContain('"op" must be one of add | modify | remove | keep (got "create")');
    expect(errorsOf((g) => (entity(g, 0).kind = "class"))[0]).toContain('"kind" must be one of route | function | fetch-site');
  });

  test("modify / remove / keep of an id that is not in the base snapshot", () => {
    for (const op of ["modify", "remove", "keep"]) {
      const errs = errorsOf((g) => Object.assign(entity(g, 2), { id: fn("healthz(Request)"), op }));
      expect(errs).toEqual([`entities[2] "${fn("healthz(Request)")}": op "${op}" needs an entity that exists in the base snapshot, and this key does not — copy the exact key from the map neighbourhood, or use op "add" for a new entity`]);
    }
  });

  test("modify / remove / keep of an AMBIGUOUS id tells the proposer to target something else", () => {
    const [err] = errorsOf((g) => Object.assign(entity(g, 2), { id: fn("helper(Int)"), op: "keep", expected_file: APP }));
    expect(err).toContain("is ambiguous in the base snapshot (2 entities share this key:");
    expect(err).toContain(`${APP}:`);
    expect(err).toContain("leave it out of the ghost set");
  });

  test("add with bad key grammar", () => {
    const [err] = errorsOf((g) => (entity(g, 0).id = "com.example.api.<top>.ping(Request"));
    expect(err).toStartWith('entities[0] "com.example.api.<top>.ping(Request": op "add" needs an id in the identity-key grammar (');
    expect(errorsOf((g) => (entity(g, 1).id = "GET /users/{id}"))[0]).toContain("route template is not normalised");
  });

  test("add of an id that already exists", () => {
    expect(errorsOf((g) => (entity(g, 7).id = fn("main()")))).toEqual([
      `entities[7] "${fn("main()")}": op "add" but this key already exists in the base snapshot (${API}Main.kt) — use "modify" or "keep", or pick the new key`,
    ]);
  });

  test("an id whose key kind disagrees with the declared kind", () => {
    expect(errorsOf((g) => (entity(g, 1).kind = "function"))[0]).toContain("the id parses as a route key but \"kind\" says function");
    expect(errorsOf((g) => (entity(g, 2).kind = "route"))[0]).toContain("\"kind\" says route but the base snapshot has this key as a function");
  });

  test("a missing or unusable expected_file (D20)", () => {
    expect(errorsOf((g) => delete entity(g, 0).expected_file)).toEqual([`entities[0] "${fn("ping(Request)")}": "expected_file" is required (D20) — the repo-relative file this entity lives in, or will live in`]);
    expect(errorsOf((g) => (entity(g, 0).expected_file = "/abs/Handlers.kt"))[0]).toContain("must be repo-relative, not absolute");
    expect(errorsOf((g) => (entity(g, 0).expected_file = "api/../Handlers.kt"))[0]).toContain("must not contain `..`");
    expect(errorsOf((g) => (entity(g, 0).expected_file = "./api/Handlers.kt"))[0]).toContain("must be a normalised path");
    expect(errorsOf((g) => (entity(g, 0).expected_file = "api\\Handlers.kt"))[0]).toContain("forward slashes");
    expect(errorsOf((g) => (entity(g, 0).expected_file = "README.md"))[0]).toContain("is not a source file the map extracts");
    expect(errorsOf((g) => (entity(g, 0).expected_file = 7))[0]).toContain('"expected_file" must be a string');
  });

  test("a TS key whose module disagrees with expected_file, and keys in the wrong language", () => {
    expect(errorsOf((g) => (entity(g, 5).expected_file = "web/src/other.tsx"))[0]).toContain('the key\'s module "web/src/status" implies file web/src/status.ts/.tsx/…, but expected_file is "web/src/other.tsx"');
    expect(errorsOf((g) => (entity(g, 0).expected_file = "web/src/ping.ts")).join("\n")).toContain("a JVM function key cannot live in");
    expect(errorsOf((g) => (entity(g, 5).expected_file = API + "Status.kt")).join("\n")).toContain("a TS function key (module#name) cannot live in");
  });

  test("the block must fit the file: same family, and an existing file's own block (review item 7)", () => {
    expect(errorsOf((g) => Object.assign(entity(g, 5), { block: KT }))).toContain(
      'entities[5] "web/src/status#useStatus": block ":api/com.example.api" is a JVM (Gradle project/package) block, but expected_file "web/src/status.tsx" is a TS/JS file',
    );
    expect(errorsOf((g) => Object.assign(entity(g, 0), { block: ":api/com.example.api.v2" }))).toEqual([
      `entities[0] "${fn("ping(Request)")}": expected_file "${HANDLERS}" is in block ":api/com.example.api" in the base snapshot, not ":api/com.example.api.v2" — use that block, or a different file`,
    ]);
  });

  test("a JVM add key's package must be its existing expected_file's package (review item 8)", () => {
    expect(errorsOf((g) => (entity(g, 0).id = "com.example.other.<top>.ping(Request)"))).toContain(
      `entities[0] "com.example.other.<top>.ping(Request)": the key's package does not match "${HANDLERS}", which declares package "com.example.api" — a JVM key starts with its file's package`,
    );
    // a member key's qualifier is package + class chain
    const ok = structuredClone(valid());
    ok.entities[0]!.id = "com.example.api.Renderer.ping(Request)";
    ok.edges = ok.edges.filter((e) => e.to !== fn("ping(Request)"));
    ok.trace = [];
    expect(validateGhostSet(ok, base).ok).toBe(true);
  });

  test("an entity in a block that is neither in base nor declared", () => {
    expect(errorsOf((g) => (entity(g, 0).block = ":api/com.example.nope"))).toEqual([
      `entities[0] "${fn("ping(Request)")}": block ":api/com.example.nope" is neither in the base snapshot nor declared in blocks[] — use an existing block key, or add the block with op "add"`,
    ]);
  });

  test("duplicate ids", () => {
    expect(errorsOf((g) => g.entities.push({ ...g.entities[0]! })).some((e) => e.includes("duplicate entity id"))).toBe(true);
    expect(errorsOf((g) => g.blocks.push({ ...g.blocks[0]! })).some((e) => e.includes("duplicate block id"))).toBe(true);
    expect(errorsOf((g) => g.edges.push({ ...g.edges[0]! })).some((e) => e.includes("duplicate edge"))).toBe(true);
  });

  test("block ids: add must be a new block key, others must exist", () => {
    expect(errorsOf((g) => (g.blocks[1]!.id = "GET /x"))[0]).toContain('parses as a route key, not a block key');
    expect(errorsOf((g) => (g.blocks[1]!.id = "web"))[0]).toContain('op "add" but the block already exists');
    expect(errorsOf((g) => Object.assign(g.blocks[0]!, { id: ":api/com.example.gone" }))[0]).toContain('op "modify" needs a block that exists in the base snapshot');
    expect(errorsOf((g) => delete (g.blocks[0] as Partial<GhostSet["blocks"][number]>).responsibility)[0]).toContain('"responsibility" must be a non-empty string (it is missing)');
  });

  test("edges: unknown endpoints, wrong endpoint kinds, modify, keep/remove of an unseen edge, add of an existing one", () => {
    expect(errorsOf((g) => (g.edges[0]!.to = fn("pingz(Request)")))[0]).toContain(`to "${fn("pingz(Request)")}" is not a block or entity in the ghost set or the base snapshot — declare it in entities[] first`);
    expect(errorsOf((g) => (g.edges[0]!.kind = "call"))[0]).toContain('a call edge goes function → function, but from "GET /ping" is a route');
    expect(errorsOf((g) => (g.edges[1]!.op = "modify"))[0]).toContain('edges have no content to modify — use "add", "remove" or "keep"');
    expect(errorsOf((g) => Object.assign(g.edges[1]!, { to: fn("health(Request)") }))[0]).toContain('op "keep" needs an edge the base snapshot has, and it does not (edge extraction is conservative)');
    expect(errorsOf((g) => (g.edges[1]!.op = "add"))[0]).toContain('op "add" but the base snapshot already has this edge — use "keep"');
    expect(errorsOf((g) => g.edges.push({ from: fn("createUser(Request)"), to: fn("helper(Int)"), kind: "call", op: "keep" })).some((e) => e.includes("ambiguous in the base snapshot, so it can never verify"))).toBe(true);
  });

  test("re-review item 7: member-extension keys pass the package rule; keep must name the entity's own file", () => {
    const ok = structuredClone(valid());
    ok.entities.push({ id: "com.example.api.Renderer.<ext String>.shout()", op: "add", block: KT, kind: "function", expected_file: HANDLERS });
    const r = validateGhostSet(ok, base);
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(errorsOf((g) => g.entities.push({ id: "com.other.<ext String>.shout()", op: "add", block: KT, kind: "function", expected_file: HANDLERS })).join("\n")).toContain("the key's package does not match");
    expect(errorsOf((g) => (entity(g, 3).expected_file = HANDLERS))).toContain(
      `entities[3] "${fn("deleteOrder(Request)")}": op "keep" but the base snapshot has this entity in "${APP}" — set expected_file to "${APP}" (keep means it stays where it is)`,
    );
  });

  test("an add / keep edge touching an entity or block the set removes (review item 8)", () => {
    const errs = errorsOf((g) => g.edges.push({ from: "web/src/Users#UserCard", to: "web/src/api#listThings", kind: "call", op: "add" }));
    expect(errs).toContain('edges[4] "web/src/Users#UserCard→web/src/api#listThings:call": op "add" but "web/src/api#listThings" is removed by this ghost set — an edge cannot survive its endpoint; use "remove" or drop the edge');
    const blockGone = errorsOf((g) => {
      g.blocks.push({ id: "web", op: "remove", responsibility: "gone" });
    });
    expect(blockGone.some((e) => e.includes('"web" is removed by this ghost set'))).toBe(true);
  });

  test("trace: too short, unknown steps, steps through a removed entity", () => {
    expect(errorsOf((g) => (g.trace[0]!.steps = [fn("main()")]))).toEqual(['trace[0] "status poll": a trace needs at least two steps (it is verified edge by edge)']);
    expect(errorsOf((g) => g.trace[0]!.steps.push("web/src/nope#x"))[0]).toContain('steps[4] "web/src/nope#x" is not an entity in the ghost set or the base snapshot');
    expect(errorsOf((g) => g.trace[0]!.steps.push("web/src/api#listThings"))[0]).toContain("is removed by this ghost set, so no trace can pass through it");
    expect(errorsOf((g) => ((g.trace[0] as unknown as Record<string, unknown>).steps = "a,b"))[0]).toContain('"steps" must be an array of entity ids');
  });

  test("a ghost set that proposes nothing", () => {
    expect(validateGhostSet({ blocks: [], entities: [], edges: [], trace: [] }, base)).toEqual({ ok: false, errors: ["the ghost set proposes nothing — declare at least one block, entity or edge"] });
  });

  test(`errors are capped at ${MAX_ERRORS} with a count of the rest`, () => {
    const g = { blocks: [], edges: [], trace: [], entities: Array.from({ length: 60 }, (_, i) => ({ id: fn(`x${i}()`), op: "keep", block: KT, kind: "function", expected_file: HANDLERS })) };
    const r = validateGhostSet(g, base);
    if (r.ok) throw new Error("expected rejection");
    expect(r.errors).toHaveLength(MAX_ERRORS + 1);
    expect(r.errors.at(-1)).toBe("… and 20 more error(s) — fix the ones above and resubmit");
  });
});

describe("comment anchoring", () => {
  test("ghostEntityIds lists block, entity and edge ids, sorted", () => {
    const ids = ghostEntityIds(valid());
    expect(ids).toContain(KT);
    expect(ids).toContain(fn("ping(Request)"));
    expect(ids).toContain(`GET /ping→${fn("ping(Request)")}:route-handler`);
    expect(ids).toEqual([...ids].sort());
    expect(ghostEdgeId({ from: "a", to: "b", kind: "call" })).toBe("a→b:call");
  });

  test("orphanedComments: comments whose key a redraw dropped, in input order, never discarded", () => {
    const v1 = valid();
    const comments = [
      { id: "c1", entity_id: fn("ping(Request)"), text: "rename" },
      { id: "c2", entity_id: "GET /ping", text: "should be POST" },
      { id: "c3", entity_id: `GET /ping→${fn("ping(Request)")}:route-handler`, text: "edge" },
    ];
    expect(orphanedComments(comments, ghostEntityIds(v1))).toEqual([]);
    // v2 renames the route: the route comment and its edge comment are orphaned
    const v2 = structuredClone(v1);
    v2.entities[1]!.id = "POST /ping";
    v2.edges[0]!.from = "POST /ping";
    expect(orphanedComments(comments, ghostEntityIds(v2)).map((c) => c.id)).toEqual(["c2", "c3"]);
  });
});
