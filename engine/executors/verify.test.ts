/**
 * `verify:run` (HOW-12), driven through the real command executor so the dispatch is covered
 * too. The routing half — a red verdict sending a passed review back to implement — is in
 * graphs/implement-slice.test.ts; this file pins what a verdict IS:
 *   - the exit code decides, and a final JSON line cannot overturn it;
 *   - a red command is a verdict (the attempt SUCCEEDS), not a park;
 *   - stderr counts — test runners report there;
 *   - the deadline kills the whole process tree, not just the `bash -c` wrapper;
 *   - no registered command is `not-configured`, never `pass`;
 *   - a node that asks for arguments or undeclarable facts is refused before anything runs.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../../log/write";
import { commandExecutor } from "./worktree";
import type { AttemptResult } from "../run";
import type { NodeDef } from "../../core/graph";
import { finalJsonFacts, outputTail, verifyFailed, VERIFY_OUTPUT_TAIL, type VerifyVerdict } from "../../core/verify";
import { verifyCommandFor, type HowdahConfig } from "../../config/config";

const NODE = { kind: "command", run: "verify:run", writes: { "verify.verdict": { scope: "per-visit" } } } as NodeDef<any>;

function run(
  command: string | null,
  over: { def?: NodeDef<any>; cwd?: string | null; timeoutMs?: number } = {},
): Promise<AttemptResult> & { log: EventLog } {
  const dir = mkdtempSync(join(tmpdir(), "howdah-verify-"));
  const log = new EventLog(join(dir, "run", "run.jsonl"));
  const exec = commandExecutor({
    verify: { verifyCommandFor: () => (command === null ? null : { workspace: "api", command }), defaultTimeoutMs: over.timeoutMs },
  });
  const cwd = over.cwd === null ? undefined : (over.cwd ?? dir);
  const p = exec({
    nodeId: "verify.run", def: over.def ?? NODE, visit: 1, attemptId: "verify.run#1", runId: "run",
    log, reads: {}, effects: { claim: () => false, done: () => {} } as never,
    ...(cwd ? { cwd } : {}),
  });
  return Object.assign(p, { log });
}

const verdictOf = (r: AttemptResult) => r.writes["verify.verdict"] as VerifyVerdict;

describe("verify:run — the exit code is the verdict", () => {
  test("exit 0 passes and carries the final JSON line as facts", async () => {
    const r = await run(`echo building; echo '{"passed": 12, "failed": 0}'`);
    expect(r.status).toBe("succeeded");
    expect(verdictOf(r)).toMatchObject({ status: "pass", exit_code: 0, timed_out: false, command: expect.any(String), workspace: "api", facts: { passed: 12, failed: 0 } });
  });

  test("a red command is a verdict, not a park — and its JSON cannot overturn the exit code", async () => {
    const r = await run(`echo "1 test failed" >&2; echo '{"status": "pass"}'; exit 3`);
    expect(r.status).toBe("succeeded");
    const v = verdictOf(r);
    expect(v).toMatchObject({ status: "fail", exit_code: 3, facts: { status: "pass" } });
    expect(verifyFailed(v)).toBe(true);
    // stderr is evidence too: bun test, jest and gradle all report failures there
    expect(v.output_tail).toContain("1 test failed");
  });

  test("the deadline kills the whole tree: a backgrounded child holding the pipes does not hang the node", async () => {
    const t0 = Date.now();
    const r = await run(`sleep 30 & sleep 30; wait`, { timeoutMs: 300 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(verdictOf(r)).toMatchObject({ status: "fail", timed_out: true, exit_code: null });
  });

  test("the node's timeoutMs beats the executor default", async () => {
    const r = await run(`sleep 30`, { def: { ...NODE, timeoutMs: 200 } as NodeDef<any>, timeoutMs: 60_000 });
    expect(verdictOf(r)).toMatchObject({ status: "fail", timed_out: true });
  });

  test("it runs in the run's worktree, not the process's cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-verify-cwd-"));
    writeFileSync(join(dir, "marker"), "here");
    expect(verdictOf(await run(`test -f marker`, { cwd: dir })).status).toBe("pass");
  });

  test("every chunk of output is logged as it streams, bracketed by the command and its result", async () => {
    const p = run(`echo one; echo two >&2; exit 1`);
    await p;
    const chunks = p.log.read().flatMap((e) => (e.type === "chunk" ? [`${e.kind}:${e.content.trim()}`] : []));
    expect(chunks[0]).toBe("tool_call:echo one; echo two >&2; exit 1");
    expect(chunks).toContain("text:one");
    expect(chunks).toContain("text:two");
    expect(chunks.at(-1)).toBe("tool_result:fail: exit 1");
  });
});

describe("verify:run — nothing configured is its own answer", () => {
  test("a registered workspace with no command reports not-configured, names the workspace, and leaves a thread note", async () => {
    const r = await run("");
    expect(r.status).toBe("succeeded");
    expect(verdictOf(r)).toMatchObject({ status: "not-configured", command: null, exit_code: null, workspace: "api" });
    expect(verifyFailed(verdictOf(r))).toBe(false);
    expect(r.reason).toContain('workspace "api"');
    expect(r.reason).toContain("howdah workspace verify");
  });

  test("an unregistered folder, or a run with no folder at all, is not-configured too", async () => {
    expect(verdictOf(await run(null)).status).toBe("not-configured");
    const none = await run("true", { cwd: null });
    expect(verdictOf(none)).toMatchObject({ status: "not-configured", workspace: null });
    expect(none.reason).toContain("no workspace folder");
  });
});

describe("verify:run — graph bugs are refused before anything runs", () => {
  test("arguments on the built-in: the command is the workspace's, not the graph's", async () => {
    const r = await run("touch ran", { def: { ...NODE, run: "verify:run bun test" } as NodeDef<any> });
    expect(r).toMatchObject({ status: "failed", reason: expect.stringContaining("takes no arguments") });
  });

  test("a declared fact it cannot produce", async () => {
    const r = await run("true", { def: { ...NODE, writes: { "verify.verdict": { scope: "per-visit" }, tests_passed: { scope: "sticky" } } } as NodeDef<any> });
    expect(r).toMatchObject({ status: "failed", reason: expect.stringContaining("cannot produce tests_passed") });
  });
});

describe("the verdict helpers (core/verify.ts)", () => {
  test("finalJsonFacts reads only a JSON OBJECT on the last non-empty line", () => {
    expect(finalJsonFacts(`ok\n{"a":1}\n\n`)).toEqual({ a: 1 });
    expect(finalJsonFacts(`{"a":1}\nok`)).toBeUndefined();
    expect(finalJsonFacts(`[1,2]`)).toBeUndefined();
    expect(finalJsonFacts(`{not json`)).toBeUndefined();
  });

  test("outputTail keeps the END, where failures print, and says what it cut", () => {
    const long = "x".repeat(VERIFY_OUTPUT_TAIL) + "THE FAILURE";
    const tail = outputTail(long);
    expect(tail.endsWith("THE FAILURE")).toBe(true);
    expect(tail).toContain("11 earlier characters omitted");
    expect(outputTail("short")).toBe("short");
  });
});

describe("verifyCommandFor (config/config.ts)", () => {
  const config: HowdahConfig = {
    repos: { api: { path: "/r/api", verifyCommand: "  bun test  " }, web: { path: "/r/web" } },
    folders: { notes: { path: "/f/notes", verifyCommand: "make check" } },
  };
  test("three answers kept apart: a command, a registered workspace with none, and nothing registered", () => {
    expect(verifyCommandFor(config, "/r/api")).toEqual({ workspace: "api", command: "bun test" });
    expect(verifyCommandFor(config, "/r/web")).toEqual({ workspace: "web", command: "" });
    expect(verifyCommandFor(config, "/f/notes")).toEqual({ workspace: "notes", command: "make check" });
    expect(verifyCommandFor(config, "/elsewhere")).toBeNull();
  });
});
