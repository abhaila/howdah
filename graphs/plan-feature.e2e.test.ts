/**
 * plan-feature end to end (HOW-23) — the fan-out as a tracer bullet, with every piece real
 * except the model and the child engines:
 *
 *   real engine · real worktree executor (`git worktree add` / `remove`) · real map built-ins
 *   (tree-sitter extraction, manifests) · real approval executor · the REAL claude executor
 *   speaking stream-json to engine/executors/fake-claude.ts, scripted turn by turn · decisions
 *   through a REAL viewer server (web/server.ts): comment, send-feedback and approve are HTTP
 *   requests to its routes.
 *
 * The one seam is `runs:launch`'s spawn: the real one starts N `implement-ticket` engines that
 * spend tokens, so it records argv instead. That argv IS the assertion — it is the whole
 * contract between the parent and its children, and nothing downstream of it is this graph's.
 *
 *   propose v1 → comment pinned → send-feedback → propose v2 (the prompt carries the comment)
 *     → approve → tickets raised → three child runs launched, one per slice, in dependency
 *     order, each in its own registered workspace → the planning worktree is removed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planFeature } from "./plan-feature";
import { Engine } from "../engine/run";
import { claudeExecutor } from "../engine/executors/claude";
import { commandExecutor, readWorktreeRecord, worktreeExecutor } from "../engine/executors/worktree";
import { approvalExecutor } from "../engine/executors/approval";
import { createHowdahServer } from "../web/server";
import { saveConfig, type HowdahConfig } from "../config/config";
import type { LoggedEvent } from "../log/events";
import { sliceRepo, SLICE_GOAL, SLICE_WORK } from "./slice-fixture";

const FAKE = join(dirname(import.meta.dir), "engine", "executors", "fake-claude.ts");
const PROMPTS = join(dirname(import.meta.dir), "prompts");
const ENV_KEYS = ["HOWDAH_HOME", "FAKE_CLAUDE_SCRIPT", "FAKE_CAPTURE", "FAKE_CLAUDE_VERDICT"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) if (process.env[k] !== undefined) saved[k] = process.env[k];
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

const RUN_ID = "plan-feature-e2e";

const slice = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Slice ${id}`,
  goal: `the ${id} half works`,
  work: `build the ${id} half`,
  verify: `exercise the ${id} half`,
  depends_on: [],
  ...over,
});

/** v1 forgets the web client; the operator pins that, and v2 adds it in its own workspace */
const PLAN_V1 = { feature: "let users delete their account", slices: [slice("api-route"), slice("api-handler", { depends_on: ["api-route"] })], out_of_scope: [], risks: [] };
const PLAN_V2 = { ...PLAN_V1, slices: [slice("api-handler", { depends_on: ["api-route"] }), slice("api-route"), slice("web-client", { workspace: "web" })] };

const ticketFor = (id: string, n: number) => ({ slice_id: id, identifier: `HOW-${n}`, url: `https://linear.app/h/issue/HOW-${n}`, title: `Slice ${id}` });
const TICKETS = { tickets: [ticketFor("api-handler", 41), ticketFor("api-route", 42), ticketFor("web-client", 43)] };

type Turn = { match: string; outputs?: Record<string, unknown> };

function e2e(turns: Turn[]) {
  const home = mkdtempSync(join(tmpdir(), "howdah-plan-e2e-"));
  process.env.HOWDAH_HOME = home;
  const script = join(home, "script.json");
  writeFileSync(script, JSON.stringify({ turns }));
  process.env.FAKE_CLAUDE_SCRIPT = script;
  process.env.FAKE_CAPTURE = join(home, "prompts.jsonl");

  const { dir: repo } = sliceRepo();
  const webRepo = sliceRepo().dir;
  saveConfig({ repos: { api: { path: repo }, web: { path: webRepo } }, folders: {} } satisfies HowdahConfig, home);
  const runsDir = join(home, "runs");
  const runDir = join(runsDir, RUN_ID);
  const spawned: string[][] = [];

  const engine = () =>
    new Engine(planFeature, {
      dir: runDir,
      cwd: repo,
      folderKind: "repo",
      promptsDir: PROMPTS,
      executors: {
        worktree: worktreeExecutor({ reposDir: join(home, "repos") }),
        command: commandExecutor({
          map: { workers: 0 },
          launch: {
            runsDir,
            // the real registry the CLI builds, over this run's own config
            workspaces: { repoNames: () => ["api", "web"], nameFor: (p) => (p === repo ? "api" : p === webRepo ? "web" : null) },
            spawn: (argv) => void spawned.push(argv),
          },
        }),
        agent: claudeExecutor({ attentionDir: join(home, "attention"), binary: FAKE, notifiers: [] }),
        approval: approvalExecutor,
        wait: async () => ({ status: "succeeded", writes: {} }),
      },
    });

  const web = viewer(runsDir, join(home, "attention"));
  servers.push(web);
  return { home, repo, webRepo, runDir, runsDir, engine, spawned, events: () => engine().log.read(), web };
}

const servers: Array<{ stop: () => void }> = [];
afterAll(() => {
  for (const s of servers) s.stop();
});

/** the viewer's decision routes for this run, with resumeRun recorded so nothing races it */
function viewer(runsDir: string, attentionDir: string) {
  const woken: string[] = [];
  const server = createHowdahServer({ runsDir, attentionDir, port: 0, pollMs: 20, resumeRun: (run) => woken.push(run) });
  const post = async (sub: string, body: unknown) => {
    const res = await fetch(`http://localhost:${server.port}/api/runs/${RUN_ID}/${sub}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const waitForWake = async (before: number) => {
    for (let i = 0; i < 100 && woken.length <= before; i++) await Bun.sleep(20);
    expect(woken.length).toBeGreaterThan(before);
  };
  return {
    stop: () => server.stop(true),
    comment: (entity_id: string, text: string) => post("comments", { entity_id, text }),
    decide: async (approved: boolean, proposal_id: number) => {
      const before = woken.length;
      const r = await post("approval", { approved, proposal_id });
      if (r.status === 200) await waitForWake(before);
      return r;
    },
  };
}

const currentRound = (events: LoggedEvent[]): number => {
  const round = events.findLast((e) => e.type === "ghost-proposed");
  if (round?.type !== "ghost-proposed") throw new Error("no proposal round yet");
  return round.proposal_id;
};

const sentPrompts = (home: string): string[] =>
  existsSync(join(home, "prompts.jsonl")) ? readFileSync(join(home, "prompts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string) : [];

const startedNodes = (events: LoggedEvent[]) => events.flatMap((e) => (e.type === "node-started" ? [e.node] : []));
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];
const inputOf = (argv: string[], key: string) => {
  for (let i = 0; i < argv.length; i++) if (argv[i] === "-i" && argv[i + 1]?.startsWith(`${key}=`)) return argv[i + 1]!.slice(key.length + 1);
  return undefined;
};

const START = { goal: SLICE_GOAL, work: SLICE_WORK };
const AWAITING = { state: "parked", node: "plan.approve", code: "awaiting-approval" } as const;

describe("plan-feature E2E (fake-claude, real map, real worktree, real decisions)", () => {
  test("v1 → comment → feedback → v2 → approve → tickets → one child run per slice", async () => {
    const run = e2e([
      { match: "plan.slices", outputs: { "plan.slices": PLAN_V1 } },
      { match: "plan.slices", outputs: { "plan.slices": PLAN_V2 } },
      { match: "tickets", outputs: { tickets: TICKETS } },
    ]);

    expect(await run.engine().start(START)).toMatchObject(AWAITING);
    // a real worktree, on this run's own branch — the children each make their own
    const record = readWorktreeRecord(run.runDir)!;
    expect(existsSync(record.path)).toBe(true);
    expect(record.branch).toBe(`howdah/${RUN_ID}`);

    // round 1: the operator pins a comment on a slice id and sends the plan back
    const first = currentRound(run.events());
    expect((await run.web.comment("api-handler", "the web client needs a slice of its own")).status).toBe(201);
    expect((await run.web.decide(false, first)).status).toBe(200);
    expect(await run.engine().resume()).toMatchObject(AWAITING);

    // the redraw was TOLD what was pinned, and answered it with a third slice
    const second = sentPrompts(run.home).filter((p) => p.includes("plan.slices"))[1]!;
    expect(second).toContain("the web client needs a slice of its own");
    expect(second).toContain("api-handler");
    expect(run.spawned).toEqual([]); // still nothing launched: nobody has approved

    // round 2: approved — and only now does anything start
    expect((await run.web.decide(true, currentRound(run.events()))).status).toBe(200);
    expect(await run.engine().resume()).toEqual({ state: "finished", outcome: "success" });

    const events = run.events();
    expect(startedNodes(events).filter((n) => n !== "plan.approve")).toEqual([
      "create_worktree", "map.extract", "plan.propose", "plan.propose", "tickets.create", "runs.launch", "cleanup",
    ]);

    // three children, dependencies first, each an implement-ticket run naming this run as parent
    expect(run.spawned.map((a) => flag(a, "--id"))).toEqual([
      `${RUN_ID}--api-route`, `${RUN_ID}--api-handler`, `${RUN_ID}--web-client`,
    ]);
    expect(run.spawned.map((a) => a[1])).toEqual(["implement-ticket", "implement-ticket", "implement-ticket"]);
    expect(run.spawned.map((a) => flag(a, "--parent"))).toEqual([RUN_ID, RUN_ID, RUN_ID]);
    // the slice that named its own workspace goes there; the other two inherit this run's
    expect(run.spawned.map((a) => flag(a, "--workspace"))).toEqual(["api", "api", "web"]);
    expect(run.spawned.map((a) => flag(a, "--name"))).toEqual(["HOW-42 Slice api-route", "HOW-41 Slice api-handler", "HOW-43 Slice web-client"]);

    // each child is handed its own ticket as `work` — it never sees the plan
    const handler = run.spawned[1]!;
    expect(inputOf(handler, "work")).toContain("HOW-41: Slice api-handler");
    expect(inputOf(handler, "work")).toContain("Depends on other slices of this feature (each has its own ticket and PR): api-route");
    expect(inputOf(handler, "goal")).toContain("one vertical slice of: let users delete their account");

    expect(events.filter((e) => e.type === "run-spawned").map((e) => e.type === "run-spawned" && e.child)).toEqual([
      `${RUN_ID}--api-route`, `${RUN_ID}--api-handler`, `${RUN_ID}--web-client`,
    ]);
    // intent before, proof after, once per child
    expect(events.filter((e) => e.type === "side-effect-intent" && e.effect.startsWith("launch-run:"))).toHaveLength(3);
    expect(events.filter((e) => e.type === "side-effect-done" && e.effect.startsWith("launch-run:"))).toHaveLength(3);

    // the planning worktree was scratch and is gone; the children's are their own business
    expect(existsSync(record.path)).toBe(false);
    expect(readWorktreeRecord(run.runDir)).toBeNull();
  }, 120000);
});
