/**
 * Map built-ins (system-map 1c): map:extract / map:reextract / map:drift run in-process behind
 * the command executor, over a real git fixture repo and a real extraction (workers: 0).
 * The executor is called directly with ExecArgs — the engine-level wiring is covered by
 * graphs/implement-slice.test.ts and the E2E.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandExecutor } from "./worktree";
import { parseMapRun, isMapBuiltin, uncommittedReason } from "./map";
import { gitIgnored, ignoredExpectedFiles, type SliceDrift, type MapAfter } from "../slice-map";
import type { ExecArgs, AttemptResult } from "../run";
import type { NodeDef } from "../../core/graph";
import { EventLog } from "../../log/write";
import type { LoggedEvent } from "../../log/events";
import type { BaseSnapshot } from "../slice-decision";
import { fingerprint } from "../reconcile";
import { readManifest, writeManifestTo } from "../../map/store";
import {
  sliceRepo, applyEdits, commitAll, implementedV2, GHOSTS_V2, API_TS, APP_FN, APP_KT, DELETE_ROUTE, DELETE_USER_TS, SLICE_GOAL, SLICE_WORK, GET_ROUTE,
} from "../../graphs/slice-fixture";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

// the rig's store sits under its own HOWDAH_HOME: stores named by the log are only honoured there
const ORIGINAL_HOME = process.env.HOWDAH_HOME;
afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOWDAH_HOME;
  else process.env.HOWDAH_HOME = ORIGINAL_HOME;
});

const EXTRACT: NodeDef<any> = {
  kind: "command",
  run: "map:extract",
  reads: ["goal", "work"],
  writes: { "map.base": { scope: "sticky" }, "map.neighbourhood": { scope: "sticky" }, "slice.drift": { scope: "per-visit" }, review_findings: { scope: "cleared" } },
};
const REEXTRACT: NodeDef<any> = { kind: "command", run: "map:reextract", reads: ["map.base"], writes: { "map.after": { scope: "per-visit" } } };
const drift = (run = "map:drift"): NodeDef<any> => ({ kind: "command", run, reads: ["slice.ghosts", "map.base", "map.after"], writes: { "slice.drift": { scope: "per-visit" } } });

interface Rig {
  repo: string;
  runDir: string;
  log: EventLog;
  events: () => LoggedEvent[];
  exec: (nodeId: string, def: NodeDef<any>, reads: Record<string, unknown>, opts?: Parameters<typeof commandExecutor>[0]) => Promise<AttemptResult>;
}

function rig(repo = sliceRepo().dir): Rig {
  const home = tmp("howdah-map-run-");
  process.env.HOWDAH_HOME = home;
  const runDir = join(home, "runs", "run-1");
  mkdirSync(runDir, { recursive: true });
  const storeDir = join(home, "store");
  const log = new EventLog(join(runDir, "run.jsonl"));
  let visit = 0;
  return {
    repo,
    runDir,
    log,
    events: () => log.read(),
    exec: (nodeId, def, reads, opts) =>
      commandExecutor({ ...opts, map: { storeDir, workers: 0, ...opts?.map } })({
        nodeId, def, visit: ++visit, attemptId: `${nodeId}#${visit}`, cwd: repo, runId: "run-1", log, reads,
        effects: { claim: () => false, done: () => {} },
      } satisfies ExecArgs),
  };
}

const TICKET = { goal: SLICE_GOAL, work: SLICE_WORK };
const of = <T extends LoggedEvent["type"]>(events: LoggedEvent[], type: T) => events.filter((e): e is Extract<LoggedEvent, { type: T }> => e.type === type);

describe("map built-ins: dispatch", () => {
  test("only the three map built-ins dispatch in-process; arguments are parsed strictly", () => {
    expect(isMapBuiltin("map:extract")).toBe(true);
    expect(isMapBuiltin("map:drift --since delivery.publish")).toBe(true);
    expect(isMapBuiltin("probe:pr")).toBe(false);
    expect(isMapBuiltin("echo map:extract")).toBe(false);
    expect(parseMapRun("map:drift --since delivery.publish")).toEqual({ name: "map:drift", since: "delivery.publish" });
    expect(() => parseMapRun("map:extract --since x")).toThrow("unknown argument");
    expect(() => parseMapRun("map:drift --since")).toThrow("unknown argument");
  });
});

describe("map:extract", () => {
  test("writes the base snapshot, the neighbourhood and the entry-path seeds; logs map-extracted; stores the manifest", async () => {
    const r = rig();
    const result = await r.exec("map.extract", EXTRACT, TICKET);
    expect(result.status).toBe("succeeded");
    const base = result.writes["map.base"] as BaseSnapshot;
    expect(base.fingerprint).toEqual((await fingerprint(r.repo))!);
    expect(base.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(r.runDir, "maps", `${base.manifest_hash}.json`))).toBe(true);
    expect(result.writes["slice.drift"]).toEqual([]);
    expect(result.writes["review_findings"]).toBeNull();

    const text = result.writes["map.neighbourhood"] as string;
    expect(text).toContain(`\`${GET_ROUTE}\``); // named by the ticket's route + file
    expect(text).toContain("Seeds:");
    expect(text.length).toBeLessThanOrEqual(16_000);

    const [extracted, ...more] = of(r.events(), "map-extracted");
    expect(more).toEqual([]);
    expect(extracted).toMatchObject({ node: "map.extract", manifest_hash: base.manifest_hash, commit: base.commit, fingerprint: base.fingerprint, tiers_run: ["syntactic"], skipped: 0, not_checked: 0, files: 3 });
  });

  test("writes exactly the declared keys, and refuses a declared key it cannot produce", async () => {
    const r = rig();
    const lean: NodeDef<any> = { kind: "command", run: "map:extract", reads: ["goal", "work"], writes: { "map.base": { scope: "sticky" } } };
    const result = await r.exec("map.extract", lean, TICKET);
    expect(Object.keys(result.writes)).toEqual(["map.base"]);
    const greedy: NodeDef<any> = { ...lean, writes: { "map.base": { scope: "sticky" }, "map.colour": { scope: "sticky" } } } as NodeDef<any>;
    await expect(r.exec("map.extract", greedy, TICKET)).rejects.toThrow("cannot produce map.colour");
  });

  test("map-progress is throttled: a frozen clock logs the first and the final event only", async () => {
    const r = rig();
    await r.exec("map.extract", EXTRACT, TICKET, { map: { now: () => 0, progressIntervalMs: 1000 } });
    const progress = of(r.events(), "map-progress").map((e) => `${e.done}/${e.total}`);
    expect(progress).toEqual(["0/3", "3/3"]);
  });

  test("map-progress: a clock past the interval logs every step, and the final one exactly once", async () => {
    const r = rig();
    let t = 0;
    await r.exec("map.extract", EXTRACT, TICKET, { map: { now: () => (t += 5000), progressIntervalMs: 1000 } });
    const progress = of(r.events(), "map-progress").map((e) => `${e.done}/${e.total}`);
    expect(progress).toEqual(["0/3", "1/3", "2/3", "3/3"]);
  });

  test("an unreadable untracked file (FingerprintError) fails the attempt with the reason — never a guessed base", async () => {
    const r = rig();
    const secret = join(r.repo, "web", "src", "secret.ts");
    writeFileSync(secret, "export const x = 1;\n");
    chmodSync(secret, 0o000);
    try {
      const result = await r.exec("map.extract", EXTRACT, TICKET);
      expect(result).toMatchObject({ status: "failed", writes: {} });
      expect(result.reason).toContain("cannot fingerprint the worktree");
      expect(of(r.events(), "map-extracted")).toEqual([]);
    } finally {
      chmodSync(secret, 0o644);
    }
  });

  test("a folder that is not a git work tree fails the attempt", async () => {
    const r = rig(tmp("howdah-not-git-"));
    const result = await r.exec("map.extract", EXTRACT, TICKET);
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("is not one");
  });

  test("a worktree that moves during extraction fails the attempt (the snapshot would match neither state)", async () => {
    const r = rig();
    let moved = false;
    const now = () => {
      if (!moved) writeFileSync(join(r.repo, "web", "src", "late.ts"), "export const late = 1;\n");
      moved = true;
      return 0;
    };
    const result = await r.exec("map.extract", EXTRACT, TICKET, { map: { now } });
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("changed during extraction");
    expect(result.reason).toContain("untracked files differ");
  });

  test("no entry point: a bounded block-level overview plus a note, never a dead end; a redesign message seeds the next extract", async () => {
    const r = rig();
    const vague = { goal: "make account management nicer", work: "users have asked for it" };
    const first = await r.exec("map.extract", EXTRACT, vague);
    expect(first.status).toBe("succeeded");
    const overview = first.writes["map.neighbourhood"] as string;
    expect(overview).toContain("Map overview");
    expect(overview).toContain("No entry point");
    expect(overview).toContain("redesign <run> <entry point>");
    expect(overview).toContain("## block `:api/com.example.api`");
    expect(overview).toContain("## block `web`");
    // the operator reads the thread
    expect(of(r.events(), "chunk").map((c) => c.content).join("")).toContain("No entry point");

    // the operator names one through `redesign` (request + jump, one append): seed text for the next extract
    r.log.appendAllIf(() => [
      { type: "slice-redesign-requested", approval: "slice.approve", message: "start from `web/src/api.ts`" },
      { type: "operator-jump", to: "map.extract", reset_budgets: true },
    ]);
    const second = await r.exec("map.extract", EXTRACT, vague);
    const seeded = second.writes["map.neighbourhood"] as string;
    expect(seeded).toContain("Seeds:");
    expect(seeded).toContain("`web/src/api#getUser`");
    expect(seeded).not.toContain("No entry point");

    // the pick is durable: after the node succeeded (the message consumed) and a later
    // stale → re-extract, the entry point is still seeded
    r.log.append({ type: "node-finished", node: "map.extract", visit: 2, status: "succeeded", writes: { "slice.feedback": [] } });
    r.log.append({ type: "edge-taken", from: "slice.approve", to: "map.extract", label: "slice.approval == 'stale'" });
    const third = await r.exec("map.extract", EXTRACT, vague);
    expect(third.writes["map.neighbourhood"] as string).toContain("`web/src/api#getUser`");

    // a redesign that jumped somewhere else is not this node's seed text
    const other = rig();
    other.log.appendAllIf(() => [
      { type: "slice-redesign-requested", approval: "other.approve", message: "start from `web/src/api.ts`" },
      { type: "operator-jump", to: "other.extract", reset_budgets: true },
    ]);
    expect((await other.exec("map.extract", EXTRACT, vague)).writes["map.neighbourhood"] as string).toContain("No entry point");
  });
});

describe("map:reextract + map:drift", () => {
  async function built(r: Rig, edits: Array<{ path: string; content: string }>, opts: { commit?: boolean } = {}) {
    const extracted = await r.exec("map.extract", EXTRACT, TICKET);
    const base = extracted.writes["map.base"] as BaseSnapshot;
    applyEdits(r.repo, edits);
    const commit = opts.commit === false ? base.commit ?? "" : commitAll(r.repo, "implement");
    const re = await r.exec("map.reextract", REEXTRACT, { "map.base": base });
    return { base, after: re.writes["map.after"] as MapAfter, commit };
  }

  test("reextract writes map.after for the new snapshot and logs map-extracted for it", async () => {
    const r = rig();
    const { base, after, commit } = await built(r, implementedV2(r.repo));
    expect(after.commit).toBe(commit);
    expect(after.manifest_hash).not.toBe(base.manifest_hash);
    expect(existsSync(join(r.runDir, "maps", `${after.manifest_hash}.json`))).toBe(true);
    expect(of(r.events(), "map-extracted").map((e) => e.node)).toEqual(["map.extract", "map.reextract"]);
  });

  test("drift over an implementation that builds the design: every ghost verified, stamped with the after commit", async () => {
    const r = rig();
    const { base, after, commit } = await built(r, implementedV2(r.repo));
    const result = await r.exec("map.drift", drift(), { "slice.ghosts": GHOSTS_V2, "map.base": base, "map.after": after });
    const d = result.writes["slice.drift"] as SliceDrift;
    expect(d.commit).toBe(commit);
    expect(d.dirty).toBe(false);
    expect(d.stamp).toBe(commit.slice(0, 12));
    expect(d.base_commit).toBe(base.commit ?? null);
    expect(d.problems).toEqual([]);
    expect(d.new_problems).toEqual([]);
    for (const g of GHOSTS_V2.entities) expect(d.items.find((i) => i.key === g.id && i.op !== null)?.outcome).toBe("verified");

    const [event] = of(r.events(), "drift-detected");
    expect(event).toMatchObject({ node: "map.drift", commit, base_commit: base.commit, counts: d.counts, items: d.items, truncated: 0 });
  });

  test("drift that breaks the design lists its problems; --since counts only those the code did not have when that node started", async () => {
    const r = rig();
    // build v2 without the web half: the web ghosts are provably missing from web/src/api.ts
    const [app] = implementedV2(r.repo);
    const { base, after } = await built(r, [app!]);
    const reads = { "slice.ghosts": GHOSTS_V2, "map.base": base, "map.after": after };
    const first = (await r.exec("map.drift", drift(), reads)).writes["slice.drift"] as SliceDrift;
    expect(first.problems).toContain(`missing ${DELETE_USER_TS}`);
    expect(first.new_problems).toEqual(first.problems); // no --since: every problem is new

    // the published code already had these problems → a later repair is not blamed for them
    r.log.append({ type: "node-started", node: "delivery.publish", visit: 1, attempt_id: "delivery.publish#1" });
    const again = (await r.exec("delivery.drift", drift("map:drift --since delivery.publish"), reads)).writes["slice.drift"] as SliceDrift;
    expect(again.problems).toEqual(first.problems);
    expect(again.new_problems).toEqual([]);
  });

  test("a drift node whose --since node never started treats every problem as new", async () => {
    const r = rig();
    const [app] = implementedV2(r.repo);
    const { base, after } = await built(r, [app!]);
    const d = (await r.exec("delivery.drift", drift("map:drift --since delivery.publish"), { "slice.ghosts": GHOSTS_V2, "map.base": base, "map.after": after }))
      .writes["slice.drift"] as SliceDrift;
    expect(d.new_problems.length).toBeGreaterThan(0);
    expect(d.new_problems).toEqual(d.problems);
  });

  /** the recorded base, as if an older extractor had written it (same objects, other version) */
  function olderExtractorBase(r: Rig, base: BaseSnapshot): BaseSnapshot & { manifest_hash: string } {
    const path = join(r.runDir, "maps", `${base.manifest_hash}.json`);
    const manifest = { ...readManifest(path), extractorVersion: "map-1b.older" };
    const hash = writeManifestTo(manifest, join(r.runDir, "maps")).hash;
    // as the older extraction would have logged it: same store, same objects
    const { seq: _seq, ts: _ts, ...extracted } = of(r.events(), "map-extracted").find((e) => e.manifest_hash === base.manifest_hash)!;
    r.log.append({ ...extracted, manifest_hash: hash });
    return { ...base, manifest_hash: hash };
  }

  test("a base from another extractor version is re-extracted at its commit, and drift is computed against that", async () => {
    const r = rig();
    const { base, after } = await built(r, implementedV2(r.repo));
    const old = olderExtractorBase(r, base);
    const result = await r.exec("map.drift", drift(), { "slice.ghosts": GHOSTS_V2, "map.base": old, "map.after": after });
    const d = result.writes["slice.drift"] as SliceDrift;
    expect(d.base_reextracted).toBe(true);
    expect(d.base_manifest_hash).not.toBe(old.manifest_hash);
    expect(existsSync(join(r.runDir, "maps", `${d.base_manifest_hash}.json`))).toBe(true);
    for (const g of GHOSTS_V2.entities) expect(d.items.find((i) => i.key === g.id && i.op !== null)?.outcome).toBe("verified");
    expect(of(r.events(), "drift-detected")[0]).toMatchObject({ base_reextracted: true, base_manifest_hash: d.base_manifest_hash });
    expect(of(r.events(), "chunk").map((c) => c.content).join("")).toContain("re-extracted the base");
  });

  /** every ghost item (not `unexpected`) of a report */
  const ghostItems = (d: SliceDrift) => d.items.filter((i) => i.op !== null || i.kind === "trace");

  test("a base drawn on uncommitted changes cannot be reproduced from its commit: every ghost not-checked, the mismatch recorded", async () => {
    const r = rig();
    writeFileSync(join(r.repo, "web", "src", "draft.ts"), "export function draft() {\n  return 0;\n}\n"); // untracked when the base is drawn
    const { base, after } = await built(r, implementedV2(r.repo));
    const old = olderExtractorBase(r, base);
    const d = (await r.exec("map.drift", drift(), { "slice.ghosts": GHOSTS_V2, "map.base": old, "map.after": after })).writes["slice.drift"] as SliceDrift;
    expect(d.base_reextracted).toBeUndefined();
    expect(d.base_manifest_hash).toBe(old.manifest_hash);
    expect(d.extractor_mismatch).toEqual({ base: "map-1b.older", after: expect.any(String) });
    expect(ghostItems(d).length).toBeGreaterThan(0);
    for (const i of ghostItems(d)) expect(i).toMatchObject({ outcome: "not-checked", reason: expect.stringContaining("different extractor versions") });
    expect(d.counts.verified).toBe(0);
    expect(d.problems).toEqual([]);
    const [event] = of(r.events(), "drift-detected");
    expect(event?.base_reextracted).toBeUndefined();
    expect(event?.extractor_mismatch).toEqual(d.extractor_mismatch);
    expect(of(r.events(), "chunk").map((c) => c.content).join("")).toContain("drawn on uncommitted changes");
  });

  test("re-extraction fails closed when a recorded object is unreadable (never a match by default)", async () => {
    const r = rig();
    const { base, after } = await built(r, implementedV2(r.repo));
    const old = olderExtractorBase(r, base);
    // point one file of the recorded base at an object that does not exist
    const path = join(r.runDir, "maps", `${old.manifest_hash}.json`);
    const manifest = readManifest(path);
    const first = Object.keys(manifest.files).find((f) => f.endsWith("Main.kt")); // no ghost lives there
    const broken = writeManifestTo({ ...manifest, files: { ...manifest.files, [first!]: "0".repeat(64) } }, join(r.runDir, "maps")).hash;
    const { seq: _seq, ts: _ts, ...extracted } = of(r.events(), "map-extracted").find((e) => e.manifest_hash === old.manifest_hash)!;
    r.log.append({ ...extracted, manifest_hash: broken });
    // a ghost set that does not depend on Main.kt (whose object is the broken one)
    const webOnly = { blocks: [], edges: [], trace: [], entities: GHOSTS_V2.entities.filter((e) => e.id === DELETE_USER_TS) };
    const d = (await r.exec("map.drift", drift(), { "slice.ghosts": webOnly, "map.base": { ...old, manifest_hash: broken }, "map.after": after })).writes["slice.drift"] as SliceDrift;
    expect(d.base_reextracted).toBeUndefined();
    expect(d.extractor_mismatch).toBeDefined();
    expect(of(r.events(), "chunk").map((c) => c.content).join("")).toContain(`the object for ${first} is missing or unreadable`);
  });

  test("an after snapshot with uncommitted changes verifies nothing: verified → not-checked, stamped '+ uncommitted changes'", async () => {
    const r = rig();
    const { base, after } = await built(r, implementedV2(r.repo), { commit: false });
    expect(after.dirty).toBe(true);
    expect(of(r.events(), "map-extracted").map((e) => e.dirty)).toEqual([false, true]);
    const d = (await r.exec("map.drift", drift(), { "slice.ghosts": GHOSTS_V2, "map.base": base, "map.after": after })).writes["slice.drift"] as SliceDrift;
    expect(d.dirty).toBe(true);
    expect(d.stamp).toBe(`${base.commit!.slice(0, 12)} + uncommitted changes`);
    expect(d.counts.verified).toBe(0);
    expect(after.uncommitted).toEqual([APP_KT, API_TS]);
    const reason = uncommittedReason([APP_KT, API_TS], 2);
    expect(reason).toContain(`(${APP_KT}, ${API_TS})`);
    for (const g of GHOSTS_V2.entities) expect(d.items.find((i) => i.key === g.id && i.op !== null)).toMatchObject({ outcome: "not-checked", reason });
    expect(of(r.events(), "drift-detected")[0]).toMatchObject({ dirty: true, stamp: d.stamp, counts: d.counts });
  });

  test("a stray non-source file does not make the snapshot dirty: verified stays verified", async () => {
    const r = rig();
    const { base, after } = await built(r, implementedV2(r.repo));
    writeFileSync(join(r.repo, "scratch.log"), "debug output\n"); // untracked, not something the map reads
    const again = (await r.exec("map.reextract", REEXTRACT, { "map.base": base })).writes["map.after"] as MapAfter;
    expect(again).toMatchObject({ dirty: false, uncommitted: [], uncommitted_count: 0, manifest_hash: after.manifest_hash });
    const d = (await r.exec("map.drift", drift(), { "slice.ghosts": GHOSTS_V2, "map.base": base, "map.after": again })).writes["slice.drift"] as SliceDrift;
    expect(d.dirty).toBe(false);
    expect(d.counts.verified).toBeGreaterThan(0);
  });

  test("an uncommitted build manifest makes the snapshot dirty (it decides block keys): settings.gradle.kts, package.json", async () => {
    for (const [file, edit] of [
      ["settings.gradle.kts", (t: string) => t + 'include(":newmod")\n'],
      ["web/package.json", (t: string) => t.replace('"private": true', '"private": false')],
    ] as const) {
      const r = rig();
      const { base } = await built(r, implementedV2(r.repo)); // sources committed
      writeFileSync(join(r.repo, file), edit(readFileSync(join(r.repo, file), "utf8")));
      const after = (await r.exec("map.reextract", REEXTRACT, { "map.base": base })).writes["map.after"] as MapAfter;
      expect(after).toMatchObject({ dirty: true, uncommitted: [file], uncommitted_count: 1 });
      const d = (await r.exec("map.drift", drift(), { "slice.ghosts": GHOSTS_V2, "map.base": base, "map.after": after })).writes["slice.drift"] as SliceDrift;
      expect(d.counts.verified).toBe(0);
      expect(d.items.find((i) => i.outcome === "not-checked")?.reason).toContain(`(${file})`);
    }
  });

  test("a modify ghost whose code did not change is a problem (unchanged)", async () => {
    const r = rig();
    const [, api] = implementedV2(r.repo); // the web half only: app() is never modified
    const { base, after } = await built(r, [api!]);
    const d = (await r.exec("map.drift", drift(), { "slice.ghosts": GHOSTS_V2, "map.base": base, "map.after": after })).writes["slice.drift"] as SliceDrift;
    expect(d.problems).toContain(`unchanged ${APP_FN}`);
  });

  test("drift refuses ghosts that no longer validate against their base (an engine bug, never a silent report)", async () => {
    const r = rig();
    const { base, after } = await built(r, implementedV2(r.repo));
    const bogus = { ...GHOSTS_V2, entities: [{ id: "GET /nope", op: "keep", block: "web", kind: "route", expected_file: API_TS }] };
    await expect(r.exec("map.drift", drift(), { "slice.ghosts": bogus, "map.base": base, "map.after": after })).rejects.toThrow("no longer validate");
  });
});

describe("git-ignored expected files", () => {
  test("drift: a ghost built into a git-ignored file is not-checked (never extracted), never missing", async () => {
    const { dir } = sliceRepo();
    writeFileSync(join(dir, ".gitignore"), "web/src/local/\n");
    commitAll(dir, "ignore local");
    const r = rig(dir);
    const extracted = await r.exec("map.extract", EXTRACT, TICKET);
    const base = extracted.writes["map.base"] as BaseSnapshot;
    mkdirSync(join(dir, "web", "src", "local"), { recursive: true });
    writeFileSync(join(dir, "web", "src", "local", "x.ts"), "export function helper() {\n  return 1;\n}\n");
    const after = (await r.exec("map.reextract", REEXTRACT, { "map.base": base })).writes["map.after"] as MapAfter;
    const ghosts = { blocks: [], edges: [], trace: [], entities: [{ id: "web/src/local/x#helper", op: "add", block: "web", kind: "function", expected_file: "web/src/local/x.ts" }] };
    const d = (await r.exec("map.drift", drift(), { "slice.ghosts": ghosts, "map.base": base, "map.after": after })).writes["slice.drift"] as SliceDrift;
    const item = d.items.find((i) => i.key === "web/src/local/x#helper")!;
    expect(item.outcome).toBe("not-checked");
    expect(item.reason).toContain("git-ignored");
    expect(d.problems).toEqual([]);
  });

  test("gitIgnored / ignoredExpectedFiles name exactly the ignored paths (tracked files never count)", () => {
    const { dir } = sliceRepo();
    writeFileSync(join(dir, ".gitignore"), "web/src/generated-local/\n");
    commitAll(dir, "ignore");
    expect([...gitIgnored(dir, ["web/src/generated-local/x.ts", API_TS])]).toEqual(["web/src/generated-local/x.ts"]);
    expect(gitIgnored(dir, [])).toEqual(new Set());
    const ghosts = { entities: [{ id: DELETE_ROUTE, op: "add" as const, block: "web", kind: "route" as const, expected_file: "web/src/generated-local/x.ts" }, ...GHOSTS_V2.entities] };
    expect(ignoredExpectedFiles(dir, ghosts)).toEqual(["web/src/generated-local/x.ts"]);
  });
});

describe("log-named snapshot locations are checked before touching disk", () => {
  test("a manifest hash must be a sha256; a store must be the default one or under $HOWDAH_HOME", async () => {
    const { checkManifestHash, checkStoreDir, loadSnapshot } = await import("../slice-map");
    const home = tmp("howdah-map-home-");
    process.env.HOWDAH_HOME = home;
    expect(() => checkManifestHash("../../etc/passwd")).toThrow("not a manifest hash");
    expect(() => loadSnapshot(home, "0".repeat(63) + "/")).toThrow("not a manifest hash");
    expect(checkManifestHash("a".repeat(64))).toBe("a".repeat(64));
    expect(checkStoreDir(join(home, "maps"))).toBe(join(home, "maps"));
    expect(checkStoreDir(join(home, "elsewhere", "store"))).toBe(join(home, "elsewhere", "store"));
    expect(() => checkStoreDir("/etc")).toThrow("neither the default store nor under $HOWDAH_HOME");
    expect(() => checkStoreDir(join(home, "..", "outside"))).toThrow("neither the default store");
  });
});
