/**
 * `runs:await` (HOW-57 S3) over hand-written dependency logs and a fake forge. Every
 * dependency state the design names is here: not started (the spawn race, G1), never launched,
 * running, parked (still waited on, G6), published, merged, package with and without a check
 * (G10), failed, aborted, closed — plus a torn final line, the primary-PR base (G7) and probe
 * mode's moved / merged.
 */
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../../log/write";
import type { RunEvent } from "../../log/events";
import type { ExecArgs } from "../run";
import { awaitBuiltinExecutor, publishedPrs, type PrHead, type PrView } from "./await";
import { worktreeRecordPath } from "./worktree-record";
import type { DepRef } from "../../core/stack";

const PARENT = "plan-1";
const REPO = "/repos/web";

function home() {
  const runsDir = mkdtempSync(join(tmpdir(), "howdah-await-"));
  /** a run's log, from events */
  const run = (id: string, events: RunEvent[], worktree?: { branch: string; base_sha?: string }) => {
    const dir = join(runsDir, id);
    mkdirSync(dir, { recursive: true });
    const log = new EventLog(join(dir, "run.jsonl"));
    for (const e of events) log.append(e);
    if (worktree) writeFileSync(worktreeRecordPath(dir), JSON.stringify({ path: `/wt/${id}`, branch: worktree.branch, repo: REPO, ...(worktree.base_sha ? { base_sha: worktree.base_sha } : {}) }));
    return log;
  };
  return { runsDir, run };
}

const started = (over: Partial<Extract<RunEvent, { type: "run-started" }>> = {}): RunEvent => ({ type: "run-started", graph: "implement-ticket", inputs: {}, pinned_prompts: {}, cwd: REPO, folder_kind: "repo", parent: PARENT, ...over });
const published = (summary: unknown): RunEvent[] => [
  { type: "node-started", node: "delivery.publish", visit: 1, attempt_id: "delivery.publish#1" },
  { type: "node-finished", node: "delivery.publish", visit: 1, status: "succeeded", writes: { publication_summary: summary } },
  { type: "edge-taken", from: "delivery.publish", to: "delivery.probe_pr" },
];
const parked: RunEvent = { type: "attention-raised", node: "implementation.plan", visit: 1, reason: "a question", code: "attempt-failed" };
const spawned = (child: string): RunEvent => ({ type: "run-spawned", node: "runs.launch", visit: 1, child, graph: "implement-ticket", slice_id: child.split("--")[1]!, workspace: "web" });

const PR1 = "https://github.com/acme/web/pull/1";
const pr = (over: Partial<PrHead> = {}): PrHead => ({ state: "OPEN", url: PR1, headRefName: "howdah/plan-1--fe-1", headRefOid: "a".repeat(40), ...over });
/** a forge with these PRs, by url or head branch */
const forge = (...prs: PrHead[]): PrView => (_cwd, ref) => prs.find((p) => p.url === ref || p.headRefName === ref) ?? null;

const dep = (slice: string, until: DepRef["until"]): DepRef => ({ slice, until, run_id: `${PARENT}--${slice}`, workspace: "web" });

const AWAIT_WRITES = { "deps.ready": { scope: "per-visit" }, "deps.waiting": { scope: "per-visit" }, "deps.base": { scope: "sticky" }, "deps.base_tip": { scope: "sticky" }, "deps.prs": { scope: "sticky" } } as const;
const PROBE_WRITES = { "deps.base_moved": { scope: "per-visit" }, "deps.base_merged": { scope: "per-visit" } } as const;

/** run the built-in as `<parent>--fe-2`, waiting on `deps` */
async function awaitAs(
  h: ReturnType<typeof home>,
  deps: DepRef[],
  opts: { prView?: PrView; packageCheckFor?: (r: string) => string | undefined; writes?: Record<string, { scope: string }>; reads?: Record<string, unknown>; self?: EventLog } = {},
) {
  const self = opts.self ?? h.run(`${PARENT}--fe-2`, [started({ graph: "implement-stacked" })]);
  const exec = awaitBuiltinExecutor({ runsDir: h.runsDir, prView: opts.prView ?? forge(), ...(opts.packageCheckFor ? { packageCheckFor: opts.packageCheckFor } : {}) });
  const writes = opts.writes ?? AWAIT_WRITES;
  const args = {
    nodeId: "deps.await", visit: 1, attemptId: "deps.await#1", runId: `${PARENT}--fe-2`, log: self,
    def: { kind: "command", run: "runs:await", reads: ["deps", ...Object.keys(opts.reads ?? {}).filter((k) => k !== "deps")], writes },
    reads: { deps: JSON.stringify(deps), ...(opts.reads ?? {}) },
    effects: { claim: () => false, done: () => {} },
  } as unknown as ExecArgs;
  const result = await exec(args);
  const notes = self.read().flatMap((e) => (e.type === "chunk" ? [e.content] : [])).join("");
  return { result, writes: result.writes, notes, self };
}

describe("runs:await — every dependency state", () => {
  test("G1: no run dir, but the parent logged run-spawned → not started yet, keep waiting", async () => {
    const h = home();
    h.run(PARENT, [started({ graph: "plan-feature", parent: undefined }), spawned(`${PARENT}--fe-1`)]);
    const { writes } = await awaitAs(h, [dep("fe-1", "published")]);
    expect(writes).toMatchObject({ "deps.ready": false, "deps.waiting": "waiting on fe-1 · published (launched, not started yet)" });
  });

  test("no run dir and no spawn record → PARK: it was never launched", async () => {
    const h = home();
    h.run(PARENT, [started({ graph: "plan-feature", parent: undefined })]);
    await expect(awaitAs(h, [dep("fe-1", "published")])).rejects.toThrow(`dependency fe-1 (run ${PARENT}--fe-1) was never launched`);
  });

  test("running, no publication → keep waiting, saying it is running", async () => {
    const h = home();
    h.run(`${PARENT}--fe-1`, [started()]);
    const { writes } = await awaitAs(h, [dep("fe-1", "published")]);
    expect(writes["deps.waiting"]).toBe("waiting on fe-1 · published (running)");
  });

  test("G6: a parked dependency is still waited on — the line says it needs you", async () => {
    const h = home();
    h.run(`${PARENT}--fe-1`, [started(), parked]);
    const { result, writes } = await awaitAs(h, [dep("fe-1", "published")]);
    expect(result.status).toBe("succeeded");
    expect(writes["deps.waiting"]).toBe("waiting on fe-1 · published (parked: needs you)");
  });

  test("published: an open PR is ready, and its head is the stack base (G7)", async () => {
    const h = home();
    h.run(`${PARENT}--fe-1`, [started(), ...published({ primary_pr_url: PR1, pr_urls: [PR1] })], { branch: "howdah/plan-1--fe-1" });
    const { writes, notes } = await awaitAs(h, [dep("fe-1", "published")], { prView: forge(pr()) });
    expect(writes).toEqual({ "deps.ready": true, "deps.waiting": "", "deps.base": "howdah/plan-1--fe-1", "deps.base_tip": "a".repeat(40), "deps.prs": [PR1] });
    expect(notes).toContain("ready: fe-1 · published (published)");
  });

  test("published while parked is still ready — it got far enough", async () => {
    const h = home();
    h.run(`${PARENT}--fe-1`, [started(), ...published({ primary_pr_url: PR1 }), parked]);
    expect((await awaitAs(h, [dep("fe-1", "published")], { prView: forge(pr()) })).writes["deps.ready"]).toBe(true);
  });

  test("G7: a dependency that published its own stack — the base is its PRIMARY PR's head, not the first", async () => {
    const h = home();
    const lower = pr({ url: "https://github.com/acme/web/pull/1", headRefName: "fe-1-part-1", headRefOid: "1".repeat(40) });
    const tip = pr({ url: "https://github.com/acme/web/pull/2", headRefName: "fe-1-part-2", headRefOid: "2".repeat(40) });
    h.run(`${PARENT}--fe-1`, [started(), ...published({ pr_urls: [lower.url, tip.url], primary_pr_url: tip.url })]);
    const { writes } = await awaitAs(h, [dep("fe-1", "published")], { prView: forge(lower, tip) });
    expect(writes).toMatchObject({ "deps.base": "fe-1-part-2", "deps.base_tip": "2".repeat(40), "deps.prs": [lower.url, tip.url] });
  });

  test("G7: a prose summary with no link is probed by the dependency's worktree branch", async () => {
    const h = home();
    h.run(`${PARENT}--fe-1`, [started(), ...published("published, see the branch")], { branch: "howdah/plan-1--fe-1" });
    // prose with no link → probed by branch; the forge knows it by branch
    const { writes } = await awaitAs(h, [dep("fe-1", "published")], { prView: forge(pr()) });
    expect(writes["deps.base"]).toBe("howdah/plan-1--fe-1");
  });

  test("merged waits for the merge; a merged PR is ready", async () => {
    const h = home();
    h.run(`${PARENT}--be-1`, [started(), ...published({ primary_pr_url: PR1 })]);
    expect((await awaitAs(h, [dep("be-1", "merged")], { prView: forge(pr()) })).writes["deps.waiting"]).toBe("waiting on be-1 · merged (running; PR open)");
    const h2 = home();
    h2.run(`${PARENT}--be-1`, [started(), ...published({ primary_pr_url: PR1 })]);
    expect((await awaitAs(h2, [dep("be-1", "merged")], { prView: forge(pr({ state: "MERGED" })) })).writes["deps.ready"]).toBe(true);
  });

  test("merged means EVERY PR of a dependency's own stack merged", async () => {
    const h = home();
    const a = pr({ url: "https://github.com/acme/web/pull/1", state: "MERGED" });
    const b = pr({ url: "https://github.com/acme/web/pull/2", state: "OPEN" });
    h.run(`${PARENT}--be-1`, [started(), ...published({ pr_urls: [a.url, b.url] })]);
    expect((await awaitAs(h, [dep("be-1", "merged")], { prView: forge(a, b) })).writes["deps.ready"]).toBe(false);
  });

  test("G10: package with no command configured behaves as merged, and says so", async () => {
    const h = home();
    h.run(`${PARENT}--be-1`, [started(), ...published({ primary_pr_url: PR1 })]);
    const { writes, notes } = await awaitAs(h, [dep("be-1", "package")], { prView: forge(pr({ state: "MERGED" })) });
    expect(writes["deps.ready"]).toBe(true);
    expect(notes).toContain("no packageCheck configured for web, so merged counts as published");
  });

  test("G10: package with a check — failing keeps waiting, passing is ready", async () => {
    const h = home();
    h.run(`${PARENT}--be-1`, [started({ cwd: tmpdir() }), ...published({ primary_pr_url: PR1 })]);
    const merged = forge(pr({ state: "MERGED" }));
    const failing = await awaitAs(h, [dep("be-1", "package")], { prView: merged, packageCheckFor: () => "exit 3" });
    expect(failing.writes).toMatchObject({ "deps.ready": false, "deps.waiting": "waiting on be-1 · package (merged; package not available yet — `exit 3` exited 3)" });
    const passing = await awaitAs(h, [dep("be-1", "package")], { prView: merged, packageCheckFor: () => "true", self: failing.self });
    expect(passing.writes["deps.ready"]).toBe(true);
  });

  test("a dependency that finished failed before publishing parks the dependent, naming it", async () => {
    const h = home();
    h.run(`${PARENT}--fe-1`, [started(), { type: "run-finished", outcome: "failed" }]);
    await expect(awaitAs(h, [dep("fe-1", "published")])).rejects.toThrow("dependency fe-1 (run plan-1--fe-1) finished failed without publishing a PR");
  });

  test("an aborted dependency whose PR never merged parks a merged-waiter", async () => {
    const h = home();
    h.run(`${PARENT}--be-1`, [started(), ...published({ primary_pr_url: PR1 }), { type: "run-finished", outcome: "aborted" }]);
    await expect(awaitAs(h, [dep("be-1", "merged")], { prView: forge(pr()) })).rejects.toThrow("finished aborted before its PR merged");
  });

  test("a PR CLOSED without merging parks, naming the PR", async () => {
    const h = home();
    h.run(`${PARENT}--be-1`, [started(), ...published({ primary_pr_url: PR1 })]);
    await expect(awaitAs(h, [dep("be-1", "published")], { prView: forge(pr({ state: "CLOSED" })) })).rejects.toThrow(`its PR ${PR1} was CLOSED without merging`);
  });

  test("a merged PR whose run then failed (worktree retained) still counts as merged", async () => {
    const h = home();
    h.run(`${PARENT}--be-1`, [started(), ...published({ primary_pr_url: PR1 }), { type: "run-finished", outcome: "failed" }]);
    expect((await awaitAs(h, [dep("be-1", "merged")], { prView: forge(pr({ state: "MERGED" })) })).writes["deps.ready"]).toBe(true);
  });

  test("a torn final line in the dependency's log is tolerated", async () => {
    const h = home();
    h.run(`${PARENT}--fe-1`, [started(), ...published({ primary_pr_url: PR1 })]);
    appendFileSync(join(h.runsDir, `${PARENT}--fe-1`, "run.jsonl"), '{"type":"node-sta');
    expect((await awaitAs(h, [dep("fe-1", "published")], { prView: forge(pr()) })).writes["deps.ready"]).toBe(true);
  });

  test("an unreachable forge keeps waiting and says so — it is not a park and not 'no PR'", async () => {
    const h = home();
    h.run(`${PARENT}--fe-1`, [started(), ...published({ primary_pr_url: PR1 })]);
    const down: PrView = () => { throw new Error("forge unreachable: offline"); };
    const { writes } = await awaitAs(h, [dep("fe-1", "published")], { prView: down });
    expect(writes["deps.waiting"]).toBe("waiting on fe-1 · published (running; forge unreachable: offline)");
  });

  test("several dependencies: ready only when all are; the line names each one still pending", async () => {
    const h = home();
    h.run(`${PARENT}--fe-1`, [started(), ...published({ primary_pr_url: PR1 })]);
    h.run(`${PARENT}--be-2`, [started(), parked]);
    const { writes } = await awaitAs(h, [dep("fe-1", "published"), dep("be-2", "package")], { prView: forge(pr()) });
    expect(writes).toMatchObject({ "deps.ready": false, "deps.waiting": "waiting on be-2 · package (parked: needs you)", "deps.base": "howdah/plan-1--fe-1" });
  });
});

describe("runs:await — refusals before anything is read", () => {
  test("a node that does not declare `deps` is refused", async () => {
    const h = home();
    const self = h.run(`${PARENT}--fe-2`, [started()]);
    const exec = awaitBuiltinExecutor({ runsDir: h.runsDir, prView: forge() });
    const r = await exec({ nodeId: "a", visit: 1, attemptId: "a#1", runId: "x", log: self, def: { kind: "command", run: "runs:await", reads: [], writes: AWAIT_WRITES }, reads: {}, effects: { claim: () => false, done: () => {} } } as unknown as ExecArgs);
    expect(r).toMatchObject({ status: "failed", reason: 'runs:await reads "deps", which this node does not declare (it declares: nothing)' });
  });

  test("mixing await and probe keys is refused", async () => {
    const h = home();
    const r = await awaitAs(h, [], { writes: { ...AWAIT_WRITES, "deps.base_moved": { scope: "per-visit" } } });
    expect(r.result.status).toBe("failed");
    expect(r.result.reason).toContain("in probe mode publishes only deps.base_moved, deps.base_merged");
  });

  test("unreadable deps fail the attempt with the reason", async () => {
    const h = home();
    const self = h.run(`${PARENT}--fe-2`, [started()]);
    const exec = awaitBuiltinExecutor({ runsDir: h.runsDir, prView: forge() });
    const r = await exec({ nodeId: "a", visit: 1, attemptId: "a#1", runId: "x", log: self, def: { kind: "command", run: "runs:await", reads: ["deps"], writes: AWAIT_WRITES }, reads: { deps: "{not json" }, effects: { claim: () => false, done: () => {} } } as unknown as ExecArgs);
    expect(r.reason).toBe('runs:await: "deps" is not JSON: {not json');
  });
});

describe("runs:await probe mode — did the base move or merge?", () => {
  const setup = (basePr: PrHead, selfEvents: RunEvent[] = []) => {
    const h = home();
    h.run(`${PARENT}--fe-1`, [started(), ...published({ primary_pr_url: PR1 })]);
    const self = h.run(`${PARENT}--fe-2`, [started({ graph: "implement-stacked" }), ...selfEvents], { branch: "howdah/plan-1--fe-2", base_sha: "a".repeat(40) });
    return { h, self, prView: forge(basePr) };
  };
  const probe = (s: ReturnType<typeof setup>, reads: Record<string, unknown> = { "deps.base": "howdah/plan-1--fe-1" }) =>
    awaitAs(s.h, [dep("fe-1", "published")], { prView: s.prView, self: s.self, writes: PROBE_WRITES, reads });

  test("unchanged: the base head is the recorded tip", async () => {
    expect((await probe(setup(pr()))).writes).toEqual({ "deps.base_moved": false, "deps.base_merged": false });
  });

  test("moved: the base head differs from the worktree's recorded base", async () => {
    const { writes, notes } = await probe(setup(pr({ headRefOid: "b".repeat(40) })));
    expect(writes).toEqual({ "deps.base_moved": true, "deps.base_merged": false });
    expect(notes).toContain(`MOVED from ${"a".repeat(12)}`);
  });

  test("the latest base-restacked is the recorded tip, not the worktree's original base", async () => {
    const restacked: RunEvent = { type: "base-restacked", node: "restack", visit: 1, from: { branch: "x", sha: "a".repeat(40) }, to: { branch: "x", sha: "b".repeat(40) }, head: "c".repeat(40) };
    expect((await probe(setup(pr({ headRefOid: "b".repeat(40) }), [restacked]))).writes["deps.base_moved"]).toBe(false);
  });

  test("merged", async () => {
    expect((await probe(setup(pr({ state: "MERGED", headRefOid: "b".repeat(40) })))).writes).toEqual({ "deps.base_moved": false, "deps.base_merged": true });
  });

  test("after the merge was restacked away (deps.base is \"\") nothing is stacked any more", async () => {
    expect((await probe(setup(pr({ state: "MERGED" })), { "deps.base": "" })).writes).toEqual({ "deps.base_moved": false, "deps.base_merged": false });
  });
});

describe("publishedPrs", () => {
  test("object form: the primary is named, else the last of the list; prose: its first link", () => {
    expect(publishedPrs({ pr_urls: ["u/pull/1", "u/pull/2"] })).toEqual({ primary: "u/pull/2", all: ["u/pull/1", "u/pull/2"] });
    expect(publishedPrs({ pr_urls: ["u/pull/1", "u/pull/2"], primary_pr_url: "u/pull/1" }).primary).toBe("u/pull/1");
    expect(publishedPrs(`see ${PR1} and https://github.com/acme/web/pull/9`)).toEqual({ primary: PR1, all: [PR1] });
    expect(publishedPrs(undefined)).toEqual({ primary: null, all: [] });
  });
});
