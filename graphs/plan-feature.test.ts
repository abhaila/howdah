/**
 * plan-feature (HOW-23) — the multi-graph workflow, driven end to end over the slice fixture
 * repo with real map built-ins, a real approval executor and real decision verbs. The agents
 * are scripted in-process and the only thing faked is the SPAWN: a real launch would start N
 * agent runs that spend tokens.
 *
 * What these tests are about is the operator's control over a fan-out before it costs
 * anything — approve, send back with feedback, redesign, and a plan the graph refuses — plus
 * the two endings (the planning worktree cleaned up, or retained because it is dirty).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { planFeature, validatePlanProposal } from "./plan-feature";
import { GRAPHS } from "./index";
import { Engine, resolveAgentConfig, type AttemptResult, type Executor } from "../engine/run";
import { approvalExecutor } from "../engine/executors/approval";
import { commandExecutor } from "../engine/executors/worktree";
import { approve, pinComment, redesign, sendFeedback } from "../engine/control";
import { EventLog } from "../log/write";
import type { LoggedEvent } from "../log/events";
import { saveConfig, type HowdahConfig } from "../config/config";
import { sliceRepo, commitAll, SLICE_GOAL, SLICE_WORK } from "./slice-fixture";
import { LAUNCH_PRODUCES, LAUNCH_READS, type WorkspaceLookup } from "../engine/executors/launch";

const PROMPTS = join(dirname(import.meta.dir), "prompts");
const ok = (writes: Record<string, unknown> = {}): AttemptResult => ({ status: "succeeded", writes });
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

// validatePlanProposal reads the registered workspaces from $HOWDAH_HOME, so every run points
// it at its own temp home — restored after each test
const ORIGINAL_HOME = process.env.HOWDAH_HOME;
afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOWDAH_HOME;
  else process.env.HOWDAH_HOME = ORIGINAL_HOME;
});

const PLAN = {
  feature: "let users delete their account",
  slices: [
    { id: "api-delete", title: "DELETE /api/users/{id}", goal: "the route exists", work: "add the route and its handler", verify: "curl it", depends_on: [] },
    { id: "web-delete", title: "Call it from the web client", goal: "the client can delete", work: "add deleteUser", verify: "click delete", depends_on: ["api-delete"] },
  ],
  out_of_scope: ["the admin UI"],
  risks: [],
};

const TICKETS = {
  tickets: [
    { slice_id: "api-delete", identifier: "HOW-31", url: "https://linear.app/h/issue/HOW-31", title: "DELETE /api/users/{id}" },
    { slice_id: "web-delete", identifier: "HOW-32", url: "https://linear.app/h/issue/HOW-32", title: "Call it from the web client" },
  ],
};

interface Script {
  /** the plans plan.propose returns, in order (the last repeats) */
  proposals?: unknown[];
  /** what tickets.create returns (default: one ticket per slice of PLAN) */
  tickets?: unknown;
  /** runs inside every plan.propose attempt — e.g. a proposer that moves the worktree */
  onPropose?: (repo: string, visit: number) => void;
  /** the planning worktree is dirty, so cleanup refuses to remove it */
  dirtyWorktree?: boolean;
  workspaces?: WorkspaceLookup;
}

function planRun(script: Script = {}) {
  const { dir: repo } = sliceRepo();
  const home = tmp("howdah-plan-home-");
  process.env.HOWDAH_HOME = home;
  saveConfig({ repos: { api: { path: repo }, web: { path: "/elsewhere/web" } }, folders: {} } satisfies HowdahConfig, home);
  const runDir = join(home, "runs", "plan-run");
  const runsDir = join(home, "runs");
  const proposals = [...(script.proposals ?? [PLAN])];
  const prompts: Array<{ node: string; visit: number; prompt: string }> = [];
  const spawned: string[][] = [];

  const agent: Executor = async ({ nodeId, visit, renderedPrompt }) => {
    prompts.push({ node: nodeId, visit, prompt: renderedPrompt ?? "" });
    if (nodeId === "plan.propose") {
      script.onPropose?.(repo, visit);
      return ok({ "plan.slices": proposals.length > 1 ? proposals.shift() : proposals[0] });
    }
    if (nodeId === "tickets.create") return ok({ tickets: script.tickets ?? TICKETS });
    throw new Error(`unscripted agent node ${nodeId}`);
  };
  const command = commandExecutor({
    map: { workers: 0 },
    launch: {
      runsDir,
      workspaces: script.workspaces ?? { repoNames: () => ["api", "web"], nameFor: (p) => (p === repo ? "api" : p === "/elsewhere/web" ? "web" : null) },
      spawn: (argv) => void spawned.push(argv),
    },
  });
  const worktree: Executor = async ({ nodeId }) =>
    ok(nodeId === "cleanup" ? { "worktree.clean": !script.dirtyWorktree } : {});
  const engine = () =>
    new Engine(planFeature, {
      dir: runDir, cwd: repo, folderKind: "repo", promptsDir: PROMPTS,
      executors: { agent, command, worktree, approval: approvalExecutor, wait: async () => ok() },
    });
  return { repo, home, runDir, runsDir, engine, prompts, spawned, events: () => engine().log.read() };
}

const INPUTS = { goal: SLICE_GOAL, work: SLICE_WORK };
const started = (events: LoggedEvent[]) => events.flatMap((e) => (e.type === "node-started" ? [e.node] : []));
const visitsOf = (events: LoggedEvent[], node: string) => events.flatMap((e) => (e.type === "node-started" && e.node === node ? [e.visit] : []));
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];

describe("the graph itself", () => {
  test("plan-feature is registered and passes structure + the MUST-analysis", () => {
    expect(GRAPHS["plan-feature"]).toBe(planFeature);
    expect(planFeature.validate()).toEqual({ structural: [], paths: [] });
  });

  test("plan.propose resolves read-only even when the run asks for bypassPermissions", () => {
    const def = planFeature.def.nodes["plan.propose"];
    if (def?.kind !== "agent") throw new Error("plan.propose must be an agent node");
    expect(resolveAgentConfig(planFeature, def, "plan.propose", { overrides: { permissionMode: "bypassPermissions" } }).permissionMode).toBe("plan");
  });

  test("the approval owns the feedback key and redesigns into map.extract, which must not declare it", () => {
    expect(planFeature.writesOf("map.extract")["plan.feedback"]?.scope).toBe("sticky"); // engine-owned (D22)
    const extract = planFeature.def.nodes["map.extract"];
    expect(extract?.kind === "command" && extract.writes && "plan.feedback" in extract.writes).toBe(false);
  });

  test("tickets.create is gated on the approval, and the launch reads exactly what the built-in reads", () => {
    const tickets = planFeature.def.nodes["tickets.create"];
    expect(tickets?.kind === "agent" && tickets.requires?.approvalOf).toBe("plan.approve");
    const launch = planFeature.def.nodes["runs.launch"];
    expect(launch?.kind === "command" && launch.run).toBe("runs:launch");
    expect(launch?.kind === "command" && launch.reads).toEqual(["plan.slices", "tickets"]);
  });

  /**
   * HOW-23 review. The built-in now refuses a node whose declaration it cannot honour, BEFORE
   * it spawns anything — so the shipped graph has to satisfy both halves, or the one workflow
   * the ticket is about would park on its most expensive step.
   */
  test("the launch step declares exactly what the built-in reads and exactly what it produces", () => {
    const launch = planFeature.def.nodes["runs.launch"];
    if (launch?.kind !== "command") throw new Error("runs.launch must be a command node");
    for (const key of LAUNCH_READS) expect(launch.reads, key).toContain(key);
    expect(Object.keys(launch.writes ?? {})).toEqual([...LAUNCH_PRODUCES]);
  });
});

describe("the approved path: one ticket per slice, one run per ticket", () => {
  test("approve → tickets → launch → cleanup → launched, with a child run per slice", async () => {
    const run = planRun();
    expect(await run.engine().start(INPUTS)).toMatchObject({ state: "parked", node: "plan.approve", code: "awaiting-approval" });
    expect(run.spawned).toEqual([]); // nothing is launched before a human says so

    expect(approve(run.runDir)).toMatchObject({ ok: true });
    expect(await run.engine().resume()).toEqual({ state: "finished", outcome: "success" });

    const events = run.events();
    expect(started(events)).toEqual([
      "create_worktree", "map.extract", "plan.propose", "plan.approve", "plan.approve", "tickets.create", "runs.launch", "cleanup",
    ]);
    expect(events.find((e) => e.type === "run-finished")).toMatchObject({ outcome: "success" });

    expect(run.spawned.map((a) => flag(a, "--id"))).toEqual(["plan-run--api-delete", "plan-run--web-delete"]);
    expect(run.spawned.every((a) => a[1] === "implement-ticket" && flag(a, "--parent") === "plan-run")).toBe(true);
    expect(events.filter((e) => e.type === "run-spawned")).toMatchObject([
      { child: "plan-run--api-delete", slice_id: "api-delete", ticket: "HOW-31", graph: "implement-ticket" },
      { child: "plan-run--web-delete", slice_id: "web-delete", ticket: "HOW-32" },
    ]);

    const launched = events.findLast((e) => e.type === "node-finished" && e.node === "runs.launch");
    expect(launched?.type === "node-finished" && launched.writes.launched).toMatchObject({ launched: [{ run_id: "plan-run--api-delete" }, { run_id: "plan-run--web-delete" }], skipped: [] });
  }, 60000);

  test("the ticket step sees the approved plan and the approval; the launcher is not an agent at all", async () => {
    const run = planRun();
    await run.engine().start(INPUTS);
    approve(run.runDir);
    await run.engine().resume();
    const tickets = run.prompts.find((p) => p.node === "tickets.create")!.prompt;
    expect(tickets).toContain("api-delete");
    expect(tickets).toContain("web-delete");
    expect(tickets).toContain('"outcome":"approved"');
    expect(run.prompts.some((p) => p.node === "runs.launch")).toBe(false);
  }, 60000);

  test("a dirty planning worktree keeps the folder and ends cleanup_pending — after the children are launched", async () => {
    const run = planRun({ dirtyWorktree: true });
    await run.engine().start(INPUTS);
    approve(run.runDir);
    expect(await run.engine().resume()).toEqual({ state: "finished", outcome: "failed" });
    expect(run.spawned).toHaveLength(2); // the fan-out happened; only the scratch folder is retained
    expect(run.events().some((e) => e.type === "edge-taken" && e.to === "cleanup_pending")).toBe(true);
  }, 60000);
});

describe("the operator steers the decomposition before anything is built", () => {
  test("feedback sends the plan back and the redraw is a new round the proposer can answer", async () => {
    const redraft = { ...PLAN, slices: [{ ...PLAN.slices[0]!, work: "add the route, its handler and its tests" }] };
    const run = planRun({ proposals: [PLAN, redraft] });
    await run.engine().start(INPUTS);

    const events = run.events();
    const round = events.find((e) => e.type === "ghost-proposed")!;
    expect(round.type === "ghost-proposed" && round.approval).toBe("plan.approve");
    pinComment(run.runDir, "web-delete", "fold this into the first slice");
    expect(sendFeedback(run.runDir)).toMatchObject({ ok: true });

    expect(await run.engine().resume()).toMatchObject({ state: "parked", node: "plan.approve", code: "awaiting-approval" });
    expect(run.events().filter((e) => e.type === "ghost-proposed")).toHaveLength(2);
    expect(run.spawned).toEqual([]);

    // the second draft was TOLD what the operator pinned, on the slice id it was pinned to
    const second = run.prompts.filter((p) => p.node === "plan.propose")[1]!.prompt;
    expect(second).toContain("fold this into the first slice");
    expect(second).toContain("web-delete");
  }, 60000);

  test("a redesign message re-extracts the map and reaches the next draft", async () => {
    const run = planRun();
    await run.engine().start(INPUTS);
    expect(redesign(run.runDir, "slice by module, not by layer", { graphs: GRAPHS })).toMatchObject({ ok: true, jumped_to: "map.extract" });
    expect(await run.engine().resume()).toMatchObject({ state: "parked", node: "plan.approve", code: "awaiting-approval" });
    expect(visitsOf(run.events(), "map.extract")).toEqual([1, 2]);
    expect(run.prompts.filter((p) => p.node === "plan.propose")[1]!.prompt).toContain("slice by module, not by layer");
  }, 60000);

  test("a worktree that moved while the proposer ran is STALE, not approved — back to map.extract", async () => {
    let moved = false;
    const run = planRun({
      onPropose: (repo) => {
        if (moved) return;
        moved = true;
        writeFileSync(join(repo, "NOTES.md"), "the tree moved under the plan\n");
        commitAll(repo, "move the tree");
      },
    });
    await run.engine().start(INPUTS);
    const order = started(run.events());
    expect(order.slice(0, 5)).toEqual(["create_worktree", "map.extract", "plan.propose", "plan.approve", "map.extract"]);
    expect(run.events().some((e) => e.type === "edge-taken" && e.from === "plan.approve" && e.to === "map.extract")).toBe(true);
  }, 60000);

  test("a base that keeps moving parks map.extract on its maxVisits instead of looping forever", async () => {
    let n = 0;
    const run = planRun({
      onPropose: (repo) => {
        writeFileSync(join(repo, `NOTE-${++n}.md`), "moved again\n");
        commitAll(repo, `move ${n}`);
      },
    });
    const result = await run.engine().start(INPUTS);
    expect(result).toMatchObject({ state: "parked", node: "map.extract", code: "max-visits" });
    expect(visitsOf(run.events(), "map.extract")).toEqual([1, 2, 3, 4, 5]);
    expect(run.spawned).toEqual([]);
  }, 120000);
});

describe("a plan the graph refuses never reaches the operator", () => {
  test("the proposer attempt fails with the validator's reasons, and its retry is told them", async () => {
    const bad = { feature: "f", slices: [{ id: "Not A Slug", title: "t", goal: "g", work: "w", verify: "v", depends_on: [] }] };
    const run = planRun({ proposals: [bad, PLAN] });
    const result = await run.engine().start(INPUTS);
    expect(result).toMatchObject({ state: "parked", node: "plan.propose", code: "attempt-failed" });
    expect((result as { reason: string }).reason).toContain("is not a slug");
    expect(run.events().some((e) => e.type === "ghost-proposed")).toBe(false);

    const refused = run.events().findLast((e) => e.type === "node-finished" && e.node === "plan.propose");
    expect(refused?.type === "node-finished" && refused.refused).toContain("child run id");

    expect(await run.engine().resume()).toMatchObject({ state: "parked", node: "plan.approve", code: "awaiting-approval" });
    expect(run.prompts.filter((p) => p.node === "plan.propose")[1]!.prompt).toContain("is not a slug");
  }, 60000);

  test("a slice naming an unregistered workspace is refused at proposal time — what is approved is launchable", () => {
    const home = tmp("howdah-plan-cfg-");
    process.env.HOWDAH_HOME = home;
    saveConfig({ repos: { api: { path: "/repos/api" } }, folders: {} } satisfies HowdahConfig, home);
    const refusal = validatePlanProposal({ ...PLAN, slices: [{ ...PLAN.slices[0]!, workspace: "mobile" }] });
    expect(refusal).toContain('workspace "mobile" is not registered');
    expect(refusal).toContain("api");
    expect(validatePlanProposal(PLAN)).toBeNull();
  });
});

describe("the approval gate on tickets.create", () => {
  test("a jump straight onto the ticket step is refused without consuming a visit or touching the tracker", async () => {
    const run = planRun();
    expect(await run.engine().start(INPUTS)).toMatchObject({ state: "parked", node: "plan.approve" });
    // what `howdah jump` appends: the runner is dead and nobody approved anything
    new EventLog(join(run.runDir, "run.jsonl")).append({ type: "operator-jump", to: "tickets.create", message: "just raise them", reset_budgets: true });

    const result = await run.engine().resume();
    expect(result).toMatchObject({ state: "parked", node: "tickets.create", code: "approval-missing" });
    expect((result as { reason: string }).reason).toContain("is undecided");
    expect(visitsOf(run.events(), "tickets.create")).toEqual([]); // refused BEFORE node-started
    expect(run.prompts.some((p) => p.node === "tickets.create")).toBe(false);
    expect(run.spawned).toEqual([]);
  }, 60000);
});

describe("the launcher's refusals park the run with nothing half-launched", () => {
  test("a ticket step that skipped a slice fails runs.launch, naming it, and launches nothing", async () => {
    const run = planRun({ tickets: { tickets: [TICKETS.tickets[0]] } });
    await run.engine().start(INPUTS);
    approve(run.runDir);
    const result = await run.engine().resume();
    expect(result).toMatchObject({ state: "parked", node: "runs.launch", code: "attempt-failed" });
    expect((result as { reason: string }).reason).toContain('slice "web-delete" was approved but no ticket was raised for it');
    expect(run.spawned).toEqual([]);
    expect(run.events().some((e) => e.type === "run-spawned")).toBe(false);
  }, 60000);
});
