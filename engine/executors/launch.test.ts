/**
 * `runs:launch` (HOW-23) — the fan-out built-in, driven through the real command executor so
 * the dispatch is covered too. Nothing here spawns a real engine: the `spawn` seam records
 * argv instead, which is the only safe way to test a step whose job is starting agent runs.
 *
 * The assertions that matter are the ones about NOT launching: a plan and its tickets that do
 * not line up, a workspace nothing could be built in, and a second attempt of a node that
 * already launched. A double launch costs a duplicate PR and a second harness allowance.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../../log/write";
import type { LoggedEvent } from "../../log/events";
import { commandExecutor } from "./worktree";
import { childRunId, isLaunchBuiltin, launchOrder, type LaunchResult, type WorkspaceLookup } from "./launch";
import type { AttemptResult } from "../run";
import type { NodeDef } from "../../core/graph";

const REPO = "/repos/api";
const WORKSPACES: WorkspaceLookup = { repoNames: () => ["api", "web"], nameFor: (p) => (p === REPO ? "api" : p === "/repos/web" ? "web" : null) };

const slice = (over: Record<string, unknown> = {}) => ({
  id: "add-endpoint",
  title: "Add the endpoint",
  goal: "a caller can POST /things",
  work: "scope: the route and its handler",
  verify: "curl it and see a 201",
  depends_on: [],
  ...over,
});

const ticket = (over: Record<string, unknown> = {}) => ({
  slice_id: "add-endpoint",
  identifier: "HOW-31",
  url: "https://linear.app/h/issue/HOW-31",
  title: "Add the endpoint",
  ...over,
});

const NODE: NodeDef<any> = {
  kind: "command",
  run: "runs:launch",
  reads: ["plan.slices", "tickets"],
  writes: { launched: { scope: "sticky" } },
} as NodeDef<any>;

interface Harness {
  dir: string;
  runsDir: string;
  log: EventLog;
  spawned: string[][];
  events: () => LoggedEvent[];
  run: (reads: Record<string, unknown>, over?: { def?: NodeDef<any>; runId?: string; cwd?: string }) => Promise<AttemptResult>;
}

/** one parent run dir, a recording spawn seam, and the real command executor over both */
function harness(opts: { workspaces?: WorkspaceLookup; overrides?: Record<string, unknown> } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "howdah-launch-"));
  const runsDir = join(dir, "runs");
  const runId = "plan-feature-abc";
  const log = new EventLog(join(runsDir, runId, "run.jsonl"));
  log.append({
    type: "run-started", graph: "plan-feature", inputs: { goal: "g" }, pinned_prompts: {},
    cwd: REPO, folder_kind: "repo", ...(opts.overrides ? { overrides: opts.overrides as never } : {}),
  });
  const spawned: string[][] = [];
  const exec = commandExecutor({
    launch: { runsDir, workspaces: opts.workspaces ?? WORKSPACES, spawn: (argv) => void spawned.push(argv) },
  });
  const done = new Set<string>();
  return {
    dir, runsDir, log, spawned,
    events: () => log.read(),
    run: (reads, over = {}) =>
      exec({
        nodeId: "runs.launch",
        def: over.def ?? NODE,
        visit: 1,
        attemptId: "runs.launch#1",
        runId: over.runId ?? runId,
        cwd: over.cwd ?? REPO,
        log,
        reads,
        effects: {
          // the engine's own handle: claim() answers "already proven done" and otherwise
          // records the intent; done() records the proof
          claim: (effect) => {
            if (done.has(effect)) return true;
            log.append({ type: "side-effect-intent", node: "runs.launch", visit: 1, attempt_id: "runs.launch#1", effect });
            return false;
          },
          done: (effect, result) => {
            done.add(effect);
            log.append({ type: "side-effect-done", node: "runs.launch", visit: 1, attempt_id: "runs.launch#1", effect, result });
          },
        },
      }) as Promise<AttemptResult>,
  };
}

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

const input = (argv: string[], key: string): string | undefined => {
  for (let i = 0; i < argv.length; i++) if (argv[i] === "-i" && argv[i + 1]?.startsWith(`${key}=`)) return argv[i + 1]!.slice(key.length + 1);
  return undefined;
};

/** a child run that already exists on disk — what a re-attempt must see */
function seedChild(runsDir: string, id: string): void {
  mkdirSync(join(runsDir, id), { recursive: true });
  writeFileSync(join(runsDir, id, "run.jsonl"), "");
}

const launched = (r: AttemptResult): LaunchResult => r.writes.launched as LaunchResult;

describe("dispatch", () => {
  test("only `runs:launch` is the built-in", () => {
    expect(isLaunchBuiltin("runs:launch")).toBe(true);
    expect(isLaunchBuiltin("  runs:launch  ")).toBe(true);
    expect(isLaunchBuiltin("runs:launcher")).toBe(false);
    expect(isLaunchBuiltin("bun runs:launch")).toBe(false);
  });
});

describe("the argv a child is launched with", () => {
  test("one implement-ticket run per slice, with the ticket as its work and a deterministic id", async () => {
    const h = harness();
    const r = await h.run({ "plan.slices": { feature: "things end to end", slices: [slice()] }, tickets: { tickets: [ticket()] } });

    expect(r.status).toBe("succeeded");
    expect(h.spawned).toHaveLength(1);
    const argv = h.spawned[0]!;
    expect(argv.slice(0, 2)).toEqual(["run", "implement-ticket"]);
    expect(flag(argv, "--id")).toBe("plan-feature-abc--add-endpoint");
    expect(flag(argv, "--parent")).toBe("plan-feature-abc");
    expect(flag(argv, "--workspace")).toBe("api");
    expect(flag(argv, "--name")).toBe("HOW-31 Add the endpoint");
    expect(argv).not.toContain("--dir"); // --dir would make the child PLAIN, with no worktree
    expect(input(argv, "goal")).toBe("a caller can POST /things (one vertical slice of: things end to end)");
    const work = input(argv, "work")!;
    expect(work).toContain("HOW-31: Add the endpoint");
    expect(work).toContain("https://linear.app/h/issue/HOW-31");
    expect(work).toContain("scope: the route and its handler");
    expect(work).toContain("How to verify:\ncurl it and see a 201");
  });

  test("the child id is the parent's plus the slice id", () => {
    expect(childRunId("plan-feature-abc", "add-endpoint")).toBe("plan-feature-abc--add-endpoint");
  });

  test("a slice's own workspace wins; one without inherits the parent's registered workspace", async () => {
    const h = harness();
    await h.run({
      "plan.slices": { feature: "f", slices: [slice({ id: "api-bit" }), slice({ id: "web-bit", workspace: "web" })] },
      tickets: { tickets: [ticket({ slice_id: "api-bit" }), ticket({ slice_id: "web-bit", identifier: "HOW-32" })] },
    });
    expect(h.spawned.map((a) => flag(a, "--workspace"))).toEqual(["api", "web"]);
  });

  test("a dependency is recorded in the ticket body as prose — nothing waits on it", async () => {
    const h = harness();
    await h.run({
      "plan.slices": { feature: "f", slices: [slice({ id: "base" }), slice({ id: "on-top", depends_on: ["base"] })], out_of_scope: ["the admin UI"] },
      tickets: { tickets: [ticket({ slice_id: "base" }), ticket({ slice_id: "on-top", identifier: "HOW-32" })] },
    });
    const work = input(h.spawned[1]!, "work")!;
    expect(work).toContain("Depends on other slices of this feature (each has its own ticket and PR): base");
    expect(work).toContain("Out of scope for the whole feature: the admin UI");
  });

  test("dependencies launch first, whatever order the plan listed them in", async () => {
    const h = harness();
    await h.run({
      "plan.slices": { feature: "f", slices: [slice({ id: "on-top", depends_on: ["base"] }), slice({ id: "base" })] },
      tickets: { tickets: [ticket({ slice_id: "on-top" }), ticket({ slice_id: "base", identifier: "HOW-32" })] },
    });
    expect(h.spawned.map((a) => flag(a, "--id"))).toEqual(["plan-feature-abc--base", "plan-feature-abc--on-top"]);
  });

  test("the parent's harness and model reach every child; its permission mode does not", async () => {
    const h = harness({ overrides: { harness: "codex", model: "gpt-5", permissionMode: "plan" } });
    await h.run({ "plan.slices": { feature: "f", slices: [slice()] }, tickets: { tickets: [ticket()] } });
    const argv = h.spawned[0]!;
    expect(flag(argv, "--harness")).toBe("codex");
    expect(flag(argv, "--model")).toBe("gpt-5");
    // inheriting `plan` would hand a child a mode in which it cannot edit a file
    expect(argv).not.toContain("--permission-mode");
  });

  test("a title too long to be a run name still launches, labelled with what fits", async () => {
    const h = harness();
    await h.run({
      "plan.slices": { feature: "f", slices: [slice()] },
      tickets: { tickets: [ticket({ title: "x".repeat(200) })] },
    });
    expect(h.spawned).toHaveLength(1);
    expect(flag(h.spawned[0]!, "--name")).toBe("HOW-31");
  });

  test("with no usable label at all the run still starts, named for its slice", async () => {
    const h = harness();
    await h.run({
      "plan.slices": { feature: "f", slices: [slice()] },
      tickets: { tickets: [ticket({ identifier: "H".repeat(200), title: "y".repeat(200) })] },
    });
    expect(h.spawned).toHaveLength(1);
    expect(flag(h.spawned[0]!, "--name")).toBe("add-endpoint");
  });
});

describe("exactly-once", () => {
  test("every launch writes intent before and proof after", async () => {
    const h = harness();
    await h.run({ "plan.slices": { feature: "f", slices: [slice()] }, tickets: { tickets: [ticket()] } });
    const effects = h.events().filter((e) => e.type === "side-effect-intent" || e.type === "side-effect-done");
    expect(effects.map((e) => [e.type, (e as { effect: string }).effect])).toEqual([
      ["side-effect-intent", "launch-run:plan-feature-abc--add-endpoint"],
      ["side-effect-done", "launch-run:plan-feature-abc--add-endpoint"],
    ]);
  });

  test("a child that already has a run dir is skipped, not relaunched", async () => {
    const h = harness();
    seedChild(h.runsDir, "plan-feature-abc--add-endpoint");
    const r = await h.run({
      "plan.slices": { feature: "f", slices: [slice(), slice({ id: "second" })] },
      tickets: { tickets: [ticket(), ticket({ slice_id: "second", identifier: "HOW-32" })] },
    });
    expect(h.spawned.map((a) => flag(a, "--id"))).toEqual(["plan-feature-abc--second"]);
    expect(launched(r).skipped).toEqual([
      { slice_id: "add-endpoint", run_id: "plan-feature-abc--add-endpoint", reason: "run plan-feature-abc--add-endpoint already exists" },
    ]);
    expect(launched(r).launched).toMatchObject([{ slice_id: "second", ticket: "HOW-32", run_id: "plan-feature-abc--second", workspace: "api" }]);
    // nothing was claimed for the skipped one, so it leaves no ambiguous intent behind
    expect(h.events().filter((e) => e.type === "side-effect-intent")).toHaveLength(1);
  });

  test("a second attempt of the same node re-launches nothing", async () => {
    const h = harness();
    const reads = { "plan.slices": { feature: "f", slices: [slice()] }, tickets: { tickets: [ticket()] } };
    await h.run(reads);
    const again = await h.run(reads);
    expect(h.spawned).toHaveLength(1);
    expect(launched(again).launched).toEqual([]);
    expect(launched(again).skipped[0]!.reason).toContain("already launched by an earlier attempt of runs.launch");
    expect(h.events().filter((e) => e.type === "run-spawned")).toHaveLength(1);
  });

  test("one run-spawned per child, naming the slice, the ticket and the workspace", async () => {
    const h = harness();
    await h.run({
      "plan.slices": { feature: "f", slices: [slice(), slice({ id: "second", workspace: "web" })] },
      tickets: { tickets: [ticket(), ticket({ slice_id: "second", identifier: "HOW-32" })] },
    });
    expect(h.events().filter((e) => e.type === "run-spawned")).toMatchObject([
      { node: "runs.launch", visit: 1, child: "plan-feature-abc--add-endpoint", graph: "implement-ticket", slice_id: "add-endpoint", ticket: "HOW-31", workspace: "api" },
      { child: "plan-feature-abc--second", slice_id: "second", ticket: "HOW-32", workspace: "web" },
    ]);
  });
});

describe("nothing is launched until everything checks out", () => {
  const refuses = async (reads: Record<string, unknown>, opts: Parameters<typeof harness>[0] = {}) => {
    const h = harness(opts);
    const r = await h.run(reads);
    expect(r.status).toBe("failed");
    expect(h.spawned).toEqual([]);
    expect(h.events().some((e) => e.type === "side-effect-intent")).toBe(false);
    return r.reason ?? "";
  };

  test("a slice with no ticket fails before the FIRST slice is launched", async () => {
    const reason = await refuses({
      "plan.slices": { feature: "f", slices: [slice(), slice({ id: "second" })] },
      tickets: { tickets: [ticket()] },
    });
    expect(reason).toContain('slice "second" was approved but no ticket was raised for it');
    expect(reason).toContain("nothing was launched");
  });

  test("a ticket for a slice that is not in the plan is refused", async () => {
    const reason = await refuses({
      "plan.slices": { feature: "f", slices: [slice()] },
      tickets: { tickets: [ticket(), ticket({ slice_id: "ghost", identifier: "HOW-99" })] },
    });
    expect(reason).toContain('ticket HOW-99 names slice "ghost", which is not in the approved plan');
  });

  test("two tickets for one slice are refused naming both", async () => {
    const reason = await refuses({
      "plan.slices": { feature: "f", slices: [slice()] },
      tickets: { tickets: [ticket(), ticket({ identifier: "HOW-99" })] },
    });
    expect(reason).toContain("two tickets name slice \"add-endpoint\" (HOW-31 and HOW-99)");
  });

  test("a ticket with no identifier or no url is refused", async () => {
    expect(await refuses({ "plan.slices": { feature: "f", slices: [slice()] }, tickets: { tickets: [ticket({ identifier: "" })] } }))
      .toContain('the ticket for slice "add-endpoint" has no identifier');
    expect(await refuses({ "plan.slices": { feature: "f", slices: [slice()] }, tickets: { tickets: [ticket({ url: "" })] } }))
      .toContain("ticket HOW-31 (slice \"add-endpoint\") has no url");
  });

  test("tickets that are not the declared shape are refused rather than half-read", async () => {
    expect(await refuses({ "plan.slices": { feature: "f", slices: [slice()] }, tickets: "HOW-31" })).toContain("is not {");
    expect(await refuses({ "plan.slices": { feature: "f", slices: [slice()] }, tickets: { tickets: [{ identifier: "HOW-31" }] } })).toContain("is not {");
  });

  test("a plan that no longer validates is refused with the validator's own words", async () => {
    const reason = await refuses({ "plan.slices": { feature: "f", slices: [slice({ id: "Not A Slug" })] }, tickets: { tickets: [ticket({ slice_id: "Not A Slug" })] } });
    expect(reason).toContain("is not launchable");
    expect(reason).toContain("is not a slug");
  });

  test("an unregistered workspace is refused, naming what IS registered", async () => {
    // the plan validator refuses this first, which is the point: the same fact, one message
    const reason = await refuses({
      "plan.slices": { feature: "f", slices: [slice({ workspace: "mobile" })] },
      tickets: { tickets: [ticket()] },
    });
    expect(reason).toContain('workspace "mobile" is not registered');
  });

  test("a parent whose folder is not a registered workspace cannot lend it to a slice", async () => {
    const h = harness({ workspaces: { repoNames: () => ["api"], nameFor: () => null } });
    const r = await h.run({ "plan.slices": { feature: "f", slices: [slice()] }, tickets: { tickets: [ticket()] } });
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("names no workspace and this run's folder (/repos/api) is not a registered one");
    expect(h.spawned).toEqual([]);
  });

  test("a PLAIN workspace is refused: implement-ticket needs a repo to make a worktree in", async () => {
    const h = harness({ workspaces: { repoNames: () => ["api"], nameFor: () => "notes" } });
    const r = await h.run({ "plan.slices": { feature: "f", slices: [slice()] }, tickets: { tickets: [ticket()] } });
    expect(r.status).toBe("failed");
    expect(r.reason).toContain('would be built in workspace "notes", which is not a registered REPO workspace');
    expect(h.spawned).toEqual([]);
  });

  test("a node that does not declare the keys the built-in reads is refused as a graph bug", async () => {
    const h = harness();
    const def = { kind: "command", run: "runs:launch", reads: ["goal"], writes: { launched: { scope: "sticky" } } } as NodeDef<any>;
    const r = await h.run({ goal: "g" }, { def });
    expect(r.status).toBe("failed");
    expect(r.reason).toContain('runs:launch reads "plan.slices", which this node does not declare');
  });
});

describe("launchOrder", () => {
  const s = (id: string, depends_on: string[] = []) => ({ id, title: "t", goal: "g", work: "w", verify: "v", depends_on });

  test("a plan with no dependencies launches exactly as it was written", () => {
    expect(launchOrder([s("a"), s("b"), s("c")]).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  test("ties keep declaration order", () => {
    expect(launchOrder([s("top", ["a", "b"]), s("a"), s("b")]).map((x) => x.id)).toEqual(["a", "b", "top"]);
  });

  test("a cycle the validator somehow let through still launches every slice", () => {
    expect(launchOrder([s("a", ["b"]), s("b", ["a"])]).map((x) => x.id).sort()).toEqual(["a", "b"]);
  });

  test("a dependency on a slice that is not in the plan is ignored, not waited for", () => {
    expect(launchOrder([s("a", ["ghost"])]).map((x) => x.id)).toEqual(["a"]);
  });
});
