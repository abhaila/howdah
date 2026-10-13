/**
 * HOW-55 — an agent's environment is chosen and recorded. Spiked against claude 2.1.296:
 * with no `--setting-sources`, five user-level SessionStart hooks injected text into a headless
 * session and it loaded the operator's own CLAUDE.md; with `project,local` none of that happened
 * and auth still worked. The captured startups are adapter/fixtures/claude-init-*.jsonl.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../run";
import { claudeExecutor } from "./claude";
import { defineGraph } from "../../core/graph";
import { readLog } from "../../log/write";
import { claudeArgs } from "../../adapter/claude";
import { environmentFiles, sha256, userHookReport } from "./agent-env";

const FAKE = join(import.meta.dir, "fake-claude.ts");
const FIXTURES = join(import.meta.dir, "..", "..", "adapter", "fixtures");
const ENV = ["FAKE_CLAUDE_INIT", "FAKE_CAPTURE_ARGV", "FAKE_CLAUDE_ASK", "FAKE_CLAUDE_RATELIMIT"];
afterEach(() => { for (const k of ENV) delete process.env[k]; });

function run(opts: { init?: string; inherits?: boolean; skills?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "howdah-env-"));
  const work = mkdtempSync(join(tmpdir(), "howdah-env-wt-"));
  writeFileSync(join(work, "CLAUDE.md"), "# project rules\n");
  const prompts = mkdtempSync(join(tmpdir(), "howdah-env-p-"));
  writeFileSync(join(prompts, "doc.draft.md"), `---\nid: doc.draft\nversion: 1\n---\nDo {{ context.goal }}.\n`);
  const argv = join(dir, "argv.jsonl");
  Object.assign(process.env, { FAKE_CAPTURE_ARGV: argv, FAKE_CLAUDE_ASK: "0", FAKE_CLAUDE_RATELIMIT: "0" });
  if (opts.init) process.env.FAKE_CLAUDE_INIT = join(FIXTURES, opts.init);
  const graph = defineGraph<{ goal: string; out: string }>({
    name: "env", entry: "do", inputs: ["goal"],
    nodes: {
      do: { kind: "agent", prompt: "doc.draft", reads: ["goal"], writes: { out: { scope: "sticky" } }, ...(opts.skills ? { skills: opts.skills } : {}) },
      done: { kind: "terminal", outcome: "success" },
    },
    edges: [{ from: "do", to: "done" }],
  });
  const engine = new Engine(graph, {
    dir, promptsDir: prompts, cwd: work,
    executors: { agent: claudeExecutor({ attentionDir: join(dir, "a"), binary: FAKE, askPollMs: 20, notifiers: [], inheritsUserSettings: (p) => p === work && !!opts.inherits }) },
  });
  const sources = () => {
    const a = JSON.parse(readFileSync(argv, "utf8").trim().split("\n")[0]!) as string[];
    return a.includes("--setting-sources") ? a[a.indexOf("--setting-sources") + 1] : null;
  };
  return { engine, work, sources, path: join(dir, "run.jsonl") };
}

describe("--setting-sources", () => {
  test("the argv builder passes it only when asked", () => {
    expect(claudeArgs({ sessionId: "s", settingSources: "project,local" })).toEqual(expect.arrayContaining(["--setting-sources", "project,local"]));
    expect(claudeArgs({ sessionId: "s" })).not.toContain("--setting-sources");
  });

  test("by default an agent loads the project's settings only", async () => {
    const r = run();
    await r.engine.start({ goal: "g" });
    expect(r.sources()).toBe("project,local");
  }, 20_000);

  test("a workspace that opts in loads the operator's user settings too", async () => {
    const r = run({ inherits: true });
    await r.engine.start({ goal: "g" });
    expect(r.sources()).toBe("user,project,local");
  }, 20_000);
});

describe("agent-environment", () => {
  test("the CLI's init is captured: plugins, skills, MCP servers, and the files it could read, hashed", async () => {
    const r = run({ init: "claude-init-project-local.jsonl" });
    expect(await r.engine.start({ goal: "g" })).toEqual({ state: "finished", outcome: "success" });
    const env = readLog(r.path).find((e) => e.type === "agent-environment")!;
    expect(env).toMatchObject({ node: "do", visit: 1, harness: "claude", setting_sources: "project,local", inherits_user: false, version: "2.1.296", hooks: [] });
    if (env.type !== "agent-environment") return;
    expect(env.plugins!.map((p) => p.name)).toEqual(["cc-plugin-agents-md", "cc-plugin-telemetry", "cc-plugin-plugin-authoring"]);
    expect(env.skills).toHaveLength(19);
    expect(env.mcp_servers!.every((m) => m.source === "claudeai")).toBe(true); // account connectors load either way
    expect(env.files).toContainEqual({ path: join(r.work, "CLAUDE.md"), scope: "project", sha256: sha256("# project rules\n") });
    expect(env.files.some((f) => f.scope === "user")).toBe(false); // not loaded, so not claimed
  }, 20_000);

  test("hooks that ran before init are recorded, with the context they injected — hashed and bounded", async () => {
    const r = run({ init: "claude-init-user-settings.jsonl", inherits: true });
    await r.engine.start({ goal: "g" });
    const env = readLog(r.path).find((e) => e.type === "agent-environment");
    if (env?.type !== "agent-environment") throw new Error("no environment recorded");
    expect(env.hooks!.map((h) => h.name)).toEqual(Array(5).fill("SessionStart:startup"));
    const injected = env.hooks!.filter((h) => h.injected);
    expect(injected).toHaveLength(4);
    expect(injected[0]!.injected!.text).toBe("<user-global skill-forcing instructions, elided from the fixture>");
    expect(injected[0]!.injected!.sha256).toBe(sha256("<user-global skill-forcing instructions, elided from the fixture>"));
    expect(env.skills!.length).toBeGreaterThan(100);
    expect(env.files.some((f) => f.scope === "user")).toBe(true);
  }, 20_000);

  test("a node naming a skill this session did not load is REFUSED with a reason — never silently without it", async () => {
    const r = run({ init: "claude-init-project-local.jsonl", skills: ["review"] });
    const res = await r.engine.start({ goal: "g" });
    expect(res).toMatchObject({ state: "parked", node: "do" });
    expect((res as { reason: string }).reason).toContain('skill "review" is not available with --setting-sources project,local');
    expect((res as { reason: string }).reason).toContain("howdah workspace user-settings <name> on");
  }, 20_000);

  test("a skill the session did load (built-in, or a plugin's namespaced one) is fine", async () => {
    const r = run({ init: "claude-init-project-local.jsonl", skills: ["simplify"] });
    expect(await r.engine.start({ goal: "g" })).toEqual({ state: "finished", outcome: "success" });
  }, 20_000);
});

describe("environmentFiles", () => {
  test("project files from the cwd up to the git root; user files only when loaded; absent ones say so", () => {
    const root = mkdtempSync(join(tmpdir(), "howdah-envfiles-"));
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "pkg", ".claude"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "root");
    writeFileSync(join(root, "pkg", ".claude", "settings.json"), "{}");
    const home = mkdtempSync(join(tmpdir(), "howdah-home-"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), "{\"hooks\":{}}");
    const files = environmentFiles("claude", join(root, "pkg"), false, home);
    expect(files).toContainEqual({ path: join(root, "CLAUDE.md"), scope: "project", sha256: sha256("root") });
    expect(files).toContainEqual({ path: join(root, "pkg", ".claude", "settings.json"), scope: "project", sha256: sha256("{}") });
    expect(files).toContainEqual({ path: join(root, "pkg", "CLAUDE.md"), scope: "project", sha256: null });
    expect(files.some((f) => f.scope === "user")).toBe(false);
    const withUser = environmentFiles("claude", join(root, "pkg"), true, home);
    expect(withUser).toContainEqual({ path: join(home, ".claude", "settings.json"), scope: "user", sha256: sha256("{\"hooks\":{}}") });
    // codex has no switch: its own config is what it reads, so that is what is hashed
    expect(environmentFiles("codex", root, true, home).map((f) => f.path)).toEqual([join(home, ".codex", "config.toml"), join(home, ".codex", "AGENTS.md")]);
  });
});

describe("doctor's user-hook report", () => {
  function homeWithHooks(): string {
    const home = mkdtempSync(join(tmpdir(), "howdah-doctor-home-"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "~/.claude/hooks/force-skills.sh" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
      },
    }));
    return home;
  }

  test("a workspace that opted in is told exactly which user hooks its agents inherit", () => {
    expect(userHookReport([{ name: "howdah", inherits: true }, { name: "other", inherits: false }], homeWithHooks())).toEqual([
      { name: "user settings — howdah", detail: "inherits 2 user hooks: SessionStart: ~/.claude/hooks/force-skills.sh; PreToolUse: guard.sh" },
    ]);
  });

  test("with no opt-in, the hooks are counted as staying out", () => {
    expect(userHookReport([{ name: "howdah", inherits: false }], homeWithHooks())).toEqual([
      { name: "user settings", detail: "not inherited — agents load project settings only (--setting-sources project,local); 2 user hooks stay out" },
    ]);
  });
});
