import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, readLog } from "./write";
import { processStart } from "./lockfile";
import { coalesce, outcomesByHash } from "./coalesce";
import type { LoggedEvent } from "./events";

const dir = () => mkdtempSync(join(tmpdir(), "howdah-log-"));

function fixedClock(): () => Date {
  let t = 0;
  return () => new Date(1757000000000 + ++t * 1000);
}

describe("EventLog", () => {
  test("appends stamped events and reads them back", () => {
    const log = new EventLog(join(dir(), "run.jsonl"), fixedClock());
    log.append({ type: "run-started", graph: "implement-ticket", inputs: { goal: "g" }, pinned_prompts: { discover: 1 } });
    log.append({ type: "node-started", node: "discover", visit: 1, attempt_id: "a1" });
    const events = log.read();
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events[0]!.type).toBe("run-started");
  });

  test("sequence continues across writer restarts (resume-by-replay)", () => {
    const path = join(dir(), "run.jsonl");
    new EventLog(path, fixedClock()).append({ type: "run-started", graph: "g", inputs: {}, pinned_prompts: {} });
    const resumed = new EventLog(path, fixedClock());
    const e = resumed.append({ type: "run-finished", outcome: "success" });
    expect(e.seq).toBe(2);
  });

  test("since() returns only newer events", () => {
    const log = new EventLog(join(dir(), "run.jsonl"), fixedClock());
    log.append({ type: "run-started", graph: "g", inputs: {}, pinned_prompts: {} });
    log.append({ type: "run-finished", outcome: "success" });
    expect(log.since(1).map((e) => e.type)).toEqual(["run-finished"]);
  });

  test("torn final line (mid-write crash) is dropped, prior events survive", () => {
    const path = join(dir(), "run.jsonl");
    const log = new EventLog(path, fixedClock());
    log.append({ type: "run-started", graph: "g", inputs: {}, pinned_prompts: {} });
    log.append({ type: "chunk", node: "n", visit: 1, turn: 1, index: 0, kind: "text", content: "kept" });
    appendFileSync(path, '{"type":"chunk","node":"n","vi'); // torn write
    const events = readLog(path);
    expect(events).toHaveLength(2);
    expect(events[1]!.type).toBe("chunk");
  });

  test("corruption NOT at the tail throws instead of silently skipping", () => {
    const path = join(dir(), "run.jsonl");
    writeFileSync(path, 'garbage\n{"type":"run-finished","outcome":"success","seq":2,"ts":"t"}\n');
    expect(() => readLog(path)).toThrow(/corrupt event line/);
  });

  test("SIGKILL mid-stream preserves every append that returned", async () => {
    const path = join(dir(), "run.jsonl");
    // child appends chunks forever; we kill it hard mid-turn — no finalize ever written
    const script = join(dir(), "writer.ts");
    writeFileSync(
      script,
      `import { EventLog } from "${join(import.meta.dir, "write.ts")}";
       const log = new EventLog(${JSON.stringify(path)});
       let i = 0;
       while (true) log.append({ type: "chunk", node: "impl", visit: 1, turn: 1, index: i++, kind: "text", content: "x" });`,
    );
    const child = Bun.spawn(["bun", script]);
    while (readLog(path).length < 50) await Bun.sleep(10); // let it stream
    child.kill(9);
    await child.exited;
    const events = readLog(path);
    expect(events.length).toBeGreaterThanOrEqual(50);
    // every surviving line is complete and ordered — no holes, no torn middles
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const turns = coalesce(events);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.finalized).toBe(false); // the death is visible in the record
  });
});

describe("EventLog locked append (system-map 0.5)", () => {
  const fixture = join(import.meta.dir, "fixtures", "appender.ts");
  const chunk = (index: number, content = "x") =>
    ({ type: "chunk", node: "n", visit: 1, turn: 1, index, kind: "text", content }) as const;

  async function runWriters(path: string, mode: "append" | "decide", count: number): Promise<void> {
    const startAt = Date.now() + 400; // both processes past bun startup before either writes
    const procs = [0, 1].map(() =>
      Bun.spawn(["bun", fixture, path, mode, String(count), String(startAt)], { stderr: "pipe" }),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    for (const [i, code] of codes.entries()) {
      if (code !== 0) throw new Error(`writer ${i} exited ${code}: ${await new Response(procs[i]!.stderr).text()}`);
    }
  }

  async function deadPid(): Promise<number> {
    const p = Bun.spawn(["true"]);
    await p.exited;
    return p.pid;
  }

  test("two OS processes appending concurrently stamp unique, strictly increasing seqs", async () => {
    const path = join(dir(), "run.jsonl");
    await runWriters(path, "append", 200);
    const events = readLog(path);
    expect(events).toHaveLength(400);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(existsSync(`${path}.lock`)).toBe(false);
  }, 30_000);

  test("two processes racing to break the same stale lock still stamp unique seqs", async () => {
    const path = join(dir(), "run.jsonl");
    writeFileSync(`${path}.lock`, String(await deadPid())); // both writers find it stale at once
    await runWriters(path, "append", 200);
    const events = readLog(path);
    expect(events).toHaveLength(400);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(existsSync(`${path}.lock.break`)).toBe(false);
  }, 30_000);

  test("release leaves a lock that another process now holds", () => {
    const path = join(dir(), "run.jsonl");
    const log = new EventLog(path, fixedClock());
    // someone else took the lock while we believed we held it: our release must not delete it
    log.appendIf(() => {
      writeFileSync(`${path}.lock`, "999999");
      return null;
    });
    expect(readFileSync(`${path}.lock`, "utf8")).toBe("999999");
  });

  test("concurrent appendIf across two processes lands exactly one decision", async () => {
    const path = join(dir(), "run.jsonl");
    await runWriters(path, "decide", 50);
    const events = readLog(path);
    expect(events.filter((e) => e.type === "operator-jump")).toHaveLength(1);
    expect(events).toHaveLength(101);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  }, 30_000);

  test("an instance built before another writer appended still stamps the next seq", () => {
    const path = join(dir(), "run.jsonl");
    const runner = new EventLog(path, fixedClock());
    runner.append({ type: "run-started", graph: "g", inputs: {}, pinned_prompts: {} });
    // the web/CLI pattern: a fresh instance appends a reply while the runner's is alive
    new EventLog(path).append({ type: "attention-resolved", node: "n", visit: 1, reply: "hi" });
    const e = runner.append({ type: "run-finished", outcome: "success" });
    expect(e.seq).toBe(3);
    expect(readLog(path).map((x) => x.seq)).toEqual([1, 2, 3]);
  });

  test("a stale lock left by a dead process is recovered and released", async () => {
    const path = join(dir(), "run.jsonl");
    const log = new EventLog(path, fixedClock());
    writeFileSync(`${path}.lock`, String(await deadPid()));
    expect(log.append(chunk(0)).seq).toBe(1);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("an empty lock older than the stale threshold is recovered", () => {
    const path = join(dir(), "run.jsonl");
    const log = new EventLog(path, fixedClock(), { lockTimeoutMs: 2000, staleLockMs: 100 });
    writeFileSync(`${path}.lock`, "");
    const old = new Date(Date.now() - 10_000);
    utimesSync(`${path}.lock`, old, old);
    expect(log.append(chunk(0)).seq).toBe(1);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("a fresh empty lock (holder mid-create) is waited on, not broken", () => {
    const path = join(dir(), "run.jsonl");
    const log = new EventLog(path, fixedClock(), { lockTimeoutMs: 150, staleLockMs: 60_000 });
    writeFileSync(`${path}.lock`, "");
    expect(() => log.append(chunk(0))).toThrow(/lock/);
    expect(existsSync(`${path}.lock`)).toBe(true); // not ours to remove
    expect(readLog(path)).toHaveLength(0);
  });

  test("a live foreign lock that never releases times out naming the path and holder", async () => {
    const path = join(dir(), "run.jsonl");
    const holder = Bun.spawn(["sleep", "30"]);
    try {
      // what a real holder writes: its identity, pid + start time (log/lockfile.ts)
      const identity = `${holder.pid} ${processStart(holder.pid)}`;
      writeFileSync(`${path}.lock`, identity);
      const log = new EventLog(path, fixedClock(), { lockTimeoutMs: 150 });
      const t0 = Date.now();
      let err: unknown;
      try {
        log.append(chunk(0));
      } catch (e) {
        err = e;
      }
      expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
      expect(String(err)).toContain(`${path}.lock`);
      expect(String(err)).toContain(String(holder.pid));
      expect(readFileSync(`${path}.lock`, "utf8")).toBe(identity); // left intact
      expect(readLog(path)).toHaveLength(0);
    } finally {
      holder.kill(9);
      await holder.exited;
    }
  });

  test("the lock is released when the append itself throws", () => {
    const path = join(dir(), "run.jsonl");
    const log = new EventLog(path, () => { throw new Error("clock broke"); });
    expect(() => log.append(chunk(0))).toThrow(/clock broke/);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("tail seq skips a torn final line and the torn bytes are cut before appending", () => {
    const path = join(dir(), "run.jsonl");
    const log = new EventLog(path, fixedClock());
    log.append(chunk(0));
    log.append(chunk(1));
    appendFileSync(path, '{"type":"chunk","node":"n","vi'); // torn write from a killed writer
    const e = new EventLog(path, fixedClock()).append(chunk(2));
    expect(e.seq).toBe(3);
    // the log stays readable: the next event did not fuse onto the torn bytes
    expect(readLog(path).map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });

  test("a complete final line missing only its newline is kept and terminated", () => {
    const path = join(dir(), "run.jsonl");
    const log = new EventLog(path, fixedClock());
    log.append(chunk(0));
    appendFileSync(path, JSON.stringify({ ...chunk(1), seq: 2, ts: "t" })); // killed before "\n"
    expect(log.append(chunk(2)).seq).toBe(3);
    expect(readLog(path).map((x) => x.seq)).toEqual([1, 2, 3]);
  });

  test("a final line that is valid JSON without a seq is refused, never truncated", () => {
    const path = join(dir(), "run.jsonl");
    const log = new EventLog(path, fixedClock());
    log.append(chunk(0));
    appendFileSync(path, '{"type":"chunk"}\n');
    const before = readFileSync(path, "utf8");
    expect(() => log.append(chunk(1))).toThrow(/no integer seq/);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("the tail scan validates only the tail, not the whole file", () => {
    const path = join(dir(), "run.jsonl");
    writeFileSync(path, 'garbage\n{"type":"run-finished","outcome":"success","seq":2,"ts":"t"}\nalso-torn');
    // the torn tail is fine and the line under it parses, so this appends; older corruption
    // is readLog's to report (it throws), not the append path's
    expect(new EventLog(path, fixedClock()).append(chunk(0)).seq).toBe(3);
  });

  test("corruption directly under a torn tail is refused, not appended past", () => {
    const path = join(dir(), "run.jsonl");
    writeFileSync(path, '{"type":"run-finished","outcome":"success","seq":1,"ts":"t"}\ngarbage\ntorn');
    expect(() => new EventLog(path, fixedClock()).append(chunk(0))).toThrow(/corrupt event line/);
  });

  test("tail read grows past its first window for an event larger than the window", () => {
    const path = join(dir(), "run.jsonl");
    const log = new EventLog(path, fixedClock());
    log.append(chunk(0));
    log.append(chunk(1, "y".repeat(300_000)));
    expect(new EventLog(path, fixedClock()).append(chunk(2)).seq).toBe(3);
  });

  test("appendIf appends when build returns an event and skips when it returns null", () => {
    const path = join(dir(), "run.jsonl");
    const log = new EventLog(path, fixedClock());
    log.append({ type: "run-started", graph: "g", inputs: {}, pinned_prompts: {} });
    const decide = (events: LoggedEvent[]) =>
      events.some((e) => e.type === "operator-jump") ? null : ({ type: "operator-jump", to: "x" } as const);
    const first = log.appendIf((events) => {
      expect(events.map((e) => e.seq)).toEqual([1]); // build sees the file, not a cache
      return decide(events);
    });
    expect(first?.seq).toBe(2);
    expect(first?.type).toBe("operator-jump");
    expect(log.appendIf(decide)).toBeNull();
    expect(readLog(path)).toHaveLength(2);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("appendIf releases the lock when build throws", () => {
    const path = join(dir(), "run.jsonl");
    const log = new EventLog(path, fixedClock());
    expect(() => log.appendIf(() => { throw new Error("bad predicate"); })).toThrow(/bad predicate/);
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(log.append(chunk(0)).seq).toBe(1);
  });

  test("appending from inside an appendIf build is refused, not deadlocked", () => {
    const path = join(dir(), "run.jsonl");
    const log = new EventLog(path, fixedClock(), { lockTimeoutMs: 5000 });
    const t0 = Date.now();
    expect(() =>
      log.appendIf(() => {
        log.append(chunk(0));
        return null;
      }),
    ).toThrow(/re-entrant/);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
});

describe("coalesce", () => {
  function turnEvents(): LoggedEvent[] {
    const log = new EventLog(join(dir(), "run.jsonl"), fixedClock());
    log.append({ type: "chunk", node: "impl", visit: 1, turn: 1, index: 0, kind: "text", content: "I will " });
    log.append({ type: "chunk", node: "impl", visit: 1, turn: 1, index: 1, kind: "text", content: "edit the file." });
    log.append({ type: "chunk", node: "impl", visit: 1, turn: 1, index: 2, kind: "tool_call", content: "Edit(core/x.ts)", tool_id: "t1", tool_name: "Edit" });
    log.append({ type: "chunk", node: "impl", visit: 1, turn: 1, index: 3, kind: "tool_result", content: "ok", tool_id: "t1" });
    log.append({ type: "chunk", node: "impl", visit: 1, turn: 1, index: 4, kind: "text", content: "Done." });
    log.append({ type: "turn-finalized", node: "impl", visit: 1, turn: 1, usage: { output_tokens: 42 } });
    return log.read();
  }

  test("chunked writes coalesce to one Orbital-style message, tool ordering kept", () => {
    const [t] = coalesce(turnEvents());
    expect(t!.finalized).toBe(true);
    expect(t!.usage?.output_tokens).toBe(42);
    expect(t!.parts.map((p) => p.kind)).toEqual(["text", "tool_call", "tool_result", "text"]);
    expect(t!.parts[0]!.content).toBe("I will edit the file."); // deltas merged
  });

  test("coalesced view is identical regardless of chunk granularity", () => {
    // same content written as one chunk vs five must render identically
    const log = new EventLog(join(dir(), "run.jsonl"), fixedClock());
    log.append({ type: "chunk", node: "impl", visit: 1, turn: 1, index: 0, kind: "text", content: "I will edit the file." });
    log.append({ type: "chunk", node: "impl", visit: 1, turn: 1, index: 1, kind: "tool_call", content: "Edit(core/x.ts)", tool_id: "t1", tool_name: "Edit" });
    log.append({ type: "chunk", node: "impl", visit: 1, turn: 1, index: 2, kind: "tool_result", content: "ok", tool_id: "t1" });
    log.append({ type: "chunk", node: "impl", visit: 1, turn: 1, index: 3, kind: "text", content: "Done." });
    log.append({ type: "turn-finalized", node: "impl", visit: 1, turn: 1, usage: { output_tokens: 42 } });
    expect(coalesce(log.read())).toEqual(coalesce(turnEvents()));
  });

  test("out-of-order arrival coalesces by index, not log position", () => {
    const log = new EventLog(join(dir(), "run.jsonl"), fixedClock());
    log.append({ type: "chunk", node: "n", visit: 1, turn: 1, index: 1, kind: "text", content: "world" });
    log.append({ type: "chunk", node: "n", visit: 1, turn: 1, index: 0, kind: "text", content: "hello " });
    const [t] = coalesce(log.read());
    expect(t!.parts[0]!.content).toBe("hello world");
  });

  test("turns are separated by node/visit/turn", () => {
    const log = new EventLog(join(dir(), "run.jsonl"), fixedClock());
    log.append({ type: "chunk", node: "n", visit: 1, turn: 1, index: 0, kind: "text", content: "a" });
    log.append({ type: "chunk", node: "n", visit: 2, turn: 1, index: 0, kind: "text", content: "b" });
    log.append({ type: "chunk", node: "n", visit: 2, turn: 2, index: 0, kind: "text", content: "c" });
    expect(coalesce(log.read())).toHaveLength(3);
  });
});

describe("prompt-outcome attribution", () => {
  test("outcomes join on rendered_hash; late follow-up writes layer fields", () => {
    const log = new EventLog(join(dir(), "run.jsonl"), fixedClock());
    log.append({
      type: "prompt-rendered", node: "delivery.publish", visit: 1, prompt: "delivery.publish",
      prompt_version: 2, rendered_hash: "h1", context_read: { goal: "g", work: "w" },
    });
    // at routing time: the reviewer's verdict
    log.append({ type: "prompt-outcome", rendered_hash: "h1", node: "delivery.publish", visit: 1, verdict_downstream: "pass" });
    // days later: the PR merged — a follow-up write, not an edit
    log.append({ type: "prompt-outcome", rendered_hash: "h1", node: "delivery.publish", visit: 1, terminal_outcome: "success" });
    const joined = outcomesByHash(log.read()).get("h1")!;
    expect(joined.verdict_downstream).toBe("pass");
    expect(joined.terminal_outcome).toBe("success");
  });
});

describe("lock holder identity (system-map 1a review: PID reuse)", () => {
  const chunkAt = (i: number) => ({ type: "chunk" as const, node: "n", visit: 1, turn: 1, index: i, kind: "text" as const, content: "x" });
  const fresh = () => join(mkdtempSync(join(tmpdir(), "howdah-ident-")), "run.jsonl");

  test("a lock records pid + start time", () => {
    const path = fresh();
    new EventLog(path).appendIf(() => {
      expect(readFileSync(`${path}.lock`, "utf8")).toBe(`${process.pid} ${processStart(process.pid)}`);
      return null;
    });
  });

  test("a lock whose PID now belongs to a DIFFERENT process (start time differs) is broken", async () => {
    const path = fresh();
    const other = Bun.spawn(["sleep", "30"]);
    try {
      writeFileSync(`${path}.lock`, `${other.pid} Thu Jan  1 00:00:00 1970`); // the PID was reused
      expect(new EventLog(path, undefined, { lockTimeoutMs: 1000 }).append(chunkAt(0)).seq).toBe(1);
    } finally {
      other.kill(9);
      await other.exited;
    }
  });

  test("a legacy PID-only lock naming a live NON-bun process is broken; one naming a bun process is waited on", async () => {
    const path = fresh();
    const other = Bun.spawn(["sleep", "30"]);
    const bun = Bun.spawn(["bun", "-e", "await Bun.sleep(30000)"]);
    try {
      writeFileSync(`${path}.lock`, String(other.pid));
      expect(new EventLog(path, undefined, { lockTimeoutMs: 1000 }).append(chunkAt(0)).seq).toBe(1);
      await Bun.sleep(100); // bun is up
      writeFileSync(`${path}.lock`, String(bun.pid));
      expect(() => new EventLog(path, undefined, { lockTimeoutMs: 150 }).append(chunkAt(1))).toThrow(/timed out/);
    } finally {
      other.kill(9);
      bun.kill(9);
      await Promise.all([other.exited, bun.exited]);
    }
  });
});

describe("EventLog.appendAllIf (system-map 1a)", () => {
  const fresh = () => join(mkdtempSync(join(tmpdir(), "howdah-all-")), "run.jsonl");
  const jump = (to: string) => ({ type: "operator-jump" as const, to });

  test("all of them, consecutively stamped with one timestamp, in one write", () => {
    const path = fresh();
    const log = new EventLog(path);
    log.append({ type: "run-started", graph: "g", inputs: {}, pinned_prompts: {} });
    const out = log.appendAllIf((events) => (events.length === 1 ? [jump("a"), jump("b"), jump("c")] : []));
    expect(out.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(new Set(out.map((e) => e.ts)).size).toBe(1);
    expect(readLog(path).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("or none: a declining build writes nothing and releases the lock", () => {
    const path = fresh();
    const log = new EventLog(path);
    log.append({ type: "run-started", graph: "g", inputs: {}, pinned_prompts: {} });
    const before = readFileSync(path, "utf8");
    expect(log.appendAllIf(() => [])).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("a torn tail is repaired first: the batch continues from the last complete seq", () => {
    const path = fresh();
    writeFileSync(path, '{"type":"run-finished","outcome":"success","seq":1,"ts":"t"}\n{"type":"chunk","seq":2,"ts');
    const out = new EventLog(path).appendAllIf(() => [jump("a"), jump("b")]);
    expect(out.map((e) => e.seq)).toEqual([2, 3]);
    expect(readLog(path).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  test("a build that writes to the log itself is refused (re-entrant), nothing lands", () => {
    const path = fresh();
    const log = new EventLog(path);
    expect(() => log.appendAllIf(() => [log.append(jump("x")) as never])).toThrow(/re-entrant/);
    expect(readLog(path)).toHaveLength(0);
  });
});
