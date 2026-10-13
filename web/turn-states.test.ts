/**
 * HOW-46 — whether a step's agent turn is live, waiting, or died is decided ONCE, in the read
 * model. The bug this pins: a turn streaming on a live runner was labelled "the process died
 * inside this turn", under every running step, at exactly the moment someone was watching.
 */
import { describe, expect, test } from "bun:test";
import { deriveDetail } from "./derive";
import { FakeLog } from "./slice.fixtures";

/** a run whose step `do@1` has said something and not finalised its turn */
function streaming(): FakeLog {
  const log = new FakeLog();
  log.add({ type: "run-started", graph: "quick-task", inputs: { goal: "g" }, pinned_prompts: {} });
  log.add({ type: "node-started", node: "do", visit: 1, attempt_id: "do#1" });
  log.add({ type: "chunk", node: "do", visit: 1, turn: 1, index: 0, kind: "text", content: "half a thou" });
  return log;
}

describe("deriveTurnStates", () => {
  test("live runner + un-finalised turn → live", () => {
    const d = deriveDetail("r", streaming().events, {}, { runnerAlive: true });
    expect(d.turn_states["do@1"]).toBe("live");
  });

  test("dead runner + un-finalised turn → died", () => {
    const d = deriveDetail("r", streaming().events, {}, { runnerAlive: false });
    expect(d.turn_states["do@1"]).toBe("died");
  });

  test("an unknown runner is not evidence of a death: a running run reads live", () => {
    expect(deriveDetail("r", streaming().events).turn_states["do@1"]).toBe("live");
  });

  test("finished run + un-finalised turn → died", () => {
    const log = streaming();
    log.add({ type: "node-finished", node: "do", visit: 1, status: "failed", writes: {} });
    log.add({ type: "run-finished", outcome: "failed" });
    expect(deriveDetail("r", log.events, {}, { runnerAlive: false }).turn_states["do@1"]).toBe("died");
  });

  test("a paused run's interrupted turn → died, even if a runner is somehow still recorded alive", () => {
    const log = streaming();
    log.add({ type: "run-paused", by: "operator" });
    expect(deriveDetail("r", log.events, {}, { runnerAlive: true }).turn_states["do@1"]).toBe("died");
  });

  test("parked on a mid-turn ask → waiting (the HOW-25 regression stays pinned)", () => {
    const log = streaming();
    log.add({
      type: "attention-raised", node: "do", visit: 1, reason: "Which?",
      ask: { kind: "user-question", request_id: "q", tool_name: "AskUserQuestion", questions: [] },
    });
    // the runner is alive and holding the session open while awaitOperator waits
    expect(deriveDetail("r", log.events, {}, { runnerAlive: true }).turn_states["do@1"]).toBe("waiting");
    // and a permission ask (no code) holds it open the same way
    const perm = streaming();
    perm.add({ type: "attention-raised", node: "do", visit: 1, reason: "Write needs permission", ask: { kind: "can_use_tool" } });
    expect(deriveDetail("r", perm.events, {}, { runnerAlive: true }).turn_states["do@1"]).toBe("waiting");
  });

  test("an engine park after the step FAILED is not a wait: the turn died", () => {
    const log = streaming();
    log.add({ type: "node-finished", node: "do", visit: 1, status: "failed", writes: {} });
    log.add({ type: "attention-raised", node: "do", visit: 1, reason: "attempt failed", code: "attempt-failed" });
    expect(deriveDetail("r", log.events, {}, { runnerAlive: true }).turn_states["do@1"]).toBe("died");
  });

  test("un-finalised turn on an earlier visit while a later visit runs → died", () => {
    const log = streaming();
    log.add({ type: "node-started", node: "do", visit: 2, attempt_id: "do#2" });
    log.add({ type: "chunk", node: "do", visit: 2, turn: 1, index: 0, kind: "text", content: "again" });
    const d = deriveDetail("r", log.events, {}, { runnerAlive: true });
    expect(d.turn_states["do@1"]).toBe("died");
    expect(d.turn_states["do@2"]).toBe("live");
  });

  test("a finalised turn → done; a step with no turn has no entry", () => {
    const log = streaming();
    log.add({ type: "turn-finalized", node: "do", visit: 1, turn: 1 });
    log.add({ type: "node-finished", node: "do", visit: 1, status: "succeeded", writes: {} });
    log.add({ type: "node-started", node: "wt", visit: 1, attempt_id: "wt#1" });
    const d = deriveDetail("r", log.events, {}, { runnerAlive: true });
    expect(d.turn_states["do@1"]).toBe("done");
    expect(d.turn_states["wt@1"]).toBeUndefined();
  });

  test("last_agent_event_at is the newest chunk or turn boundary, not the newest event", () => {
    const log = streaming();
    const chunkTs = log.last.ts;
    log.add({ type: "reconciled", node: "do", git: { repo: true, branch: "b", head: "h", uncommitted: 0, unpushed: 0 }, disagreements: [] });
    expect(deriveDetail("r", log.events).last_agent_event_at).toBe(chunkTs);
    expect(deriveDetail("r", new FakeLog().events).last_agent_event_at).toBeNull();
  });
});
