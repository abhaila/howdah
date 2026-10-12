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
import { waiveCriterion } from "./acceptance-decision";
import { REPLY_RULES } from "./control";

type C = { goal: string; acceptance: unknown; summary: string };
const ok = (writes: Record<string, unknown> = {}): AttemptResult => ({ status: "succeeded", writes });
const row = (id: string, passes: boolean) => ({ id, text: `criterion ${id}`, source: "plan", passes, evidence: passes ? { kind: "verify.result" } : null });

function setup(reviewPasses: Record<string, boolean>) {
  const dir = mkdtempSync(join(tmpdir(), "howdah-acceptance-"));
  const prompts = mkdtempSync(join(tmpdir(), "howdah-acceptance-p-"));
  for (const id of ["doc.draft", "doc.review"])
    writeFileSync(join(prompts, `${id}.md`), `---\nid: ${id}\nversion: 1\n---\nDo {{ context.goal }}.\n`);
  const graph = defineGraph<C>({
    name: "gated", entry: "criteria", inputs: ["goal"],
    nodes: {
      criteria: { kind: "agent", prompt: "doc.draft", reads: ["goal"], writes: { acceptance: { scope: "sticky" } }, readOnly: true },
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
        if (nodeId === "criteria") return ok({ acceptance: Object.keys(reviewPasses).map((id) => row(id, false)) });
        if (nodeId === "review") return ok({ acceptance: Object.entries(reviewPasses).map(([id, p]) => row(id, p)) });
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
    expect((res as { reason: string }).reason).toContain('1 unmet — "ac-2" (criterion ac-2)');
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
