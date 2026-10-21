/**
 * HOW-65: the draft routes — GET /api/runs/:id/draft in each D-4A state, the card's Save with
 * provenance, and the builder PUT's provenance rule (decision 2: the server writes `drafted`,
 * never the client).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHowdahServer } from "./server";
import { EventLog } from "../log/write";
import type { RunEvent } from "../log/events";
import { localGraphPath, loadLocalGraph } from "../graphs/local";
import { specOf, type GraphSpec } from "../core/graph-spec";
import { CATALOG, cleanDraft } from "../core/fixtures/graph-draft";
import type { ReadyDraft } from "./draft";

const ROOT = join(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "howdah-draft-api-"));
const runsDir = join(home, "runs");
const server = createHowdahServer({ runsDir, attentionDir: join(home, "attention"), port: 0, repoRoot: ROOT });
const url = (p: string) => `http://localhost:${server.port}${p}`;
const origin = () => `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

const send = (method: string, p: string, body: unknown) =>
  fetch(url(p), { method, headers: { "content-type": "application/json", origin: origin() }, body: JSON.stringify(body) });
const get = async (id: string) => {
  const r = await fetch(url(`/api/runs/${id}/draft`));
  return { status: r.status, body: (await r.json()) as Omit<ReadyDraft, "state"> & { state: string; reason?: string } };
};
const save = (id: string, name: string) => send("POST", `/api/runs/${id}/draft/save`, { name });

type Phase = "running" | "parked" | "done";
/** a draft-graph run log, written by hand: catalog → draft → (park | done) */
function seedRun(id: string, opts: { phase?: Phase; draft?: unknown; catalog?: unknown; graph?: string } = {}): void {
  const log = new EventLog(join(runsDir, id, "run.jsonl"));
  const ev = (e: RunEvent) => log.append(e);
  ev({ type: "run-started", graph: opts.graph ?? "draft-graph", inputs: { intent: "like quick-task with a review" }, pinned_prompts: {} } as RunEvent);
  ev({ type: "node-started", node: "graphs.catalog", visit: 1, attempt_id: "graphs.catalog#1" });
  ev({ type: "node-finished", node: "graphs.catalog", visit: 1, status: "succeeded", writes: { "graphs.catalog": opts.catalog ?? CATALOG } });
  ev({ type: "node-started", node: "graph.draft", visit: 1, attempt_id: "graph.draft#1" });
  const phase = opts.phase ?? "done";
  if (phase === "running") return;
  if (phase === "parked") {
    ev({ type: "node-finished", node: "graph.draft", visit: 1, status: "failed", writes: {} });
    ev({ type: "attention-raised", node: "graph.draft", visit: 1, reason: "output contract violation: the draft cannot be saved:\n- There is already a graph called `quick-task`. Pick another name." });
    return;
  }
  ev({ type: "node-finished", node: "graph.draft", visit: 1, status: "succeeded", writes: { "graph.draft": opts.draft ?? cleanDraft() } });
  ev({ type: "run-finished", outcome: "success" });
}

const graphFile = (name: string) => readFileSync(localGraphPath(home, name), "utf8");
const savedSpec = async (name: string): Promise<GraphSpec> => specOf(await loadLocalGraph(home, name, ROOT))!;

describe("GET /api/runs/:id/draft — the D-4A states", () => {
  test("an unknown run is 404 with a reason", async () => {
    const { status, body } = await get("no-such-run");
    expect(status).toBe(404);
    expect(body).toEqual({ state: "unknown", reason: "There is no run called `no-such-run`." } as never);
  });

  test("a run of another graph is not a draft", async () => {
    seedRun("other-graph", { graph: "quick-task" });
    const { status, body } = await get("other-graph");
    expect([status, body.state]).toEqual([404, "unknown"]);
    expect(body.reason).toContain("is a quick-task run, not a draft");
  });

  test("a running draft is 409 'still drafting'", async () => {
    seedRun("drafting", { phase: "running" });
    const { status, body } = await get("drafting");
    expect([status, body.state, body.reason]).toEqual([409, "drafting", "Howdah is still drafting this graph."]);
  });

  test("a draft refused twice (parked) is 409 with the park's own words", async () => {
    seedRun("refused", { phase: "parked" });
    const { status, body } = await get("refused");
    expect([status, body.state]).toEqual([409, "refused"]);
    expect(body.reason).toContain("There is already a graph called `quick-task`. Pick another name.");
  });

  test("a finished draft is ready: diff, advice, grantsNewWrite, draftHash, not saved", async () => {
    seedRun("ready");
    const { status, body } = await get("ready");
    expect([status, body.state]).toEqual([200, "ready"]);
    expect(body.draft.based_on).toBe("quick-task");
    expect(body.base?.name).toBe("quick-task");
    expect(body.diff.added.map((r) => r.id)).toEqual(["quick-review.work", "quick-review.review"]);
    expect(body.diff.removed.map((r) => r.id)).toEqual(["quick-task.work"]);
    expect(body.diff.added[0]!.body).toMatchObject({ unchangedFrom: "quick-task.work" });
    expect(body.grantsNewWrite).toBe(true); // quick-review.work is a writer the base did not have by that id
    expect(body.texts["quick-review.work"]).toContain("context.goal"); // the copy, filled in
    expect(body.draftHash).toStartWith("c53:");
    expect(body.saved).toBeNull();
    expect(body.baseChanged).toBeNull();
    expect(Array.isArray(body.advice)).toBe(true);
  });
});

describe("POST /api/runs/:id/draft/save — Save is the approval", () => {
  test("a taken name is 409 with the exact sentence, and writes nothing", async () => {
    seedRun("taken");
    await send("PUT", "/api/graphs/occupied/builder", {
      intent: "create",
      spec: { ...cleanDraft().spec, name: "occupied", entry: "occupied.work", nodes: [
        { id: "occupied.work", kind: "agent", prompt: "occupied.work", reads: [], writes: ["summary"] },
        { id: "done", kind: "terminal", outcome: "success" },
      ], edges: [{ from: "occupied.work", to: "done" }] },
      prompts: { "occupied.work": "Do it." },
    });
    const before = graphFile("occupied");
    const r = await save("taken", "occupied");
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe("There is already a graph called `occupied`. Pick another name.");
    expect(graphFile("occupied")).toBe(before);
  });

  test("a built-in's name is 409", async () => {
    const r = await save("taken", "quick-task");
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe(`"quick-task" is one of Howdah's own graphs — pick another name`);
  });

  test("a free name writes <name>.ts with drafted {run, draftHash}; GET then reports saved; a second Save is refused", async () => {
    seedRun("to-save");
    const hash = (await get("to-save")).body.draftHash;
    const r = await save("to-save", "my-review");
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ ok: true, name: "my-review" });
    expect(graphFile("my-review")).toContain('"drafted"');
    expect(graphFile("my-review")).toContain('"run": "to-save"');
    const spec = await savedSpec("my-review");
    expect(spec.drafted).toEqual({ run: "to-save", draftHash: hash });
    // the rename moved every prompt the draft owned, and the copy was written out as text
    expect(spec.nodes.flatMap((n) => (n.kind === "agent" ? [n.prompt] : []))).toEqual(["my-review.work", "my-review.review"]);
    expect(readdirSync(join(home, "prompts"))).toContain("my-review.work.md");
    expect(readFileSync(join(home, "prompts", "my-review.work.md"), "utf8")).toContain("context.goal");

    expect((await get("to-save")).body.saved).toEqual({ name: "my-review", edited: false });
    const again = await save("to-save", "another-name");
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("This draft is already saved as `my-review`.");
    expect(existsSync(localGraphPath(home, "another-name"))).toBe(false);
  });

  test("a draft that is not ready cannot be saved", async () => {
    expect((await save("drafting", "whatever")).status).toBe(409);
    expect((await save("no-such-run", "whatever")).status).toBe(404);
  });
});

describe("the builder PUT's provenance (decision 2)", () => {
  test("fromRun stamps drafted {run, draftHash, edited: true}; GET reports edited", async () => {
    seedRun("canvas");
    const ready = (await get("canvas")).body;
    const r = await send("PUT", "/api/graphs/from-canvas/builder", {
      intent: "create",
      fromRun: "canvas",
      spec: { ...renamedSpec(ready, "from-canvas"), drafted: { run: "forged", draftHash: "c53:x" } },
      prompts: renamedTexts(ready, "from-canvas"),
    });
    expect(r.status).toBe(201);
    expect((await savedSpec("from-canvas")).drafted).toEqual({ run: "canvas", draftHash: ready.draftHash, edited: true });
    expect((await get("canvas")).body.saved).toEqual({ name: "from-canvas", edited: true });
    // ...and the card's Save now refuses: it is already a graph
    expect((await save("canvas", "elsewhere")).status).toBe(409);
  });

  test("fromRun naming a run already saved under another name is refused", async () => {
    const ready = (await get("canvas")).body;
    const r = await send("PUT", "/api/graphs/second-copy/builder", {
      intent: "create", fromRun: "canvas", spec: renamedSpec(ready, "second-copy"), prompts: renamedTexts(ready, "second-copy"),
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe("This draft is already saved as `from-canvas`.");
  });

  test("an update of a drafted graph keeps drafted and marks it edited — a moved step is enough", async () => {
    const spec = await savedSpec("my-review");
    const moved = { ...spec, nodes: spec.nodes.map((n, i) => (i === 0 ? { ...n, position: { x: 400, y: 10 } } : n)) };
    const r = await send("PUT", "/api/graphs/my-review/builder", { intent: "update", spec: { ...moved, drafted: undefined }, prompts: {} });
    expect(r.status).toBe(200);
    expect((await savedSpec("my-review")).drafted).toEqual({ run: "to-save", draftHash: spec.drafted!.draftHash, edited: true });
    expect((await get("to-save")).body.saved).toEqual({ name: "my-review", edited: true });
  });

  test("a client-forged drafted on a plain create is stripped", async () => {
    const r = await send("PUT", "/api/graphs/forged/builder", {
      intent: "create",
      spec: { ...plainSpec("forged"), drafted: { run: "to-save", draftHash: "c53:forged" } },
      prompts: { "forged.work": "Do it." },
    });
    expect(r.status).toBe(201);
    expect((await savedSpec("forged")).drafted).toBeUndefined();
    expect(graphFile("forged")).not.toContain('"drafted"');
  });

  test("fromRun on a run with no ready draft is refused with its reason", async () => {
    const r = await send("PUT", "/api/graphs/never/builder", { intent: "create", fromRun: "drafting", spec: plainSpec("never"), prompts: { "never.work": "x" } });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe("Howdah is still drafting this graph.");
    expect(existsSync(localGraphPath(home, "never"))).toBe(false);
  });
});

describe("base changed after drafting", () => {
  test("a base spec edited since the catalog was read raises the banner flag", async () => {
    const edited = JSON.parse(JSON.stringify(CATALOG)) as typeof CATALOG;
    edited.graphs = edited.graphs.map((g) => (g.name === "quick-task" ? { ...g, spec: { ...g.spec, description: "an older description" } } : g));
    seedRun("base-moved", { catalog: edited });
    expect((await get("base-moved")).body.baseChanged).toEqual({ base: "quick-task", gone: false });
  });

  test("a base that no longer exists is `gone`", async () => {
    seedRun("base-gone", { draft: { ...cleanDraft(), based_on: "look-only" } });
    const { body } = await get("base-gone");
    expect(body.baseChanged).toEqual({ base: "look-only", gone: true });
    expect(body.base?.name).toBe("look-only"); // still diffed against what the drafter saw
  });
});

function plainSpec(name: string): GraphSpec {
  return {
    version: 1, name, description: "plain", entry: `${name}.work`, inputs: ["goal"],
    fields: [{ key: "goal", kind: "text", scope: "sticky" }, { key: "summary", kind: "text", scope: "sticky" }],
    nodes: [
      { id: `${name}.work`, kind: "agent", prompt: `${name}.work`, reads: [], writes: ["summary"] },
      { id: "done", kind: "terminal", outcome: "success" },
    ],
    edges: [{ from: `${name}.work`, to: "done" }],
  };
}

/** what the builder sends for a draft opened from a run: renamed, copies already text */
function renamedSpec(ready: Pick<ReadyDraft, "draft">, name: string): GraphSpec {
  return JSON.parse(JSON.stringify(ready.draft.spec).replaceAll(`"${ready.draft.spec.name}.`, `"${name}.`).replace(`"name":"${ready.draft.spec.name}"`, `"name":"${name}"`)) as GraphSpec;
}
function renamedTexts(ready: Pick<ReadyDraft, "draft" | "texts">, name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(ready.texts).map(([id, t]) => [id.replace(`${ready.draft.spec.name}.`, `${name}.`), t]));
}
