/**
 * HOW-67: the quiet "Ready for you" tier — GET /api/ready. A finished draft nobody has saved or
 * discarded is listed, and clears on either answer however it arrives; and the tier is never an
 * attention record, while a twice-refused draft still takes the full amber path.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHowdahServer } from "./server";
import { EventLog } from "../log/write";
import type { RunEvent } from "../log/events";
import { AttentionCenter } from "../engine/attention";
import type { InboxItem } from "../engine/attention-inbox";
import { CATALOG, cleanDraft } from "../core/fixtures/graph-draft";
import { REDRAFT_MARKER } from "../core/draft-launch";
import type { ReadyDraft, ReadyItem } from "./draft";

const ROOT = join(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "howdah-ready-api-"));
const runsDir = join(home, "runs");
const attentionDir = join(home, "attention");
const server = createHowdahServer({ runsDir, attentionDir, port: 0, repoRoot: ROOT });
const url = (p: string) => `http://localhost:${server.port}${p}`;
afterAll(() => server.stop(true));

const send = (method: string, p: string, body: unknown) =>
  fetch(url(p), { method, headers: { "content-type": "application/json", origin: url("") }, body: JSON.stringify(body) });
const ready = async () => (await (await fetch(url("/api/ready"))).json()) as ReadyItem[];
const attention = async () => (await (await fetch(url("/api/attention"))).json()) as InboxItem[];
const readyIds = async () => (await ready()).map((i) => i.run);

type Phase = "running" | "parked" | "done" | "done-no-draft";
const REFUSAL = "output contract violation: the draft cannot be saved:\n- `runs:launch` is not something a draft may use.";

/** a draft-graph run log, written by hand: catalog → draft → (park | done) */
function seedRun(id: string, opts: { phase?: Phase; graph?: string; intent?: string; name?: string; at?: string } = {}): void {
  const log = new EventLog(join(runsDir, id, "run.jsonl"));
  const ev = (e: RunEvent) => log.append(e);
  ev({
    type: "run-started", graph: opts.graph ?? "draft-graph", inputs: { intent: opts.intent ?? "like quick-task with a review" },
    pinned_prompts: {}, ...(opts.name ? { name: opts.name } : {}),
  } as RunEvent);
  ev({ type: "node-started", node: "graphs.catalog", visit: 1, attempt_id: "graphs.catalog#1" });
  ev({ type: "node-finished", node: "graphs.catalog", visit: 1, status: "succeeded", writes: { "graphs.catalog": CATALOG } });
  ev({ type: "node-started", node: "graph.draft", visit: 1, attempt_id: "graph.draft#1" });
  const phase = opts.phase ?? "done";
  if (phase === "running") return;
  if (phase === "parked") {
    ev({ type: "node-finished", node: "graph.draft", visit: 1, status: "failed", writes: {} });
    ev({ type: "attention-raised", node: "graph.draft", visit: 1, reason: REFUSAL });
    return;
  }
  ev({ type: "node-finished", node: "graph.draft", visit: 1, status: "succeeded", writes: phase === "done" ? { "graph.draft": cleanDraft() } : {} });
  ev({ type: "run-finished", outcome: "success" });
}

const attentionFiles = () => (existsSync(attentionDir) ? readdirSync(attentionDir) : []);

describe("GET /api/ready", () => {
  test("a finished, unsaved, undiscarded draft appears, linking to its review page", async () => {
    seedRun("appears", { name: "my label" });
    const items = await ready();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ run: "appears", name: "my label", intent: "like quick-task with a review", href: "/runs/appears/draft" });
    expect(typeof items[0]!.finished_at).toBe("string");
  });

  test("it never touches the amber path: /api/attention stays empty and nothing is written to attention/", async () => {
    expect(await readyIds()).toContain("appears");
    expect(await attention()).toEqual([]);
    expect(attentionFiles()).toEqual([]);
  });

  test("Save from the card clears it — and asking again still says so (derived, idempotent)", async () => {
    const r = await send("POST", "/api/runs/appears/draft/save", { name: "ready-saved" });
    expect(r.status).toBe(201);
    expect(await readyIds()).not.toContain("appears");
    expect(await readyIds()).not.toContain("appears");
  });

  test("Save through the builder (another tab, ?fromRun=) clears it on the next poll", async () => {
    seedRun("other-tab");
    expect(await readyIds()).toContain("other-tab");
    const d = (await (await fetch(url("/api/runs/other-tab/draft"))).json()) as ReadyDraft;
    const old = d.draft.spec.name;
    const spec = JSON.parse(JSON.stringify(d.draft.spec).replaceAll(`"${old}.`, `"from-tab.`).replace(`"name":"${old}"`, `"name":"from-tab"`));
    const prompts = Object.fromEntries(Object.entries(d.texts).map(([id, t]) => [id.replace(`${old}.`, "from-tab."), t]));
    const r = await send("PUT", "/api/graphs/from-tab/builder", { intent: "create", fromRun: "other-tab", spec, prompts });
    expect(r.status).toBe(201);
    expect(await readyIds()).not.toContain("other-tab");
  });

  test("Discard clears it", async () => {
    seedRun("to-discard");
    expect(await readyIds()).toContain("to-discard");
    expect((await send("POST", "/api/runs/to-discard/draft/discard", {})).status).toBe(200);
    expect(await readyIds()).not.toContain("to-discard");
  });

  test("a running draft, a parked draft, a finished run with no draft and another graph's run are not listed", async () => {
    seedRun("still-running", { phase: "running" });
    seedRun("parked", { phase: "parked" });
    seedRun("no-draft", { phase: "done-no-draft" });
    seedRun("not-a-draft", { graph: "implement-ticket" });
    const ids = await readyIds();
    for (const id of ["still-running", "parked", "no-draft", "not-a-draft"]) expect(ids).not.toContain(id);
  });

  test("a redraft shows the operator's words, not the previous draft its intent carries", async () => {
    seedRun("redraft", { intent: `add a review\n\n${REDRAFT_MARKER}\n{"spec":{}}` });
    const item = (await ready()).find((i) => i.run === "redraft")!;
    expect(item.intent).toBe("add a review");
  });

  test("newest first", async () => {
    seedRun("older");
    await Bun.sleep(5);
    seedRun("newer");
    const items = await ready();
    const sorted = [...items].sort((a, b) => b.finished_at.localeCompare(a.finished_at));
    expect(items.length).toBeGreaterThan(1);
    expect(items.map((i) => i.run)).toEqual(sorted.map((i) => i.run));
    expect(items[0]!.run).toBe("newer");
  });
});

describe("a draft refused twice still raises the full alarm", () => {
  test("its park is on /api/attention with the refusal, and it is not in the quiet tier", async () => {
    seedRun("refused-twice", { phase: "parked", intent: "fan out with runs:launch" });
    // the engine's raise, exactly as it would write it — durable record, then (no) notifiers
    await new AttentionCenter(attentionDir, []).raise({ run: "refused-twice", node: "graph.draft", visit: 1, reason: REFUSAL });
    const asks = await attention();
    expect(asks.map((a) => a.run)).toEqual(["refused-twice"]);
    expect(asks[0]!.reason).toContain("runs:launch");
    expect(await readyIds()).not.toContain("refused-twice");
  });
});
