/**
 * HOW-66: the draft's other two answers on the server — Ask for changes (POST …/draft/redraft,
 * D-5A) and Discard (POST …/draft/discard, D-10A) — and New run's draft-graph launch. The
 * spawn is injected (`spawnRun`): a real one starts an engine that may spend tokens. Both
 * launch paths are pinned against core/draft-launch.ts, so they cannot drift apart.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHowdahServer } from "./server";
import { EventLog } from "../log/write";
import type { RunEvent } from "../log/events";
import { launchArgs } from "../core/launch-args";
import { draftLaunchRequest, REDRAFT_MARKER } from "../core/draft-launch";
import { CATALOG, cleanDraft } from "../core/fixtures/graph-draft";
import { REDRAFT_INTENT_CAP, type ReadyDraft } from "./draft";
import { deriveDraftDiscarded, deriveLogRows } from "./derive";

const ROOT = join(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "howdah-draft-actions-"));
const runsDir = join(home, "runs");
const wsPath = mkdtempSync(join(tmpdir(), "howdah-draft-ws-"));
writeFileSync(join(home, "config.json"), JSON.stringify({ repos: {}, folders: { scratch: { path: wsPath } } }));
const spawned: string[][] = [];
const server = createHowdahServer({ runsDir, attentionDir: join(home, "attention"), port: 0, repoRoot: ROOT, spawnRun: (argv) => spawned.push(argv) });
const url = (p: string) => `http://localhost:${server.port}${p}`;
afterAll(() => server.stop(true));

const post = (p: string, body?: unknown) =>
  fetch(url(p), {
    method: "POST",
    headers: { origin: `http://localhost:${server.port}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const getDraft = async (id: string) => (await (await fetch(url(`/api/runs/${id}/draft`))).json()) as ReadyDraft & { reason?: string };
const redraft = (id: string, change: unknown) => post(`/api/runs/${id}/draft/redraft`, { change });
const discard = (id: string) => post(`/api/runs/${id}/draft/discard`);
const errorOf = async (r: Response) => ((await r.json()) as { error: string }).error;
const logOf = (id: string) => readFileSync(join(runsDir, id, "run.jsonl"), "utf8");
const count = (id: string, type: string) => logOf(id).split("\n").filter((l) => l.includes(`"type":"${type}"`)).length;
const flag = (argv: string[], f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);

/** a draft-graph run log, written by hand: catalog → draft → done (or still drafting) */
function seedRun(id: string, opts: { running?: boolean; draft?: unknown; intent?: string; cwd?: string; parent?: string } = {}): void {
  const log = new EventLog(join(runsDir, id, "run.jsonl"));
  const ev = (e: RunEvent) => log.append(e);
  ev({ type: "run-started", graph: "draft-graph", inputs: { intent: opts.intent ?? "like quick-task with a review" }, pinned_prompts: {},
    ...(opts.cwd ? { cwd: opts.cwd, folder_kind: "plain" } : {}), ...(opts.parent ? { parent: opts.parent } : {}) } as RunEvent);
  ev({ type: "node-started", node: "graphs.catalog", visit: 1, attempt_id: "graphs.catalog#1" });
  ev({ type: "node-finished", node: "graphs.catalog", visit: 1, status: "succeeded", writes: { "graphs.catalog": CATALOG } });
  ev({ type: "node-started", node: "graph.draft", visit: 1, attempt_id: "graph.draft#1" });
  if (opts.running) return;
  ev({ type: "node-finished", node: "graph.draft", visit: 1, status: "succeeded", writes: { "graph.draft": opts.draft ?? cleanDraft() } });
  ev({ type: "run-finished", outcome: "success" });
}

describe("New run → Draft a graph: the launch argv from both paths", () => {
  test("POST /api/runs with draftLaunchRequest's body spawns exactly launchArgs(draftLaunchRequest(...))", async () => {
    spawned.length = 0;
    const request = draftLaunchRequest({ intent: "like quick-task with a review", base: "quick-task", workspace: "scratch" });
    const r = await post("/api/runs", request);
    expect(r.status).toBe(202);
    const { id } = (await r.json()) as { id: string };
    expect(id).toStartWith("draft-graph-");
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toEqual(launchArgs(request, id));
  });
});

describe("POST /api/runs/:id/draft/redraft — Ask for changes (D-5A)", () => {
  test("launches a draft-graph child with --parent, the requests, the change, this draft as base, and the parent's workspace", async () => {
    seedRun("parent", { cwd: wsPath });
    spawned.length = 0;
    const r = await redraft("parent", "make the review read-only");
    expect(r.status).toBe(202);
    const { id } = (await r.json()) as { id: string };
    expect(spawned).toHaveLength(1);
    const argv = spawned[0]!;
    expect(argv.slice(0, 4)).toEqual(["run", "draft-graph", "--id", id]);
    expect(flag(argv, "--parent")).toBe("parent");
    expect(flag(argv, "--workspace")).toBe("scratch");
    const intent = flag(argv, "-i")!.replace(/^intent=/, "");
    expect(intent).toStartWith("like quick-task with a review\n\nChange requested: make the review read-only\n\n" + REDRAFT_MARKER);
    expect(intent).toContain("Keep `based_on` as `quick-task`");
    expect(JSON.parse(intent.slice(intent.indexOf("{"))).spec.name).toBe(cleanDraft().spec.name);
  });

  test("the old card's receipt is derived from the child's run-started.parent", async () => {
    expect((await getDraft("parent")).redrafts).toEqual([]);
    seedRun("child-1", { running: true, parent: "parent" });
    // a run of another graph naming the same parent is not a redraft
    new EventLog(join(runsDir, "not-a-draft", "run.jsonl")).append({ type: "run-started", graph: "quick-task", parent: "parent", inputs: {}, pinned_prompts: {} } as RunEvent);
    const d = await getDraft("parent");
    expect(d.redrafts.map((x) => x.run)).toEqual(["child-1"]);
    expect(typeof d.redrafts[0]!.at).toBe("string");
  });

  test("no workspace recorded (or an unregistered one): no --workspace", async () => {
    seedRun("no-ws", { cwd: "/nowhere/registered" });
    spawned.length = 0;
    expect((await redraft("no-ws", "x")).status).toBe(202);
    expect(spawned[0]).not.toContain("--workspace");
  });

  test("refusals spawn nothing: an empty change, a draft not ready, a discarded draft, one too large", async () => {
    seedRun("still-drafting", { running: true });
    seedRun("to-discard-then-redraft");
    const huge = { ...cleanDraft(), notes: "", prompts: { ...cleanDraft().prompts, "quick-review.review": "x".repeat(REDRAFT_INTENT_CAP) } };
    seedRun("huge", { draft: huge });
    expect((await getDraft("huge")).state).toBe("ready");
    spawned.length = 0;

    const empty = await redraft("parent", "   ");
    expect([empty.status, await errorOf(empty)]).toEqual([400, "Say what should change."]);
    const notReady = await redraft("still-drafting", "x");
    expect([notReady.status, await errorOf(notReady)]).toEqual([409, "Howdah is still drafting this graph."]);
    expect((await redraft("no-such-run", "x")).status).toBe(404);
    expect((await discard("to-discard-then-redraft")).status).toBe(200);
    const gone = await redraft("to-discard-then-redraft", "x");
    expect([gone.status, await errorOf(gone)]).toEqual([409, "This draft was discarded."]);
    const big = await redraft("huge", "x");
    expect(big.status).toBe(422);
    expect(await errorOf(big)).toContain("open it in the builder");
    expect(spawned).toEqual([]);
  });
});

describe("POST /api/runs/:id/draft/discard — Discard (D-10A)", () => {
  test("twice is idempotent: 200 both times, appended then not, exactly one event; GET exposes it", async () => {
    seedRun("twice");
    expect((await getDraft("twice")).discarded).toBeNull();
    const a = await discard("twice");
    expect([a.status, await a.json()]).toEqual([200, { ok: true, appended: true }]);
    const b = await discard("twice");
    expect([b.status, await b.json()]).toEqual([200, { ok: true, appended: false }]);
    expect(count("twice", "draft-discarded")).toBe(1);
    expect(logOf("twice")).toContain('"by":"operator"');
    expect((await getDraft("twice")).discarded).toMatchObject({ at: expect.any(String) });
  });

  test("after a save it is refused naming the graph, and appends nothing", async () => {
    seedRun("saved-first");
    expect((await post("/api/runs/saved-first/draft/save", { name: "kept-graph" })).status).toBe(201);
    const r = await discard("saved-first");
    expect([r.status, await errorOf(r)]).toEqual([409, "This draft is already saved as `kept-graph` — delete the graph instead."]);
    expect(count("saved-first", "draft-discarded")).toBe(0);
  });

  test("a save after a discard is refused — the card's Save and the builder's fromRun alike", async () => {
    seedRun("discarded-first");
    await discard("discarded-first");
    const r = await post("/api/runs/discarded-first/draft/save", { name: "never-saved" });
    expect([r.status, await errorOf(r)]).toEqual([409, "This draft was discarded."]);
    const ready = await getDraft("discarded-first");
    const put = await fetch(url(`/api/graphs/${ready.draft.spec.name}/builder`), {
      method: "PUT",
      headers: { "content-type": "application/json", origin: `http://localhost:${server.port}` },
      body: JSON.stringify({ intent: "create", fromRun: "discarded-first", spec: { ...ready.draft.spec }, prompts: ready.texts }),
    });
    expect([put.status, await errorOf(put)]).toEqual([409, "This draft was discarded."]);
  });

  test("a draft still drafting cannot be discarded; an unknown run is 404", async () => {
    seedRun("busy", { running: true });
    const r = await discard("busy");
    expect([r.status, await errorOf(r)]).toEqual([409, "Howdah is still drafting this graph."]);
    expect(count("busy", "draft-discarded")).toBe(0);
    expect((await discard("no-such-run")).status).toBe(404);
  });
});

describe("derive: the discard decision (D-10A)", () => {
  test("deriveDraftDiscarded is the FIRST draft-discarded's time, or null; deriveLogRows gives it an operator row", () => {
    const log = new EventLog(join(mkdtempSync(join(tmpdir(), "howdah-derive-discard-")), "run.jsonl"));
    log.append({ type: "run-started", graph: "draft-graph", inputs: { intent: "x" }, pinned_prompts: {} } as RunEvent);
    expect(deriveDraftDiscarded(log.read())).toBeNull();
    const first = log.append({ type: "draft-discarded", by: "operator" });
    log.append({ type: "draft-discarded", by: "operator" }); // a hand-written repeat changes nothing
    expect(deriveDraftDiscarded(log.read())).toEqual({ at: first.ts });
    const rows = deriveLogRows(log.read()).filter((r) => r.type === "draft-discarded");
    expect(rows[0]).toMatchObject({ kind: "operator", node: null, summary: "draft discarded" });
  });
});
