/**
 * HOW-78: a built-in graph gained an agent step (implementation.report) while runs of it were
 * still going, and "Map this change" — a jump into that step — parked on ENOENT: runs pin their
 * prompts at START, so the new step's prompt had never been pinned. resume() now pins exactly the
 * prompts the run never pinned, logs them as `prompts-pinned`, and leaves every existing pin alone.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineGraph } from "../core/graph";
import { Engine, type AttemptResult } from "./run";
import { reconstructRender } from "../prompts/library";
import { deriveDetail } from "../web/derive";

interface Ctx { goal: string; summary: string; change_map: unknown }

const ok = (writes: Record<string, unknown> = {}): AttemptResult => ({ status: "succeeded", writes });

function prompts(): string {
  const dir = mkdtempSync(join(tmpdir(), "howdah-late-pin-prompts-"));
  const write = (id: string, version: number, body: string) =>
    writeFileSync(join(dir, `${id}.md`), `---\nid: ${id}\nversion: ${version}\n---\n${body}`);
  write("implementation.implement", 1, "Implement {{ context.goal }}.\n");
  write("implementation.report", 1, "Map the change for {{ context.goal }}: {{ context.summary }}\n");
  return dir;
}

// the graph as the run started it, and the same graph after it gained a step
const before = () => defineGraph<Ctx>({
  name: "late-pin", entry: "implement", inputs: ["goal"],
  nodes: {
    implement: { kind: "agent", prompt: "implementation.implement", reads: ["goal"], writes: { summary: { scope: "sticky" } } },
    done: { kind: "terminal", outcome: "success" },
  },
  edges: [{ from: "implement", to: "done" }],
});
const after = () => defineGraph<Ctx>({
  name: "late-pin", entry: "implement", inputs: ["goal"],
  nodes: {
    implement: { kind: "agent", prompt: "implementation.implement", reads: ["goal"], writes: { summary: { scope: "sticky" } } },
    report: { kind: "agent", prompt: "implementation.report", reads: ["goal", "summary"], writes: { change_map: { scope: "sticky" } } },
    done: { kind: "terminal", outcome: "success" },
  },
  edges: [{ from: "implement", to: "report" }, { from: "report", to: "done" }],
});

test("a jump into a step the graph gained after the run started pins its prompt instead of parking on ENOENT", async () => {
  const dir = mkdtempSync(join(tmpdir(), "howdah-late-pin-run-"));
  const promptsDir = prompts();
  // the run parks inside its only step, as a run waiting on a human would
  const first = new Engine(before(), { dir, promptsDir, executors: { agent: async () => ({ status: "failed", writes: {} }) } });
  expect(await first.start({ goal: "g" })).toMatchObject({ state: "parked" });
  expect(existsSync(join(dir, "prompts", "implementation.report.md"))).toBe(false);

  // the repo moves on: the implement prompt is revised, and the graph gains `report`
  writeFileSync(join(promptsDir, "implementation.implement.md"), "---\nid: implementation.implement\nversion: 9\n---\nSomething else.\n");
  const pinnedImplement = readFileSync(join(dir, "prompts", "implementation.implement.md"), "utf8");

  const rendered: string[] = [];
  const second = new Engine(after(), {
    dir, promptsDir,
    executors: { agent: async ({ nodeId, renderedPrompt }) => { rendered.push(`${nodeId}: ${renderedPrompt ?? ""}`); return ok({ change_map: { title: "t" } }); } },
  });
  // the jump's target needs `summary`, which the parked run never wrote; seed it the way a real run would have
  second.log.append({ type: "node-started", node: "implement", visit: 2, attempt_id: "implement#2" });
  second.log.append({ type: "node-finished", node: "implement", visit: 2, status: "succeeded", writes: { summary: "built it" } });
  second.log.append({ type: "operator-jump", to: "report", reset_budgets: true });
  expect(await second.resume()).toEqual({ state: "finished", outcome: "success" });

  expect(rendered[0]).toStartWith("report: Map the change for g: built it");
  const events = second.log.read();
  // only the prompt the run never had is pinned, on the record, and the old pin is untouched
  expect(events.filter((e) => e.type === "prompts-pinned")).toEqual([expect.objectContaining({ pinned_prompts: { "implementation.report": 1 } })]);
  expect(readFileSync(join(dir, "prompts", "implementation.implement.md"), "utf8")).toBe(pinnedImplement);
  // and it reconstructs like any prompt pinned at start
  const render = events.find((e) => e.type === "prompt-rendered" && e.node === "report");
  expect(render?.type === "prompt-rendered" && reconstructRender(dir, render.rendered_hash)?.verified).toBe(true);
  expect(deriveDetail("r", events).pinned_prompts).toEqual({ "implementation.implement": 1, "implementation.report": 1 });

  // a second resume pins nothing more
  await new Engine(after(), { dir, promptsDir, executors: { agent: async () => ok() } }).resume();
  expect(readFileSync(join(dir, "run.jsonl"), "utf8").match(/"prompts-pinned"/g)).toHaveLength(1);
});
