import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { defineGraph } from "../core/graph";
import { Engine, type EngineOpts } from "./run";
import { readControl, writeControl, clearControl, resolveReply, NOTHING_AWAITING } from "./control";
import { EventLog, readLog } from "../log/write";
import { replayState } from "./replay";
import { deriveStatus, deriveTimeline } from "../web/derive";

interface Ctx {
  goal: string;
  a: string;
  b: string;
  c: string;
}

function prompts(): string {
  const dir = mkdtempSync(join(tmpdir(), "howdah-ctl-p-"));
  writeFileSync(join(dir, "doc.draft.md"), `---\nid: doc.draft\nversion: 1\n---\nStep for {{ context.goal }}.\n`);
  return dir;
}

const graph = () =>
  defineGraph<Ctx>({
    name: "ctl",
    entry: "one",
    inputs: ["goal"],
    nodes: {
      one: { kind: "agent", prompt: "doc.draft", reads: ["goal"], writes: { a: { scope: "sticky" } } },
      two: { kind: "agent", prompt: "doc.draft", reads: ["a"], writes: { b: { scope: "sticky" } } },
      three: { kind: "agent", prompt: "doc.draft", reads: ["b"], writes: { c: { scope: "sticky" } } },
      done: { kind: "terminal", outcome: "success" },
    },
    edges: [
      { from: "one", to: "two" },
      { from: "two", to: "three" },
      { from: "three", to: "done" },
    ],
  });

function agentStub(ran: string[]) {
  return async ({ nodeId, renderedPrompt }: any) => {
    ran.push(nodeId);
    const writes = { one: { a: `prompt:${renderedPrompt}` }, two: { b: "b" }, three: { c: "c" } }[nodeId as "one"];
    return { status: "succeeded" as const, writes: writes ?? {} };
  };
}

describe("pause + abort at node boundaries (T22)", () => {
  test("pause lands between nodes; resume picks up exactly where it held", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-ctl-"));
    const promptsDir = prompts();
    const ran: string[] = [];
    // pause after the first node completes
    const make = () =>
      new Engine(graph(), {
        dir,
        promptsDir,
        control: () => readControl(dir),
        executors: { agent: agentStub(ran) },
      });
    const first = make();
    const origExec = agentStub(ran);
    (first as any).opts.executors.agent = async (args: any) => {
      const r = await origExec(args);
      if (args.nodeId === "one") writeControl(dir, "pause");
      return r;
    };
    const r1 = await first.start({ goal: "g" });
    expect(r1).toEqual({ state: "paused", node: "two" });
    expect(ran).toEqual(["one"]);
    expect(first.log.read().some((e) => e.type === "run-paused")).toBe(true);
    expect(replayState(first.log.read()).paused).toBe(true);

    // paused runs are never auto-resumed; the operator resumes
    clearControl(dir);
    ran.length = 0;
    const r2 = await make().resume();
    expect(r2).toEqual({ state: "finished", outcome: "success" });
    expect(ran).toEqual(["two", "three"]); // one was NOT re-run
  });

  test("abort seals the log with outcome aborted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-ctl-"));
    const ran: string[] = [];
    const engine = new Engine(graph(), {
      dir,
      promptsDir: prompts(),
      control: () => readControl(dir),
      executors: {
        agent: async (args: any) => {
          const r = await agentStub(ran)(args);
          writeControl(dir, "abort");
          return r;
        },
      },
    });
    const r = await engine.start({ goal: "g" });
    expect(r).toEqual({ state: "finished", outcome: "aborted" });
    expect(ran).toEqual(["one"]);
    const finished: any = engine.log.read().find((e) => e.type === "run-finished");
    expect(finished.outcome).toBe("aborted");
  });
});

describe("operator jump", () => {
  test("jump event moves the replay position and the instruction reaches the prompt once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-ctl-"));
    const promptsDir = prompts();
    const ran: string[] = [];
    const seenPrompts: Record<string, string> = {};
    const exec = async ({ nodeId, renderedPrompt }: any) => {
      ran.push(nodeId);
      seenPrompts[nodeId] = renderedPrompt;
      const writes = { one: { a: "a" }, two: { b: "b" }, three: { c: "c" } }[nodeId as "one"];
      return { status: "succeeded" as const, writes: writes ?? {} };
    };
    // run to completion first, so context has everything
    const first = new Engine(graph(), { dir, promptsDir, executors: { agent: exec } });
    // pause it after two, then jump back to two with an instruction
    (first as any).opts.control = () => (ran.length === 2 ? readControl(dir) : null);
    writeControl(dir, "pause");
    const r1 = await first.start({ goal: "g" });
    expect(r1.state).toBe("paused");
    clearControl(dir);

    first.log.append({ type: "operator-jump", to: "two", message: "focus only on the API section this time" });
    const replayed = replayState(first.log.read());
    expect(replayed.position).toEqual({ node: "two", midFlight: false });
    expect(replayed.jumpNote).toEqual({ node: "two", message: "focus only on the API section this time" });

    ran.length = 0;
    const second = new Engine(graph(), { dir, promptsDir, executors: { agent: exec } });
    const r2 = await second.resume();
    expect(r2).toEqual({ state: "finished", outcome: "success" });
    expect(ran).toEqual(["two", "three"]);
    expect(seenPrompts["two"]).toContain("## Operator instruction");
    expect(seenPrompts["two"]).toContain("focus only on the API section this time");
    expect(seenPrompts["three"]).not.toContain("Operator instruction"); // consumed by two only
  });
});

// system-map 0.3: work ⇄ review, both bounded at 2, with a reviewer that never passes
interface LoopCtx {
  goal: string;
  a: string;
  verdict: "pass" | "reject";
}
const loopGraph = () =>
  defineGraph<LoopCtx>({
    name: "ctl-loop",
    entry: "work",
    inputs: ["goal"],
    nodes: {
      work: { kind: "agent", prompt: "doc.draft", reads: ["goal"], writes: { a: { scope: "sticky" } }, maxVisits: 2 },
      review: { kind: "agent", prompt: "doc.draft", reads: ["a"], writes: { verdict: { scope: "cleared" } }, maxVisits: 2 },
      done: { kind: "terminal", outcome: "success" },
    },
    edges: [
      { from: "work", to: "review" },
      { from: "review", to: "work", condition: { reads: ["verdict"], test: (v) => v.verdict === "reject", label: "reject" }, weight: 2 },
      { from: "review", to: "done", condition: { reads: ["verdict"], test: (v) => v.verdict === "pass", label: "pass" }, weight: 1 },
    ],
  });

async function parkedLoop(): Promise<{ dir: string; promptsDir: string; make: () => Engine }> {
  const dir = mkdtempSync(join(tmpdir(), "howdah-ctl-loop-"));
  const promptsDir = prompts();
  const make = () =>
    new Engine(loopGraph(), {
      dir,
      promptsDir,
      executors: { agent: async ({ nodeId }: any) => ({ status: "succeeded" as const, writes: nodeId === "work" ? { a: "a" } : { verdict: "reject" } }) },
    });
  // work#1 review#1 work#2 review#2, then work#3 exceeds its budget
  expect(await make().start({ goal: "g" })).toMatchObject({ state: "parked", node: "work" });
  return { dir, promptsDir, make };
}

const startedIds = (events: any[]) => events.filter((e) => e.type === "node-started").map((e) => `${e.node}@${e.visit}`);

describe("jump budget floors (system-map 0.3)", () => {
  test("a reset_budgets jump floors EVERY node at its replayed visit count", async () => {
    const { make } = await parkedLoop();
    const engine = make();
    engine.log.append({ type: "operator-jump", to: "review", message: "be lenient", reset_budgets: true });
    const replayed = replayState(engine.log.read());
    expect(replayed.visits).toEqual({ work: 2, review: 2 });
    expect(replayed.floors).toEqual({ work: 2, review: 2 });
  });

  test("floors apply to every node, not just the jump target", async () => {
    const { make } = await parkedLoop();
    const engine = make();
    // jump to review — work (which is what parked) must ALSO get a fresh budget
    engine.log.append({ type: "operator-jump", to: "review", message: "be lenient", reset_budgets: true });
    const result = await make().resume();
    // review#3 work#3 review#4 work#4, then review#5 is past review's fresh budget of 2
    expect(result).toMatchObject({ state: "parked", node: "review" });
    const events = engine.log.read();
    expect(startedIds(events)).toEqual([
      "work@1", "review@1", "work@2", "review@2",
      "review@3", "work@3", "review@4", "work@4",
    ]);
    const lastPark: any = events.filter((e) => e.type === "attention-raised").at(-1);
    expect(lastPark).toMatchObject({ node: "review", visit: 5 });
    expect(lastPark.reason).toContain("maxVisits");
  });

  test("a legacy operator-jump without reset_budgets replays as before: no floors, re-parks at once", async () => {
    const { make } = await parkedLoop();
    const engine = make();
    engine.log.append({ type: "operator-jump", to: "review", message: "be lenient" });
    expect(replayState(engine.log.read()).floors).toEqual({});
    const result = await make().resume();
    expect(result).toMatchObject({ state: "parked", node: "review" });
    expect(startedIds(engine.log.read())).toEqual(["work@1", "review@1", "work@2", "review@2"]);
  });

  test("floors from an earlier jump are raised, not reset, by a later jump", async () => {
    const { make } = await parkedLoop();
    const engine = make();
    engine.log.append({ type: "operator-jump", to: "work", reset_budgets: true });
    await make().resume(); // work#3 review#3 work#4 review#4, parks at work#5
    engine.log.append({ type: "operator-jump", to: "work", reset_budgets: true });
    expect(replayState(engine.log.read()).floors).toEqual({ work: 4, review: 4 });
    await make().resume();
    const ids = startedIds(engine.log.read());
    expect(ids.slice(-4)).toEqual(["work@5", "review@5", "work@6", "review@6"]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("howdah jump (CLI) precheck", () => {
  test("jump to a node whose reads are unwritten is refused with the missing keys named", async () => {
    const base = mkdtempSync(join(tmpdir(), "howdah-jump-"));
    // a parked write-doc run that only finished doc.outline — doc.review needs doc_summary
    const { Engine: E } = await import("./run");
    const { writeDoc } = await import("../graphs/write-doc");
    const engine = new E(writeDoc, {
      dir: join(base, "runs", "j1"),
      executors: {
        agent: async ({ nodeId }: any) => {
          if (nodeId === "doc.outline") return { status: "succeeded", writes: { doc_outline: "o" } };
          throw new Error("stop here");
        },
      },
    });
    await engine.start({ goal: "g", work: "w" });

    const run = (args: string[]) =>
      Bun.spawnSync(["bun", join(import.meta.dir, "..", "cli", "main.ts"), ...args], {
        env: { ...process.env, HOWDAH_HOME: base, HOWDAH_STUB: "1" },
        stdout: "pipe", stderr: "pipe",
      });

    const bad = run(["jump", "j1", "doc.review"]);
    expect(bad.exitCode).toBe(1);
    expect(new TextDecoder().decode(bad.stderr)).toContain("doc_summary");

    const unknown = run(["jump", "j1", "doc.ghost"]);
    expect(new TextDecoder().decode(unknown.stderr)).toContain('unknown node "doc.ghost"');

    // jumping to a satisfiable node works and the log records it
    const ok = run(["jump", "j1", "doc.draft", "use", "British", "spelling"]);
    expect(ok.exitCode).toBe(0);
    const { readLog } = await import("../log/write");
    const jump: any = readLog(join(base, "runs", "j1", "run.jsonl")).find((e) => e.type === "operator-jump");
    // system-map 0.3: CLI jumps (and the web route, which spawns this verb) reset budgets
    expect(jump).toMatchObject({ to: "doc.draft", message: "use British spelling", reset_budgets: true });
  }, 15000);
});

describe("jump budget floors: crash and viewer consistency (system-map 0.3)", () => {
  test("a crash mid-flight on the post-jump visit re-attempts that visit and keeps the budget", async () => {
    const { make } = await parkedLoop();
    const engine = make();
    engine.log.append({ type: "operator-jump", to: "work", reset_budgets: true });
    // the runner died inside work@3: started, never finished
    engine.log.append({ type: "node-started", node: "work", visit: 3, attempt_id: "work#3" });
    const result = await make().resume();
    const events = engine.log.read();
    // work@3 re-attempted on the SAME visit; the fresh budget of 2 still parks at work@5
    expect(result).toMatchObject({ state: "parked", node: "work" });
    expect(events.filter((e) => e.type === "node-finished").map((e: any) => `${e.node}@${e.visit}`)).toEqual([
      "work@1", "review@1", "work@2", "review@2", "work@3", "review@3", "work@4", "review@4",
    ]);
    expect((events.filter((e) => e.type === "attention-raised").at(-1) as any).visit).toBe(5);
  });

  test("the viewer closes a maxVisits ask at the jump: the post-jump attempt is not 'waiting'", async () => {
    const { dir, promptsDir, make } = await parkedLoop();
    make().log.append({ type: "operator-jump", to: "work", message: "go", reset_budgets: true });
    // a slow work attempt, so a wrongly-open ask would visibly overlap it
    const slow = new Engine(loopGraph(), {
      dir,
      promptsDir,
      executors: {
        agent: async ({ nodeId }: any) => {
          if (nodeId === "work") await Bun.sleep(40);
          return { status: "succeeded" as const, writes: nodeId === "work" ? { a: "a" } : { verdict: "reject" } };
        },
      },
    });
    await slow.resume();
    const events = slow.log.read();
    // the maxVisits park was raised at work@3 — the same node@visit the real post-jump attempt uses
    const row = deriveTimeline(events).find((r) => r.node === "work" && r.visit === 3);
    expect(row).toBeDefined();
    expect(row!.waiting_ms).toBe(0);
    // and while that attempt runs, the run reads as running, not needs-input
    const upToStart = events.slice(0, events.findIndex((e: any) => e.type === "node-started" && e.node === "work" && e.visit === 3) + 1);
    expect(deriveStatus(upToStart).status).toBe("running");
  });
});

// ---- replies per park code (system-map 0.2) -------------------------------------------

interface ReplyCtx {
  goal: string;
  a: string;
  b: string;
  c: string;
}
/** agent → command → worktree → agent: one node of every kind a park can land on */
const replyGraph = () =>
  defineGraph<ReplyCtx>({
    name: "ctl-reply",
    entry: "one",
    inputs: ["goal"],
    nodes: {
      one: { kind: "agent", prompt: "doc.draft", reads: ["goal"], writes: { a: { scope: "sticky" } } },
      cmd: { kind: "command", run: "true", writes: { b: { scope: "sticky" } } },
      wt: { kind: "worktree", action: "create" },
      last: { kind: "agent", prompt: "doc.draft", reads: ["goal"], writes: { c: { scope: "sticky" } }, maxVisits: 2 },
      done: { kind: "terminal", outcome: "success" },
    },
    edges: [
      { from: "one", to: "cmd" },
      { from: "cmd", to: "wt" },
      { from: "wt", to: "last" },
      { from: "last", to: "done" },
    ],
  });
const REPLY_GRAPHS = { "ctl-reply": replyGraph() };

type Outcome = "ok" | "fail" | "throw";
/** an engine whose node outcomes are scripted per `node@visit` (default ok); prompts recorded */
function replyEngine(dir: string, promptsDir: string, script: Record<string, Outcome>, seen: Map<string, string>) {
  const run = async ({ nodeId, visit, renderedPrompt }: any) => {
    if (renderedPrompt !== undefined) seen.set(`${nodeId}@${visit}`, renderedPrompt);
    const outcome = script[`${nodeId}@${visit}`] ?? "ok";
    if (outcome === "throw") throw new Error(`${nodeId} blew up`);
    if (outcome === "fail") return { status: "failed" as const, writes: {} };
    const writes = { one: { a: "a" }, cmd: { b: "b" }, last: { c: "c" } }[nodeId as "one"] ?? {};
    return { status: "succeeded" as const, writes };
  };
  return new Engine(replyGraph(), { dir, promptsDir, executors: { agent: run, command: run, worktree: run } });
}

const count = (haystack: string | undefined, needle: string) => (haystack ?? "").split(needle).length - 1;
const REPLY_HEADING = "## Operator reply";

describe("reply to an agent failure reaches the retry, once (system-map 0.2)", () => {
  for (const [outcome, code] of [["fail", "attempt-failed"], ["throw", "executor-threw"]] as const) {
    test(`${code}: accepted, rendered into the retried prompt exactly once, not into the attempt after`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "howdah-reply-"));
      const promptsDir = prompts();
      const seen = new Map<string, string>();
      // one@1 fails; the operator replies; one@2 fails again; plain resume; one@3 succeeds
      const script: Record<string, Outcome> = { "one@1": outcome, "one@2": "fail" };
      expect(await replyEngine(dir, promptsDir, script, seen).start({ goal: "g" })).toMatchObject({ state: "parked", node: "one", code });

      const r = resolveReply(dir, "use the v2 API", { graphs: REPLY_GRAPHS });
      expect(r).toEqual({ ok: true, node: "one", visit: 1, code, rendered: true });
      expect(replayState(readLog(join(dir, "run.jsonl"))).replyNote).toEqual({ node: "one", message: "use the v2 API" });

      await replyEngine(dir, promptsDir, script, seen).resume();
      const retried = seen.get("one@2");
      expect(count(retried, REPLY_HEADING)).toBe(1);
      expect(count(retried, "use the v2 API")).toBe(1);
      // body → reply → outputs contract (fixed order, system-map 0.1)
      expect(retried!.indexOf(REPLY_HEADING)).toBeLessThan(retried!.indexOf("## Output contract"));

      // one@2 parked again; resume() resolves it itself — that resolution must not render
      await replyEngine(dir, promptsDir, script, seen).resume();
      expect(seen.get("one@3")).toBeDefined();
      expect(seen.get("one@3")).not.toContain(REPLY_HEADING);
      expect(seen.get("last@1")).not.toContain(REPLY_HEADING);

      const events = readLog(join(dir, "run.jsonl"));
      expect(events.filter((e) => e.type === "attention-resolved").map((e: any) => e.source)).toEqual(["operator", "resume"]);
      const render: any = events.find((e) => e.type === "prompt-rendered" && e.node === "one" && e.visit === 2);
      expect(render.suffix_version).toBe(2);
    });
  }

  test("a crash before the retry starts keeps the reply for the next life", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-reply-"));
    const promptsDir = prompts();
    const seen = new Map<string, string>();
    await replyEngine(dir, promptsDir, { "one@1": "fail" }, seen).start({ goal: "g" });
    resolveReply(dir, "try harder", { graphs: REPLY_GRAPHS });
    // a resume that pauses before the node boundary consumes nothing
    writeControl(dir, "pause");
    const paused = replyEngine(dir, promptsDir, {}, seen);
    (paused as any).opts.control = () => readControl(dir);
    expect(await paused.resume()).toMatchObject({ state: "paused" });
    clearControl(dir);
    expect(replayState(readLog(join(dir, "run.jsonl"))).replyNote).toEqual({ node: "one", message: "try harder" });
    await replyEngine(dir, promptsDir, {}, seen).resume();
    expect(count(seen.get("one@2"), "try harder")).toBe(1);
  });
});

describe("resolveReply refuses what a reply cannot fix (system-map 0.2)", () => {
  /** a run of the reply graph with one hand-written park on `node` */
  function parkedOn(node: string, code: string | undefined, extra: Record<string, unknown> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "howdah-reply-"));
    const log = new EventLog(join(dir, "run.jsonl"));
    log.append({ type: "run-started", graph: "ctl-reply", inputs: { goal: "g" }, pinned_prompts: {} });
    log.append({ type: "node-started", node, visit: 1, attempt_id: `${node}#1` });
    log.append({ type: "attention-raised", node, visit: 1, reason: "r", ...(code ? { code } : {}), ...extra } as never);
    const before = readFileSync(join(dir, "run.jsonl"), "utf8");
    return { dir, unchanged: () => readFileSync(join(dir, "run.jsonl"), "utf8") === before };
  }

  const refusals: Array<[string, string, string, RegExp]> = [
    ["command node failure", "cmd", "attempt-failed", /"cmd" is a command node, so there is no prompt to carry it; fix the cause, then `resume /],
    ["worktree node failure", "wt", "attempt-failed", /"wt" is a worktree node.*fix the cause, then `resume /],
    ["command node throw", "cmd", "executor-threw", /command node.*fix the cause/],
    ["max-visits", "one", "max-visits", /use `jump \S+ <node> <msg>`/],
    ["no-edge", "one", "no-edge", /use `jump \S+ <node> <msg>`/],
    ["max-steps", "one", "max-steps", /use `jump \S+ <node> <msg>`/],
    ["ambiguous-effect", "cmd", "ambiguous-effect", /resolve the effect first/],
    ["awaiting-approval", "one", "awaiting-approval", /use `approve \S+`, `comment \S+ <entity-id> <text>` then `send-feedback \S+`, or `redesign \S+ <msg>`/],
    ["approval-missing", "one", "approval-missing", /use `jump \S+ <approval-node>` to return to the approval step \(then `approve \S+`\), or `redesign \S+ <msg>`/],
    ["stale-base", "one", "stale-base", /undo the change and `resume \S+`, or `redesign \S+ <msg>` to re-extract and redraw/],
  ];
  for (const [label, node, code, message] of refusals) {
    test(`${label}: refused naming the next step, nothing appended`, () => {
      const { dir, unchanged } = parkedOn(node, code);
      const r = resolveReply(dir, "please just continue", { graphs: REPLY_GRAPHS });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe(code as never);
      expect(r.message).toStartWith(`reply refused (${code}): `);
      expect(r.message).toMatch(message);
      expect(unchanged()).toBe(true);
    });
  }

  test("every refusal names this run's id in its command", () => {
    const { dir } = parkedOn("one", "max-visits");
    const r = resolveReply(dir, "x", { graphs: REPLY_GRAPHS });
    expect(!r.ok && r.message).toContain(`jump ${basename(dir)} <node> <msg>`);
  });

  test("an agent failure in a graph that is not registered is refused, never silently dropped", () => {
    const { dir, unchanged } = parkedOn("one", "attempt-failed");
    const r = resolveReply(dir, "x", { graphs: {} });
    expect(r).toMatchObject({ ok: false, code: "attempt-failed" });
    // resume refuses an unregistered graph too, so the refusal must not send the operator there
    expect(!r.ok && r.message).toContain("not registered in graphs/index.ts, so the run cannot move until it is");
    expect(!r.ok && r.message).not.toContain("resume");
    expect(unchanged()).toBe(true);
  });

  test("an agent failure on the node's last budgeted visit is refused naming jump — the retry would park first", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-reply-"));
    const path = join(dir, "run.jsonl");
    const log = new EventLog(path);
    log.append({ type: "run-started", graph: "ctl-reply", inputs: { goal: "g" }, pinned_prompts: {} });
    const failVisit = (visit: number) => {
      log.append({ type: "node-started", node: "last", visit, attempt_id: `last#${visit}` });
      log.append({ type: "node-finished", node: "last", visit, status: "failed", writes: {} });
      log.append({ type: "attention-raised", node: "last", visit, reason: "attempt failed", code: "attempt-failed" });
    };
    // visit 1 of maxVisits 2: the retry is visit 2, within budget — accepted
    failVisit(1);
    expect(resolveReply(dir, "hint", { graphs: REPLY_GRAPHS })).toMatchObject({ ok: true, rendered: true });
    // visit 2 of 2: the retry would be visit 3, which parks max-visits before node-started
    failVisit(2);
    const before = readFileSync(path, "utf8");
    const r = resolveReply(dir, "hint", { graphs: REPLY_GRAPHS });
    expect(r).toMatchObject({ ok: false, code: "attempt-failed" });
    expect(!r.ok && r.message).toBe(
      `reply refused (attempt-failed): the retry would exceed maxVisits (2); use \`jump ${basename(dir)} <node> <msg>\``,
    );
    expect(readFileSync(path, "utf8")).toBe(before);
    // a reset_budgets jump floors the budget: the same arithmetic the engine uses
    log.append({ type: "operator-jump", to: "last", reset_budgets: true });
    failVisit(3);
    expect(resolveReply(dir, "hint", { graphs: REPLY_GRAPHS })).toMatchObject({ ok: true, rendered: true });
  });

  test("LEGACY: an ask without a code is accepted, logged as operator, and never rendered", async () => {
    // a real engine park, with the code stripped the way a pre-0.2 log reads
    const dir = mkdtempSync(join(tmpdir(), "howdah-reply-"));
    const promptsDir = prompts();
    const seen = new Map<string, string>();
    await replyEngine(dir, promptsDir, { "one@1": "fail" }, seen).start({ goal: "g" });
    const path = join(dir, "run.jsonl");
    const stripped = readLog(path).map((e) => (e.type === "attention-raised" ? (({ code: _c, ...rest }) => rest)(e) : e));
    writeFileSync(path, stripped.map((e) => JSON.stringify(e)).join("\n") + "\n");

    expect(resolveReply(dir, "use the v2 API", { graphs: REPLY_GRAPHS })).toEqual({ ok: true, node: "one", visit: 1, code: undefined, rendered: false });
    const resolved: any = readLog(path).find((e) => e.type === "attention-resolved");
    expect(resolved).toMatchObject({ reply: "use the v2 API", source: "operator" });
    expect(replayState(readLog(path)).replyNote).toBeNull();

    await replyEngine(dir, promptsDir, {}, seen).resume();
    expect(seen.get("one@2")).toBeDefined();
    expect(seen.get("one@2")).not.toContain("use the v2 API");
  });

  test("a mid-node harness permission ask (no code) keeps its live path: accepted, not rendered", () => {
    const { dir } = parkedOn("one", undefined, { ask: { kind: "can_use_tool", request_id: "r1", tool_name: "Bash" } });
    expect(resolveReply(dir, "allow", { graphs: REPLY_GRAPHS })).toMatchObject({ ok: true, rendered: false });
    const resolved: any = readLog(join(dir, "run.jsonl")).find((e) => e.type === "attention-resolved");
    expect(resolved).toMatchObject({ node: "one", visit: 1, reply: "allow", source: "operator" });
  });

  test("nothing awaiting: no ask, an answered ask, an ask a jump superseded, a finished run, an unknown run", () => {
    const none = parkedOn("one", "attempt-failed");
    expect(resolveReply(none.dir, "first", { graphs: REPLY_GRAPHS })).toMatchObject({ ok: true });
    expect(resolveReply(none.dir, "second", { graphs: REPLY_GRAPHS })).toEqual({ ok: false, message: NOTHING_AWAITING });

    const jumped = parkedOn("one", "max-visits");
    new EventLog(join(jumped.dir, "run.jsonl")).append({ type: "operator-jump", to: "one", message: "m", reset_budgets: true });
    expect(resolveReply(jumped.dir, "x", { graphs: REPLY_GRAPHS })).toEqual({ ok: false, message: NOTHING_AWAITING });

    const finished = parkedOn("one", "attempt-failed");
    new EventLog(join(finished.dir, "run.jsonl")).append({ type: "run-finished", outcome: "aborted" });
    expect(resolveReply(finished.dir, "x", { graphs: REPLY_GRAPHS })).toEqual({ ok: false, message: NOTHING_AWAITING });

    expect(resolveReply(join(tmpdir(), "howdah-no-such-run"), "x", { graphs: REPLY_GRAPHS })).toEqual({ ok: false, message: "unknown run: howdah-no-such-run" });
  });

  test("a blank reply to an agent failure is accepted as a plain retry, with no empty suffix", () => {
    const { dir } = parkedOn("one", "attempt-failed");
    expect(resolveReply(dir, "   ", { graphs: REPLY_GRAPHS })).toMatchObject({ ok: true, rendered: false });
    expect(replayState(readLog(join(dir, "run.jsonl"))).replyNote).toBeNull();
  });

  // in one process these serialise; the cross-process race is in cli/reply.test.ts
  test("back-to-back replies land exactly one resolution", () => {
    const { dir } = parkedOn("one", "attempt-failed");
    const results = ["a", "b", "c", "d"].map((t) => resolveReply(dir, t, { graphs: REPLY_GRAPHS }));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.message === NOTHING_AWAITING)).toBe(true);
    expect(readLog(join(dir, "run.jsonl")).filter((e) => e.type === "attention-resolved")).toHaveLength(1);
  });
});

describe("replay derives replyNote like jumpNote (system-map 0.2)", () => {
  const base = [
    { type: "run-started", graph: "ctl-reply", inputs: {}, pinned_prompts: {} },
    { type: "node-started", node: "one", visit: 1, attempt_id: "one#1" },
    { type: "node-finished", node: "one", visit: 1, status: "failed", writes: {} },
  ];
  const stamp = (events: object[]) => events.map((e, i) => ({ ...e, seq: i + 1, ts: "t" })) as any[];
  const raised = (code?: string) => ({ type: "attention-raised", node: "one", visit: 1, reason: "r", ...(code ? { code } : {}) });
  const resolved = (fields: object) => ({ type: "attention-resolved", node: "one", visit: 1, ...fields });

  test("an operator reply to a renderable park is the note; the next attempt of that node consumes it once it finishes", () => {
    const events = [...base, raised("attempt-failed"), resolved({ reply: "hint", source: "operator" })];
    expect(replayState(stamp(events)).replyNote).toEqual({ node: "one", message: "hint" });
    const started = [...events, { type: "node-started", node: "one", visit: 2, attempt_id: "one#2" }];
    // still mid-flight: a resume here re-attempts one@2, which must carry the reply
    expect(replayState(stamp(started)).replyNote).toEqual({ node: "one", message: "hint" });
    const consumed = [...started, { type: "node-finished", node: "one", visit: 2, status: "failed", writes: {} }];
    expect(replayState(stamp(consumed)).replyNote).toBeNull();
    const otherNode = [...events, { type: "node-started", node: "cmd", visit: 1, attempt_id: "cmd#1" }];
    expect(replayState(stamp(otherNode)).replyNote).toEqual({ node: "one", message: "hint" });
  });

  test("resume's own resolution never becomes a note — with source, or legacy reply \"resume\" without", () => {
    expect(replayState(stamp([...base, raised("attempt-failed"), resolved({ reply: "resume", source: "resume" })])).replyNote).toBeNull();
    expect(replayState(stamp([...base, raised("attempt-failed"), resolved({ reply: "resume" })])).replyNote).toBeNull();
  });

  test("a legacy operator reply without source still counts as operator (only on a coded park)", () => {
    expect(replayState(stamp([...base, raised("executor-threw"), resolved({ reply: "hint" })])).replyNote).toEqual({ node: "one", message: "hint" });
    expect(replayState(stamp([...base, raised(), resolved({ reply: "hint" })])).replyNote).toBeNull();
  });

  test("replies to non-renderable parks never become notes", () => {
    for (const code of ["max-visits", "no-edge", "max-steps", "ambiguous-effect", "awaiting-approval", "approval-missing", "stale-base"])
      expect(replayState(stamp([...base, raised(code), resolved({ reply: "hint", source: "operator" })])).replyNote).toBeNull();
  });

  test("an operator jump supersedes a pending reply, as it supersedes the park", () => {
    const events = [...base, raised("attempt-failed"), resolved({ reply: "hint", source: "operator" }), { type: "operator-jump", to: "one", message: "jump msg" }];
    const s = replayState(stamp(events));
    expect(s.replyNote).toBeNull();
    expect(s.jumpNote).toEqual({ node: "one", message: "jump msg" });
  });
});

describe("notes survive a crash mid-attempt (system-map 0.2)", () => {
  /** simulate the runner dying inside `node`'s attempt: node-started (and its render) logged, never finished */
  const crashInside = (dir: string, node: string, visit: number) =>
    new EventLog(join(dir, "run.jsonl")).append({ type: "node-started", node, visit, attempt_id: `${node}#${visit}` });

  test("reply: the mid-flight re-attempt carries it exactly once, the attempt after none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-reply-"));
    const promptsDir = prompts();
    const seen = new Map<string, string>();
    await replyEngine(dir, promptsDir, { "one@1": "fail" }, seen).start({ goal: "g" });
    resolveReply(dir, "use the v2 API", { graphs: REPLY_GRAPHS });
    crashInside(dir, "one", 2);
    expect(replayState(readLog(join(dir, "run.jsonl"))).replyNote).toEqual({ node: "one", message: "use the v2 API" });

    // the re-attempt of one@2 fails; plain resume retries one@3
    await replyEngine(dir, promptsDir, { "one@2": "fail" }, seen).resume();
    expect(count(seen.get("one@2"), REPLY_HEADING)).toBe(1);
    expect(count(seen.get("one@2"), "use the v2 API")).toBe(1);
    expect(replayState(readLog(join(dir, "run.jsonl"))).replyNote).toBeNull(); // consumed by the finished attempt
    await replyEngine(dir, promptsDir, {}, seen).resume();
    expect(seen.get("one@3")).toBeDefined();
    expect(seen.get("one@3")).not.toContain(REPLY_HEADING);
  });

  test("jump: the mid-flight re-attempt carries the instruction exactly once, the attempt after none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-reply-"));
    const promptsDir = prompts();
    const seen = new Map<string, string>();
    await replyEngine(dir, promptsDir, { "one@1": "fail" }, seen).start({ goal: "g" });
    new EventLog(join(dir, "run.jsonl")).append({ type: "operator-jump", to: "one", message: "narrow the scope", reset_budgets: true });
    crashInside(dir, "one", 2);
    expect(replayState(readLog(join(dir, "run.jsonl"))).jumpNote).toEqual({ node: "one", message: "narrow the scope" });

    await replyEngine(dir, promptsDir, { "one@2": "fail" }, seen).resume();
    expect(count(seen.get("one@2"), "narrow the scope")).toBe(1);
    await replyEngine(dir, promptsDir, {}, seen).resume();
    expect(seen.get("one@3")).not.toContain("narrow the scope");
  });

  test("two crashes in a row on the same attempt still keep the reply and the jump note", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-reply-"));
    const promptsDir = prompts();
    const seen = new Map<string, string>();
    await replyEngine(dir, promptsDir, { "one@1": "fail" }, seen).start({ goal: "g" });
    resolveReply(dir, "use the v2 API", { graphs: REPLY_GRAPHS });
    crashInside(dir, "one", 2);
    crashInside(dir, "one", 2); // the re-attempt died too
    expect(replayState(readLog(join(dir, "run.jsonl"))).replyNote).toEqual({ node: "one", message: "use the v2 API" });
    await replyEngine(dir, promptsDir, {}, seen).resume();
    expect(count(seen.get("one@2"), "use the v2 API")).toBe(1);

    const dir2 = mkdtempSync(join(tmpdir(), "howdah-reply-"));
    const seen2 = new Map<string, string>();
    await replyEngine(dir2, promptsDir, { "one@1": "fail" }, seen2).start({ goal: "g" });
    new EventLog(join(dir2, "run.jsonl")).append({ type: "operator-jump", to: "one", message: "narrow the scope", reset_budgets: true });
    crashInside(dir2, "one", 2);
    crashInside(dir2, "one", 2);
    expect(replayState(readLog(join(dir2, "run.jsonl"))).jumpNote).toEqual({ node: "one", message: "narrow the scope" });
    await replyEngine(dir2, promptsDir, {}, seen2).resume();
    expect(count(seen2.get("one@2"), "narrow the scope")).toBe(1);
  });

  test("a note taken by an attempt that FINISHED is not restored by a later mid-flight crash elsewhere", () => {
    const stamp = (events: object[]) => events.map((e, i) => ({ ...e, seq: i + 1, ts: "t" })) as any[];
    const s = replayState(
      stamp([
        { type: "run-started", graph: "ctl-reply", inputs: {}, pinned_prompts: {} },
        { type: "attention-raised", node: "one", visit: 1, reason: "r", code: "attempt-failed" },
        { type: "attention-resolved", node: "one", visit: 1, reply: "hint", source: "operator" },
        { type: "node-started", node: "one", visit: 2, attempt_id: "one#2" },
        { type: "node-finished", node: "one", visit: 2, status: "succeeded", writes: {} },
        { type: "edge-taken", from: "one", to: "cmd" },
        { type: "node-started", node: "cmd", visit: 1, attempt_id: "cmd#1" },
      ]),
    );
    expect(s.position).toEqual({ node: "cmd", midFlight: true });
    expect(s.replyNote).toBeNull();
  });
});

describe("resume vs a reply landing mid-resume (system-map 0.2)", () => {
  test("a reply appended after resume's replay is adopted, and resume adds no resolution of its own", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-reply-"));
    const promptsDir = prompts();
    const seen = new Map<string, string>();
    // one@1 claims an effect and fails: the pending intent makes resume() await its probe,
    // which is the window between resume's replay and its own resolution
    const claimThenFail = async ({ nodeId, visit, renderedPrompt, effects }: any) => {
      if (renderedPrompt !== undefined) seen.set(`${nodeId}@${visit}`, renderedPrompt);
      if (nodeId === "one" && visit === 1) {
        effects.claim("push");
        return { status: "failed" as const, writes: {} };
      }
      const writes = { one: { a: "a" }, cmd: { b: "b" }, last: { c: "c" } }[nodeId as "one"] ?? {};
      return { status: "succeeded" as const, writes };
    };
    const make = (probe?: EngineOpts["probe"]) =>
      new Engine(replyGraph(), { dir, promptsDir, probe, executors: { agent: claimThenFail, command: claimThenFail, worktree: claimThenFail } });
    expect(await make().start({ goal: "g" })).toMatchObject({ state: "parked", code: "attempt-failed" });

    const result = await make(async () => {
      expect(resolveReply(dir, "late but important", { graphs: REPLY_GRAPHS })).toMatchObject({ ok: true, rendered: true });
      return "not-happened";
    }).resume();
    expect(result).toEqual({ state: "finished", outcome: "success" });
    expect(count(seen.get("one@2"), "late but important")).toBe(1);
    const resolutions = readLog(join(dir, "run.jsonl")).filter((e) => e.type === "attention-resolved");
    expect(resolutions).toEqual([expect.objectContaining({ reply: "late but important", source: "operator" })]);
  });
});
