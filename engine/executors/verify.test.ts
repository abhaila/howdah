/**
 * `verify:run` (HOW-12) against real bash in a real git worktree record: the code is RUN, a
 * failing suite is a verdict rather than a failed attempt, and an unconfigured workspace is
 * `not-checked` — never a pass.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { verifyBuiltinExecutor, finalJsonLine } from "./verify";
import { commandExecutor } from "./worktree";
import { runShell } from "./shell";
import { worktreeRecordPath } from "./worktree-record";
import { EventLog, readLog } from "../../log/write";
import { VERIFY_OUTPUT_TAIL_CHARS, tail, type VerifyResult } from "../../core/verify";
import type { ExecArgs } from "../run";

function repo(): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), "howdah-verify-repo-"));
  const git = (c: string) => execSync(`git ${c}`, { cwd: dir, stdio: "pipe" }).toString().trim();
  git("init -q -b main");
  git("config user.email t@t && git config user.name t");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git("add . && git commit -q -m init");
  return { dir, head: git("rev-parse HEAD") };
}

/** a run dir whose worktree.json points at `worktree`, recorded as made from `repoPath` */
function runWith(worktree: string | null, repoPath = "/repos/api"): EventLog {
  const runDir = mkdtempSync(join(tmpdir(), "howdah-verify-run-"));
  if (worktree) writeFileSync(worktreeRecordPath(runDir), JSON.stringify({ path: worktree, branch: "howdah/r", repo: repoPath }));
  return new EventLog(join(runDir, "run.jsonl"));
}

function args(log: EventLog, def: Partial<Extract<ExecArgs["def"], { kind: "command" }>> = {}, cwd?: string): ExecArgs {
  return {
    nodeId: "verify.run", visit: 1, attemptId: "verify.run#1", runId: "r", reads: {}, log,
    ...(cwd ? { cwd } : {}),
    def: { kind: "command", run: "verify:run", writes: { "verify.result": { scope: "per-visit" } }, ...def },
    effects: { claim: () => false, done: () => {} },
  } as ExecArgs;
}

const result = (r: { writes: Record<string, unknown> }) => r.writes["verify.result"] as VerifyResult;
const commandFor = (cmd: string | undefined) => (p: string) => (p === "/repos/api" ? cmd : undefined);

describe("verify:run — the code is actually run", () => {
  test("exit 0 is a pass, tied to the worktree's HEAD", async () => {
    const { dir, head } = repo();
    const r = await verifyBuiltinExecutor({ commandFor: commandFor("true") })(args(runWith(dir)));
    expect(r.status).toBe("succeeded");
    expect(result(r)).toMatchObject({ outcome: "pass", command: "true", exit_code: 0, timed_out: false, commit: head, dirty: false });
    expect(result(r).reason).toBeUndefined();
    expect(typeof result(r).duration_ms).toBe("number");
  });

  test("runs IN the worktree, not the repo it was made from", async () => {
    const { dir } = repo();
    const r = await verifyBuiltinExecutor({ commandFor: commandFor("pwd -P; test -f README.md") })(args(runWith(dir)));
    expect(result(r).outcome).toBe("pass");
    expect(result(r).output_tail.trim()).toBe(execSync("pwd -P", { cwd: dir }).toString().trim());
  });

  test("a failing suite FAILS the verdict but SUCCEEDS the attempt — it is evidence for the reviewer", async () => {
    const { dir } = repo();
    const r = await verifyBuiltinExecutor({ commandFor: commandFor("echo boom; echo 'oops' >&2; exit 3") })(args(runWith(dir)));
    expect(r.status).toBe("succeeded");
    expect(result(r)).toMatchObject({ outcome: "fail", exit_code: 3, timed_out: false, reason: "exited 3" });
    expect(result(r).output_tail).toBe("boom\noops\n");
  });

  test("a timeout is a fail with timed_out, and kills the whole process group", async () => {
    const { dir } = repo();
    const started = Date.now();
    // the `sleep` is a CHILD of bash: killing only bash left it holding stdout open
    const r = await verifyBuiltinExecutor({ commandFor: commandFor("echo started; sleep 5; echo never") })(args(runWith(dir), { timeoutMs: 100 }));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.status).toBe("succeeded");
    expect(result(r)).toMatchObject({ outcome: "fail", timed_out: true, reason: "timed out after 100ms and was killed" });
    expect(result(r).output_tail).toBe("started\n");
  });

  test("a final JSON-object line rides along as facts; anything else is just output", async () => {
    const { dir } = repo();
    const r = await verifyBuiltinExecutor({ commandFor: commandFor(`echo running; echo '{"tests":12,"failed":0}'`) })(args(runWith(dir)));
    expect(result(r).facts).toEqual({ tests: 12, failed: 0 });
    expect(finalJsonLine("ok\n[1,2]\n")).toBeUndefined();
    expect(finalJsonLine("ok\n{not json\n")).toBeUndefined();
    expect(finalJsonLine("12\n")).toBeUndefined();
    expect(finalJsonLine('x\n  {"a":1}  \n\n')).toEqual({ a: 1 });
  });

  test("uncommitted changes are reported as dirty — the verdict covers more than the commit", async () => {
    const { dir } = repo();
    writeFileSync(join(dir, "new.ts"), "x\n");
    const r = await verifyBuiltinExecutor({ commandFor: commandFor("true") })(args(runWith(dir)));
    expect(result(r).dirty).toBe(true);
  });

  test("output beyond the cap keeps only the tail in context; the log keeps all of it", async () => {
    const { dir } = repo();
    const log = runWith(dir);
    // ~30KB of numbered lines, then a recognisable last one
    const r = await verifyBuiltinExecutor({ commandFor: commandFor("for i in $(seq 1 3000); do echo line-$i; done; echo LAST") })(args(log));
    const t = result(r).output_tail;
    expect(t.endsWith("LAST\n")).toBe(true);
    expect(t).toContain("earlier characters are in the run log");
    expect(t).not.toContain("line-1\n");
    expect(t.length).toBeLessThan(VERIFY_OUTPUT_TAIL_CHARS + 100);
    const streamed = readLog(log.path).flatMap((e) => (e.type === "chunk" && e.kind === "text" ? [e.content] : [])).join("");
    expect(streamed).toContain("line-1\n");
    expect(streamed).toContain("LAST\n");
  });

  test("stdout streams into the log as chunks, bracketed by the command and the verdict", async () => {
    const { dir } = repo();
    const log = runWith(dir);
    await verifyBuiltinExecutor({ commandFor: commandFor("echo hello") })(args(log));
    const chunks = readLog(log.path).flatMap((e) => (e.type === "chunk" ? [[e.kind, e.content, e.node, e.index] as const] : []));
    expect(chunks[0]).toEqual(["tool_call", "echo hello", "verify.run", 0]);
    expect(chunks.some(([k, c]) => k === "text" && c === "hello\n")).toBe(true);
    expect(chunks.at(-1)![0]).toBe("tool_result");
    expect(chunks.at(-1)![1]).toStartWith("pass");
    expect(chunks.map((c) => c[3])).toEqual(chunks.map((_, i) => i));
  });
});

describe("verify:run — never a silent pass", () => {
  test("no configured command is not-checked, with a reason that says how to configure one", async () => {
    const { dir } = repo();
    for (const configured of [undefined, "", "   "]) {
      let ran = false;
      const r = await verifyBuiltinExecutor({ commandFor: commandFor(configured), run: async () => { ran = true; throw new Error("must not run"); } })(args(runWith(dir)));
      expect(ran).toBe(false);
      expect(r.status).toBe("succeeded");
      expect(result(r).outcome).toBe("not-checked");
      expect(result(r).reason).toContain("no verify command is configured for the workspace at /repos/api");
      expect(result(r).reason).toContain("verifyCommand");
      expect(result(r).reason).toContain("--verify");
    }
  });

  test("an executor built with no lookup at all is not-checked too", async () => {
    const { dir } = repo();
    const r = await verifyBuiltinExecutor()(args(runWith(dir)));
    expect(result(r).outcome).toBe("not-checked");
  });

  test("no worktree record and no cwd is not-checked", async () => {
    const r = await verifyBuiltinExecutor({ commandFor: () => "true" })(args(runWith(null)));
    expect(result(r)).toMatchObject({ outcome: "not-checked", output_tail: "" });
    expect(result(r).reason).toContain("no repo or worktree");
  });

  test("no worktree record falls back to the run's cwd as both repo and working dir", async () => {
    const { dir, head } = repo();
    const seen: string[] = [];
    const r = await verifyBuiltinExecutor({ commandFor: (p) => (seen.push(p), "true") })(args(runWith(null), {}, dir));
    expect(seen).toEqual([dir]);
    expect(result(r)).toMatchObject({ outcome: "pass", commit: head });
  });
});

describe("verify:run — refused before anything is spawned", () => {
  const neverRun = async () => { throw new Error("must not run"); };

  test("a node declaring a write the built-in cannot publish", async () => {
    const { dir } = repo();
    const r = await verifyBuiltinExecutor({ commandFor: () => "true", run: neverRun })(
      args(runWith(dir), { writes: { "verify.result": { scope: "per-visit" }, summary: { scope: "sticky" } } }),
    );
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("verify:run cannot produce summary");
    expect(r.reason).toContain("Nothing was run");
  });

  test("arguments — the command comes from the workspace, not the graph", async () => {
    const { dir } = repo();
    const r = await verifyBuiltinExecutor({ commandFor: () => "true", run: neverRun })(args(runWith(dir), { run: "verify:run --all" }));
    expect(r.status).toBe("failed");
    expect(r.reason).toContain('takes no arguments (got "--all")');
  });

  test("a node that declares nothing still runs, and publishes nothing", async () => {
    const { dir } = repo();
    const r = await verifyBuiltinExecutor({ commandFor: commandFor("true") })(args(runWith(dir), { writes: {} }));
    expect(r).toEqual({ status: "succeeded", writes: {} });
  });
});

describe("verify:run — dispatched by the command executor", () => {
  test("commandExecutor routes verify:run to the built-in with the injected lookup and timeout", async () => {
    const { dir } = repo();
    const exec = commandExecutor({ defaultTimeoutMs: 100, verify: { commandFor: commandFor("sleep 5") } });
    const r = await exec(args(runWith(dir)));
    expect(r.status).toBe("succeeded");
    expect(result(r)).toMatchObject({ outcome: "fail", timed_out: true });
  });

  test("a node's own timeoutMs beats the default", async () => {
    const { dir } = repo();
    const r = await verifyBuiltinExecutor({ commandFor: commandFor("sleep 0.2"), defaultTimeoutMs: 50 })(args(runWith(dir), { timeoutMs: 5000 }));
    expect(result(r).outcome).toBe("pass");
  });
});

describe("runShell", () => {
  test("drains a large stderr while stdout is still open — no pipe deadlock", async () => {
    // 200KB of stderr before any stdout: reading stderr only after stdout closed would block
    const r = await runShell("head -c 200000 /dev/zero | tr '\\0' x >&2; echo done", { timeoutMs: 10_000 });
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, stdout: "done\n" });
    expect(r.stderr.length).toBe(200_000);
  });

  test("tail() leaves short text alone and marks a cut", () => {
    expect(tail("abc", 10)).toBe("abc");
    expect(tail("abcdef", 3)).toBe("… [3 earlier characters are in the run log]\ndef");
  });
});
