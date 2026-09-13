import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, readLog } from "./write";
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
