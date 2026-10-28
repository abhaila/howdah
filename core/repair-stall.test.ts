/**
 * HOW-75 — when a probe's demand is a REPEAT of the repair that just changed nothing. The engine
 * test (graphs/delivery-no-change.test.ts) drives it through a real run; these pin the edges.
 */
import { describe, expect, test } from "bun:test";
import { repairStall } from "./repair-stall";

const PROBE = "delivery.probe_pr";
const fin = (node: string, visit: number, writes: Record<string, unknown>, status = "succeeded") => ({ type: "node-finished", node, visit, status, writes });
/** probe@1 asked for a review repair, address_reviews@1 ran, repair_check said `changed` */
const cycle = (changed: boolean, state = "CHANGES_REQUIRED") => [
  fin(PROBE, 1, { "pr.state": state }),
  fin("delivery.address_reviews", 1, { repair_summary: "x" }),
  fin("delivery.repair_check", 1, { "repair.changed": changed }),
  fin("delivery.wait", 1, {}),
];

describe("repairStall", () => {
  test("same state, a repair that changed nothing, nothing new → stalled, naming the repair", () => {
    expect(repairStall(cycle(false), PROBE, 2, "CHANGES_REQUIRED", false)).toEqual({ previousVisit: 1, repair: { node: "delivery.address_reviews", visit: 1 } });
  });
  test("new input on the PR is never a stall", () => {
    expect(repairStall(cycle(false), PROBE, 2, "CHANGES_REQUIRED", true)).toBeNull();
  });
  test("a different state is a different demand", () => {
    expect(repairStall(cycle(false), PROBE, 2, "CI_FAILED", false)).toBeNull();
    expect(repairStall(cycle(false, "CI_FAILED"), PROBE, 2, "CHANGES_REQUIRED", false)).toBeNull();
  });
  test("a repair that changed something is not a stall (the publish carries it)", () => {
    expect(repairStall(cycle(true), PROBE, 2, "CHANGES_REQUIRED", false)).toBeNull();
  });
  test("the first probe has nothing to repeat, and states with no repair never stall", () => {
    expect(repairStall([], PROBE, 1, "CHANGES_REQUIRED", false)).toBeNull();
    expect(repairStall(cycle(false, "OPEN"), PROBE, 2, "OPEN", false)).toBeNull();
  });
  test("no repair check since the previous probe (an OPEN poll in between) is not a stall", () => {
    const events = [...cycle(false), fin(PROBE, 2, { "pr.state": "CHANGES_REQUIRED" })];
    expect(repairStall(events, PROBE, 3, "CHANGES_REQUIRED", false)).toBeNull();
  });
  test("a failed (stalled) probe visit is skipped: Retry this step with nothing new parks again", () => {
    const events = [...cycle(false), fin(PROBE, 2, {}, "failed")];
    expect(repairStall(events, PROBE, 3, "CHANGES_REQUIRED", false)?.previousVisit).toBe(1);
  });
});
