/**
 * HOW-51 — POST /api/runs/:id/acceptance/waive: a decision appended under the log lock; the
 * runner is resumed only when the waiver settled the LAST unmet criterion of a run parked on the
 * gate. Refusals come back in the decision's own words.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, readLog } from "../log/write";
import { createHowdahServer } from "./server";

function parked(rows: Array<{ id: string; passes: boolean; check?: string }>, verify?: unknown) {
  const home = mkdtempSync(join(tmpdir(), "howdah-waive-"));
  const runDir = join(home, "runs", "r1");
  const log = new EventLog(join(runDir, "run.jsonl"));
  log.append({ type: "run-started", graph: "implement-ticket", inputs: {}, pinned_prompts: {} });
  if (verify) log.append({ type: "node-finished", node: "verify.run", visit: 1, status: "succeeded", writes: { "verify.result": verify } });
  log.append({ type: "node-finished", node: "implementation.local_review", visit: 1, status: "succeeded", writes: {
    acceptance: rows.map((r) => ({ id: r.id, text: r.id, source: "plan", passes: r.passes, evidence: r.passes ? { kind: "verify.result" } : null, ...(r.check ? { check: r.check } : {}) })),
  } });
  log.append({ type: "attention-raised", node: "delivery.publish", visit: 1, reason: "unmet", code: "acceptance-unmet" });
  return { home, path: join(runDir, "run.jsonl") };
}

async function withServer(home: string, fn: (post: (body: unknown) => Promise<Response>, resumed: string[]) => Promise<void>) {
  const resumed: string[] = [];
  const server = createHowdahServer({ runsDir: join(home, "runs"), attentionDir: join(home, "attention"), port: 0, graphs: {}, resumeRun: (id) => resumed.push(id) });
  const post = (body: unknown) => fetch(`http://localhost:${server.port}/api/runs/r1/acceptance/waive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try { await fn(post, resumed); } finally { server.stop(true); }
}

describe("POST /api/runs/:id/acceptance/waive", () => {
  test("the last unmet criterion: 202, the decision is logged, and the parked run is resumed", async () => {
    const { home, path } = parked([{ id: "ac-1", passes: true }, { id: "ac-2", passes: false }]);
    await withServer(home, async (post, resumed) => {
      const res = await post({ criterion: "ac-2", reason: "checked by eye" });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true, appended: true, remaining: 0, resumed: true });
      expect(resumed).toEqual(["r1"]);
      expect(readLog(path).at(-1)).toMatchObject({ type: "acceptance-waived", criterion_id: "ac-2", reason: "checked by eye", by: "operator" });
    });
  });

  test("not the last one: logged, but the run stays held", async () => {
    const { home } = parked([{ id: "ac-1", passes: false }, { id: "ac-2", passes: false }]);
    await withServer(home, async (post, resumed) => {
      expect(await (await post({ criterion: "ac-1", reason: "r" })).json()).toMatchObject({ remaining: 1, resumed: false });
      expect(resumed).toEqual([]);
    });
  });

  test("a refusal is a 409 in the decision's own words", async () => {
    const { home, path } = parked([{ id: "ac-1", passes: true }]);
    const before = readLog(path).length;
    await withServer(home, async (post) => {
      const res = await post({ criterion: "ac-1", reason: "r" });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('criterion "ac-1" already passes on evidence — there is nothing to waive');
    });
    expect(readLog(path)).toHaveLength(before);
  });

  test("HOW-59: `unprovable: true` waives every row this run cannot prove, and resumes when that was all", async () => {
    const { home, path } = parked([{ id: "ac-1", passes: false, check: "tests" }, { id: "ac-2", passes: false, check: "human" }], { outcome: "not-checked", reason: "no verify command" });
    await withServer(home, async (post, resumed) => {
      const res = await post({ unprovable: true, reason: "no test command on this repo" });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true, waived: ["ac-1", "ac-2"], remaining: 0, resumed: true });
      expect(resumed).toEqual(["r1"]);
    });
    expect(readLog(path).filter((e) => e.type === "acceptance-waived")).toHaveLength(2);
  });

  test("HOW-59: with nothing unprovable, the bulk waiver is a 409 and logs nothing", async () => {
    const { home, path } = parked([{ id: "ac-1", passes: false, check: "command" }]);
    const before = readLog(path).length;
    await withServer(home, async (post) => {
      const res = await post({ unprovable: true, reason: "r" });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain("no unmet criterion is unprovable");
    });
    expect(readLog(path)).toHaveLength(before);
  });
});
