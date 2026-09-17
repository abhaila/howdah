import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineGraph } from "../core/graph";
import { Engine, type Executor, type AttemptResult } from "./run";
import { replayState } from "./replay";
import { PromptStore } from "../prompts/store";
import { readLog } from "../log/write";

interface Ctx {
  goal: string;
  discovery: "candidate" | "idle";
  verdict: "pass" | "reject";
  summary: string;
}

// prompt fixture dir shared by tests — engine pins from here
function promptFixtures(): string {
  const dir = mkdtempSync(join(tmpdir(), "howdah-prompts-"));
  const write = (id: string, version: number, body: string) =>
    writeFileSync(join(dir, `${id}.md`), `---\nid: ${id}\nversion: ${version}\n---\n${body}`);
  write("discover", 1, "Find work toward {{ context.goal }}.\n");
  write("implementation.implement", 1, "Implement per {{ context.goal }}. Prior: {{ context.summary }}\n");
  write("implementation.local_review", 2, "Review {{ context.summary }} against {{ context.goal }}.\n");
  write("delivery.publish", 1, "Publish the work for {{ context.goal }}.\n");
  return dir;
}

// a simple lint-ish pipeline: implement -> review -> (pass: publish | reject: implement again)
function pipelineGraph() {
  return defineGraph<Ctx>({
    name: "mini-pipeline",
    entry: "implement",
    inputs: ["goal", "summary"],
    nodes: {
      implement: { kind: "agent", prompt: "implementation.implement", reads: ["goal", "summary"], writes: { summary: { scope: "sticky" } }, maxVisits: 3 },
      review: { kind: "agent", prompt: "implementation.local_review", reads: ["goal", "summary"], writes: { verdict: { scope: "cleared" } } },
      publish: { kind: "command", run: "probe:publish", reads: ["summary"] },
      done: { kind: "terminal", outcome: "success" },
    },
    edges: [
      { from: "implement", to: "review" },
      { from: "review", to: "implement", condition: { reads: ["verdict"], test: (v) => v.verdict === "reject", label: "verdict == 'reject'" }, weight: 2 },
      { from: "review", to: "publish", condition: { reads: ["verdict"], test: (v) => v.verdict === "pass", label: "verdict == 'pass'" }, weight: 1 },
      { from: "publish", to: "done" },
    ],
  });
}

const ok = (writes: Record<string, unknown> = {}): AttemptResult => ({ status: "succeeded", writes });

describe("engine loop + routing", () => {
  test("runs the pipeline to terminal, taking the weighted conditional path", async () => {
    const verdicts: Ctx["verdict"][] = ["reject", "pass"]; // first review rejects, second passes
    const engine = new Engine(pipelineGraph(), {
      dir: mkdtempSync(join(tmpdir(), "howdah-run-")),
      promptsDir: promptFixtures(),
      executors: {
        agent: async ({ nodeId }) =>
          nodeId === "review" ? ok({ verdict: verdicts.shift()! }) : ok({ summary: "did the work" }),
        command: async () => ok(),
      },
    });
    const result = await engine.start({ goal: "ship it", summary: "" });
    expect(result).toEqual({ state: "finished", outcome: "success" });

    const events = engine.log.read();
    const edges = events.filter((e) => e.type === "edge-taken").map((e: any) => `${e.from}>${e.to}`);
    expect(edges).toEqual(["implement>review", "review>implement", "implement>review", "review>publish", "publish>done"]);
  });

  test("maxVisits exceeded parks the run with attention", async () => {
    const engine = new Engine(pipelineGraph(), {
      dir: mkdtempSync(join(tmpdir(), "howdah-run-")),
      promptsDir: promptFixtures(),
      executors: {
        agent: async ({ nodeId }) => (nodeId === "review" ? ok({ verdict: "reject" }) : ok({ summary: "s" })),
        command: async () => ok(),
      },
    });
    const result = await engine.start({ goal: "g", summary: "" });
    expect(result).toMatchObject({ state: "parked", node: "implement" });
    expect((result as any).reason).toContain("maxVisits");
    expect(engine.log.read().some((e) => e.type === "attention-raised")).toBe(true);
  });

  test("failed attempt parks; context write is NOT published (publish-on-success)", async () => {
    const engine = new Engine(pipelineGraph(), {
      dir: mkdtempSync(join(tmpdir(), "howdah-run-")),
      promptsDir: promptFixtures(),
      executors: {
        agent: async () => ({ status: "failed", writes: { summary: "poison" } }),
        command: async () => ok(),
      },
    });
    const result = await engine.start({ goal: "g", summary: "" });
    expect(result).toMatchObject({ state: "parked", reason: "attempt failed" });
    const finished: any = engine.log.read().find((e) => e.type === "node-finished");
    expect(finished.status).toBe("failed");
  });

  test("claude allowance exhaustion retries the same agent node on codex", async () => {
    const seen: Array<{ node: string; visit: number; harness?: string }> = [];
    const engine = new Engine(pipelineGraph(), {
      dir: mkdtempSync(join(tmpdir(), "howdah-run-")),
      promptsDir: promptFixtures(),
      executors: {
        agent: async ({ nodeId, visit, agentConfig, log }) => {
          seen.push({ node: nodeId, visit, harness: agentConfig?.harness });
          if (nodeId === "implement" && agentConfig?.harness === "claude") {
            log.append({ type: "allowance", harness: "claude", state: "exhausted" });
            return { status: "failed", writes: {} };
          }
          return nodeId === "review" ? ok({ verdict: "pass" }) : ok({ summary: "codex did the work" });
        },
        command: async () => ok(),
      },
    });

    const result = await engine.start({ goal: "g", summary: "" });

    expect(result).toEqual({ state: "finished", outcome: "success" });
    expect(seen).toEqual([
      { node: "implement", visit: 1, harness: "claude" },
      { node: "implement", visit: 2, harness: "codex" },
      { node: "review", visit: 1, harness: "codex" },
    ]);
    const finishes = engine.log.read().filter((e: any) => e.type === "node-finished" && e.node === "implement") as any[];
    expect(finishes.map((e) => e.status)).toEqual(["failed", "succeeded"]);
    expect(finishes[1].writes).toEqual({ summary: "codex did the work" });
  });

  test("claude session-limit text falls back even when allowance says ok", async () => {
    const seen: Array<{ node: string; visit: number; harness?: string }> = [];
    const engine = new Engine(pipelineGraph(), {
      dir: mkdtempSync(join(tmpdir(), "howdah-run-")),
      promptsDir: promptFixtures(),
      executors: {
        agent: async ({ nodeId, visit, agentConfig, log }) => {
          seen.push({ node: nodeId, visit, harness: agentConfig?.harness });
          if (nodeId === "implement" && agentConfig?.harness === "claude") {
            log.append({ type: "allowance", harness: "claude", state: "ok" });
            log.append({
              type: "chunk",
              node: nodeId,
              visit,
              turn: 1,
              index: 0,
              kind: "text",
              content: "[turn error: You've hit your session limit · resets 4:10pm]",
            });
            return { status: "failed", writes: {} };
          }
          return nodeId === "review" ? ok({ verdict: "pass" }) : ok({ summary: "codex recovered" });
        },
        command: async () => ok(),
      },
    });

    const result = await engine.start({ goal: "g", summary: "" });

    expect(result).toEqual({ state: "finished", outcome: "success" });
    expect(seen.slice(0, 2)).toEqual([
      { node: "implement", visit: 1, harness: "claude" },
      { node: "implement", visit: 2, harness: "codex" },
    ]);
  });

  test("codex fallback survives resume before the next agent node", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-run-"));
    const seen: Array<{ node: string; visit: number; harness?: string; process: 1 | 2 }> = [];
    let pauseAtReview = false;
    const first = new Engine(pipelineGraph(), {
      dir,
      promptsDir: promptFixtures(),
      control: () => pauseAtReview ? "pause" : null,
      executors: {
        agent: async ({ nodeId, visit, agentConfig, log }) => {
          seen.push({ node: nodeId, visit, harness: agentConfig?.harness, process: 1 });
          if (nodeId === "implement" && agentConfig?.harness === "claude") {
            log.append({
              type: "chunk",
              node: nodeId,
              visit,
              turn: 1,
              index: 0,
              kind: "text",
              content: "[turn error: You've hit your session limit]",
            });
            return { status: "failed", writes: {} };
          }
          pauseAtReview = true;
          return ok({ summary: "codex did the work" });
        },
        command: async () => ok(),
      },
    });

    expect(await first.start({ goal: "g", summary: "" })).toEqual({ state: "paused", node: "review" });

    const second = new Engine(pipelineGraph(), {
      dir,
      promptsDir: promptFixtures(),
      executors: {
        agent: async ({ nodeId, visit, agentConfig }) => {
          seen.push({ node: nodeId, visit, harness: agentConfig?.harness, process: 2 });
          return ok({ verdict: "pass" });
        },
        command: async () => ok(),
      },
    });

    expect(await second.resume()).toEqual({ state: "finished", outcome: "success" });
    expect(seen).toEqual([
      { node: "implement", visit: 1, harness: "claude", process: 1 },
      { node: "implement", visit: 2, harness: "codex", process: 1 },
      { node: "review", visit: 1, harness: "codex", process: 2 },
    ]);
  });

  test("prompt-rendered carries context_read and version; outcomes attribute verdict + terminal", async () => {
    const engine = new Engine(pipelineGraph(), {
      dir: mkdtempSync(join(tmpdir(), "howdah-run-")),
      promptsDir: promptFixtures(),
      executors: {
        agent: async ({ nodeId }) => (nodeId === "review" ? ok({ verdict: "pass" }) : ok({ summary: "s2" })),
        command: async () => ok(),
      },
    });
    await engine.start({ goal: "ship", summary: "" });
    const events = engine.log.read();
    const rendered: any = events.find((e) => e.type === "prompt-rendered");
    expect(rendered.prompt).toBe("implementation.implement");
    expect(rendered.prompt_version).toBe(1);
    expect(rendered.context_read).toEqual({ goal: "ship", summary: "" });

    const outcomes: any[] = events.filter((e) => e.type === "prompt-outcome");
    const reviewHash = (events.find((e: any) => e.type === "prompt-rendered" && e.node === "review") as any).rendered_hash;
    expect(outcomes.some((o) => o.rendered_hash === reviewHash && o.verdict_downstream === "verdict == 'pass'")).toBe(true);
    expect(outcomes.some((o) => o.rendered_hash === reviewHash && o.terminal_outcome === "success")).toBe(true);
  });
});

describe("exactly-once side effects (OV-1)", () => {
  function publishingEngine(dir: string, opts: { crashDuringEffect?: boolean; probe?: "happened" | "not-happened" | "unknown"; prCount: { n: number } }) {
    const command: Executor = async ({ effects }) => {
      if (!effects.claim("create-pr")) {
        if (opts.crashDuringEffect) throw new Error("SIMULATED CRASH between intent and done");
        opts.prCount.n++;
        effects.done("create-pr", { url: "https://pr/1" });
      }
      return ok();
    };
    return new Engine(pipelineGraph(), {
      dir,
      promptsDir: promptFixtures(),
      executors: {
        agent: async ({ nodeId }) => (nodeId === "review" ? ok({ verdict: "pass" }) : ok({ summary: "s" })),
        command,
      },
      probe: async () => opts.probe ?? "unknown",
    });
  }

  test("crash between intent and done + probe says happened: resume does NOT duplicate the PR", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-run-"));
    const prCount = { n: 0 };
    const first = publishingEngine(dir, { crashDuringEffect: true, prCount });
    const r1 = await first.start({ goal: "g", summary: "" });
    expect(r1.state).toBe("parked"); // executor threw after intent

    // resume in a fresh engine (new process, same dir); probe finds the PR exists
    const second = publishingEngine(dir, { probe: "happened", prCount });
    const r2 = await second.resume();
    expect(r2).toEqual({ state: "finished", outcome: "success" });
    expect(prCount.n).toBe(0); // never executed the effect again
    const done: any = second.log.read().find((e) => e.type === "side-effect-done");
    expect(done.result).toEqual({ probed: true });
  });

  test("probe says not-happened: retry runs the effect exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-run-"));
    const prCount = { n: 0 };
    await publishingEngine(dir, { crashDuringEffect: true, prCount }).start({ goal: "g", summary: "" });
    const r2 = await publishingEngine(dir, { probe: "not-happened", prCount }).resume();
    expect(r2).toEqual({ state: "finished", outcome: "success" });
    expect(prCount.n).toBe(1);
  });

  test("probe cannot decide: run parks instead of risking a duplicate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-run-"));
    const prCount = { n: 0 };
    await publishingEngine(dir, { crashDuringEffect: true, prCount }).start({ goal: "g", summary: "" });
    const r2 = await publishingEngine(dir, { probe: "unknown", prCount }).resume();
    expect(r2).toMatchObject({ state: "parked" });
    expect((r2 as any).reason).toContain("ambiguous side effect");
    expect(prCount.n).toBe(0);
  });
});

describe("run pinning (OV-2)", () => {
  test("a parked run keeps its pinned prompt versions across an accepted revision", async () => {
    const promptsDir = promptFixtures();
    const runDir = mkdtempSync(join(tmpdir(), "howdah-run-"));

    // park immediately: review always rejects, maxVisits 3 on implement
    const make = () =>
      new Engine(pipelineGraph(), {
        dir: runDir,
        promptsDir,
        executors: {
          agent: async ({ nodeId, renderedPrompt }) =>
            nodeId === "review" ? ok({ verdict: "reject" }) : ok({ summary: renderedPrompt! }),
          command: async () => ok(),
        },
      });
    const r1 = await make().start({ goal: "g", summary: "" });
    expect(r1.state).toBe("parked");

    // a revision lands in the STORE while the run is parked
    const store = new PromptStore(promptsDir);
    writeFileSync(join(promptsDir, "implementation.implement.md"), `---\nid: implementation.implement\nversion: 9\n---\nREVISED {{ context.goal }}\n`);
    expect(store.load("implementation.implement").version).toBe(9);

    // resume: still parked (maxVisits), but every render so far and the pin are v1
    const events = readLog(join(runDir, "run.jsonl"));
    const started: any = events.find((e) => e.type === "run-started");
    expect(started.pinned_prompts["implementation.implement"]).toBe(1);
    const renders: any[] = events.filter((e: any) => e.type === "prompt-rendered" && e.prompt === "implementation.implement");
    expect(renders.every((r) => r.prompt_version === 1)).toBe(true);
    expect(renders.every((r) => !String(r.rendered_hash).includes("REVISED"))).toBe(true);
  });
});

describe("resume-by-replay (R7)", () => {
  test("kill after review, resume completes with replayed context (cleared scope replays)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-run-"));
    const promptsDir = promptFixtures();
    // first engine: crash inside publish (before any effect claim)
    const first = new Engine(pipelineGraph(), {
      dir,
      promptsDir,
      executors: {
        agent: async ({ nodeId }) => (nodeId === "review" ? ok({ verdict: "pass" }) : ok({ summary: "replayed!" })),
        command: async () => { throw new Error("power cut"); },
      },
    });
    expect((await first.start({ goal: "g", summary: "" })).state).toBe("parked");

    const second = new Engine(pipelineGraph(), {
      dir,
      promptsDir,
      executors: {
        agent: async ({ nodeId }) => (nodeId === "review" ? ok({ verdict: "pass" }) : ok({ summary: "should-not-run" })),
        command: async ({ reads }) => {
          expect(reads.summary).toBe("replayed!"); // context rebuilt from the log, not re-executed
          return ok();
        },
      },
    });
    // the park (attention) must be resolved before continuing
    second.log.append({ type: "attention-resolved", node: "publish", visit: 1, reply: "retry" });
    const r2 = await second.resume();
    expect(r2).toEqual({ state: "finished", outcome: "success" });
    // implement/review were NOT re-executed: no new prompt-rendered for them after resume
    const renders = second.log.read().filter((e) => e.type === "prompt-rendered");
    expect(renders).toHaveLength(2); // one per agent node, from the FIRST life only
  });

  test("resume() on a finished run is a no-op returning the outcome", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-run-"));
    const promptsDir = promptFixtures();
    const make = () =>
      new Engine(pipelineGraph(), {
        dir,
        promptsDir,
        executors: {
          agent: async ({ nodeId }) => (nodeId === "review" ? ok({ verdict: "pass" }) : ok({ summary: "s" })),
          command: async () => ok(),
        },
      });
    await make().start({ goal: "g", summary: "" });
    expect(await make().resume()).toEqual({ state: "finished", outcome: "success" });
  });

  test("replayState: mid-flight node, pending intent, park bookkeeping", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-run-"));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "run.jsonl");
    const lines = [
      { type: "run-started", graph: "g", inputs: { goal: "x" }, pinned_prompts: {}, seq: 1, ts: "t" },
      { type: "node-started", node: "a", visit: 1, attempt_id: "a#1", seq: 2, ts: "t" },
      { type: "node-finished", node: "a", visit: 1, status: "succeeded", writes: { k: 1 }, seq: 3, ts: "t" },
      { type: "edge-taken", from: "a", to: "b", seq: 4, ts: "t" },
      { type: "node-started", node: "b", visit: 1, attempt_id: "b#1", seq: 5, ts: "t" },
      { type: "side-effect-intent", node: "b", visit: 1, attempt_id: "b#1", effect: "push", seq: 6, ts: "t" },
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const s = replayState(readLog(path));
    expect(s.position).toEqual({ node: "b", midFlight: true });
    expect(s.pendingIntents).toHaveLength(1);
    expect(s.visits).toEqual({ a: 1, b: 1 });
    expect(s.finishes).toHaveLength(1);
    expect(s.parked).toBeNull();
  });
});
