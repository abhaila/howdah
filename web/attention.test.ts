/**
 * GET /api/attention (HOW-20) — the read model behind the "Needs you" screen: the answer to
 * "where are they so I can read what the actual issues are". It must agree with the ring
 * (same `stillNeedsHuman`) and must not resolve anything just because it was looked at.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../log/write";
import { AttentionCenter } from "../engine/attention";
import { createHowdahServer } from "./server";

const base = mkdtempSync(join(tmpdir(), "howdah-attn-api-"));
const runsDir = join(base, "runs");
const attentionDir = join(base, "attention");

function parked(id: string, node: string, reason: string): EventLog {
  const log = new EventLog(join(runsDir, id, "run.jsonl"));
  log.append({ type: "run-started", graph: "implement-ticket", inputs: { goal: "g" }, pinned_prompts: {} });
  log.append({ type: "node-started", node, visit: 1, attempt_id: `${node}#1` });
  log.append({ type: "attention-raised", node, visit: 1, reason });
  return log;
}

describe("GET /api/attention", () => {
  const server = createHowdahServer({ runsDir, attentionDir, port: 0, pollMs: 20 });
  const url = (p: string) => `http://localhost:${server.port}${p}`;
  afterAll(() => server.stop(true));

  test("lists what is waiting, drops what is not, and never resolves a record", async () => {
    expect(await (await fetch(url("/api/attention"))).json()).toEqual([]); // empty state is empty

    parked("run-waiting", "implementation.plan", "attempt failed");
    const finished = parked("run-finished", "implement", "attempt failed");
    finished.append({ type: "run-finished", outcome: "success" });
    const center = new AttentionCenter(attentionDir, []);
    await center.raise({ run: "run-waiting", node: "implementation.plan", visit: 1, reason: "attempt failed" });
    await center.raise({ run: "run-finished", node: "implement", visit: 1, reason: "attempt failed" });

    const items = (await (await fetch(url("/api/attention"))).json()) as any[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "run-waiting:implementation.plan:1",
      run: "run-waiting",
      graph: "implement-ticket",
      node: "implementation.plan",
      reason: "attempt failed",
      deep_link: "http://localhost:4711/run/run-waiting#needs-input",
    });
    expect(items[0].waited).toMatch(/just now|waiting/);
    expect(center.pending()).toHaveLength(2); // a GET is a read: both records are still there
  });

  test("the guard runs first, like every other route", async () => {
    const res = await fetch(url("/api/attention"), { headers: { host: "evil.test" } });
    expect(res.status).toBe(403);
  });
});
