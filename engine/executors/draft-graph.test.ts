/**
 * HOW-64 (HOW-56 T5; decisions 1A, 6A, E) — the draft-graph run over the fake wire: a clean
 * draft is published, a refused one is repaired in the same session, one refused twice parks
 * quoting every problem word for word, and a reply re-runs the step in a FRESH session. Plus the
 * outputs dispatch itself, which fails CLOSED without a catalog or a prompt reader.
 *
 * The real `draftGraph` runs, with a command executor that publishes a fixed catalog
 * (core/fixtures/graph-draft.ts) — graphs:catalog itself is pinned in catalog.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type Executor } from "../run";
import { claudeExecutor } from "./claude";
import { checkWrites, graphDraftProblem } from "./outputs";
import { liveExecutors } from "./index";
import { draftGraph } from "../../graphs/draft-graph";
import { GRAPHS } from "../../graphs/index";
import { defineGraph } from "../../core/graph";
import { resolveReply } from "../control";
import { readLog } from "../../log/write";
import { CATALOG, EDGE_CASES, cleanDraft, materialiseFake, renamed } from "../../core/fixtures/graph-draft";

const FAKE = join(import.meta.dir, "fake-claude.ts");
const PROMPTS = join(import.meta.dir, "..", "..", "prompts");
const ENV = ["FAKE_CLAUDE_SCRIPT", "FAKE_CLAUDE_REPAIR_OUTPUTS", "FAKE_CAPTURE", "FAKE_CLAUDE_ARGV", "FAKE_CLAUDE_ASK", "FAKE_CLAUDE_RATELIMIT"];
afterEach(() => { for (const k of ENV) delete process.env[k]; });

const publishCatalog: Executor = async () => ({ status: "succeeded", writes: { "graphs.catalog": CATALOG } });

/** draft-graph over the fake: `answers` are the first answer of each spawn, `repair` the repair turn's */
function setup(answers: unknown[], repair?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "howdah-draft-"));
  const script = join(dir, "script.json");
  writeFileSync(script, JSON.stringify({ turns: answers.map((a) => ({ match: "graph.draft", outputs: { "graph.draft": a } })) }));
  const capture = join(dir, "capture.jsonl");
  const argv = join(dir, "argv.jsonl");
  Object.assign(process.env, { FAKE_CLAUDE_SCRIPT: script, FAKE_CAPTURE: capture, FAKE_CLAUDE_ARGV: argv, FAKE_CLAUDE_ASK: "0", FAKE_CLAUDE_RATELIMIT: "0" });
  if (repair !== undefined) process.env.FAKE_CLAUDE_REPAIR_OUTPUTS = JSON.stringify({ "graph.draft": repair });
  const engine = () => new Engine(draftGraph, {
    dir, promptsDir: PROMPTS,
    executors: {
      command: publishCatalog,
      agent: claudeExecutor({ attentionDir: join(dir, "a"), binary: FAKE, askPollMs: 20, notifiers: [], materialise: materialiseFake }),
    },
  });
  const turns = () => readFileSync(capture, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string);
  const sessions = () => readFileSync(argv, "utf8").trim().split("\n").map((l) => {
    const a = JSON.parse(l) as string[];
    return a[a.indexOf("--session-id") + 1];
  });
  const finished = () => readLog(join(dir, "run.jsonl")).filter((e) => e.type === "node-finished" && e.node === "graph.draft");
  return { dir, engine, turns, sessions, finished };
}

const reasonOf = (r: unknown) => (r as { reason: string }).reason;

describe("draft-graph: catalog → agent drafts → checked, repaired once, parks if refused twice", () => {
  test("a clean draft (with a copyOf) is published as graph.draft, with no repair turn", async () => {
    const { engine, turns, finished } = setup([cleanDraft()]);
    expect(await engine().start({ intent: "like quick-task but with a review step" })).toEqual({ state: "finished", outcome: "success" });
    expect(turns()).toHaveLength(1);
    expect(turns()[0]).toContain("like quick-task but with a review step");
    expect(turns()[0]).toContain('"takenNames"'); // the catalog reached the drafter
    expect(finished()).toEqual([expect.objectContaining({ status: "succeeded", writes: { "graph.draft": cleanDraft() } })]);
  }, 20_000);

  test("a refused draft is repaired in the same session: the repair names the problem, the fix is published", async () => {
    const { engine, turns, sessions, finished } = setup([renamed("quick-task")], cleanDraft());
    expect(await engine().start({ intent: "i" })).toEqual({ state: "finished", outcome: "success" });
    const repair = turns().at(-1)!;
    expect(repair).toStartWith("Your outputs object was refused");
    expect(repair).toContain(EDGE_CASES["name taken"]!.says);
    expect(sessions()).toHaveLength(1); // one spawn, one session: the repair is a second turn of it
    expect(finished()).toEqual([expect.objectContaining({ status: "succeeded", writes: { "graph.draft": cleanDraft() } })]);
  }, 20_000);

  test("a draft refused twice parks with every problem quoted word for word, and nothing is published", async () => {
    const twice = renamed("quick-task");
    twice.prompts["quick-task.extra"] = "Nobody runs this.\n";
    const { engine, finished } = setup([renamed("quick-task")], twice);
    const res = await engine().start({ intent: "i" });
    expect(res).toMatchObject({ state: "parked", node: "graph.draft" });
    const reason = reasonOf(res);
    expect(reason).toContain("output contract violation: the draft cannot be saved:");
    expect(reason).toContain(`- ${EDGE_CASES["name taken"]!.says}`);
    expect(reason).toContain(`- ${EDGE_CASES["orphan body"]!.says.replaceAll("quick-review", "quick-task")}`);
    expect(finished()).toEqual([expect.objectContaining({ status: "failed", writes: {} })]);
  }, 20_000);

  for (const [name, c] of Object.entries(EDGE_CASES))
    test(`${name}: refused, repaired the same way, and the park quotes it`, async () => {
      const { engine } = setup([c.draft()], c.draft());
      const res = await engine().start({ intent: "i" });
      expect(res).toMatchObject({ state: "parked", node: "graph.draft" });
      expect(reasonOf(res)).toContain(`- ${c.says}`);
    }, 20_000);

  test("a reply after the park re-runs the step as visit 2 in a FRESH session, and a valid draft publishes", async () => {
    const { dir, engine, sessions, finished } = setup([renamed("quick-task"), cleanDraft()], renamed("quick-task"));
    expect(await engine().start({ intent: "i" })).toMatchObject({ state: "parked", node: "graph.draft" });
    delete process.env.FAKE_CLAUDE_REPAIR_OUTPUTS;
    expect(resolveReply(dir, "pick a name nobody has", { graphs: GRAPHS })).toMatchObject({ ok: true, node: "graph.draft", visit: 1 });
    expect(await engine().resume()).toEqual({ state: "finished", outcome: "success" });
    const s = sessions();
    expect(s).toHaveLength(2);
    expect(new Set(s).size).toBe(2);
    expect(finished().map((e) => (e as { visit: number; status: string }).visit)).toEqual([1, 2]);
    expect(finished().at(-1)).toMatchObject({ status: "succeeded", writes: { "graph.draft": cleanDraft() } });
  }, 30_000);

  test("a step that writes graph.draft without reading graphs.catalog parks: catalog not available to this step", async () => {
    const { dir } = setup([cleanDraft()]);
    const graph = defineGraph<{ intent: string; "graph.draft": unknown }>({
      name: "blind-draft", entry: "draft", inputs: ["intent"],
      nodes: {
        draft: { kind: "agent", prompt: "quick-task.work" as never, reads: ["intent"], writes: { "graph.draft": { scope: "sticky" } }, readOnly: true },
        done: { kind: "terminal", outcome: "success" },
      },
      edges: [{ from: "draft", to: "done" }],
    });
    const prompts = mkdtempSync(join(tmpdir(), "howdah-draft-p-"));
    writeFileSync(join(prompts, "quick-task.work.md"), "---\nid: quick-task.work\nversion: 1\n---\nDraft {{ context.intent }}.\n");
    const engine = new Engine(graph, {
      dir, promptsDir: prompts,
      executors: { agent: claudeExecutor({ attentionDir: join(dir, "a"), binary: FAKE, askPollMs: 20, notifiers: [], materialise: materialiseFake }) },
    });
    const res = await engine.start({ intent: "i" });
    expect(res).toMatchObject({ state: "parked", node: "draft" });
    expect(reasonOf(res)).toContain("catalog not available to this step");
  }, 20_000);
});

describe("the outputs dispatch for graph.draft fails closed", () => {
  const reads = { "graphs.catalog": CATALOG, intent: "i" };

  test("a clean draft is accepted", () => {
    expect(checkWrites({ "graph.draft": cleanDraft() }, reads, { materialise: materialiseFake })).toBeNull();
  });

  test("no graphs.catalog among the reads: refused, never published unchecked", () => {
    expect(checkWrites({ "graph.draft": cleanDraft() }, { intent: "i" }, { materialise: materialiseFake })).toStartWith("catalog not available to this step");
  });

  test("a catalog that is not shaped like one is the same refusal", () => {
    for (const bad of [null, "catalog", { graphs: [] }, { takenNames: [], graphs: [{ name: "x" }] }])
      expect(graphDraftProblem(cleanDraft(), { "graphs.catalog": bad }, { materialise: materialiseFake })).toStartWith("catalog not available to this step");
  });

  test("an installation that wired no prompt reader cannot judge a copy, so it refuses", () => {
    expect(checkWrites({ "graph.draft": cleanDraft() }, reads)).toBe(
      "this installation cannot read prompt bodies to check a graph.draft — it did not wire one",
    );
  });

  test("a refusal lists every problem on its own line", () => {
    expect(checkWrites({ "graph.draft": renamed("quick-task") }, reads, { materialise: materialiseFake })).toBe(
      `the draft cannot be saved:\n- ${EDGE_CASES["name taken"]!.says}`,
    );
  });

  test("a write that is not a draft is untouched", () => {
    expect(checkWrites({ summary: "anything" }, {}, {})).toBeNull();
  });
});

describe("the live registry wires graphs:catalog and the prompt reader", () => {
  test("a graphs:catalog node no longer fails with 'did not wire one' when deps.catalog is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-draft-live-"));
    const registry = async () => ({ graphs: { "quick-task": GRAPHS["quick-task"]! }, source: { "quick-task": "builtin" as const }, problems: [] });
    const live = liveExecutors({ attentionDir: join(dir, "a"), catalog: { registry } });
    const graph = defineGraph<{ "graphs.catalog": unknown }>({
      name: "just-catalog", entry: "cat", inputs: [],
      nodes: {
        cat: { kind: "command", run: "graphs:catalog", writes: { "graphs.catalog": { scope: "sticky" } } },
        done: { kind: "terminal", outcome: "success" },
      },
      edges: [{ from: "cat", to: "done" }],
    });
    const engine = new Engine(graph, { dir, promptsDir: PROMPTS, executors: live });
    expect(await engine.start({})).toEqual({ state: "finished", outcome: "success" });
    const done = readLog(join(dir, "run.jsonl")).find((e) => e.type === "node-finished" && e.node === "cat") as { writes: Record<string, { takenNames: string[] }> };
    expect(done.writes["graphs.catalog"]!.takenNames).toContain("quick-task");
  }, 20_000);
});
