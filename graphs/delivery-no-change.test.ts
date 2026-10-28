/**
 * HOW-75 — a review repair that rightly changes nothing waits for the PR instead of parking.
 *
 * The real implement-ticket graph over a real git repo, with the CLI's reconciler seat (git is
 * probed before every node) and the REAL command executor — so `repair:changed` and `probe:pr`
 * run as they do in a run, with only gh replaced by a scripted probe. Agents are stubs; the
 * verify and evidence built-ins are stubbed too, since what they publish is not under test.
 *
 * The operator's report (implement-ticket-mvquko8): probe CHANGES_REQUIRED → address_reviews
 * finds every thread already fixed and one answered, changes nothing → parked `no-progress`
 * ("another review would judge the same code"). Now: repair_check → wait → probe, no park.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { implementTicket } from "./implement-ticket";
import { Engine, type AttemptResult, type Executor } from "../engine/run";
import { commandExecutor, type PrProbeResult, type PrState } from "../engine/executors/worktree";
import { Reconciler } from "../engine/reconcile";
import { commit, lonelyRepo } from "../engine/executors/git-testkit";
import { replyVerdict } from "../engine/control";
import type { LoggedEvent } from "../log/events";

const PROMPTS = join(import.meta.dir, "..", "prompts");
const PR = "https://github.com/acme/app/pull/9";
const ok = (writes: Record<string, unknown> = {}): AttemptResult => ({ status: "succeeded", writes });
const savedHome = process.env.HOWDAH_HOME;
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOWDAH_HOME;
  else process.env.HOWDAH_HOME = savedHome;
});

type Probe = (since: string | null, n: number) => Partial<PrProbeResult> & { state: PrState };

/** the run, scripted: what each probe answers and whether a repair commits */
function deliveryRun(o: { probes: Probe[]; repairCommits?: (node: string, visit: number) => boolean; onRepair?: (repo: string) => void; summary?: string }) {
  const repo = lonelyRepo();
  const home = mkdtempSync(join(tmpdir(), "howdah-how75-"));
  process.env.HOWDAH_HOME = home;
  const dir = join(home, "runs", "how75-run");
  const sinces: Array<string | null> = [];
  let probes = 0;
  const real = commandExecutor({
    prProbe: (_cwd, _ref, since = null) => {
      sinces.push(since);
      const p = o.probes[Math.min(probes, o.probes.length - 1)]!(since, probes++);
      return { url: PR, activity: [], skipped: { bot: 0, howdah: 0 }, ...p };
    },
  });
  const command: Executor = async (args) =>
    args.nodeId === "verify.run" ? ok({ "verify.result": { outcome: "pass", command: "t", exit_code: 0, commit: "x", dirty: false, output_tail: "" } })
    : args.nodeId === "implementation.evidence" ? ok({ "evidence.items": { outcome: "not-checked", items: [], reason: "stub" } })
    : real(args);
  const agent: Executor = async ({ nodeId, visit }) => {
    switch (nodeId) {
      case "implementation.plan": return ok({ implementation_plan: "plan" });
      case "implementation.criteria": return ok({ acceptance: [{ id: "ac-1", text: "works", source: "plan", passes: false, evidence: null }] });
      case "implementation.implement":
        commit(repo, "feature.ts", "export const f = 1;\n", "feature");
        return ok({ implementation_summary: "built" });
      case "implementation.local_review":
        return ok({ review_verdict: "pass", review_findings: [], acceptance: [{ id: "ac-1", text: "works", source: "plan", passes: true, evidence: { kind: "verify.result" } }] });
      case "delivery.publish": return ok({ publication_summary: `PR ${PR}` });
      case "delivery.review_repairs": return ok({ review_verdict: "pass", review_findings: [] });
      case "complete_ticket": return ok({ completion_summary: "done" });
      case "delivery.address_reviews":
      case "delivery.fix_ci":
      case "delivery.resolve_conflicts":
        o.onRepair?.(repo);
        if (o.repairCommits?.(nodeId, visit)) commit(repo, `fix-${visit}.ts`, `export const v = ${visit};\n`, `${nodeId}@${visit}`);
        return ok({ repair_summary: o.summary ?? "Every thread was already fixed; replied on the naming thread.\nMore detail here." });
      default: throw new Error(`unscripted agent ${nodeId}`);
    }
  };
  const engine = (): Engine => {
    const e: Engine = new Engine(implementTicket, {
      dir, cwd: repo, folderKind: "repo", promptsDir: PROMPTS,
      // the CLI's reconciler seat (cli/main.ts reconcilerHook): git is probed before every node
      beforeNode: async (nodeId, def) => {
        const r = await new Reconciler(repo).reconcile(def);
        e.log.append({ type: "reconciled", node: nodeId, git: r.git, intended: undefined, disagreements: r.disagreements });
      },
      executors: {
        agent, command, wait: async () => ok(),
        worktree: async ({ nodeId }) => ok(nodeId.startsWith("cleanup") ? { "worktree.clean": true } : { "worktree.verify_command": "", "worktree.preview_paths": "" }),
      },
    });
    return e;
  };
  return { repo, dir, engine, sinces, events: () => engine().log.read() };
}

const started = (events: LoggedEvent[]) => events.flatMap((e) => (e.type === "node-started" ? [e.node] : []));
const asks = (events: LoggedEvent[]) => events.filter((e): e is Extract<LoggedEvent, { type: "attention-raised" }> => e.type === "attention-raised");
const START = { goal: "fix it", work: "HOW-75" };

describe("HOW-75: a repair that rightly changes nothing", () => {
  test("probe CHANGES_REQUIRED → address_reviews changes nothing → no park → wait → probe, and the thread says why", async () => {
    const run = deliveryRun({ probes: [() => ({ state: "CHANGES_REQUIRED", reviewDecision: "CHANGES_REQUESTED" }), () => ({ state: "OPEN" }), () => ({ state: "MERGED" })] });
    expect(await run.engine().start(START)).toEqual({ state: "finished", outcome: "success" });
    const events = run.events();
    expect(asks(events)).toEqual([]);
    const order = started(events);
    const at = order.indexOf("delivery.address_reviews");
    expect(order.slice(at, at + 4)).toEqual(["delivery.address_reviews", "delivery.repair_check", "delivery.wait", "delivery.probe_pr"]);
    // nothing to judge and nothing to push
    expect(order).not.toContain("delivery.review_repairs");
    expect(order.filter((n) => n === "delivery.publish")).toHaveLength(1);
    const check = events.find((e) => e.type === "node-finished" && e.node === "delivery.repair_check");
    expect(check?.type === "node-finished" && check.writes).toEqual({ "repair.changed": false });
    const note = events.find((e) => e.type === "chunk" && e.node === "delivery.repair_check");
    expect(note?.type === "chunk" && note.content).toContain(
      "delivery.address_reviews@1 made no change: Every thread was already fixed; replied on the naming thread.; waiting for the PR to move",
    );
    // the repair is no longer HOW-54 progress-checked: no tree recorded on its node-finished
    const repair = events.find((e) => e.type === "node-finished" && e.node === "delivery.address_reviews");
    expect(repair?.type === "node-finished" && repair.tree).toBeUndefined();
  });

  test("a repair that DOES commit still goes repair_check → review_repairs → publish", async () => {
    const run = deliveryRun({ probes: [() => ({ state: "CI_FAILED" }), () => ({ state: "MERGED" })], repairCommits: () => true });
    expect(await run.engine().start(START)).toEqual({ state: "finished", outcome: "success" });
    const events = run.events();
    const order = started(events);
    const at = order.indexOf("delivery.fix_ci");
    expect(order.slice(at, at + 4)).toEqual(["delivery.fix_ci", "delivery.repair_check", "delivery.review_repairs", "delivery.publish"]);
    const check = events.find((e) => e.type === "node-finished" && e.node === "delivery.repair_check");
    expect(check?.type === "node-finished" && check.writes).toEqual({ "repair.changed": true });
    expect(asks(events)).toEqual([]);
  });

  test("an uncommitted edit counts as a change — it goes to review, never silently left behind", async () => {
    const run = deliveryRun({ probes: [() => ({ state: "CONFLICTS" }), () => ({ state: "MERGED" })], onRepair: (repo) => writeFileSync(join(repo, "loose.ts"), "x\n") });
    expect(await run.engine().start(START)).toEqual({ state: "finished", outcome: "success" });
    const check = run.events().find((e) => e.type === "node-finished" && e.node === "delivery.repair_check");
    expect(check?.type === "node-finished" && check.writes).toEqual({ "repair.changed": true });
  });
});

describe("HOW-75: a probe that keeps demanding the repair that changed nothing parks — at the probe", () => {
  const awaiting = [{ pr: PR, url: `${PR}#discussion_r1`, path: "src/release.ts", line: 12, reviewer: "rita" }];

  test("a standing CHANGES_REQUESTED with nothing new on the PR parks repair-stalled, saying what is outstanding and how to go on", async () => {
    const run = deliveryRun({ probes: [() => ({ state: "CHANGES_REQUIRED", reviewDecision: "CHANGES_REQUESTED", awaiting, lastReviewAt: "2020-01-01T00:00:00Z" })] });
    const r = await run.engine().start(START);
    expect(r.state).toBe("parked");
    const events = run.events();
    const [ask] = asks(events);
    expect(ask?.code).toBe("repair-stalled");
    expect(ask?.node).toBe("delivery.probe_pr");
    expect(ask?.reason).toContain(PR);
    expect(ask?.reason).toContain("CHANGES_REQUESTED");
    expect(ask?.reason).toContain("delivery.address_reviews@1 made no change");
    expect(ask?.reason).toContain(`src/release.ts:12 ${PR}#discussion_r1, answered and waiting on rita`);
    expect(ask?.reason).toContain("Retry this step");
    expect(ask?.reason).toContain("jump how75-run delivery.address_reviews");
    expect(ask?.reason).toContain("abort how75-run");
    expect(ask?.reason).not.toContain("another review would judge the same code");
    // the repair ran once and was never reviewed or re-published
    expect(started(events).filter((n) => n === "delivery.address_reviews")).toHaveLength(1);
    expect(started(events)).not.toContain("delivery.review_repairs");
    // a reply cannot reach a command step: refused verbatim, with "Retry this step" as the remedy
    const verdict = replyVerdict(events, "how75-run", { "implement-ticket": implementTicket });
    expect(verdict?.accept).toBe(false);
    if (verdict && !verdict.accept) {
      expect(verdict.code).toBe("repair-stalled");
      expect(verdict.retry).toBe(true);
      expect(verdict.message).toContain("Retry this step");
    }
  });

  test("a review submitted since the repair started is new input: address_reviews runs again instead", async () => {
    const run = deliveryRun({
      probes: [
        () => ({ state: "CHANGES_REQUIRED", reviewDecision: "CHANGES_REQUESTED" }),
        (since) => ({ state: "CHANGES_REQUIRED", reviewDecision: "CHANGES_REQUESTED", lastReviewAt: new Date(Date.parse(since!) + 1000).toISOString() }),
        () => ({ state: "MERGED" }),
      ],
    });
    expect(await run.engine().start(START)).toEqual({ state: "finished", outcome: "success" });
    const events = run.events();
    expect(asks(events)).toEqual([]);
    expect(started(events).filter((n) => n === "delivery.address_reviews")).toHaveLength(2);
  });

  test("CI still failing after a fix_ci that changed nothing parks too, pointing at the checks", async () => {
    const run = deliveryRun({ probes: [() => ({ state: "CI_FAILED" })] });
    expect((await run.engine().start(START)).state).toBe("parked");
    const [ask] = asks(run.events());
    expect(ask?.code).toBe("repair-stalled");
    expect(ask?.reason).toContain(`${PR}/checks`);
    expect(ask?.reason).toContain("delivery.fix_ci@1 made no change");
  });
});
