import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, readLog } from "../log/write";
import type { LoggedEvent, RunEvent } from "../log/events";
import { defineGraph } from "../core/graph";
import {
  currentProposal,
  decisionAnswers,
  findDecision,
  isApproved,
  pendingRedesigns,
  readBase,
  roundComments,
  asksOfRound,
} from "./slice-decision";
import { replayState } from "./replay";
import {
  afterDecision,
  approve,
  claimRunner,
  releaseRunner,
  pinComment,
  redesign,
  sendFeedback,
  supervisorShouldResume,
  wakeRunner,
  writeControl,
} from "./control";
import { AttentionCenter } from "./attention";
import { processStart } from "../log/lockfile";
import { consumeAndRedraw, proposeRound, seedAwaitingRun } from "./slice-decision.fixtures";

/** a fresh run dir parked awaiting a decision on one round */
function awaitingRun(opts: Parameters<typeof seedAwaitingRun>[2] = {}) {
  return seedAwaitingRun(mkdtempSync(join(tmpdir(), "howdah-decide-")), "run", opts);
}
const propose = proposeRound;

const count = (events: LoggedEvent[], type: RunEvent["type"]) => events.filter((e) => e.type === type).length;

describe("slice-decision queries (D7/6A)", () => {
  test("currentProposal is the latest round, per approval node when asked", () => {
    const { log, round } = awaitingRun();
    const r2 = consumeAndRedraw(log, { ghosts: ["v2"] });
    const events = log.read();
    expect(currentProposal(events)?.proposal_id).toBe(r2.proposal_id);
    expect(currentProposal(events, "approve")?.proposal_id).toBe(r2.proposal_id);
    expect(currentProposal(events, "other")).toBeNull();
    expect(r2.proposal_id).toBeGreaterThan(round.proposal_id);
  });

  test("findDecision returns the FIRST decision of a round, and only that round's", () => {
    const { log, round } = awaitingRun();
    log.append({ type: "slice-approved", proposal_id: round.proposal_id, proposal_hash: round.proposal_hash, manifest_hash: "m1" });
    // a later event for the same round (never written by the routes) does not change the answer
    log.append({ type: "slice-feedback-sent", proposal_id: round.proposal_id, proposal_hash: round.proposal_hash, manifest_hash: "m1", comment_ids: [] });
    expect(findDecision(log.read(), round.proposal_id)?.type).toBe("slice-approved");
    expect(findDecision(log.read(), round.proposal_id + 999)).toBeNull();
  });

  test("isApproved binds the round, the proposal bytes and the manifest", () => {
    const proposal = { ghosts: [{ id: "a", op: "add" }] };
    const { log, round } = awaitingRun({ proposal });
    expect(isApproved(log.read(), proposal, "m1")).toBe(false); // undecided
    log.append({ type: "slice-approved", proposal_id: round.proposal_id, proposal_hash: round.proposal_hash, manifest_hash: "m1" });
    const events = log.read();
    expect(isApproved(events, { ghosts: [{ op: "add", id: "a" }] }, "m1")).toBe(true); // key order is irrelevant
    expect(isApproved(events, { ghosts: [] }, "m1")).toBe(false); // different proposal
    expect(isApproved(events, proposal, "m2")).toBe(false); // different base
    expect(isApproved(events, proposal, "m1", "elsewhere")).toBe(false);
    consumeAndRedraw(log, proposal); // an identical redraw is a new, undecided round
    expect(isApproved(log.read(), proposal, "m1")).toBe(false);
  });

  test("feedback is not approval", () => {
    const { log, round } = awaitingRun();
    log.append({ type: "slice-feedback-sent", proposal_id: round.proposal_id, proposal_hash: round.proposal_hash, manifest_hash: "m1", comment_ids: [] });
    expect(isApproved(log.read(), { ghosts: ["v1"] }, "m1")).toBe(false);
  });

  test("pendingRedesigns: per approval node, consumed only by that approval's seeder publishing the key", () => {
    const { log } = awaitingRun();
    const pending = () => pendingRedesigns(log.read(), "approve", "extract", "feedback");
    log.append({ type: "slice-redesign-requested", approval: "approve", message: "one" });
    log.append({ type: "slice-redesign-requested", approval: "other-approval", message: "not mine" });
    log.append({ type: "slice-redesign-requested", approval: "approve", message: "two" });
    expect(pending()).toEqual([
      { source: "redesign", text: "one" },
      { source: "redesign", text: "two" },
    ]);
    expect(pendingRedesigns(log.read(), "other-approval", "extract2", "feedback2")).toEqual([{ source: "redesign", text: "not mine" }]);
    log.append({ type: "node-finished", node: "extract", visit: 2, status: "failed", writes: {} });
    log.append({ type: "node-finished", node: "other", visit: 1, status: "succeeded", writes: { unrelated: 1 } });
    // the APPROVAL node publishing the key (e.g. finishing stale) never swallows a request
    log.append({ type: "node-finished", node: "approve", visit: 1, status: "succeeded", writes: { decision: {}, feedback: [] } });
    expect(pending()).toHaveLength(2);
    log.append({ type: "node-finished", node: "extract", visit: 2, status: "succeeded", writes: { feedback: [] } });
    expect(pending()).toEqual([]);
  });

  test("readBase accepts the snapshot shape and refuses anything else loudly — including no fingerprint", () => {
    const fp = { head: "h", tracked: "t", untracked: "u" };
    expect(readBase({ manifest_hash: "m", fingerprint: fp, commit: "c" }, "b")).toEqual({ manifest_hash: "m", fingerprint: fp, commit: "c" });
    expect(readBase({ fingerprint: fp }, "b")).toEqual({ manifest_hash: null, fingerprint: fp, commit: null });
    expect(() => readBase({ manifest_hash: "m", fingerprint: null }, "b")).toThrow("has no fingerprint — an approval needs a git work tree");
    expect(() => readBase("nope", "b")).toThrow('base "b" is not an object');
    expect(() => readBase({ manifest_hash: 3 }, "b")).toThrow("manifest_hash must be a string or null");
    expect(() => readBase({ fingerprint: "abc" }, "b")).toThrow("fingerprint must be a fingerprint");
  });
});

describe("decisions (D5/4A, D15)", () => {
  test("double approve: the second is an idempotent success, one event, one resolution", () => {
    const { dir, round, events } = awaitingRun();
    expect(approve(dir)).toEqual({ ok: true, proposal_id: round.proposal_id, idempotent: false, asks: [{ node: "approve", visit: 1 }] });
    expect(approve(dir)).toEqual({ ok: true, proposal_id: round.proposal_id, idempotent: true, asks: [{ node: "approve", visit: 1 }] });
    expect(count(events(), "slice-approved")).toBe(1);
    const resolved = events().filter((e) => e.type === "attention-resolved");
    expect(resolved).toEqual([expect.objectContaining({ node: "approve", visit: 1, reply: "approved", source: "operator" })]);
    expect(events().find((e) => e.type === "slice-approved")).toMatchObject({
      proposal_id: round.proposal_id,
      proposal_hash: round.proposal_hash,
      manifest_hash: "m1",
    });
  });

  test("approve then feedback is refused naming when it was approved; and the reverse", () => {
    const a = awaitingRun();
    approve(a.dir);
    pinComment(a.dir, "e", "late comment"); // refused too: the round is decided
    const r = sendFeedback(a.dir);
    expect(r).toMatchObject({ ok: false, code: "already-decided" });
    expect(!r.ok && r.message).toMatch(/^proposal #\d+ was already approved at \d\d:\d\d$/);
    expect(count(a.events(), "slice-feedback-sent")).toBe(0);
    expect(count(a.events(), "comment-pinned")).toBe(0);

    const b = awaitingRun();
    pinComment(b.dir, "e", "change it");
    expect(sendFeedback(b.dir)).toMatchObject({ ok: true });
    const r2 = approve(b.dir);
    expect(!r2.ok && r2.message).toMatch(/already sent feedback at \d\d:\d\d$/);
    expect(count(b.events(), "slice-approved")).toBe(0);
  });

  test("comments pin to the current round; feedback carries them in order; none → refused", () => {
    const { dir, round, events } = awaitingRun();
    expect(sendFeedback(dir)).toMatchObject({ ok: false, code: "no-comments" });
    const c1 = pinComment(dir, "route:/a", "first");
    const c2 = pinComment(dir, "block:b", "second", { proposalId: round.proposal_id });
    expect(c1).toMatchObject({ ok: true, proposal_id: round.proposal_id, comment_id: expect.stringMatching(/^c\d+$/) });
    // a comment's id is its own event's seq
    const pinned = roundComments(events(), round.proposal_id);
    expect(pinned.map((c) => c.id)).toEqual(pinned.map((c) => `c${c.seq}`));
    expect(sendFeedback(dir)).toMatchObject({ ok: true });
    const sent = events().find((e) => e.type === "slice-feedback-sent");
    expect(sent).toMatchObject({ comment_ids: [c1.ok && c1.comment_id, c2.ok && c2.comment_id] });
    expect(pinComment(dir, "", "x")).toMatchObject({ ok: false, code: "bad-request" });
    expect(pinComment(dir, "e", "  ")).toMatchObject({ ok: false, code: "bad-request" });
  });

  test("a decision for an old round is refused as superseded; an unknown id says so", () => {
    const { dir, log, round } = awaitingRun();
    const r2 = consumeAndRedraw(log, { ghosts: ["v1"] }); // identical redraw
    const old = approve(dir, { proposalId: round.proposal_id });
    expect(old).toMatchObject({ ok: false, code: "superseded" });
    expect(!old.ok && old.message).toContain(`proposal #${round.proposal_id} was superseded by #${r2.proposal_id}`);
    const unknown = sendFeedback(dir, { proposalId: 424242 });
    expect(!unknown.ok && unknown.message).toContain("is not a proposal of run");
    expect(pinComment(dir, "e", "x", { proposalId: round.proposal_id })).toMatchObject({ ok: false, code: "superseded" });
    expect(approve(dir, { proposalId: r2.proposal_id })).toMatchObject({ ok: true, proposal_id: r2.proposal_id });
  });

  test("refused when nothing awaits: not at the approval node, no proposal, finished, unknown run", () => {
    const moved = awaitingRun();
    moved.log.append({ type: "operator-jump", to: "implement", reset_budgets: true });
    expect(approve(moved.dir)).toMatchObject({ ok: false, code: "not-awaiting" });

    const bare = mkdtempSync(join(tmpdir(), "howdah-decide-"));
    new EventLog(join(bare, "run.jsonl")).append({ type: "run-started", graph: "g", inputs: {}, pinned_prompts: {} });
    expect(approve(bare)).toMatchObject({ ok: false, code: "no-proposal" });

    const done = awaitingRun();
    done.log.append({ type: "run-finished", outcome: "aborted" });
    expect(approve(done.dir)).toMatchObject({ ok: false, code: "finished" });

    expect(approve(join(tmpdir(), "howdah-no-such-run"))).toMatchObject({ ok: false, code: "unknown-run" });
  });

  test("a decision while the runner has not parked yet: appended, nothing to resolve, still answers the later park", () => {
    const { log } = awaitingRun();
    // the same run, copied up to the moment before the park: in the approval node, runner live, mid-check
    const d2 = mkdtempSync(join(tmpdir(), "howdah-decide-"));
    const l2 = new EventLog(join(d2, "run.jsonl"));
    for (const e of log.read().filter((e) => e.type !== "attention-raised")) {
      const { seq: _s, ts: _t, ...rest } = e;
      l2.append(rest as RunEvent);
    }
    expect(approve(d2)).toMatchObject({ ok: true, asks: [] });
    // the runner then parks (it checked just before the decision) — D17 still counts it answered
    l2.append({ type: "attention-raised", node: "approve", visit: 1, reason: "awaiting", code: "awaiting-approval" });
    expect(replayState(l2.read()).parked).toBeNull();
  });
});

describe("D17: the decision alone resolves the park", () => {
  test("crash between append and resolve: replay sees no park, and `up` would resume", () => {
    const { log, round } = awaitingRun();
    expect(replayState(log.read()).parked).toMatchObject({ code: "awaiting-approval" });
    expect(supervisorShouldResume(replayState(log.read()), null)).toBe(false);
    // the route appended the decision and died before resolving the attention
    log.append({ type: "slice-approved", proposal_id: round.proposal_id, proposal_hash: round.proposal_hash, manifest_hash: "m1" });
    const replayed = replayState(log.read());
    expect(replayed.parked).toBeNull();
    expect(replayed.answeredPark).toMatchObject({ node: "approve", code: "awaiting-approval" });
    expect(replayed.position).toEqual({ node: "approve", midFlight: true }); // same visit re-attempted
    expect(supervisorShouldResume(replayed, null)).toBe(true);
    // the operator still owns a paused or controlled run
    expect(supervisorShouldResume(replayed, "pause")).toBe(false);
    log.append({ type: "run-paused", by: "operator" });
    expect(supervisorShouldResume(replayState(log.read()), null)).toBe(false);
  });

  test("a decision on an OLD round does not answer the current round's park", () => {
    const { log, round } = awaitingRun();
    consumeAndRedraw(log, { v: 2 });
    log.append({ type: "slice-approved", proposal_id: round.proposal_id, proposal_hash: round.proposal_hash, manifest_hash: "m1" });
    expect(replayState(log.read()).parked).toMatchObject({ code: "awaiting-approval" });
  });

  test("only awaiting-approval parks are decision-resolved", () => {
    const { log, round } = awaitingRun();
    log.append({ type: "slice-approved", proposal_id: round.proposal_id, proposal_hash: round.proposal_hash, manifest_hash: "m1" });
    log.append({ type: "attention-raised", node: "approve", visit: 1, reason: "boom", code: "executor-threw" });
    expect(replayState(log.read()).parked).toMatchObject({ code: "executor-threw" });
    expect(decisionAnswers(log.read(), { node: "approve", code: "executor-threw" })).toBe(false);
  });

  test("the `up` supervisor tick resumes a decided-but-unresolved run", async () => {
    const home = mkdtempSync(join(tmpdir(), "howdah-up-"));
    const runDir = join(home, "runs", "decided");
    mkdirSync(runDir, { recursive: true });
    const log = new EventLog(join(runDir, "run.jsonl"));
    log.append({ type: "run-started", graph: "not-registered", inputs: {}, pinned_prompts: {} });
    const round = propose(log, { v: 1 });
    log.append({ type: "slice-approved", proposal_id: round.proposal_id, proposal_hash: round.proposal_hash, manifest_hash: "m1" });
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "cli", "main.ts"), "up", "--once"], {
      env: { ...process.env, HOWDAH_HOME: home, HOWDAH_STUB: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(new TextDecoder().decode(r.stdout)).toContain("resuming dead run decided");
  });
});

describe("waking the runner (D17 grace re-check)", () => {
  function decidedRun() {
    const run = awaitingRun();
    approve(run.dir);
    return run;
  }
  const spawner = () => {
    const calls: number[] = [];
    return { calls, spawn: () => void calls.push(Date.now()) };
  };

  test("dead runner + a run that needs one → spawned at once", async () => {
    const { dir } = decidedRun();
    const s = spawner();
    expect(await wakeRunner(dir, s.spawn)).toBe("spawned");
    expect(s.calls).toHaveLength(1);
  });

  test("dead runner but the run still parked on something else → idle, nothing spawned", async () => {
    const { dir } = awaitingRun(); // undecided
    const s = spawner();
    expect(await wakeRunner(dir, s.spawn)).toBe("idle");
    expect(s.calls).toHaveLength(0);
  });

  /** a fake runner: alive for `polls` liveness checks, on a clock that only moves when waited on */
  function scripted(alivePolls: number) {
    let t = 0;
    let checks = 0;
    return {
      alive: () => checks++ < alivePolls,
      sleep: async (ms: number) => void (t += ms),
      now: () => t,
      get checks() {
        return checks;
      },
    };
  }

  test("a runner exiting within the grace without consuming the decision → resumed", async () => {
    const { dir } = decidedRun();
    const s = spawner();
    const runner = scripted(3); // alive at the first check and two polls, then gone
    expect(await wakeRunner(dir, s.spawn, { graceMs: 1000, pollMs: 100, ...runner })).toBe("spawned");
    expect(s.calls).toHaveLength(1);
  });

  test("a runner alive past the grace owns the run → no second runner", async () => {
    const { dir } = decidedRun();
    const s = spawner();
    const runner = scripted(Infinity);
    expect(await wakeRunner(dir, s.spawn, { graceMs: 1000, pollMs: 100, ...runner })).toBe("live");
    expect(s.calls).toHaveLength(0);
    expect(runner.checks).toBe(11); // the first check + one per poll until the grace ran out
  });

  test("the real liveness probe: a genuine runner identity counts as alive, a dead one does not", async () => {
    const { dir } = decidedRun();
    const runner = Bun.spawn(["sleep", "30"]);
    try {
      writeFileSync(join(dir, "runner.pid"), `${runner.pid} ${processStart(runner.pid)}`);
      const s = spawner();
      expect(await wakeRunner(dir, s.spawn, { graceMs: 0 })).toBe("live");
      expect(s.calls).toHaveLength(0);
    } finally {
      runner.kill(9);
      await runner.exited;
    }
    const s = spawner();
    expect(await wakeRunner(dir, s.spawn, { graceMs: 0 })).toBe("spawned");
    expect(s.calls).toHaveLength(1);
  });

  test("a paused run is never woken by a decision", async () => {
    const { dir } = decidedRun();
    writeControl(dir, "pause");
    const s = spawner();
    expect(await wakeRunner(dir, s.spawn)).toBe("idle");
    expect(s.calls).toHaveLength(0);
  });

  test("afterDecision clears the attention records of every answered ask, after waking", async () => {
    const { dir } = awaitingRun();
    const attentionDir = mkdtempSync(join(tmpdir(), "howdah-attn-"));
    const run = dir.split("/").at(-1)!;
    const center = new AttentionCenter(attentionDir, []);
    await center.raise({ run, node: "approve", visit: 1, reason: "awaiting" }).catch(() => {});
    expect(center.pending()).toHaveLength(1);
    const r = approve(dir);
    if (!r.ok) throw new Error(r.message);
    const s = spawner();
    expect(await afterDecision(dir, r, { attentionDir, spawn: s.spawn })).toBe("spawned");
    expect(center.pending()).toHaveLength(0);
  });
});

describe("review fixes: waking and clearing (items 2, 5)", () => {
  test("double approve + afterDecision for both: ONE wake (the repeat is idempotent)", async () => {
    const { dir } = awaitingRun();
    let spawns = 0;
    const deps = { attentionDir: mkdtempSync(join(tmpdir(), "howdah-attn-")), spawn: () => void spawns++ };
    const a = approve(dir);
    const b = approve(dir);
    if (!a.ok || !b.ok) throw new Error("both approvals should be accepted");
    expect([a.idempotent, b.idempotent]).toEqual([false, true]);
    const woke = await Promise.all([afterDecision(dir, a, deps), afterDecision(dir, b, deps)]);
    expect(woke).toEqual(["spawned", "already-woken"]);
    expect(spawns).toBe(1);
  });

  test("afterDecision clears only the DECIDED round's asks — a newer round's ask keeps ringing", async () => {
    const { dir, log } = awaitingRun();
    pinComment(dir, "e", "c");
    const decided = sendFeedback(dir);
    if (!decided.ok) throw new Error(decided.message);
    consumeAndRedraw(log, { v: 2 }); // round 2 parks on approve visit 2
    const attentionDir = mkdtempSync(join(tmpdir(), "howdah-attn-"));
    const center = new AttentionCenter(attentionDir, []);
    await center.raise({ run: "run", node: "approve", visit: 1, reason: "round 1" }).catch(() => {});
    await center.raise({ run: "run", node: "approve", visit: 2, reason: "round 2" }).catch(() => {});
    await afterDecision(dir, decided, { attentionDir, spawn: () => {} });
    expect(center.pending().map((p) => p.visit)).toEqual([2]);
    expect(asksOfRound(log.read(), decided.proposal_id!)).toEqual([{ node: "approve", visit: 1 }]);
  });
});

describe("redesign (D22)", () => {
  interface G {
    goal: string;
    base: unknown;
    feedback: unknown;
    proposal: unknown;
    decision: unknown;
  }
  const graph = defineGraph<G>({
    name: "decide-graph",
    entry: "extract",
    inputs: ["goal"],
    nodes: {
      extract: { kind: "command", run: "x", writes: { base: { scope: "sticky" } } },
      propose: { kind: "agent", prompt: "discover", reads: ["base", "feedback"], writes: { proposal: { scope: "per-visit" } } },
      approve: { kind: "approval", proposal: "proposal", base: "base", decision: "decision", feedback: "feedback", redesignTo: "extract" },
      done: { kind: "terminal", outcome: "success" },
    },
    edges: [
      { from: "extract", to: "propose" },
      { from: "propose", to: "approve" },
      { from: "approve", to: "done" },
    ],
  });
  const graphs = { "decide-graph": graph };

  test("appends the request, then a budget-resetting jump to redesignTo; the park is superseded", () => {
    const { dir, events } = awaitingRun();
    const r = redesign(dir, "split reads from writes", { graphs });
    expect(r).toEqual({ ok: true, proposal_id: null, idempotent: false, jumped_to: "extract", asks: [{ node: "approve", visit: 1 }] });
    const tail = events().slice(-2);
    expect(tail[0]).toMatchObject({ type: "slice-redesign-requested", message: "split reads from writes" });
    expect(tail[1]).toMatchObject({ type: "operator-jump", to: "extract", reset_budgets: true });
    expect(tail[1]).not.toHaveProperty("message"); // the message travels through feedback, not the jump note
    const replayed = replayState(events());
    expect(replayed.parked).toBeNull();
    expect(replayed.position).toEqual({ node: "extract", midFlight: false });
    expect(pendingRedesigns(events(), "approve", "extract", "feedback")).toEqual([{ source: "redesign", text: "split reads from writes" }]);
    // one append: the pair is consecutive and shares a timestamp
    expect(tail[1]!.seq).toBe(tail[0]!.seq + 1);
    expect(tail[1]!.ts).toBe(tail[0]!.ts);
    expect(tail[0]).toMatchObject({ approval: "approve" });
  });

  test("works on a run that is not parked, too", () => {
    const { dir, log } = awaitingRun();
    log.append({ type: "attention-resolved", node: "approve", visit: 1, reply: "resume", source: "resume" });
    expect(redesign(dir, "again", { graphs })).toMatchObject({ ok: true, asks: [] });
  });

  test("refusals: live runner, blank message, unregistered graph, no approval node, finished run", () => {
    const live = awaitingRun();
    expect(claimRunner(live.dir)).toBeNull(); // this test process is the run's live runner
    expect(redesign(live.dir, "x", { graphs })).toMatchObject({ ok: false, code: "runner-live" });
    releaseRunner(live.dir);
    expect(count(live.events(), "slice-redesign-requested")).toBe(0);

    const r = awaitingRun();
    expect(redesign(r.dir, "  ", { graphs })).toMatchObject({ ok: false, code: "bad-request" });
    expect(redesign(r.dir, "x", { graphs: {} })).toMatchObject({ ok: false, code: "unknown-graph" });
    const plain = defineGraph<{ goal: string }>({
      name: "decide-graph",
      entry: "a",
      inputs: ["goal"],
      nodes: { a: { kind: "command", run: "x" }, done: { kind: "terminal", outcome: "success" } },
      edges: [{ from: "a", to: "done" }],
    });
    const none = redesign(r.dir, "x", { graphs: { "decide-graph": plain } });
    expect(none).toMatchObject({ ok: false, code: "no-approval-node" });
    expect(!none.ok && none.message).toContain("use `jump");
    r.log.append({ type: "run-finished", outcome: "aborted" });
    expect(redesign(r.dir, "x", { graphs })).toMatchObject({ ok: false, code: "finished" });
    expect(count(r.events(), "slice-redesign-requested")).toBe(0);
  });
});

describe("concurrent decisions land exactly one (appendIf across processes)", () => {
  test("racing approve and send-feedback processes: one decision event, the losers refused or idempotent", async () => {
    const { dir, events } = awaitingRun();
    pinComment(dir, "e", "a comment so feedback is possible");
    const control = join(import.meta.dir, "control.ts");
    const racer = (fn: "approve" | "sendFeedback") =>
      Bun.spawn(["bun", "-e", `import { ${fn} } from ${JSON.stringify(control)}; console.log(JSON.stringify(${fn}(${JSON.stringify(dir)})));`], {
        stdout: "pipe",
        stderr: "pipe",
      });
    const procs = [racer("approve"), racer("sendFeedback"), racer("approve"), racer("sendFeedback")];
    const outs = await Promise.all(procs.map(async (p) => JSON.parse((await new Response(p.stdout).text()).trim()) as { ok: boolean; code?: string; idempotent?: boolean }));
    const decisions = events().filter((e) => e.type === "slice-approved" || e.type === "slice-feedback-sent");
    expect(decisions).toHaveLength(1);
    const winner = decisions[0]!.type === "slice-approved" ? "approve" : "sendFeedback";
    const kinds = ["approve", "sendFeedback", "approve", "sendFeedback"];
    outs.forEach((o, i) => {
      if (kinds[i] === winner) expect(o.ok).toBe(true);
      else expect(o).toMatchObject({ ok: false, code: "already-decided" });
    });
    expect(outs.filter((o) => o.ok && o.idempotent === false)).toHaveLength(1);
    expect(existsSync(join(dir, "run.jsonl.lock"))).toBe(false);
    expect(readLog(join(dir, "run.jsonl")).map((e) => e.seq)).toEqual(events().map((_, i) => i + 1));
  }, 20000);
});
