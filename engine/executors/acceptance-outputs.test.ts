/**
 * HOW-51 — the outputs check over the fake wire: a criterion flipped without evidence is
 * REFUSED, the one repair turn names the problem, and a corrected flip is accepted; a repair
 * that is still wrong fails the attempt with the reason instead of publishing it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../run";
import { claudeExecutor } from "./claude";
import { checkWrites, stackedPublicationProblem } from "./outputs";
import { defineGraph } from "../../core/graph";
import { readLog } from "../../log/write";

const FAKE = join(import.meta.dir, "fake-claude.ts");
const ENV = ["FAKE_CLAUDE_SCRIPT", "FAKE_CLAUDE_REPAIR_OUTPUTS", "FAKE_CAPTURE", "FAKE_CLAUDE_ASK", "FAKE_CLAUDE_RATELIMIT"];
afterEach(() => { for (const k of ENV) delete process.env[k]; });

type C = { goal: string; acceptance: unknown };
const row = (over: object = {}) => ({ id: "ac-1", text: "the login form rejects a blank password", source: "ticket", passes: false, evidence: null, ...over });

function run(reviewFlip: object, repair?: object) {
  const dir = mkdtempSync(join(tmpdir(), "howdah-acc-out-"));
  const prompts = mkdtempSync(join(tmpdir(), "howdah-acc-out-p-"));
  for (const id of ["doc.draft", "doc.review"]) writeFileSync(join(prompts, `${id}.md`), `---\nid: ${id}\nversion: 1\n---\nDo {{ context.goal }}.\n`);
  const script = join(dir, "script.json");
  writeFileSync(script, JSON.stringify({ turns: [
    { match: "acceptance", outputs: { acceptance: [row()] } },          // the criteria step: default-FAIL
    { match: "acceptance", outputs: { acceptance: [row(reviewFlip)] } }, // the evaluator's first answer
  ] }));
  const capture = join(dir, "capture.jsonl");
  Object.assign(process.env, { FAKE_CLAUDE_SCRIPT: script, FAKE_CAPTURE: capture, FAKE_CLAUDE_ASK: "0", FAKE_CLAUDE_RATELIMIT: "0" });
  if (repair) process.env.FAKE_CLAUDE_REPAIR_OUTPUTS = JSON.stringify({ acceptance: [row(repair)] });
  const graph = defineGraph<C>({
    name: "acc", entry: "criteria", inputs: ["goal"],
    nodes: {
      criteria: { kind: "agent", prompt: "doc.draft", reads: ["goal"], writes: { acceptance: { scope: "sticky" } }, readOnly: true },
      review: { kind: "agent", prompt: "doc.review", reads: ["goal", "acceptance"], writes: { acceptance: { scope: "sticky" } }, readOnly: true },
      done: { kind: "terminal", outcome: "success" },
    },
    edges: [{ from: "criteria", to: "review" }, { from: "review", to: "done" }],
  });
  const engine = new Engine(graph, { dir, promptsDir: prompts, executors: { agent: claudeExecutor({ attentionDir: join(dir, "a"), binary: FAKE, askPollMs: 20, notifiers: [] }) } });
  return { engine, dir, capture, path: join(dir, "run.jsonl") };
}

const COMMAND = { kind: "command", command: "bun test login", output: "1 pass, 0 fail" };

describe("the outputs check on acceptance", () => {
  test("a flip with no evidence is refused, the repair names why, and a flip WITH evidence is accepted", async () => {
    const { engine, capture, path } = run({ passes: true }, { passes: true, evidence: COMMAND });
    expect(await engine.start({ goal: "fix login" })).toEqual({ state: "finished", outcome: "success" });
    const turns = readFileSync(capture, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string);
    const repair = turns.at(-1)!;
    expect(repair).toStartWith("Your outputs object was refused");
    expect(repair).toContain('criterion "ac-1" passes but names no evidence');
    const done = readLog(path).find((e) => e.type === "node-finished" && e.node === "review")!;
    expect(done).toMatchObject({ status: "succeeded", writes: { acceptance: [row({ passes: true, evidence: COMMAND })] } });
  }, 20_000);

  test("a flip with evidence is accepted first time — no repair turn", async () => {
    const { engine, capture } = run({ passes: true, evidence: COMMAND });
    expect(await engine.start({ goal: "fix login" })).toEqual({ state: "finished", outcome: "success" });
    expect(readFileSync(capture, "utf8").trim().split("\n")).toHaveLength(2); // two prompts, no repair
  }, 20_000);

  test("a repair that is still unsupported fails the attempt with the reason — it is never published", async () => {
    const { engine, path } = run({ passes: true }, { passes: true, evidence: { kind: "verify.result" } });
    const res = await engine.start({ goal: "fix login" });
    expect(res).toMatchObject({ state: "parked", node: "review" });
    expect((res as { reason: string }).reason).toContain("output contract violation: criterion \"ac-1\" cites verify.result, but the tests did not pass in this run");
    expect(readLog(path).find((e) => e.type === "node-finished" && e.node === "review")).toMatchObject({ status: "failed", writes: {} });
  }, 20_000);

  test("rewriting a criterion's text is refused like a missing flip", async () => {
    const { engine } = run({ text: "the login form exists" });
    const res = await engine.start({ goal: "fix login" });
    expect((res as { reason: string }).reason).toContain('criterion "ac-1" was reworded');
  }, 20_000);
});

describe("HOW-57 (G2): a stacked publish names only its own PRs, as an object", () => {
  const base = "https://github.com/acme/web/pull/1";
  const own = "https://github.com/acme/web/pull/2";
  const reads = { "deps.base": "howdah/p--fe-1", "deps.prs": [base] };

  test("an object naming this run's PR is accepted", () => {
    expect(checkWrites({ publication_summary: { pr_urls: [own], primary_pr_url: own } }, reads)).toBeNull();
  });

  test("prose is refused, saying what shape to use", () => {
    expect(stackedPublicationProblem({ publication_summary: `opened ${own} on top of ${base}` }, reads)).toBe(
      `publication_summary must be an object for a stacked change — { "pr_urls": [<this run's PR URLs>], "primary_pr_url": <its tip> } — not prose`,
    );
  });

  test("an object with no PR, or one listing the base's PR, is refused", () => {
    expect(stackedPublicationProblem({ publication_summary: { note: "pushed" } }, reads)).toContain("names no PR of this run");
    expect(stackedPublicationProblem({ publication_summary: { pr_urls: [base, own], primary_pr_url: own } }, reads)).toBe(
      `publication_summary lists ${base}, which belongs to a slice this one depends on — list only this run's own PRs`,
    );
  });

  test("a publish that did not read deps.base (implement-ticket's) is untouched — prose stays legal there", () => {
    expect(checkWrites({ publication_summary: `opened ${own}` }, { goal: "g" })).toBeNull();
  });

  test("once the base merged away (deps.base read, but empty) the rule still holds, and own PRs pass", () => {
    expect(stackedPublicationProblem({ publication_summary: { pr_urls: [own] } }, { "deps.base": "", "deps.prs": [base] })).toBeNull();
  });
});
