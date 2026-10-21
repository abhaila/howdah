/**
 * HOW-65 end to end: a REAL draft-graph run (the engine, the claude executor, the fake-claude
 * wire, the outputs check) into a temp HOWDAH_HOME, then the viewer's routes over its log —
 * the draft is ready, a taken name is refused word for word, a free name saves a loadable graph
 * carrying `drafted`, the run then reports it saved, and a canvas save marks it edited.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type Executor } from "../engine/run";
import { claudeExecutor } from "../engine/executors/claude";
import { draftGraph } from "../graphs/draft-graph";
import { loadLocalGraph, localGraphPath } from "../graphs/local";
import { specOf, type GraphSpec } from "../core/graph-spec";
import { CATALOG, cleanDraft, materialiseFake } from "../core/fixtures/graph-draft";
import { createHowdahServer } from "./server";

const ROOT = join(import.meta.dir, "..");
const FAKE = join(ROOT, "engine", "executors", "fake-claude.ts");
const ENV = ["FAKE_CLAUDE_SCRIPT", "FAKE_CAPTURE", "FAKE_CLAUDE_ARGV", "FAKE_CLAUDE_ASK", "FAKE_CLAUDE_RATELIMIT"];
afterEach(() => { for (const k of ENV) delete process.env[k]; });

const home = mkdtempSync(join(tmpdir(), "howdah-draft-e2e-"));
const runsDir = join(home, "runs");
const RUN = "draft-e2e-run";
const server = createHowdahServer({ runsDir, attentionDir: join(home, "attention"), port: 0, repoRoot: ROOT });
afterAll(() => server.stop(true));
const url = (p: string) => `http://localhost:${server.port}${p}`;
const send = (method: string, p: string, body: unknown) =>
  fetch(url(p), { method, headers: { "content-type": "application/json", origin: `http://localhost:${server.port}` }, body: JSON.stringify(body) });

test("a fake-claude draft-graph run → the card's routes → a saved, loadable graph with provenance → edited on canvas", async () => {
  // 1. the run, exactly as engine/executors/draft-graph.test.ts drives it
  const dir = join(runsDir, RUN);
  const scratch = mkdtempSync(join(tmpdir(), "howdah-draft-e2e-fake-"));
  const script = join(scratch, "script.json");
  writeFileSync(script, JSON.stringify({ turns: [{ match: "graph.draft", outputs: { "graph.draft": cleanDraft() } }] }));
  Object.assign(process.env, {
    FAKE_CLAUDE_SCRIPT: script, FAKE_CAPTURE: join(scratch, "c.jsonl"), FAKE_CLAUDE_ARGV: join(scratch, "a.jsonl"),
    FAKE_CLAUDE_ASK: "0", FAKE_CLAUDE_RATELIMIT: "0",
  });
  const publishCatalog: Executor = async () => ({ status: "succeeded", writes: { "graphs.catalog": CATALOG } });
  const engine = new Engine(draftGraph, {
    dir, promptsDir: join(ROOT, "prompts"),
    executors: {
      command: publishCatalog,
      agent: claudeExecutor({ attentionDir: join(home, "attention"), binary: FAKE, askPollMs: 20, notifiers: [], materialise: materialiseFake }),
    },
  });
  expect(await engine.start({ intent: "like quick-task but with a review step" })).toEqual({ state: "finished", outcome: "success" });

  // 2. the draft is ready
  const got = await fetch(url(`/api/runs/${RUN}/draft`));
  expect(got.status).toBe(200);
  const draft = (await got.json()) as { state: string; saved: unknown; draftHash: string; grantsNewWrite: boolean; diff: { added: unknown[] } };
  expect(draft).toMatchObject({ state: "ready", saved: null });
  expect(draft.diff.added).toHaveLength(2);

  // 3. a taken name: the 409, word for word, and nothing written
  const taken = await send("POST", `/api/runs/${RUN}/draft/save`, { name: "quick-task" });
  expect(taken.status).toBe(409);
  expect(((await taken.json()) as { error: string }).error).toBe(`"quick-task" is one of Howdah's own graphs — pick another name`);

  // 4. a free name: 201, and the module carries the run
  const saved = await send("POST", `/api/runs/${RUN}/draft/save`, { name: "reviewed-task" });
  expect(saved.status).toBe(201);
  const source = readFileSync(localGraphPath(home, "reviewed-task"), "utf8");
  expect(source).toContain('"drafted"');
  expect(source).toContain(`"run": "${RUN}"`);

  // 5. it loads through the same gate as any local graph
  const spec = specOf(await loadLocalGraph(home, "reviewed-task", ROOT)) as GraphSpec;
  expect(spec.drafted).toEqual({ run: RUN, draftHash: draft.draftHash });

  // 6. the run now reports it saved — a reload never offers Save again
  expect(((await (await fetch(url(`/api/runs/${RUN}/draft`))).json()) as { saved: unknown }).saved).toEqual({ name: "reviewed-task", edited: false });

  // 7. open on canvas, move a step, save: edited
  const moved = { ...spec, nodes: spec.nodes.map((n, i) => (i === 0 ? { ...n, position: { x: 320, y: 40 } } : n)) };
  expect((await send("PUT", "/api/graphs/reviewed-task/builder", { intent: "update", spec: moved, prompts: {} })).status).toBe(200);
  expect(((await (await fetch(url(`/api/runs/${RUN}/draft`))).json()) as { saved: unknown }).saved).toEqual({ name: "reviewed-task", edited: true });
}, 30_000);
