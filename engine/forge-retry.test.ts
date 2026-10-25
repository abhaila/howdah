/**
 * HOW-69: a read-only forge probe (`probe:pr`) that cannot reach the forge is retried by the
 * ENGINE with bounded backoff (30s, 2m, 5m) before the run parks for a human. The run that
 * filed the ticket parked on a GraphQL timeout and drew a reply box that could only be refused.
 * Pinned: a transient failure recovers with no park and a `forge-retried` fact in the log; a
 * persistent one retries three times at the backoff then parks executor-threw saying so; the
 * operator's pause wins; "no PR" (a different outcome) is never retried; an agent node is never
 * retried this way; and the budget restarts once the operator resumes a park.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineGraph } from "../core/graph";
import { Engine, FORGE_RETRY_BACKOFF_MS, forgeRetriesUsed, type AttemptResult, type EngineOpts, type Executor } from "./run";
import { ForgeUnreachableError } from "./executors/git";
import { readLog } from "../log/write";
import type { LoggedEvent } from "../log/events";

interface Ctx { goal: string; "pr.state": string; summary: string }
const graph = (run = "probe:pr") => defineGraph<Ctx>({
  name: "forge-retry", entry: "probe", inputs: ["goal"],
  nodes: {
    probe: { kind: "command", run, writes: { "pr.state": { scope: "sticky" } } },
    agent: { kind: "agent", prompt: "a.do" as never, reads: ["goal"], writes: { summary: { scope: "sticky" } } },
    done: { kind: "terminal", outcome: "success" },
  },
  edges: [{ from: "probe", to: "agent" }, { from: "agent", to: "done" }],
});
function promptsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "howdah-fr-p-"));
  writeFileSync(join(dir, "a.do.md"), "---\nid: a.do\nversion: 1\n---\nDo {{ context.goal }}.\n");
  return dir;
}
const tmp = () => mkdtempSync(join(tmpdir(), "howdah-fr-"));
const UNREACHABLE = "Post https://api.github.com/graphql: operation timed out";

/** the probe: throws `failOn[visit]` (unreachable / no PR), succeeds otherwise */
function probe(failOn: Record<number, "unreachable" | "no-pr">): Executor {
  return async ({ visit }): Promise<AttemptResult> => {
    const f = failOn[visit];
    if (f === "unreachable") throw new ForgeUnreachableError(UNREACHABLE);
    if (f === "no-pr") throw new Error(`no PR exists for "howdah/x" — was publish skipped?`);
    return { status: "succeeded", writes: { "pr.state": "OPEN" } };
  };
}
const agentOk: Executor = async () => ({ status: "succeeded", writes: { summary: "ok" } });

function engine(dir: string, command: Executor, extra: Partial<EngineOpts> = {}, agent: Executor = agentOk, run?: string) {
  const slept: number[] = [];
  const e = new Engine(graph(run), {
    dir, promptsDir: promptsDir(), executors: { command, agent },
    sleep: async (ms) => void slept.push(ms), ...extra,
  });
  return { e, slept };
}
const events = (dir: string): LoggedEvent[] => readLog(join(dir, "run.jsonl"));
const retried = (es: LoggedEvent[]) => es.filter((e) => e.type === "forge-retried");
const parks = (es: LoggedEvent[]) => es.filter((e) => e.type === "attention-raised");

describe("forge-unreachable retry on a read-only probe (HOW-69)", () => {
  test("a transient failure: retried after 30s, no park, a forge-retried fact and an engine note", async () => {
    const dir = tmp();
    const { e, slept } = engine(dir, probe({ 1: "unreachable" }));
    expect(await e.start({ goal: "g" })).toEqual({ state: "finished", outcome: "success" });
    const es = events(dir);
    expect(parks(es)).toEqual([]);
    expect(slept).toEqual([30_000]);
    expect(retried(es)).toEqual([expect.objectContaining({
      node: "probe", visit: 1, retry: 1, budget: 3, delay_ms: 30_000, reason: `forge unreachable: ${UNREACHABLE}`,
    })]);
    expect(es.some((x) => x.type === "chunk" && x.node === "probe" && x.content.includes("[forge unreachable — retrying automatically in 30s (1 of 3)]"))).toBe(true);
    expect(es.filter((x) => x.type === "node-started" && x.node === "probe").map((x: any) => x.visit)).toEqual([1, 2]);
  });

  test("persistently unreachable: three retries at 30s / 2m / 5m, then an executor-threw park that says so", async () => {
    const dir = tmp();
    const { e, slept } = engine(dir, probe({ 1: "unreachable", 2: "unreachable", 3: "unreachable", 4: "unreachable" }));
    const r = await e.start({ goal: "g" });
    expect(r).toMatchObject({ state: "parked", node: "probe", code: "executor-threw" });
    expect(slept).toEqual([...FORGE_RETRY_BACKOFF_MS]);
    expect(slept).toEqual([30_000, 120_000, 300_000]);
    const es = events(dir);
    expect(retried(es).map((x: any) => [x.visit, x.retry])).toEqual([[1, 1], [2, 2], [3, 3]]);
    expect(parks(es)).toEqual([expect.objectContaining({
      node: "probe", visit: 4, code: "executor-threw",
      reason: `executor threw: forge unreachable: ${UNREACHABLE} — forge unreachable 4 times in a row`,
    })]);
  });

  test("the budget restarts once the operator resumes the park", async () => {
    const dir = tmp();
    const failing = probe({ 1: "unreachable", 2: "unreachable", 3: "unreachable", 4: "unreachable", 5: "unreachable" });
    await engine(dir, failing).e.start({ goal: "g" });
    expect(forgeRetriesUsed(events(dir), "probe")).toBe(0); // the park closed the streak
    const { e, slept } = engine(dir, failing);
    expect(await e.resume()).toEqual({ state: "finished", outcome: "success" });
    expect(slept).toEqual([30_000]); // visit 5 failed, retried from a fresh budget; visit 6 succeeded
  });

  test("a pending pause parks at once — the operator's control wins", async () => {
    const dir = tmp();
    const { e, slept } = engine(dir, probe({ 1: "unreachable" }), { control: () => null });
    let calls = 0;
    (e as any).opts.control = () => (calls++ === 0 ? null : "pause"); // clear at the boundary, set by the failure
    expect(await e.start({ goal: "g" })).toMatchObject({ state: "parked", node: "probe", code: "executor-threw" });
    expect(slept).toEqual([]);
    expect(retried(events(dir))).toEqual([]);
  });

  test('"no PR" is a different outcome and is never retried', async () => {
    const dir = tmp();
    const { e, slept } = engine(dir, probe({ 1: "no-pr" }));
    expect(await e.start({ goal: "g" })).toMatchObject({ state: "parked", node: "probe", code: "executor-threw" });
    expect(slept).toEqual([]);
    expect(retried(events(dir))).toEqual([]);
  });

  test("only probe:pr is retried — a general command that throws the same error parks", async () => {
    const dir = tmp();
    const { e, slept } = engine(dir, probe({ 1: "unreachable" }), {}, agentOk, "gh pr view");
    expect(await e.start({ goal: "g" })).toMatchObject({ state: "parked", node: "probe" });
    expect(slept).toEqual([]);
    expect(retried(events(dir))).toEqual([]);
  });

  test("the retry keys on the error's TYPE, not its words — a plain Error saying 'forge unreachable' parks", async () => {
    const dir = tmp();
    const plain: Executor = async () => { throw new Error(`forge unreachable: ${UNREACHABLE}`); };
    const { e, slept } = engine(dir, plain);
    expect(await e.start({ goal: "g" })).toMatchObject({ state: "parked", node: "probe", code: "executor-threw" });
    expect(slept).toEqual([]);
    expect(retried(events(dir))).toEqual([]);
  });

  test("an agent node's forge throw is never retried this way", async () => {
    const dir = tmp();
    const agent: Executor = async () => { throw new ForgeUnreachableError(UNREACHABLE); };
    const { e, slept } = engine(dir, probe({}), {}, agent);
    expect(await e.start({ goal: "g" })).toMatchObject({ state: "parked", node: "agent", code: "executor-threw" });
    expect(slept).toEqual([]);
    expect(retried(events(dir))).toEqual([]);
  });
});
