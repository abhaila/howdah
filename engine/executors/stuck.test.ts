/**
 * HOW-38: stuck detection and the turn ceiling.
 *
 * The streak table pins the paper's definition (identical name + arguments, consecutive), the
 * fake-claude tests pin what the operator sees: 8 identical failing calls park `stuck` naming
 * the command, 8 identical successes only warn, denials count for nothing, and a hung turn
 * past `turnTimeoutMs` parks `turn-timeout` with its whole process group gone.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreakTracker, looksLikeDenial, stuckReason, stuckReminder, TurnCeiling } from "./stuck";
import { argumentsHash, toolArguments } from "../../adapter/tools";
import { claudeExecutor } from "./claude";
import { Engine, type AttemptResult } from "../run";
import { defineGraph } from "../../core/graph";
import { EventLog } from "../../log/write";
import { stuckThresholds } from "../../config/config";
import type { LoggedEvent } from "../../log/events";

const FAKE = join(import.meta.dir, "fake-claude.ts");

describe("the streak (paper definition: same tool, byte-identical arguments, consecutive)", () => {
  const T = { warn: 5, stop: 8 };
  /** feed (name, args, isError) calls in order; returns every signal with its 1-based call number */
  function feed(calls: Array<[string, unknown, boolean, boolean?]>, thresholds = T) {
    const t = new StreakTracker(thresholds);
    const signals: Array<{ at: number; kind: string; count: number; failing: number }> = [];
    calls.forEach(([name, args, isError, denied], i) => {
      const id = `c${i}`;
      t.call(id, name, argumentsHash("claude", name, args), JSON.stringify(args));
      const s = t.result(id, isError, isError ? "boom" : "ok", denied === true);
      if (s) signals.push({ at: i + 1, kind: s.kind, count: s.count, failing: s.failing });
    });
    return signals;
  }
  const bash = (cmd: string) => ["Bash", { command: cmd }] as const;
  const times = <X>(n: number, x: X): X[] => Array.from({ length: n }, () => x);

  test("8 identical failing calls: warn at 5, stop at 8", () => {
    expect(feed(times(8, [...bash("bun test"), true] as [string, unknown, boolean]))).toEqual([
      { at: 5, kind: "warn", count: 5, failing: 5 },
      { at: 8, kind: "stop", count: 8, failing: 8 },
    ]);
  });

  test("identical SUCCESSFUL calls warn once and never stop (a polling loop)", () => {
    expect(feed(times(20, [...bash("gh pr checks"), false] as [string, unknown, boolean]))).toEqual([
      { at: 5, kind: "warn", count: 5, failing: 0 },
    ]);
  });

  test("a paginated read at a new offset is a different call: nothing trips", () => {
    const reads = Array.from({ length: 12 }, (_, i) => ["Read", { file_path: "big.ts", offset: i * 100 }, false] as [string, unknown, boolean]);
    expect(feed(reads)).toEqual([]);
  });

  test("a streak broken by one different call and resumed is a NEW streak", () => {
    const fail = [...bash("bun test"), true] as [string, unknown, boolean];
    const calls = [...times(4, fail), [...bash("cat x"), false] as [string, unknown, boolean], ...times(7, fail)];
    expect(feed(calls)).toEqual([{ at: 10, kind: "warn", count: 5, failing: 5 }]); // 4 + 7: never 8 in a row
  });

  test("a success inside a streak resets the FAILING count (stop needs 8 failures in a row)", () => {
    const fail = [...bash("bun test"), true] as [string, unknown, boolean];
    const pass = [...bash("bun test"), false] as [string, unknown, boolean];
    const signals = feed([...times(7, fail), pass, ...times(7, fail)]);
    expect(signals.map((s) => s.kind)).toEqual(["warn"]);
  });

  test("permission denials count for nothing — not toward the warning, not toward the stop", () => {
    expect(feed(times(12, [...bash("rm -rf build"), true, true] as [string, unknown, boolean, boolean]))).toEqual([]);
  });

  test("arguments are compared in FULL, not as the 400-char clip the log keeps", () => {
    const long = (tail: string) => ({ command: `${"x".repeat(500)}${tail}` });
    expect(argumentsHash("claude", "Bash", long("a"))).not.toBe(argumentsHash("claude", "Bash", long("b")));
    // key order does not make two argument sets different
    expect(argumentsHash("claude", "Edit", { a: 1, b: 2 })).toBe(argumentsHash("claude", "Edit", { b: 2, a: 1 }));
  });

  test("codex: the item's id/status/output are not arguments — two identical commands hash alike", () => {
    const item = (id: string, status: string) => ({ id, type: "commandExecution", command: "bun test", cwd: "/w", status, aggregatedOutput: id });
    expect(toolArguments("codex", "commandExecution", item("1", "inProgress"))).toEqual({ command: "bun test", cwd: "/w" });
    expect(argumentsHash("codex", "commandExecution", item("1", "inProgress"))).toBe(argumentsHash("codex", "commandExecution", item("2", "completed")));
  });

  test("the reminder and the park reason name the call and the error", () => {
    const s = { kind: "stop" as const, tool: "Bash", summary: '{"command":"bun test"}', count: 8, failing: 8, last_error: "expected 2, got 3" };
    expect(stuckReminder(s)).toContain("SAME arguments 8 times");
    expect(stuckReason(s)).toContain('{"command":"bun test"}');
    expect(stuckReason(s)).toContain("expected 2, got 3");
    expect(looksLikeDenial("Permission to use Bash has been denied.")).toBe(true);
    expect(looksLikeDenial("error: expected 2, got 3")).toBe(false);
  });

  test("config.json thresholds are cleaned: defaults, and stop never below warn", () => {
    expect(stuckThresholds({ repos: {}, folders: {} })).toEqual({ warn: 5, stop: 8 });
    expect(stuckThresholds({ repos: {}, folders: {}, stuck: { warn: 3, stop: 2 } })).toEqual({ warn: 3, stop: 3 });
    expect(stuckThresholds({ repos: {}, folders: {}, stuck: { warn: -1, stop: 1.5 } as any })).toEqual({ warn: 5, stop: 8 });
  });

  test("the ceiling does not run while paused (a human's thinking time)", async () => {
    let fired = false;
    const c = new TurnCeiling(80, () => { fired = true; });
    c.start();
    await Bun.sleep(30);
    c.pause();
    await Bun.sleep(120);
    expect(fired).toBe(false);
    c.start();
    await Bun.sleep(120);
    expect(fired).toBe(true);
  });
});

interface Ctx { goal: string; summary: string }
function oneNodeGraph(config: { turnTimeoutMs?: number; stuckDetection?: boolean } = {}) {
  return defineGraph<Ctx>({
    name: "stuck-mini",
    entry: "work",
    inputs: ["goal"],
    nodes: {
      work: { kind: "agent", prompt: "doc.draft" as never, reads: ["goal"], writes: { summary: { scope: "sticky" } }, ...config },
      done: { kind: "terminal", outcome: "success" },
    },
    edges: [{ from: "work", to: "done" }],
  });
}
function promptDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "howdah-stuck-p-"));
  writeFileSync(join(dir, "doc.draft.md"), "---\nid: doc.draft\nversion: 1\n---\nDo {{ context.goal }}.\n");
  return dir;
}

async function runFake(env: Record<string, string>, config: { turnTimeoutMs?: number; stuckDetection?: boolean } = {}, replier?: string) {
  const dir = mkdtempSync(join(tmpdir(), "howdah-stuck-"));
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const stop = { done: false };
  // answers every ask with `replier` (the deny case), the way the web card would
  const answering = replier === undefined ? Promise.resolve() : (async () => {
    const path = join(dir, "run.jsonl");
    let answered = 0;
    while (!stop.done) {
      await Bun.sleep(20);
      if (!existsSync(path)) continue;
      const events = new EventLog(path).read();
      const asks = events.filter((e) => e.type === "attention-raised");
      if (asks.length > answered) {
        const ask = asks[answered]!;
        new EventLog(path).append({ type: "attention-resolved", node: ask.node, visit: ask.visit, reply: replier });
        answered++;
      }
    }
  })();
  try {
    const engine = new Engine(oneNodeGraph(config), {
      dir,
      promptsDir: promptDir(),
      executors: { agent: claudeExecutor({ attentionDir: join(dir, "attn"), binary: FAKE, askPollMs: 20, notifiers: [] }) },
    });
    const result = await engine.start({ goal: "fix the flaky test" });
    return { result, events: engine.log.read(), dir };
  } finally {
    stop.done = true;
    await answering;
    for (const k of Object.keys(env)) delete process.env[k];
  }
}

const warnings = (events: LoggedEvent[]) => events.filter((e) => e.type === "stuck-warning");

describe("claude executor: stuck detection over the fake wire (HOW-38)", () => {
  test("8 identical failing Bash calls park `stuck`, and the reason names the command", async () => {
    const { result, events } = await runFake({ FAKE_CLAUDE_REPEAT: "12", FAKE_CLAUDE_REPEAT_FAIL: "1" });
    expect(result).toMatchObject({ state: "parked", node: "work", code: "stuck" });
    expect((result as { reason: string }).reason).toContain("bun test engine/flaky.test.ts");
    expect((result as { reason: string }).reason).toContain("expected 2, got 3");
    // one warning first, and claude was reminded mid-turn (the SPIKE)
    expect(warnings(events)).toEqual([expect.objectContaining({ tool_name: "Bash", count: 5, failing: 5, reminded: true })]);
    // the full arguments were hashed before the clip, on every call chunk
    const calls = events.filter((e) => e.type === "chunk" && e.kind === "tool_call");
    expect(calls.every((e) => e.type === "chunk" && typeof e.input_hash === "string")).toBe(true);
    expect(new Set(calls.map((e) => e.type === "chunk" && e.input_hash)).size).toBe(1);
  }, 20000);

  test("8 identical SUCCESSFUL calls warn but do not park", async () => {
    const { result, events } = await runFake({ FAKE_CLAUDE_REPEAT: "8" });
    expect(result).toEqual({ state: "finished", outcome: "success" });
    expect(warnings(events)).toHaveLength(1);
    const results = events.filter((e) => e.type === "chunk" && e.kind === "tool_result");
    expect(results.every((e) => e.type === "chunk" && e.is_error === false)).toBe(true);
  }, 20000);

  test("permission denials do not count: 8 denied identical calls neither warn nor park `stuck`", async () => {
    const { result, events } = await runFake({ FAKE_CLAUDE_REPEAT: "8", FAKE_CLAUDE_REPEAT_DENY: "1" }, {}, "no, do not run that");
    expect(result).toEqual({ state: "finished", outcome: "success" });
    expect(warnings(events)).toEqual([]);
    expect(events.filter((e) => e.type === "attention-raised")).toHaveLength(8);
  }, 30000);

  test("a node can opt out (stuckDetection: false) — a polling step never warns or stops", async () => {
    const { result, events } = await runFake({ FAKE_CLAUDE_REPEAT: "10", FAKE_CLAUDE_REPEAT_FAIL: "1" }, { stuckDetection: false });
    expect(result).toEqual({ state: "finished", outcome: "success" });
    expect(warnings(events)).toEqual([]);
  }, 20000);

  test("turnTimeoutMs parks a hung turn `turn-timeout` and leaves no process of its group alive", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "howdah-pid-")), "pids");
    const { result } = await runFake({ FAKE_CLAUDE_HANG: "1", FAKE_CLAUDE_PIDFILE: pidFile }, { turnTimeoutMs: 1500 });
    expect(result).toMatchObject({ state: "parked", node: "work", code: "turn-timeout" });
    const [leader, child] = readFileSync(pidFile, "utf8").split(" ").map(Number) as [number, number];
    const alive = (pid: number, group = false) => { try { process.kill(group ? -pid : pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 40 && (alive(leader, true) || alive(child)); i++) await Bun.sleep(100);
    expect(alive(leader, true)).toBe(false); // the group is gone: ESRCH
    expect(alive(child)).toBe(false); // including the grandchild the harness started
  }, 20000);
});

describe("engine: a stuck or timed-out attempt never hops harnesses (HOW-38)", () => {
  for (const code of ["stuck", "turn-timeout"] as const) {
    test(`${code} parks on the same harness even when the transcript says "rate limit"`, async () => {
      const seen: string[] = [];
      const engine = new Engine(oneNodeGraph(), {
        dir: mkdtempSync(join(tmpdir(), "howdah-stuck-hop-")),
        promptsDir: promptDir(),
        executors: {
          agent: async ({ nodeId, visit, log, agentConfig }): Promise<AttemptResult> => {
            seen.push(agentConfig!.harness!);
            log.append({ type: "chunk", node: nodeId, visit, turn: 1, index: 0, kind: "text", content: "writing the rate limit handler" });
            return { status: "failed", writes: {}, reason: `${code}: …`, code };
          },
        },
      });
      expect(await engine.start({ goal: "g" })).toMatchObject({ state: "parked", code });
      expect(seen).toEqual(["claude"]);
    });
  }
});

describe("a reply resumes a stuck park, carrying the stuck facts (HOW-38)", () => {
  test("the retry's prompt holds the reply AND the call that kept failing, and reconstructs VERIFIED", async () => {
    const { resolveReply } = await import("../control");
    const { reconstructRender } = await import("../../prompts/library");
    const dir = mkdtempSync(join(tmpdir(), "howdah-stuck-reply-"));
    const prompts = promptDir();
    const seen: string[] = [];
    let first = true;
    const make = () => new Engine(oneNodeGraph(), {
      dir, promptsDir: prompts,
      executors: {
        agent: async ({ renderedPrompt }): Promise<AttemptResult> => {
          seen.push(renderedPrompt ?? "");
          if (first) {
            first = false;
            return { status: "failed", writes: {}, code: "stuck", reason: 'stuck: Bash was called 8 times in a row with identical arguments and failed the last 8 — call: {"command":"bun test"}' };
          }
          return { status: "succeeded", writes: { summary: "fixed" } };
        },
      },
    });
    expect(await make().start({ goal: "g" })).toMatchObject({ state: "parked", code: "stuck" });
    expect(resolveReply(dir, "the test needs the fixture rebuilt first", { graphs: { "stuck-mini": oneNodeGraph() } })).toMatchObject({ ok: true, code: "stuck", rendered: true });
    expect(await make().resume()).toEqual({ state: "finished", outcome: "success" });
    expect(seen[1]).toContain("the test needs the fixture rebuilt first");
    expect(seen[1]).toContain('{"command":"bun test"}');
    const rendered = new EventLog(join(dir, "run.jsonl")).read().filter((e) => e.type === "prompt-rendered").at(-1)!;
    expect(rendered.type === "prompt-rendered" && reconstructRender(dir, rendered.rendered_hash)).toMatchObject({ verified: true });
  });
});
