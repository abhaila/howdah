import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execSync } from "node:child_process";
import { worktreeExecutor, commandExecutor, effectiveCwd, readWorktreeRecord, derivePrState, ghPrProbe, stackPrState, publicationPrRefs, type PrState } from "./worktree";
import { EventLog } from "../../log/write";
import type { ExecArgs } from "../run";
import { commit, git, lonelyRepo, originFixture, sha } from "./git-testkit";

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

  test("HOW-44: create publishes the workspace's verify command when declared — \"\" when it has none, on both paths", async () => {
    const repoDir = repo();
    const runDir = mkdtempSync(join(tmpdir(), "howdah-wt-run-"));
    const log = new EventLog(join(runDir, "run.jsonl"));
    const declared = { kind: "worktree" as const, action: "create" as const, writes: { "worktree.verify_command": { scope: "sticky" as const } } };
    const exec = worktreeExecutor({ reposDir: join(runDir, "repos"), verifyCommandFor: (p) => (p === repoDir ? "bun test" : undefined) });
    expect((await exec(args({ def: declared, log, cwd: repoDir }))).writes).toEqual({ "worktree.verify_command": "bun test" });
    // the idempotent re-visit publishes it too
    expect((await exec(args({ def: declared, log, cwd: repoDir }))).writes).toEqual({ "worktree.verify_command": "bun test" });
    const none = worktreeExecutor({ reposDir: join(runDir, "repos2") });
    const run2 = mkdtempSync(join(tmpdir(), "howdah-wt-run-"));
    expect((await none(args({ def: declared, log: new EventLog(join(run2, "run.jsonl")), cwd: repo() }))).writes).toEqual({ "worktree.verify_command": "" });
    // not declared: nothing published, exactly as before
    const run3 = mkdtempSync(join(tmpdir(), "howdah-wt-run-"));
    expect((await exec(args({ def: { kind: "worktree", action: "create" }, log: new EventLog(join(run3, "run.jsonl")), cwd: repo() }))).writes).toEqual({});
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

describe("HOW-57: where a worktree branch starts (decision C)", () => {
  const create = { kind: "worktree" as const, action: "create" as const };
  const stacked = { ...create, reads: ["deps.base", "deps.base_tip"] };
  const run = () => {
    const runDir = mkdtempSync(join(tmpdir(), "howdah-wt-run-"));
    return { runDir, log: new EventLog(join(runDir, "run.jsonl")), reposDir: join(runDir, "repos") };
  };
  const notes = (log: EventLog) => log.read().flatMap((e) => (e.type === "chunk" ? [e.content] : [])).join("");
  const doneResult = (log: EventLog) => {
    const done = log.read().find((e) => e.type === "side-effect-done" && e.effect === "worktree-create");
    return done?.type === "side-effect-done" ? done.result : undefined;
  };
  /** args whose effects really log, so the effect's recorded result can be asserted */
  const logged = (partial: Partial<ExecArgs> & { def: ExecArgs["def"]; log: EventLog }): ExecArgs =>
    args({
      ...partial,
      effects: {
        claim: () => false,
        done: (effect, result) => void partial.log.append({ type: "side-effect-done", node: "n", visit: 1, attempt_id: "n#1", effect, result }),
      },
    });

  test("REGRESSION (critical): a repo with no remote branches from HEAD, as before, and says why", async () => {
    const repoDir = lonelyRepo();
    git(repoDir, "checkout", "-q", "-b", "feature");
    const head = commit(repoDir, "f.txt", "feature work\n");
    const { runDir, log, reposDir } = run();
    const r = await worktreeExecutor({ reposDir })(logged({ def: create, log, cwd: repoDir }));
    expect(r.status).toBe("succeeded");
    const record = readWorktreeRecord(runDir)!;
    expect(sha(record.path, "HEAD")).toBe(head);
    expect(record).toMatchObject({ base: "HEAD", base_sha: head });
    expect(notes(log)).toContain("no `origin` remote — branching from HEAD (feature @");
    expect(doneResult(log)).toMatchObject({ base: "HEAD", base_sha: head, local_head: head });
  });

  test("the default base is origin/main after a fetch, even when the clone is behind", async () => {
    const { clone, other } = originFixture();
    const tip = commit(other, "teammate.txt", "landed upstream\n");
    git(other, "push", "-q", "origin", "main");
    const { runDir, log, reposDir } = run();
    await worktreeExecutor({ reposDir })(logged({ def: create, log, cwd: clone }));
    const record = readWorktreeRecord(runDir)!;
    expect(sha(record.path, "HEAD")).toBe(tip);
    expect(record.base).toBe("origin/main");
    expect(notes(log)).toContain(`worktree base: origin/main @ ${tip.slice(0, 12)}`);
    expect(notes(log)).not.toContain("ahead");
  });

  test("local commits origin lacks are reported and NOT used", async () => {
    const { clone } = originFixture();
    const upstream = sha(clone, "origin/main");
    const local = commit(clone, "experiment.txt", "unpushed\n");
    const { runDir, log, reposDir } = run();
    await worktreeExecutor({ reposDir })(logged({ def: create, log, cwd: clone }));
    const record = readWorktreeRecord(runDir)!;
    expect(sha(record.path, "HEAD")).toBe(upstream);
    expect(existsSync(join(record.path, "experiment.txt"))).toBe(false);
    expect(notes(log)).toContain("your local main is 1 commit ahead of origin/main; not used");
    expect(doneResult(log)).toMatchObject({ base: "origin/main", base_sha: upstream, local_head: local, ahead: 1 });
  });

  test("config defaultBranch wins over origin's HEAD", async () => {
    const { clone, other } = originFixture();
    git(other, "checkout", "-q", "-b", "develop");
    const dev = commit(other, "dev.txt", "develop\n");
    git(other, "push", "-q", "origin", "develop");
    const { runDir, log, reposDir } = run();
    await worktreeExecutor({ reposDir, defaultBranchFor: (p) => (p === clone ? "develop" : undefined) })(logged({ def: create, log, cwd: clone }));
    expect(sha(readWorktreeRecord(runDir)!.path, "HEAD")).toBe(dev);
  });

  test("a stack base starts the branch at the dependency's published tip", async () => {
    const { clone, other } = originFixture();
    git(other, "checkout", "-q", "-b", "howdah/p--fe-1");
    const tip = commit(other, "fe1.txt", "fe-1\n");
    git(other, "push", "-q", "origin", "howdah/p--fe-1");
    const { runDir, log, reposDir } = run();
    await worktreeExecutor({ reposDir })(logged({ def: stacked, log, cwd: clone, reads: { "deps.base": "howdah/p--fe-1", "deps.base_tip": tip } }));
    const record = readWorktreeRecord(runDir)!;
    expect(sha(record.path, "HEAD")).toBe(tip);
    expect(record.base_sha).toBe(tip);
    expect(notes(log)).toContain(`stacked on howdah/p--fe-1 @ ${tip.slice(0, 12)}`);
  });

  test("a stack base with no tip starts from origin/<base>", async () => {
    const { clone, other } = originFixture();
    git(other, "checkout", "-q", "-b", "be-stack");
    const tip = commit(other, "be.txt", "be\n");
    git(other, "push", "-q", "origin", "be-stack");
    const { runDir, log, reposDir } = run();
    await worktreeExecutor({ reposDir })(logged({ def: stacked, log, cwd: clone, reads: { "deps.base": "be-stack", "deps.base_tip": "" } }));
    expect(sha(readWorktreeRecord(runDir)!.path, "HEAD")).toBe(tip);
  });

  test("an unknown stack base parks with the reason — it never falls back to main", async () => {
    const { clone } = originFixture();
    const { runDir, log, reposDir } = run();
    const exec = worktreeExecutor({ reposDir });
    await expect(exec(logged({ def: stacked, log, cwd: clone, reads: { "deps.base": "nope", "deps.base_tip": "" } }))).rejects.toThrow('base branch "nope" not found on origin');
    expect(readWorktreeRecord(runDir)).toBeNull();
  });

  test("a failed fetch (origin is unreachable) still branches, from HEAD, and says so", async () => {
    const { clone } = originFixture();
    git(clone, "remote", "set-url", "origin", join(tmpdir(), "howdah-no-such-origin-" + Date.now()));
    // forget the remote-tracking refs too, so there is no stale origin/main to fall back on
    git(clone, "update-ref", "-d", "refs/remotes/origin/main");
    try { git(clone, "remote", "set-head", "origin", "-d"); } catch { /* none */ }
    const head = sha(clone, "HEAD");
    const { runDir, log, reposDir } = run();
    await worktreeExecutor({ reposDir })(logged({ def: create, log, cwd: clone }));
    expect(sha(readWorktreeRecord(runDir)!.path, "HEAD")).toBe(head);
    expect(notes(log)).toContain("git fetch origin failed");
    expect(notes(log)).toContain("branching from HEAD");
  });

  test("a failed fetch with a stale origin/main uses it and says it was not refreshed", async () => {
    const { clone } = originFixture();
    const stale = sha(clone, "origin/main");
    git(clone, "remote", "set-url", "origin", join(tmpdir(), "howdah-no-such-origin-" + Date.now()));
    const { runDir, log, reposDir } = run();
    await worktreeExecutor({ reposDir })(logged({ def: create, log, cwd: clone }));
    expect(sha(readWorktreeRecord(runDir)!.path, "HEAD")).toBe(stale);
    expect(notes(log)).toContain("(not refreshed: the fetch failed)");
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
    expect(derivePrState({ state: "OPEN", reviewDecision: "CHANGES_REQUESTED", failedChecks: true })).toBe("CHANGES_REQUIRED");
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

  test("prefers the published PR URL over branch rediscovery", async () => {
    const repoDir = repo();
    const runDir = mkdtempSync(join(tmpdir(), "howdah-pr-"));
    const log = new EventLog(join(runDir, "run.jsonl"));
    let observedRef = "";
    const exec = commandExecutor({
      prProbe: (_cwd, ref) => {
        observedRef = ref;
        return { state: "OPEN", url: "https://github.com/areeb/x/pull/7" };
      },
    });
    await exec(args({
      def: { ...prDef, reads: ["publication_summary"] },
      log,
      cwd: repoDir,
      reads: { publication_summary: { pr_url: "https://github.com/areeb/x/pull/7" } },
    }));
    expect(observedRef).toBe("https://github.com/areeb/x/pull/7");
  });

  test("a stacked publish probes every PR and routes on the most urgent, lowest first", async () => {
    const repoDir = repo();
    const runDir = mkdtempSync(join(tmpdir(), "howdah-pr-"));
    const log = new EventLog(join(runDir, "run.jsonl"));
    const states: Record<string, PrState> = {
      "https://github.com/areeb/x/pull/1": "OPEN",
      "https://github.com/areeb/x/pull/2": "CI_FAILED",
      "https://github.com/areeb/x/pull/3": "CI_FAILED",
    };
    const probed: string[] = [];
    const exec = commandExecutor({
      prProbe: (_cwd, ref) => {
        probed.push(ref);
        const state = states[ref];
        return state ? { state, url: ref } : null;
      },
    });
    const r = await exec(args({
      def: { ...prDef, reads: ["publication_summary"] },
      log,
      cwd: repoDir,
      reads: {
        publication_summary: {
          pr_urls: Object.keys(states),
          primary_pr_url: "https://github.com/areeb/x/pull/3",
        },
      },
    }));
    expect(probed).toEqual(Object.keys(states));
    expect(r).toEqual({ status: "succeeded", writes: { "pr.state": "CI_FAILED" } });
    const rec: any = log.read().find((e) => e.type === "reconciled");
    expect(rec.forge).toEqual({ kind: "pr", state: "CI_FAILED", url: "https://github.com/areeb/x/pull/2" });
  });

  test("HOW-57 G2: a dependency PR cited FIRST is ignored — the run watches only its own", async () => {
    const repoDir = repo();
    const runDir = mkdtempSync(join(tmpdir(), "howdah-pr-"));
    const log = new EventLog(join(runDir, "run.jsonl"));
    const base = "https://github.com/areeb/x/pull/1";
    const own = "https://github.com/areeb/x/pull/2";
    const probed: string[] = [];
    const exec = commandExecutor({
      prProbe: (_cwd, ref) => {
        probed.push(ref);
        return { state: ref === base ? "MERGED" : "OPEN", url: ref };
      },
    });
    // prose that names the base PR first: without the filter, publicationPrRefs takes it as ours
    const r = await exec(args({
      def: { ...prDef, reads: ["publication_summary", "deps.prs"] },
      log, cwd: repoDir,
      reads: { publication_summary: { pr_urls: [base, own], primary_pr_url: own }, "deps.prs": [base] },
    }));
    expect(probed).toEqual([own]);
    expect(r.writes).toEqual({ "pr.state": "OPEN" });
    // and a prose summary whose only link is the base falls back to the run's own branch
    probed.length = 0;
    await exec(args({ def: { ...prDef, reads: ["publication_summary", "deps.prs"] }, log, cwd: repoDir, reads: { publication_summary: `stacked on ${base}`, "deps.prs": [base] } }));
    expect(probed).not.toContain(base);
  });

  test("HOW-57: pr.approved, when declared, is true only when every PR of the run is approved", async () => {
    const repoDir = repo();
    const runDir = mkdtempSync(join(tmpdir(), "howdah-pr-"));
    const log = new EventLog(join(runDir, "run.jsonl"));
    const approvals: Record<string, boolean> = { "https://github.com/areeb/x/pull/1": true, "https://github.com/areeb/x/pull/2": false };
    const exec = commandExecutor({ prProbe: (_cwd, ref) => ({ state: "OPEN", url: ref, approved: approvals[ref] }) });
    const def = { ...prDef, reads: ["publication_summary"], writes: { ...prDef.writes, "pr.approved": { scope: "per-visit" as const } } };
    const summary = { pr_urls: Object.keys(approvals) };
    expect((await exec(args({ def, log, cwd: repoDir, reads: { publication_summary: summary } }))).writes).toEqual({ "pr.state": "OPEN", "pr.approved": false });
    approvals["https://github.com/areeb/x/pull/2"] = true;
    expect((await exec(args({ def, log, cwd: repoDir, reads: { publication_summary: summary } }))).writes).toEqual({ "pr.state": "OPEN", "pr.approved": true });
    // undeclared: not published, exactly as before
    expect((await exec(args({ def: { ...prDef, reads: ["publication_summary"] }, log, cwd: repoDir, reads: { publication_summary: summary } }))).writes).toEqual({ "pr.state": "OPEN" });
  });

  test("a stack PR that does not exist parks naming it", async () => {
    const repoDir = repo();
    const runDir = mkdtempSync(join(tmpdir(), "howdah-pr-"));
    const log = new EventLog(join(runDir, "run.jsonl"));
    const exec = commandExecutor({
      prProbe: (_cwd, ref) => (ref.endsWith("/1") ? { state: "OPEN", url: ref } : null),
    });
    await expect(exec(args({
      def: { ...prDef, reads: ["publication_summary"] },
      log,
      cwd: repoDir,
      reads: { publication_summary: { pr_urls: ["https://github.com/areeb/x/pull/1", "https://github.com/areeb/x/pull/2"] } },
    }))).rejects.toThrow('no PR exists for "https://github.com/areeb/x/pull/2"');
  });

  test("stackPrState: MERGED only when all land; a closed PR beside an open one keeps polling", () => {
    expect(stackPrState(["MERGED", "MERGED"])).toEqual({ state: "MERGED", decidedBy: 1 });
    expect(stackPrState(["MERGED", "OPEN"])).toEqual({ state: "OPEN", decidedBy: 1 });
    expect(stackPrState(["CLOSED", "OPEN"])).toEqual({ state: "OPEN", decidedBy: 1 });
    expect(stackPrState(["MERGED", "CLOSED"])).toEqual({ state: "CLOSED", decidedBy: 1 });
    expect(stackPrState(["CI_FAILED", "CHANGES_REQUIRED", "CONFLICTS"])).toEqual({ state: "CONFLICTS", decidedBy: 2 });
    expect(stackPrState(["OPEN", "CHANGES_REQUIRED", "CI_FAILED"])).toEqual({ state: "CHANGES_REQUIRED", decidedBy: 1 });
  });

  test("publicationPrRefs: list first, primary deduped, prose keeps only its first link", () => {
    expect(publicationPrRefs({
      pr_urls: ["https://github.com/a/b/pull/1", "https://github.com/a/b/pull/2"],
      primary_pr_url: "https://github.com/a/b/pull/2",
    })).toEqual(["https://github.com/a/b/pull/1", "https://github.com/a/b/pull/2"]);
    expect(publicationPrRefs({ pr_url: "https://github.com/a/b/pull/7" })).toEqual(["https://github.com/a/b/pull/7"]);
    expect(publicationPrRefs("opened https://github.com/a/b/pull/3 after https://github.com/c/d/pull/9")).toEqual(["https://github.com/a/b/pull/3"]);
    expect(publicationPrRefs({ note: "nothing" })).toEqual([]);
  });

  test("required checks decide CI_FAILED, not optional failures in the rollup", () => {
    const repoDir = repo();
    const binDir = mkdtempSync(join(tmpdir(), "howdah-gh-"));
    const gh = join(binDir, "gh");
    writeFileSync(gh, `#!/usr/bin/env bash
if [[ "$1 $2" == "pr view" ]]; then
  printf '%s\\n' '{"state":"OPEN","url":"https://github.com/areeb/x/pull/7","mergeable":"MERGEABLE","reviewDecision":"REVIEW_REQUIRED","statusCheckRollup":[{"conclusion":"FAILURE","state":"COMPLETED"}]}'
  exit 0
fi
if [[ "$1 $2" == "pr checks" ]]; then
  printf '%s\\n' '[{"name":"required","state":"SUCCESS","bucket":"pass"}]'
  exit 0
fi
exit 1
`);
    chmodSync(gh, 0o755);
    const priorPath = process.env.PATH;
    process.env.PATH = `${binDir}:${priorPath ?? ""}`;
    try {
      expect(ghPrProbe(repoDir, "https://github.com/areeb/x/pull/7")).toEqual({
        state: "OPEN",
        url: "https://github.com/areeb/x/pull/7",
        approved: false, // HOW-57: REVIEW_REQUIRED is not an approval
      });
    } finally {
      process.env.PATH = priorPath;
    }
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
