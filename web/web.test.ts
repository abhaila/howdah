import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, readLog } from "../log/write";
import { deriveStatus, deriveSummary, deriveDetail, deriveTimeline, sortRuns } from "./derive";
import { createHowdahServer } from "./server";
import { AttentionCenter } from "../engine/attention";

function fixedClock(startMs = 1757750000000): () => Date {
  let t = 0;
  return () => new Date(startMs + ++t * 1000);
}

/** a run that rendered a prompt, streamed a turn, then parked on an ask */
function seedParkedRun(runsDir: string, id: string): EventLog {
  const log = new EventLog(join(runsDir, id, "run.jsonl"), fixedClock());
  log.append({ type: "run-started", graph: "write-doc", inputs: { goal: "draft the blog post" }, pinned_prompts: { "doc.draft": 1 } });
  log.append({ type: "node-started", node: "doc.draft", visit: 1, attempt_id: "doc.draft#1" });
  log.append({ type: "prompt-rendered", node: "doc.draft", visit: 1, prompt: "doc.draft", prompt_version: 1, rendered_hash: "h1", context_read: { goal: "draft the blog post" } });
  log.append({ type: "chunk", node: "doc.draft", visit: 1, turn: 1, index: 0, kind: "text", content: "Drafting…" });
  log.append({ type: "chunk", node: "doc.draft", visit: 1, turn: 1, index: 1, kind: "tool_call", content: "Write(doc.md)", tool_id: "t1", tool_name: "Write" });
  log.append({ type: "turn-finalized", node: "doc.draft", visit: 1, turn: 1, usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.01 } });
  log.append({ type: "node-finished", node: "doc.draft", visit: 1, status: "succeeded", writes: { doc_summary: "v1" } });
  log.append({ type: "allowance", harness: "claude", state: "ok", remaining: 0.42 });
  log.append({ type: "attention-raised", node: "doc.review", visit: 1, reason: "needs your reply" });
  return log;
}

describe("derive", () => {
  test("needs-input outranks a failed node; resolution returns to running", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-web-"));
    const log = seedParkedRun(dir, "r1");
    expect(deriveStatus(log.read()).status).toBe("needs-input");
    log.append({ type: "attention-resolved", node: "doc.review", visit: 1, reply: "go on" });
    expect(deriveStatus(log.read()).status).toBe("running");
    log.append({ type: "run-finished", outcome: "success" });
    expect(deriveStatus(log.read()).status).toBe("done");
  });

  test("summary carries goal, wait-since, and reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-web-"));
    const log = seedParkedRun(dir, "r1");
    const s = deriveSummary("r1", log.read());
    expect(s).toMatchObject({ id: "r1", graph: "write-doc", goal: "draft the blog post", status: "needs-input", needs_input_reason: "needs your reply" });
    expect(s.waiting_since).not.toBeNull();
  });

  test("detail: coalesced turns, timeline durations, usage totals, allowance, pinned prompts", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-web-"));
    const d = deriveDetail("r1", seedParkedRun(dir, "r1").read());
    expect(d.turns).toHaveLength(1);
    expect(d.turns[0]!.parts.map((p) => p.kind)).toEqual(["text", "tool_call"]);
    expect(d.timeline).toEqual([
      expect.objectContaining({ node: "doc.draft", visit: 1, status: "succeeded", duration_ms: 5000 }),
    ]);
    expect(d.usage).toEqual({ input_tokens: 100, output_tokens: 50, cost_usd: 0.01 });
    expect(d.allowance).toEqual([expect.objectContaining({ harness: "claude", state: "ok", remaining: 0.42 })]);
    expect(d.pinned_prompts).toEqual({ "doc.draft": 1 });
    expect(d.ask?.reason).toBe("needs your reply");
  });

  test("sortRuns: needs-input first with longest wait first, terminal last", () => {
    const mk = (id: string, status: any, waiting_since: string | null = null, last = "2026-09-13T10:00:00Z") =>
      ({ id, graph: "g", goal: "", status, started_at: null, last_event_at: last, waiting_since, needs_input_reason: null }) as any;
    const sorted = sortRuns([
      mk("done1", "done"),
      mk("run1", "running"),
      mk("wait-short", "needs-input", "2026-09-13T09:50:00Z"),
      mk("wait-long", "needs-input", "2026-09-13T08:00:00Z"),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["wait-long", "wait-short", "run1", "done1"]);
  });

  test("deriveTimeline leaves an unfinished node running with null duration", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-web-"));
    const log = new EventLog(join(dir, "r", "run.jsonl"), fixedClock());
    log.append({ type: "node-started", node: "a", visit: 1, attempt_id: "a#1" });
    expect(deriveTimeline(log.read())).toEqual([
      expect.objectContaining({ node: "a", status: "running", duration_ms: null, finished_at: null }),
    ]);
  });
});

describe("server API", () => {
  const base = mkdtempSync(join(tmpdir(), "howdah-srv-"));
  const runsDir = join(base, "runs");
  const attentionDir = join(base, "attention");
  mkdirSync(runsDir, { recursive: true });
  const server = createHowdahServer({ runsDir, attentionDir, port: 0, pollMs: 20 });
  const url = (p: string) => `http://localhost:${server.port}${p}`;
  afterAll(() => server.stop(true));

  test("GET /api/runs lists seeded runs sorted", async () => {
    seedParkedRun(runsDir, "run-a");
    const runs = (await (await fetch(url("/api/runs"))).json()) as any[];
    expect(runs.map((r) => r.id)).toContain("run-a");
    expect(runs.find((r) => r.id === "run-a").status).toBe("needs-input");
  });

  test("GET /api/runs/:id returns detail; unknown id is 404", async () => {
    const d = (await (await fetch(url("/api/runs/run-a"))).json()) as any;
    expect(d.summary.graph).toBe("write-doc");
    expect(d.ask.reason).toBe("needs your reply");
    expect((await fetch(url("/api/runs/nope"))).status).toBe(404);
  });

  test("reply round-trips: POST resolves the ask in the log AND the attention record", async () => {
    // durable attention record exists alongside the log, as the engine would leave it
    const center = new AttentionCenter(attentionDir, []);
    await center.raise({ run: "run-a", node: "doc.review", visit: 1, reason: "needs your reply" }).catch(() => {});
    expect(center.pending()).toHaveLength(1);

    const r = await fetch(url("/api/runs/run-a/reply"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "looks good, continue" }),
    });
    expect(r.status).toBe(200);

    const events = readLog(join(runsDir, "run-a", "run.jsonl"));
    const resolved: any = events.find((e) => e.type === "attention-resolved");
    expect(resolved.reply).toBe("looks good, continue");
    expect(center.pending()).toHaveLength(0); // watchdog will not re-ring a resolved ask

    // the run's status flips — the round trip is visible in the list
    const runs = (await (await fetch(url("/api/runs"))).json()) as any[];
    expect(runs.find((x) => x.id === "run-a").status).toBe("running");

    // a second reply has nothing to answer
    const again = await fetch(url("/api/runs/run-a/reply"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(again.status).toBe(409);
  });

  test("SSE streams events appended after connect", async () => {
    seedParkedRun(runsDir, "run-sse");
    const events = readLog(join(runsDir, "run-sse", "run.jsonl"));
    const res = await fetch(url(`/api/runs/run-sse/events?since=${events.at(-1)!.seq}`));
    const reader = res.body!.getReader();

    // append a new event after the stream is open
    new EventLog(join(runsDir, "run-sse", "run.jsonl")).append({ type: "attention-resolved", node: "doc.review", visit: 1, reply: "hi" });

    // read frames until the data event arrives (first frame is the connect comment)
    let frame = "";
    for (let i = 0; i < 20 && !frame.includes("data: "); i++) {
      const { value } = await reader.read();
      frame += new TextDecoder().decode(value);
    }
    expect(frame).toContain("data: ");
    expect(frame).toContain('"attention-resolved"');
    await reader.cancel();
  });

  test("static: app shell served for page routes, assets by name", async () => {
    const shell = await (await fetch(url("/run/run-a"))).text();
    expect(shell).toContain('<div id="root">');
    const css = await fetch(url("/tokens.css"));
    expect(css.status).toBe(200);
    expect(await css.text()).toContain("--attention");
  });
});

describe("settings + open-ide (T19)", () => {
  const base2 = mkdtempSync(join(tmpdir(), "howdah-t19-"));
  const runsDir2 = join(base2, "runs");
  mkdirSync(runsDir2, { recursive: true });
  let server2: ReturnType<typeof createHowdahServer>;
  const url2 = (p: string) => `http://localhost:${server2.port}${p}`;

  test("settings round-trip via the API", async () => {
    process.env.HOWDAH_HOME = base2;
    server2 = createHowdahServer({ runsDir: runsDir2, attentionDir: join(base2, "attention"), port: 0 });
    expect(((await (await fetch(url2("/api/settings"))).json()) as any).editorCommand).toBeUndefined();
    await fetch(url2("/api/settings"), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ editorCommand: "idea", chime: false }) });
    const s = (await (await fetch(url2("/api/settings"))).json()) as any;
    expect(s).toMatchObject({ editorCommand: "idea", chime: false });
    expect(s.repos).toBeUndefined(); // workspaces are not settings
  });

  test("open-ide: 404 no folder, 410 cleaned worktree, 409 unconfigured; detail carries the button facts", async () => {
    process.env.HOWDAH_HOME = base2;
    // run with a real folder
    const folder = mkdtempSync(join(tmpdir(), "howdah-t19-folder-"));
    const log = new EventLog(join(runsDir2, "with-folder", "run.jsonl"));
    log.append({ type: "run-started", graph: "write-doc", inputs: {}, pinned_prompts: {}, cwd: folder, folder_kind: "plain" });
    // run whose folder is gone
    const gone = new EventLog(join(runsDir2, "gone-folder", "run.jsonl"));
    gone.append({ type: "run-started", graph: "write-doc", inputs: {}, pinned_prompts: {}, cwd: join(folder, "deleted"), folder_kind: "repo" });
    // run with no folder at all
    const plain = new EventLog(join(runsDir2, "no-folder", "run.jsonl"));
    plain.append({ type: "run-started", graph: "research", inputs: {}, pinned_prompts: {} });

    const detail = (await (await fetch(url2("/api/runs/with-folder"))).json()) as any;
    expect(detail).toMatchObject({ cwd_exists: true, editor_configured: true });

    expect((await fetch(url2("/api/runs/no-folder/open-ide"), { method: "POST" })).status).toBe(404);
    expect((await fetch(url2("/api/runs/gone-folder/open-ide"), { method: "POST" })).status).toBe(410);

    // unconfigure the editor → 409 routes the user to Settings
    await fetch(url2("/api/settings"), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ editorCommand: "" }) });
    expect((await fetch(url2("/api/runs/with-folder/open-ide"), { method: "POST" })).status).toBe(409);
    server2.stop(true);
  });
});

describe("graph shape API (T20)", () => {
  test("GET /api/graphs/:name serializes nodes + edge labels for the DAG", async () => {
    const base3 = mkdtempSync(join(tmpdir(), "howdah-t20-"));
    mkdirSync(join(base3, "runs"), { recursive: true });
    const s3 = createHowdahServer({ runsDir: join(base3, "runs"), attentionDir: join(base3, "attention"), port: 0 });
    const shape = (await (await fetch(`http://localhost:${s3.port}/api/graphs/write-doc`)).json()) as any;
    expect(shape.entry).toBe("doc.outline");
    expect(shape.nodes.find((n: any) => n.id === "doc.draft")).toMatchObject({ kind: "agent", prompt: "doc.draft" });
    expect(shape.edges.some((e: any) => e.label === "review_verdict == 'reject'")).toBe(true);
    expect((await fetch(`http://localhost:${s3.port}/api/graphs/nope`)).status).toBe(404);
    s3.stop(true);
  });
});

describe("failure visibility + reply-resumes (blog-post regression)", () => {
  test("a failed node's park reason survives ask resolution as summary.failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-fail-"));
    const log = new EventLog(join(dir, "r", "run.jsonl"));
    log.append({ type: "run-started", graph: "write-doc", inputs: { goal: "g" }, pinned_prompts: {} });
    log.append({ type: "node-started", node: "doc.review", visit: 1, attempt_id: "doc.review#1" });
    log.append({ type: "node-finished", node: "doc.review", visit: 1, status: "failed", writes: {} });
    log.append({ type: "attention-raised", node: "doc.review", visit: 1, reason: "executor threw: reviewer needs your call" });

    let s = deriveSummary("r", log.read());
    expect(s.status).toBe("needs-input");
    expect(s.failure).toMatchObject({ node: "doc.review", reason: "executor threw: reviewer needs your call" });

    // the ask gets answered — the WHY must remain visible on the failed run
    log.append({ type: "attention-resolved", node: "doc.review", visit: 1, reply: "yes" });
    s = deriveSummary("r", log.read());
    expect(s.status).toBe("failed-recoverable");
    expect(s.failure).toMatchObject({ node: "doc.review", visit: 1, reason: "executor threw: reviewer needs your call" });

    // a successful re-attempt clears the failure state
    log.append({ type: "node-started", node: "doc.review", visit: 2, attempt_id: "doc.review#2" });
    log.append({ type: "node-finished", node: "doc.review", visit: 2, status: "succeeded", writes: {} });
    expect(deriveSummary("r", log.read()).status).toBe("running");
  });

  test("web reply spawns a resume when the runner is dead", async () => {
    const base = mkdtempSync(join(tmpdir(), "howdah-replyres-"));
    const runsDir = join(base, "runs");
    mkdirSync(runsDir, { recursive: true });
    process.env.HOWDAH_HOME = base;
    process.env.HOWDAH_STUB = "1";
    const server = createHowdahServer({ runsDir, attentionDir: join(base, "attention"), port: 0 });
    try {
      // seed a parked run with pinned prompts so resume can rebuild it
      const { Engine } = await import("../engine/run");
      const { writeDoc } = await import("../graphs/write-doc");
      const engine = new Engine(writeDoc, {
        dir: join(runsDir, "parked"),
        executors: { agent: async ({ nodeId }) => {
          if (nodeId === "doc.review") throw new Error("needs your call");
          return { status: "succeeded", writes: nodeId === "doc.outline" ? { doc_outline: "o" } : { doc_summary: "s" } };
        } },
      });
      const parked = await engine.start({ goal: "g", work: "w" });
      expect(parked.state).toBe("parked");

      await fetch(`http://localhost:${server.port}/api/runs/parked/reply`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "yes go" }),
      });
      // the detached stub resume re-attempts doc.review, which parks on the stub registry
      let resumed = false;
      for (let i = 0; i < 60 && !resumed; i++) {
        await Bun.sleep(100);
        const events = readLog(join(runsDir, "parked", "run.jsonl"));
        resumed = events.some((e: any) => e.type === "node-started" && e.node === "doc.review" && e.visit === 2);
      }
      expect(resumed).toBe(true); // the reply MOVED the run
    } finally {
      server.stop(true);
      delete process.env.HOWDAH_STUB;
    }
  }, 15000);
});

describe("workspace registration (repo-picker gap)", () => {
  test("POST detects git repos vs plain folders, validates, and DELETE removes", async () => {
    const base = mkdtempSync(join(tmpdir(), "howdah-ws-"));
    mkdirSync(join(base, "runs"), { recursive: true });
    process.env.HOWDAH_HOME = base;
    const server = createHowdahServer({ runsDir: join(base, "runs"), attentionDir: join(base, "attention"), port: 0 });
    const url = (p: string) => `http://localhost:${server.port}${p}`;
    const post = (body: unknown) => fetch(url("/api/workspaces"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      // a real git repo → kind repo with detected default branch
      const repoDir = mkdtempSync(join(tmpdir(), "howdah-ws-repo-"));
      const { execSync } = await import("node:child_process");
      execSync("git init -q -b main && git config user.email t@t && git config user.name t", { cwd: repoDir });
      const r1 = await post({ name: "my-api", path: repoDir });
      expect(r1.status).toBe(201);
      expect(await r1.json()).toMatchObject({ kind: "repo", defaultBranch: "main" });

      // a plain folder → kind plain
      const folder = mkdtempSync(join(tmpdir(), "howdah-ws-plain-"));
      expect((await (await post({ name: "notes", path: folder })).json())).toMatchObject({ kind: "plain" });

      // validation: missing path, bad name, duplicate
      expect((await post({ name: "ghost", path: join(base, "nope") })).status).toBe(400);
      expect((await post({ name: "bad name!", path: folder })).status).toBe(400);
      expect((await post({ name: "my-api", path: repoDir })).status).toBe(409);

      // list reflects both; the form's repo-required picker now has an option
      const ws = (await (await fetch(url("/api/workspaces"))).json()) as any;
      expect(ws.repos.map((w: any) => w.name)).toEqual(["my-api"]);
      expect(ws.folders.map((w: any) => w.name)).toEqual(["notes"]);

      // delete
      expect((await fetch(url("/api/workspaces"), { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "notes" }) })).status).toBe(200);
      const after = (await (await fetch(url("/api/workspaces"))).json()) as any;
      expect(after.folders).toEqual([]);
    } finally {
      server.stop(true);
    }
  });
});
