import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, readLog } from "../log/write";
import { deriveStatus, deriveSummary, deriveDetail, deriveTimeline, deriveLogRows, deriveContextTable, runDigest, citeParts, sortRuns } from "./derive";
import { createHowdahServer, guardRequest } from "./server";
import { AttentionCenter } from "../engine/attention";
import { renderedHash } from "../core/template";

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

  test("later progress makes an unresolved ask stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-web-"));
    const log = new EventLog(join(dir, "r1", "run.jsonl"), fixedClock());
    log.append({ type: "run-started", graph: "write-doc", inputs: { goal: "g" }, pinned_prompts: {} });
    log.append({ type: "node-started", node: "probe", visit: 1, attempt_id: "probe#1" });
    log.append({ type: "node-finished", node: "probe", visit: 1, status: "failed", writes: {} });
    log.append({ type: "attention-raised", node: "probe", visit: 1, reason: "forge unreachable" });
    expect(deriveStatus(log.read()).status).toBe("needs-input");

    log.append({ type: "operator-jump", to: "fix_ci", message: "move on" });
    log.append({ type: "node-started", node: "fix_ci", visit: 1, attempt_id: "fix_ci#1" });
    const status = deriveStatus(log.read());
    expect(status.status).toBe("running");
    expect(status.ask).toBeNull();
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

  test("an unfinished node with no live runner is reported as harness-dead", async () => {
    const id = "dead-runner";
    const log = new EventLog(join(runsDir, id, "run.jsonl"), fixedClock());
    log.append({ type: "run-started", graph: "write-doc", inputs: { goal: "g" }, pinned_prompts: {} });
    log.append({ type: "node-started", node: "doc.draft", visit: 1, attempt_id: "doc.draft#1" });

    const d = (await (await fetch(url(`/api/runs/${id}`))).json()) as any;
    expect(d.summary.status).toBe("harness-dead");
    const runs = (await (await fetch(url("/api/runs"))).json()) as any[];
    expect(runs.find((r) => r.id === id).status).toBe("harness-dead");
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

  test("pause records a paused state and interrupts a live runner", async () => {
    const id = "pause-live";
    const log = new EventLog(join(runsDir, id, "run.jsonl"), fixedClock());
    log.append({ type: "run-started", graph: "write-doc", inputs: { goal: "pause me" }, pinned_prompts: { "doc.draft": 1 } });
    log.append({ type: "node-started", node: "doc.draft", visit: 1, attempt_id: "doc.draft#1" });
    const child = Bun.spawn(["sh", "-c", "sleep 30"], { stdout: "ignore", stderr: "ignore" });
    writeFileSync(join(runsDir, id, "runner.pid"), String(child.pid));

    const res = await fetch(url(`/api/runs/${id}/pause`), { method: "POST" });
    expect(res.status).toBe(202);
    expect((await res.json()) as any).toMatchObject({ ok: true, interrupted: true });
    expect(readLog(join(runsDir, id, "run.jsonl")).some((e) => e.type === "run-paused")).toBe(true);
    await Bun.sleep(50);
    expect(() => process.kill(child.pid, 0)).toThrow();
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
    const app = (await (await fetch(url2("/api/app"))).json()) as any;
    expect(app).toMatchObject({ home: base2, runsDir: runsDir2, configPath: join(base2, "config.json") });
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
    expect(detail.persistence).toMatchObject({
      home: base2,
      run_dir: join(runsDir2, "with-folder"),
      log_path: join(runsDir2, "with-folder", "run.jsonl"),
      runner_alive: false,
    });

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

describe("graph tuning API", () => {
  test("PUT round-trips, rejects unknown nodes, prunes empties, and effective values shift", async () => {
    const base = mkdtempSync(join(tmpdir(), "howdah-tuneapi-"));
    mkdirSync(join(base, "runs"), { recursive: true });
    process.env.HOWDAH_HOME = base;
    const server = createHowdahServer({ runsDir: join(base, "runs"), attentionDir: join(base, "attention"), port: 0 });
    const url = (p: string) => `http://localhost:${server.port}${p}`;
    try {
      const put = (body: unknown) => fetch(url("/api/graphs/write-doc/tuning"), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

      // unknown node refused — a typo must not silently no-op
      expect((await put({ nodes: { "doc.ghost": { model: "x" } } })).status).toBe(400);

      // tune one node + graph defaults
      expect((await put({ defaults: { effort: "low" }, nodes: { "doc.draft": { model: "claude-opus-5", effort: "" } } })).status).toBe(200);
      const shape = (await (await fetch(url("/api/graphs/write-doc"))).json()) as any;
      const draft = shape.nodes.find((n: any) => n.id === "doc.draft");
      expect(draft.node_tuning).toEqual({ model: "claude-opus-5" }); // empty effort pruned
      expect(draft.effective).toMatchObject({ model: "claude-opus-5", effort: "low" });
      const review = shape.nodes.find((n: any) => n.id === "doc.review");
      expect(review.effective).toMatchObject({ effort: "low" }); // graph tuning reaches untouched nodes
      expect(review.node_tuning).toBeUndefined();

      // clearing everything removes the overlay entirely
      expect((await put({})).status).toBe(200);
      const after = (await (await fetch(url("/api/graphs/write-doc"))).json()) as any;
      expect(after.tuning).toEqual({});
    } finally {
      server.stop(true);
    }
  });
});

// ---- prompt library + proposal review (T21) ---------------------------------------

/** a repo-shaped root so these tests never touch the real prompts/ or feedback/ */
function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "howdah-t21-repo-"));
  mkdirSync(join(root, "prompts"), { recursive: true });
  mkdirSync(join(root, "feedback"), { recursive: true });
  mkdirSync(join(root, "reviser", "proposals"), { recursive: true });
  // doc.outline is consumed by the real write-doc graph, which declares reads goal + work —
  // that is what makes the OV-3 undeclared-read guard testable through the API
  writeFileSync(
    join(root, "prompts", "doc.outline.md"),
    `---\nid: doc.outline\nversion: 1\ntags: [doc]\n---\nOutline {{ context.goal }} for {{ context.work }}.\n`,
  );
  return root;
}

function seedProposalFile(root: string, opts: { id: string; base: number; body: string; status?: string }) {
  const file = `${opts.id}.v${opts.base + 1}.proposal.md`;
  writeFileSync(
    join(root, "reviser", "proposals", file),
    `---\nid: ${opts.id}\nbase_version: ${opts.base}\nproposed_version: ${opts.base + 1}\nstatus: ${opts.status ?? "pending"}\ncreated: 2026-09-15T00:00:00Z\n---\n${opts.body}`,
  );
  return file;
}

describe("prompt library API (T21)", () => {
  test("list + detail expose consumers, feedback and outcomes; unknown ids 404", async () => {
    const root = fixtureRepo();
    const base = mkdtempSync(join(tmpdir(), "howdah-t21-"));
    const runsDir = join(base, "runs");
    mkdirSync(runsDir, { recursive: true });
    process.env.HOWDAH_HOME = base;
    // a run that rendered doc.outline and finished — the outcome join has something to find
    const log = new EventLog(join(runsDir, "r-doc", "run.jsonl"), fixedClock());
    log.append({ type: "run-started", graph: "write-doc", inputs: { goal: "g" }, pinned_prompts: { "doc.outline": 1 } });
    log.append({ type: "prompt-rendered", node: "doc.outline", visit: 1, prompt: "doc.outline", prompt_version: 1, rendered_hash: "abc123", context_read: { goal: "g", work: "w" } });
    log.append({ type: "prompt-outcome", rendered_hash: "abc123", node: "doc.outline", visit: 1, terminal_outcome: "success" });
    log.append({ type: "run-finished", outcome: "success" });

    const server = createHowdahServer({ runsDir, attentionDir: join(base, "attention"), port: 0, repoRoot: root });
    const url = (p: string) => `http://localhost:${server.port}${p}`;
    try {
      const list = (await (await fetch(url("/api/prompts"))).json()) as any[];
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: "doc.outline", version: 1, tags: ["doc"] });
      expect(list[0].consumers).toEqual([{ graph: "write-doc", node: "doc.outline" }]);
      expect(list[0].outcomes).toMatchObject({ renders: 1, success: 1, pending: 0 });

      const detail = (await (await fetch(url("/api/prompts/doc.outline"))).json()) as any;
      expect(detail.body).toContain("{{ context.goal }}");
      expect(detail.outcome_rows[0]).toMatchObject({ run: "r-doc", node: "doc.outline", terminal_outcome: "success" });

      expect((await fetch(url("/api/prompts/nope"))).status).toBe(404);
      // a traversal attempt is an unknown id, not a file read
      expect((await fetch(url("/api/prompts/..%2F..%2Fetc%2Fpasswd"))).status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  test("feedback POST lands in feedback/<id>.jsonl and shows up in detail; junk is refused", async () => {
    const root = fixtureRepo();
    const base = mkdtempSync(join(tmpdir(), "howdah-t21-"));
    const runsDir = join(base, "runs");
    mkdirSync(runsDir, { recursive: true });
    process.env.HOWDAH_HOME = base;
    const server = createHowdahServer({ runsDir, attentionDir: join(base, "attention"), port: 0, repoRoot: root });
    const url = (p: string) => `http://localhost:${server.port}${p}`;
    const post = (body: unknown) =>
      fetch(url("/api/prompts/doc.outline/feedback"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const good = { run: "r-doc", node: "doc.outline", visit: 1, note: "outlines are too long", verdict: "reject", rendered_hash: "abc123" };
      const res = await post(good);
      expect(res.status).toBe(201);
      expect(((await res.json()) as any).entry).toMatchObject({ run: "r-doc", verdict: "reject", note: "outlines are too long" });

      const written = readFileSync(join(root, "feedback", "doc.outline.jsonl"), "utf8").trim().split("\n");
      expect(written).toHaveLength(1);
      expect(JSON.parse(written[0]!)).toMatchObject({ node: "doc.outline", visit: 1, rendered_hash: "abc123" });

      const detail = (await (await fetch(url("/api/prompts/doc.outline"))).json()) as any;
      expect(detail.feedback).toMatchObject({ count: 1, rejects: 1 });
      expect(detail.feedback_entries[0].note).toBe("outlines are too long");

      // the reviser's inputs are validated at the door
      expect((await post({ ...good, note: "" })).status).toBe(400);
      expect((await post({ ...good, verdict: "sideways" })).status).toBe(400);
      expect((await post({ ...good, rendered_hash: "" })).status).toBe(400);
      expect(readFileSync(join(root, "feedback", "doc.outline.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });

  test("render endpoint rebuilds a turn's prompt and proves it by re-hashing", async () => {
    const root = fixtureRepo();
    const base = mkdtempSync(join(tmpdir(), "howdah-t21-"));
    const runsDir = join(base, "runs");
    mkdirSync(join(runsDir, "r-render", "prompts"), { recursive: true });
    process.env.HOWDAH_HOME = base;
    // pin the prompt into the run dir exactly as the engine does, and hash the same text
    writeFileSync(join(runsDir, "r-render", "prompts", "doc.outline.md"), readFileSync(join(root, "prompts", "doc.outline.md"), "utf8"));
    const text = "Outline ship it for the blog post.\n";
    const hash = renderedHash(text);
    const log = new EventLog(join(runsDir, "r-render", "run.jsonl"), fixedClock());
    log.append({ type: "run-started", graph: "write-doc", inputs: {}, pinned_prompts: { "doc.outline": 1 } });
    log.append({ type: "prompt-rendered", node: "doc.outline", visit: 1, prompt: "doc.outline", prompt_version: 1, rendered_hash: hash, context_read: { goal: "ship it", work: "the blog post" } });

    const server = createHowdahServer({ runsDir, attentionDir: join(base, "attention"), port: 0, repoRoot: root });
    const url = (p: string) => `http://localhost:${server.port}${p}`;
    try {
      const r = (await (await fetch(url(`/api/runs/r-render/render/${hash}`))).json()) as any;
      expect(r).toMatchObject({ verified: true, text, prompt: "doc.outline", prompt_version: 1, node: "doc.outline", visit: 1 });
      expect((await fetch(url("/api/runs/r-render/render/ffffffffffffffff"))).status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});

describe("proposal review API (T21)", () => {
  function serve(root: string) {
    const base = mkdtempSync(join(tmpdir(), "howdah-t21-"));
    const runsDir = join(base, "runs");
    mkdirSync(runsDir, { recursive: true });
    process.env.HOWDAH_HOME = base;
    const server = createHowdahServer({ runsDir, attentionDir: join(base, "attention"), port: 0, repoRoot: root });
    return { server, url: (p: string) => `http://localhost:${server.port}${p}` };
  }

  test("accept bumps the prompt to v+1 and marks the proposal accepted", async () => {
    const root = fixtureRepo();
    const file = seedProposalFile(root, { id: "doc.outline", base: 1, body: "Outline {{ context.goal }} for {{ context.work }}, tightly.\n" });
    const { server, url } = serve(root);
    try {
      const res = await fetch(url(`/api/proposals/${file}/accept`), { method: "POST" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, version: 2 });

      const prompt = readFileSync(join(root, "prompts", "doc.outline.md"), "utf8");
      expect(prompt).toContain("version: 2");
      expect(prompt).toContain("tightly.");
      expect(prompt).toContain("provenance:");

      const list = (await (await fetch(url("/api/proposals"))).json()) as any[];
      expect(list[0]).toMatchObject({ id: "doc.outline", status: "accepted", current_version: 2 });
      // accepting twice is refused — the lifecycle is one-way
      expect((await fetch(url(`/api/proposals/${file}/accept`), { method: "POST" })).status).toBe(409);
    } finally {
      server.stop(true);
    }
  });

  test("a stale base is refused with the re-draft reason (D7)", async () => {
    const root = fixtureRepo();
    const file = seedProposalFile(root, { id: "doc.outline", base: 0, body: "Outline {{ context.goal }}.\n" }); // prompt is v1
    const { server, url } = serve(root);
    try {
      const list = (await (await fetch(url("/api/proposals"))).json()) as any[];
      expect(list[0]).toMatchObject({ stale: true, base_version: 0, current_version: 1 });

      const res = await fetch(url(`/api/proposals/${file}/accept`), { method: "POST" });
      expect(res.status).toBe(409);
      expect(((await res.json()) as any).error).toMatch(/stale base/);
      expect(readFileSync(join(root, "prompts", "doc.outline.md"), "utf8")).toContain("version: 1"); // untouched
    } finally {
      server.stop(true);
    }
  });

  test("a revision introducing an undeclared read is refused (OV-3)", async () => {
    const root = fixtureRepo();
    const file = seedProposalFile(root, { id: "doc.outline", base: 1, body: "Outline {{ context.goal }} using {{ context.secret_plan }}.\n" });
    const { server, url } = serve(root);
    try {
      const res = await fetch(url(`/api/proposals/${file}/accept`), { method: "POST" });
      expect(res.status).toBe(409);
      expect(((await res.json()) as any).error).toMatch(/undeclared reads[\s\S]*secret_plan/);
      expect(readFileSync(join(root, "prompts", "doc.outline.md"), "utf8")).toContain("version: 1");
    } finally {
      server.stop(true);
    }
  });

  test("reject requires a reason and records it as reviser input", async () => {
    const root = fixtureRepo();
    const file = seedProposalFile(root, { id: "doc.outline", base: 1, body: "whatever\n" });
    const { server, url } = serve(root);
    const post = (body?: unknown) =>
      fetch(url(`/api/proposals/${file}/reject`), { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    try {
      expect((await post({ reason: "   " })).status).toBe(400);
      expect((await post()).status).toBe(400); // no body at all
      expect((await post({ reason: "drops the audience line" })).status).toBe(200);
      const list = (await (await fetch(url("/api/proposals"))).json()) as any[];
      expect(list[0]).toMatchObject({ status: "rejected", rejection_reason: "drops the audience line" });
      expect(readFileSync(join(root, "prompts", "doc.outline.md"), "utf8")).toContain("version: 1"); // rejection changes nothing
    } finally {
      server.stop(true);
    }
  });

  test("redraft is accepted for a known proposal and 404s for anything else", async () => {
    const root = fixtureRepo();
    const file = seedProposalFile(root, { id: "doc.outline", base: 0, body: "stale one\n" });
    const { server, url } = serve(root);
    process.env.HOWDAH_STUB = "1"; // never spawn the real reviser (it spends tokens) in tests
    try {
      const res = await fetch(url(`/api/proposals/${file}/redraft`), { method: "POST" });
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ drafting: "doc.outline", stubbed: true });

      expect((await fetch(url("/api/proposals/ghost.v2.proposal.md/redraft"), { method: "POST" })).status).toBe(404);
      // path traversal and non-proposal names are refused before any file is touched
      expect((await fetch(url("/api/proposals/..%2F..%2Fprompts%2Fdoc.outline.md/accept"), { method: "POST" })).status).toBe(404);
      expect((await fetch(url("/api/proposals/notes.md/accept"), { method: "POST" })).status).toBe(404);
    } finally {
      delete process.env.HOWDAH_STUB;
      server.stop(true);
    }
  });
});

// ---- steps axis (story 3) ---------------------------------------------------------

describe("deriveTimeline axis", () => {
  test("rows carry an offset and a shared span", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-axis-"));
    const log = new EventLog(join(dir, "r", "run.jsonl"), fixedClock());
    log.append({ type: "node-started", node: "a", visit: 1, attempt_id: "a#1" });   // t+1s
    log.append({ type: "node-finished", node: "a", visit: 1, status: "succeeded", writes: {} }); // t+2s
    log.append({ type: "node-started", node: "b", visit: 1, attempt_id: "b#1" });   // t+3s
    log.append({ type: "node-finished", node: "b", visit: 1, status: "succeeded", writes: {} }); // t+4s
    const rows = deriveTimeline(log.read());
    expect(rows.map((r) => r.offset_ms)).toEqual([0, 2000]);
    expect(rows.every((r) => r.run_span_ms === 3000)).toBe(true);
  });

  test("a running step stretches the span to the last event, and never divides by zero", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-axis-"));
    const log = new EventLog(join(dir, "r", "run.jsonl"), fixedClock());
    log.append({ type: "node-started", node: "a", visit: 1, attempt_id: "a#1" });
    log.append({ type: "chunk", node: "a", visit: 1, turn: 1, index: 0, kind: "text", content: "…" });
    const rows = deriveTimeline(log.read());
    expect(rows[0]!.duration_ms).toBeNull();
    expect(rows[0]!.run_span_ms).toBeGreaterThan(0);
  });

  test("a repeated start for the same visit closes the abandoned attempt", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-axis-"));
    const log = new EventLog(join(dir, "r", "run.jsonl"), fixedClock());
    log.append({ type: "node-started", node: "repair", visit: 2, attempt_id: "repair#2" });
    log.append({ type: "chunk", node: "repair", visit: 2, turn: 1, index: 0, kind: "text", content: "stale" });
    log.append({ type: "node-started", node: "repair", visit: 2, attempt_id: "repair#2b" });
    const rows = deriveTimeline(log.read());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ node: "repair", visit: 2, status: "failed", duration_ms: 2000 });
    expect(rows[1]).toMatchObject({ node: "repair", visit: 2, status: "running", duration_ms: null });
  });

  test("a jump to another node closes the prior unfinished row", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-axis-"));
    const log = new EventLog(join(dir, "r", "run.jsonl"), fixedClock());
    log.append({ type: "node-started", node: "fix_ci", visit: 1, attempt_id: "fix_ci#1" });
    log.append({ type: "chunk", node: "fix_ci", visit: 1, turn: 1, index: 0, kind: "text", content: "working" });
    log.append({ type: "node-started", node: "revise_repairs", visit: 2, attempt_id: "revise_repairs#2" });
    const rows = deriveTimeline(log.read());
    expect(rows[0]).toMatchObject({ node: "fix_ci", status: "failed", duration_ms: 2000 });
    expect(rows[1]).toMatchObject({ node: "revise_repairs", status: "running", duration_ms: null });
  });

  test("an empty log has no rows and no axis", () => {
    expect(deriveTimeline([])).toEqual([]);
  });
});

// ---- the waiting split (story 4) --------------------------------------------------

describe("deriveTimeline waiting split", () => {
  test("an ask answered mid-attempt is charged to that step, and sums with its work", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-wait-"));
    const log = new EventLog(join(dir, "r", "run.jsonl"), fixedClock());
    log.append({ type: "node-started", node: "a", visit: 1, attempt_id: "a#1" });          // +1s
    log.append({ type: "attention-raised", node: "a", visit: 1, reason: "Bash needs permission" }); // +2s
    log.append({ type: "attention-resolved", node: "a", visit: 1, reply: "yes" });          // +3s
    log.append({ type: "node-finished", node: "a", visit: 1, status: "succeeded", writes: {} }); // +4s
    const row = deriveTimeline(log.read())[0]!;
    expect(row.duration_ms).toBe(3000);
    expect(row.waiting_ms).toBe(1000);
  });

  test("a run parked AFTER a step failed does not charge that wait to the step", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-wait-"));
    const log = new EventLog(join(dir, "r", "run.jsonl"), fixedClock());
    log.append({ type: "node-started", node: "a", visit: 1, attempt_id: "a#1" });
    log.append({ type: "node-finished", node: "a", visit: 1, status: "failed", writes: {} });
    log.append({ type: "attention-raised", node: "a", visit: 1, reason: "executor threw" });
    log.append({ type: "attention-resolved", node: "a", visit: 1, reply: "resume" });
    expect(deriveTimeline(log.read())[0]!.waiting_ms).toBe(0);
  });

  test("an unanswered ask keeps counting to now", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-wait-"));
    const log = new EventLog(join(dir, "r", "run.jsonl"), fixedClock());
    log.append({ type: "node-started", node: "a", visit: 1, attempt_id: "a#1" });
    log.append({ type: "attention-raised", node: "a", visit: 1, reason: "needs you" });
    log.append({ type: "chunk", node: "a", visit: 1, turn: 1, index: 0, kind: "text", content: "…" });
    const row = deriveTimeline(log.read())[0]!;
    expect(row.waiting_ms).toBeGreaterThan(0);
    expect(row.finished_at).toBeNull();
  });

  test("a step that never asked has no waiting time", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-wait-"));
    const log = new EventLog(join(dir, "r", "run.jsonl"), fixedClock());
    log.append({ type: "node-started", node: "a", visit: 1, attempt_id: "a#1" });
    log.append({ type: "node-finished", node: "a", visit: 1, status: "succeeded", writes: {} });
    expect(deriveTimeline(log.read())[0]!.waiting_ms).toBe(0);
  });
});

// ---- log rows (story 7) -----------------------------------------------------------

describe("deriveLogRows", () => {
  test("summarises one row per event and nests tool detail", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-logrows-"));
    const rows = deriveLogRows(seedParkedRun(dir, "r-logs").read());
    expect(rows).toHaveLength(9);
    const byType = Object.fromEntries(rows.map((r) => [r.type, r]));
    expect(byType["run-started"]!.kind).toBe("engine");
    expect(byType["prompt-rendered"]!.summary).toContain("doc.draft v1");
    expect(byType["attention-raised"]!.kind).toBe("attention");
    expect(byType["chunk"]!.depth).toBe(1);
    expect(rows.find((r) => r.type === "chunk" && r.kind === "tool")).toBeDefined();
  });

  test("an exhausted allowance is attention, a healthy one is not", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-logrows-"));
    const log = new EventLog(join(dir, "r", "run.jsonl"), fixedClock());
    log.append({ type: "allowance", harness: "claude", state: "ok", remaining: 0.4 });
    log.append({ type: "allowance", harness: "codex", state: "exhausted", resets_at: "18:00" });
    const rows = deriveLogRows(log.read());
    expect(rows[0]!.kind).toBe("engine");
    expect(rows[1]!.kind).toBe("attention");
  });

  test("every event type in the union is handled", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-logrows-"));
    const log = new EventLog(join(dir, "r", "run.jsonl"), fixedClock());
    log.append({ type: "run-started", graph: "g", inputs: {}, pinned_prompts: {} });
    log.append({ type: "node-started", node: "a", visit: 1, attempt_id: "a#1" });
    log.append({ type: "prompt-rendered", node: "a", visit: 1, prompt: "discover" as never, prompt_version: 1, rendered_hash: "h", context_read: {} });
    log.append({ type: "chunk", node: "a", visit: 1, turn: 1, index: 0, kind: "tool_call", content: "ls", tool_name: "Bash" });
    log.append({ type: "turn-finalized", node: "a", visit: 1, turn: 1, usage: { input_tokens: 1, output_tokens: 2, cost_usd: 0.1 } });
    log.append({ type: "prompt-outcome", rendered_hash: "h", node: "a", visit: 1, terminal_outcome: "success" });
    log.append({ type: "node-finished", node: "a", visit: 1, status: "succeeded", writes: { k: 1 } });
    log.append({ type: "side-effect-intent", node: "a", visit: 1, attempt_id: "a#1", effect: "create-pr" });
    log.append({ type: "side-effect-done", node: "a", visit: 1, attempt_id: "a#1", effect: "create-pr" });
    log.append({ type: "reconciled", node: "a", git: { repo: true, branch: "b", head: "h", uncommitted: 0, unpushed: 0 }, forge: { kind: "no-pr" }, disagreements: [] });
    log.append({ type: "edge-taken", from: "a", to: "b", label: "ok" });
    log.append({ type: "attention-raised", node: "a", visit: 1, reason: "needs you" });
    log.append({ type: "attention-resolved", node: "a", visit: 1, reply: "go" });
    log.append({ type: "operator-jump", to: "a", message: "focus here" });
    log.append({ type: "run-paused", by: "operator" });
    log.append({ type: "run-resumed", by: "operator" });
    log.append({ type: "allowance", harness: "claude", state: "ok" });
    log.append({ type: "run-finished", outcome: "success" });
    const rows = deriveLogRows(log.read());
    expect(rows).toHaveLength(18);
    expect(rows.every((r) => r.summary.length > 0)).toBe(true);
    expect(new Set(rows.map((r) => r.type)).size).toBe(18);
  });
});

describe("log rows carry the stored event", () => {
  test("the raw form is the event as written, not a re-render", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-raw-"));
    const log = new EventLog(join(dir, "r", "run.jsonl"), fixedClock());
    log.append({ type: "attention-raised", node: "a", visit: 1, reason: "needs you", ask: { kind: "can_use_tool" } });
    const stored = log.read()[0]!;
    const row = deriveLogRows(log.read())[0]!;
    expect(row.raw).toEqual(stored);
    expect(JSON.parse(JSON.stringify(row.raw))).toEqual(stored);
  });

  test("run detail exposes the same rows the Logs tab renders", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-raw-"));
    const events = seedParkedRun(dir, "r-detail").read();
    expect(deriveDetail("r-detail", events).log_rows).toEqual(deriveLogRows(events));
  });
});

// ---- context table (stories 9 + 10) -----------------------------------------------

const DECL = {
  goal: { scope: "sticky" as const, writer: ["__inputs__"] },
  implementation_plan: { scope: "sticky" as const, writer: ["plan", "plan_review"] },
  review_verdict: { scope: "cleared" as const, writer: ["local_review"] },
  "worktree.clean": { scope: "per-visit" as const, writer: ["cleanup"] },
};

describe("deriveContextTable", () => {
  function run(dir: string) {
    const log = new EventLog(join(dir, "r", "run.jsonl"), fixedClock());
    log.append({ type: "run-started", graph: "g", inputs: {}, pinned_prompts: {} });
    log.append({ type: "node-started", node: "plan", visit: 1, attempt_id: "plan#1" });
    log.append({ type: "prompt-rendered", node: "plan", visit: 1, prompt: "implementation.plan" as never, prompt_version: 1, rendered_hash: "h1", context_read: { goal: "g" } });
    log.append({ type: "node-finished", node: "plan", visit: 1, status: "succeeded", writes: { implementation_plan: "v1" } });
    return log;
  }

  test("lists declared keys that nothing has written yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-ctx-"));
    const table = deriveContextTable(run(dir).read(), DECL);
    const clean = table.find((c) => c.key === "worktree.clean")!;
    expect(clean.written).toBe(false);
    expect(clean.value).toBeUndefined();
    expect(clean.declared_writers).toEqual(["cleanup"]);
    expect(clean.scope).toBe("per-visit");
  });

  test("the latest published value wins and the earlier write is marked replaced", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-ctx-"));
    const log = run(dir);
    log.append({ type: "node-started", node: "plan_review", visit: 1, attempt_id: "plan_review#1" });
    log.append({ type: "node-finished", node: "plan_review", visit: 1, status: "succeeded", writes: { implementation_plan: "v2" } });
    const plan = deriveContextTable(log.read(), DECL).find((c) => c.key === "implementation_plan")!;
    expect(plan.value).toBe("v2");
    expect(plan.writes.map((w) => [w.node, w.replaced])).toEqual([["plan", false], ["plan_review", true]]);
  });

  test("a failed attempt publishes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-ctx-"));
    const log = new EventLog(join(dir, "r", "run.jsonl"), fixedClock());
    log.append({ type: "node-started", node: "plan", visit: 1, attempt_id: "plan#1" });
    log.append({ type: "node-finished", node: "plan", visit: 1, status: "failed", writes: {} });
    const plan = deriveContextTable(log.read(), DECL).find((c) => c.key === "implementation_plan")!;
    expect(plan.written).toBe(false);
  });

  test("a cleared key is veiled while its writer is mid-attempt", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-ctx-"));
    const log = new EventLog(join(dir, "r", "run.jsonl"), fixedClock());
    log.append({ type: "node-started", node: "local_review", visit: 1, attempt_id: "local_review#1" });
    log.append({ type: "node-finished", node: "local_review", visit: 1, status: "succeeded", writes: { review_verdict: "pass" } });
    log.append({ type: "node-started", node: "local_review", visit: 2, attempt_id: "local_review#2" });
    const verdict = deriveContextTable(log.read(), DECL).find((c) => c.key === "review_verdict")!;
    expect(verdict.veiled).toBe(true);
  });

  test("read_by names every prompt that consumed the key, once", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-ctx-"));
    const log = run(dir);
    log.append({ type: "prompt-rendered", node: "implement", visit: 1, prompt: "implementation.implement" as never, prompt_version: 1, rendered_hash: "h2", context_read: { goal: "g" } });
    log.append({ type: "prompt-rendered", node: "implement", visit: 2, prompt: "implementation.implement" as never, prompt_version: 1, rendered_hash: "h3", context_read: { goal: "g" } });
    const goal = deriveContextTable(log.read(), DECL).find((c) => c.key === "goal")!;
    expect(goal.read_by).toEqual(["implementation.plan", "implementation.implement"]);
  });

  test("an empty run still lists every declared key", () => {
    expect(deriveContextTable([], DECL).map((c) => c.key).sort()).toEqual(Object.keys(DECL).sort());
  });
});

// ---- run digest (story 11) --------------------------------------------------------

describe("runDigest", () => {
  test("names the status, the wait and the steps", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-digest-"));
    const d = runDigest("r1", seedParkedRun(dir, "r1").read());
    expect(d).toContain("RUN r1");
    expect(d).toContain("graph: write-doc");
    expect(d).toContain("WAITING ON A HUMAN");
    expect(d).toContain("doc.draft@1");
    expect(d).toContain("PROMPTS RENDERED");
  });

  test("is bounded: a huge run does not paste the whole log", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-digest-"));
    const log = new EventLog(join(dir, "r", "run.jsonl"), fixedClock());
    log.append({ type: "run-started", graph: "g", inputs: {}, pinned_prompts: {} });
    for (let i = 0; i < 400; i++) {
      log.append({ type: "node-started", node: `n${i}`, visit: 1, attempt_id: `n${i}#1` });
      log.append({ type: "chunk", node: `n${i}`, visit: 1, turn: 1, index: 0, kind: "text", content: "x".repeat(2000) });
      log.append({ type: "node-finished", node: `n${i}`, visit: 1, status: "succeeded", writes: {} });
    }
    const d = runDigest("big", log.read());
    expect(d.split("\n").filter((l) => l.startsWith("  n")).length).toBeLessThanOrEqual(120);
    expect(d).toContain("(2000 chars)"); // long values are cut, not carried
    expect(d.length).toBeLessThan(60_000);
  });

  test("carries run events only — no environment, no credentials", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-digest-"));
    process.env.HOWDAH_TEST_SECRET = "sk-should-never-appear";
    const d = runDigest("r1", seedParkedRun(dir, "r1").read());
    expect(d).not.toContain("sk-should-never-appear");
    expect(d).not.toContain("HOWDAH_TEST_SECRET");
    delete process.env.HOWDAH_TEST_SECRET;
  });

  test("a run with nothing in it still produces a readable digest", () => {
    expect(runDigest("empty", [])).toContain("RUN empty");
  });
});

describe("ask about a run (story 11)", () => {
  test("stubbed: answers without spawning an agent, and never writes to the run", async () => {
    const root = fixtureRepo();
    const base = mkdtempSync(join(tmpdir(), "howdah-ask-"));
    const runsDir = join(base, "runs");
    mkdirSync(runsDir, { recursive: true });
    process.env.HOWDAH_HOME = base;
    process.env.HOWDAH_STUB = "1";
    const log = seedParkedRun(runsDir, "r-ask");
    const before = readFileSync(join(runsDir, "r-ask", "run.jsonl"), "utf8");
    const server = createHowdahServer({ runsDir, attentionDir: join(base, "attention"), port: 0, repoRoot: root });
    const url = (p: string) => `http://localhost:${server.port}${p}`;
    try {
      const res = await fetch(url("/api/runs/r-ask/ask"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "what is it waiting for?" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.stubbed).toBe(true);
      expect(body.digest_chars).toBeGreaterThan(0);
      // read-only is the whole decision: the log must be byte-identical afterwards
      expect(readFileSync(join(runsDir, "r-ask", "run.jsonl"), "utf8")).toBe(before);
      expect(log.read().some((e) => e.type === "attention-resolved")).toBe(false);

      expect((await fetch(url("/api/runs/r-ask/ask"), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "  " }),
      })).status).toBe(400);
      expect((await fetch(url("/api/runs/nope/ask"), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "x" }),
      })).status).toBe(404);
    } finally {
      delete process.env.HOWDAH_STUB;
      server.stop(true);
    }
  });
});

// ---- chat citations (story 12) ----------------------------------------------------

describe("citeParts", () => {
  const known = new Set(["implementation.implement@1", "delivery.address_reviews@1"]);

  test("a step this run has becomes a citation", () => {
    const parts = citeParts("It died at implementation.implement@1 and retried.", known);
    expect(parts.find((p) => p.text === "implementation.implement@1")?.cite).toBe(true);
  });

  test("a step this run does NOT have stays plain text", () => {
    const parts = citeParts("See totally.invented@9 for details.", known);
    expect(parts.find((p) => p.text === "totally.invented@9")?.cite).toBe(false);
  });

  test("model output round-trips as text, so markup can never be markup", () => {
    const evil = '<img src=x onerror=alert(1)> and implementation.implement@1';
    const parts = citeParts(evil, known);
    expect(parts.map((p) => p.text).join("")).toBe(evil);
    expect(parts.filter((p) => p.cite)).toHaveLength(1);
  });

  test("an answer with no citations fabricates none", () => {
    expect(citeParts("Nothing to cite here.", known).every((p) => !p.cite)).toBe(true);
  });
});

// ---- local-only surface (system-map 0.4 / eng review issue 1) ----------------------
// The viewer reads run logs full of proprietary code and can launch bypassPermissions
// runs, so it must be unreachable from the LAN, from a DNS-rebound hostname, and from a
// cross-origin page — while the UI itself and no-Origin clients (CLI, curl) keep working.

describe("viewer guard (system-map 0.4)", () => {
  /** a fresh HOWDAH_HOME per test so "no run was launched" is an empty-dir assertion */
  function guardedServer() {
    const base = mkdtempSync(join(tmpdir(), "howdah-guard-"));
    const runsDir = join(base, "runs");
    mkdirSync(runsDir, { recursive: true });
    process.env.HOWDAH_HOME = base;
    process.env.HOWDAH_STUB = "1"; // a launch that slips through must not spend tokens
    const server = createHowdahServer({ runsDir, attentionDir: join(base, "attention"), port: 0 });
    const url = (p: string) => `http://localhost:${server.port}${p}`;
    return { server, runsDir, url, self: `http://localhost:${server.port}` };
  }
  /** one cleanup path for every guard test: the stub flag and the listener never leak */
  async function withGuardedServer(fn: (s: ReturnType<typeof guardedServer>) => Promise<void>) {
    const s = guardedServer();
    try {
      await fn(s);
    } finally {
      delete process.env.HOWDAH_STUB;
      s.server.stop(true);
    }
  }
  const launchBody = JSON.stringify({ graph: "research", inputs: { goal: "guard" }, overrides: { permissionMode: "bypassPermissions" } });

  test("binds loopback only", async () => {
    await withGuardedServer(async ({ server }) => {
    expect(server.hostname).toBe("127.0.0.1");
    // and a non-loopback address of this machine gets no listener at all
    const lan = Object.values(networkInterfaces()).flat()
      .find((a) => a && a.family === "IPv4" && !a.internal)?.address;
    if (lan) {
      let reached = false;
      try { await fetch(`http://${lan}:${server.port}/api/runs`, { signal: AbortSignal.timeout(2000) }); reached = true; } catch { /* refused */ }
      expect(reached).toBe(false);
    }
    });
  });

  test("a foreign Host is refused on reads and writes (DNS rebinding)", async () => {
    await withGuardedServer(async ({ server, runsDir, url }) => {
    const get = await fetch(url("/api/runs"), { headers: { host: `evil.test:${server.port}` } });
    expect(get.status).toBe(403);
    expect(((await get.json()) as any).error).toContain("evil.test");
    // the app shell and SSE sit behind the same guard
    expect((await fetch(url("/"), { headers: { host: `evil.test:${server.port}` } })).status).toBe(403);
    // right name, wrong port is still foreign
    expect((await fetch(url("/api/runs"), { headers: { host: "localhost:1" } })).status).toBe(403);

    const post = await fetch(url("/api/runs"), {
      method: "POST", headers: { host: `evil.test:${server.port}`, "content-type": "application/json" }, body: launchBody,
    });
    expect(post.status).toBe(403);
    await Bun.sleep(500);
    expect(readdirSync(runsDir)).toEqual([]);
    });
  });

  test("both loopback Host spellings are accepted", async () => {
    await withGuardedServer(async ({ server }) => {
    expect((await fetch(`http://127.0.0.1:${server.port}/api/runs`)).status).toBe(200);
    expect((await fetch(`http://localhost:${server.port}/api/runs`)).status).toBe(200);
    });
  });

  test("a foreign Origin cannot launch a run (CSRF)", async () => {
    await withGuardedServer(async ({ server, runsDir, url }) => {
    for (const origin of ["http://evil.test", "null", `https://localhost:${server.port}`, "http://localhost:1"]) {
      const r = await fetch(url("/api/runs"), {
        method: "POST", headers: { origin, "content-type": "application/json" }, body: launchBody,
      });
      expect(r.status).toBe(403);
      expect(((await r.json()) as any).error).toContain(`foreign Origin ${origin}`);
    }
    // body-less writes are guarded too
    expect((await fetch(url("/api/runs/x/pause"), { method: "POST", headers: { origin: "http://evil.test" } })).status).toBe(403);
    // no detached CLI was spawned: give one time to write, then nothing is there
    await Bun.sleep(1000);
    expect(readdirSync(runsDir)).toEqual([]);
    });
  });

  test("a non-JSON body is refused with 415 (no-preflight text/plain POST)", async () => {
    await withGuardedServer(async ({ server, runsDir, url }) => {
    const plain = await fetch(url("/api/runs"), {
      method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" }, body: launchBody,
    });
    expect(plain.status).toBe(415);
    expect(((await plain.json()) as any).error).toContain("text/plain");
    // a missing content-type on a body is just as unacceptable
    expect((await fetch(url("/api/runs"), { method: "POST", body: launchBody })).status).toBe(415);
    for (const ct of ["application/x-www-form-urlencoded", "multipart/form-data; boundary=x"])
      expect((await fetch(url("/api/settings"), { method: "PUT", headers: { "content-type": ct }, body: "a=b" })).status).toBe(415);
    await Bun.sleep(500);
    expect(readdirSync(runsDir)).toEqual([]);
    // a charset parameter on JSON is fine
    expect((await fetch(url("/api/runs"), {
      method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: "{}",
    })).status).toBe(400); // past the guard: "graph required"
    });
  });

  test("the UI's own same-origin launch still works", async () => {
    await withGuardedServer(async ({ server, runsDir, url, self }) => {
    const r = await fetch(url("/api/runs"), {
      method: "POST", headers: { origin: self, "content-type": "application/json" },
      body: JSON.stringify({ graph: "research", inputs: { goal: "same origin" } }),
    });
    expect(r.status).toBe(202);
    const { id } = (await r.json()) as { id: string };
    let started: any;
    for (let i = 0; i < 50 && !started; i++) {
      await Bun.sleep(100);
      const path = join(runsDir, id, "run.jsonl");
      if (existsSync(path)) started = readLog(path).find((e) => e.type === "run-started");
    }
    expect(started).toMatchObject({ graph: "research", inputs: { goal: "same origin" } });
    // the 127.0.0.1 spelling of our own origin is ours too
    const alt = await fetch(`http://127.0.0.1:${server.port}/api/runs`, {
      method: "POST", headers: { origin: `http://127.0.0.1:${server.port}`, "content-type": "application/json" }, body: "{}",
    });
    expect(alt.status).toBe(400); // past the guard
    });
  });

  test("no-Origin clients (CLI, curl) pass: JSON bodies and body-less writes", async () => {
    await withGuardedServer(async ({ server, url }) => {
    expect((await fetch(url("/api/runs"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(400);
    expect((await fetch(url("/api/runs/nope/pause"), { method: "POST" })).status).toBe(404); // past the guard, unknown run
    expect((await fetch(url("/api/settings"), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ chime: true }) })).status).toBe(200);
    });
  });
});

// guardRequest is pure: the header permutations a live server can't easily produce
describe("guardRequest (system-map 0.4)", () => {
  const PORT = 4711;
  const req = (method: string, headers: Record<string, string>, body?: string) =>
    new Request(`http://127.0.0.1:${PORT}/api/runs`, { method, headers, body });
  const own = { host: `localhost:${PORT}` };

  test("a missing Host is refused", () => {
    expect(guardRequest(new Request("http://x/api/runs", { headers: { host: "" } }), PORT)?.status).toBe(403);
  });

  test("Host matching is case-insensitive but exact", () => {
    expect(guardRequest(req("GET", { host: `LOCALHOST:${PORT}` }), PORT)).toBeNull();
    for (const host of [`localhost.:${PORT}`, "localhost", `[::1]:${PORT}`, `127.0.0.1:${PORT + 1}`])
      expect(guardRequest(req("GET", { host }), PORT)?.status).toBe(403);
  });

  test("a foreign Origin is refused on every write method, never on reads", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      expect(guardRequest(req(method, { ...own, origin: "http://evil.test" }), PORT)?.status).toBe(403);
    expect(guardRequest(req("GET", { ...own, origin: "http://evil.test" }), PORT)).toBeNull();
  });

  test("a chunked non-JSON body is refused even without content-length", () => {
    const r = guardRequest(req("POST", { ...own, "transfer-encoding": "chunked", "content-type": "text/plain" }), PORT);
    expect(r?.status).toBe(415);
  });

  test("JSON with parameters or in upper case passes; a JSON-looking list does not", () => {
    // a constructed Request carries no content-length; a real HTTP request with a body does
    const withBody = { ...own, "content-length": "2" };
    expect(guardRequest(req("POST", { ...withBody, "content-type": "APPLICATION/JSON; charset=utf-8" }, "{}"), PORT)).toBeNull();
    expect(guardRequest(req("POST", { ...withBody, "content-type": "application/json, text/plain" }, "{}"), PORT)?.status).toBe(415);
  });
});
