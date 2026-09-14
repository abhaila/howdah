import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineGraph } from "../core/graph";
import { Engine } from "./run";

interface Ctx { goal: string; a: string; b: string; }

function prompts(): string {
  const dir = mkdtempSync(join(tmpdir(), "howdah-cfg-p-"));
  writeFileSync(join(dir, "doc.draft.md"), `---\nid: doc.draft\nversion: 1\n---\nGo {{ context.goal }}.\n`);
  return dir;
}

const graph = () =>
  defineGraph<Ctx>({
    name: "cfg",
    defaults: { model: "graph-default-model", effort: "medium", permissionMode: "acceptEdits" },
    entry: "one",
    inputs: ["goal"],
    nodes: {
      one: { kind: "agent", prompt: "doc.draft", reads: ["goal"], writes: { a: { scope: "sticky" } }, model: "claude-opus-5", skills: ["review"] },
      two: { kind: "agent", prompt: "doc.draft", reads: ["goal"], writes: { b: { scope: "sticky" } }, harness: "codex", effort: "xhigh" },
      done: { kind: "terminal", outcome: "success" },
    },
    edges: [
      { from: "one", to: "two" },
      { from: "two", to: "done" },
    ],
  });

describe("per-node agent config (T17)", () => {
  test("node beats graph default; unset falls through; resolution lands in ExecArgs AND the log", async () => {
    const seen: any[] = [];
    const engine = new Engine(graph(), {
      dir: mkdtempSync(join(tmpdir(), "howdah-cfg-")),
      promptsDir: prompts(),
      executors: {
        agent: async ({ nodeId, agentConfig }) => {
          seen.push({ nodeId, ...agentConfig });
          return { status: "succeeded", writes: nodeId === "one" ? { a: "x" } : { b: "y" } };
        },
      },
    });
    await engine.start({ goal: "g" });

    expect(seen[0]).toMatchObject({ nodeId: "one", harness: "claude", model: "claude-opus-5", effort: "medium", skills: ["review"] });
    expect(seen[1]).toMatchObject({ nodeId: "two", harness: "codex", model: "graph-default-model", effort: "xhigh" });

    // the resolved config is IN THE RECORD per turn — Orbital's "Model —" gap, closed
    const renders: any[] = engine.log.read().filter((e) => e.type === "prompt-rendered");
    expect(renders[0]).toMatchObject({ node: "one", model: "claude-opus-5", harness: "claude" });
    expect(renders[1]).toMatchObject({ node: "two", model: "graph-default-model", harness: "codex", effort: "xhigh" });
  });

  test("run-level override beats both node and graph default (Orbital order)", async () => {
    const seen: any[] = [];
    const engine = new Engine(graph(), {
      dir: mkdtempSync(join(tmpdir(), "howdah-cfg-")),
      promptsDir: prompts(),
      overrides: { model: "haiku", harness: "claude" },
      executors: {
        agent: async ({ nodeId, agentConfig }) => {
          seen.push({ nodeId, ...agentConfig });
          return { status: "succeeded", writes: nodeId === "one" ? { a: "x" } : { b: "y" } };
        },
      },
    });
    await engine.start({ goal: "g" });
    expect(seen.every((s) => s.model === "haiku" && s.harness === "claude")).toBe(true);
    expect(seen[1].effort).toBe("xhigh"); // untouched fields still resolve per node
  });
});

describe("UI tuning overlay", () => {
  test("resolution: run override → node tuning → TS node → graph tuning → TS default", async () => {
    const seen: any[] = [];
    const make = (opts: any = {}) =>
      new Engine(graph(), {
        dir: mkdtempSync(join(tmpdir(), "howdah-tune-")),
        promptsDir: prompts(),
        ...opts,
        executors: {
          agent: async ({ nodeId, agentConfig }) => {
            seen.push({ nodeId, ...agentConfig });
            return { status: "succeeded", writes: nodeId === "one" ? { a: "x" } : { b: "y" } };
          },
        },
      });

    // node tuning beats the TS node's own model; graph tuning beats TS defaults
    await make({
      tuning: {
        defaults: { effort: "low" },
        nodes: { one: { model: "tuned-model", permissionMode: "manual" } },
      },
    }).start({ goal: "g" });
    // graph-level tuning beats the TS graph default (effort low, not medium)…
    expect(seen[0]).toMatchObject({ nodeId: "one", model: "tuned-model", permissionMode: "manual", effort: "low" });
    // …but an explicit TS node setting survives graph-level tuning (two keeps its xhigh)
    expect(seen[1]).toMatchObject({ nodeId: "two", effort: "xhigh", model: "graph-default-model" });
    seen.length = 0;

    // run override still beats node tuning
    await make({
      tuning: { nodes: { one: { model: "tuned-model" } } },
      overrides: { model: "run-model" },
    }).start({ goal: "g" });
    expect(seen[0]!.model).toBe("run-model");
  });
});

describe("overrides survive resume (implement-ticket-mu1brke9 regression)", () => {
  test("run-started persists overrides and replay hands them back", async () => {
    const { replayState } = await import("./replay");
    const engine = new Engine(graph(), {
      dir: mkdtempSync(join(tmpdir(), "howdah-ovr-")),
      promptsDir: prompts(),
      overrides: { harness: "codex", model: "gpt-5.3-codex", effort: "medium" },
      executors: { agent: async ({ nodeId }) => ({ status: "succeeded", writes: nodeId === "one" ? { a: "x" } : { b: "y" } }) },
    });
    await engine.start({ goal: "g" });
    const started = replayState(engine.log.read()).started!;
    expect(started.overrides).toEqual({ harness: "codex", model: "gpt-5.3-codex", effort: "medium" });
  });
});

describe("cross-harness model leak (haiku→codex regression)", () => {
  test("a model from a lower layer is dropped when it does not fit the resolved harness", async () => {
    const seen: any[] = [];
    const engine = new Engine(graph(), {
      dir: mkdtempSync(join(tmpdir(), "howdah-leak-")),
      promptsDir: prompts(),
      overrides: { harness: "codex" },
      tuning: { defaults: { model: "haiku" } }, // claude model in tuning
      executors: { agent: async ({ nodeId, agentConfig }) => { seen.push(agentConfig); return { status: "succeeded", writes: nodeId === "one" ? { a: "x" } : { b: "y" } }; } },
    });
    await engine.start({ goal: "g" });
    expect(seen[0]).toMatchObject({ harness: "codex" });
    expect(seen[0].model).toBeUndefined(); // haiku dropped — codex uses its own default
    // node "one" declares claude-opus-5 in TS — clearly claude, dropped under codex;
    // unknown names (graph-default-model) are NOT dropped: custom models must pass
    expect(seen.every((s: any) => s.model === undefined || !/claude|opus|sonnet|haiku/i.test(s.model))).toBe(true);
  });
});
