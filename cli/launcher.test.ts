import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, resolveWorkspace, configPath } from "../config/config";
import { graphCatalog } from "../graphs/index";
import { parseDuration } from "../engine/executors";
import { readLog } from "../log/write";
import { createHowdahServer, launchArgs } from "../web/server";
import { parseRunArgs, splitVerifyFlag } from "./main";

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

  test("--name is stamped on run-started; the run id is unchanged by it (HOW-18)", async () => {
    const base = mkdtempSync(join(tmpdir(), "howdah-cli-"));
    const proc = Bun.spawn(
      ["bun", join(import.meta.dir, "main.ts"), "run", "write-doc",
        "-i", "goal=named launch", "-i", "work=doc.md", "--name", "  My named run  ", "--id", "named-test"],
      { env: { ...process.env, HOWDAH_HOME: base, HOWDAH_STUB: "1" }, stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(await new Response(proc.stdout).text()).toContain('run named-test "My named run" starting');
    const started: any = readLog(join(base, "runs", "named-test", "run.jsonl")).find((e) => e.type === "run-started");
    expect(started).toMatchObject({ graph: "write-doc", name: "My named run", inputs: { goal: "named launch" } });
  });

  test("a bad --name fails before anything is logged (HOW-18)", async () => {
    const base = mkdtempSync(join(tmpdir(), "howdah-cli-"));
    const bad = Bun.spawn(
      ["bun", join(import.meta.dir, "main.ts"), "run", "write-doc", "-i", "goal=g", "-i", "work=w", "--name", "x".repeat(121), "--id", "bad-name"],
      { env: { ...process.env, HOWDAH_HOME: base, HOWDAH_STUB: "1" }, stderr: "pipe" },
    );
    await bad.exited;
    expect(bad.exitCode).toBe(1);
    expect(await new Response(bad.stderr).text()).toContain("at most 120");
    expect(existsSync(join(base, "runs", "bad-name"))).toBe(false);
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

describe("parseRunArgs --name (HOW-18)", () => {
  test("trims the name and leaves every other flag parsing as before", () => {
    const parsed = parseRunArgs(["g", "-i", "goal=x", "--name", "  My run  ", "--workspace", "w", "--model", "m"]);
    expect(parsed).toMatchObject({ graphName: "g", name: "My run", inputs: { goal: "x" }, workspace: "w", overrides: { model: "m" } });
  });

  test("no --name and a blank --name both mean no name", () => {
    expect(parseRunArgs(["g"]).name).toBeUndefined();
    expect(parseRunArgs(["g", "--name", "   "]).name).toBeUndefined();
  });

  test("refuses an over-long name, a multi-line one, and a missing value", () => {
    expect(parseRunArgs(["g", "--name", "x".repeat(120)]).name).toHaveLength(120);
    expect(() => parseRunArgs(["g", "--name", "x".repeat(121)])).toThrow("at most 120");
    expect(() => parseRunArgs(["g", "--name", "two\nlines"])).toThrow("one line");
    expect(() => parseRunArgs(["g", "--name"])).toThrow("--name needs a value");
  });
});

describe("parseRunArgs --parent (HOW-23)", () => {
  test("carries the launching run's id alongside every other flag", () => {
    const parsed = parseRunArgs(["implement-ticket", "--id", "p--a", "--parent", "p", "-i", "goal=x", "--workspace", "api"]);
    expect(parsed).toMatchObject({ graphName: "implement-ticket", id: "p--a", parent: "p", workspace: "api" });
  });

  test("a run nobody launched has no parent", () => {
    expect(parseRunArgs(["g"]).parent).toBeUndefined();
  });
});

describe("launchArgs (HOW-18)", () => {
  test("forwards a name as --name, and nothing when there is none", () => {
    const args = launchArgs({ graph: "research", name: "My run", inputs: { goal: "g" } }, "research-abc");
    expect(args).toEqual(["run", "research", "--id", "research-abc", "-i", "goal=g", "--name", "My run"]);
    expect(launchArgs({ graph: "research" }, "research-abc")).not.toContain("--name");
    expect(launchArgs({ graph: "research", name: "" }, "research-abc")).not.toContain("--name");
  });

  test("keeps forwarding workspace, dir and every override", () => {
    expect(launchArgs({
      graph: "g", workspace: "ws", dir: "/d",
      overrides: { model: "m", effort: "high", permissionMode: "plan", harness: "codex", maxTurns: 5, skills: ["a", "b"] },
    }, "g-1")).toEqual([
      "run", "g", "--id", "g-1", "--workspace", "ws", "--dir", "/d",
      "--model", "m", "--effort", "high", "--permission-mode", "plan", "--harness", "codex", "--max-turns", "5", "--skills", "a,b",
    ]);
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

  test("GET /api/graphs serves the catalog, tagging where each graph came from", async () => {
    const body = (await (await fetch(url("/api/graphs"))).json()) as { graphs: any[]; problems: any[] };
    expect(body.graphs.map((g) => g.name)).toContain("write-doc");
    // built-ins are compile-checked and come first; local ones are the operator's own
    expect(body.graphs.find((g) => g.name === "write-doc")!.source).toBe("builtin");
    expect(body.problems).toEqual([]);
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

  test("POST with a name records it; the id is still <graph>-<base36> (HOW-18)", async () => {
    const r = await fetch(url("/api/runs"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ graph: "research", name: "  Named from the web  ", inputs: { goal: "named api launch" } }),
    });
    expect(r.status).toBe(202);
    const { id } = (await r.json()) as { id: string };
    expect(id).toMatch(/^research-[0-9a-z]+$/);
    let started: any;
    for (let i = 0; i < 50 && !started; i++) {
      await Bun.sleep(100);
      const path = join(base, "runs", id, "run.jsonl");
      if (existsSync(path)) started = readLog(path).find((e) => e.type === "run-started");
    }
    expect(started).toMatchObject({ graph: "research", name: "Named from the web", inputs: { goal: "named api launch" } });
  });

  test("a bad name is a 400 naming the rule, and nothing is spawned (HOW-18)", async () => {
    const before = readdirSync(join(base, "runs")).length;
    for (const [name, why] of [["x".repeat(121), "at most 120"], ["two\nlines", "one line"], [42, "must be a string"]] as const) {
      const r = await fetch(url("/api/runs"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ graph: "research", name, inputs: { goal: "g" } }),
      });
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error).toContain(why);
    }
    await Bun.sleep(500);
    expect(readdirSync(join(base, "runs")).length).toBe(before);
  });

  test("POST without a graph is a 400", async () => {
    const r = await fetch(url("/api/runs"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(400);
  });
});

// HOW-12: the verify command is configurable without hand-editing config.json
describe("workspace --verify", () => {
  const main = join(import.meta.dir, "main.ts");
  async function cli(base: string, ...args: string[]) {
    const p = Bun.spawn(["bun", main, ...args], { env: { ...process.env, HOWDAH_HOME: base, HOWDAH_STUB: "1" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr };
  }
  function gitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "howdah-verify-ws-"));
    Bun.spawnSync(["git", "init", "-q", dir]);
    return dir;
  }

  test("add --verify persists the command on the repo, and `workspace verify` sets and clears it", async () => {
    const base = mkdtempSync(join(tmpdir(), "howdah-cfg-"));
    const dir = gitRepo();
    const added = await cli(base, "workspace", "add", "api", dir, "--verify", "bun test --bail");
    expect(added.code).toBe(0);
    expect(added.stdout).toContain("(verify: bun test --bail)");
    expect(loadConfig(base).repos.api).toEqual({ path: dir, verifyCommand: "bun test --bail" });

    expect((await cli(base, "workspace", "verify", "api", "./gradlew", "test")).code).toBe(0);
    expect(loadConfig(base).repos.api?.verifyCommand).toBe("./gradlew test");

    const cleared = await cli(base, "workspace", "verify", "api");
    expect(cleared.stdout).toContain("not-checked");
    expect(loadConfig(base).repos.api).toEqual({ path: dir });
  });

  test("--verify on a Plain folder, or with no command, is refused and nothing is saved", async () => {
    const base = mkdtempSync(join(tmpdir(), "howdah-cfg-"));
    const plain = mkdtempSync(join(tmpdir(), "howdah-plain-"));
    const r = await cli(base, "workspace", "add", "notes", plain, "--verify", "true");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("--verify needs a git repo");
    expect(loadConfig(base).folders.notes).toBeUndefined();

    const empty = await cli(base, "workspace", "add", "api", gitRepo(), "--verify");
    expect(empty.code).not.toBe(0);
    expect(empty.stderr).toContain("--verify needs a command");
    expect(loadConfig(base).repos.api).toBeUndefined();
  });

  test("splitVerifyFlag lifts the flag from anywhere", () => {
    expect(splitVerifyFlag(["add", "--verify", "make test", "api", "/p"])).toEqual({ rest: ["add", "api", "/p"], verify: "make test" });
    expect(splitVerifyFlag(["list"])).toEqual({ rest: ["list"] });
  });
});
