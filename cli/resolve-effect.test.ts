/**
 * `howdah resolve-effect` (HOW-3): the CLI half of the shared attestation rules. An
 * `ambiguous-effect` park used to have no exit but hand-editing run.jsonl; this verb is the
 * human answer. A refusal exits non-zero and appends nothing; resolutions racing from
 * separate PROCESSES land exactly one `side-effect-resolved`, because resolveEffect decides
 * and appends inside one EventLog.appendIf critical section.
 *
 * An ACCEPTED resolution spawns a detached resume (the resolution must move the run), so
 * these assert on the presence or absence of `side-effect-resolved` rather than on the
 * bytes of the log — the resume legitimately appends after us, and never that type.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, readLog } from "../log/write";
import { processStart } from "../log/lockfile";

const MAIN = join(import.meta.dir, "main.ts");

/** a HOWDAH_HOME with one run parked on `ambiguous-effect`, its intent never proven done */
function ambiguousRun(opts: { liveRunner?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "howdah-effect-cli-"));
  const runDir = join(home, "runs", "r1");
  const log = new EventLog(join(runDir, "run.jsonl"));
  log.append({ type: "run-started", graph: "write-doc", inputs: { goal: "g", work: "w" }, pinned_prompts: {} });
  log.append({ type: "node-started", node: "doc.review", visit: 1, attempt_id: "doc.review#1" });
  log.append({ type: "side-effect-intent", node: "doc.review", visit: 1, attempt_id: "doc.review#1", effect: "create-pr" });
  log.append({ type: "attention-raised", node: "doc.review", visit: 1, reason: 'ambiguous side effect "create-pr"', code: "ambiguous-effect" });
  if (opts.liveRunner) writeFileSync(join(runDir, "runner.pid"), `${opts.liveRunner} ${processStart(opts.liveRunner)}`);
  const path = join(runDir, "run.jsonl");
  const before = readFileSync(path, "utf8");
  return {
    home,
    path,
    unchanged: () => readFileSync(path, "utf8") === before,
    resolutions: () => readLog(path).filter((e) => e.type === "side-effect-resolved"),
  };
}

function resolve(home: string, args: string[]) {
  return Bun.spawn(["bun", MAIN, "resolve-effect", "r1", ...args], {
    env: { ...process.env, HOWDAH_HOME: home, HOWDAH_STUB: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function outcome(proc: ReturnType<typeof resolve>) {
  await proc.exited;
  return { code: proc.exitCode, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

describe("howdah resolve-effect (CLI, HOW-3)", () => {
  for (const verdict of ["happened", "not-happened"] as const) {
    test(`"${verdict}" is recorded once, as an operator attestation`, async () => {
      const run = ambiguousRun();
      const r = await outcome(resolve(run.home, ["create-pr", verdict]));
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`recorded: "create-pr" ${verdict}`);
      expect(run.resolutions()).toEqual([
        expect.objectContaining({ node: "doc.review", visit: 1, attempt_id: "doc.review#1", effect: "create-pr", verdict, by: "operator" }),
      ]);
    }, 15000);
  }

  test("an effect nobody claimed: refused non-zero with the code, nothing appended", async () => {
    const run = ambiguousRun();
    const r = await outcome(resolve(run.home, ["push-tag", "happened"]));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("[no-ambiguous-effect]");
    expect(r.stderr).toContain('ambiguous now: "create-pr" on "doc.review"');
    expect(run.unchanged()).toBe(true);
  }, 15000);

  test("a live runner: refused, told to pause or abort first, nothing appended", async () => {
    const holder = Bun.spawn(["sleep", "30"]);
    try {
      const run = ambiguousRun({ liveRunner: holder.pid });
      const r = await outcome(resolve(run.home, ["create-pr", "happened"]));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("[runner-live]");
      expect(run.resolutions()).toEqual([]);
    } finally {
      holder.kill(9);
    }
  }, 15000);

  test("an unknown verdict word is a usage error before the log is touched", async () => {
    const run = ambiguousRun();
    const r = await outcome(resolve(run.home, ["create-pr", "probably"]));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("usage: howdah resolve-effect <run-id> <effect> happened|not-happened");
    expect(run.unchanged()).toBe(true);
  }, 15000);

  test("--node picks between two nodes claiming the same effect", async () => {
    const run = ambiguousRun();
    new EventLog(run.path).append({ type: "side-effect-intent", node: "doc.outline", visit: 1, attempt_id: "doc.outline#1", effect: "create-pr" });
    const ambiguousName = await outcome(resolve(run.home, ["create-pr", "happened"]));
    expect(ambiguousName.code).toBe(1);
    expect(ambiguousName.stderr).toContain("--node <node>");
    expect(readLog(run.path).filter((e) => e.type === "side-effect-resolved")).toEqual([]);

    const picked = await outcome(resolve(run.home, ["create-pr", "happened", "--node", "doc.outline"]));
    expect(picked.code).toBe(0);
    expect(run.resolutions()).toEqual([expect.objectContaining({ node: "doc.outline", verdict: "happened" })]);
  }, 20000);

  test("resolutions racing from four processes land exactly one side-effect-resolved", async () => {
    const run = ambiguousRun();
    const verdicts = ["happened", "not-happened", "happened", "not-happened"];
    const results = await Promise.all(verdicts.map((v) => outcome(resolve(run.home, ["create-pr", v]))));
    expect(run.resolutions()).toHaveLength(1);
    const winner = run.resolutions()[0] as { verdict: string };
    // the twin of whichever verdict landed is idempotent (exit 0); the opposite pair is refused
    expect(results.filter((r) => r.code === 0)).toHaveLength(2);
    for (const l of results.filter((r) => r.code !== 0)) expect(l.stderr).toContain(`already resolved as ${winner.verdict}`);
  }, 25000);
});
