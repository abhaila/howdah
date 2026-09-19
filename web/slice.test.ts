/**
 * deriveSlice — the read model behind the approval card, drift view and map progress
 * (system-map 1d). Kept out of web.test.ts only to stay independent of that file; same
 * conventions (bun:test, mkdtempSync roots for anything on disk).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asGhostSet, deriveDetail, deriveSlice, groupGhosts, snapshotIndex } from "./derive";
import { baseIndex, createHowdahServer, UNREADABLE_TTL_MS } from "./server";
import type { RunEvent } from "../log/events";
import { DRIFT_OUTCOMES } from "../map/drift";
import { PROBLEM_OUTCOMES } from "../engine/slice-map";
import { FakeLog, FIND, HANDLER_EDGE, LOAD, ROUTE, SNAPSHOT, drift, failApproval, ghostsV1, ghostsV2, pin, proposeAndPark, proposeRound, started } from "./slice.fixtures";
import { fixtureRepo } from "../map/testkit";
import { extract } from "../map/extract";
import { MapStore, writeManifestTo } from "../map/store";
import { assemble } from "../map/assemble";

const index = () => snapshotIndex(SNAPSHOT);

describe("deriveSlice", () => {
  test("null for a run with no proposal, extraction or drift events", () => {
    const log = new FakeLog();
    started(log, "write-doc");
    log.add({ type: "node-started", node: "doc.draft", visit: 1, attempt_id: "doc.draft#1" });
    expect(deriveSlice(log.events)).toBeNull();
    expect(deriveDetail("r", log.events).slice).toBeNull();
  });

  test("current round: groups block → entities → edges, tiers from the base, adds untiered", () => {
    const log = new FakeLog();
    started(log);
    const id = proposeAndPark(log, ghostsV1());
    const s = deriveSlice(log.events, index())!;
    expect(s.approval).toBe("slice.approve");
    expect(s.proposal).toMatchObject({ proposal_id: id, round: 1, node: "slice.propose", manifest_hash: "m1", tiers_known: true });
    expect(s.proposal!.groups.map((g) => g.block)).toEqual(["api", "web/src"]);
    const api = s.proposal!.groups[0]!;
    expect(api.row).toMatchObject({ id: "api", subject: "block", op: "modify", tier: "syntactic", prose: "serves the user API" });
    expect(api.entities.map((e) => [e.id, e.op, e.tier])).toEqual([
      [ROUTE, "add", null], // an add has no tier until it is built
      [FIND, "modify", "syntactic"],
      ["com.x.Users.legacy()", "remove", "syntactic"],
    ]);
    expect(api.entities[1]).toMatchObject({ expected_file: "api/src/Users.kt", prose: "find" });
    // the edge groups under its source's block and carries the comment key `from→to:kind`
    expect(api.edges).toEqual([
      { id: HANDLER_EDGE, subject: "edge", op: "add", tier: null, edge: { from: ROUTE, to: FIND, kind: "route-handler" } },
    ]);
    expect(s.proposal!.groups[1]!.entities[0]).toMatchObject({ id: LOAD, tier: "resolved" });
    expect(s.proposal!.tier_counts).toEqual({ syntactic: 4, resolved: 1 });
    expect(s.proposal!.untiered).toBe(2);
    expect(s.proposal!.traces).toEqual([{ scenario: "load a user", steps: [LOAD, ROUTE, FIND] }]);
  });

  test("without a readable base snapshot every tier is unknown, and says so", () => {
    const log = new FakeLog();
    started(log);
    proposeAndPark(log, ghostsV1());
    const p = deriveSlice(log.events)!.proposal!;
    expect(p.tiers_known).toBe(false);
    expect(p.tier_counts).toEqual({});
    expect(p.groups.flatMap((g) => [...g.entities, ...g.edges]).every((r) => r.tier === null)).toBe(true);
  });

  test("an edge from an entity the ghost set does not declare groups under that entity's base block, else 'other'", () => {
    const g = asGhostSet({
      blocks: [], entities: [], trace: [],
      edges: [
        { from: FIND, to: "com.x.Db.query()", kind: "call", op: "add" },
        { from: "com.y.Unknown.f()", to: FIND, kind: "call", op: "keep" },
      ],
    })!;
    const groups = groupGhosts(g, index());
    expect(groups.map((x) => [x.block, x.edges.map((e) => e.id)])).toEqual([
      ["api", [`${FIND}→com.x.Db.query():call`]],
      ["", [`com.y.Unknown.f()→${FIND}:call`]], // unknown source reads last
    ]);
  });

  test("a proposal that is not a ghost set is kept raw, never crashes the view", () => {
    const log = new FakeLog();
    started(log, "decide-graph");
    proposeAndPark(log, { ghosts: ["v1"] });
    const p = deriveSlice(log.events)!.proposal!;
    expect(p.ghosts).toBeNull();
    expect(p.raw).toEqual({ ghosts: ["v1"] });
    expect(p.groups).toEqual([]);
    // malformed entries are dropped, the rest kept
    expect(asGhostSet({ blocks: [{ id: 1 }], entities: [{ id: "a", op: "bogus" }], edges: [], trace: "x" })).toEqual({ blocks: [], entities: [], edges: [], trace: [] });
  });

  describe("decision state", () => {
    const parked = () => {
      const log = new FakeLog();
      started(log);
      const id = proposeAndPark(log, ghostsV1());
      return { log, id };
    };

    test("awaiting while parked with nothing decided — the needs-you state", () => {
      const { log } = parked();
      expect(deriveSlice(log.events)!.decision).toEqual({ kind: "awaiting" });
    });

    test("undecided while the round is open but the run is not parked on it", () => {
      const log = new FakeLog();
      started(log);
      log.add({ type: "ghost-proposed", node: "slice.propose", approval: "slice.approve", proposal_id: 2, proposal_hash: "h", manifest_hash: "m1", fingerprint: null, proposal: ghostsV1() });
      expect(deriveSlice(log.events)!.decision).toEqual({ kind: "undecided" });
    });

    test("approved at the decision's time; the first decision is the decision", () => {
      const { log, id } = parked();
      const approved = log.add({ type: "slice-approved", proposal_id: id, proposal_hash: `h${id}`, manifest_hash: "m1" });
      log.add({ type: "slice-feedback-sent", proposal_id: id, proposal_hash: `h${id}`, manifest_hash: "m1", comment_ids: [] }); // never written by the routes; ignored anyway
      expect(deriveSlice(log.events)!.decision).toEqual({ kind: "approved", at: approved.ts });
    });

    test("feedback sent at t, with its comment count", () => {
      const { log, id } = parked();
      const c = pin(log, id, FIND, "use the repository");
      const sent = log.add({ type: "slice-feedback-sent", proposal_id: id, proposal_hash: `h${id}`, manifest_hash: "m1", comment_ids: [c] });
      const s = deriveSlice(log.events)!;
      expect(s.decision).toEqual({ kind: "feedback", at: sent.ts, comments: 1 });
      expect(s.comments[FIND]).toEqual([expect.objectContaining({ id: c, sent: true, round: 1 })]);
    });

    test("stale when the approval node wrote outcome stale for this round (no event: the key says it)", () => {
      const { log, id } = parked();
      log.add({ type: "attention-resolved", node: "slice.approve", visit: 1, reply: "resume", source: "resume" });
      const fin = log.add({
        type: "node-finished", node: "slice.approve", visit: 1, status: "succeeded",
        writes: { "slice.approval": { outcome: "stale", proposal_id: id, proposal_hash: `h${id}`, manifest_hash: "m1", reason: "worktree changed: tracked changes differ" }, "slice.feedback": [] },
      });
      expect(deriveSlice(log.events)!.decision).toEqual({ kind: "stale", at: fin.ts, reason: "worktree changed: tracked changes differ" });
    });

    test("a stale write for ANOTHER round does not make this one stale", () => {
      const { log, id } = parked();
      log.add({ type: "node-finished", node: "slice.approve", visit: 1, status: "succeeded", writes: { "slice.approval": { outcome: "stale", proposal_id: id - 100 } } });
      expect(deriveSlice(log.events)!.decision?.kind).not.toBe("stale");
    });

    test("redesigning once a redesign is requested after the round opened", () => {
      const { log } = parked();
      const r = log.add({ type: "slice-redesign-requested", approval: "slice.approve", message: "split the handler" });
      const s = deriveSlice(log.events)!;
      expect(s.decision).toEqual({ kind: "redesigning", at: r.ts, message: "split the handler" });
      expect(s.redesigns).toEqual([{ message: "split the handler", at: r.ts, after_current: true }]);
    });

    test("parked-other when the approval step parked for another reason — it outranks the round's state", () => {
      const log = new FakeLog();
      started(log);
      const id = proposeRound(log, ghostsV1());
      failApproval(log, 1, "approval executor threw: base unreadable");
      expect(deriveSlice(log.events)!.decision).toEqual({ kind: "parked-other", code: "attempt-failed", reason: "approval executor threw: base unreadable", decided: null });

      // a decided round keeps its decision alongside (so Approve stays closed)
      const approved = log.add({ type: "slice-approved", proposal_id: id, proposal_hash: `h${id}`, manifest_hash: "m1" });
      expect(deriveSlice(log.events)!.decision).toMatchObject({ kind: "parked-other", decided: { kind: "approved", at: approved.ts } });

      // a pre-start park at a visit that never started (max-visits) is the same case
      const mv = new FakeLog();
      started(mv);
      proposeRound(mv, ghostsV1());
      mv.add({ type: "attention-raised", node: "slice.approve", visit: 2, reason: "maxVisits exceeded (2 > 1)", code: "max-visits" });
      expect(deriveSlice(mv.events)!.decision).toMatchObject({ kind: "parked-other", code: "max-visits" });
    });

    test("closed when the run finished undecided", () => {
      const { log } = parked();
      log.add({ type: "run-finished", outcome: "aborted" });
      expect(deriveSlice(log.events)!.decision).toEqual({ kind: "closed", outcome: "aborted" });
    });
  });

  test("rounds: a redraw supersedes the previous round, whose decision stays in history", () => {
    const log = new FakeLog();
    started(log);
    const r1 = proposeAndPark(log, ghostsV1());
    const c = pin(log, r1, "com.x.Users.legacy()", "keep legacy for now");
    const fb = log.add({ type: "slice-feedback-sent", proposal_id: r1, proposal_hash: `h${r1}`, manifest_hash: "m1", comment_ids: [c] });
    const r2 = proposeAndPark(log, ghostsV2(), 2);
    const s = deriveSlice(log.events)!;
    expect(s.proposal).toMatchObject({ proposal_id: r2, round: 2 });
    expect(s.decision).toEqual({ kind: "awaiting" });
    expect(s.rounds).toEqual([
      { proposal_id: r1, round: 1, at: expect.any(String), outcome: "feedback", decided_at: fb.ts },
      { proposal_id: r2, round: 2, at: expect.any(String), outcome: null, decided_at: null },
    ]);
  });

  test("comments: kept keys carry across a redraw, dropped keys are orphaned (the map/ghosts rule)", () => {
    const log = new FakeLog();
    started(log);
    const r1 = proposeAndPark(log, ghostsV1());
    const onFind = pin(log, r1, FIND, "use the repository");
    const onEdge = pin(log, r1, HANDLER_EDGE, "handler should validate");
    const onLegacy = pin(log, r1, "com.x.Users.legacy()", "keep legacy for now");
    log.add({ type: "slice-feedback-sent", proposal_id: r1, proposal_hash: `h${r1}`, manifest_hash: "m1", comment_ids: [onFind, onEdge, onLegacy] });
    const r2 = proposeAndPark(log, ghostsV2(), 2);
    const now = pin(log, r2, ROUTE, "pagination?");
    const s = deriveSlice(log.events)!;
    expect(s.comments[FIND]!.map((c) => [c.id, c.round, c.sent])).toEqual([[onFind, 1, true]]);
    expect(s.comments[HANDLER_EDGE]!.map((c) => c.id)).toEqual([onEdge]); // edges pin by `from→to:kind`
    expect(s.comments[ROUTE]!.map((c) => [c.id, c.round, c.sent])).toEqual([[now, 2, false]]);
    expect(s.orphaned.map((c) => [c.id, c.entity_id, c.round])).toEqual([[onLegacy, "com.x.Users.legacy()", 1]]);
    expect(s.comments["com.x.Users.legacy()"]).toBeUndefined();
  });

  test("map progress: the latest extraction still running; gone once extracted; snapshots listed", () => {
    const log = new FakeLog();
    started(log);
    log.add({ type: "node-started", node: "map.extract", visit: 1, attempt_id: "map.extract#1" });
    log.add({ type: "map-progress", node: "map.extract", visit: 1, done: 3, total: 10, skipped: 0 });
    log.add({ type: "map-progress", node: "map.extract", visit: 1, done: 7, total: 10, skipped: 1 });
    expect(deriveSlice(log.events)!.mapping).toEqual({ node: "map.extract", visit: 1, done: 7, total: 10, skipped: 1 });
    log.add({
      type: "map-extracted", node: "map.extract", visit: 1, manifest_hash: "m1", commit: "c0ffee1234", tiers_run: ["syntactic"], dirty: true, store: "/tmp/store",
      fingerprint: { head: "c0ffee1234", tracked: "t", untracked: "u" }, unparsed: 2, skipped: 1, not_checked: 0, files: 10,
    });
    const s = deriveSlice(log.events)!;
    expect(s.mapping).toBeNull();
    expect(s.maps).toEqual([expect.objectContaining({ node: "map.extract", visit: 1, manifest_hash: "m1", commit: "c0ffee1234", tiers_run: ["syntactic"], files: 10, unparsed: 2, dirty: true, stamp: "c0ffee1234 + uncommitted changes" })]);
  });

  test("map progress of a finished run is never shown as still running", () => {
    const log = new FakeLog();
    started(log);
    log.add({ type: "map-progress", node: "map.extract", visit: 1, done: 3, total: 10, skipped: 0 });
    log.add({ type: "run-finished", outcome: "failed" });
    expect(deriveSlice(log.events)!.mapping).toBeNull();
  });

  test("drift: grouped by outcome worst first, counts cover truncated items, stamped with its commit", () => {
    const log = new FakeLog();
    started(log);
    log.add(drift(
      [
        { key: "a", outcome: "verified", evidence: "api/src/A.kt:3" },
        { key: "b", outcome: "not-checked", reason: "partial coverage: helper-built route" },
        { key: "c", outcome: "missing", reason: "absent after; api/src/Routes.kt fully searched", evidence: "api/src/Routes.kt:1" },
        { key: "d", outcome: "still-present", evidence: "api/src/Users.kt:40" },
      ],
      { truncated: 5, extra: { verified: 5 } },
    ));
    const [d] = deriveSlice(log.events)!.drifts;
    expect(d!.commit).toBe("abc1234def5678");
    expect(d!.groups.map((g) => [g.outcome, g.count, g.items.length, g.problem])).toEqual([
      ["missing", 1, 1, true],
      ["still-present", 1, 1, true],
      ["not-checked", 1, 1, false],
      ["verified", 6, 1, false], // the counts include the 5 items past the cap
    ]);
    expect(d!.stamp).toBe("abc1234def56");
    expect(d!.truncated).toBe(5);
    expect(d!.outdated).toBe(false);
    expect(d!.head_now).toBeNull();
  });

  test("drift problems are exactly engine/slice-map PROBLEM_OUTCOMES; a dirty or legacy report keeps the engine's stamp", () => {
    const log = new FakeLog();
    started(log);
    log.add(drift(DRIFT_OUTCOMES.map((outcome, i) => ({ key: `k${i}`, outcome })), { dirty: true }));
    const [d] = deriveSlice(log.events)!.drifts;
    expect(d!.groups.filter((g) => g.problem).map((g) => g.outcome).sort()).toEqual([...PROBLEM_OUTCOMES].sort());
    expect(d).toMatchObject({ stamp: "abc1234def56 + uncommitted changes", dirty: true, extractor_mismatch: null, base_reextracted: false });

    const legacy = new FakeLog();
    started(legacy);
    const { stamp: _s, dirty: _d, ...old } = drift([{ key: "a", outcome: "verified" }]) as Extract<RunEvent, { type: "drift-detected" }>;
    legacy.add(old as RunEvent);
    expect(deriveSlice(legacy.events)!.drifts[0]).toMatchObject({ stamp: "abc1234def56", dirty: false });
  });

  test("drift is outdated once the reconciler sees HEAD move past the commit it checked", () => {
    const log = new FakeLog();
    started(log);
    const reconciled = (head: string) =>
      log.add({ type: "reconciled", node: "implementation.local_review", git: { repo: true, branch: "howdah/r", head, uncommitted: 0, unpushed: 0 }, disagreements: [] });
    reconciled("0000000");
    log.add(drift([{ key: "a", outcome: "verified" }], { commit: "abc1234def5678" }));
    reconciled("abc1234def5678");
    expect(deriveSlice(log.events)!.drifts[0]).toMatchObject({ head_now: "abc1234def5678", outdated: false });
    reconciled("fff9999");
    expect(deriveSlice(log.events)!.drifts[0]).toMatchObject({ head_now: "fff9999", outdated: true });
  });
});

describe("GET /api/runs/:id exposes the slice read model", () => {
  const base = mkdtempSync(join(tmpdir(), "howdah-web-slice-"));
  // the map store must live under $HOWDAH_HOME (the server refuses a store elsewhere)
  const prevHome = process.env.HOWDAH_HOME;
  beforeAll(() => void (process.env.HOWDAH_HOME = base));
  afterAll(() => {
    if (prevHome === undefined) delete process.env.HOWDAH_HOME;
    else process.env.HOWDAH_HOME = prevHome;
  });
  const runsDir = join(base, "runs");
  mkdirSync(join(runsDir, "s1"), { recursive: true });
  const server = createHowdahServer({ runsDir, attentionDir: join(base, "attention"), port: 0 });
  afterAll(() => server.stop(true));

  test("proposal, decision and comments; an unreadable base snapshot means tiers unknown, not a 500", async () => {
    const log = new FakeLog();
    started(log);
    const id = proposeAndPark(log, ghostsV1());
    pin(log, id, FIND, "use the repository");
    writeFileSync(join(runsDir, "s1", "run.jsonl"), log.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const res = await fetch(`http://localhost:${server.port}/api/runs/s1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReturnType<typeof deriveDetail>;
    expect(body.summary.status).toBe("needs-input");
    expect(body.slice?.proposal).toMatchObject({ proposal_id: id, round: 1, tiers_known: false });
    expect(body.slice?.decision).toEqual({ kind: "awaiting" });
    expect(body.slice?.comments[FIND]).toHaveLength(1);
  });

  /** A run whose round was drawn on a REAL extracted snapshot recorded in runs/<id>/maps/. */
  async function seedMappedRun(id: string, storeDir: string) {
    const repo = fixtureRepo();
    const res = await extract({ repoDir: repo.dir, commit: repo.commit, storeDir, workers: 0 });
    const { hash } = writeManifestTo(res.manifest, join(runsDir, id, "maps"));
    const map = assemble(res.manifest, new MapStore(storeDir));
    const entity = map.entities.find((e) => !e.ambiguous)!;
    const block = map.blocks.find((b) => b.key === entity.block)!;
    const log = new FakeLog();
    started(log);
    log.add({
      type: "map-extracted", node: "map.extract", visit: 1, manifest_hash: hash, commit: repo.commit, dirty: false, store: storeDir,
      fingerprint: { head: repo.commit, tracked: "t", untracked: "u" }, tiers_run: ["syntactic"], unparsed: 0, skipped: 0, not_checked: 0, files: 1,
    });
    const ghosts = {
      blocks: [{ id: block.key, op: "modify", responsibility: "r" }],
      entities: [
        { id: entity.key, op: "keep", block: block.key, kind: entity.kind, expected_file: entity.file },
        { id: "GET /brand/new", op: "add", block: block.key, kind: "route", expected_file: entity.file },
      ],
      edges: [], trace: [],
    };
    log.add({ type: "ghost-proposed", node: "slice.propose", approval: "slice.approve", proposal_id: 3, proposal_hash: "h", manifest_hash: hash, fingerprint: null, proposal: ghosts });
    mkdirSync(join(runsDir, id), { recursive: true });
    writeFileSync(join(runsDir, id, "run.jsonl"), log.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return { entity, block, events: log.events, manifestPath: join(runsDir, id, "maps", `${hash}.json`) };
  }

  test("an unreadable snapshot is not retried per poll, but recovers once its TTL passes", async () => {
    const { events, manifestPath, entity } = await seedMappedRun("flaky", join(base, "stores", "flaky"));
    renameSync(manifestPath, `${manifestPath}.away`); // a transient failure
    let t = 1_000_000;
    const now = () => t;
    const runDir = join(runsDir, "flaky");
    expect(baseIndex(runDir, events, now)).toBeNull();
    renameSync(`${manifestPath}.away`, manifestPath); // readable again
    t += UNREADABLE_TTL_MS - 1;
    expect(baseIndex(runDir, events, now)).toBeNull(); // still remembered as unreadable
    t += 2;
    expect(baseIndex(runDir, events, now)?.tier.get(entity.key)).toBe(entity.tier); // TTL passed: retried
  }, 60_000);

  test("tiers come from the round's real base snapshot, read from the store its map-extracted names", async () => {
    const { entity, block } = await seedMappedRun("mapped", join(base, "stores", "custom")); // not the default store
    const body = (await (await fetch(`http://localhost:${server.port}/api/runs/mapped`)).json()) as ReturnType<typeof deriveDetail>;
    const p = body.slice!.proposal!;
    expect(p.tiers_known).toBe(true);
    const rows = p.groups.flatMap((g) => [...(g.row ? [g.row] : []), ...g.entities]);
    expect(rows.find((r) => r.id === block.key)!.tier).toBe(block.tier);
    expect(rows.find((r) => r.id === entity.key)!.tier).toBe(entity.tier);
    expect(rows.find((r) => r.id === "GET /brand/new")!.tier).toBeNull();
  }, 60_000);

  test("a store outside $HOWDAH_HOME named by the log is never read", async () => {
    await seedMappedRun("elsewhere", join(mkdtempSync(join(tmpdir(), "howdah-foreign-")), "store"));
    const body = (await (await fetch(`http://localhost:${server.port}/api/runs/elsewhere`)).json()) as ReturnType<typeof deriveDetail>;
    expect(body.slice!.proposal!.tiers_known).toBe(false);
  }, 60_000);
});
