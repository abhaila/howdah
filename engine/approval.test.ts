/**
 * system-map 1a engine tests: the approval node, the awaiting path, the `requires` gate,
 * proposal rounds, feedback rounds, redesign seeding and the validateProposal hook — run
 * generically on a small slice graph with a scripted fake proposer, over a real temp git
 * repo so the fingerprint is real.
 *
 *   extract ─▶ propose (readOnly) ─▶ approve ─┬─ approved ─▶ implement ─▶ review ─┬─ pass ─▶ done
 *      ▲          ▲                           ├─ feedback ─┘ (requires)   ▲       │
 *      │          └───────────────────────────┘                           └ reject┘
 *      └───────────────── stale ──────────────┘   redesign → extract
 */
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { defineGraph, type GraphDef } from "../core/graph";
import { Engine, type AttemptResult, type Executor } from "./run";
import { replayState } from "./replay";
import { approvalExecutor } from "./executors/approval";
import { fingerprint } from "./reconcile";
import { approve, pinComment, redesign, runnerAlive, sendFeedback } from "./control";
import { processStart } from "../log/lockfile";
import { proposalHash } from "../core/proposal";
import { EventLog } from "../log/write";
import type { LoggedEvent, RunEvent } from "../log/events";
import { commandExecutor } from "./executors/worktree";
import type { ApprovalDecision, BaseSnapshot, FeedbackItem } from "./slice-decision";

interface Ctx {
  goal: string;
  base: BaseSnapshot;
  feedback: FeedbackItem[];
  proposal: unknown;
  decision: ApprovalDecision;
  summary: string;
  verdict: "pass" | "reject";
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "howdah-slice-repo-"));
  const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir, stdio: "pipe" });
  git("init -q -b main");
  git("config user.email t@t && git config user.name t");
  writeFileSync(join(dir, "a.txt"), "hello\n");
  git("add a.txt && git commit -q -m init");
  return dir;
}

function prompts(): string {
  const dir = mkdtempSync(join(tmpdir(), "howdah-slice-prompts-"));
  const write = (id: string, body: string) => writeFileSync(join(dir, `${id}.md`), `---\nid: ${id}\nversion: 1\n---\n${body}`);
  write("discover", "Propose for {{ context.goal }}. Feedback: {{ context.feedback }}\n");
  write("implementation.implement", "Implement {{ context.proposal }} ({{ context.decision }}).\n");
  write("implementation.local_review", "Review {{ context.summary }}.\n");
  return dir;
}

function sliceGraph(extra: Partial<GraphDef<Ctx>> = {}) {
  return defineGraph<Ctx>({
    name: "slice-test",
    entry: "extract",
    inputs: ["goal"],
    nodes: {
      extract: { kind: "command", run: "extract", reads: ["goal"], writes: { base: { scope: "sticky" } }, maxVisits: 5 },
      propose: { kind: "agent", prompt: "discover", readOnly: true, reads: ["goal", "base", "feedback"], writes: { proposal: { scope: "per-visit" } } },
      approve: { kind: "approval", proposal: "proposal", base: "base", decision: "decision", feedback: "feedback", redesignTo: "extract" },
      implement: {
        kind: "agent",
        prompt: "implementation.implement",
        requires: { approvalOf: "approve" },
        reads: ["goal", "proposal", "decision"],
        writes: { summary: { scope: "sticky" } },
        maxVisits: 3,
      },
      review: { kind: "agent", prompt: "implementation.local_review", reads: ["summary"], writes: { verdict: { scope: "cleared" } } },
      done: { kind: "terminal", outcome: "success" },
    },
    edges: [
      { from: "extract", to: "propose" },
      { from: "propose", to: "approve" },
      { from: "approve", to: "implement", condition: { reads: ["decision"], test: (v) => v.decision.outcome === "approved", label: "approved" } },
      { from: "approve", to: "propose", condition: { reads: ["decision"], test: (v) => v.decision.outcome === "feedback", label: "feedback" } },
      { from: "approve", to: "extract", condition: { reads: ["decision"], test: (v) => v.decision.outcome === "stale", label: "stale" } },
      { from: "implement", to: "review" },
      { from: "review", to: "implement", condition: { reads: ["verdict"], test: (v) => v.verdict === "reject", label: "reject" }, weight: 2 },
      { from: "review", to: "done", condition: { reads: ["verdict"], test: (v) => v.verdict === "pass", label: "pass" }, weight: 1 },
    ],
    ...extra,
  });
}

interface Script {
  /** what the fake proposer returns, round by round (last one repeats) */
  proposals?: unknown[];
  verdicts?: Array<"pass" | "reject">;
  /** runs inside a node's attempt — mutate the worktree mid-proposal, mid-implement, ... */
  during?: Partial<Record<string, (repoDir: string) => void>>;
  /** runs after the approval executor returned (before the gate on the next node) */
  afterApproval?: (result: AttemptResult, repoDir: string) => void;
  /** how long the fake implement takes (to overlap two runners) */
  implementMs?: number;
  /** replace the fake extract with this executor (e.g. the REAL commandExecutor) */
  command?: Executor;
}

/** a run of the slice graph: fresh engines over the same dir, recording every prompt */
function harness(script: Script = {}, graph = sliceGraph()) {
  const dir = mkdtempSync(join(tmpdir(), "howdah-slice-run-"));
  const cwd = repo();
  const promptsDir = prompts();
  const seen: Array<{ node: string; prompt: string }> = [];
  const proposals = [...(script.proposals ?? [{ ghosts: ["v1"] }])];
  const verdicts = [...(script.verdicts ?? ["pass"])];
  let manifest = 0;

  const agent: Executor = async ({ nodeId, renderedPrompt }) => {
    seen.push({ node: nodeId, prompt: renderedPrompt ?? "" });
    script.during?.[nodeId]?.(cwd);
    if (nodeId === "implement" && script.implementMs) await Bun.sleep(script.implementMs);
    if (nodeId === "propose") return { status: "succeeded", writes: { proposal: proposals.length > 1 ? proposals.shift() : proposals[0] } };
    if (nodeId === "implement") return { status: "succeeded", writes: { summary: "built it" } };
    return { status: "succeeded", writes: { verdict: verdicts.length > 1 ? verdicts.shift() : verdicts[0] } };
  };
  const command: Executor = async ({ cwd: runCwd }) => {
    script.during?.["extract"]?.(cwd);
    const fp = (await fingerprint(runCwd))!;
    const base: BaseSnapshot = { manifest_hash: `m${++manifest}`, fingerprint: fp, commit: fp.head };
    return { status: "succeeded", writes: { base } }; // feedback: engine-owned on the redesignTo node
  };
  const approval: Executor = async (args) => {
    const r = await approvalExecutor(args);
    script.afterApproval?.(r, cwd);
    return r;
  };
  const engine = () => new Engine(graph, { dir, cwd, folderKind: "repo", promptsDir, executors: { agent, command: script.command ?? command, approval } });
  const events = () => new EventLog(join(dir, "run.jsonl")).read();
  return { dir, cwd, seen, engine, events, graph };
}

const of = <T extends LoggedEvent["type"]>(events: LoggedEvent[], type: T) =>
  events.filter((e): e is Extract<LoggedEvent, { type: T }> => e.type === type);
const started = (events: LoggedEvent[], node: string) => of(events, "node-started").filter((e) => e.node === node);
const finished = (events: LoggedEvent[], node: string) => of(events, "node-finished").filter((e) => e.node === node);
const git = (dir: string, cmd: string) => execSync(`git ${cmd}`, { cwd: dir, stdio: "pipe" });

describe("proposal rounds (D15)", () => {
  test("a successful proposer write opens a round: ghost-proposed before node-finished, id = its own seq", async () => {
    const h = harness({ proposals: [{ ghosts: ["a", "b"] }] });
    await h.engine().start({ goal: "g" });
    const events = h.events();
    const [ghost] = of(events, "ghost-proposed");
    expect(ghost).toMatchObject({
      node: "propose",
      approval: "approve",
      proposal_id: ghost!.seq,
      proposal_hash: proposalHash({ ghosts: ["a", "b"] }),
      manifest_hash: "m1",
      proposal: { ghosts: ["a", "b"] },
    });
    expect(ghost!.fingerprint).toEqual(await fingerprint(h.cwd));
    // the round opens inside the proposer's attempt, before its node-finished
    expect(finished(events, "propose")[0]!.seq).toBe(ghost!.seq + 1);
  });

  test("validateProposal refusing fails the proposer attempt with its message; no round opens", async () => {
    const graph = sliceGraph({ validateProposal: (p) => ((p as { bad?: boolean }).bad ? "ghost g1 names unknown entity x" : null) });
    const h = harness({ proposals: [{ bad: true }] }, graph);
    const r = await h.engine().start({ goal: "g" });
    expect(r).toMatchObject({ state: "parked", node: "propose", code: "attempt-failed" });
    expect((r as { reason: string }).reason).toBe('proposal for "approve" refused: ghost g1 names unknown entity x');
    const events = h.events();
    expect(of(events, "ghost-proposed")).toHaveLength(0);
    expect(finished(events, "propose")[0]).toMatchObject({ status: "failed", writes: {} });
    // the reason is readable in the thread, not only in the ask
    expect(of(events, "chunk").some((c) => c.content.includes("ghost g1 names unknown entity x"))).toBe(true);
  });

  test("the hook sees the value and the approval node, and accepting lets the round open", async () => {
    const calls: Array<[unknown, string]> = [];
    const graph = sliceGraph({ validateProposal: (p, a) => (calls.push([p, a]), null) });
    const h = harness({ proposals: [{ ok: 1 }] }, graph);
    await h.engine().start({ goal: "g" });
    expect(calls).toEqual([[{ ok: 1 }, "approve"]]);
    expect(of(h.events(), "ghost-proposed")).toHaveLength(1);
  });
});

describe("the awaiting path (D4/3A)", () => {
  test("undecided: parks awaiting-approval with NO node-finished; context left consistent", async () => {
    const h = harness();
    const engine = h.engine();
    const r = await engine.start({ goal: "g" });
    expect(r).toMatchObject({ state: "parked", node: "approve", code: "awaiting-approval" });
    const events = h.events();
    expect(started(events, "approve")).toHaveLength(1);
    expect(finished(events, "approve")).toHaveLength(0);
    expect(replayState(events).position).toEqual({ node: "approve", midFlight: true });
    const ctx = (engine as any).ctx;
    // the attempt was closed as failed: nothing is left open, sticky values stand
    expect(() => ctx.beginAttempt("probe", 1)).not.toThrow();
    expect(ctx.has("feedback")).toBe(true);
    expect(ctx.has("decision")).toBe(false); // no decision was ever published
  });

  test("a restart re-attempts the SAME visit (no visit consumed) and is still awaiting", async () => {
    const h = harness();
    await h.engine().start({ goal: "g" });
    for (let i = 0; i < 2; i++) {
      const r = await h.engine().resume();
      expect(r).toMatchObject({ state: "parked", node: "approve", code: "awaiting-approval" });
    }
    const events = h.events();
    expect(started(events, "approve").map((e) => e.visit)).toEqual([1, 1, 1]);
    expect(finished(events, "approve")).toHaveLength(0);
    expect(replayState(events).visits["approve"]).toBe(1);
    expect(of(events, "ghost-proposed")).toHaveLength(1); // waiting never redraws
  });

  test("a restart while awaiting never routes onward on a previous visit's decision", async () => {
    // round 1 gets feedback (approve finishes with outcome feedback), round 2 is undecided
    const h = harness({ proposals: [{ v: 1 }, { v: 2 }] });
    await h.engine().start({ goal: "g" });
    expect(pinComment(h.dir, "e1", "tighten it").ok).toBe(true);
    expect(sendFeedback(h.dir).ok).toBe(true);
    const r = await h.engine().resume();
    expect(r).toMatchObject({ state: "parked", node: "approve", code: "awaiting-approval" });
    const again = await h.engine().resume();
    expect(again).toMatchObject({ state: "parked", node: "approve", code: "awaiting-approval" });
    expect(started(h.events(), "implement")).toHaveLength(0);
    // visit 1 was re-attempted once to consume the feedback; visit 2 then waited twice
    expect(started(h.events(), "approve").map((e) => e.visit)).toEqual([1, 1, 2, 2]);
  });

  test("a decision landing between restarts is picked up by the same visit", async () => {
    const h = harness();
    await h.engine().start({ goal: "g" });
    await h.engine().resume(); // still awaiting
    expect(approve(h.dir)).toMatchObject({ ok: true, idempotent: false });
    const r = await h.engine().resume();
    expect(r).toEqual({ state: "finished", outcome: "success" });
    const events = h.events();
    const decided = finished(events, "approve");
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ visit: 1, status: "succeeded" });
    const ghost = of(events, "ghost-proposed")[0]!;
    expect(decided[0]!.writes).toEqual({
      decision: { outcome: "approved", proposal_id: ghost.proposal_id, proposal_hash: ghost.proposal_hash, manifest_hash: "m1" },
      feedback: [],
    });
  });
});

describe("the requires gate (D3/2A, D18)", () => {
  test("a jump straight to implement without an approval parks approval-missing: no node-started, no visit", async () => {
    const h = harness();
    await h.engine().start({ goal: "g" });
    new EventLog(join(h.dir, "run.jsonl")).append({ type: "operator-jump", to: "implement", reset_budgets: true });
    for (let i = 0; i < 2; i++) {
      const r = await h.engine().resume();
      expect(r).toMatchObject({ state: "parked", node: "implement", code: "approval-missing" });
      expect((r as { reason: string }).reason).toMatch(/requires an approval from "approve": proposal #\d+ is undecided/);
    }
    const events = h.events();
    expect(started(events, "implement")).toHaveLength(0);
    expect(replayState(events).visits["implement"]).toBeUndefined();
  });

  test("a jump past a round that got feedback is approval-missing too, even though an old decision is readable", async () => {
    const h = harness({ proposals: [{ v: 1 }, { v: 2 }] });
    await h.engine().start({ goal: "g" });
    pinComment(h.dir, "e", "no");
    sendFeedback(h.dir);
    await h.engine().resume(); // round 1 finished with outcome feedback; round 2 awaiting
    new EventLog(join(h.dir, "run.jsonl")).append({ type: "operator-jump", to: "implement", reset_budgets: true });
    const r = await h.engine().resume();
    expect(r).toMatchObject({ state: "parked", node: "implement", code: "approval-missing" });
    expect((r as { reason: string }).reason).toMatch(/proposal #\d+ is undecided/);
    expect(started(h.events(), "implement")).toHaveLength(0);
  });

  const edits: Array<[string, (dir: string) => void, RegExp, ((dir: string) => void)?]> = [
    ["a tracked change", (d) => writeFileSync(join(d, "a.txt"), "edited after approval\n"), /: tracked changes differ$/],
    [
      "an untracked file's content",
      (d) => writeFileSync(join(d, "notes.txt"), "v2\n"),
      /: untracked files differ$/,
      (d) => writeFileSync(join(d, "notes.txt"), "v1\n"), // present (untracked) when the base is taken
    ],
    ["a HEAD move", (d) => git(d, "commit -q --allow-empty -m sneaky"), /: HEAD moved \([0-9a-f]{7} → [0-9a-f]{7}\)$/],
  ];
  for (const [label, edit, summary, setup] of edits) {
    test(`approval, then ${label} before implement starts → stale-base with a diff summary`, async () => {
      let edited = false;
      const h = harness({
        during: setup ? { extract: setup } : {},
        afterApproval: (r, d) => {
          if (r.status === "succeeded" && !edited) {
            edited = true;
            edit(d);
          }
        },
      });
      await h.engine().start({ goal: "g" });
      approve(h.dir);
      const r = await h.engine().resume();
      expect(r).toMatchObject({ state: "parked", node: "implement", code: "stale-base" });
      expect((r as { reason: string }).reason).toMatch(/^the worktree changed since proposal #\d+ was approved/);
      expect((r as { reason: string }).reason).toMatch(summary);
      expect(started(h.events(), "implement")).toHaveLength(0);
      // deterministic: a plain resume re-parks, still without starting implement
      expect(await h.engine().resume()).toMatchObject({ state: "parked", code: "stale-base" });
      expect(started(h.events(), "implement")).toHaveLength(0);
    });
  }

  test("reject-loop re-entries after the same approval pass the gate although implement changed the tree", async () => {
    const h = harness({
      verdicts: ["reject", "pass"],
      during: { implement: (d) => writeFileSync(join(d, "a.txt"), `implemented ${Date.now()}\n`) },
    });
    await h.engine().start({ goal: "g" });
    approve(h.dir);
    const r = await h.engine().resume();
    expect(r).toEqual({ state: "finished", outcome: "success" });
    expect(started(h.events(), "implement").map((e) => e.visit)).toEqual([1, 2]);
  });
});

describe("feedback rounds and redesign", () => {
  test("pinned comments → send-feedback → the proposer redraws reading them → a new round", async () => {
    const h = harness({ proposals: [{ v: 1 }, { v: 2 }] });
    await h.engine().start({ goal: "g" });
    const c1 = pinComment(h.dir, "route:/users", "paginate this");
    const c2 = pinComment(h.dir, "block:api", "split the handler");
    expect(c1).toMatchObject({ ok: true });
    expect(sendFeedback(h.dir)).toMatchObject({ ok: true, idempotent: false });
    const r = await h.engine().resume();
    expect(r).toMatchObject({ state: "parked", node: "approve", code: "awaiting-approval" });

    const proposerPrompts = h.seen.filter((s) => s.node === "propose").map((s) => s.prompt);
    expect(proposerPrompts).toHaveLength(2);
    expect(proposerPrompts[0]).toContain("Feedback: []");
    expect(proposerPrompts[1]).toContain("paginate this");
    expect(proposerPrompts[1]).toContain("split the handler");
    const fed = finished(h.events(), "approve")[0]!.writes["feedback"];
    expect(fed).toEqual([
      { source: "comment", id: c1.ok ? c1.comment_id : "", entity_id: "route:/users", text: "paginate this" },
      { source: "comment", id: c2.ok ? c2.comment_id : "", entity_id: "block:api", text: "split the handler" },
    ]);
    const rounds = of(h.events(), "ghost-proposed");
    expect(rounds).toHaveLength(2);
    expect(rounds[1]!.proposal_id).toBeGreaterThan(rounds[0]!.proposal_id);
  });

  test("an identical redraw after feedback is a NEW round, and it is decidable", async () => {
    const h = harness({ proposals: [{ same: true }] });
    await h.engine().start({ goal: "g" });
    pinComment(h.dir, "e", "try again");
    sendFeedback(h.dir);
    await h.engine().resume();
    const [r1, r2] = of(h.events(), "ghost-proposed");
    expect(r1!.proposal_hash).toBe(r2!.proposal_hash);
    expect(r2!.proposal_id).not.toBe(r1!.proposal_id);
    expect(approve(h.dir, { proposalId: r1!.proposal_id })).toMatchObject({ ok: false, code: "superseded" });
    expect(approve(h.dir, { proposalId: r2!.proposal_id })).toMatchObject({ ok: true, proposal_id: r2!.proposal_id });
    expect(await h.engine().resume()).toEqual({ state: "finished", outcome: "success" });
  });

  test("redesign: the message reaches the proposer's prompt exactly once", async () => {
    const h = harness({ proposals: [{ v: 1 }, { v: 2 }, { v: 3 }] });
    await h.engine().start({ goal: "g" });
    const r = redesign(h.dir, "use a queue, not polling", { graphs: { "slice-test": h.graph } });
    expect(r).toMatchObject({ ok: true, jumped_to: "extract" });
    const tail = h.events().slice(-2);
    expect(tail.map((e) => e.type)).toEqual(["slice-redesign-requested", "operator-jump"]);
    expect(tail[1]).toMatchObject({ to: "extract", reset_budgets: true });

    await h.engine().resume(); // extract (seeds feedback) → propose → approve awaiting
    pinComment(h.dir, "e", "one more tweak");
    sendFeedback(h.dir);
    await h.engine().resume(); // propose again with the comment only
    const prompts = h.seen.filter((s) => s.node === "propose").map((s) => s.prompt);
    expect(prompts).toHaveLength(3);
    expect(prompts.filter((p) => p.includes("use a queue, not polling"))).toHaveLength(1);
    expect(prompts[1]).toContain('"source":"redesign"');
    expect(prompts[2]).toContain("one more tweak");
    // the seed is the extract node's publish, not the executor's: it wrote no feedback itself
    const seeded = finished(h.events(), "extract").map((e) => e.writes["feedback"]);
    expect(seeded).toEqual([[], [{ source: "redesign", text: "use a queue, not polling" }]]);
  });

  test("a redesign whose seeding attempt fails keeps the message for the retry", async () => {
    let failExtract = false;
    const h = harness({
      during: {
        extract: () => {
          if (failExtract) {
            failExtract = false;
            throw new Error("extract blew up");
          }
        },
      },
    });
    await h.engine().start({ goal: "g" });
    redesign(h.dir, "rethink storage", { graphs: { "slice-test": h.graph } });
    failExtract = true;
    expect(await h.engine().resume()).toMatchObject({ state: "parked", node: "extract", code: "executor-threw" });
    await h.engine().resume(); // retry succeeds
    const prompts = h.seen.filter((s) => s.node === "propose").map((s) => s.prompt);
    expect(prompts.filter((p) => p.includes("rethink storage"))).toHaveLength(1);
  });
});

describe("stale outcomes (D18)", () => {
  test("a worktree change while the proposer ran → stale, 'worktree changed during propose', back to extract", async () => {
    let dirtied = false;
    const h = harness({
      during: {
        propose: (d) => {
          if (!dirtied) {
            dirtied = true;
            writeFileSync(join(d, "scratch.md"), "the proposer wrote a file\n");
          }
        },
      },
    });
    const r = await h.engine().start({ goal: "g" });
    expect(r).toMatchObject({ state: "parked", node: "approve", code: "awaiting-approval" }); // round 2, clean
    const first = finished(h.events(), "approve")[0]!;
    expect(first.writes["decision"]).toMatchObject({
      outcome: "stale",
      reason: "worktree changed during propose: untracked files differ",
    });
    expect(first.writes["feedback"]).toEqual([]);
    expect(started(h.events(), "extract")).toHaveLength(2);
    expect(of(h.events(), "ghost-proposed")).toHaveLength(2);
  });

  test("a change after the proposal (while awaiting) → stale 'since propose proposed', even if approved", async () => {
    const h = harness();
    await h.engine().start({ goal: "g" });
    approve(h.dir);
    git(h.cwd, "commit -q --allow-empty -m moved");
    const r = await h.engine().resume();
    expect(r).toMatchObject({ state: "parked", node: "approve", code: "awaiting-approval" }); // redrawn round
    const decision = finished(h.events(), "approve")[0]!.writes["decision"] as ApprovalDecision;
    expect(decision.outcome).toBe("stale");
    expect(decision.reason).toMatch(/^worktree changed since propose proposed: HEAD moved/);
    expect(started(h.events(), "implement")).toHaveLength(0);
  });
});

// ---- system-map 1a review fixes ----------------------------------------------------------

/** copy a run's log up to (and including) the first event matching `until` into a fresh run dir */
function crashCopy(h: ReturnType<typeof harness>, until: (e: LoggedEvent) => boolean) {
  const events = h.events();
  const cut = events.findIndex(until);
  const dir = mkdtempSync(join(tmpdir(), "howdah-slice-crash-"));
  const log = new EventLog(join(dir, "run.jsonl"));
  for (const e of events.slice(0, cut + 1)) {
    const { seq: _s, ts: _t, ...rest } = e;
    log.append(rest as RunEvent);
  }
  cpSync(join(h.dir, "prompts"), join(dir, "prompts"), { recursive: true });
  return dir;
}

describe("one runner per run (review item 2)", () => {
  test("two concurrent resumes of a decided park: exactly one runs implement, the other is busy", async () => {
    const h = harness({ implementMs: 200 });
    await h.engine().start({ goal: "g" });
    approve(h.dir);
    const [a, b] = await Promise.all([h.engine().resume(), h.engine().resume()]);
    const states = [a.state, b.state].sort();
    expect(states).toEqual(["busy", "finished"]);
    expect(started(h.events(), "implement")).toHaveLength(1);
    expect(h.seen.filter((x) => x.node === "implement")).toHaveLength(1);
  });

  test("the lock is released when the loop returns, and a dead holder's lock is broken", async () => {
    const h = harness();
    await h.engine().start({ goal: "g" }); // parks, releases
    expect(existsSync(join(h.dir, "runner.pid"))).toBe(false);
    writeFileSync(join(h.dir, "runner.pid"), "999999999"); // a runner killed with -9
    expect(await h.engine().resume()).toMatchObject({ state: "parked", code: "awaiting-approval" });
  });

  test("a graph with an approval step refuses to start outside a git work tree", async () => {
    const plain = mkdtempSync(join(tmpdir(), "howdah-plain-"));
    const engine = new Engine(sliceGraph(), { dir: mkdtempSync(join(tmpdir(), "howdah-slice-run-")), cwd: plain, promptsDir: prompts(), executors: {} });
    await expect(engine.start({ goal: "g" })).rejects.toThrow(/has an approval step.*is not a git work tree/);
    expect(engine.log.read()).toHaveLength(0);
  });
});

describe("engine-owned feedback on the redesign target (review item 3)", () => {
  test("the REAL commandExecutor as extract: its facts need only its own writes; the engine seeds feedback", async () => {
    const graph = sliceGraph();
    const h = harness({ command: commandExecutor() }, graph);
    const fp = await fingerprint(h.cwd);
    const facts = JSON.stringify({ base: { manifest_hash: "real-1", fingerprint: fp, commit: fp!.head } });
    (graph.def.nodes.extract as { run: string }).run = `echo extracting; echo '${facts}'`;
    // the executor-facing declaration is the node's own: no feedback key to demand from the script
    expect(Object.keys((graph.def.nodes.extract as { writes: object }).writes)).toEqual(["base"]);
    const r = await h.engine().start({ goal: "g" });
    expect(r).toMatchObject({ state: "parked", node: "approve", code: "awaiting-approval" });
    expect(finished(h.events(), "extract")[0]).toMatchObject({ status: "succeeded", writes: { base: { manifest_hash: "real-1" }, feedback: [] } });
  });

  test("feedback routed THROUGH the redesign target is not wiped: the proposer still sees the comments", async () => {
    const graph = sliceGraph({
      edges: sliceGraph().def.edges.map((e) =>
        e.from === "approve" && e.to === "propose" ? { ...e, to: "extract" } : e,
      ),
    });
    const h = harness({ proposals: [{ v: 1 }, { v: 2 }] }, graph);
    await h.engine().start({ goal: "g" });
    pinComment(h.dir, "e", "keep this comment alive");
    sendFeedback(h.dir);
    await h.engine().resume(); // approve(feedback) → extract → propose
    const prompts = h.seen.filter((x) => x.node === "propose").map((x) => x.prompt);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("keep this comment alive");
    // extract published nothing for feedback on that visit
    expect(finished(h.events(), "extract").map((e) => "feedback" in e.writes)).toEqual([true, false]);
  });
});

describe("the approval binds to the round's base (review item 4)", () => {
  test("a re-extract between proposal and approval is stale, not approved-then-refused", async () => {
    // propose → refresh (writes a NEW base) → approve
    const base = sliceGraph();
    const graph = sliceGraph({
      nodes: {
        ...base.def.nodes,
        refresh: { kind: "command", run: "refresh", writes: { base: { scope: "sticky" } } },
      },
      edges: base.def.edges.flatMap((e) =>
        e.from === "propose" && e.to === "approve" ? [{ from: "propose", to: "refresh" }, { from: "refresh", to: "approve" }] : [e],
      ),
    });
    const h = harness({}, graph);
    await h.engine().start({ goal: "g" });
    const decisions = finished(h.events(), "approve").map((e) => e.writes["decision"] as ApprovalDecision);
    expect(decisions[0]).toMatchObject({ outcome: "stale" });
    expect(decisions[0]!.reason).toMatch(/^the base was re-extracted since propose proposed \(manifest m1 → m2\)$/);
  });

  test("a stale round that had been sent back with feedback carries the comments into the redraw", async () => {
    const h = harness({ proposals: [{ v: 1 }, { v: 2 }] });
    await h.engine().start({ goal: "g" });
    pinComment(h.dir, "e", "carry me");
    sendFeedback(h.dir);
    git(h.cwd, "commit -q --allow-empty -m moved"); // stale before the decision is consumed
    await h.engine().resume(); // approve: stale (carrying) → extract → propose
    const first = finished(h.events(), "approve")[0]!;
    expect(first.writes["decision"]).toMatchObject({ outcome: "stale" });
    expect(first.writes["feedback"]).toEqual([expect.objectContaining({ source: "comment", text: "carry me" })]);
    expect(h.seen.filter((x) => x.node === "propose").at(-1)!.prompt).toContain("carry me");
  });
});

describe("crash windows (review item 8)", () => {
  test("a crash between ghost-proposed and the proposer's node-finished: the redraw opens a NEW round; the orphan is not decidable", async () => {
    const h = harness({ proposals: [{ v: 1 }] });
    await h.engine().start({ goal: "g" });
    const orphan = of(h.events(), "ghost-proposed")[0]!;
    const dir = crashCopy(h, (e) => e.type === "ghost-proposed");
    expect(replayState(new EventLog(join(dir, "run.jsonl")).read()).position).toEqual({ node: "propose", midFlight: true });
    // while the proposer is mid-flight nothing awaits a decision
    expect(approve(dir)).toMatchObject({ ok: false, code: "not-awaiting" });
    const engine = new Engine(h.graph, { dir, cwd: h.cwd, folderKind: "repo", executors: (h.engine() as any).opts.executors });
    expect(await engine.resume()).toMatchObject({ state: "parked", node: "approve", code: "awaiting-approval" });
    const rounds = of(engine.log.read(), "ghost-proposed");
    expect(rounds).toHaveLength(2);
    expect(approve(dir, { proposalId: orphan.proposal_id })).toMatchObject({ ok: false, code: "superseded" });
    expect(approve(dir, { proposalId: rounds[1]!.proposal_id })).toMatchObject({ ok: true });
  });

  test("PINNED: a first implement attempt that died mid-flight after editing the tree re-attempts past the gate", async () => {
    const h = harness({ during: { implement: (d) => writeFileSync(join(d, "a.txt"), "half-done implementation\n") } });
    await h.engine().start({ goal: "g" });
    approve(h.dir);
    await h.engine().resume(); // implement ran (edited the tree), review passed
    const dir = crashCopy(h, (e) => e.type === "node-started" && e.node === "implement");
    // the log ends inside implement's first attempt; the tree carries its edit
    const engine = new Engine(h.graph, { dir, cwd: h.cwd, folderKind: "repo", executors: (h.engine() as any).opts.executors });
    expect(await engine.resume()).toEqual({ state: "finished", outcome: "success" });
    expect(started(engine.log.read(), "implement").map((e) => e.visit)).toEqual([1, 1]); // same visit, not stale-base
  });
});

describe("PID reuse and the runner lock (re-review item 1)", () => {
  test("runner.pid naming a reused PID (pid 1, a non-howdah process) is stale: resume proceeds", async () => {
    const h = harness();
    await h.engine().start({ goal: "g" });
    approve(h.dir);
    writeFileSync(join(h.dir, "runner.pid"), "1"); // the reviewer's repro: reboot + a reused PID
    expect(await h.engine().resume()).toEqual({ state: "finished", outcome: "success" });
  });

  test("an identity lock whose live PID started at another time is stale; the genuine holder blocks", async () => {
    const h = harness();
    await h.engine().start({ goal: "g" });
    const other = Bun.spawn(["sleep", "30"]);
    try {
      writeFileSync(join(h.dir, "runner.pid"), `${other.pid} Thu Jan  1 00:00:00 1970`);
      expect(await h.engine().resume()).toMatchObject({ state: "parked", code: "awaiting-approval" });
      writeFileSync(join(h.dir, "runner.pid"), `${other.pid} ${processStart(other.pid)}`); // that process IS the holder
      const busy = await h.engine().resume();
      expect(busy).toMatchObject({ state: "busy", holder: { pid: other.pid, genuine: true } });
    } finally {
      other.kill(9);
      await other.exited;
    }
  });

  test("whileHeld (where the CLI raises a park's attention) runs before the lock is released", async () => {
    const h = harness();
    let heldDuring: boolean | undefined;
    const engine = new Engine(h.graph, {
      dir: h.dir, cwd: h.cwd, folderKind: "repo", promptsDir: prompts(),
      executors: (h.engine() as any).opts.executors,
      whileHeld: async (r) => {
        heldDuring = r.state === "parked" && runnerAlive(h.dir);
      },
    });
    await engine.start({ goal: "g" });
    expect(heldDuring).toBe(true);
    expect(runnerAlive(h.dir)).toBe(false);
  });
});

describe("a plain jump to the redesign target restarts the conversation (re-review item 3)", () => {
  test("round N's comments are NOT re-read by the proposer after `jump <run> extract`", async () => {
    const h = harness({ proposals: [{ v: 1 }, { v: 2 }, { v: 3 }] });
    await h.engine().start({ goal: "g" });
    pinComment(h.dir, "e", "comment C1 from round 1");
    sendFeedback(h.dir);
    await h.engine().resume(); // round 2 drawn with C1, now awaiting
    const log = new EventLog(join(h.dir, "run.jsonl"));
    log.append({ type: "operator-jump", to: "extract", reset_budgets: true }); // no redesign message
    await h.engine().resume();
    const prompts = h.seen.filter((x) => x.node === "propose").map((x) => x.prompt);
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain("comment C1 from round 1");
    expect(prompts[2]).not.toContain("comment C1");
    expect(prompts[2]).toContain("Feedback: []");
  });
});
