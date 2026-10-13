/**
 * HOW-57 S8 (decision 8A): stacked full-stack slices end to end, against REAL git — two local
 * bare "origins" (an api repo and a web repo) — with the real implement-ticket and
 * implement-stacked graphs, the real worktree / runs:await / git:restack / probe:pr executors,
 * a scripted agent that commits and pushes, and an in-memory forge standing in for GitHub.
 *
 *   be-1 (api, implement-ticket)
 *   fe-1 (web) depends on be-1 until package     → implement-stacked, waits for the package
 *   fe-2 (web) depends on fe-1 until published   → implement-stacked, stacks on fe-1's PR
 *
 * All three are "launched" together (the parent's log records each spawn). Every wait PAUSES its
 * run, so the test is the clock: it moves the world (merges, pushes, approvals) between resumes,
 * and each resume is a fresh Engine replaying the log, as `howdah up` would.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type AttemptResult, type Executor, type RunState } from "./run";
import { commandExecutor, worktreeExecutor, readWorktreeRecord, type PrState } from "./executors/worktree";
import type { PrHead, PrView } from "./executors/await";
import type { PrRetarget } from "./executors/restack";
import { EventLog, readLog } from "../log/write";
import type { LoggedEvent } from "../log/events";
import { implementTicket } from "../graphs/implement-ticket";
import { implementStacked } from "../graphs/implement-stacked";
import { childDeps } from "./executors/launch";
import { git, originFixture, sha } from "./executors/git-testkit";
import type { Graph } from "../core/graph";
import type { Slice } from "../graphs/slice-plan";

const PARENT = "plan";

/** GitHub, in memory: PRs by url, heads read from the real bare origin. */
class Forge {
  private prs: Array<{ url: string; repo: string; origin: string; head: string; base: string; state: "OPEN" | "MERGED" | "CLOSED"; approved: boolean; mergedOid?: string }> = [];
  constructor(private origins: Record<string, { origin: string; clone: string }>) {}

  private repoOf(cwd: string): string {
    const hit = Object.entries(this.origins).find(([, r]) => cwd === r.clone || cwd.startsWith(r.clone));
    if (!hit) throw new Error(`forge: no repo at ${cwd}`);
    return hit[0];
  }
  private find(cwd: string, ref: string) {
    return this.prs.find((p) => p.url === ref) ?? this.prs.find((p) => p.repo === this.repoOf(cwd) && p.head === ref && p.state === "OPEN");
  }
  private oid(p: { origin: string; head: string; mergedOid?: string }): string {
    try {
      return git(p.origin, "rev-parse", `refs/heads/${p.head}`);
    } catch {
      return p.mergedOid ?? "";
    }
  }
  upsert(cwd: string, head: string, base: string): string {
    const existing = this.find(cwd, head);
    if (existing) return existing.url;
    const repo = this.repoOf(cwd);
    const url = `https://github.com/acme/${repo}/pull/${this.prs.length + 1}`;
    this.prs.push({ url, repo, origin: this.origins[repo]!.origin, head, base, state: "OPEN", approved: false });
    return url;
  }
  pr(url: string) {
    const p = this.prs.find((x) => x.url === url);
    if (!p) throw new Error(`forge: no PR ${url}`);
    return p;
  }
  merge(url: string): void {
    const p = this.pr(url);
    p.mergedOid = this.oid(p);
    p.state = "MERGED";
  }
  view: PrView = (cwd, ref): PrHead | null => {
    const p = this.find(cwd, ref);
    return p ? { state: p.state, url: p.url, headRefName: p.head, headRefOid: this.oid(p), baseRefName: p.base, approved: p.approved } : null;
  };
  probe = (cwd: string, ref: string): { state: PrState; url: string; approved?: boolean } | null => {
    const p = this.find(cwd, ref);
    return p ? { state: p.state, url: p.url, approved: p.approved } : null;
  };
  retarget: PrRetarget = (_cwd, ref, base) => {
    this.pr(ref).base = base;
    return null;
  };
}

/** The agent, scripted: it commits one file per build and pushes + opens a PR on publish. */
function scriptedAgent(forge: Forge, prompts: Map<string, string[]>): Executor {
  return async ({ nodeId, def, log, runId, reads, renderedPrompt }): Promise<AttemptResult> => {
    if (def.kind !== "agent") throw new Error("not an agent");
    prompts.set(`${runId}:${nodeId}`, [...(prompts.get(`${runId}:${nodeId}`) ?? []), renderedPrompt ?? ""]);
    const wt = readWorktreeRecord(join(log.path, ".."));
    const slice = runId.split("--")[1]!;
    const writes: Record<string, unknown> = {};
    for (const key of Object.keys(def.writes ?? {})) {
      if (key === "implementation_plan") writes[key] = `plan for ${slice}`;
      else if (key === "acceptance") writes[key] = [];
      else if (key === "implementation_summary") {
        writeFileSync(join(wt!.path, `${slice}.txt`), `${slice}'s change\n`);
        git(wt!.path, "add", "-A");
        git(wt!.path, "commit", "-q", "-m", `${slice}: build`);
        writes[key] = "built";
      } else if (key === "review_verdict") writes[key] = "pass";
      else if (key === "review_findings") writes[key] = [];
      else if (key === "publication_summary") {
        git(wt!.path, "push", "-q", "-f", "origin", `HEAD:refs/heads/${wt!.branch}`);
        const base = typeof reads["deps.base"] === "string" && reads["deps.base"] ? (reads["deps.base"] as string) : "main";
        const url = forge.upsert(wt!.repo, wt!.branch, base);
        writes[key] = { pr_urls: [url], primary_pr_url: url };
      } else writes[key] = `${key} done`;
    }
    return { status: "succeeded", writes };
  };
}

function world() {
  const home = mkdtempSync(join(tmpdir(), "howdah-stacked-e2e-"));
  const runsDir = join(home, "runs");
  const api = originFixture();
  const web = originFixture();
  const forge = new Forge({ api: { origin: api.origin, clone: api.clone }, web: { origin: web.origin, clone: web.clone } });
  const prompts = new Map<string, string[]>();
  const marker = join(home, "api-client-published");

  // the parent: it launched all three at once and finished — it never supervises them
  const parentLog = new EventLog(join(runsDir, PARENT, "run.jsonl"));
  parentLog.append({ type: "run-started", graph: "plan-feature", inputs: {}, pinned_prompts: {}, cwd: api.clone, folder_kind: "repo" });
  const slices: Array<Slice & { graph: Graph<any>; cwd: string; ws: string }> = [
    { id: "be-1", title: "be", goal: "g", work: "w", verify: "v", depends_on: [], graph: implementTicket, cwd: api.clone, ws: "api" },
    { id: "fe-1", title: "fe", goal: "g", work: "w", verify: "v", depends_on: [{ slice: "be-1", until: "package" }], graph: implementStacked, cwd: web.clone, ws: "web" },
    { id: "fe-2", title: "fe", goal: "g", work: "w", verify: "v", depends_on: [{ slice: "fe-1", until: "published" }], graph: implementStacked, cwd: web.clone, ws: "web" },
  ];
  for (const s of slices)
    parentLog.append({ type: "run-spawned", node: "runs.launch", visit: 1, child: `${PARENT}--${s.id}`, graph: s.graph.def.name, slice_id: s.id, workspace: s.ws });
  parentLog.append({ type: "run-finished", outcome: "success" });

  const command = commandExecutor({
    prProbe: forge.probe,
    await: { runsDir, prView: forge.view, packageCheckFor: (repo) => (repo === api.clone ? `test -f '${marker}'` : undefined) },
    restack: { prView: forge.view, retarget: forge.retarget },
  });
  const worktree = worktreeExecutor({ reposDir: join(home, "repos") });
  const agent = scriptedAgent(forge, prompts);

  /** start (first time) or resume a child; it runs until its next wait, then pauses */
  const step = async (id: string): Promise<RunState> => {
    const s = slices.find((x) => x.id === id)!;
    const dir = join(runsDir, `${PARENT}--${id}`);
    let waited = false;
    const engine = new Engine(s.graph, {
      dir, cwd: s.cwd, folderKind: "repo", parent: PARENT,
      executors: {
        agent, command, worktree,
        wait: async () => {
          waited = true;
          return { status: "succeeded", writes: {} };
        },
      },
      control: () => (waited ? "pause" : null),
    });
    if (existsSync(join(dir, "run.jsonl"))) return engine.resume();
    const inputs: Record<string, unknown> = { goal: s.goal, work: s.work };
    if (s.depends_on.length) inputs.deps = childDeps(s, PARENT, (sid) => slices.find((x) => x.id === sid)!.ws);
    return engine.start(inputs);
  };

  const events = (id: string): LoggedEvent[] => readLog(join(runsDir, `${PARENT}--${id}`, "run.jsonl"));
  /** the latest value a run published for `key` */
  const latest = (id: string, key: string): unknown => {
    const e = events(id).findLast((x) => x.type === "node-finished" && key in x.writes);
    return e?.type === "node-finished" ? e.writes[key] : undefined;
  };
  const record = (id: string) => readWorktreeRecord(join(runsDir, `${PARENT}--${id}`))!;
  const prOf = (id: string) => (latest(id, "publication_summary") as { primary_pr_url: string }).primary_pr_url;
  return { api, web, forge, prompts, marker, step, events, latest, record, prOf };
}

describe("HOW-57 E2E: one plan, a BE and an FE stack, merged one by one (real git)", () => {
  test("waits, stacks, restacks on a move, leaves an approved PR alone, and restacks onto main after a squash merge", async () => {
    const w = world();

    // ---- all three launched together: the FE slices wait, the BE slice builds -------------
    expect(await w.step("fe-1")).toMatchObject({ state: "paused", node: "deps.await" });
    expect(w.latest("fe-1", "deps.waiting")).toBe("waiting on be-1 · package (launched, not started yet)");
    expect(await w.step("fe-2")).toMatchObject({ state: "paused", node: "deps.await" });
    expect(w.latest("fe-2", "deps.waiting")).toBe("waiting on fe-1 · published (paused)");

    expect(await w.step("be-1")).toMatchObject({ state: "paused", node: "delivery.probe_pr" });
    const be1 = w.prOf("be-1");
    expect(w.forge.pr(be1)).toMatchObject({ base: "main", state: "OPEN" });

    // ---- be-1 merged, but its package is not out yet: fe-1 keeps waiting ------------------
    w.forge.merge(be1);
    expect(await w.step("fe-1")).toMatchObject({ state: "paused", node: "deps.await" });
    expect(w.latest("fe-1", "deps.waiting")).toMatch(/^waiting on be-1 · package \(merged; package not available yet — `test -f .*` exited 1\)$/);
    expect(w.events("fe-1").some((e) => e.type === "node-started" && e.node === "create_worktree")).toBe(false);

    // ---- the package is published: fe-1 builds from origin/main and publishes --------------
    writeFileSync(w.marker, "1.0.0\n");
    expect(await w.step("fe-1")).toMatchObject({ state: "paused", node: "deps.probe" });
    const fe1 = w.prOf("fe-1");
    expect(w.record("fe-1")).toMatchObject({ base: "origin/main", base_sha: sha(w.web.origin, "main") });
    expect(w.forge.pr(fe1)).toMatchObject({ head: "howdah/plan--fe-1", base: "main" });
    // fe-1 depends on nothing published, so it is not stacked and is never briefed as stacked
    expect(w.prompts.get("plan--fe-1:implementation.plan")![0]).not.toContain("Stacked change");

    // ---- fe-2 branches from fe-1's PR head, and its PR targets fe-1's branch ---------------
    expect(await w.step("fe-2")).toMatchObject({ state: "paused", node: "deps.probe" });
    const fe1Tip = sha(w.web.origin, "howdah/plan--fe-1");
    expect(w.record("fe-2")).toMatchObject({ base: "howdah/plan--fe-1", base_sha: fe1Tip });
    expect(git(w.record("fe-2").path, "rev-parse", "HEAD~1")).toBe(fe1Tip);
    const fe2 = w.prOf("fe-2");
    expect(w.forge.pr(fe2)).toMatchObject({ head: "howdah/plan--fe-2", base: "howdah/plan--fe-1" });
    expect(w.latest("fe-2", "deps.prs")).toEqual([fe1]);
    // every agent step was told its range, and probe:pr watches fe-2's own PR, not fe-1's
    for (const node of ["implementation.plan", "implementation.implement", "implementation.local_review", "delivery.publish"])
      expect(w.prompts.get(`plan--fe-2:${node}`)![0], node).toContain(`This change is stacked on howdah/plan--fe-1@${fe1Tip.slice(0, 12)}`);
    expect(w.events("fe-2").findLast((e) => e.type === "reconciled")).toMatchObject({ forge: { url: fe2 } });

    // ---- a review fix on UNAPPROVED fe-1 moves the base: fe-2 is restacked onto it ---------
    const fix = commitOn(w.record("fe-1").path, "fe-1-fix.txt", "review fix\n", "howdah/plan--fe-1");
    expect(await w.step("fe-2")).toMatchObject({ state: "paused", node: "deps.probe" });
    expect(w.latest("fe-2", "deps.restack")).toBe(true);
    const restacked = w.events("fe-2").filter((e) => e.type === "base-restacked");
    expect(restacked).toHaveLength(1);
    expect(restacked[0]).toMatchObject({ from: { branch: "howdah/plan--fe-1", sha: fe1Tip }, to: { branch: "howdah/plan--fe-1", sha: fix } });
    expect(git(w.web.origin, "rev-parse", "howdah/plan--fe-2~1")).toBe(fix);
    expect(w.latest("fe-2", "deps.base_tip")).toBe(fix);

    // ---- fe-2 APPROVED, and fe-1 moves again: fe-2 is NOT re-pushed (decision B) -----------
    w.forge.pr(fe2).approved = true;
    const pushedBefore = sha(w.web.origin, "howdah/plan--fe-2");
    commitOn(w.record("fe-1").path, "fe-1-more.txt", "more\n", "howdah/plan--fe-1");
    expect(await w.step("fe-2")).toMatchObject({ state: "paused", node: "deps.probe" });
    expect(w.latest("fe-2", "deps.base_moved")).toBe(true);
    expect(w.latest("fe-2", "deps.restack")).toBe(false);
    expect(sha(w.web.origin, "howdah/plan--fe-2")).toBe(pushedBefore);
    expect(w.events("fe-2").filter((e) => e.type === "base-restacked")).toHaveLength(1);

    // ---- fe-1 SQUASH-merged: fe-2 is replayed onto main; its diff is fe-2's alone ----------
    const squashed = squashMerge(w.web.other, "howdah/plan--fe-1", "fe-1 (#1)");
    w.forge.merge(fe1);
    git(w.web.other, "push", "-q", "origin", ":howdah/plan--fe-1");
    expect(await w.step("fe-2")).toMatchObject({ state: "paused", node: "deps.probe" });
    const onMain = w.events("fe-2").filter((e) => e.type === "base-restacked").at(-1);
    expect(onMain).toMatchObject({ to: { branch: "main", sha: squashed }, pr: fe2 });
    expect(git(w.web.origin, "rev-parse", "howdah/plan--fe-2~1")).toBe(squashed);
    expect(git(w.web.origin, "diff", "--name-only", `${squashed}..howdah/plan--fe-2`)).toBe("fe-2.txt");
    expect(w.forge.pr(fe2).base).toBe("main");
    expect(w.latest("fe-2", "deps.base")).toBe("");

    // ---- fe-2 merges; probe:pr watched fe-2's own PR all along, so the run completes -------
    w.forge.merge(fe2);
    expect(await w.step("fe-2")).toEqual({ state: "finished", outcome: "success" });
  }, 120_000);
});

/** commit a file on `branch` in a checkout and push it — a teammate's (or a repair's) push */
function commitOn(cwd: string, file: string, content: string, branch: string): string {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", `fix: ${file}`);
  git(cwd, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  return sha(cwd, "HEAD");
}

/** GitHub's squash merge of `branch` into main, done in a teammate's clone; returns the new main */
function squashMerge(other: string, branch: string, message: string): string {
  git(other, "fetch", "-q", "origin");
  git(other, "checkout", "-q", "main");
  git(other, "reset", "-q", "--hard", "origin/main");
  git(other, "merge", "--squash", `origin/${branch}`);
  git(other, "commit", "-q", "-m", message);
  git(other, "push", "-q", "origin", "main");
  return sha(other, "HEAD");
}
