/**
 * HOW-47 — the steer precheck and its route. ONE precheck (engine/steer.ts) for the route and
 * `howdah steer`; it runs again inside the log lock, so a turn that ends between the check and
 * the append refuses rather than queueing a steer nothing will deliver.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, readLog } from "../log/write";
import type { RunEvent } from "../log/events";
import { claimRunner, releaseRunner } from "../engine/control";
import { steer, steerRefusal } from "../engine/steer";
import { MAX_STEER_CHARS } from "../core/steer";
import { createHowdahServer } from "./server";

const claimed: string[] = [];
afterEach(() => { for (const d of claimed.splice(0)) releaseRunner(d); });

/** a run whose `build@1` is a live claude turn; `extra` appends after it; `live` claims the runner */
function run(extra: RunEvent[] = [], opts: { live?: boolean; harness?: "claude" | "codex" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "howdah-steer-route-"));
  const runDir = join(home, "runs", "r1");
  const log = new EventLog(join(runDir, "run.jsonl"));
  log.append({ type: "run-started", graph: "g", inputs: {}, pinned_prompts: {} });
  log.append({ type: "node-started", node: "build", visit: 1, attempt_id: "build#1" });
  log.append({ type: "prompt-rendered", node: "build", visit: 1, prompt: "doc.draft", prompt_version: 1, rendered_hash: "h", context_read: {}, harness: opts.harness ?? "claude" });
  for (const e of extra) log.append(e);
  if (opts.live ?? true) { claimRunner(runDir); claimed.push(runDir); }
  return { home, runDir, path: join(runDir, "run.jsonl") };
}

describe("the steer precheck", () => {
  test("a live claude turn on a proven runner accepts a steer, recorded under the log lock", () => {
    const { runDir, path } = run();
    expect(steerRefusal(runDir, "use core/")).toBeNull();
    const sent = steer(runDir, "  use core/  ");
    expect(sent).toMatchObject({ ok: true, node: "build", visit: 1 });
    expect(readLog(path).at(-1)).toMatchObject({ type: "operator-steered", node: "build", visit: 1, text: "use core/", by: "operator" });
  });

  test.each([
    ["a finished run", [{ type: "run-finished", outcome: "success" }] as RunEvent[], /already finished/],
    ["a parked run (answer it instead)", [{ type: "attention-raised", node: "build", visit: 1, reason: "which?" }] as RunEvent[], /waiting on you — answer it with a reply/],
    ["a paused run", [{ type: "run-paused", by: "operator" }] as RunEvent[], /paused/],
    ["a step that has finished", [{ type: "node-finished", node: "build", visit: 1, status: "succeeded", writes: {} }] as RunEvent[], /has finished/],
  ])("refuses %s", (_label, extra, why) => {
    const { runDir, path } = run(extra);
    const before = readLog(path).length;
    expect(steerRefusal(runDir, "x")).toMatch(why);
    expect(steer(runDir, "x").ok).toBe(false);
    expect(readLog(path)).toHaveLength(before); // nothing appended
  });

  test("refuses a dead runner: nothing would deliver it", () => {
    const { runDir } = run([], { live: false });
    expect(steerRefusal(runDir, "x")).toMatch(/runner is not alive/);
  });

  test("refuses a harness with no steer channel, naming it", () => {
    const { runDir } = run([], { harness: "codex" });
    expect(steerRefusal(runDir, "x")).toBe("steer: not supported on codex — it has no channel into a running turn yet");
  });

  test("refuses a step that is not an agent turn", () => {
    const home = mkdtempSync(join(tmpdir(), "howdah-steer-cmd-"));
    const runDir = join(home, "runs", "r");
    const log = new EventLog(join(runDir, "run.jsonl"));
    log.append({ type: "run-started", graph: "g", inputs: {}, pinned_prompts: {} });
    log.append({ type: "node-started", node: "worktree.create", visit: 1, attempt_id: "w#1" });
    claimRunner(runDir); claimed.push(runDir);
    expect(steerRefusal(runDir, "x")).toMatch(/not an agent turn/);
  });

  test("an empty or over-long steer is refused, never trimmed", () => {
    const { runDir } = run();
    expect(steerRefusal(runDir, "   ")).toBe("a steer needs some text");
    expect(steerRefusal(runDir, "x".repeat(MAX_STEER_CHARS + 1))).toMatch(/at most 4000 characters/);
  });
});

describe("POST /api/runs/:id/steer", () => {
  async function serve(r: ReturnType<typeof run>, fn: (url: (p: string) => string, port: number) => Promise<void>) {
    const server = createHowdahServer({ runsDir: join(r.home, "runs"), attentionDir: join(r.home, "attention"), port: 0, graphs: {} });
    try { await fn((p) => `http://localhost:${server.port}${p}`, server.port!); } finally { server.stop(true); }
  }
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  test("accepted while running: 202, and the steer is in the log", async () => {
    const r = run();
    await serve(r, async (url) => {
      const res = await fetch(url("/api/runs/r1/steer"), post({ text: "use core/" }));
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ ok: true, node: "build", visit: 1 });
      expect(readLog(r.path).at(-1)).toMatchObject({ type: "operator-steered", text: "use core/" });
    });
  });

  test("refused on a non-running run, with the precheck's own words", async () => {
    const r = run([{ type: "run-finished", outcome: "success" }]);
    await serve(r, async (url) => {
      const res = await fetch(url("/api/runs/r1/steer"), post({ text: "x" }));
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/already finished/);
    });
  });

  test("refused for a cross-origin request (guardRequest), and nothing is appended", async () => {
    const r = run();
    const before = readLog(r.path).length;
    await serve(r, async (url) => {
      const res = await fetch(url("/api/runs/r1/steer"), post({ text: "x" }, { origin: "http://evil.test" }));
      expect(res.status).toBe(403);
    });
    expect(readLog(r.path)).toHaveLength(before);
  });
});
