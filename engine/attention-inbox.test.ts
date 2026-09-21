/**
 * HOW-20: the one answer to "does this pending record still need a human?", and the inbox
 * read model over it. Every case here is a way the old code kept ringing for nobody.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  /**
   * The flood the ticket actually shows: park, resume, park again. Resuming appends
   * attention-resolved but deletes no disk record, so the run owns a record per park, and
   * "is the run parked?" — the question this used to ask — keeps every one of them.
   */
  test("an ask superseded by a later park is answered; only the standing one survives", () => {
    const runs = home();
    const log = parked(runs, "r1");
    log.append({ type: "attention-resolved", node: "implement", visit: 1, reply: "resume", source: "resume" });
    log.append({ type: "node-started", node: "implement", visit: 2, attempt_id: "implement#2" });
    log.append({ type: "attention-raised", node: "implement", visit: 2, reason: "attempt failed again" });

    expect(stillNeedsHuman(runs, { run: "r1", node: "implement", visit: 1 })).toBe(false);
    expect(stillNeedsHuman(runs, { run: "r1", node: "implement", visit: 2 })).toBe(true);
  });

  test("a park on ANOTHER node is not this record's ask", () => {
    const runs = home();
    const log = parked(runs, "r1");
    log.append({ type: "attention-resolved", node: "implement", visit: 1, reply: "go on", source: "operator" });
    log.append({ type: "node-started", node: "review", visit: 1, attempt_id: "review#1" });
    log.append({ type: "attention-raised", node: "review", visit: 1, reason: "needs your reply" });
    expect(stillNeedsHuman(runs, { run: "r1", node: "implement", visit: 1 })).toBe(false);
    expect(stillNeedsHuman(runs, { run: "r1", node: "review", visit: 1 })).toBe(true);
  });

  test("a run mid-flight with no standing park keeps nobody waiting", () => {
    const runs = home();
    const log = parked(runs, "r1");
    log.append({ type: "attention-resolved", node: "implement", visit: 1, reply: "go on", source: "operator" });
    expect(stillNeedsHuman(runs, { run: "r1", node: "implement", visit: 1 })).toBe(false);
  });

  /**
   * The runner-lock record has no log event of its own, so the LOCK is what judges it: kept
   * while a non-runner still holds it (`howdah up` re-raises it every tick, and its once-guard
   * only holds while the record is there — dropping it would ring on every tick instead),
   * dropped as soon as the lock is gone.
   */
  test("a runner-lock record lives and dies by the lock, not by the log", async () => {
    const runs = home();
    parked(runs, "wedged");
    const runDir = join(runs, "wedged");
    const record = { run: "wedged", node: "runner-lock", visit: 0 };
    const bystander = Bun.spawn(["bun", "-e", "setInterval(()=>{},1e9)"]);
    try {
      await Bun.sleep(200);
      writeFileSync(join(runDir, "runner.pid"), String(bystander.pid));
      expect(stillNeedsHuman(runs, record)).toBe(true); // still wedged: `resume --force` is the fix
      rmSync(join(runDir, "runner.pid"));
      expect(stillNeedsHuman(runs, record)).toBe(false); // lock gone: nothing left to force
    } finally {
      bystander.kill(9);
      await bystander.exited;
    }
  }, 30000);
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
      href: "/run/run-old#needs-input",
    });
  });

  test("the harness row links at the inbox, because there is no /run/howdah to link at", async () => {
    const base = home();
    const runsDir = join(base, "runs");
    const attentionDir = join(base, "attention");
    const center = new AttentionCenter(attentionDir, []);
    await center.raise({ run: "howdah", node: "__harness__", visit: 1, reason: "harness is dead — run `howdah up`" });

    const [item] = inboxItems({ runsDir, attentionDir });
    expect(item!.href).toBeNull(); // the row is text, not a link to a run that does not exist
    expect(item!.deep_link).toBe("http://localhost:4711/attention");
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
