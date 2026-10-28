import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execSync } from "node:child_process";
import { worktreeExecutor, commandExecutor, effectiveCwd, readWorktreeRecord, derivePrState, ghPrProbe, stackPrState, publicationPrRefs, checksFailed, type PrState } from "./worktree";
import { EventLog } from "../../log/write";
import { REVIEW_REPLY_MARKER } from "../../core/review-activity";
import { ForgeUnreachableError } from "./git";
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

  test("HOW-59: create publishes the preview's paths when declared — \"\" when there is no preview, on both paths", async () => {
    const repoDir = repo();
    const runDir = mkdtempSync(join(tmpdir(), "howdah-wt-run-"));
    const log = new EventLog(join(runDir, "run.jsonl"));
    const declared = { kind: "worktree" as const, action: "create" as const, writes: { "worktree.preview_paths": { scope: "sticky" as const } } };
    const exec = worktreeExecutor({ reposDir: join(runDir, "repos"), previewPathsFor: (p) => (p === repoDir ? ["/", "/runs"] : undefined) });
    expect((await exec(args({ def: declared, log, cwd: repoDir }))).writes).toEqual({ "worktree.preview_paths": "/, /runs" });
    expect((await exec(args({ def: declared, log, cwd: repoDir }))).writes).toEqual({ "worktree.preview_paths": "/, /runs" });
    const run2 = mkdtempSync(join(tmpdir(), "howdah-wt-run-"));
    expect((await worktreeExecutor({ reposDir: join(run2, "repos") })(args({ def: declared, log: new EventLog(join(run2, "run.jsonl")), cwd: repo() }))).writes).toEqual({ "worktree.preview_paths": "" });
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

  // Captured from PR 14969 ninety seconds after a stack force-push: every check's superseded
  // run sits CANCELLED beside the new run of the same name, still in progress. Read flat that
  // was CI_FAILED, and the graph went into fix_ci on a verdict CI had not given.
  test("a check is failed only when its latest run says so — a superseded CANCELLED run is not a verdict", () => {
    const rollup = [
      { conclusion: "CANCELLED", name: "check-commits", startedAt: "2026-10-15T11:34:42Z", status: "COMPLETED" },
      { conclusion: "SUCCESS", name: "check-commits", startedAt: "2026-10-15T11:34:51Z", status: "COMPLETED" },
      { conclusion: "CANCELLED", name: "build", startedAt: "2026-10-15T11:34:43Z", status: "COMPLETED" },
      { conclusion: "", name: "build", startedAt: "2026-10-15T11:35:24Z", status: "IN_PROGRESS" },
      { conclusion: "CANCELLED", name: "pact-check", startedAt: "2026-10-15T11:34:44Z", status: "COMPLETED" },
    ];
    expect(checksFailed(rollup)).toBe(false);
    // the same picture from `gh pr checks` (state + bucket, no conclusion)
    expect(checksFailed([
      { name: "build", state: "CANCELLED", bucket: "cancel", startedAt: "2026-10-15T11:34:43Z" },
      { name: "build", state: "PENDING", bucket: "pending", startedAt: "2026-10-15T11:35:24Z" },
    ])).toBe(false);
    // a real failure with nothing re-running IS a verdict, under either spelling
    expect(checksFailed([{ name: "unit-test", conclusion: "FAILURE", status: "COMPLETED" }])).toBe(true);
    expect(checksFailed([{ name: "unit-test", state: "FAILURE", bucket: "fail" }])).toBe(true);
    // a failure that has since been re-run green is not; an older green beside a newer failure is
    expect(checksFailed([
      { name: "unit-test", conclusion: "FAILURE", startedAt: "2026-10-15T10:00:00Z", status: "COMPLETED" },
      { name: "unit-test", conclusion: "SUCCESS", startedAt: "2026-10-15T11:00:00Z", status: "COMPLETED" },
    ])).toBe(false);
    expect(checksFailed([
      { name: "unit-test", conclusion: "SUCCESS", startedAt: "2026-10-15T10:00:00Z", status: "COMPLETED" },
      { name: "unit-test", conclusion: "FAILURE", startedAt: "2026-10-15T11:00:00Z", status: "COMPLETED" },
    ])).toBe(true);
    // a failure still being re-run has no verdict yet; a cancelled run alone is waited on, not repaired
    expect(checksFailed([{ name: "build", conclusion: "FAILURE", status: "COMPLETED" }, { name: "build", conclusion: "", status: "IN_PROGRESS" }])).toBe(false);
    expect(checksFailed([{ name: "build", conclusion: "CANCELLED", status: "COMPLETED" }])).toBe(false);
    // rows with no name (status contexts) each stand alone
    expect(checksFailed([{ context: "ci/legacy", state: "FAILURE" }, { context: "ci/other", state: "SUCCESS" }])).toBe(true);
    expect(checksFailed([])).toBe(false);
  });

  test("the probe reads OPEN, not CI_FAILED, while a force-push's superseded runs sit beside new ones", () => {
    const repoDir = repo();
    const binDir = mkdtempSync(join(tmpdir(), "howdah-gh-"));
    const gh = join(binDir, "gh");
    writeFileSync(gh, `#!/usr/bin/env bash
if [[ "$1 $2" == "pr view" ]]; then
  printf '%s\\n' '{"state":"OPEN","url":"https://github.com/areeb/x/pull/9","mergeable":"MERGEABLE","reviewDecision":"REVIEW_REQUIRED","statusCheckRollup":[{"conclusion":"CANCELLED","name":"build","startedAt":"2026-10-15T11:34:43Z","status":"COMPLETED"},{"conclusion":"","name":"build","startedAt":"2026-10-15T11:35:24Z","status":"IN_PROGRESS"}]}'
  exit 0
fi
if [[ "$1 $2" == "api graphql" ]]; then
  printf '%s\\n' '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[]},"comments":{"nodes":[]},"reviewThreads":{"nodes":[]}}}}}'
  exit 0
fi
exit 1
`);
    chmodSync(gh, 0o755);
    const priorPath = process.env.PATH;
    process.env.PATH = `${binDir}:${priorPath ?? ""}`;
    try {
      // no required checks configured (gh pr checks exits 1): the rollup decides, and it is pending
      expect(ghPrProbe(repoDir, "https://github.com/areeb/x/pull/9")?.state).toBe("OPEN");
    } finally {
      process.env.PATH = priorPath;
    }
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
if [[ "$1 $2" == "api graphql" ]]; then
  printf '%s\\n' '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[]},"comments":{"nodes":[]},"reviewThreads":{"nodes":[]}}}}}'
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
        activity: [], // HOW-70: an empty list is "no new activity", never "forge unreachable"
        skipped: { bot: 0, howdah: 0 },
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

/**
 * HOW-70 — probe:pr reads review activity, with a stubbed gh on PATH. Every Howdah PR is opened
 * as the operator, who cannot request changes on their own PR, so `reviewDecision` here is
 * always REVIEW_REQUIRED: whatever routes CHANGES_REQUIRED below is the review activity.
 */
describe("HOW-70: probe:pr picks up review comments", () => {
  const PR = "https://github.com/areeb/x/pull/7";
  const prDef = {
    kind: "command", run: "probe:pr",
    writes: { "pr.state": { scope: "per-visit" }, "pr.review_activity": { scope: "per-visit" } },
  } as any;
  const human = { __typename: "User", login: "areeb" };
  const bot = { __typename: "Bot", login: "github-actions" };
  const nap = () => Bun.sleepSync(5);
  const iso = () => { nap(); const t = new Date().toISOString(); nap(); return t; };

  /** a gh that answers pr view with an open PR and api graphql with `activity` — or fails it */
  function fakeGh(activity: object | "unreachable"): string {
    const binDir = mkdtempSync(join(tmpdir(), "howdah-gh-"));
    const payload = join(binDir, "activity.json");
    if (activity !== "unreachable") writeFileSync(payload, JSON.stringify({ data: { repository: { pullRequest: activity } } }));
    writeFileSync(join(binDir, "gh"), `#!/usr/bin/env bash
if [[ "$1 $2" == "pr view" ]]; then
  printf '%s\\n' '{"state":"OPEN","url":"${PR}","mergeable":"MERGEABLE","reviewDecision":"REVIEW_REQUIRED","statusCheckRollup":[]}'
  exit 0
fi
if [[ "$1 $2" == "api graphql" ]]; then
  ${activity === "unreachable" ? `echo "error connecting to api.github.com" >&2; exit 1` : `cat "${payload}"; exit 0`}
fi
exit 1
`);
    chmodSync(join(binDir, "gh"), 0o755);
    return binDir;
  }
  const pr = (o: { reviews?: object[]; comments?: object[]; threads?: object[] }) => ({
    reviews: { nodes: o.reviews ?? [] }, comments: { nodes: o.comments ?? [] }, reviewThreads: { nodes: o.threads ?? [] },
  });
  const comment = (author: object, at: string, body = "please rename this") => ({ author, body, createdAt: at, url: `${PR}#c-${at}` });

  /** a run that has published: the cutoff is publish's start */
  function published(): { log: EventLog; repoDir: string; runDir: string } {
    const repoDir = repo();
    const runDir = mkdtempSync(join(tmpdir(), "howdah-pr-"));
    const log = new EventLog(join(runDir, "run.jsonl"));
    log.append({ type: "node-started", node: "delivery.publish", visit: 1, attempt_id: "delivery.publish#1" });
    return { log, repoDir, runDir };
  }

  async function probeWith(activity: object | "unreachable", log: EventLog, repoDir: string) {
    const binDir = fakeGh(activity);
    const priorPath = process.env.PATH;
    process.env.PATH = `${binDir}:${priorPath ?? ""}`;
    try {
      return await commandExecutor()(args({ def: { ...prDef, reads: ["publication_summary"] }, reads: { publication_summary: { pr_url: PR } }, log, cwd: repoDir }));
    } finally {
      process.env.PATH = priorPath;
    }
  }
  const chunks = (log: EventLog) => log.read().flatMap((e) => (e.type === "chunk" ? [e.content] : []));

  test("a review submitted COMMENTED → CHANGES_REQUIRED, and the review is handed over", async () => {
    const { log, repoDir } = published();
    const at = iso();
    const r = await probeWith(pr({ reviews: [{ author: human, state: "COMMENTED", body: "this leaks a handle", submittedAt: at, url: `${PR}#r1` }] }), log, repoDir);
    expect(r.writes["pr.state"]).toBe("CHANGES_REQUIRED");
    expect(r.writes["pr.review_activity"]).toEqual([{ pr: PR, kind: "review", author: "areeb", at, url: `${PR}#r1`, body: "this leaks a handle" }]);
    expect(chunks(log).some((c) => c.startsWith("1 new review item since"))).toBe(true);
  });

  test("an unresolved inline thread → CHANGES_REQUIRED; the same thread resolved → OPEN", async () => {
    const a = published();
    const at = iso();
    const thread = pr({ threads: [{ isResolved: false, path: "core/x.ts", line: 12, comments: { nodes: [comment(human, at, "off by one")] } }] });
    const r = await probeWith(thread, a.log, a.repoDir);
    expect(r.writes["pr.state"]).toBe("CHANGES_REQUIRED");
    expect(r.writes["pr.review_activity"]).toEqual([expect.objectContaining({ kind: "thread", path: "core/x.ts", line: 12, body: "off by one" })]);
    const b = published();
    const fresh = iso(); // after b's publish: new, but a resolved thread never counts
    const resolved = pr({ threads: [{ isResolved: true, path: "core/x.ts", line: 12, comments: { nodes: [comment(human, fresh, "off by one")] } }] });
    expect((await probeWith(resolved, b.log, b.repoDir)).writes).toEqual({ "pr.state": "OPEN", "pr.review_activity": [] });
  });

  test("a plain PR comment → CHANGES_REQUIRED", async () => {
    const { log, repoDir } = published();
    const r = await probeWith(pr({ comments: [comment(human, iso())] }), log, repoDir);
    expect(r.writes["pr.state"]).toBe("CHANGES_REQUIRED");
    expect((r.writes["pr.review_activity"] as { kind: string }[]).map((i) => i.kind)).toEqual(["comment"]);
  });

  test("the same comments again after an address_reviews visit → OPEN (the cutoff is read from the log)", async () => {
    const { log, repoDir } = published();
    const activity = pr({ comments: [comment(human, iso())], threads: [{ isResolved: false, path: "a.ts", line: 1, comments: { nodes: [comment(human, iso(), "and here")] } }] });
    expect((await probeWith(activity, log, repoDir)).writes["pr.state"]).toBe("CHANGES_REQUIRED");
    nap();
    log.append({ type: "node-started", node: "delivery.address_reviews", visit: 1, attempt_id: "delivery.address_reviews#1" });
    log.append({ type: "node-finished", node: "delivery.address_reviews", visit: 1, status: "succeeded", writes: {} });
    expect((await probeWith(activity, log, repoDir)).writes).toEqual({ "pr.state": "OPEN", "pr.review_activity": [] });
  });

  test("a comment the operator posts WHILE address_reviews runs still counts on the next probe", async () => {
    const { log, repoDir } = published();
    nap();
    log.append({ type: "node-started", node: "delivery.address_reviews", visit: 1, attempt_id: "delivery.address_reviews#1" });
    const during = iso();
    log.append({ type: "node-finished", node: "delivery.address_reviews", visit: 1, status: "succeeded", writes: {} });
    expect((await probeWith(pr({ comments: [comment(human, during, "one more thing")] }), log, repoDir)).writes["pr.state"]).toBe("CHANGES_REQUIRED");
  });

  test("the agent's own reply — the operator's login, carrying the marker — → OPEN", async () => {
    const { log, repoDir } = published();
    const reply = `Fixed in abc123.\n\n${REVIEW_REPLY_MARKER}`;
    const activity = pr({
      comments: [comment(human, iso(), reply)],
      threads: [{ isResolved: false, path: "a.ts", line: 3, comments: { nodes: [comment(human, iso(), reply)] } }],
    });
    expect((await probeWith(activity, log, repoDir)).writes).toEqual({ "pr.state": "OPEN", "pr.review_activity": [] });
    expect(chunks(log)).toContain("not counted as review activity: 2 of Howdah's own replies (core/review-activity.ts)");
  });

  test("bot rule: a bot's comment or review never routes a repair, and the skip is named", async () => {
    const { log, repoDir } = published();
    const activity = pr({
      comments: [comment(bot, iso(), "Coverage dropped 0.2%"), comment({ __typename: "User", login: "renovate[bot]" }, iso(), "Update deps")],
      reviews: [{ author: bot, state: "COMMENTED", body: "lint: 3 warnings", submittedAt: iso(), url: `${PR}#r9` }],
    });
    expect((await probeWith(activity, log, repoDir)).writes).toEqual({ "pr.state": "OPEN", "pr.review_activity": [] });
    expect(chunks(log)).toContain("not counted as review activity: 3 by a bot (core/review-activity.ts)");
  });

  test("forge unreachable on the review read THROWS ForgeUnreachableError — never \"no new activity\"", async () => {
    const { log, repoDir } = published();
    const err = await probeWith("unreachable", log, repoDir).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ForgeUnreachableError);
    expect(String(err)).toContain("forge unreachable: error connecting to api.github.com");
  });

  test("a stack: the PR with new activity decides, and every PR's items are collected in stack order", async () => {
    const { log, repoDir } = published();
    const at = iso();
    const exec = commandExecutor({
      prProbe: (_cwd, ref, since) => {
        expect(since).not.toBeNull(); // the cutoff is computed once and handed to every PR
        return ref.endsWith("/2")
          ? { state: "CHANGES_REQUIRED", url: ref, activity: [{ pr: ref, kind: "comment", author: "areeb", at, url: ref, body: "b" }] }
          : { state: "OPEN", url: ref, activity: [] };
      },
    });
    const r = await exec(args({
      def: { ...prDef, reads: ["publication_summary"] },
      reads: { publication_summary: { pr_urls: ["https://github.com/areeb/x/pull/1", "https://github.com/areeb/x/pull/2"] } },
      log, cwd: repoDir,
    }));
    expect(r.writes["pr.state"]).toBe("CHANGES_REQUIRED");
    expect((r.writes["pr.review_activity"] as { pr: string }[]).map((i) => i.pr)).toEqual(["https://github.com/areeb/x/pull/2"]);
  });

  test("pr.review_activity is dropped when the node does not declare it (the existing convention)", async () => {
    const { log, repoDir } = published();
    const exec = commandExecutor({ prProbe: () => ({ state: "OPEN", url: PR, activity: [] }) });
    const r = await exec(args({ def: { kind: "command", run: "probe:pr", writes: { "pr.state": { scope: "per-visit" } } } as any, log, cwd: repoDir }));
    expect(r.writes).toEqual({ "pr.state": "OPEN" });
  });
});
