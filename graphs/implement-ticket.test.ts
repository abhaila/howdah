/**
 * implement-ticket loop bounds (system-map 0.3 / T5): every agent-driven review loop parks
 * with a maxVisits reason instead of spinning to maxSteps, and an operator jump after that
 * park gets a fresh budget — visit numbers keep climbing, because they are identity.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { implementTicket, type PrState } from "./implement-ticket";
import { Engine, type AttemptResult, type EngineOpts } from "../engine/run";
import type { LoggedEvent } from "../log/events";

const PROMPTS = join(dirname(import.meta.dir), "prompts");
const ok = (writes: Record<string, unknown> = {}): AttemptResult => ({ status: "succeeded", writes });

interface Script {
  localReview: () => "pass" | "reject";
  repairReview?: () => "pass" | "reject";
  pr?: () => PrState;
}

/** stub every executor kind; agent prompts are recorded per `node@visit` */
function engineFor(dir: string, script: Script, prompts: Map<string, string>, extra: Partial<EngineOpts> = {}): Engine {
  return new Engine(implementTicket, {
    dir,
    promptsDir: PROMPTS,
    ...extra,
    executors: {
      worktree: async ({ nodeId }) => ok(nodeId.startsWith("cleanup") ? { "worktree.clean": true } : {}),
      command: async () => ok({ "pr.state": script.pr?.() ?? "OPEN" }),
      wait: async () => ok(),
      agent: async ({ nodeId, visit, renderedPrompt }) => {
        prompts.set(`${nodeId}@${visit}`, renderedPrompt ?? "");
        switch (nodeId) {
          case "implementation.plan":
          case "implementation.plan_review":
            return ok({ implementation_plan: "plan" });
          case "implementation.implement":
          case "implementation.implement_review":
            return ok({ implementation_summary: "summary" });
          case "implementation.local_review":
            return ok({ review_verdict: script.localReview(), review_findings: ["nit"] });
          case "delivery.publish":
            return ok({ publication_summary: "pr opened" });
          case "delivery.review_repairs":
            return ok({ review_verdict: script.repairReview?.() ?? "pass", review_findings: ["nit"] });
          case "delivery.fix_ci":
          case "delivery.address_reviews":
          case "delivery.resolve_conflicts":
          case "delivery.revise_repairs":
            return ok({ repair_summary: "repaired" });
          case "complete_ticket":
            return ok({ completion_summary: "done" });
          default:
            throw new Error(`unexpected node ${nodeId}`);
        }
      },
    },
  });
}

const started = (events: LoggedEvent[], node: string): number[] =>
  events.flatMap((e) => (e.type === "node-started" && e.node === node ? [e.visit] : []));

function expectNoDuplicateAttempts(events: LoggedEvent[]): void {
  const ids = events.flatMap((e) => (e.type === "node-started" ? [`${e.node}@${e.visit}`] : []));
  expect(new Set(ids).size).toBe(ids.length);
}

const INPUTS = { goal: "fix the login bug", work: "TICKET-1" };
const tmp = () => mkdtempSync(join(tmpdir(), "howdah-it-"));

describe("implement-ticket loop bounds (system-map 0.3)", () => {
  test("an always-rejecting local reviewer parks the plan_review loop after 3 visits", async () => {
    const engine = engineFor(tmp(), { localReview: () => "reject" }, new Map());
    const result = await engine.start(INPUTS);
    expect(result).toMatchObject({ state: "parked", node: "implementation.plan_review" });
    expect((result as any).reason).toContain("maxVisits");
    expect(started(engine.log.read(), "implementation.plan_review")).toEqual([1, 2, 3]);
  });

  test("an always-rejecting repair reviewer parks review_repairs ⇄ revise_repairs after 3 revisions", async () => {
    const engine = engineFor(tmp(), { localReview: () => "pass", repairReview: () => "reject", pr: () => "CI_FAILED" }, new Map());
    const result = await engine.start(INPUTS);
    expect(result).toMatchObject({ state: "parked", node: "delivery.revise_repairs" });
    expect((result as any).reason).toContain("maxVisits");
    expect(started(engine.log.read(), "delivery.revise_repairs")).toEqual([1, 2, 3]);
  });

  test("CI that never goes green parks the repair → publish cycle after 5 publishes", async () => {
    const engine = engineFor(tmp(), { localReview: () => "pass", repairReview: () => "pass", pr: () => "CI_FAILED" }, new Map());
    const result = await engine.start(INPUTS);
    expect(result).toMatchObject({ state: "parked", node: "delivery.publish" });
    expect((result as any).reason).toContain("maxVisits");
    expect(started(engine.log.read(), "delivery.publish")).toEqual([1, 2, 3, 4, 5]);
  });

  test("the probe_pr ⇄ wait poll stays unbounded by maxVisits (it waits on a human reviewer)", async () => {
    const engine = engineFor(tmp(), { localReview: () => "pass", pr: () => "OPEN" }, new Map(), { maxSteps: 60 });
    const result = await engine.start(INPUTS);
    expect(result).toMatchObject({ state: "parked" });
    expect((result as any).reason).toContain("maxSteps");
    expect(started(engine.log.read(), "delivery.probe_pr").length).toBeGreaterThan(5);
  });
});

describe("jump after a maxVisits park (system-map 0.3 budget floors)", () => {
  const JUMP = "keep the plan to the auth module only";

  async function parkedOnPlanReview(dir: string): Promise<Engine> {
    const engine = engineFor(dir, { localReview: () => "reject" }, new Map());
    expect(await engine.start(INPUTS)).toMatchObject({ state: "parked", node: "implementation.plan_review" });
    // what `howdah jump` appends (the runner is dead), before it resumes
    engine.log.append({ type: "operator-jump", to: "implementation.plan_review", message: JUMP, reset_budgets: true });
    return engine;
  }

  test("the parked node runs again with the jump message, and the run makes progress to completion", async () => {
    const dir = tmp();
    await parkedOnPlanReview(dir);
    const prompts = new Map<string, string>();
    const resumed = engineFor(dir, { localReview: () => "pass", pr: () => "MERGED" }, prompts);
    expect(await resumed.resume()).toEqual({ state: "finished", outcome: "success" });

    const events = resumed.log.read();
    // visit numbers continue upward: 1..3 before the park, 4 after the jump
    expect(started(events, "implementation.plan_review")).toEqual([1, 2, 3, 4]);
    expect(prompts.get("implementation.plan_review@4")).toContain("## Operator instruction");
    expect(prompts.get("implementation.plan_review@4")).toContain(JUMP);
    expect(prompts.get("implementation.implement_review@4")).not.toContain(JUMP); // consumed once
    expectNoDuplicateAttempts(events);
  });

  test("the jump buys exactly a fresh maxVisits budget, then parks again", async () => {
    const dir = tmp();
    await parkedOnPlanReview(dir);
    const resumed = engineFor(dir, { localReview: () => "reject" }, new Map());
    const result = await resumed.resume();
    expect(result).toMatchObject({ state: "parked", node: "implementation.plan_review" });
    expect((result as any).reason).toContain("maxVisits");

    const events = resumed.log.read();
    expect(started(events, "implementation.plan_review")).toEqual([1, 2, 3, 4, 5, 6]);
    const parks = events.filter((e) => e.type === "attention-raised");
    expect(parks.map((e: any) => `${e.node}@${e.visit}`)).toEqual([
      "implementation.plan_review@4",
      "implementation.plan_review@7",
    ]);
    expectNoDuplicateAttempts(events);
  });
});
