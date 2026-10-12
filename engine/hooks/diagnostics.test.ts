/**
 * HOW-39: post-edit diagnostics through a claude PostToolUse hook. Pinned: the hook's output
 * contract (probed on claude 2.1.296), its own timeout and output cap, that the argv carries
 * `--settings` ONLY when the workspace has a command and the node opted in (never for a
 * read-only node), that the output reaches the transcript over the fake wire, and doctor's
 * check of the command's binary.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIAGNOSTICS_TAIL_CHARS, diagnosticsSettings, runDiagnostics } from "./diagnostics";
import { defineGraph, type AgentConfig } from "../../core/graph";
import { Engine } from "../run";
import { claudeExecutor } from "../executors/claude";
import { diagnosticsCommandProblem } from "../../config/config";
import { readLog } from "../../log/write";

const FAKE = join(import.meta.dir, "..", "executors", "fake-claude.ts");
const EDIT = { tool_name: "Edit", tool_input: { file_path: "src/a.ts" }, tool_use_id: "toolu_1" };

describe("the hook script", () => {
  test("output contract: hookSpecificOutput.additionalContext, naming the command and its exit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "howdah-diag-"));
    const { stdout, run } = await runDiagnostics({ ...EDIT, cwd }, { HOWDAH_DIAG_CMD: "echo 'src/a.ts(1,1): error TS2322'; exit 2" });
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("exited 2");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("error TS2322");
    expect(run).toMatchObject({ exit_code: 2, timed_out: false, file: "src/a.ts" });
  });

  test("a passing check says so in one line", async () => {
    const { stdout } = await runDiagnostics({ ...EDIT, cwd: tmpdir() }, { HOWDAH_DIAG_CMD: "true" });
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toMatch(/`true` passed/);
  });

  test("a hung command times out on the hook's own ceiling and says 'timed out' rather than blocking", async () => {
    const started = Date.now();
    const { stdout, run } = await runDiagnostics({ ...EDIT, cwd: tmpdir() }, { HOWDAH_DIAG_CMD: "sleep 30", HOWDAH_DIAG_TIMEOUT_MS: "300" });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(run?.timed_out).toBe(true);
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain("timed out");
  });

  test("a huge output is capped to its tail", async () => {
    const { run } = await runDiagnostics({ ...EDIT, cwd: tmpdir() }, { HOWDAH_DIAG_CMD: "seq 1 20000; exit 1" });
    expect(run!.output.length).toBeLessThan(DIAGNOSTICS_TAIL_CHARS + 100);
    expect(run!.output).toContain("20000"); // the tail is where failures print
    expect(run!.output).toContain("earlier characters are in the run log");
  });

  test("no command: no output, no record — never an error", async () => {
    expect(await runDiagnostics({ ...EDIT }, {})).toEqual({ stdout: "", run: null });
  });

  test("the settings install it on Edit|Write|MultiEdit, with claude's timeout above the script's", () => {
    const settings = JSON.parse(diagnosticsSettings(20_000));
    const group = settings.hooks.PostToolUse[0];
    expect(group.matcher).toBe("Edit|Write|MultiEdit");
    expect(group.hooks[0].timeout).toBe(30);
    expect(group.hooks[0].command).toContain("diagnostics.ts");
  });
});

interface Ctx { goal: string; summary: string }
const graph = (node: AgentConfig & { readOnly?: true }) => defineGraph<Ctx>({
  name: "diag", entry: "work", inputs: ["goal"],
  nodes: {
    work: { kind: "agent", prompt: "d.work" as never, reads: ["goal"], writes: { summary: { scope: "sticky" } }, ...node },
    done: { kind: "terminal", outcome: "success" },
  },
  edges: [{ from: "work", to: "done" }],
});

async function run(node: AgentConfig & { readOnly?: true }, command: string | undefined, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "howdah-diag-run-"));
  const repo = mkdtempSync(join(tmpdir(), "howdah-diag-repo-"));
  const prompts = mkdtempSync(join(tmpdir(), "howdah-diag-p-"));
  writeFileSync(join(prompts, "d.work.md"), "---\nid: d.work\nversion: 1\n---\nDo {{ context.goal }}.\n");
  const argv = join(dir, "argv.jsonl");
  Object.assign(process.env, { FAKE_CLAUDE_ARGV: argv, ...env });
  try {
    const engine = new Engine(graph(node), {
      dir, promptsDir: prompts, cwd: repo,
      diagnosticsCommandFor: (path) => (path === repo ? command : undefined),
      executors: { agent: claudeExecutor({ attentionDir: join(dir, "attn"), binary: FAKE, askPollMs: 30, notifiers: [] }) },
    });
    const result = await engine.start({ goal: "g" });
    const spawned = existsSync(argv) ? (JSON.parse(readFileSync(argv, "utf8").trim().split("\n")[0]!) as string[]) : [];
    return { result, argv: spawned, events: readLog(join(dir, "run.jsonl")) };
  } finally {
    for (const k of ["FAKE_CLAUDE_ARGV", ...Object.keys(env)]) delete process.env[k];
  }
}

describe("the executor's argv", () => {
  test("--settings only when the workspace has a command AND the node opted in", async () => {
    expect((await run({ diagnostics: true }, "true")).argv).toContain("--settings");
    expect((await run({}, "true")).argv).not.toContain("--settings"); // node did not opt in
    expect((await run({ diagnostics: true }, undefined)).argv).not.toContain("--settings"); // no command: no hook, no error
  }, 20000);

  test("a read-only node never gets the hook", async () => {
    const { argv, events } = await run({ diagnostics: true, readOnly: true }, "true");
    expect(argv).not.toContain("--settings");
    expect(events.find((e) => e.type === "prompt-rendered")).not.toHaveProperty("diagnostics_command");
  }, 20000);

  test("a harness without edit hooks (codex) resolves no command, so the run records none", async () => {
    const g = graph({ diagnostics: true, harness: "codex" });
    const dir = mkdtempSync(join(tmpdir(), "howdah-diag-codex-"));
    const prompts = mkdtempSync(join(tmpdir(), "howdah-diag-p-"));
    writeFileSync(join(prompts, "d.work.md"), "---\nid: d.work\nversion: 1\n---\nDo {{ context.goal }}.\n");
    const engine = new Engine(g, {
      dir, promptsDir: prompts, cwd: "/repo", diagnosticsCommandFor: () => "true",
      executors: { agent: async () => ({ status: "succeeded", writes: { summary: "s" } }) },
    });
    await engine.start({ goal: "g" });
    expect(readLog(join(dir, "run.jsonl")).find((e) => e.type === "prompt-rendered")).not.toHaveProperty("diagnostics_command");
  });
});

describe("integration over the fake wire", () => {
  test("the hook's output reaches the model and the transcript, and the run records what ran", async () => {
    const { result, events } = await run({ diagnostics: true }, "echo 'src/a.ts(3,7): error TS2322: Type string'; exit 2", { FAKE_CLAUDE_EDIT: "1", FAKE_CLAUDE_VERDICT: "pass" });
    expect(result).toEqual({ state: "finished", outcome: "success" });
    expect(events.find((e) => e.type === "prompt-rendered")).toMatchObject({ diagnostics_command: "echo 'src/a.ts(3,7): error TS2322: Type string'; exit 2" });
    expect(events.find((e) => e.type === "diagnostics-ran")).toMatchObject({ node: "work", visit: 1, tool_use_id: "toolu_edit_1", tool_name: "Edit", file: "src/a.ts", exit_code: 2 });
    const transcript = events.filter((e) => e.type === "chunk" && e.kind === "text").map((e) => (e.type === "chunk" ? e.content : "")).join("");
    expect(transcript).toContain("[diagnostics after Edit src/a.ts: exit 2");
    expect(transcript).toContain("error TS2322");
    // and the model was handed it in its turn (the fake repeats what the hook told it)
    expect(transcript).toContain("The hook told me: [Howdah diagnostics]");
  }, 20000);
});

describe("doctor", () => {
  test("a diagnostics command whose binary is missing is reported", () => {
    expect(diagnosticsCommandProblem("nonesuch-linter --fast", () => null, () => false)).toBe("nonesuch-linter is not on PATH");
    expect(diagnosticsCommandProblem("bunx tsc --noEmit", (b) => (b === "bunx" ? "/bin/bunx" : null), () => false)).toBeNull();
    expect(diagnosticsCommandProblem("./scripts/lint.sh", () => null, () => false)).toBe("./scripts/lint.sh does not exist");
  });
});
