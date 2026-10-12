/**
 * HOW-50 — the runs board's per-run summary, folded incrementally from each log, and the
 * budget that keeps it fast with hundreds of runs.
 */
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../log/write";
import type { RunEvent } from "../log/events";
import { BoardCache, boardRow } from "./board";
import { boardGroup, RECENT_MS } from "./app/lib/board";
import { deriveSummary } from "./derive";
import { readLog } from "../log/write";

function runLog(events: RunEvent[]): string {
  const dir = mkdtempSync(join(tmpdir(), "howdah-board-"));
  const log = new EventLog(join(dir, "run.jsonl"));
  for (const e of events) log.append(e);
  return join(dir, "run.jsonl");
}

const START: RunEvent = { type: "run-started", graph: "implement-ticket", inputs: { goal: "g" }, pinned_prompts: {} };
const node = (n: string, visit = 1): RunEvent => ({ type: "node-started", node: n, visit, attempt_id: `${n}#${visit}` });
const chunk = (n: string, text = "x", visit = 1): RunEvent => ({ type: "chunk", node: n, visit, turn: 1, index: 0, kind: "text", content: text });
const turn = (n: string, cost?: number): RunEvent => ({ type: "turn-finalized", node: n, visit: 1, turn: 1, usage: cost === undefined ? { input_tokens: 1 } : { cost_usd: cost } });

const row = (path: string, cache = new BoardCache(), opts: Parameters<typeof boardRow>[2] = {}) => boardRow("r", cache.fold(path), opts);

describe("the board row", () => {
  test("running: current step, since, last activity, cost so far is a floor while a turn is live", () => {
    const p = runLog([START, node("plan"), chunk("plan"), turn("plan", 0.5), { type: "node-finished", node: "plan", visit: 1, status: "succeeded", writes: {} }, node("build"), chunk("build", "working")]);
    const r = row(p);
    expect(r.status).toBe("running");
    expect(r.current).toMatchObject({ node: "build", visit: 1 });
    expect(r.cost_usd).toBe(0.5);
    expect(r.cost_partial).toBe(true); // build's turn has not reported yet
    const events = readLog(p);
    expect(r.last_activity_at).toBe(events.at(-1)!.ts);
    expect(r.last_event_at).toBe(events.at(-1)!.ts); // a chunk, even though chunks are not kept
  });

  test("parked: needs-input, with the step it is parked on", () => {
    const p = runLog([START, node("build"), { type: "node-finished", node: "build", visit: 1, status: "failed", writes: {} }, { type: "attention-raised", node: "build", visit: 1, reason: "attempt failed", code: "attempt-failed" }]);
    const r = row(p);
    expect(r.status).toBe("needs-input");
    expect(r.needs_input_reason).toBe("attempt failed");
    expect(r.current).toMatchObject({ node: "build", visit: 1 });
  });

  test("done: no current step; the cost is the whole bill when every turn reported one", () => {
    const p = runLog([START, node("build"), turn("build", 1.25), { type: "node-finished", node: "build", visit: 1, status: "succeeded", writes: {} }, { type: "run-finished", outcome: "success" }]);
    const r = row(p);
    expect(r.status).toBe("done");
    expect(r.current).toBeNull();
    expect(r).toMatchObject({ cost_usd: 1.25, cost_partial: false });
  });

  test("failed and aborted are terminal; a turn with no cost (codex) makes the cost a floor", () => {
    const failed = row(runLog([START, node("b"), turn("b"), { type: "run-finished", outcome: "failed" }]));
    expect(failed.status).toBe("failed-terminal");
    expect(failed.cost_partial).toBe(true);
    const aborted = row(runLog([START, node("b"), { type: "run-finished", outcome: "aborted" }]));
    expect(aborted.outcome).toBe("aborted");
  });

  test("a run with no turns yet: no activity, no cost, nothing invented", () => {
    const r = row(runLog([START, node("worktree.create")]));
    expect(r.last_activity_at).toBeNull();
    expect(r.cost_usd).toBe(0);
    expect(r.commits).toBeNull();
    expect(r.pr).toBeNull();
  });

  test("a torn final line is held back, exactly as readLog tolerates it — and folded once it completes", () => {
    const p = runLog([START, node("build")]);
    const cache = new BoardCache();
    appendFileSync(p, '{"type":"chunk","node":"build","vis');
    const r = row(p, cache);
    expect(r.status).toBe("running");
    expect(r.last_activity_at).toBeNull();
    appendFileSync(p, 'it":1,"turn":1,"index":0,"kind":"text","content":"hi","seq":3,"ts":"2026-10-12T10:00:00.000Z"}\n');
    expect(row(p, cache).last_activity_at).toBe("2026-10-12T10:00:00.000Z");
  });

  test("a whole but unterminated final line counts, as readLog counts it", () => {
    const p = runLog([START, node("build")]);
    appendFileSync(p, JSON.stringify({ type: "run-finished", outcome: "success", seq: 3, ts: "2026-10-12T10:00:00.000Z" }));
    expect(row(p).status).toBe("done");
  });

  test("agrees with the full-replay summary on status, name and timing", () => {
    const p = runLog([{ ...START, name: "Fix login" } as RunEvent, node("plan"), chunk("plan"), { type: "attention-raised", node: "plan", visit: 1, reason: "which?" }]);
    const full = deriveSummary("r", readLog(p));
    const r = row(p);
    expect({ status: r.status, name: r.name, waiting_since: r.waiting_since, started_at: r.started_at, last_event_at: r.last_event_at })
      .toEqual({ status: full.status, name: full.name, waiting_since: full.waiting_since, started_at: full.started_at, last_event_at: full.last_event_at });
  });

  test("commits between the first and latest observed HEAD, and the latest PR", () => {
    const rec = (head: string, forge?: any): RunEvent => ({ type: "reconciled", node: "n", git: { repo: true, branch: "b", head, uncommitted: 0, unpushed: 0 }, forge, disagreements: [] });
    const p = runLog([{ ...START, cwd: "/repo" } as RunEvent, rec("aaa"), node("build"), rec("ccc", { kind: "pr", state: "OPEN", url: "https://github.com/o/r/pull/1" })]);
    const calls: string[] = [];
    const cache = new BoardCache({ countCommits: (cwd, base, head) => { calls.push(`${cwd} ${base}..${head}`); return 3; } });
    const opts = { cwd: "/repo", commits: (c: any, b: any, h: any) => cache.commitsBetween(c, b, h) };
    const r = boardRow("r", cache.fold(p), opts);
    expect(r.commits).toBe(3);
    expect(r.pr).toEqual({ url: "https://github.com/o/r/pull/1", state: "OPEN" });
    boardRow("r", cache.fold(p), opts);
    expect(calls).toEqual(["/repo aaa..ccc"]); // two fixed shas: counted once, then cached
  });

  test("the liveness hook can turn a running run into harness-dead", () => {
    const p = runLog([START, node("build"), chunk("build")]);
    const r = row(p, new BoardCache(), { liveness: (s) => ({ ...s, status: "harness-dead" }) });
    expect(r.status).toBe("harness-dead");
  });
});

describe("the fold is incremental", () => {
  test("a second fold reads only what was appended; a log that shrank is refolded", () => {
    const p = runLog([START, node("build")]);
    const cache = new BoardCache();
    const first = cache.fold(p);
    expect(first.events).toHaveLength(2);
    new EventLog(p).append(chunk("build"));
    new EventLog(p).append({ type: "run-finished", outcome: "success" });
    const second = cache.fold(p);
    expect(second.offset).toBeGreaterThan(first.offset);
    expect(second.events.map((e) => e.type)).toEqual(["run-started", "node-started", "run-finished"]); // the chunk was folded, not kept
    writeFileSync(p, readLog(p).slice(0, 1).map((e) => JSON.stringify(e) + "\n").join(""));
    expect(cache.fold(p).events).toHaveLength(1);
  });
});

describe("grouping", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  const at = (ms: number) => new Date(now - ms).toISOString();
  test("needs-you outranks running; harness-dead and retryable failures need you too", () => {
    expect(boardGroup({ status: "needs-input", last_event_at: at(0) }, now)).toBe("needs-you");
    expect(boardGroup({ status: "harness-dead", last_event_at: at(0) }, now)).toBe("needs-you");
    expect(boardGroup({ status: "failed-recoverable", last_event_at: at(0) }, now)).toBe("needs-you");
    expect(boardGroup({ status: "running", last_event_at: at(0) }, now)).toBe("running");
    expect(boardGroup({ status: "waiting", last_event_at: at(0) }, now)).toBe("running");
  });
  test("finished within a day is recent; older than that is older", () => {
    expect(boardGroup({ status: "done", last_event_at: at(RECENT_MS - 1) }, now)).toBe("recent");
    expect(boardGroup({ status: "failed-terminal", last_event_at: at(RECENT_MS + 1) }, now)).toBe("older");
  });
});

/**
 * The budget, agreed in the plan: 300 runs of 2,000 events each (most of them chunks, as on a
 * real $HOWDAH_HOME) — the FIRST fold of all of them under 1.5s, and a tick that appends a few
 * events to a few runs under 100ms. The old list replayed every full log on every refresh.
 */
describe("performance", () => {
  test("300 runs × 2,000 events: first fold < 1.5s, an incremental tick < 100ms", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "howdah-board-perf-"));
    const paths: string[] = [];
    const ts = "2026-10-12T10:00:00.000Z";
    for (let r = 0; r < 300; r++) {
      const dir = join(runsDir, `run-${r}`);
      mkdirSync(dir);
      const lines: string[] = [];
      let seq = 0;
      const push = (e: object) => lines.push(JSON.stringify({ ...e, seq: ++seq, ts }));
      push(START);
      for (let n = 0; n < 20; n++) {
        push(node(`n${n}`));
        for (let c = 0; c < 97; c++) push({ type: "chunk", node: `n${n}`, visit: 1, turn: 1, index: c, kind: "text", content: "streaming delta of a sentence " });
        push({ type: "turn-finalized", node: `n${n}`, visit: 1, turn: 1, usage: { cost_usd: 0.01 } });
        push({ type: "node-finished", node: `n${n}`, visit: 1, status: "succeeded", writes: {} });
      }
      const p = join(dir, "run.jsonl");
      writeFileSync(p, lines.join("\n") + "\n");
      paths.push(p);
    }
    expect(readLog(paths[0]!).length).toBe(2001);
    const cache = new BoardCache();
    const t0 = performance.now();
    for (const p of paths) boardRow("r", cache.fold(p));
    const first = performance.now() - t0;

    for (const p of paths.slice(0, 5)) appendFileSync(p, JSON.stringify({ type: "chunk", node: "n19", visit: 1, turn: 1, index: 999, kind: "text", content: "more", seq: 9999, ts }) + "\n");
    const t1 = performance.now();
    for (const p of paths) boardRow("r", cache.fold(p));
    const tick = performance.now() - t1;
    console.log(`board: first fold ${first.toFixed(0)}ms, incremental tick ${tick.toFixed(0)}ms`);
    expect(first).toBeLessThan(1500);
    expect(tick).toBeLessThan(100);
  }, 60_000);
});

describe("the routes", () => {
  test("GET /api/runs returns board rows; /api/board/events says which run changed", async () => {
    const { createHowdahServer } = await import("./server");
    const home = mkdtempSync(join(tmpdir(), "howdah-board-srv-"));
    const runsDir = join(home, "runs");
    const a = new EventLog(join(runsDir, "a", "run.jsonl"));
    a.append(START);
    a.append(node("build"));
    new EventLog(join(runsDir, "b", "run.jsonl")).append(START);
    const server = createHowdahServer({ runsDir, attentionDir: join(home, "attention"), port: 0, pollMs: 20, graphs: {} });
    try {
      const rows = (await (await fetch(`http://localhost:${server.port}/api/runs`)).json()) as RunBoardRowLike[];
      expect(rows.map((r) => r.id).sort()).toEqual(["a", "b"]);
      // no runner holds "a", so the liveness rule the run page uses applies here too
      expect(rows.find((r) => r.id === "a")).toMatchObject({ status: "harness-dead", current: { node: "build", visit: 1 } });

      const res = await fetch(`http://localhost:${server.port}/api/board/events`);
      const reader = res.body!.getReader();
      await reader.read(); // ": connected"
      a.append(chunk("build"));
      let frame = "";
      for (let i = 0; i < 20 && !frame.includes("data: "); i++) frame += new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
      expect(JSON.parse(frame.split("data: ")[1]!.split("\n")[0]!)).toEqual({ changed: ["a"] });
    } finally {
      server.stop(true);
    }
  });
});

type RunBoardRowLike = { id: string; status: string; current: unknown };
