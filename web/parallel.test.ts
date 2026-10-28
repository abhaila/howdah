/**
 * HOW-73 — the read model over a parallel step's log: status and the ask name the branch that
 * parked (and keep its failure reason past its siblings' finishes), the timeline shows the
 * branches as concurrent rows with no false "failed", every live branch turn reads live, two
 * branches' mid-turn questions stand together, and a steer with several live turns asks which.
 */
import { describe, expect, test } from "bun:test";
import { deriveDetail, deriveStatus, deriveTimeline } from "./derive";
import { FakeLog } from "./slice.fixtures";
import { replayState } from "../engine/replay";
import { steerTarget } from "../engine/steer-state";
import { parallelBlocks } from "./app/run/steps";
import { conversation } from "./app/run/chat";

const BRANCHES = ["review_security", "review_tests", "review_ux"];

/** build → fan, and the three branches started and talking; nothing finished yet */
function inFlight(): FakeLog {
  const log = new FakeLog();
  log.add({ type: "run-started", graph: "parallel-review", inputs: { goal: "g" }, pinned_prompts: {} });
  log.add({ type: "node-started", node: "build", visit: 1, attempt_id: "build#1" });
  log.add({ type: "node-finished", node: "build", visit: 1, status: "succeeded", writes: { summary: "s" } });
  log.add({ type: "edge-taken", from: "build", to: "fan" });
  log.add({ type: "node-started", node: "fan", visit: 1, attempt_id: "fan#1" });
  for (const b of BRANCHES) {
    log.add({ type: "node-started", node: b, visit: 1, attempt_id: `${b}#1`, parallel: { node: "fan", visit: 1 } });
    log.add({
      type: "prompt-rendered", node: b, visit: 1, prompt: "doc.review", prompt_version: 1, rendered_hash: `h-${b}`,
      context_read: {}, harness: "claude", skills: [], output_keys: [], suffix_version: 1,
    } as never);
  }
  for (const b of BRANCHES) log.add({ type: "chunk", node: b, visit: 1, turn: 1, index: 0, kind: "text", content: `${b} looking` });
  return log;
}

/** ...then security and ux succeed, tests fails, and the run parks on tests */
function parkedOnTests(): FakeLog {
  const log = inFlight();
  log.add({ type: "node-finished", node: "review_tests", visit: 1, status: "failed", writes: {} });
  log.add({ type: "node-finished", node: "review_security", visit: 1, status: "succeeded", writes: { security: "pass" } });
  log.add({ type: "node-finished", node: "review_ux", visit: 1, status: "succeeded", writes: { ux: "pass" } });
  log.add({ type: "attention-raised", node: "review_tests", visit: 1, reason: "could not read the suite", code: "attempt-failed" });
  return log;
}

describe("deriveTimeline over a parallel step", () => {
  test("the branches are concurrent rows: a sibling's start never marks another row failed", () => {
    const rows = deriveTimeline(inFlight().events);
    expect(rows.map((r) => `${r.node}:${r.status}`)).toEqual(["build:succeeded", "fan:running", ...BRANCHES.map((b) => `${b}:running`)]);
    for (const r of rows.filter((r) => BRANCHES.includes(r.node))) expect(r.parallel).toEqual({ node: "fan", visit: 1 });
    expect(rows.find((r) => r.node === "build")!.parallel).toBeUndefined();
  });

  test("finished and failed branches keep their own status; the parallel step's row stays running", () => {
    const rows = deriveTimeline(parkedOnTests().events);
    expect(Object.fromEntries(rows.map((r) => [r.node, r.status]))).toEqual({
      build: "succeeded", fan: "running", review_security: "succeeded", review_tests: "failed", review_ux: "succeeded",
    });
  });

  test("the Steps pane groups the branches of one visit into one block", () => {
    const blocks = parallelBlocks(deriveTimeline(parkedOnTests().events));
    expect(blocks.map((b) => [b.group, b.rows.map(([t]) => t.node)])).toEqual([
      [null, ["build"]], [null, ["fan"]], ["fan@1", BRANCHES],
    ]);
  });
});

describe("Chat over a parallel step", () => {
  test("each branch's turn is its own labelled step, with only its own words beneath it", () => {
    const msgs = conversation(deriveDetail("r1", inFlight().events));
    const steps = msgs.filter((m) => m.kind === "step");
    expect(steps.map((m) => [m.node, m.parallel])).toEqual([
      ["build", undefined], ["fan", undefined], ...BRANCHES.map((b) => [b, "fan"]),
    ]);
    // the words that follow each branch's step header are that branch's, never a sibling's
    for (const b of BRANCHES) {
      const at = msgs.findIndex((m) => m.kind === "step" && m.node === b);
      const next = msgs.slice(at + 1).findIndex((m) => m.kind === "step");
      const mine = JSON.stringify(next === -1 ? msgs.slice(at + 1) : msgs.slice(at + 1, at + 1 + next));
      expect(mine).toContain(`${b} looking`);
      for (const other of BRANCHES.filter((o) => o !== b)) expect(mine).not.toContain(`${other} looking`);
    }
  });
});

describe("deriveStatus / replay over a parallel step", () => {
  test("parked on a branch: needs-input, the ask names the branch, and the failure keeps its reason", () => {
    const log = parkedOnTests();
    const s = deriveStatus(log.events);
    expect(s.status).toBe("needs-input");
    expect(s.ask).toMatchObject({ node: "review_tests", visit: 1, code: "attempt-failed" });
    expect(s.failure).toMatchObject({ node: "review_tests", visit: 1, reason: "could not read the suite" });
    const replayed = replayState(log.events);
    expect(replayed.position).toEqual({ node: "fan", midFlight: true });
    expect(replayed.parked).toMatchObject({ node: "review_tests" });
  });

  test("while branches run, the status is running and every branch turn reads live", () => {
    const d = deriveDetail("r", inFlight().events, {}, { runnerAlive: true });
    expect(d.summary.status).toBe("running");
    for (const b of BRANCHES) expect(d.turn_states[`${b}@1`]).toBe("live");
  });

  test("a dead runner: every unfinished branch turn died", () => {
    const d = deriveDetail("r", inFlight().events, {}, { runnerAlive: false });
    for (const b of BRANCHES) expect(d.turn_states[`${b}@1`]).toBe("died");
  });

  test("two branches ask mid-turn at once: both stand, the first is answered first, then the other", () => {
    const log = inFlight();
    log.add({ type: "attention-raised", node: "review_security", visit: 1, reason: "which env?", ask: {} });
    log.add({ type: "attention-raised", node: "review_ux", visit: 1, reason: "which screen?", ask: {} });
    expect(replayState(log.events).parked).toMatchObject({ node: "review_security" });
    expect(deriveStatus(log.events).ask).toMatchObject({ node: "review_security" });
    log.add({ type: "attention-resolved", node: "review_security", visit: 1, reply: "staging", source: "operator" });
    expect(replayState(log.events).parked).toMatchObject({ node: "review_ux" });
    expect(deriveStatus(log.events).ask).toMatchObject({ node: "review_ux" });
    // the turn waiting on its question reads waiting; the answered one is live again
    const d = deriveDetail("r", log.events, {}, { runnerAlive: true });
    expect(d.turn_states["review_ux@1"]).toBe("waiting");
    expect(d.turn_states["review_security@1"]).toBe("live");
    log.add({ type: "attention-resolved", node: "review_ux", visit: 1, reply: "login", source: "operator" });
    expect(replayState(log.events).parked).toBeNull();
  });

  test("an engine park (with a code) still replaces every standing ask — the sequential rule", () => {
    const log = new FakeLog();
    log.add({ type: "run-started", graph: "g", inputs: {}, pinned_prompts: {} });
    log.add({ type: "node-started", node: "do", visit: 1, attempt_id: "do#1" });
    log.add({ type: "attention-raised", node: "do", visit: 1, reason: "a question", ask: {} });
    log.add({ type: "node-finished", node: "do", visit: 1, status: "failed", writes: {} });
    log.add({ type: "attention-raised", node: "do", visit: 1, reason: "attempt failed", code: "attempt-failed" });
    expect(replayState(log.events).parked).toMatchObject({ code: "attempt-failed" });
    expect(deriveStatus(log.events).ask).toMatchObject({ code: "attempt-failed" });
  });
});

describe("steerTarget with several live turns", () => {
  test("no node: refused, naming the live branches; a node: that branch's turn", () => {
    const events = inFlight().events;
    const refused = steerTarget(events);
    expect(refused).toEqual({ ok: false, message: `3 steps are running at once (${BRANCHES.join(", ")}) — name one with --node` });
    expect(steerTarget(events, { node: "review_ux" })).toEqual({ ok: true, node: "review_ux", visit: 1 });
  });

  test("one branch left running: it is the target without naming it", () => {
    const log = inFlight();
    log.add({ type: "node-finished", node: "review_security", visit: 1, status: "succeeded", writes: {} });
    log.add({ type: "node-finished", node: "review_tests", visit: 1, status: "succeeded", writes: {} });
    expect(steerTarget(log.events)).toEqual({ ok: true, node: "review_ux", visit: 1 });
    expect(steerTarget(log.events, { node: "review_tests" })).toMatchObject({ ok: false, message: "review_tests@1 has finished — there is no live turn to steer" });
  });

  test("a sibling's mid-turn question does not hold this branch's turn", () => {
    const log = inFlight();
    log.add({ type: "attention-raised", node: "review_security", visit: 1, reason: "which env?", ask: {} });
    expect(steerTarget(log.events, { node: "review_ux" })).toEqual({ ok: true, node: "review_ux", visit: 1 });
    expect(steerTarget(log.events, { node: "review_security" })).toMatchObject({ ok: false });
  });
});
