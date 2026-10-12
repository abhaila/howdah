/**
 * HOW-53 — a read-only step over the fake wire. Spiked against claude 2.1.296
 * (adapter/fixtures/claude-plan-mode-*.jsonl): plan mode runs `git diff` and Read, but it does
 * NOT refuse an Edit — it asks the permission-prompt tool, i.e. Howdah. So the refusal that makes
 * `readOnly` real is the executor's, and it must never become a question for the operator.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../run";
import { claudeExecutor } from "./claude";
import { defineGraph } from "../../core/graph";
import { readLog } from "../../log/write";

const FAKE = join(import.meta.dir, "fake-claude.ts");
const ENV = ["FAKE_CLAUDE_TRY_EDIT", "FAKE_CLAUDE_TRY_EXIT_PLAN", "FAKE_CAPTURE_ARGV", "FAKE_CLAUDE_ASK", "FAKE_CLAUDE_RATELIMIT"];
afterEach(() => { for (const k of ENV) delete process.env[k]; });

function run(readOnly: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "howdah-readonly-"));
  const work = mkdtempSync(join(tmpdir(), "howdah-readonly-wt-"));
  const prompts = mkdtempSync(join(tmpdir(), "howdah-readonly-p-"));
  writeFileSync(join(prompts, "doc.review.md"), `---\nid: doc.review\nversion: 1\n---\nReview {{ context.goal }}.\n`);
  const argv = join(dir, "argv.jsonl");
  Object.assign(process.env, { FAKE_CLAUDE_TRY_EDIT: "1", FAKE_CLAUDE_TRY_EXIT_PLAN: "1", FAKE_CAPTURE_ARGV: argv, FAKE_CLAUDE_ASK: "0", FAKE_CLAUDE_RATELIMIT: "0" });
  const graph = defineGraph<{ goal: string; review_verdict: string }>({
    name: "ro", entry: "review", inputs: ["goal"],
    nodes: {
      review: { kind: "agent", prompt: "doc.review", reads: ["goal"], writes: { review_verdict: { scope: "cleared" } }, ...(readOnly ? { readOnly: true as const } : {}) },
      done: { kind: "terminal", outcome: "success" },
    },
    edges: [{ from: "review", to: "done" }],
  });
  const engine = new Engine(graph, { dir, promptsDir: prompts, cwd: work, executors: { agent: claudeExecutor({ attentionDir: join(dir, "a"), binary: FAKE, askPollMs: 20, notifiers: [] }) } });
  return { engine, dir, work, argv, path: join(dir, "run.jsonl") };
}

describe("a read-only reviewer", () => {
  test("runs in plan mode; its Edit and ExitPlanMode are refused by the harness — never asked of the operator — and nothing changes", async () => {
    const { engine, work, argv, path } = run(true);
    expect(await engine.start({ goal: "the change" })).toEqual({ state: "finished", outcome: "success" });
    const args = JSON.parse(readFileSync(argv, "utf8").trim().split("\n")[0]!) as string[];
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    const events = readLog(path);
    expect(events.some((e) => e.type === "attention-raised")).toBe(false); // nobody was asked
    expect(existsSync(join(work, "edited.txt"))).toBe(false); // the edit never happened
    const refusals = events.filter((e) => e.type === "chunk" && e.kind === "tool_result" && e.content.startsWith("refused:")).map((e: any) => e.content);
    expect(refusals).toEqual(["refused: Edit — this step is read-only", "refused: ExitPlanMode — this step is read-only"]);
  }, 20_000);

  test("a WRITING step still puts the same permission to the operator, as before", async () => {
    const { engine, path } = run(false);
    const running = engine.start({ goal: "the change" });
    for (let i = 0; i < 200 && !readLog(path).some((e) => e.type === "attention-raised"); i++) await Bun.sleep(20);
    expect(readLog(path).find((e) => e.type === "attention-raised")).toMatchObject({ reason: "Edit needs permission" });
    const { EventLog } = await import("../../log/write");
    const ask = readLog(path).find((e) => e.type === "attention-raised")!;
    new EventLog(path).append({ type: "attention-resolved", node: "review", visit: 1, reply: "deny", source: "operator" });
    for (let i = 0; i < 200 && readLog(path).filter((e) => e.type === "attention-raised").length < 2; i++) await Bun.sleep(20);
    new EventLog(path).append({ type: "attention-resolved", node: "review", visit: 1, reply: "deny", source: "operator" });
    await running;
    expect(ask.seq).toBeGreaterThan(0);
  }, 20_000);
});
