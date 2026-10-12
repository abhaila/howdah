/**
 * HOW-43: a visit that fills its context window is continued ONCE automatically — a fresh visit
 * on the same harness, briefed with the HOW-36 handoff — before the run parks for a human.
 * Pinned: the happy path over the fake wire (no park, two visits, VERIFIED), the budget, the
 * no-progress guard, an ambiguous effect parking for the effect, the operator's pause winning,
 * and a resume in a fresh process landing on the same visit and budget.
 */
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineGraph } from "../core/graph";
import { Engine, contextRetriesUsed, type AttemptResult, type EngineOpts, type Executor } from "./run";
import { claudeExecutor } from "./executors/claude";
import { contextExhaustedFailure } from "./executors/harness-failure";
import { replayState } from "./replay";
import { reconstructRender } from "../prompts/library";
import { readLog } from "../log/write";
import type { LoggedEvent } from "../log/events";

const FAKE_CLAUDE = join(import.meta.dir, "executors", "fake-claude.ts");
interface Ctx { goal: string; summary: string }
const graph = (contextRetries?: number) => defineGraph<Ctx>({
  name: "auto-continue", entry: "implement", inputs: ["goal"],
  nodes: {
    implement: { kind: "agent", prompt: "a.implement" as never, reads: ["goal"], writes: { summary: { scope: "sticky" } }, maxVisits: 6, ...(contextRetries === undefined ? {} : { contextRetries }) },
    done: { kind: "terminal", outcome: "success" },
  },
  edges: [{ from: "implement", to: "done" }],
});
function promptsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "howdah-ac-p-"));
  writeFileSync(join(dir, "a.implement.md"), "---\nid: a.implement\nversion: 1\n---\nImplement {{ context.goal }}.\n");
  return dir;
}
const tmp = () => mkdtempSync(join(tmpdir(), "howdah-ac-"));
const started = (events: LoggedEvent[]) => events.flatMap((e) => (e.type === "node-started" && e.node === "implement" ? [e.visit] : []));
const parks = (events: LoggedEvent[]) => events.filter((e) => e.type === "attention-raised");
const continued = (events: LoggedEvent[]) => events.filter((e) => e.type === "context-continued");

/** exhausts on the listed visits (editing a file first when `edits`), succeeds otherwise */
function scripted(exhaustOn: number[], opts: { edits?: boolean; claimEffect?: boolean } = {}): Executor {
  return async ({ nodeId, visit, log, effects }): Promise<AttemptResult> => {
    if (!exhaustOn.includes(visit)) return { status: "succeeded", writes: { summary: `done on ${visit}` } };
    if (opts.edits)
      log.append({ type: "chunk", node: nodeId, visit, turn: 1, index: 0, kind: "tool_call", content: JSON.stringify({ file_path: `f${visit}.ts`, content: "x" }), tool_id: `w${visit}`, tool_name: "Write" });
    if (opts.claimEffect) effects.claim("push");
    const f = contextExhaustedFailure("claude");
    return { status: "failed", writes: {}, reason: f.reason, code: f.code };
  };
}
const engine = (dir: string, agent: Executor, extra: Partial<EngineOpts> = {}, retries?: number, prompts = promptsDir()) =>
  new Engine(graph(retries), { dir, promptsDir: prompts, executors: { agent }, ...extra });

describe("auto-continue after context exhaustion (HOW-43)", () => {
  test("fake-claude exhausts once, then succeeds: no park, two visits, visit 2 briefed with the handoff and VERIFIED", async () => {
    const dir = tmp();
    const claude = claudeExecutor({ attentionDir: join(dir, "attn"), binary: FAKE_CLAUDE, askPollMs: 30, notifiers: [] });
    Object.assign(process.env, { FAKE_CLAUDE_CONTEXT: "exceed-once", FAKE_CLAUDE_CONTEXT_STATE: join(dir, "exceeded"), FAKE_CLAUDE_EXCEED_TOOLS: "1" });
    let result;
    try {
      result = await engine(dir, claude).start({ goal: "fix the parser" });
    } finally {
      for (const k of ["FAKE_CLAUDE_CONTEXT", "FAKE_CLAUDE_CONTEXT_STATE", "FAKE_CLAUDE_EXCEED_TOOLS"]) delete process.env[k];
    }
    expect(result).toEqual({ state: "finished", outcome: "success" });
    const events = readLog(join(dir, "run.jsonl"));
    expect(parks(events)).toEqual([]);
    expect(started(events)).toEqual([1, 2]);
    expect(continued(events)).toEqual([expect.objectContaining({ node: "implement", visit: 1, retry: 1, budget: 1 })]);
    const second = events.find((e) => e.type === "prompt-rendered" && e.visit === 2);
    expect(second).toMatchObject({ reentry_after_visit: 1, suffix_version: 5 });
    const rebuilt = reconstructRender(dir, second!.type === "prompt-rendered" ? second!.rendered_hash : "")!;
    expect(rebuilt).toMatchObject({ verified: true });
    expect(rebuilt.text).toContain("### Files modified\n- src/parser.ts");
  }, 30000);

  test("two exhaustions in a row park, with the new wording", async () => {
    const dir = tmp();
    const result = await engine(dir, scripted([1, 2, 3], { edits: true })).start({ goal: "g" });
    expect(result).toMatchObject({ state: "parked", node: "implement", code: "context-exhausted" });
    expect((result as { reason: string }).reason).toContain("exhausted context 2 times in a row; consider splitting this step");
    const events = readLog(join(dir, "run.jsonl"));
    expect(started(events)).toEqual([1, 2]);
    expect(continued(events)).toHaveLength(1);
  });

  test("no progress: a continuation that exhausted again with no edit and no new commit parks on the first retry, budget or not", async () => {
    const dir = tmp();
    const result = await engine(dir, scripted([1, 2, 3]), {}, 3).start({ goal: "g" });
    expect((result as { reason: string }).reason).toContain("no new commit and no edited file");
    const events = readLog(join(dir, "run.jsonl"));
    expect(started(events)).toEqual([1, 2]);
    expect(contextRetriesUsed(events, "implement")).toBe(1); // the budget of 3 was not spent
  });

  test("an ambiguous effect plus exhaustion parks for the EFFECT, not for exhaustion", async () => {
    const dir = tmp();
    const result = await engine(dir, scripted([1], { claimEffect: true })).start({ goal: "g" });
    expect(result).toMatchObject({ state: "parked", code: "ambiguous-effect" });
    expect((result as { reason: string }).reason).toContain('"push"');
    expect(continued(readLog(join(dir, "run.jsonl")))).toEqual([]);
  });

  test("a probe that proves the effect happened lets the continuation go ahead", async () => {
    const dir = tmp();
    const result = await engine(dir, scripted([1], { claimEffect: true }), { probe: async () => "happened" }).start({ goal: "g" });
    expect(result).toEqual({ state: "finished", outcome: "success" });
  });

  test("a pause during the turn wins: no continuation", async () => {
    const dir = tmp();
    let pausedMidTurn = false; // the operator pressed pause while visit 1 was running
    const agent: Executor = async (args) => { pausedMidTurn = true; return scripted([1], { edits: true })(args); };
    const result = await engine(dir, agent, { control: () => (pausedMidTurn ? "pause" : null) }).start({ goal: "g" });
    expect(result).toMatchObject({ state: "parked", code: "context-exhausted" });
    expect(continued(readLog(join(dir, "run.jsonl")))).toEqual([]);
  });

  test("contextRetries: 0 restores HOW-14's park-every-time", async () => {
    const dir = tmp();
    expect(await engine(dir, scripted([1], { edits: true }), {}, 0).start({ goal: "g" })).toMatchObject({ code: "context-exhausted" });
  });

  test("replay in a fresh process: the same visit count and budget state", async () => {
    // the original run: visit 1 exhausts, the engine continues, visit 2 succeeds
    const dir = tmp();
    const prompts = promptsDir();
    expect(await engine(dir, scripted([1], { edits: true }), {}, undefined, prompts).start({ goal: "g" })).toEqual({ state: "finished", outcome: "success" });
    const full = readLog(join(dir, "run.jsonl"));

    // the same run, cut right after the decision — the runner died before visit 2 started
    const cut = mkdtempSync(join(tmpdir(), "howdah-ac-cut-"));
    cpSync(join(dir, "prompts"), join(cut, "prompts"), { recursive: true });
    const at = full.findIndex((e) => e.type === "context-continued");
    writeFileSync(join(cut, "run.jsonl"), full.slice(0, at + 2).map((e) => JSON.stringify(e)).join("\n") + "\n");
    const replayed = replayState(readLog(join(cut, "run.jsonl")));
    expect(replayed.parked).toBeNull(); // a continuation is not a park
    expect(replayed.visits.implement).toBe(1);
    expect(contextRetriesUsed(readLog(join(cut, "run.jsonl")), "implement")).toBe(1);

    expect(await engine(cut, scripted([], { edits: true }), {}, undefined, prompts).resume()).toEqual({ state: "finished", outcome: "success" });
    const resumed = readLog(join(cut, "run.jsonl"));
    expect(started(resumed)).toEqual(started(full)); // [1, 2]
    // the fresh process briefs visit 2 exactly as the original did
    const brief = (events: LoggedEvent[]) => events.find((e) => e.type === "prompt-rendered" && e.visit === 2);
    expect(brief(resumed)).toMatchObject({ reentry_after_visit: 1, rendered_hash: (brief(full) as { rendered_hash: string }).rendered_hash });
  });
});

describe("the knob round-trips through a GraphSpec (the builder's artifact)", () => {
  test("contextRetries (0 included) and the other HOW-3x knobs survive parseAgentConfig", async () => {
    const { parseAgentConfig } = await import("../core/graph-spec");
    expect(parseAgentConfig({ contextRetries: 0, turnTimeoutMs: 60000, stuckDetection: false, contextCap: 32000 }))
      .toEqual({ contextRetries: 0, turnTimeoutMs: 60000, stuckDetection: false, contextCap: 32000 });
    expect(parseAgentConfig({ contextRetries: -1, contextCap: 0 })).toBeUndefined();
  });
});
