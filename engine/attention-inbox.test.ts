/**
 * HOW-20: the one answer to "does this pending record still need a human?", and the inbox
 * read model over it. Every case here is a way the old code kept ringing for nobody.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../log/write";
import { AttentionCenter } from "./attention";
import { inboxItems, stillNeedsHuman } from "./attention-inbox";

const home = () => mkdtempSync(join(tmpdir(), "howdah-inbox-"));

function parked(runsDir: string, id: string, node = "implement"): EventLog {
  const log = new EventLog(join(runsDir, id, "run.jsonl"));
  log.append({ type: "run-started", graph: "implement-ticket", inputs: { goal: "g" }, pinned_prompts: {} });
  log.append({ type: "node-started", node, visit: 1, attempt_id: `${node}#1` });
  log.append({ type: "attention-raised", node, visit: 1, reason: "attempt failed" });
  return log;
}

describe("stillNeedsHuman", () => {
  test("a run standing on an unresolved ask needs a human", () => {
    const runs = home();
    parked(runs, "r1");
    expect(stillNeedsHuman(runs, { run: "r1", node: "implement", visit: 1 })).toBe(true);
  });

  test("finished, aborted, answered and deleted runs do not", () => {
    const runs = home();
    const done = parked(runs, "done");
    done.append({ type: "run-finished", outcome: "success" });
    const aborted = parked(runs, "aborted");
    aborted.append({ type: "run-finished", outcome: "aborted" });
    const answered = parked(runs, "answered");
    answered.append({ type: "attention-resolved", node: "implement", visit: 1, reply: "go on" });

    const ask = { node: "implement", visit: 1 };
    expect(stillNeedsHuman(runs, { run: "done", ...ask })).toBe(false);
    expect(stillNeedsHuman(runs, { run: "aborted", ...ask })).toBe(false);
    expect(stillNeedsHuman(runs, { run: "answered", ...ask })).toBe(false);
    expect(stillNeedsHuman(runs, { run: "never-existed", ...ask })).toBe(false);
  });

  test("a log that cannot be read keeps its ask — a read error must never drop one", () => {
    const runs = home();
    mkdirSync(join(runs, "torn"), { recursive: true });
    writeFileSync(join(runs, "torn", "run.jsonl"), "{not json}\n{still not}\n");
    expect(stillNeedsHuman(runs, { run: "torn", node: "implement", visit: 1 })).toBe(true);

    mkdirSync(join(runs, "empty"), { recursive: true });
    writeFileSync(join(runs, "empty", "run.jsonl"), "");
    expect(stillNeedsHuman(runs, { run: "empty", node: "implement", visit: 1 })).toBe(true);
  });

  test("the harness record has no run to replay, so it is never judged here", () => {
    expect(stillNeedsHuman(home(), { run: "howdah", node: "__harness__", visit: 1 })).toBe(true);
  });
});

describe("inboxItems", () => {
  test("joins run, graph, node, reason, wait and deep link — oldest wait first", async () => {
    const base = home();
    const runsDir = join(base, "runs");
    const attentionDir = join(base, "attention");
    parked(runsDir, "run-old");
    parked(runsDir, "run-new", "review");
    const center = new AttentionCenter(attentionDir, []);
    await center.raise({ run: "run-old", node: "implement", visit: 1, reason: "attempt failed" });
    // deliberately raised later, so the sort has something to do
    const later = new AttentionCenter(attentionDir, [], { clock: () => new Date(Date.now() + 60_000) });
    await later.raise({ run: "run-new", node: "review", visit: 1, reason: "needs your reply" });

    const items = inboxItems({ runsDir, attentionDir, clock: () => new Date(Date.parse(center.pending()[0]!.raised_at) + 2 * 60 * 60_000 + 11 * 60_000) });
    expect(items.map((i) => i.run)).toEqual(["run-old", "run-new"]); // newest wait last
    expect(items[0]).toMatchObject({
      id: "run-old:implement:1",
      run: "run-old",
      graph: "implement-ticket",
      node: "implement",
      visit: 1,
      reason: "attempt failed",
      waited: "waiting 2h 11m",
      deep_link: "http://localhost:4711/run/run-old#needs-input",
    });
  });

  test("drops what no longer needs a human, and does NOT delete it — reading is not resolving", async () => {
    const base = home();
    const runsDir = join(base, "runs");
    const attentionDir = join(base, "attention");
    const done = parked(runsDir, "run-done");
    done.append({ type: "run-finished", outcome: "success" });
    const center = new AttentionCenter(attentionDir, []);
    await center.raise({ run: "run-done", node: "implement", visit: 1, reason: "attempt failed" });

    expect(inboxItems({ runsDir, attentionDir })).toEqual([]);
    expect(center.pending()).toHaveLength(1); // the watchdog clears it; the screen only reads
  });
});
