/**
 * `howdah reply` (system-map 0.2): the CLI half of the shared reply rules. A refusal exits
 * non-zero naming the verb that can move the run and appends nothing; replies racing from
 * separate processes land exactly one resolution, because resolveReply decides and appends
 * inside one EventLog.appendIf critical section.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, readLog } from "../log/write";

const MAIN = join(import.meta.dir, "main.ts");

/** a HOWDAH_HOME with one run of a registered graph, parked by hand on `node` with `code` */
function parkedRun(graph: string, node: string, code: string | undefined, opts: { liveRunner?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "howdah-reply-cli-"));
  const runDir = join(home, "runs", "r1");
  const log = new EventLog(join(runDir, "run.jsonl"));
  log.append({ type: "run-started", graph, inputs: { goal: "g", work: "w" }, pinned_prompts: {} });
  log.append({ type: "node-started", node, visit: 1, attempt_id: `${node}#1` });
  log.append({ type: "node-finished", node, visit: 1, status: "failed", writes: {} });
  log.append({ type: "attention-raised", node, visit: 1, reason: "r", ...(code ? { code } : {}) } as never);
  // a live runner.pid (this test process) means an accepted reply kicks no resume
  if (opts.liveRunner) writeFileSync(join(runDir, "runner.pid"), String(process.pid));
  const path = join(runDir, "run.jsonl");
  const before = readFileSync(path, "utf8");
  return { home, path, unchanged: () => readFileSync(path, "utf8") === before };
}

function reply(home: string, text: string) {
  return Bun.spawn(["bun", MAIN, "reply", "r1", ...text.split(" ")], {
    env: { ...process.env, HOWDAH_HOME: home, HOWDAH_STUB: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function outcome(proc: ReturnType<typeof reply>) {
  await proc.exited;
  return { code: proc.exitCode, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

describe("howdah reply (CLI, system-map 0.2)", () => {
  test("an agent failure: accepted, logged as an operator reply that the retry will carry", async () => {
    const run = parkedRun("write-doc", "doc.review", "attempt-failed", { liveRunner: true });
    const r = await outcome(reply(run.home, "cover the edge cases"));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("the retry will carry your reply");
    const resolved = readLog(run.path).filter((e) => e.type === "attention-resolved");
    expect(resolved).toEqual([expect.objectContaining({ node: "doc.review", visit: 1, reply: "cover the edge cases", source: "operator" })]);
  }, 15000);

  test("a command node failure: refused non-zero, told to fix the cause and resume, nothing appended", async () => {
    const run = parkedRun("implement-ticket", "delivery.probe_pr", "attempt-failed");
    const r = await outcome(reply(run.home, "try again"));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("reply refused (attempt-failed)");
    expect(r.stderr).toContain('"delivery.probe_pr" is a command node');
    expect(r.stderr).toContain("fix the cause, then `resume r1`");
    expect(run.unchanged()).toBe(true);
  }, 15000);

  test("a worktree node failure is refused the same way", async () => {
    const run = parkedRun("implement-ticket", "create_worktree", "executor-threw");
    const r = await outcome(reply(run.home, "try again"));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("worktree node");
    expect(run.unchanged()).toBe(true);
  }, 15000);

  test("a max-visits park: refused naming jump, nothing appended", async () => {
    const run = parkedRun("write-doc", "doc.revise", "max-visits");
    const r = await outcome(reply(run.home, "be lenient"));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("use `jump r1 <node> <msg>`");
    expect(run.unchanged()).toBe(true);
  }, 15000);

  test("LEGACY: an ask without a code is accepted as before", async () => {
    const run = parkedRun("write-doc", "doc.review", undefined, { liveRunner: true });
    const r = await outcome(reply(run.home, "ok"));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("replied");
  }, 15000);

  test("replies racing from four processes land exactly one resolution", async () => {
    const run = parkedRun("write-doc", "doc.review", "attempt-failed", { liveRunner: true });
    const results = await Promise.all(["one", "two", "three", "four"].map((t) => outcome(reply(run.home, t))));
    expect(results.filter((r) => r.code === 0)).toHaveLength(1);
    const losers = results.filter((r) => r.code !== 0);
    expect(losers).toHaveLength(3);
    for (const l of losers) expect(l.stderr).toContain("nothing awaiting a reply");
    expect(readLog(run.path).filter((e) => e.type === "attention-resolved")).toHaveLength(1);
  }, 20000);

  test("an accepted reply on a dead runner kicks a resume that re-attempts the node", async () => {
    const home = mkdtempSync(join(tmpdir(), "howdah-reply-cli-"));
    const { Engine } = await import("../engine/run");
    const { writeDoc } = await import("../graphs/write-doc");
    const engine = new Engine(writeDoc, {
      dir: join(home, "runs", "r1"),
      executors: {
        agent: async ({ nodeId }) => {
          if (nodeId === "doc.review") return { status: "failed", writes: {} };
          return { status: "succeeded", writes: nodeId === "doc.outline" ? { doc_outline: "o" } : { doc_summary: "s" } };
        },
      },
    });
    expect(await engine.start({ goal: "g", work: "w" })).toMatchObject({ state: "parked", code: "attempt-failed" });
    const r = await outcome(reply(home, "look at section 2"));
    expect(r.code).toBe(0);
    let retried: any;
    for (let i = 0; i < 60 && !retried; i++) {
      await Bun.sleep(100);
      retried = readLog(join(home, "runs", "r1", "run.jsonl")).find(
        (e) => e.type === "prompt-rendered" && e.node === "doc.review" && e.visit === 2,
      );
    }
    expect(retried).toBeDefined(); // the reply MOVED the run, and the retry rendered under v2
    expect(retried.suffix_version).toBe(2);
  }, 15000);
});
