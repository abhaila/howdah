/**
 * HOW-73: a parallel (fork/join) step — the engine half. Branches run concurrently in the one
 * runner, park the run naming themselves, keep a finished sibling's result, and resume from the
 * log alone (a crash mid-parallel re-attempts only what was in flight).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineGraph } from "../core/graph";
import { Engine, type AttemptResult, type EngineOpts, type Executor } from "./run";
import { parallelProgress, replayState } from "./replay";
import { resolveEffect, resolveReply, interruptRunner, jumpRefusal } from "./control";
import { takeNodeFlag } from "../cli/main";
import { readLog } from "../log/write";
import type { LoggedEvent } from "../log/events";
import { reconstructRender } from "../prompts/library";
import { PARALLEL_PROMPTS, parallelReview, parallelReviewRouted, type ParallelCtx } from "./fixtures/parallel-review";

const BRANCHES = ["review_security", "review_tests", "review_ux"] as const;
const VERDICT_KEY: Record<string, "security" | "tests" | "ux"> = { review_security: "security", review_tests: "tests", review_ux: "ux" };

function promptFixtures(): string {
  const dir = mkdtempSync(join(tmpdir(), "howdah-par-prompts-"));
  for (const [id, body] of Object.entries(PARALLEL_PROMPTS)) writeFileSync(join(dir, `${id}.md`), `---\nid: ${id}\nversion: 1\n---\n${body}`);
  return dir;
}

const ok = (writes: Record<string, unknown> = {}): AttemptResult => ({ status: "succeeded", writes });
const build: Executor = async () => ok({ summary: "built" });
const pass: Executor = async ({ nodeId }) => ok({ [VERDICT_KEY[nodeId]!]: "pass" });

function engineFor(graph = parallelReview(), opts: Partial<EngineOpts> & { agent?: Executor } = {}): { engine: Engine; dir: string } {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "howdah-par-run-"));
  const { agent, ...rest } = opts;
  const engine = new Engine(graph, {
    dir,
    promptsDir: promptFixtures(),
    executors: { agent: agent ?? pass, command: async (a) => (a.nodeId === "decide" ? ok({ decision: "made" }) : build(a)) },
    ...rest,
  });
  return { engine, dir };
}

const starts = (events: LoggedEvent[], node: string) => events.filter((e) => e.type === "node-started" && e.node === node);
const finishes = (events: LoggedEvent[], node: string) => events.filter((e) => e.type === "node-finished" && e.node === node);

/** rewrite a run's log as if the runner died: keep only the events `keep` accepts, renumbered */
function crashLog(dir: string, keep: (e: LoggedEvent) => boolean): void {
  const kept = readLog(join(dir, "run.jsonl")).filter(keep).map((e, i) => ({ ...e, seq: i + 1 }));
  writeFileSync(join(dir, "run.jsonl"), kept.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

describe("parallel step: running", () => {
  test("three branches run at once — every start precedes the first branch finish", async () => {
    let started = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => (release = r));
    const { engine } = engineFor(parallelReview(), {
      agent: async (a) => {
        if (++started === 3) release();
        await barrier; // only resolves once all three are in flight at the same time
        return pass(a);
      },
    });
    expect(await engine.start({ goal: "g" })).toEqual({ state: "finished", outcome: "success" });
    const events = engine.log.read();
    const branchStarts = events.filter((e) => e.type === "node-started" && e.parallel);
    expect(branchStarts.map((e) => e.type === "node-started" && e.node).sort()).toEqual([...BRANCHES].sort());
    for (const s of branchStarts) expect(s).toMatchObject({ parallel: { node: "fan", visit: 1 } });
    const firstBranchFinish = events.findIndex((e) => e.type === "node-finished" && (BRANCHES as readonly string[]).includes(e.node));
    const lastBranchStart = events.findLastIndex((e) => e.type === "node-started" && !!e.parallel);
    expect(lastBranchStart).toBeLessThan(firstBranchFinish);
    // the parallel step itself: one start, one finish after every branch, then the join edge
    expect(starts(events, "fan")).toHaveLength(1);
    const fanFinish = events.findIndex((e) => e.type === "node-finished" && e.node === "fan");
    expect(fanFinish).toBeGreaterThan(events.findLastIndex((e) => e.type === "node-finished" && e.node !== "fan"));
    expect(events.filter((e) => e.type === "edge-taken").map((e) => e.type === "edge-taken" && `${e.from}>${e.to}`)).toEqual(["build>fan", "fan>done"]);
  });

  test("the join routes on the merged context — both outcomes", async () => {
    for (const [security, tests, outcome] of [["pass", "pass", "success"], ["pass", "reject", "failed"]] as const) {
      const verdicts: Record<string, string> = { review_security: security, review_tests: tests, review_ux: "pass" };
      const { engine } = engineFor(parallelReviewRouted(), { agent: async ({ nodeId }) => ok({ [VERDICT_KEY[nodeId]!]: verdicts[nodeId] }) });
      expect(await engine.start({ goal: "g" })).toEqual({ state: "finished", outcome });
      const taken = engine.log.read().filter((e) => e.type === "edge-taken").map((e) => e.type === "edge-taken" && e.to);
      expect(taken).toEqual(["fan", "decide", outcome === "success" ? "done" : "rejected"]);
    }
  });

  test("a concurrency cap is honoured — never more than 2 of 3 in flight", async () => {
    let live = 0;
    let peak = 0;
    const { engine } = engineFor(parallelReview({ concurrency: 2 }), {
      agent: async (a) => {
        peak = Math.max(peak, ++live);
        await Bun.sleep(20);
        live--;
        return pass(a);
      },
    });
    expect(await engine.start({ goal: "g" })).toMatchObject({ state: "finished", outcome: "success" });
    expect(peak).toBe(2);
    expect(engine.log.read().filter((e) => e.type === "node-started" && e.parallel)).toHaveLength(3);
  });

  test("every branch's prompt reconstructs VERIFIED", async () => {
    const { engine, dir } = engineFor();
    await engine.start({ goal: "g" });
    const renders = engine.log.read().filter((e) => e.type === "prompt-rendered");
    expect(renders).toHaveLength(3);
    for (const r of renders) if (r.type === "prompt-rendered") expect(reconstructRender(dir, r.rendered_hash)?.verified).toBe(true);
  });
});

describe("parallel step: parking and resuming", () => {
  test("a branch that fails parks the run naming it; siblings are kept; a reply re-runs only that branch", async () => {
    const prompts: Record<string, string> = {};
    let failTests = true;
    const agent: Executor = async (a) => {
      prompts[`${a.nodeId}#${a.visit}`] = a.renderedPrompt ?? "";
      if (a.nodeId === "review_tests" && failTests) return { status: "failed", writes: {}, reason: "could not read the suite" };
      await Bun.sleep(10); // the siblings are still running when the failure lands
      return pass(a);
    };
    const { engine, dir } = engineFor(parallelReview(), { agent });
    const parked = await engine.start({ goal: "g" });
    expect(parked).toMatchObject({ state: "parked", node: "review_tests", code: "attempt-failed" });
    let events = engine.log.read();
    // siblings finished their attempt and published, AFTER the failure, BEFORE the park
    for (const b of ["review_security", "review_ux"]) expect(finishes(events, b)).toMatchObject([{ status: "succeeded" }]);
    const park = events.findIndex((e) => e.type === "attention-raised");
    expect(park).toBe(events.length - 1);
    expect(replayState(events).position).toEqual({ node: "fan", midFlight: true });
    expect(parallelProgress(events, "fan", 1)).toMatchObject({ succeeded: new Set(["review_security", "review_ux"]), failed: new Set(["review_tests"]) });

    expect(resolveReply(dir, "the suite is under test/", { graphs: { "parallel-review": parallelReview() } })).toMatchObject({ ok: true });
    failTests = false;
    const { engine: again } = engineFor(parallelReview(), { dir, agent });
    expect(await again.resume()).toEqual({ state: "finished", outcome: "success" });
    events = again.log.read();
    expect(starts(events, "review_security")).toHaveLength(1);
    expect(starts(events, "review_ux")).toHaveLength(1);
    expect(starts(events, "review_tests").map((e) => e.type === "node-started" && e.visit)).toEqual([1, 2]);
    expect(prompts["review_tests#2"]).toContain("the suite is under test/");
    // the resumed parallel visit is the SAME visit, so the join still sees the kept results
    expect(starts(events, "fan").map((e) => e.type === "node-started" && e.visit)).toEqual([1, 1]);
  });

  test("two branches park: the run parks once, on the first, and says the other parked too", async () => {
    const { engine } = engineFor(parallelReview(), {
      agent: async (a) => (a.nodeId === "review_security" ? pass(a) : { status: "failed", writes: {}, reason: `${a.nodeId} broke` }),
    });
    const parked = await engine.start({ goal: "g" });
    expect(parked).toMatchObject({ state: "parked", code: "attempt-failed" });
    const asks = engine.log.read().filter((e) => e.type === "attention-raised");
    expect(asks).toHaveLength(1);
    expect((parked as { reason: string }).reason).toContain("also parked");
  });

  test("a parked branch stops queued branches from starting (concurrency 1)", async () => {
    const { engine } = engineFor(parallelReview({ concurrency: 1 }), {
      agent: async (a) => (a.nodeId === "review_security" ? { status: "failed", writes: {} } : pass(a)),
    });
    expect(await engine.start({ goal: "g" })).toMatchObject({ state: "parked", node: "review_security" });
    expect(engine.log.read().filter((e) => e.type === "node-started" && e.parallel)).toHaveLength(1);
  });

  test("kill -9 mid-parallel: finished branches are not re-run, the in-flight one re-attempts the SAME visit", async () => {
    const { engine, dir } = engineFor();
    await engine.start({ goal: "g" });
    // the runner died while review_ux was running: drop its finish and everything after the branches
    crashLog(dir, (e) =>
      !(e.type === "node-finished" && (e.node === "review_ux" || e.node === "fan")) &&
      !(e.type === "edge-taken" && e.from === "fan") && e.type !== "run-finished" && e.type !== "prompt-outcome");
    const replayed = replayState(readLog(join(dir, "run.jsonl")));
    expect(replayed.position).toEqual({ node: "fan", midFlight: true });
    expect([...parallelProgress(readLog(join(dir, "run.jsonl")), "fan", 1).inFlight]).toEqual([["review_ux", 1]]);

    const ran: string[] = [];
    const { engine: again } = engineFor(parallelReview(), { dir, agent: async (a) => { ran.push(`${a.nodeId}#${a.visit}`); return pass(a); } });
    expect(await again.resume()).toEqual({ state: "finished", outcome: "success" });
    expect(ran).toEqual(["review_ux#1"]);
    const events = again.log.read();
    expect(starts(events, "review_ux").map((e) => e.type === "node-started" && e.visit)).toEqual([1, 1]);
    expect(finishes(events, "fan")).toHaveLength(1);
  });

  test("an ambiguous effect in one branch parks for resolve-effect; resolving re-runs only that branch", async () => {
    const effectful: Executor = async (a) => {
      if (a.nodeId === "review_ux" && !a.effects.claim("post-comment")) a.effects.done("post-comment", { id: 1 });
      return pass(a);
    };
    const { engine, dir } = engineFor(parallelReview(), { agent: effectful });
    await engine.start({ goal: "g" });
    // died between the intent and its proof, inside review_ux
    crashLog(dir, (e) =>
      !(e.type === "side-effect-done") && !(e.type === "node-finished" && (e.node === "review_ux" || e.node === "fan")) &&
      !(e.type === "edge-taken" && e.from === "fan") && e.type !== "run-finished" && e.type !== "prompt-outcome");

    const probe = async () => "unknown" as const;
    const { engine: second } = engineFor(parallelReview(), { dir, agent: effectful, probe });
    expect(await second.resume()).toMatchObject({ state: "parked", node: "review_ux", code: "ambiguous-effect" });

    expect(resolveEffect(dir, "post-comment", "not-happened")).toMatchObject({ ok: true });
    const ran: string[] = [];
    const { engine: third } = engineFor(parallelReview(), { dir, probe, agent: async (a) => { ran.push(a.nodeId); return effectful(a); } });
    expect(await third.resume()).toEqual({ state: "finished", outcome: "success" });
    expect(ran).toEqual(["review_ux"]);
    // claimed again (not-happened) and proven this time
    expect(third.log.read().filter((e) => e.type === "side-effect-done")).toHaveLength(1);
  });

  test("pause between branch starts: nothing further starts; resume runs the rest, never the finished one", async () => {
    let command: "pause" | "abort" | null = null;
    const { engine, dir } = engineFor(parallelReview({ concurrency: 1 }), {
      control: () => command,
      agent: async (a) => { command = "pause"; return pass(a); },
    });
    expect(await engine.start({ goal: "g" })).toEqual({ state: "paused", node: "fan" });
    expect(engine.log.read().filter((e) => e.type === "node-started" && e.parallel)).toHaveLength(1);

    command = null;
    const ran: string[] = [];
    const { engine: again } = engineFor(parallelReview({ concurrency: 1 }), { dir, control: () => null, agent: async (a) => { ran.push(a.nodeId); return pass(a); } });
    expect(await again.resume()).toEqual({ state: "finished", outcome: "success" });
    expect(ran).toEqual(["review_tests", "review_ux"]);
  });

  test("abort between branch starts finishes the run aborted", async () => {
    let command: "pause" | "abort" | null = null;
    const { engine } = engineFor(parallelReview({ concurrency: 1 }), {
      control: () => command,
      agent: async (a) => { command = "abort"; return pass(a); },
    });
    expect(await engine.start({ goal: "g" })).toEqual({ state: "finished", outcome: "aborted" });
    expect(engine.log.read().filter((e) => e.type === "node-started" && e.parallel)).toHaveLength(1);
  });

  test("maxSteps counts each branch execution", async () => {
    // build (1) + fan (2) + one branch (3): the next branch would be the 4th step
    const { engine } = engineFor(parallelReview({ concurrency: 1 }), { maxSteps: 3 });
    expect(await engine.start({ goal: "g" })).toMatchObject({ state: "parked", code: "max-steps", node: "review_tests" });
  });

  test("maxVisits is per branch and parks naming the branch", async () => {
    const g = parallelReview();
    (g.def.nodes.review_tests as { maxVisits?: number }).maxVisits = 1;
    const agent: Executor = async (a) => (a.nodeId === "review_tests" ? { status: "failed", writes: {} } : pass(a));
    const { engine, dir } = engineFor(g, { agent });
    expect(await engine.start({ goal: "g" })).toMatchObject({ state: "parked", node: "review_tests", code: "attempt-failed" });
    const { engine: again } = engineFor(g, { dir, agent });
    expect(await again.resume()).toMatchObject({ state: "parked", node: "review_tests", code: "max-visits" });
  });

  test("an allowance hop on one branch retries that branch alone, on the next harness", async () => {
    const ran: string[] = [];
    const { engine } = engineFor(parallelReview(), {
      agent: async (a) => {
        ran.push(`${a.nodeId}#${a.visit}@${a.agentConfig?.harness}`);
        if (a.nodeId === "review_ux" && a.agentConfig?.harness === "claude") {
          a.log.append({ type: "allowance", harness: "claude", state: "exhausted" });
          return { status: "failed", writes: {} };
        }
        return pass(a);
      },
    });
    expect(await engine.start({ goal: "g" })).toEqual({ state: "finished", outcome: "success" });
    expect(ran.filter((r) => r.startsWith("review_ux"))).toEqual(["review_ux#1@claude", "review_ux#2@codex"]);
    expect(ran.filter((r) => r.startsWith("review_security"))).toHaveLength(1);
    expect(ran.filter((r) => r.startsWith("review_tests"))).toHaveLength(1);
  });
});

describe("parallel step: operator verbs", () => {
  test("a jump to a branch is refused (jump to its parallel step); a jump instruction to the parallel step is refused", async () => {
    const { engine, dir } = engineFor(parallelReview(), { agent: async (a) => (a.nodeId === "review_ux" ? { status: "failed", writes: {} } : pass(a)) });
    await engine.start({ goal: "g" });
    const graphs = { "parallel-review": parallelReview() };
    expect(jumpRefusal(dir, "review_ux", graphs)).toEqual({ ok: false, message: `"review_ux" is one of the steps "fan" runs at once — jump to "fan" instead` });
    expect(jumpRefusal(dir, "fan", graphs, "be thorough")).toMatchObject({ ok: false, message: expect.stringContaining("no prompt of its own") });
    expect(jumpRefusal(dir, "fan", graphs)).toMatchObject({ ok: true });
  });

  test("the CLI's --node flag is pulled out of the arguments", () => {
    expect(takeNodeFlag(["r1", "--node", "review_ux", "look", "here"])).toEqual({ node: "review_ux", args: ["r1", "look", "here"] });
    expect(takeNodeFlag(["r1", "text"])).toEqual({ args: ["r1", "text"] });
    expect(() => takeNodeFlag(["r1", "--node"])).toThrow("--node needs a step id");
  });
});

describe("parallel step: pause interrupts every live branch", () => {
  test("interruptRunner kills each branch's harness child of the runner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-par-int-"));
    const pidsDir = mkdtempSync(join(tmpdir(), "howdah-par-pids-"));
    const prompts = promptFixtures();
    const script = join(mkdtempSync(join(tmpdir(), "howdah-par-script-")), "runner.ts");
    // a runner whose three branches each wait on a `sleep` child — the stand-in for a harness
    writeFileSync(script, `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { Engine } from ${JSON.stringify(join(import.meta.dir, "run.ts"))};
      import { parallelReview } from ${JSON.stringify(join(import.meta.dir, "fixtures", "parallel-review.ts"))};
      const engine = new Engine(parallelReview(), {
        dir: ${JSON.stringify(dir)}, promptsDir: ${JSON.stringify(prompts)},
        executors: {
          command: async () => ({ status: "succeeded", writes: { summary: "s" } }),
          agent: async ({ nodeId }) => {
            const child = Bun.spawn(["sleep", "60"]);
            writeFileSync(join(${JSON.stringify(pidsDir)}, nodeId), String(child.pid));
            await child.exited;
            return { status: "failed", writes: {} };
          },
        },
      });
      await engine.start({ goal: "g" });
    `);
    const runner = Bun.spawn(["bun", script], { stdout: "ignore", stderr: "ignore" });
    const pidFile = (b: string) => join(pidsDir, b);
    for (let i = 0; i < 200 && !BRANCHES.every((b) => existsSync(pidFile(b))); i++) await Bun.sleep(50);
    expect(BRANCHES.every((b) => existsSync(pidFile(b)))).toBe(true);
    const children = BRANCHES.map((b) => Number(readFileSync(pidFile(b), "utf8")));

    expect(await interruptRunner(dir, 300)).toBe(true);
    await runner.exited;
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 40 && children.some(alive); i++) await Bun.sleep(50);
    expect(children.filter(alive)).toEqual([]);
  }, 20_000);
});

describe("parallel step: graph shape is unchanged for the engine", () => {
  test("defineGraph typing accepts a parallel node and its validator passes the fixture", () => {
    expect(parallelReview().validate()).toEqual({ structural: [], paths: [] });
    expect(parallelReviewRouted().validate()).toEqual({ structural: [], paths: [] });
    // ParallelCtx is the fixture's context — referenced so the import is not type-only dead code
    const ctx: Partial<ParallelCtx> = { security: "pass" };
    expect(ctx.security).toBe("pass");
  });

  test("a sequential graph with no parallel step behaves as before (no parallel field on node-started)", async () => {
    const g = defineGraph<{ goal: string; summary: string }>({
      name: "seq", entry: "build", inputs: ["goal"],
      nodes: { build: { kind: "command", run: "x", reads: ["goal"], writes: { summary: { scope: "sticky" } } }, done: { kind: "terminal", outcome: "success" } },
      edges: [{ from: "build", to: "done" }],
    });
    const { engine } = engineFor(g as never);
    await engine.start({ goal: "g" });
    expect(engine.log.read().filter((e) => e.type === "node-started").every((e) => e.type === "node-started" && e.parallel === undefined)).toBe(true);
  });
});
