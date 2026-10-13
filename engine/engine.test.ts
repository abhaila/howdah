import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineGraph } from "../core/graph";
import { Engine, type Executor, type AttemptResult, type EngineOpts } from "./run";
import { replayState } from "./replay";
import { resolveEffect, supervisorShouldResume } from "./control";
import { PromptStore } from "../prompts/store";
import { readLog } from "../log/write";
import type { LoggedEvent } from "../log/events";
import { buildOutputInstruction, renderedHash } from "../core/template";
import { reconstructRender } from "../prompts/library";

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

const lastPark = (events: LoggedEvent[]) => events.filter((e) => e.type === "attention-raised").at(-1);

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
    expect(result).toMatchObject({ state: "parked", node: "implement", code: "max-visits" });
    expect((result as any).reason).toContain("maxVisits");
    expect(lastPark(engine.log.read())).toMatchObject({ node: "implement", visit: 4, code: "max-visits" });
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

  /**
   * HOW-17, the ticket's own case: "allow cursor to be used as a backup when we run out of
   * tokens for claude or codex". Before this the fallback was a BOOLEAN — claude→codex or
   * nothing — so a run whose codex allowance was also gone simply parked. The chain makes
   * the hop an ordered walk, and the third hop is a fresh visit that is still not charged to
   * maxVisits, exactly as the second one always was.
   */
  test("claude AND codex exhausted: the node hops on to cursor, and the rest of the run follows", async () => {
    const seen: Array<{ node: string; visit: number; harness?: string }> = [];
    const engine = new Engine(pipelineGraph(), {
      dir: mkdtempSync(join(tmpdir(), "howdah-run-")),
      promptsDir: promptFixtures(),
      executors: {
        agent: async ({ nodeId, visit, agentConfig, log }) => {
          seen.push({ node: nodeId, visit, harness: agentConfig?.harness });
          for (const harness of ["claude", "codex"] as const) {
            if (agentConfig?.harness !== harness) continue;
            log.append({ type: "allowance", harness, state: "exhausted" });
            return { status: "failed", writes: {} };
          }
          return nodeId === "review" ? ok({ verdict: "pass" }) : ok({ summary: "cursor did the work" });
        },
        command: async () => ok(),
      },
    });

    expect(await engine.start({ goal: "g", summary: "" })).toEqual({ state: "finished", outcome: "success" });
    expect(seen).toEqual([
      { node: "implement", visit: 1, harness: "claude" },
      { node: "implement", visit: 2, harness: "codex" },
      { node: "implement", visit: 3, harness: "cursor" },
      { node: "review", visit: 1, harness: "cursor" },
    ]);
    // implement declares maxVisits 3 (pipelineGraph): three visits without a hop would have
    // been fine, but the point is that neither fallback visit was charged
    const text = engine.log.read().filter((e: any) => e.type === "chunk").map((e: any) => e.content).join("");
    expect(text).toContain("[claude allowance exhausted: retrying this node with codex]");
    expect(text).toContain("[codex allowance exhausted: retrying this node with cursor]");
  });

  test("HOW-33: a hop re-resolves effort for the new harness — mapped for codex, inert on cursor", async () => {
    const engine = new Engine(pipelineGraph(), {
      dir: mkdtempSync(join(tmpdir(), "howdah-run-")),
      promptsDir: promptFixtures(),
      overrides: { effort: "max" },
      executors: {
        agent: async ({ agentConfig, log }) => {
          log.append({ type: "allowance", harness: agentConfig!.harness!, state: "exhausted" });
          return { status: "failed", writes: {} };
        },
        command: async () => ok(),
      },
    });
    await engine.start({ goal: "g", summary: "" });
    const renders = engine.log.read().filter((e: any) => e.type === "prompt-rendered") as any[];
    expect(renders.map((e) => [e.harness, e.effort, e.effort_inert])).toEqual([
      ["claude", "max", undefined],
      ["codex", "xhigh", undefined], // claude's `max` never reaches codex verbatim
      ["cursor", undefined, "effort max: not supported by cursor"],
    ]);
  });

  test("the chain is exhausted too: the run parks on the last attempt rather than looping", async () => {
    const engine = new Engine(pipelineGraph(), {
      dir: mkdtempSync(join(tmpdir(), "howdah-run-")),
      promptsDir: promptFixtures(),
      executors: {
        agent: async ({ agentConfig, log }) => {
          log.append({ type: "allowance", harness: agentConfig!.harness!, state: "exhausted" });
          return { status: "failed", writes: {} };
        },
        command: async () => ok(),
      },
    });
    const result = await engine.start({ goal: "g", summary: "" });
    expect(result).toMatchObject({ state: "parked", node: "implement", code: "attempt-failed" });
    // one attempt per harness in the chain, and no more
    const renders = engine.log.read().filter((e: any) => e.type === "prompt-rendered") as any[];
    expect(renders.map((e) => e.harness)).toEqual(["claude", "codex", "cursor"]);
  });

  test("config.json can reorder the chain: cursor first", async () => {
    const seen: string[] = [];
    const engine = new Engine(pipelineGraph(), {
      dir: mkdtempSync(join(tmpdir(), "howdah-run-")),
      promptsDir: promptFixtures(),
      harnesses: { fallbackChain: ["claude", "cursor", "codex"] },
      executors: {
        agent: async ({ nodeId, agentConfig, log }) => {
          seen.push(agentConfig!.harness!);
          if (agentConfig?.harness === "claude") {
            log.append({ type: "allowance", harness: "claude", state: "exhausted" });
            return { status: "failed", writes: {} };
          }
          return nodeId === "review" ? ok({ verdict: "pass" }) : ok({ summary: "s" });
        },
        command: async () => ok(),
      },
    });
    expect(await engine.start({ goal: "g", summary: "" })).toEqual({ state: "finished", outcome: "success" });
    expect(seen).toEqual(["claude", "cursor", "cursor"]);
  });

  test("the configured default harness is what an undeclared node runs on", async () => {
    const seen: string[] = [];
    const engine = new Engine(pipelineGraph(), {
      dir: mkdtempSync(join(tmpdir(), "howdah-run-")),
      promptsDir: promptFixtures(),
      harnesses: { default: "cursor" },
      executors: {
        agent: async ({ nodeId, agentConfig }) => {
          seen.push(agentConfig!.harness!);
          return nodeId === "review" ? ok({ verdict: "pass" }) : ok({ summary: "s" });
        },
        command: async () => ok(),
      },
    });
    expect(await engine.start({ goal: "g", summary: "" })).toEqual({ state: "finished", outcome: "success" });
    expect(seen).toEqual(["cursor", "cursor"]);
  });

  // Rebase reconciliation (system-map 0.1 x upstream codex fallback): the fallback retry is
  // a NEW visit rendered after the harness decision, so its prompt-rendered carries the
  // harness actually used and that harness's skill hint, and both renders reconstruct VERIFIED.
  test("a codex fallback re-renders for codex: harness, skills and hash match the attempt that ran", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-run-"));
    const sent: Array<{ visit: number; harness?: string; prompt: string }> = [];
    const engine = new Engine(pipelineGraph(), {
      dir,
      promptsDir: promptFixtures(),
      tuning: { nodes: { implement: { skills: ["review"] } } },
      executors: {
        agent: async ({ nodeId, visit, agentConfig, log, renderedPrompt }) => {
          if (nodeId === "implement") sent.push({ visit, harness: agentConfig?.harness, prompt: renderedPrompt ?? "" });
          if (nodeId === "implement" && agentConfig?.harness === "claude") {
            log.append({ type: "allowance", harness: "claude", state: "exhausted" });
            return { status: "failed", writes: {} };
          }
          return nodeId === "review" ? ok({ verdict: "pass" }) : ok({ summary: "codex did the work" });
        },
        command: async () => ok(),
      },
    });

    expect(await engine.start({ goal: "g", summary: "" })).toEqual({ state: "finished", outcome: "success" });

    const renders = engine.log.read().filter((e) => e.type === "prompt-rendered" && e.node === "implement") as any[];
    expect(renders.map((r) => [r.visit, r.harness, r.skills])).toEqual([
      [1, "claude", ["review"]],
      [2, "codex", []],
    ]);
    expect(sent.map((s) => [s.visit, s.harness])).toEqual([[1, "claude"], [2, "codex"]]);
    expect(sent[0]!.prompt).toContain("/review");
    expect(sent[1]!.prompt).not.toContain("Relevant installed skills");
    sent.forEach((s, i) => expect(renderedHash(s.prompt)).toBe(renders[i].rendered_hash));
    for (const r of renders) expect(reconstructRender(dir, r.rendered_hash)?.verified).toBe(true);
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
    expect(r2).toMatchObject({ state: "parked", code: "ambiguous-effect" });
    expect((r2 as any).reason).toContain("ambiguous side effect");
    // system-map 0.2: the logged ask carries the code a reply is judged by
    expect(lastPark(publishingEngine(dir, { prCount }).log.read())).toMatchObject({ code: "ambiguous-effect", node: "publish" });
    expect(prCount.n).toBe(0);
  });

  // HOW-3: the operator is the probe of last resort. These pin that replay honours the
  // attestation both ways — the whole point of the verb.
  test("operator says it happened: the retry skips the effect and the run finishes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-run-"));
    const prCount = { n: 0 };
    await publishingEngine(dir, { crashDuringEffect: true, prCount }).start({ goal: "g", summary: "" });
    expect(await publishingEngine(dir, { probe: "unknown", prCount }).resume()).toMatchObject({ code: "ambiguous-effect" });

    const r = resolveEffect(dir, "create-pr", "happened");
    expect(r).toMatchObject({ ok: true, node: "publish", effect: "create-pr", verdict: "happened", idempotent: false });

    const r2 = await publishingEngine(dir, { probe: "unknown", prCount }).resume();
    expect(r2).toEqual({ state: "finished", outcome: "success" });
    expect(prCount.n).toBe(0); // never executed the effect again
  });

  test("operator says it did not happen: the retry claims and runs the effect exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-run-"));
    const prCount = { n: 0 };
    await publishingEngine(dir, { crashDuringEffect: true, prCount }).start({ goal: "g", summary: "" });
    expect(await publishingEngine(dir, { probe: "unknown", prCount }).resume()).toMatchObject({ code: "ambiguous-effect" });

    expect(resolveEffect(dir, "create-pr", "not-happened")).toMatchObject({ ok: true, verdict: "not-happened" });

    const r2 = await publishingEngine(dir, { probe: "unknown", prCount }).resume();
    expect(r2).toEqual({ state: "finished", outcome: "success" });
    expect(prCount.n).toBe(1);
    // the intent was claimed afresh, and this time it was proven done
    const log = readLog(join(dir, "run.jsonl"));
    expect(log.filter((e) => e.type === "side-effect-intent")).toHaveLength(2);
    expect(log.filter((e) => e.type === "side-effect-done")).toHaveLength(1);
  });

  test("a resolution answers the park, so `up` resumes even if the spawned resume died", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-run-"));
    const prCount = { n: 0 };
    await publishingEngine(dir, { crashDuringEffect: true, prCount }).start({ goal: "g", summary: "" });
    await publishingEngine(dir, { probe: "unknown", prCount }).resume();
    const parked = replayState(readLog(join(dir, "run.jsonl")));
    expect(parked.parked).toMatchObject({ code: "ambiguous-effect" });
    expect(supervisorShouldResume(parked, null)).toBe(false);

    resolveEffect(dir, "create-pr", "happened");

    // nothing else ran: no attention-resolved, yet the run is no longer waiting on a human
    const after = replayState(readLog(join(dir, "run.jsonl")));
    expect(after.parked).toBeNull();
    expect(after.answeredPark).toMatchObject({ code: "ambiguous-effect", node: "publish" });
    expect(after.pendingIntents).toEqual([]);
    expect(supervisorShouldResume(after, null)).toBe(true);
    expect(supervisorShouldResume(after, "pause")).toBe(false); // the operator still owns a held run
  });
});

describe("run name (HOW-18)", () => {
  const engineFor = (dir: string, fail: { first: boolean }, name?: string) =>
    new Engine(pipelineGraph(), {
      dir,
      promptsDir: promptFixtures(),
      ...(name !== undefined ? { name } : {}),
      executors: {
        agent: async ({ nodeId }) => {
          if (fail.first) { fail.first = false; return { status: "failed", writes: {} }; }
          return nodeId === "review" ? ok({ verdict: "pass" }) : ok({ summary: "s" });
        },
        command: async () => ok(),
      },
    });

  test("the name is stamped once on run-started and survives park + resume", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-run-"));
    const fail = { first: true };
    expect((await engineFor(dir, fail, "Fix login").start({ goal: "g", summary: "" })).state).toBe("parked");
    // the resuming runner is built WITHOUT a name, as `howdah resume` builds it: the log keeps it
    expect(await engineFor(dir, fail).resume()).toEqual({ state: "finished", outcome: "success" });
    const events = readLog(join(dir, "run.jsonl"));
    const starts = events.filter((e) => e.type === "run-started");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ type: "run-started", name: "Fix login", graph: "mini-pipeline", inputs: { goal: "g" } });
    expect(replayState(events).started).toMatchObject({ name: "Fix login" });
  });

  test("an unnamed run writes no name key — the pre-HOW-18 event shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-run-"));
    await engineFor(dir, { first: false }).start({ goal: "g", summary: "" });
    const started = readLog(join(dir, "run.jsonl")).find((e) => e.type === "run-started")!;
    expect("name" in started).toBe(false);
  });

  test("an empty name is treated as no name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-run-"));
    await engineFor(dir, { first: false }, "").start({ goal: "g", summary: "" });
    expect("name" in readLog(join(dir, "run.jsonl")).find((e) => e.type === "run-started")!).toBe(false);
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

describe("render proof covers every suffix (system-map 0.1)", () => {
  const skilled = (harness: "claude" | "codex" | "opencode") =>
    defineGraph<Ctx>({
      name: "mini-skilled",
      entry: "implement",
      inputs: ["goal", "summary"],
      defaults: { harness },
      nodes: {
        implement: { kind: "agent", prompt: "implementation.implement", reads: ["goal", "summary"], writes: { summary: { scope: "sticky" } }, skills: ["review"] },
        done: { kind: "terminal", outcome: "success" },
      },
      edges: [{ from: "implement", to: "done" }],
    });

  for (const harness of ["claude", "opencode", "codex"] as const) {
    test(`${harness}: the prompt handed to the executor is exactly the hashed text`, async () => {
      let handed = "";
      const engine = new Engine(skilled(harness), {
        dir: mkdtempSync(join(tmpdir(), "howdah-run-")),
        promptsDir: promptFixtures(),
        executors: { agent: async ({ renderedPrompt }) => ((handed = renderedPrompt!), ok({ summary: "s" })) },
      });
      await engine.start({ goal: "g", summary: "p" });
      const render: any = engine.log.read().find((e) => e.type === "prompt-rendered");
      expect(renderedHash(handed)).toBe(render.rendered_hash);
      expect(handed.startsWith("Implement per g. Prior: p\n")).toBe(true);
      expect(handed.endsWith(buildOutputInstruction(["summary"]))).toBe(true);
      expect(handed.includes("/review")).toBe(harness !== "codex");
      expect(render).toMatchObject({ skills: harness === "codex" ? [] : ["review"], output_keys: ["summary"], suffix_version: 7 });
    });
  }
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

describe("every park carries its code (system-map 0.2)", () => {
  const engineWith = (executors: EngineOpts["executors"], extra: { maxSteps?: number } = {}) =>
    new Engine(pipelineGraph(), { dir: mkdtempSync(join(tmpdir(), "howdah-run-")), promptsDir: promptFixtures(), executors, ...extra });

  test("a failed attempt parks with attempt-failed, reason text unchanged", async () => {
    const engine = engineWith({ agent: async () => ({ status: "failed", writes: {} }) });
    expect(await engine.start({ goal: "g", summary: "" })).toEqual({
      state: "parked", node: "implement", reason: "attempt failed", code: "attempt-failed",
    });
    expect(lastPark(engine.log.read())).toMatchObject({ node: "implement", visit: 1, reason: "attempt failed", code: "attempt-failed" });
  });

  test("a throwing executor parks with executor-threw", async () => {
    const engine = engineWith({ agent: async () => { throw new Error("boom"); } });
    expect(await engine.start({ goal: "g", summary: "" })).toMatchObject({ state: "parked", code: "executor-threw", reason: "executor threw: boom" });
    expect(lastPark(engine.log.read())).toMatchObject({ node: "implement", code: "executor-threw" });
  });

  test("a command node's failure carries the same code — the reply rule, not the engine, tells kinds apart", async () => {
    const engine = engineWith({
      agent: async ({ nodeId }) => (nodeId === "review" ? ok({ verdict: "pass" }) : ok({ summary: "s" })),
      command: async () => ({ status: "failed", writes: {} }),
    });
    expect(await engine.start({ goal: "g", summary: "" })).toMatchObject({ state: "parked", node: "publish", code: "attempt-failed" });
  });

  test("exhausted conditions park with no-edge", async () => {
    const engine = engineWith({ agent: async ({ nodeId }) => (nodeId === "review" ? ok({ verdict: "maybe" }) : ok({ summary: "s" })) });
    expect(await engine.start({ goal: "g", summary: "" })).toMatchObject({ state: "parked", node: "review", code: "no-edge" });
    expect(lastPark(engine.log.read())).toMatchObject({ code: "no-edge", reason: "no edge matched (conditions exhausted)" });
  });

  test("the step guard parks with max-steps", async () => {
    const engine = engineWith({ agent: async ({ nodeId }) => (nodeId === "review" ? ok({ verdict: "reject" }) : ok({ summary: "s" })) }, { maxSteps: 2 });
    expect(await engine.start({ goal: "g", summary: "" })).toMatchObject({ state: "parked", code: "max-steps", reason: "maxSteps reached (2)" });
    expect(lastPark(engine.log.read())).toMatchObject({ code: "max-steps" });
  });

  test("resume()'s own resolution is marked source resume", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-run-"));
    const promptsDir = promptFixtures();
    const make = (fail: boolean) =>
      new Engine(pipelineGraph(), {
        dir, promptsDir,
        executors: {
          agent: async ({ nodeId }) => (fail ? { status: "failed", writes: {} } : nodeId === "review" ? ok({ verdict: "pass" }) : ok({ summary: "s" })),
          command: async () => ok(),
        },
      });
    await make(true).start({ goal: "g", summary: "" });
    await make(false).resume();
    const resolved = readLog(join(dir, "run.jsonl")).filter((e) => e.type === "attention-resolved");
    expect(resolved).toEqual([expect.objectContaining({ node: "implement", visit: 1, reply: "resume", source: "resume" })]);
  });
});
