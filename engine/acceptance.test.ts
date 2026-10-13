/**
 * HOW-51 — the delivery gate in the engine. A node that `requiresAcceptance` does not START while
 * a live criterion is unmet and unwaived; a plain resume re-checks and parks again (the gate reads
 * decision events, never `attention-resolved`); a waiver — and only a waiver — lets it through.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type AttemptResult } from "./run";
import { defineGraph } from "../core/graph";
import { readLog } from "../log/write";
import { waiveCriterion, waiveUnprovable } from "./acceptance-decision";
import { REPLY_RULES } from "./control";

type C = { goal: string; acceptance: unknown; summary: string; "verify.result": unknown };
const ok = (writes: Record<string, unknown> = {}): AttemptResult => ({ status: "succeeded", writes });
const row = (id: string, passes: boolean, check?: string) => ({ id, text: `criterion ${id}`, source: "plan", passes, evidence: passes ? { kind: "verify.result" } : null, ...(check ? { check } : {}) });

/** reviewPasses: id → passes; checks: id → HOW-59 check; verify: what verify:run published */
function setup(reviewPasses: Record<string, boolean>, checks: Record<string, string> = {}, verify?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "howdah-acceptance-"));
  const prompts = mkdtempSync(join(tmpdir(), "howdah-acceptance-p-"));
  for (const id of ["doc.draft", "doc.review"])
    writeFileSync(join(prompts, `${id}.md`), `---\nid: ${id}\nversion: 1\n---\nDo {{ context.goal }}.\n`);
  const graph = defineGraph<C>({
    name: "gated", entry: "criteria", inputs: ["goal"],
    nodes: {
      criteria: { kind: "agent", prompt: "doc.draft", reads: ["goal"], writes: { acceptance: { scope: "sticky" }, "verify.result": { scope: "sticky" } }, readOnly: true },
      review: { kind: "agent", prompt: "doc.review", reads: ["goal", "acceptance"], writes: { acceptance: { scope: "sticky" } }, readOnly: true },
      publish: { kind: "agent", prompt: "doc.draft", reads: ["goal", "acceptance"], writes: { summary: { scope: "sticky" } }, requiresAcceptance: true },
      done: { kind: "terminal", outcome: "success" },
    },
    edges: [{ from: "criteria", to: "review" }, { from: "review", to: "publish" }, { from: "publish", to: "done" }],
  });
  const ran: string[] = [];
  const engine = () => new Engine(graph, {
    dir, promptsDir: prompts,
    executors: {
      agent: async ({ nodeId }) => {
        ran.push(nodeId);
        if (nodeId === "criteria") return ok({ acceptance: Object.keys(reviewPasses).map((id) => row(id, false, checks[id])), "verify.result": verify ?? { outcome: "pass" } });
        if (nodeId === "review") return ok({ acceptance: Object.entries(reviewPasses).map(([id, p]) => row(id, p, checks[id])) });
        return ok({ summary: "published" });
      },
    },
  });
  return { dir, engine, ran, path: join(dir, "run.jsonl") };
}

describe("the acceptance gate", () => {
  test("delivery is refused while a criterion is false — before it starts, so no visit is spent", async () => {
    const { engine, ran, path } = setup({ "ac-1": true, "ac-2": false });
    const res = await engine().start({ goal: "g" });
    expect(res).toMatchObject({ state: "parked", node: "publish", code: "acceptance-unmet" });
    expect((res as { reason: string }).reason).toContain('1 not met yet — "ac-2" (criterion ac-2)');
    expect(ran).toEqual(["criteria", "review"]);
    expect(readLog(path).some((e) => e.type === "node-started" && e.node === "publish")).toBe(false);
  });

  test("a plain resume does NOT let it through — the park is re-checked, not trusted", async () => {
    const { engine, ran } = setup({ "ac-1": false });
    await engine().start({ goal: "g" });
    const again = await engine().resume(); // a fresh process: replay reaches the same decision
    expect(again).toMatchObject({ state: "parked", code: "acceptance-unmet" });
    expect(ran).not.toContain("publish");
  });

  test("a reply cannot fix it either — it is refused with the verbs that can", () => {
    const rule = REPLY_RULES["acceptance-unmet"]({ run: "r1", node: "publish" } as never);
    expect(rule.accept).toBe(false);
    expect((rule as { message: string }).message).toContain("`waive r1 <criterion-id> <reason>`");
    expect((rule as { message: string }).message).toContain("`waive r1 --unprovable <reason>`");
    expect((rule as { message: string }).message).toContain("`jump r1 implementation.local_review`");
  });

  test("after a waiver decision event, delivery runs", async () => {
    const { engine, ran, dir, path } = setup({ "ac-1": true, "ac-2": false });
    await engine().start({ goal: "g" });
    expect(waiveCriterion(dir, "ac-2", "")).toMatchObject({ ok: false, message: expect.stringContaining("needs a reason") });
    expect(waiveCriterion(dir, "ac-1", "x")).toMatchObject({ ok: false, message: expect.stringContaining("already passes") });
    expect(waiveCriterion(dir, "nope", "x")).toMatchObject({ ok: false, message: expect.stringContaining("no criterion \"nope\"") });
    expect(waiveCriterion(dir, "ac-2", "a judgement call, checked by eye")).toEqual({ ok: true, appended: true, remaining: 0 });
    expect(waiveCriterion(dir, "ac-2", "again")).toEqual({ ok: true, appended: false, remaining: 0 }); // idempotent
    expect(await engine().resume()).toEqual({ state: "finished", outcome: "success" });
    expect(ran.at(-1)).toBe("publish");
    expect(readLog(path).filter((e) => e.type === "acceptance-waived")).toHaveLength(1);
  });

  test("an empty contract has nothing unmet, so the gate opens (the outputs check refuses an empty FIRST list)", async () => {
    const { engine } = setup({});
    expect(await engine().start({ goal: "g" })).toEqual({ state: "finished", outcome: "success" });
  });
});

describe("HOW-59: what this run cannot prove is one decision, not a loop", () => {
  const notRun = { outcome: "not-checked", reason: "no verify command is configured" };

  test("an after-publish criterion does not hold publication", async () => {
    const { engine, ran } = setup({ "ac-1": true, "ac-2": false }, { "ac-2": "after-publish" });
    expect(await engine().start({ goal: "g" })).toEqual({ state: "finished", outcome: "success" });
    expect(ran.at(-1)).toBe("publish");
  });

  test("the park names what this run cannot prove, and why, apart from what is merely not met", async () => {
    const { engine } = setup({ "ac-1": false, "ac-2": false, "ac-3": false }, { "ac-1": "tests", "ac-2": "human", "ac-3": "command" }, notRun);
    const res = await engine().start({ goal: "g" });
    const reason = (res as { reason: string }).reason;
    expect(reason).toContain("3 unmet.");
    expect(reason).toContain('2 this run cannot prove — "ac-1" (criterion ac-1): it needs the tests, and the tests were never run (no verify command is configured)');
    expect(reason).toContain('"ac-2" (criterion ac-2): only a human can judge it');
    expect(reason).toContain("--unprovable");
    expect(reason).toContain('1 not met yet — "ac-3" (criterion ac-3)');
  });

  test("a test criterion whose tests DID run is not unprovable — a red suite is a real failure", async () => {
    const { engine } = setup({ "ac-1": false }, { "ac-1": "tests" }, { outcome: "fail" });
    const reason = ((await engine().start({ goal: "g" })) as { reason: string }).reason;
    expect(reason).not.toContain("cannot prove");
    expect(reason).toContain("1 not met yet");
  });

  test("one waiver settles every unprovable row together, never a merely-unmet one", async () => {
    const { engine, dir, path } = setup({ "ac-1": false, "ac-2": false, "ac-3": false }, { "ac-1": "tests", "ac-2": "human", "ac-3": "command" }, notRun);
    await engine().start({ goal: "g" });
    expect(waiveUnprovable(dir, " ")).toMatchObject({ ok: false, message: expect.stringContaining("needs a reason") });
    expect(waiveUnprovable(dir, "no test command on this repo yet")).toEqual({ ok: true, waived: ["ac-1", "ac-2"], remaining: 1 });
    const waivers = readLog(path).filter((e) => e.type === "acceptance-waived");
    expect(waivers.map((e) => e.type === "acceptance-waived" && e.criterion_id)).toEqual(["ac-1", "ac-2"]);
    // consecutive: one append, all or none
    expect(waivers[1]!.seq).toBe(waivers[0]!.seq + 1);
    expect(waiveUnprovable(dir, "again")).toMatchObject({ ok: false, message: expect.stringContaining("no unmet criterion is unprovable") });
    expect(await engine().resume()).toMatchObject({ state: "parked", code: "acceptance-unmet" }); // ac-3 still holds it
    expect(waiveCriterion(dir, "ac-3", "checked by hand")).toMatchObject({ ok: true, remaining: 0 });
    expect(await engine().resume()).toEqual({ state: "finished", outcome: "success" });
  });

  test("a row with no check (a run pinned before HOW-59) is gated exactly as before", async () => {
    const { engine } = setup({ "ac-1": false }, {}, notRun);
    const reason = ((await engine().start({ goal: "g" })) as { reason: string }).reason;
    expect(reason).toContain('1 not met yet — "ac-1"');
  });
});
