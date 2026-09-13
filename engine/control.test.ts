import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineGraph } from "../core/graph";
import { Engine } from "./run";
import { readControl, writeControl, clearControl } from "./control";
import { replayState } from "./replay";

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
    expect(jump).toMatchObject({ to: "doc.draft", message: "use British spelling" });
  }, 15000);
});
