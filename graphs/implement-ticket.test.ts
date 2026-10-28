/**
 * implement-ticket loop bounds (system-map 0.3 / T5): every agent-driven review loop parks
 * with a maxVisits reason instead of spinning to maxSteps, and an operator jump after that
 * park gets a fresh budget — visit numbers keep climbing, because they are identity.
 * Each park is asserted by its code (system-map 0.2), not only its reason text.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { implementTicket, spec, type PrState } from "./implement-ticket";
import { buildGraph, type GraphSpec } from "../core/graph-spec";
import { Engine, type AttemptResult, type EngineOpts } from "../engine/run";
import type { LoggedEvent } from "../log/events";
import type { VerifyResult } from "../core/verify";

const VERIFY_PASS: VerifyResult = { outcome: "pass", command: "bun test", exit_code: 0, commit: "abc123", dirty: false, output_tail: "12 pass" };

const PROMPTS = join(dirname(import.meta.dir), "prompts");
const ok = (writes: Record<string, unknown> = {}): AttemptResult => ({ status: "succeeded", writes });

interface Script {
  localReview: () => "pass" | "reject";
  /** HOW-40: what verify.run publishes (default: a pass) */
  verify?: () => VerifyResult;
  /** HOW-51: does the reviewer flip the criterion? default yes */
  flips?: boolean;
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
      worktree: async ({ nodeId }) => ok(nodeId.startsWith("cleanup") ? { "worktree.clean": true } : { "worktree.verify_command": "", "worktree.preview_paths": "" }),
      // verify, the evidence capture, the repair check and the probe are the command steps; each
      // publishes its own fact. HOW-75: every stubbed repair "changed" something, so the loops
      // below go round through review_repairs and publish as they always did
      command: async ({ nodeId }) =>
        nodeId === "delivery.repair_check"
          ? ok({ "repair.changed": true })
          : nodeId === "verify.run"
          ? ok({ "verify.result": script.verify?.() ?? VERIFY_PASS })
          : nodeId === "implementation.evidence"
          ? ok({ "evidence.items": { outcome: "not-checked", items: [], reason: "stub" } })
          : ok({ "pr.state": script.pr?.() ?? "OPEN" }),
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
          case "implementation.criteria":
            return ok({ acceptance: [{ id: "ac-1", text: "the bug is fixed", source: "plan", passes: false, evidence: null }] });
          case "implementation.local_review":
            // a passing review flips the one criterion on the (stubbed) passing tests
            return ok({
              review_verdict: script.localReview(), review_findings: ["nit"],
              acceptance: [script.flips === false
                ? { id: "ac-1", text: "the bug is fixed", source: "plan", passes: false, evidence: null }
                : { id: "ac-1", text: "the bug is fixed", source: "plan", passes: true, evidence: { kind: "verify.result" } }],
            });
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

const lastPark = (events: LoggedEvent[]) => events.filter((e) => e.type === "attention-raised").at(-1);

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
    expect(result).toMatchObject({ state: "parked", node: "implementation.plan_review", code: "max-visits" });
    expect((result as any).reason).toContain("maxVisits");
    expect(lastPark(engine.log.read())).toMatchObject({ node: "implementation.plan_review", code: "max-visits" });
    expect(started(engine.log.read(), "implementation.plan_review")).toEqual([1, 2, 3]);
  });

  test("an always-rejecting repair reviewer parks review_repairs ⇄ revise_repairs after 3 revisions", async () => {
    const engine = engineFor(tmp(), { localReview: () => "pass", repairReview: () => "reject", pr: () => "CI_FAILED" }, new Map());
    const result = await engine.start(INPUTS);
    expect(result).toMatchObject({ state: "parked", node: "delivery.revise_repairs", code: "max-visits" });
    expect((result as any).reason).toContain("maxVisits");
    expect(lastPark(engine.log.read())).toMatchObject({ node: "delivery.revise_repairs", code: "max-visits" });
    expect(started(engine.log.read(), "delivery.revise_repairs")).toEqual([1, 2, 3]);
  });

  test("CI that never goes green parks the repair → publish cycle after 5 publishes", async () => {
    const engine = engineFor(tmp(), { localReview: () => "pass", repairReview: () => "pass", pr: () => "CI_FAILED" }, new Map());
    const result = await engine.start(INPUTS);
    expect(result).toMatchObject({ state: "parked", node: "delivery.publish", code: "max-visits" });
    expect((result as any).reason).toContain("maxVisits");
    expect(lastPark(engine.log.read())).toMatchObject({ node: "delivery.publish", code: "max-visits" });
    expect(started(engine.log.read(), "delivery.publish")).toEqual([1, 2, 3, 4, 5]);
  });

  test("the probe_pr ⇄ wait poll stays unbounded by maxVisits (it waits on a human reviewer)", async () => {
    const engine = engineFor(tmp(), { localReview: () => "pass", pr: () => "OPEN" }, new Map(), { maxSteps: 60 });
    const result = await engine.start(INPUTS);
    expect(result).toMatchObject({ state: "parked", code: "max-steps" });
    expect((result as any).reason).toContain("maxSteps");
    expect(started(engine.log.read(), "delivery.probe_pr").length).toBeGreaterThan(5);
  });
});

describe("jump after a maxVisits park (system-map 0.3 budget floors)", () => {
  const JUMP = "keep the plan to the auth module only";

  async function parkedOnPlanReview(dir: string): Promise<Engine> {
    const engine = engineFor(dir, { localReview: () => "reject" }, new Map());
    expect(await engine.start(INPUTS)).toMatchObject({ state: "parked", node: "implementation.plan_review", code: "max-visits" });
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
    expect(result).toMatchObject({ state: "parked", node: "implementation.plan_review", code: "max-visits" });
    expect((result as any).reason).toContain("maxVisits");

    const events = resumed.log.read();
    expect(started(events, "implementation.plan_review")).toEqual([1, 2, 3, 4, 5, 6]);
    const parks = events.filter((e) => e.type === "attention-raised");
    expect(parks.map((e: any) => `${e.node}@${e.visit}:${e.code}`)).toEqual([
      "implementation.plan_review@4:max-visits",
      "implementation.plan_review@7:max-visits",
    ]);
    expectNoDuplicateAttempts(events);
  });
});

/**
 * HOW-40: implement-ticket never ran verify:run, so its reviewer judged only the agent's own
 * claims about which checks it ran. Now every implementation pass is followed by verify.run,
 * and the reviewer reads `verify.result` through the partial implement-slice's reviewer uses.
 */
describe("implement-ticket runs verify:run before its review (HOW-40)", () => {
  test("the graph validates, and the validator proves verify.result is written on every path to the review", () => {
    const clean = implementTicket.validate();
    expect([...clean.structural, ...clean.paths]).toEqual([]);
    const withoutVerify: GraphSpec = {
      ...spec,
      nodes: spec.nodes.filter((n) => n.id !== "verify.run"),
      edges: spec.edges
        .filter((e) => e.from !== "verify.run")
        .map((e) => (e.to === "verify.run" ? { ...e, to: "implementation.local_review" } : e)),
    };
    // the MUST-analysis names the read and the path that reaches it unwritten
    expect(buildGraph(withoutVerify).validate().paths).toContainEqual(
      expect.objectContaining({ node: "implementation.local_review", key: "verify.result" }),
    );
  });

  const cases: Array<[string, VerifyResult]> = [
    ["pass", VERIFY_PASS],
    ["fail", { outcome: "fail", command: "bun test", exit_code: 1, output_tail: "1 fail" }],
    ["not-checked", { outcome: "not-checked", output_tail: "", reason: "workspace \"w\" has no verifyCommand" }],
  ];
  for (const [label, verify] of cases) {
    test(`a ${label} verify result reaches local_review, which reads it`, async () => {
      const prompts = new Map<string, string>();
      const engine = engineFor(tmp(), { localReview: () => "pass", pr: () => "MERGED", verify: () => verify }, prompts);
      expect(await engine.start(INPUTS)).toEqual({ state: "finished", outcome: "success" });
      const events = engine.log.read();
      const order = events.flatMap((e) => (e.type === "node-started" ? [e.node] : []));
      expect(order.slice(0, 7)).toEqual(["create_worktree", "implementation.plan", "implementation.criteria", "implementation.implement", "verify.run", "implementation.evidence", "implementation.local_review"]);
      const review = events.find((e) => e.type === "prompt-rendered" && e.node === "implementation.local_review");
      expect(review?.type === "prompt-rendered" && review.context_read["verify.result"]).toEqual(verify);
      expect(prompts.get("implementation.local_review@1")).toContain(`"outcome":"${label}"`);
      expect(prompts.get("implementation.local_review@1")).toContain("## Behaviour: the workspace's tests");
    });
  }

  test("an implement_review repair is re-verified before the review sees it again", async () => {
    let reviews = 0;
    const engine = engineFor(tmp(), { localReview: () => (reviews++ === 0 ? "reject" : "pass"), pr: () => "MERGED" }, new Map());
    expect(await engine.start(INPUTS)).toEqual({ state: "finished", outcome: "success" });
    expect(started(engine.log.read(), "verify.run")).toEqual([1, 2]);
  });

  test("both reviewer prompts include the same partial, and the run pins it", async () => {
    const engine = engineFor(tmp(), { localReview: () => "pass", pr: () => "MERGED" }, new Map());
    await engine.start(INPUTS);
    const startedEv = engine.log.read().find((e) => e.type === "run-started");
    expect(startedEv?.type === "run-started" && startedEv.pinned_includes?.["ticket.local_review"]).toMatchObject({ "review._verify_result": 1 });
    const raw = (id: string) => readFileSync(join(PROMPTS, `${id}.md`), "utf8");
    for (const id of ["implementation.local_review", "ticket.local_review", "slice.local_review"]) {
      expect(raw(id)).toContain("{{> review._verify_result }}");
      expect(raw(id)).not.toContain("{{ context.verify.result }}"); // only the partial carries it
    }
  });
});

describe("implement-ticket's acceptance gate (HOW-51)", () => {
  test("a review that PASSES but leaves a criterion unmet is still held before delivery.publish", async () => {
    const engine = engineFor(tmp(), { localReview: () => "pass", flips: false }, new Map());
    const result = await engine.start(INPUTS);
    expect(result).toMatchObject({ state: "parked", node: "delivery.publish", code: "acceptance-unmet" });
    expect(started(engine.log.read(), "delivery.publish")).toEqual([]);
  });

  test("the criteria step runs once, after the plan and before any code", async () => {
    const engine = engineFor(tmp(), { localReview: () => "pass" }, new Map());
    await engine.start(INPUTS);
    const order = engine.log.read().flatMap((e) => (e.type === "node-started" ? [e.node] : []));
    expect(order.slice(0, 7)).toEqual([
      "create_worktree", "implementation.plan", "implementation.criteria", "implementation.implement",
      "verify.run", "implementation.evidence", "implementation.local_review",
    ]);
    expect(order.filter((n) => n === "implementation.criteria")).toHaveLength(1);
  });
});
