/**
 * HOW-47 — `howdah steer <run> <text>`: the same precheck and append as the viewer's route
 * (engine/steer.ts), so the CLI refuses the same runs in the same words.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, readLog } from "../log/write";
import { claimRunner, releaseRunner } from "../engine/control";

const MAIN = join(import.meta.dir, "main.ts");
const held: string[] = [];
afterEach(() => { for (const d of held.splice(0)) releaseRunner(d); });

function liveRun(finished = false) {
  const home = mkdtempSync(join(tmpdir(), "howdah-steer-cli-"));
  const runDir = join(home, "runs", "r1");
  const log = new EventLog(join(runDir, "run.jsonl"));
  log.append({ type: "run-started", graph: "g", inputs: {}, pinned_prompts: {} });
  log.append({ type: "node-started", node: "build", visit: 1, attempt_id: "build#1" });
  log.append({ type: "prompt-rendered", node: "build", visit: 1, prompt: "doc.draft", prompt_version: 1, rendered_hash: "h", context_read: {}, harness: "claude" });
  if (finished) log.append({ type: "run-finished", outcome: "aborted" });
  claimRunner(runDir); // this test process is the run's proven runner
  held.push(runDir);
  return { home, path: join(runDir, "run.jsonl") };
}

async function steerCli(home: string, ...text: string[]) {
  const proc = Bun.spawn(["bun", MAIN, "steer", "r1", ...text], { env: { ...process.env, HOWDAH_HOME: home, HOWDAH_STUB: "1" }, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  return { code, out: await new Response(proc.stdout).text(), err: await new Response(proc.stderr).text() };
}

describe("howdah steer", () => {
  test("records the steer for the live turn and says when it will land", async () => {
    const { home, path } = liveRun();
    const r = await steerCli(home, "use", "the", "helper");
    expect(r.code).toBe(0);
    expect(r.out).toContain("sent to build@1 — it reaches the agent at its next tool call");
    expect(readLog(path).at(-1)).toMatchObject({ type: "operator-steered", text: "use the helper" });
  });

  test("refuses a finished run in the precheck's words, and appends nothing", async () => {
    const { home, path } = liveRun(true);
    const before = readLog(path).length;
    const r = await steerCli(home, "too", "late");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("the run already finished (aborted)");
    expect(readLog(path)).toHaveLength(before);
  });
});
