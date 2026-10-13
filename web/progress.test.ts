/**
 * HOW-49 — "where is it at?": the plan from the agent's own TodoWrite, the live worktree probe,
 * and the liveness clock. The executor half (the full TodoWrite input reaching the log) is in
 * engine/executors/executors.test.ts beside the other fake-claude wire tests.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveDetail, derivePlan } from "./derive";
import { FakeLog } from "./slice.fixtures";
import { LiveGitHub, liveTargetOf, probeLiveGit, type LiveTarget } from "./live-git";
import { QUIET_MS, fmtAgo, liveness } from "./app/lib/liveness";

const todo = (log: FakeLog, todos: unknown, visit = 1, node = "build") =>
  log.add({ type: "chunk", node, visit, turn: 1, index: log.events.length, kind: "tool_call", content: JSON.stringify({ todos }), tool_id: `t${log.events.length}`, tool_name: "TodoWrite" });

function building(): FakeLog {
  const log = new FakeLog();
  log.add({ type: "run-started", graph: "g", inputs: {}, pinned_prompts: {} });
  log.add({ type: "node-started", node: "build", visit: 1, attempt_id: "build#1" });
  return log;
}

describe("derivePlan", () => {
  test("with several TodoWrite calls, the latest wins", () => {
    const log = building();
    todo(log, [{ content: "a", status: "in_progress" }]);
    todo(log, [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "pending" }]);
    expect(derivePlan(log.events, "build", 1)!.items).toEqual([
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "pending" },
    ]);
  });

  test("with none, there is no plan — and nothing is carried over from another step or visit", () => {
    const log = building();
    todo(log, [{ content: "old", status: "pending" }], 1, "plan");
    expect(derivePlan(log.events, "build", 1)).toBeNull();
    todo(log, [{ content: "v1", status: "pending" }]);
    expect(derivePlan(log.events, "build", 2)).toBeNull();
  });

  test("a clipped (pre-HOW-49) input reads as no plan, never as half a plan", () => {
    const log = building();
    log.add({ type: "chunk", node: "build", visit: 1, turn: 1, index: 0, kind: "tool_call", content: '{"todos":[{"content":"a","status":"pend', tool_id: "t", tool_name: "TodoWrite" });
    expect(derivePlan(log.events, "build", 1)).toBeNull();
  });

  test("an unknown status reads as pending; an item with no text is dropped", () => {
    const log = building();
    todo(log, [{ content: "a", status: "weird" }, { status: "completed" }, { activeForm: "Doing b", status: "completed" }]);
    expect(derivePlan(log.events, "build", 1)!.items).toEqual([{ content: "a", status: "pending" }, { content: "Doing b", status: "completed" }]);
  });

  test("RunDetail.plan is the NEWEST step's plan", () => {
    const log = building();
    todo(log, [{ content: "a", status: "pending" }]);
    expect(deriveDetail("r", log.events).plan!.items).toHaveLength(1);
    log.add({ type: "node-finished", node: "build", visit: 1, status: "succeeded", writes: {} });
    log.add({ type: "node-started", node: "review", visit: 1, attempt_id: "review#1" });
    expect(deriveDetail("r", log.events).plan).toBeNull();
  });
});

describe("liveness", () => {
  test("turns amber at the threshold, not before", () => {
    const now = Date.parse("2026-10-12T12:00:00Z");
    const at = (ms: number) => new Date(now - ms).toISOString();
    expect(liveness(at(QUIET_MS - 1), now).quiet).toBe(false);
    expect(liveness(at(QUIET_MS), now).quiet).toBe(true);
    expect(liveness(at(14_000), now)).toEqual({ ageMs: 14_000, quiet: false });
    expect(liveness(null, now)).toEqual({ ageMs: null, quiet: false });
  });

  test("ages read in the shortest honest unit", () => {
    expect(fmtAgo(14_000)).toBe("14s");
    expect(fmtAgo(4 * 60_000)).toBe("4m");
    expect(fmtAgo(65 * 60_000)).toBe("1h 05m");
    expect(fmtAgo(47 * 3_600_000)).toBe("47h 00m");
    expect(fmtAgo(5 * 86_400_000)).toBe("5d");
  });
});

// ---- the live git probe, against a real temp repo -----------------------------------------

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

function repo(): { dir: string; head: () => string } {
  const dir = mkdtempSync(join(tmpdir(), "howdah-livegit-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return { dir, head: () => git(dir, "rev-parse", "HEAD").stdout.trim() };
}

describe("probeLiveGit", () => {
  test("commits made during the step appear; dirty files are counted; the base commit is not", () => {
    const { dir, head } = repo();
    const target: LiveTarget = { node: "build", visit: 1, cwd: dir, base: head(), since: new Date().toISOString() };
    expect(probeLiveGit(target)!.commit_count).toBe(0);
    writeFileSync(join(dir, "b.txt"), "b");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "feat: add b");
    writeFileSync(join(dir, "c.txt"), "dirty");
    writeFileSync(join(dir, "a.txt"), "changed");
    const got = probeLiveGit(target)!;
    expect(got.commits.map((c) => c.subject)).toEqual(["feat: add b"]);
    expect(got.commit_count).toBe(1);
    expect(got.uncommitted).toBe(2);
    expect(got.last_commit_at).not.toBeNull();
  });

  test("it is read-only: no index.lock is ever taken", () => {
    const { dir, head } = repo();
    // a held index.lock makes any git command that WRITES the index fail; ours still answer
    writeFileSync(join(dir, ".git", "index.lock"), "");
    writeFileSync(join(dir, "z.txt"), "z");
    const got = probeLiveGit({ node: "n", visit: 1, cwd: dir, base: head(), since: new Date().toISOString() })!;
    expect(got.uncommitted).toBe(1);
  });

  test("not a repo, or a worktree that is gone, is null rather than a guess", () => {
    expect(probeLiveGit({ node: "n", visit: 1, cwd: mkdtempSync(join(tmpdir(), "plain-")), base: null, since: "" })).toBeNull();
    expect(probeLiveGit({ node: "n", visit: 1, cwd: "/nonexistent/howdah", base: null, since: "" })).toBeNull();
  });
});

describe("liveTargetOf", () => {
  test("the live step, with the HEAD the reconciler saw just before it started", () => {
    const log = new FakeLog();
    log.add({ type: "run-started", graph: "g", inputs: {}, pinned_prompts: {} });
    log.add({ type: "reconciled", node: "build", git: { repo: true, branch: "b", head: "abc", uncommitted: 0, unpushed: 0 }, disagreements: [] });
    log.add({ type: "node-started", node: "build", visit: 1, attempt_id: "build#1" });
    expect(liveTargetOf(log.events, "/w")).toMatchObject({ node: "build", visit: 1, cwd: "/w", base: "abc" });
    log.add({ type: "node-finished", node: "build", visit: 1, status: "succeeded", writes: {} });
    expect(liveTargetOf(log.events, "/w")).toBeNull(); // the step ended
  });

  test("no cwd, no step, or a finished run is not live", () => {
    const log = building();
    expect(liveTargetOf(log.events, undefined)).toBeNull();
    expect(liveTargetOf(new FakeLog().events, "/w")).toBeNull();
    log.add({ type: "run-finished", outcome: "aborted" });
    expect(liveTargetOf(log.events, "/w")).toBeNull();
  });
});

describe("LiveGitHub", () => {
  const hubs: LiveGitHub[] = [];
  const unsubs: Array<() => void> = [];
  afterEach(() => { for (const u of unsubs.splice(0)) u(); hubs.length = 0; });

  test("probes while watched and live; stops when the step ends; stops when the last subscriber leaves", async () => {
    let live = true;
    let probes = 0;
    const hub = new LiveGitHub({
      intervalMs: 20,
      target: () => (live ? { node: "n", visit: 1, cwd: "/w", base: null, since: "" } : null),
      probe: (t) => { probes++; return { node: t.node, visit: t.visit, commits: [], commit_count: 0, uncommitted: 0, last_commit_at: null, base: null, probed_at: "" }; },
    });
    const got: number[] = [];
    const a = hub.subscribe("r", () => got.push(1));
    const b = hub.subscribe("r", () => got.push(2));
    expect(probes).toBeGreaterThanOrEqual(2); // each subscriber gets one at once
    await Bun.sleep(70);
    expect(got).toContain(1);
    expect(got).toContain(2);

    live = false; // the step ended: ticks keep checking, but nothing is spawned
    const atEnd = probes;
    await Bun.sleep(70);
    expect(probes).toBe(atEnd);

    live = true;
    a();
    expect(hub.watching()).toEqual(["r"]); // one subscriber left
    b();
    expect(hub.watching()).toEqual([]); // the last one left: the timer is gone
    const atLeave = probes;
    await Bun.sleep(70);
    expect(probes).toBe(atLeave);
  });
});

describe("the run's SSE stream carries the live probe", () => {
  test("a watched live step gets `event: git-live` frames; nothing is written to the log", async () => {
    const { createHowdahServer } = await import("./server");
    const { EventLog, readLog } = await import("../log/write");
    const { claimRunner, releaseRunner } = await import("../engine/control");
    const home = mkdtempSync(join(tmpdir(), "howdah-livegit-srv-"));
    const runsDir = join(home, "runs");
    const { dir, head } = repo();
    const runDir = join(runsDir, "live");
    const log = new EventLog(join(runDir, "run.jsonl"));
    log.append({ type: "run-started", graph: "g", inputs: {}, pinned_prompts: {}, cwd: dir, folder_kind: "repo" });
    log.append({ type: "reconciled", node: "build", git: { repo: true, branch: "main", head: head(), uncommitted: 0, unpushed: null }, disagreements: [] });
    log.append({ type: "node-started", node: "build", visit: 1, attempt_id: "build#1" });
    writeFileSync(join(dir, "b.txt"), "b");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "feat: during the step");
    claimRunner(runDir); // this test process is the "runner": alive and provable
    const before = readLog(join(runDir, "run.jsonl")).length;
    const server = createHowdahServer({ runsDir, attentionDir: join(home, "attention"), port: 0, pollMs: 50, liveGitIntervalMs: 50, graphs: {} });
    try {
      const res = await fetch(`http://localhost:${server.port}/api/runs/live/events?since=999`);
      const reader = res.body!.getReader();
      let frame = "";
      for (let i = 0; i < 20 && !frame.includes("event: git-live"); i++) frame += new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
      const data = frame.split("event: git-live\ndata: ")[1]!.split("\n")[0]!;
      const got = JSON.parse(data);
      expect(got).toMatchObject({ node: "build", visit: 1, commit_count: 1 });
      expect(got.commits[0].subject).toBe("feat: during the step");
      expect(readLog(join(runDir, "run.jsonl")).length).toBe(before);
    } finally {
      releaseRunner(runDir);
      server.stop(true);
    }
  });
});
