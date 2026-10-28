/**
 * HOW-75 — `repair:changed`: unchanged needs proof, and every doubtful case answers "changed".
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairChanged, repairCheckBuiltinExecutor } from "./repair-check";
import { commit, lonelyRepo } from "./git-testkit";
import { EventLog } from "../../log/write";
import { probeGit } from "../reconcile";

const git0 = (head: string | null, uncommitted = 0) => ({ repo: true, branch: "howdah/x", head, uncommitted, unpushed: 0 });

describe("repairChanged", () => {
  test("same HEAD, clean then and now → unchanged", () => {
    expect(repairChanged(git0("abc1234"), git0("abc1234")).changed).toBe(false);
  });
  test("a new commit, or an uncommitted edit → changed", () => {
    expect(repairChanged(git0("abc1234"), git0("def5678"))).toMatchObject({ changed: true, why: expect.stringContaining("HEAD moved") });
    expect(repairChanged(git0("abc1234"), git0("abc1234", 2))).toMatchObject({ changed: true, why: expect.stringContaining("uncommitted") });
  });
  test("doubt answers changed: no observation, a dirty start, no HEAD, no git", () => {
    expect(repairChanged(undefined, git0("a")).changed).toBe(true);
    expect(repairChanged(git0("abc1234", 1), git0("abc1234", 1)).changed).toBe(true);
    expect(repairChanged(git0(null), git0("a")).changed).toBe(true);
    expect(repairChanged({ ...git0("a"), repo: false }, git0("a")).changed).toBe(true);
  });
});

describe("repair:changed over a real log and repo", () => {
  const def = { kind: "command", run: "repair:changed", reads: ["repair_summary"], writes: { "repair.changed": { scope: "per-visit" } } } as any;
  function setup() {
    const repo = lonelyRepo();
    const log = new EventLog(join(mkdtempSync(join(tmpdir(), "howdah-rc-")), "run.jsonl"));
    // what the engine logs: the reconcile before the repair's start, then the check's own start
    log.append({ type: "reconciled", node: "delivery.address_reviews", git: probeGit(repo), disagreements: [] });
    log.append({ type: "node-started", node: "delivery.address_reviews", visit: 2, attempt_id: "delivery.address_reviews#2" });
    return { repo, log };
  }
  const run = (repo: string, log: EventLog, reads: Record<string, unknown> = { repair_summary: "Already fixed.\nmore" }, d = def) => {
    log.append({ type: "node-started", node: "delivery.repair_check", visit: 1, attempt_id: "delivery.repair_check#1" });
    return repairCheckBuiltinExecutor()({ nodeId: "delivery.repair_check", def: d, visit: 1, attemptId: "x", cwd: repo, runId: "r", log, reads, effects: {} as any });
  };

  test("nothing committed → false, and the thread quotes the summary's first line", async () => {
    const { repo, log } = setup();
    expect((await run(repo, log)).writes).toEqual({ "repair.changed": false });
    const note = log.read().find((e) => e.type === "chunk");
    expect(note?.type === "chunk" && note.content).toStartWith("delivery.address_reviews@2 made no change: Already fixed.; waiting for the PR to move");
  });

  test("a commit, or a loose edit → true", async () => {
    const a = setup();
    commit(a.repo, "x.ts", "1\n");
    expect((await run(a.repo, a.log)).writes).toEqual({ "repair.changed": true });
    const b = setup();
    writeFileSync(join(b.repo, "loose.ts"), "x\n");
    expect((await run(b.repo, b.log)).writes).toEqual({ "repair.changed": true });
  });

  test("a dirty start → true (whatever was there is unreviewed work)", async () => {
    const repo = lonelyRepo();
    writeFileSync(join(repo, "loose.ts"), "x\n");
    const log = new EventLog(join(mkdtempSync(join(tmpdir(), "howdah-rc-")), "run.jsonl"));
    log.append({ type: "reconciled", node: "delivery.fix_ci", git: probeGit(repo), disagreements: [] });
    log.append({ type: "node-started", node: "delivery.fix_ci", visit: 1, attempt_id: "delivery.fix_ci#1" });
    rmSync(join(repo, "loose.ts")); // clean now, by a means that is not a commit
    expect((await run(repo, log)).writes).toEqual({ "repair.changed": true });
  });

  test("no reconcile on the log → true", async () => {
    const repo = lonelyRepo();
    const log = new EventLog(join(mkdtempSync(join(tmpdir(), "howdah-rc-")), "run.jsonl"));
    log.append({ type: "node-started", node: "delivery.fix_ci", visit: 1, attempt_id: "delivery.fix_ci#1" });
    expect((await run(repo, log)).writes).toEqual({ "repair.changed": true });
  });

  test("refused before anything: an argument, a write it cannot produce, a missing read", async () => {
    const { repo, log } = setup();
    expect((await run(repo, log, {}, { ...def, run: "repair:changed --x" })).status).toBe("failed");
    expect((await run(repo, log, {}, { ...def, writes: { other: { scope: "per-visit" } } })).status).toBe("failed");
    expect((await run(repo, log, {}, { ...def, reads: [] })).status).toBe("failed");
  });
});
