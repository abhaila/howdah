import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AttentionCenter,
  formatWait,
  makeOsNotifier,
  notifierArgv,
  notifierStatus,
  OS_SOUND,
  pidAlive,
  resolveViewerBase,
  readHeartbeat,
  writeHeartbeat,
  type Notification,
} from "./attention";
import { check } from "../watchdog/check";
import { presencePath, readPresence, VIEWER_FRESH_MS, viewerDelivers, viewerMissedIt, writePresence } from "./viewer-presence";
import { EventLog } from "../log/write";

const dir = () => mkdtempSync(join(tmpdir(), "howdah-attn-"));

/** a run parked on an ask — the state a pending attention record is supposed to describe */
function seedParked(runsDir: string, id: string, node = "implement"): EventLog {
  const log = new EventLog(join(runsDir, id, "run.jsonl"));
  log.append({ type: "run-started", graph: "implement-ticket", inputs: { goal: "g" }, pinned_prompts: {} });
  log.append({ type: "node-started", node, visit: 1, attempt_id: `${node}#1` });
  log.append({ type: "attention-raised", node, visit: 1, reason: "needs your reply" });
  return log;
}

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
    expect(fired[0]!.title).toBe("Howdah needs you — run-1 · implement");
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

  test("resolve removes the record; reRaise reports only stale deliveries", async () => {
    const { fired, notifier } = capture();
    let now = new Date("2026-09-13T12:00:00Z");
    const center = new AttentionCenter(dir(), [notifier], { clock: () => now });
    await center.raise({ run: "r", node: "a", visit: 1, reason: "one" });
    await center.raise({ run: "r", node: "b", visit: 1, reason: "two" });
    fired.length = 0;

    // 10 minutes later: within the 30m re-notify window — nothing is due
    now = new Date("2026-09-13T12:10:00Z");
    expect(await center.reRaise(30 * 60_000)).toHaveLength(0);

    // 40 minutes later: both are due — and reRaise RETURNS them rather than ringing each
    // one, so the caller can deliver a backlog as a single notification (HOW-20)
    now = new Date("2026-09-13T12:40:00Z");
    const due = await center.reRaise(30 * 60_000);
    expect(due).toHaveLength(2);
    expect(fired).toHaveLength(0);
    await center.notify(due[0]!);
    expect(fired[0]!.body).toContain("waiting 40m");

    center.resolve("r:a:1");
    expect(center.pending().map((r) => r.node)).toEqual(["b"]);
  });

  test("the same id raised twice is ONE situation: rewritten durably, rung once, clock kept", async () => {
    const { fired, notifier } = capture();
    let now = new Date("2026-09-13T12:00:00Z");
    const center = new AttentionCenter(dir(), [notifier], { clock: () => now });
    // the claude executor's permission ask…
    await center.raise({ run: "r", node: "implement", visit: 2, reason: "Bash needs permission" });
    // …and the park that follows it seconds later, on the very same id
    now = new Date("2026-09-13T12:00:20Z");
    const second = await center.raise({ run: "r", node: "implement", visit: 2, reason: "attempt failed" });

    expect(fired).toHaveLength(1);                       // one situation, one ring
    expect(center.pending()).toHaveLength(1);
    expect(second.reason).toBe("attempt failed");        // the write still happened
    expect(second.raised_at).toBe("2026-09-13T12:00:00.000Z"); // the wait clock did not restart

    // past the cooldown, the same standing ask may ring again
    now = new Date("2026-09-13T12:20:00Z");
    await center.raise({ run: "r", node: "implement", visit: 2, reason: "attempt failed" });
    expect(fired).toHaveLength(2);
    expect(fired[1]!.body).toContain("waiting 20m");
  });

  test("a backlog is ONE notification naming the count and linking the inbox", async () => {
    const { fired, notifier } = capture();
    const now = new Date("2026-09-13T12:00:00Z");
    const center = new AttentionCenter(dir(), [notifier], { clock: () => now, viewerBase: "http://localhost:4711" });
    const records = [];
    for (const node of ["a", "b", "c"])
      records.push(await center.raise({ run: `run-${node}`, node, visit: 1, reason: `${node} waits` }));
    fired.length = 0;

    await center.notify(records);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.title).toBe("Howdah needs you — 3 runs");
    expect(fired[0]!.link).toBe("http://localhost:4711/attention");
    expect(fired[0]!.body).toContain("run-a · a");
    // every record in the batch counts as delivered, or the next tick rings for it again
    expect(center.pending().every((r) => r.notified_at)).toBe(true);
  });

  test("reRaise resolves a record whose run no longer needs a human, and never rings it", async () => {
    const { fired, notifier } = capture();
    const now = new Date("2026-09-13T13:00:00Z");
    const center = new AttentionCenter(dir(), [notifier], { clock: () => now });
    await center.raise({ run: "live", node: "n", visit: 1, reason: "waiting" });
    await center.raise({ run: "dead", node: "n", visit: 1, reason: "long gone" });
    fired.length = 0;

    const due = await center.reRaise(0, (r) => r.run === "live");
    expect(due.map((r) => r.run)).toEqual(["live"]);
    expect(center.pending().map((r) => r.run)).toEqual(["live"]);
    expect(fired).toHaveLength(0); // reRaise decides; the caller delivers
  });

  test("the macOS ring is clickable when it can be, and still says where to go when it cannot", () => {
    const n: Notification = { title: 'a "quoted" run', body: "why", link: "http://localhost:4711/run/r#needs-input" };
    const clickable = notifierArgv(n, "/opt/homebrew/bin/terminal-notifier");
    expect(clickable).toEqual([
      "/opt/homebrew/bin/terminal-notifier",
      "-title", "a quoted run",
      "-message", "why",
      "-open", "http://localhost:4711/run/r#needs-input",
    ]);
    // HOW-68: silent unless the operator turned the sound on — and then on both deliverers
    // D19: and then the soft system sound, not "Glass" (the expectation changed with the sound)
    expect(OS_SOUND).toBe("Tink");
    expect(notifierArgv(n, "/opt/homebrew/bin/terminal-notifier", true).slice(-2)).toEqual(["-sound", "Tink"]);
    expect(notifierArgv(n, null)[2]).not.toContain("sound name");
    expect(notifierArgv(n, null, true)[2]).toContain('sound name "Tink"');
    expect(JSON.stringify([notifierArgv(n, null, true), notifierArgv(n, "/x/terminal-notifier", true)])).not.toContain("Glass");
    const fallback = notifierArgv(n, null);
    expect(fallback[0]).toBe("osascript");
    expect(fallback[2]).toContain("http://localhost:4711/run/r#needs-input");
    expect(fallback[2]).not.toContain('"a "quoted" run"'); // the AppleScript is still intact
  });

  test("formatWait renders hours", () => {
    expect(formatWait("2026-09-13T10:00:00Z", new Date("2026-09-13T12:05:00Z"))).toBe("waiting 2h 5m");
  });
});

describe("viewer presence decides whether the OS banner rings (HOW-68 D18)", () => {
  const t0 = new Date("2026-11-12T10:00:00Z");
  const at = (ms: number) => new Date(t0.getTime() + ms);
  const n: Notification = { title: "Howdah needs you — r · n", body: "why", link: "http://localhost:4711/run/r#needs-input" };

  test("viewerDelivers: only a NOTIFYING viewer seen inside the window stands in for the banner", () => {
    const beat = { at: t0.toISOString(), notify: true };
    expect(viewerDelivers(null, t0)).toBe(false); // no viewer was ever open
    expect(viewerDelivers(beat, at(0))).toBe(true);
    expect(viewerDelivers(beat, at(VIEWER_FRESH_MS))).toBe(true);
    expect(viewerDelivers(beat, at(VIEWER_FRESH_MS + 1))).toBe(false); // two missed beats: gone
    expect(viewerDelivers({ ...beat, notify: false }, at(1000))).toBe(false); // open, but may not notify
    expect(viewerDelivers(beat, at(-5000))).toBe(false); // a beat from the future proves nothing
  });

  test("viewerMissedIt: a viewer that never beat again after the ask was not there", () => {
    const deferred = t0.toISOString();
    const before = { at: at(-10_000).toISOString(), notify: true };
    const after = { at: at(15_000).toISOString(), notify: true };
    expect(viewerMissedIt(before, deferred, at(20_000))).toBe(false); // too early to tell
    expect(viewerMissedIt(before, deferred, at(VIEWER_FRESH_MS))).toBe(true);
    expect(viewerMissedIt(after, deferred, at(10 * 60_000))).toBe(false); // it beat afterwards: it got the ask
    expect(viewerMissedIt(null, deferred, at(VIEWER_FRESH_MS))).toBe(true);
  });

  test("presence round-trips through viewer.json, and a torn file is no viewer", () => {
    const home = dir();
    expect(readPresence(home)).toBeNull();
    writePresence(home, { notify: true, base: "http://localhost:4841" }, () => t0);
    expect(readPresence(home)).toEqual({ at: t0.toISOString(), notify: true, base: "http://localhost:4841" });
    writeFileSync(presencePath(home), '{"at":');
    expect(readPresence(home)).toBeNull();
    writeFileSync(presencePath(home), '{"at":"not a date","notify":true}');
    expect(readPresence(home)).toBeNull();
  });

  test("the OS notifier skips while a notifying viewer is fresh, and rings otherwise", async () => {
    const home = dir();
    const spawned: string[][] = [];
    const os = (now: Date) => makeOsNotifier({ home, clock: () => now, spawn: (a) => void spawned.push(a), which: () => null });

    expect(await os(t0)(n)).toBeUndefined(); // no viewer.json at all
    expect(spawned).toHaveLength(1);
    expect(spawned[0]![0]).toBe("osascript"); // no terminal-notifier: the fallback still rings

    writePresence(home, { notify: true }, () => t0);
    expect(await os(at(5000))(n)).toBe("viewer");
    expect(spawned).toHaveLength(1); // nothing posted: the browser's notification is the one

    expect(await os(at(VIEWER_FRESH_MS + 1000))(n)).toBeUndefined(); // the tab closed
    expect(spawned).toHaveLength(2);

    writePresence(home, { notify: false }, () => at(60_000)); // open, permission not granted
    expect(await os(at(61_000))(n)).toBeUndefined();
    expect(spawned).toHaveLength(3);
  });

  test("a ring left to the viewer is durable, counts as notified, and says who was trusted", async () => {
    const attn = join(dir(), "attention");
    let now = t0;
    const center = new AttentionCenter(attn, [async () => "viewer" as const], { clock: () => now, presence: () => ({ at: t0.toISOString(), notify: true }) });
    const r = await center.raise({ run: "r", node: "n", visit: 1, reason: "needs your reply" });
    expect(r.notified_at).toBe(t0.toISOString());
    expect(center.pending()[0]).toMatchObject({ id: "r:n:1", notified_via: "viewer" });
    // a re-raise inside the cooldown keeps the stamp AND who it was left to
    now = at(5000);
    await center.raise({ run: "r", node: "n", visit: 1, reason: "park: no matching edge" });
    expect(center.pending()[0]).toMatchObject({ notified_at: t0.toISOString(), notified_via: "viewer" });
  });

  test("the watchdog rings through the OS once the viewer is shown to have been gone", async () => {
    const attn = join(dir(), "attention");
    let now = t0;
    let presence: { at: string; notify: boolean } | null = { at: at(-10_000).toISOString(), notify: true };
    let viewerOpen = true;
    const rung: string[] = [];
    const notifier = async (x: Notification) => { if (viewerOpen) return "viewer" as const; rung.push(x.title); };
    const center = new AttentionCenter(attn, [notifier], { clock: () => now, presence: () => presence });
    await center.raise({ run: "r", node: "n", visit: 1, reason: "needs your reply" });
    expect(rung).toEqual([]);

    // 20s later: still inside the window — nothing is known yet, so nothing is due
    now = at(20_000);
    expect(await center.reRaise(30 * 60_000)).toEqual([]);

    // a minute later the viewer has not beaten since the ask: it was never there. Due NOW,
    // not at the 30-minute mark, and by now the notifier rings for real.
    now = at(60_000);
    viewerOpen = false;
    const due = await center.reRaise(30 * 60_000);
    expect(due.map((r) => r.id)).toEqual(["r:n:1"]);
    await center.notify(due);
    expect(rung).toEqual(["Howdah needs you — r · n"]);
    expect(center.pending()[0]!.notified_via).toBeUndefined(); // delivered by the OS now

    // whereas a viewer that DID beat after the ask delivered it: no early re-ring
    const center2 = new AttentionCenter(join(dir(), "attention"), [async () => "viewer" as const], { clock: () => now, presence: () => presence });
    now = t0;
    await center2.raise({ run: "r", node: "n", visit: 1, reason: "needs your reply" });
    presence = { at: at(15_000).toISOString(), notify: true };
    now = at(5 * 60_000);
    expect(await center2.reRaise(30 * 60_000)).toEqual([]);
    now = at(31 * 60_000); // the ordinary re-notify still comes round
    expect((await center2.reRaise(30 * 60_000)).map((r) => r.id)).toEqual(["r:n:1"]);
  });

  test("deep links follow the viewer's real port, not :4711", async () => {
    const home = dir();
    expect(resolveViewerBase(home, {})).toBe("http://localhost:4711");
    expect(resolveViewerBase(home, { HOWDAH_PORT: "4841" })).toBe("http://localhost:4841");
    expect(resolveViewerBase(home, { HOWDAH_PORT: "nonsense" })).toBe("http://localhost:4711");
    // launchd's watchdog has no HOWDAH_PORT: it uses where a viewer last said it was
    writePresence(home, { notify: false, base: "http://localhost:5005" });
    expect(resolveViewerBase(home, {})).toBe("http://localhost:5005");
    expect(resolveViewerBase(home, { HOWDAH_PORT: "4841" })).toBe("http://localhost:4841"); // the env wins
    expect(resolveViewerBase(home, {}, { at: t0.toISOString(), notify: true, base: "https://evil.example" })).toBe("http://localhost:4711");
    // and an AttentionCenter nobody told (the CLI, the watchdog, an executor) builds links from it
    const prior = process.env.HOWDAH_PORT;
    delete process.env.HOWDAH_PORT;
    try {
      const center = new AttentionCenter(join(home, "attention"), []);
      const r = await center.raise({ run: "r", node: "n", visit: 1, reason: "x" });
      expect(r.deep_link).toBe("http://localhost:5005/run/r#needs-input");
    } finally {
      if (prior !== undefined) process.env.HOWDAH_PORT = prior;
    }
  });

  test("notifierStatus says which banner the operator gets, and the one line that fixes it", () => {
    expect(notifierStatus(() => "/opt/homebrew/bin/terminal-notifier")).toMatchObject({ clickable: true, path: "/opt/homebrew/bin/terminal-notifier" });
    expect(notifierStatus(() => "/x/terminal-notifier").fix).toBeUndefined();
    const missing = notifierStatus(() => null);
    expect(missing).toMatchObject({ clickable: false, path: null, fix: "brew install terminal-notifier" });
    expect(missing.detail).toContain("Script Editor");
  });
});

describe("watchdog check()", () => {
  test("kill -9 with attention pending: the notification still arrives", async () => {
    const base = dir();
    const attentionDir = join(base, "attention");
    const heartbeat = join(base, "heartbeat.json");
    seedParked(join(base, "runs"), "run-9", "delivery.publish");

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

  test("three pending records, one of them long finished: ONE ring, and the dead one is gone", async () => {
    const base = dir();
    const attentionDir = join(base, "attention");
    const runsDir = join(base, "runs");
    const { fired, notifier } = capture();
    const raiser = new AttentionCenter(attentionDir, [], { clock: clockAt("2026-09-13T12:00:00Z") });
    for (const id of ["run-a", "run-b", "run-done"]) {
      seedParked(runsDir, id);
      await raiser.raise({ run: id, node: "implement", visit: 1, reason: `${id} waits` });
    }
    // run-done finished hours ago and nothing cleared its record — the flood in HOW-20
    new EventLog(join(runsDir, "run-done", "run.jsonl")).append({ type: "run-finished", outcome: "success" });

    const result = await check({
      attentionDir,
      runsDir,
      heartbeatPath: join(base, "heartbeat.json"), // never written: no harness claim either way
      notifiers: [notifier],
      clock: clockAt("2026-09-13T12:40:00Z"),
      reNotifyAfterMs: 30 * 60_000,
    });

    expect(result.notified.sort()).toEqual(["run-a:implement:1", "run-b:implement:1"]);
    expect(result.resolved).toEqual(["run-done:implement:1"]);
    expect(raiser.pending().map((r) => r.run)).toEqual(["run-a", "run-b"]);
    // two due records, ONE banner — not one per record per tick
    expect(fired).toHaveLength(1);
    expect(fired[0]!.title).toBe("Howdah needs you — 2 runs");
    expect(fired[0]!.link).toBe("http://localhost:4711/attention");
  });

  /**
   * The only durable record of "the supervisor is down" may not be deleted by a tick that
   * merely FAILED TO PROVE the harness dead (HOW-20 review): a recycled pid, or a heartbeat
   * torn by a kill mid-write (writeHeartbeat is a plain writeFileSync), both read as "not
   * provably dead" while the harness is still very much down.
   */
  test("a tick that cannot prove the harness dead leaves its record standing", async () => {
    const base = dir();
    const attentionDir = join(base, "attention");
    const heartbeat = join(base, "heartbeat.json");
    const { fired, notifier } = capture();
    const corpse = Bun.spawn(["sleep", "300"]);
    writeHeartbeat(heartbeat, clockAt("2026-09-13T12:00:00Z"), corpse.pid);
    corpse.kill(9);
    await corpse.exited;
    const opts = {
      attentionDir,
      runsDir: join(base, "runs"),
      heartbeatPath: heartbeat,
      notifiers: [notifier],
      clock: clockAt("2026-09-13T12:10:00Z"),
    };
    expect((await check(opts)).harnessDead).toBe(true);

    // the pid has been recycled: the heartbeat is STILL stale, but its pid now runs again
    writeHeartbeat(heartbeat, clockAt("2026-09-13T12:00:00Z"), process.pid);
    const recycled = await check(opts);
    expect(recycled.harnessDead).toBe(false);
    expect(recycled.resolved).toEqual([]);
    expect(new AttentionCenter(attentionDir, []).pending().map((r) => r.id)).toEqual(["howdah:__harness__:1"]);

    // and a heartbeat torn mid-write says nothing either way — still not proof of a return
    writeFileSync(heartbeat, '{"pid":');
    const torn = await check(opts);
    expect(torn.resolved).toEqual([]);
    expect(new AttentionCenter(attentionDir, []).pending().map((r) => r.id)).toEqual(["howdah:__harness__:1"]);
    expect(fired).toHaveLength(1); // one ring for one situation, across all three ticks
  });

  test("the harness banner links the inbox — /run/howdah is not a page", async () => {
    const base = dir();
    const heartbeat = join(base, "heartbeat.json");
    const { fired, notifier } = capture();
    const corpse = Bun.spawn(["sleep", "300"]);
    writeHeartbeat(heartbeat, clockAt("2026-09-13T12:00:00Z"), corpse.pid);
    corpse.kill(9);
    await corpse.exited;
    await check({
      attentionDir: join(base, "attention"),
      runsDir: join(base, "runs"),
      heartbeatPath: heartbeat,
      notifiers: [notifier],
      clock: clockAt("2026-09-13T12:10:00Z"),
    });
    expect(fired).toHaveLength(1);
    expect(fired[0]!.body).toContain("howdah up");
    expect(fired[0]!.link).toBe("http://localhost:4711/attention");
  });

  test("the harness record is cleared once the heartbeat comes back", async () => {
    const base = dir();
    const attentionDir = join(base, "attention");
    const heartbeat = join(base, "heartbeat.json");
    const { fired, notifier } = capture();
    const corpse = Bun.spawn(["sleep", "300"]);
    writeHeartbeat(heartbeat, clockAt("2026-09-13T12:00:00Z"), corpse.pid);
    corpse.kill(9);
    await corpse.exited;
    const opts = {
      attentionDir,
      runsDir: join(base, "runs"),
      heartbeatPath: heartbeat,
      notifiers: [notifier],
      clock: clockAt("2026-09-13T12:10:00Z"),
    };
    expect((await check(opts)).harnessDead).toBe(true);
    expect(fired).toHaveLength(1);

    // `howdah up` is back: the record it left is answered, and nothing else ever cleared it
    writeHeartbeat(heartbeat, clockAt("2026-09-13T12:09:30Z"));
    const back = await check(opts);
    expect(back.harnessDead).toBe(false);
    expect(back.resolved).toContain("howdah:__harness__:1");
    expect(new AttentionCenter(attentionDir, []).pending()).toHaveLength(0);
    expect(fired).toHaveLength(1); // and it did not ring again on the way out
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
