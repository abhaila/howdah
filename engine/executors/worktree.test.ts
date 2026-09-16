import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execSync } from "node:child_process";
import { worktreeExecutor, commandExecutor, effectiveCwd, readWorktreeRecord, derivePrState } from "./worktree";
import { EventLog } from "../../log/write";
import type { ExecArgs } from "../run";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "howdah-wt-repo-"));
  const git = (c: string) => execSync(`git ${c}`, { cwd: dir, stdio: "pipe" });
  git("init -q -b main");
  git("config user.email t@t && git config user.name t");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git("add . && git commit -q -m init");
  return dir;
}

function args(partial: Partial<ExecArgs> & { def: ExecArgs["def"]; log: EventLog }): ExecArgs {
  const claimed = new Set<string>();
  return {
    nodeId: "n", visit: 1, attemptId: "n#1", runId: "wt-run", reads: {},
    effects: { claim: (e) => claimed.has(e) || (claimed.add(e), false), done: () => {} },
    ...partial,
  } as ExecArgs;
}

describe("worktree executor (real git)", () => {
  test("the repoName resolver decides the folder — two clones of one name cannot collide", async () => {
    const repoDir = repo();
    const runDir = mkdtempSync(join(tmpdir(), "howdah-wt-run-"));
    const reposDir = join(runDir, "repos");
    const log = new EventLog(join(runDir, "run.jsonl"));
    const exec = worktreeExecutor({ reposDir, repoName: () => "acme-api" });

    await exec(args({ def: { kind: "worktree", action: "create" }, log, cwd: repoDir }));
    expect(readWorktreeRecord(runDir)!.path).toBe(join(reposDir, "acme-api", "worktrees", "wt-run"));
  });

  test("create → work lands in an isolated branch; remove refuses while dirty; clean remove succeeds", async () => {
    const repoDir = repo();
    const runDir = mkdtempSync(join(tmpdir(), "howdah-wt-run-"));
    const reposDir = join(runDir, "repos");
    const log = new EventLog(join(runDir, "run.jsonl"));
    const exec = worktreeExecutor({ reposDir });

    // create
    const created = await exec(args({ def: { kind: "worktree", action: "create" }, log, cwd: repoDir }));
    expect(created.status).toBe("succeeded");
    const record = readWorktreeRecord(runDir)!;
    expect(record.branch).toBe("howdah/wt-run");
    // grouped per repo: <reposDir>/<repo name>/worktrees/<runId>
    expect(record.path).toBe(join(reposDir, basename(repoDir), "worktrees", "wt-run"));
    expect(existsSync(join(record.path, "README.md"))).toBe(true);
    // executors resolve their cwd through the record from now on
    expect(effectiveCwd(log.path, repoDir)).toBe(record.path);
    // idempotent on re-visit
    expect((await exec(args({ def: { kind: "worktree", action: "create" }, log, cwd: repoDir }))).status).toBe("succeeded");

    // dirty worktree: remove REFUSES, preserving local work
    writeFileSync(join(record.path, "wip.txt"), "uncommitted\n");
    const def = { kind: "worktree", action: "remove", writes: { "worktree.clean": { scope: "per-visit" }, outcome: { scope: "per-visit" } } } as const;
    const dirty = await exec(args({ def: def as any, log, cwd: repoDir }));
    expect(dirty.writes).toEqual({ "worktree.clean": false, outcome: "failed" });
    expect(existsSync(record.path)).toBe(true);

    // commit the work → clean remove
    execSync("git add . && git commit -q -m wip", { cwd: record.path });
    const clean = await exec(args({ def: def as any, log, cwd: repoDir }));
    expect(clean.writes).toEqual({ "worktree.clean": true, outcome: "removed" });
    expect(existsSync(record.path)).toBe(false);
    expect(readWorktreeRecord(runDir)).toBeNull();
  });
});

describe("command executor", () => {
  test("streams stdout and reads declared facts from the FINAL JSON line", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "howdah-cmd-"));
    const log = new EventLog(join(runDir, "run.jsonl"));
    const result = await commandExecutor()(args({
      def: { kind: "command", run: `echo working...; echo '{"tests_passed": true, "count": 7}'`, writes: { tests_passed: { scope: "per-visit" }, count: { scope: "per-visit" } } } as any,
      log, cwd: runDir,
    }));
    expect(result).toEqual({ status: "succeeded", writes: { tests_passed: true, count: 7 } });
    const text = log.read().filter((e: any) => e.type === "chunk" && e.kind === "text").map((e: any) => e.content).join("");
    expect(text).toContain("working...");
  });

  test("non-zero exit and missing facts both fail the attempt", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "howdah-cmd-"));
    const log = new EventLog(join(runDir, "run.jsonl"));
    const boom = await commandExecutor()(args({ def: { kind: "command", run: "exit 3" } as any, log, cwd: runDir }));
    expect(boom.status).toBe("failed");
    const noFacts = await commandExecutor()(args({
      def: { kind: "command", run: `echo '{"other": 1}'`, writes: { needed: { scope: "per-visit" } } } as any,
      log, cwd: runDir,
    }));
    expect(noFacts.status).toBe("failed");
  });

  test("timeout kills the command", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "howdah-cmd-"));
    const log = new EventLog(join(runDir, "run.jsonl"));
    const r = await commandExecutor({ defaultTimeoutMs: 300 })(args({ def: { kind: "command", run: "sleep 30" } as any, log, cwd: runDir }));
    expect(r.status).toBe("failed");
  }, 5000);
});

describe("probe:pr", () => {
  const prDef = { kind: "command", run: "probe:pr", writes: { "pr.state": { scope: "per-visit" } } } as any;

  test("derivePrState covers the routing table", () => {
    expect(derivePrState({ state: "MERGED" })).toBe("MERGED");
    expect(derivePrState({ state: "CLOSED" })).toBe("CLOSED");
    expect(derivePrState({ state: "OPEN", mergeable: "CONFLICTING" })).toBe("CONFLICTS");
    expect(derivePrState({ state: "OPEN", failedChecks: true })).toBe("CI_FAILED");
    expect(derivePrState({ state: "OPEN", reviewDecision: "CHANGES_REQUESTED" })).toBe("CHANGES_REQUIRED");
    expect(derivePrState({ state: "OPEN" })).toBe("OPEN");
  });

  test("writes pr.state and a reconciled event carrying the PR link", async () => {
    const repoDir = repo();
    const runDir = mkdtempSync(join(tmpdir(), "howdah-pr-"));
    const log = new EventLog(join(runDir, "run.jsonl"));
    const exec = commandExecutor({ prProbe: () => ({ state: "CHANGES_REQUIRED", url: "https://github.com/areeb/x/pull/7" }) });
    const r = await exec(args({ def: prDef, log, cwd: repoDir }));
    expect(r).toEqual({ status: "succeeded", writes: { "pr.state": "CHANGES_REQUIRED" } });
    const rec: any = log.read().find((e) => e.type === "reconciled");
    expect(rec.forge).toEqual({ kind: "pr", state: "CHANGES_REQUIRED", url: "https://github.com/areeb/x/pull/7" });
  });

  test("no PR is a THROWN error (parks), and so is forge-unreachable — never a silent state", async () => {
    const repoDir = repo();
    const runDir = mkdtempSync(join(tmpdir(), "howdah-pr-"));
    const log = new EventLog(join(runDir, "run.jsonl"));
    await expect(
      commandExecutor({ prProbe: () => null })(args({ def: prDef, log, cwd: repoDir })),
    ).rejects.toThrow(/no PR exists/);
    await expect(
      commandExecutor({ prProbe: () => { throw new Error("forge unreachable: connect timeout"); } })(args({ def: prDef, log, cwd: repoDir })),
    ).rejects.toThrow(/forge unreachable/);
  });
});
