import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, resolveWorkspace, configPath } from "../config/config";
import { graphCatalog } from "../graphs/index";
import { parseDuration } from "../engine/executors";
import { readLog } from "../log/write";
import { createHowdahServer } from "../web/server";

describe("config", () => {
  test("round-trips and resolves workspaces by kind", () => {
    const base = mkdtempSync(join(tmpdir(), "howdah-cfg-"));
    const config = loadConfig(base); // defaults
    config.repos["platform-api"] = { path: "/Users/areeb/code/sequence-platform-api", defaultBranch: "main" };
    config.folders["notes"] = { path: "/Users/areeb/notes" };
    config.editorCommand = "idea";
    saveConfig(config, base);
    expect(existsSync(configPath(base))).toBe(true);

    const loaded = loadConfig(base);
    expect(resolveWorkspace(loaded, "platform-api")).toMatchObject({ kind: "repo", path: "/Users/areeb/code/sequence-platform-api" });
    expect(resolveWorkspace(loaded, "notes")).toMatchObject({ kind: "plain" });
    expect(resolveWorkspace(loaded, "nope")).toBeNull();
    expect(loaded.editorCommand).toBe("idea");
  });
});

describe("graph catalog", () => {
  test("worktree graphs need a repo; plain graphs do not", () => {
    const byName = Object.fromEntries(graphCatalog().map((g) => [g.name, g]));
    expect(byName["implement-ticket"]!.kind).toBe("repo");
    expect(byName["improve-codebase"]!.kind).toBe("repo");
    expect(byName["write-doc"]!.kind).toBe("plain");
    expect(byName["research"]!.kind).toBe("plain");
    expect(byName["write-doc"]!.inputs).toEqual(["goal", "work"]);
  });
});

describe("executors registry", () => {
  test("parseDuration handles the Orbital forms", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("5s")).toBe(5000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(() => parseDuration("soon")).toThrow(/bad duration/);
  });
});

describe("howdah run (CLI)", () => {
  test("setup creates the default local app home layout", async () => {
    const base = mkdtempSync(join(tmpdir(), "howdah-setup-"));
    const proc = Bun.spawn(["bun", join(import.meta.dir, "main.ts"), "setup"], {
      env: { ...process.env, HOWDAH_HOME: base },
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    const out = await new Response(proc.stdout).text();
    expect(out).toContain(`home: ${base}`);
    expect(existsSync(join(base, "config.json"))).toBe(true);
    expect(existsSync(join(base, "runs"))).toBe(true);
    expect(existsSync(join(base, "repos"))).toBe(true);
    expect(existsSync(join(base, "attention"))).toBe(true);
  });

  test("launches a run whose run-started carries cwd + folder_kind; stub executor parks it", async () => {
    const base = mkdtempSync(join(tmpdir(), "howdah-cli-"));
    const notes = join(base, "notes");
    mkdirSync(notes);
    const config = loadConfig(base);
    config.folders["notes"] = { path: notes };
    saveConfig(config, base);

    const proc = Bun.spawn(
      ["bun", join(import.meta.dir, "main.ts"), "run", "write-doc",
        "-i", "goal=test the launcher", "-i", "work=doc.md",
        "--workspace", "notes", "--id", "launch-test"],
      { env: { ...process.env, HOWDAH_HOME: base, HOWDAH_STUB: "1" }, stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    expect(proc.exitCode).toBe(0);

    const events = readLog(join(base, "runs", "launch-test", "run.jsonl"));
    const started: any = events.find((e) => e.type === "run-started");
    expect(started).toMatchObject({
      graph: "write-doc",
      inputs: { goal: "test the launcher", work: "doc.md" },
      cwd: notes,
      folder_kind: "plain",
    });
    // stub registry (HOWDAH_STUB=1) — the run parks honestly, naming the gap
    const parked: any = events.find((e) => e.type === "attention-raised");
    expect(parked.reason).toContain("stub");
  });

  test("unknown graph and unknown workspace fail with useful errors", async () => {
    const base = mkdtempSync(join(tmpdir(), "howdah-cli-"));
    const bad = Bun.spawn(["bun", join(import.meta.dir, "main.ts"), "run", "nope"], {
      env: { ...process.env, HOWDAH_HOME: base }, stderr: "pipe",
    });
    await bad.exited;
    expect(bad.exitCode).toBe(1);
    expect(await new Response(bad.stderr).text()).toContain("unknown graph");

    const badWs = Bun.spawn(["bun", join(import.meta.dir, "main.ts"), "run", "write-doc", "--workspace", "ghost"], {
      env: { ...process.env, HOWDAH_HOME: base }, stderr: "pipe",
    });
    await badWs.exited;
    expect(await new Response(badWs.stderr).text()).toContain('unknown workspace "ghost"');
  });
});

describe("launch API", () => {
  const base = mkdtempSync(join(tmpdir(), "howdah-launch-"));
  mkdirSync(join(base, "runs"), { recursive: true });
  process.env.HOWDAH_HOME = base; // loadConfig in the server reads this
  process.env.HOWDAH_STUB = "1"; // the detached CLI inherits this — no real agent spawns in tests
  const server = createHowdahServer({ runsDir: join(base, "runs"), attentionDir: join(base, "attention"), port: 0 });
  const url = (p: string) => `http://localhost:${server.port}${p}`;
  afterAll(() => server.stop(true));

  test("GET /api/graphs serves the catalog", async () => {
    const graphs = (await (await fetch(url("/api/graphs"))).json()) as any[];
    expect(graphs.map((g) => g.name)).toContain("write-doc");
  });

  test("POST /api/runs launches detached and the run appears", async () => {
    const r = await fetch(url("/api/runs"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ graph: "research", inputs: { goal: "api launch" } }),
    });
    expect(r.status).toBe(202);
    const { id } = (await r.json()) as { id: string };

    // the detached CLI needs a moment to write run-started
    let started: any;
    for (let i = 0; i < 50 && !started; i++) {
      await Bun.sleep(100);
      const path = join(base, "runs", id, "run.jsonl");
      if (existsSync(path)) started = readLog(path).find((e) => e.type === "run-started");
    }
    expect(started).toMatchObject({ graph: "research", inputs: { goal: "api launch" } });
    expect(r.status).toBe(202);
  });

  test("POST without a graph is a 400", async () => {
    const r = await fetch(url("/api/runs"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(400);
  });
});
