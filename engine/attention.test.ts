import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AttentionCenter,
  formatWait,
  pidAlive,
  readHeartbeat,
  writeHeartbeat,
  type Notification,
} from "./attention";
import { check } from "../watchdog/check";

const dir = () => mkdtempSync(join(tmpdir(), "howdah-attn-"));

function capture(): { fired: Notification[]; notifier: (n: Notification) => Promise<void> } {
  const fired: Notification[] = [];
  return { fired, notifier: async (n) => void fired.push(n) };
}

function clockAt(iso: string): () => Date {
  return () => new Date(iso);
}

describe("AttentionCenter", () => {
  test("raise writes the durable record BEFORE notifying; text carries wait + deep link", async () => {
    const { fired, notifier } = capture();
    const center = new AttentionCenter(dir(), [notifier], { clock: clockAt("2026-09-13T12:00:00Z") });
    const r = await center.raise({ run: "run-1", node: "implement", visit: 2, reason: "maxVisits exceeded" });
    expect(center.pending()).toHaveLength(1);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.title).toContain("implement");
    expect(fired[0]!.body).toContain("maxVisits exceeded");
    expect(fired[0]!.body).toContain("just now");
    expect(fired[0]!.link).toBe("http://localhost:4711/run/run-1#needs-input");
    expect(r.notified_at).toBeDefined();
  });

  test("a failing notifier leaves the record durable and undelivered", async () => {
    const center = new AttentionCenter(dir(), [async () => { throw new Error("notification daemon down"); }]);
    await expect(center.raise({ run: "r", node: "n", visit: 1, reason: "x" })).rejects.toThrow();
    const [pending] = center.pending();
    expect(pending).toBeDefined();
    expect(pending!.notified_at).toBeUndefined(); // the watchdog will deliver it
  });

  test("resolve removes the record; reRaise re-notifies only stale deliveries", async () => {
    const { fired, notifier } = capture();
    let now = new Date("2026-09-13T12:00:00Z");
    const center = new AttentionCenter(dir(), [notifier], { clock: () => now });
    await center.raise({ run: "r", node: "a", visit: 1, reason: "one" });
    await center.raise({ run: "r", node: "b", visit: 1, reason: "two" });
    fired.length = 0;

    // 10 minutes later: within the 30m re-notify window — nothing fires
    now = new Date("2026-09-13T12:10:00Z");
    expect(await center.reRaise(30 * 60_000)).toHaveLength(0);

    // 40 minutes later: both re-fire, with the wait duration in the text
    now = new Date("2026-09-13T12:40:00Z");
    const due = await center.reRaise(30 * 60_000);
    expect(due).toHaveLength(2);
    expect(fired[0]!.body).toContain("waiting 40m");

    center.resolve("r:a:1");
    expect(center.pending().map((r) => r.node)).toEqual(["b"]);
  });

  test("formatWait renders hours", () => {
    expect(formatWait("2026-09-13T10:00:00Z", new Date("2026-09-13T12:05:00Z"))).toBe("waiting 2h 5m");
  });
});

describe("watchdog check()", () => {
  test("kill -9 with attention pending: the notification still arrives", async () => {
    const base = dir();
    const attentionDir = join(base, "attention");
    const heartbeat = join(base, "heartbeat.json");

    // a real process that raises attention durably and dies before delivering:
    // the notifier never fires (simulated daemon outage), then the process is SIGKILLed
    const silent = new AttentionCenter(attentionDir, [async () => { throw new Error("dead before notify"); }], {
      clock: clockAt("2026-09-13T12:00:00Z"),
    });
    await silent.raise({ run: "run-9", node: "delivery.publish", visit: 1, reason: "needs your reply" }).catch(() => {});
    // heartbeat from a process that is now dead
    const corpse = Bun.spawn(["sleep", "300"]);
    writeHeartbeat(heartbeat, clockAt("2026-09-13T12:00:00Z"), corpse.pid);
    corpse.kill(9);
    await corpse.exited;

    // the watchdog, in a different "process", with working notifiers
    const { fired, notifier } = capture();
    const result = await check({
      attentionDir,
      heartbeatPath: heartbeat,
      notifiers: [notifier],
      clock: clockAt("2026-09-13T12:10:00Z"),
      staleAfterMs: 120_000,
      reNotifyAfterMs: 30 * 60_000,
    });

    expect(result.harnessDead).toBe(true);
    expect(result.notified).toContain("run-9:delivery.publish:1");
    // both the pending ask AND the harness-death event were delivered
    const bodies = fired.map((f) => f.body).join(" | ");
    expect(bodies).toContain("needs your reply");
    expect(bodies).toContain("howdah up");
  });

  test("live harness, fresh heartbeat: no death event", async () => {
    const base = dir();
    const heartbeat = join(base, "heartbeat.json");
    writeHeartbeat(heartbeat, clockAt("2026-09-13T12:09:30Z")); // our own live pid
    const { fired, notifier } = capture();
    const result = await check({
      attentionDir: join(base, "attention"),
      heartbeatPath: heartbeat,
      notifiers: [notifier],
      clock: clockAt("2026-09-13T12:10:00Z"),
    });
    expect(result.harnessDead).toBe(false);
    expect(fired).toHaveLength(0);
  });

  test("harness death is raised once, not every tick", async () => {
    const base = dir();
    const heartbeat = join(base, "heartbeat.json");
    const corpse = Bun.spawn(["sleep", "300"]);
    writeHeartbeat(heartbeat, clockAt("2026-09-13T12:00:00Z"), corpse.pid);
    corpse.kill(9);
    await corpse.exited;

    const { fired, notifier } = capture();
    const opts = {
      attentionDir: join(base, "attention"),
      heartbeatPath: heartbeat,
      notifiers: [notifier],
      clock: clockAt("2026-09-13T13:00:00Z"),
    };
    await check(opts);
    const afterFirst = fired.length;
    await check(opts); // second tick within the re-notify window
    expect(afterFirst).toBe(1);
    expect(fired.length).toBe(1);
  });

  test("heartbeat helpers round-trip; pidAlive detects the difference", () => {
    const path = join(dir(), "hb.json");
    writeHeartbeat(path, clockAt("2026-09-13T12:00:00Z"), 12345);
    expect(readHeartbeat(path)).toEqual({ pid: 12345, at: "2026-09-13T12:00:00.000Z" });
    expect(readHeartbeat(join(dir(), "missing.json"))).toBeNull();
    expect(pidAlive(process.pid)).toBe(true);
    const corpsePath = join(dir(), "corrupt.json");
    writeFileSync(corpsePath, "not json");
    expect(readHeartbeat(corpsePath)).toBeNull();
  });
});
