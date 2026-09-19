import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineGraph } from "../core/graph";
import { Engine } from "./run";
import { readControl, writeControl, clearControl } from "./control";
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
