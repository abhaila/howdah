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
