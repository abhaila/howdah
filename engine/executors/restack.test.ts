/**
 * `git:restack` (HOW-57 S5) against a real local bare origin (decision 8A): merged (squash),
 * moved while unapproved, moved while approved (no push), a conflict (aborted, with the exact
 * --onto command), a conflict an agent then resolved by hand (and the base squash-merging after
 * it), a PR head named after the ticket, an idempotent re-run, and a teammate's push that a
 * restack must never overwrite.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../../log/write";
import type { ExecArgs } from "../run";
import { worktreeExecutor, readWorktreeRecord } from "./worktree";
import { restackBuiltinExecutor, type PrRetarget } from "./restack";
import type { PrHead, PrView } from "./await";
import { commit, git, originFixture, sha } from "./git-testkit";

const RESTACK_DEF = {
  kind: "command", run: "git:restack",
  reads: ["deps.base", "deps.base_merged", "pr.approved", "publication_summary"],
  writes: { "restack.conflict": { scope: "per-visit" }, "deps.base": { scope: "sticky" }, "deps.base_tip": { scope: "sticky" } },
} as const;

/**
 * fe-1 (a teammate's clone, `other`) has published branch `fe-1`; fe-2 (this run) stacks on it
 * in a real worktree of the operator's clone, commits its own change and pushes its branch.
 */
async function stack() {
  const fx = originFixture();
  git(fx.other, "checkout", "-q", "-b", "fe-1");
  const a = commit(fx.other, "shared.txt", "fe-1 line\n", "fe-1: shared");
  git(fx.other, "push", "-q", "origin", "fe-1");

  const runDir = mkdtempSync(join(tmpdir(), "howdah-restack-run-"));
  const log = new EventLog(join(runDir, "run.jsonl"));
  const done = new Set<string>();
  const effects = {
    claim: (e: string) => {
      if (done.has(e)) return true;
      log.append({ type: "side-effect-intent", node: "restack", visit: 1, attempt_id: "restack#1", effect: e });
      return false;
    },
    done: (e: string, result?: unknown) => {
      done.add(e);
      log.append({ type: "side-effect-done", node: "restack", visit: 1, attempt_id: "restack#1", effect: e, result });
    },
  };
  await worktreeExecutor({ reposDir: join(runDir, "repos") })({
    nodeId: "create_worktree", visit: 1, attemptId: "create_worktree#1", runId: "plan--fe-2", log, cwd: fx.clone,
    def: { kind: "worktree", action: "create", reads: ["deps.base", "deps.base_tip"] },
    reads: { "deps.base": "fe-1", "deps.base_tip": a }, effects,
  } as unknown as ExecArgs);
  const wt = readWorktreeRecord(runDir)!.path;
  const b = commit(wt, "fe2.txt", "fe-2 work\n", "fe-2: its own change");
  git(wt, "push", "-q", "origin", "howdah/plan--fe-2");

  const prs: { retargeted: Array<[string, string]>; base: string; head: string } = { retargeted: [], base: "fe-1", head: "howdah/plan--fe-2" };
  const prView: PrView = (): PrHead => ({ state: "OPEN", url: "https://github.com/acme/web/pull/2", headRefName: prs.head, headRefOid: "", baseRefName: prs.base });
  const retarget: PrRetarget = (_cwd, ref, base) => {
    prs.retargeted.push([ref, base]);
    prs.base = base;
    return null;
  };
  const restack = (reads: { merged?: boolean; approved?: boolean; base?: string }) =>
    restackBuiltinExecutor({ prView, retarget })({
      nodeId: "restack", visit: 1, attemptId: "restack#1", runId: "plan--fe-2", log, cwd: fx.clone,
      def: RESTACK_DEF,
      reads: {
        "deps.base": reads.base ?? "fe-1",
        "deps.base_merged": reads.merged ?? false,
        "pr.approved": reads.approved ?? false,
        publication_summary: { primary_pr_url: "https://github.com/acme/web/pull/2" },
      },
      effects,
    } as unknown as ExecArgs);
  // the worktree-create effect shares the handle; only the restack's own effects are counted
  const events = (type: string) => log.read().filter((e) => e.type === type && (!("effect" in e) || e.effect.startsWith("restack:")));
  const notes = () => log.read().flatMap((e) => (e.type === "chunk" && e.node === "restack" ? [e.content] : [])).join("");
  const remote = (branch = "howdah/plan--fe-2") => sha(fx.other, "HEAD") && git(fx.clone, "ls-remote", "origin", `refs/heads/${branch}`).split(/\s+/)[0]!;
  return { ...fx, wt, a, b, log, restack, events, notes, remote, prs };
}

describe("git:restack (real git, local bare origin)", () => {
  test("base MOVED and this PR unapproved → replayed onto the new tip and pushed", async () => {
    const s = await stack();
    const a2 = commit(s.other, "fe1-more.txt", "a review fix\n", "fe-1: review fix");
    git(s.other, "push", "-q", "origin", "fe-1");

    const r = await s.restack({});
    expect(r).toEqual({ status: "succeeded", writes: { "restack.conflict": "", "deps.base": "fe-1", "deps.base_tip": a2 } });
    // fe-2's own commit now sits on fe-1's new tip, and that is what origin has
    expect(git(s.wt, "rev-parse", "HEAD~1")).toBe(a2);
    expect(git(s.wt, "log", "--format=%s", `${a2}..HEAD`)).toBe("fe-2: its own change");
    expect(s.remote()).toBe(sha(s.wt, "HEAD"));
    const [e] = s.events("base-restacked") as any[];
    expect(e).toMatchObject({ from: { branch: "fe-1", sha: s.a }, to: { branch: "fe-1", sha: a2 }, head: sha(s.wt, "HEAD") });
    // the base did not change name, so the PR is not retargeted
    expect(s.prs.retargeted).toEqual([]);
  });

  test("base MOVED and this PR approved → NOT re-pushed (decision B)", async () => {
    const s = await stack();
    commit(s.other, "fe1-more.txt", "a review fix\n");
    git(s.other, "push", "-q", "origin", "fe-1");
    const before = s.remote();

    const r = await s.restack({ approved: true });
    expect(r.writes).toEqual({ "restack.conflict": "", "deps.base": "fe-1", "deps.base_tip": s.a });
    expect(s.remote()).toBe(before);
    expect(sha(s.wt, "HEAD")).toBe(s.b);
    expect(s.events("base-restacked")).toEqual([]);
    expect(s.events("side-effect-intent")).toEqual([]);
    expect(s.notes()).toContain("this PR is approved — not re-pushed");
  });

  test("base SQUASH-MERGED → replayed onto origin/main; the diff is fe-2's own commits only; the PR is retargeted", async () => {
    const s = await stack();
    // GitHub's squash merge: one new commit on main with fe-1's change; fe-1's branch deleted
    git(s.other, "checkout", "-q", "main");
    git(s.other, "pull", "-q", "origin", "main");
    git(s.other, "merge", "--squash", "fe-1");
    git(s.other, "commit", "-q", "-m", "fe-1 (#1)");
    const squashed = sha(s.other, "HEAD");
    git(s.other, "push", "-q", "origin", "main", ":fe-1");

    const r = await s.restack({ merged: true, approved: true }); // approval does not matter for a merge
    expect(r.writes).toEqual({ "restack.conflict": "", "deps.base": "", "deps.base_tip": "" });
    expect(git(s.wt, "rev-parse", "HEAD~1")).toBe(squashed);
    expect(git(s.wt, "diff", "--name-only", `${squashed}..HEAD`)).toBe("fe2.txt");
    expect(git(s.wt, "log", "--format=%s", `${squashed}..HEAD`)).toBe("fe-2: its own change");
    expect(s.remote()).toBe(sha(s.wt, "HEAD"));
    expect(s.prs.retargeted).toEqual([["https://github.com/acme/web/pull/2", "main"]]);
    expect(s.events("base-restacked")[0]).toMatchObject({ to: { branch: "main", sha: squashed }, pr: "https://github.com/acme/web/pull/2" });
  });

  test("a conflict aborts cleanly and hands over the EXACT --onto command", async () => {
    const s = await stack();
    // fe-2 edits fe-1's file; fe-1 then edits the same line
    const b2 = commit(s.wt, "shared.txt", "fe-2's version\n", "fe-2: touch shared");
    git(s.wt, "push", "-q", "origin", "howdah/plan--fe-2");
    const a2 = commit(s.other, "shared.txt", "fe-1's newer version\n", "fe-1: rewrite shared");
    git(s.other, "push", "-q", "origin", "fe-1");
    const before = s.remote();

    const r = await s.restack({});
    expect(r.writes).toEqual({ "restack.conflict": `git rebase --onto ${a2} ${s.a}`, "deps.base": "fe-1", "deps.base_tip": s.a });
    expect(sha(s.wt, "HEAD")).toBe(b2);
    expect(git(s.wt, "status", "--porcelain")).toBe("");
    expect(existsSync(join(s.wt, ".git"))).toBe(true);
    expect(git(s.wt, "rev-parse", "--git-path", "rebase-merge").length).toBeGreaterThan(0);
    expect(existsSync(join(s.wt, git(s.wt, "rev-parse", "--git-path", "rebase-merge")))).toBe(false);
    expect(s.remote()).toBe(before);
    expect(s.events("base-restacked")).toEqual([]);
    expect(s.notes()).toContain("conflicts in shared.txt");
  });

  test("…and once an agent resolved it with that command, the next restack records it without rebasing again", async () => {
    const s = await stack();
    commit(s.wt, "shared.txt", "fe-2's version\n", "fe-2: touch shared");
    git(s.wt, "push", "-q", "origin", "howdah/plan--fe-2");
    const a2 = commit(s.other, "shared.txt", "fe-1's newer version\n");
    git(s.other, "push", "-q", "origin", "fe-1");
    const conflict = (await s.restack({})).writes["restack.conflict"] as string;

    // the repair agent: run the command, resolve, continue, push
    git(s.wt, "fetch", "-q", "origin");
    try { git(s.wt, ...conflict.split(" ").slice(1)); } catch { /* the conflict */ }
    writeFileSync(join(s.wt, "shared.txt"), "both versions\n");
    git(s.wt, "add", "shared.txt");
    git(s.wt, "-c", "core.editor=true", "rebase", "--continue");
    git(s.wt, "push", "-q", "--force-with-lease", "origin", "howdah/plan--fe-2");
    const resolved = sha(s.wt, "HEAD");

    const r = await s.restack({});
    expect(r.writes).toEqual({ "restack.conflict": "", "deps.base": "fe-1", "deps.base_tip": a2 });
    expect(sha(s.wt, "HEAD")).toBe(resolved);
    expect(s.notes()).toContain("already contains fe-1");
    expect(s.events("base-restacked")[0]).toMatchObject({ from: { sha: s.a }, to: { sha: a2 }, head: resolved });
  });

  test("a conflict resolved by hand, then the base squash-merges: only this run's commits are replayed", async () => {
    const s = await stack();
    commit(s.wt, "shared.txt", "fe-2's version\n", "fe-2: touch shared");
    git(s.wt, "push", "-q", "origin", "howdah/plan--fe-2");
    const a2 = commit(s.other, "shared.txt", "fe-1's newer version\n", "fe-1: rewrite shared");
    git(s.other, "push", "-q", "origin", "fe-1");
    const r1 = await s.restack({});
    const conflict = r1.writes["restack.conflict"] as string;
    // the engine logs what the conflicted restack published; the repair agent resolves by hand
    s.log.append({ type: "node-finished", node: "restack", visit: 1, status: "succeeded", writes: r1.writes });
    git(s.wt, "fetch", "-q", "origin");
    try { git(s.wt, ...conflict.split(" ").slice(1)); } catch { /* the conflict */ }
    writeFileSync(join(s.wt, "shared.txt"), "both versions\n");
    git(s.wt, "add", "shared.txt");
    git(s.wt, "-c", "core.editor=true", "rebase", "--continue");
    git(s.wt, "push", "-q", "--force-with-lease", "origin", "howdah/plan--fe-2");

    // before the next restack, fe-1 is squash-merged and its branch deleted
    git(s.other, "checkout", "-q", "main");
    git(s.other, "pull", "-q", "origin", "main");
    git(s.other, "merge", "--squash", "fe-1");
    git(s.other, "commit", "-q", "-m", "fe-1 (#1)");
    const squashed = sha(s.other, "HEAD");
    git(s.other, "push", "-q", "origin", "main", ":fe-1");

    const r = await s.restack({ merged: true });
    expect(r.writes).toEqual({ "restack.conflict": "", "deps.base": "", "deps.base_tip": "" });
    expect(git(s.wt, "rev-parse", "HEAD~2")).toBe(squashed);
    expect(git(s.wt, "log", "--format=%s", `${squashed}..HEAD`)).toBe("fe-2: touch shared\nfe-2: its own change");
    expect(s.notes()).toContain(`resolved onto ${a2.slice(0, 12)} by hand`);
    expect(s.events("base-restacked")[0]).toMatchObject({ from: { sha: a2 }, to: { branch: "main", sha: squashed } });
  });

  test("idempotent: a second restack onto the same tip does nothing — no second event, no second push", async () => {
    const s = await stack();
    commit(s.other, "fe1-more.txt", "x\n");
    git(s.other, "push", "-q", "origin", "fe-1");
    await s.restack({});
    const head = sha(s.wt, "HEAD");
    const r = await s.restack({});
    expect(r.writes["restack.conflict"]).toBe("");
    expect(sha(s.wt, "HEAD")).toBe(head);
    expect(s.events("base-restacked")).toHaveLength(1);
    expect(s.events("side-effect-done")).toHaveLength(1);
    expect(s.notes()).toContain("already stacked on fe-1");
  });

  test("a teammate's commit on this branch is never force-pushed over — the restack parks instead", async () => {
    const s = await stack();
    git(s.other, "fetch", "-q", "origin");
    git(s.other, "checkout", "-q", "-b", "theirs", "origin/howdah/plan--fe-2");
    commit(s.other, "theirs.txt", "a teammate's fix\n");
    git(s.other, "push", "-q", "origin", "theirs:howdah/plan--fe-2");
    const theirs = s.remote();
    git(s.other, "checkout", "-q", "fe-1");
    commit(s.other, "fe1-more.txt", "x\n");
    git(s.other, "push", "-q", "origin", "fe-1");

    await expect(s.restack({})).rejects.toThrow("origin/howdah/plan--fe-2 has commits this worktree lacks");
    expect(s.remote()).toBe(theirs);
    expect(s.events("side-effect-intent")).toEqual([]);
  });

  test("a PR whose head is named after the ticket: the stale howdah/<run> copy is ignored, and the PR's branch is pushed", async () => {
    const s = await stack();
    // the publish step pushed this run's work under the ticket's name; howdah/<run> keeps an older copy
    commit(s.wt, "fe2-more.txt", "a review fix\n", "fe-2: review fix");
    git(s.wt, "push", "-q", "origin", "HEAD:refs/heads/areeb/fe-2-ticket");
    git(s.wt, "push", "-q", "--force", "origin", `${s.a}:refs/heads/howdah/plan--fe-2`);
    commit(s.other, "fe1-more.txt", "x\n");
    git(s.other, "push", "-q", "origin", "fe-1");
    s.prs.head = "areeb/fe-2-ticket";
    const stale = s.remote();

    const r = await s.restack({});
    expect(r.writes["restack.conflict"]).toBe("");
    expect(s.remote("areeb/fe-2-ticket")).toBe(sha(s.wt, "HEAD"));
    expect(s.remote()).toBe(stale);
    expect(s.notes()).toContain("restacked areeb/fe-2-ticket");
  });

  test("a push that races this one is refused by the lease: put back, recorded as not pushed, retried next probe", async () => {
    const s = await stack();
    const a2 = commit(s.other, "fe1-more.txt", "x\n");
    git(s.other, "push", "-q", "origin", "fe-1");
    // between the rebase and the push, someone moves this branch on origin
    // (worktrees share the clone's hooks)
    writeFileSync(join(s.clone, ".git", "hooks", "pre-push"), `#!/bin/sh\ngit --git-dir="${s.origin}" update-ref refs/heads/howdah/plan--fe-2 ${s.a}\n`, { mode: 0o755 });

    const r = await s.restack({});
    expect(r.writes).toEqual({ "restack.conflict": "", "deps.base": "fe-1", "deps.base_tip": s.a });
    expect(sha(s.wt, "HEAD")).toBe(s.b);
    expect(s.events("base-restacked")).toEqual([]);
    expect((s.events("side-effect-done")[0] as any).result).toMatchObject({ pushed: false });
    expect(s.notes()).toContain("push refused");
    expect(s.notes()).toContain(`onto fe-1's new tip`);
    expect(a2).not.toBe(s.a);
  });

  test("not stacked any more (deps.base is \"\") → nothing to do", async () => {
    const s = await stack();
    expect((await s.restack({ base: "" })).writes).toEqual({ "restack.conflict": "", "deps.base": "", "deps.base_tip": "" });
  });

  test("a node that does not declare its reads is refused before git is touched", async () => {
    const r = await restackBuiltinExecutor()({
      nodeId: "restack", visit: 1, def: { kind: "command", run: "git:restack", reads: ["deps.base"], writes: {} }, reads: {},
      log: new EventLog(join(mkdtempSync(join(tmpdir(), "howdah-restack-")), "run.jsonl")),
    } as unknown as ExecArgs);
    expect(r).toMatchObject({ status: "failed", reason: 'git:restack reads "deps.base_merged", which this node does not declare (it declares: deps.base)' });
  });
});
