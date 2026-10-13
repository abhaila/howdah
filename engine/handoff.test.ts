/**
 * HOW-36: the structured handoff on re-entry after context exhaustion (suffix v5).
 *
 *   - claude, fake wire: a visit that read, edited and ran a failing test before its window
 *     filled hands the retry its files and commands, and the retry reconstructs VERIFIED;
 *   - codex, fake wire: `contextWindowExceeded` produces the same headings, filled from
 *     commandExecution / fileChange;
 *   - a v4 re-entry render written before HOW-36 (prompts/fixtures/reentry-v4, made at
 *     ffa9d4a) still reconstructs VERIFIED;
 *   - the block is bounded however many calls the visit made, and a visit that exhausted before
 *     any tool call says so instead of rendering empty headings.
 */
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineGraph } from "../core/graph";
import { Engine, type Executor } from "./run";
import { claudeExecutor } from "./executors/claude";
import { codexExecutor } from "./executors/codex";
import { deriveHandoff } from "./handoff";
import { HANDOFF_CHARS, handoffBlock, renderedHash } from "../core/template";
import { reconstructRender } from "../prompts/library";
import { readLog } from "../log/write";
import type { LoggedEvent, RunEvent } from "../log/events";

const FAKE_CLAUDE = join(import.meta.dir, "executors", "fake-claude.ts");
const FAKE_CODEX = join(import.meta.dir, "executors", "fake-codex.ts");
const HEADINGS = ["### Files examined", "### Files modified", "### Commands run (most recent last)", "### Last stated intent", "### Outputs still owed"];

interface Ctx { goal: string; summary: string }
const graph = (harness: "claude" | "codex" = "claude") => defineGraph<Ctx>({
  name: "handoff", entry: "implement", inputs: ["goal"],
  defaults: { harness },
  nodes: {
    implement: { kind: "agent", prompt: "h.implement" as never, reads: ["goal"], writes: { summary: { scope: "sticky" } }, maxVisits: 5, contextRetries: 0 },
    done: { kind: "terminal", outcome: "success" },
  },
  edges: [{ from: "implement", to: "done" }],
});
function promptsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "howdah-handoff-p-"));
  writeFileSync(join(dir, "h.implement.md"), "---\nid: h.implement\nversion: 1\n---\nImplement {{ context.goal }}.\n");
  return dir;
}
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  Object.assign(process.env, env);
  try { return await fn(); } finally { for (const k of Object.keys(env)) delete process.env[k]; }
}
const renders = (events: LoggedEvent[]) => events.filter((e): e is Extract<LoggedEvent, { type: "prompt-rendered" }> => e.type === "prompt-rendered");

async function exhaustThenResume(dir: string, agent: Executor, env: Record<string, string>, harness: "claude" | "codex" = "claude") {
  const prompts = promptsDir();
  const capture = join(dir, "sent.jsonl");
  writeFileSync(capture, "");
  const make = () => new Engine(graph(harness), { dir, promptsDir: prompts, executors: { agent } });
  await withEnv({ ...env, FAKE_CAPTURE: capture }, async () => {
    expect(await make().start({ goal: "fix the parser" })).toMatchObject({ code: "context-exhausted" });
    expect(await make().resume()).toEqual({ state: "finished", outcome: "success" });
  });
  return readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string);
}

describe("the handoff over the fake wire", () => {
  test("claude: the visit-2 prompt names the touched files and last commands, and reconstructs VERIFIED", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-handoff-"));
    const claude = claudeExecutor({ attentionDir: join(dir, "attn"), binary: FAKE_CLAUDE, askPollMs: 30, notifiers: [] });
    const sent = await exhaustThenResume(dir, claude, {
      FAKE_CLAUDE_CONTEXT: "exceed-once", FAKE_CLAUDE_CONTEXT_STATE: join(dir, "exceeded"), FAKE_CLAUDE_EXCEED_TOOLS: "1",
    });
    const retry = sent[1]!;
    for (const h of HEADINGS) expect(retry).toContain(h);
    expect(retry).toContain("- src/parser.ts"); // examined AND modified
    expect(retry).toContain("`bun test src/parser.test.ts` — FAILED");
    expect(retry).toContain("> Next I will make parse() handle an empty token list.");
    expect(retry).toContain("- summary"); // still owed
    // the git steps are still there, after the handoff
    expect(retry.indexOf("### Outputs still owed")).toBeLessThan(retry.indexOf("Get your bearings"));
    const second = renders(readLog(join(dir, "run.jsonl")))[1]!;
    expect(second).toMatchObject({ suffix_version: 5, reentry_after_visit: 1 });
    expect(renderedHash(retry)).toBe(second.rendered_hash);
    expect(reconstructRender(dir, second.rendered_hash)).toMatchObject({ verified: true });
  }, 30000);

  test("codex: contextWindowExceeded produces the same shape, from commandExecution and fileChange", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-handoff-codex-"));
    const codex = codexExecutor({ attentionDir: join(dir, "attn"), binary: FAKE_CODEX, askPollMs: 30, notifiers: [] });
    const sent = await exhaustThenResume(dir, codex, {
      FAKE_CODEX_CONTEXT: "exceed-once", FAKE_CODEX_CONTEXT_STATE: join(dir, "exceeded"), FAKE_CODEX_EXCEED_TOOLS: "1",
    }, "codex");
    const retry = sent[1]!;
    for (const h of HEADINGS) expect(retry).toContain(h);
    expect(retry).toContain("- src/parser.rs");
    expect(retry).toContain("`cargo test parser` — FAILED");
    const second = renders(readLog(join(dir, "run.jsonl")))[1]!;
    expect(reconstructRender(dir, second.rendered_hash)).toMatchObject({ verified: true });
  }, 30000);
});

describe("a v4 re-entry written before HOW-36 still reconstructs VERIFIED", () => {
  test("the fixture's briefed render (suffix_version 4) verifies with no handoff", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-reentry-v4-"));
    cpSync(join(import.meta.dir, "..", "prompts", "fixtures", "reentry-v4"), dir, { recursive: true });
    const briefed = renders(readLog(join(dir, "run.jsonl"))).find((r) => r.reentry_after_visit !== undefined)!;
    expect(briefed.suffix_version).toBe(4);
    const rebuilt = reconstructRender(dir, briefed.rendered_hash)!;
    expect(rebuilt).toMatchObject({ verified: true });
    expect(rebuilt.text).not.toContain("What the previous visit had done");
  });
});

describe("the block's bounds", () => {
  const stamp = (events: RunEvent[]): LoggedEvent[] => events.map((e, i) => ({ ...e, seq: i + 1, ts: "2026-10-12T00:00:00.000Z" }) as LoggedEvent);
  const base: RunEvent[] = [
    { type: "node-started", node: "impl", visit: 1, attempt_id: "impl#1" },
    { type: "prompt-rendered", node: "impl", visit: 1, prompt: "h.implement" as never, prompt_version: 1, rendered_hash: "h", context_read: {}, harness: "claude" },
  ];

  test("hundreds of tool calls produce a block at most HANDOFF_CHARS, with stubs saying how to get the rest", () => {
    const calls: RunEvent[] = [];
    for (let i = 0; i < 500; i++) {
      calls.push({ type: "chunk", node: "impl", visit: 1, turn: 1, index: i * 2, kind: "tool_call", content: JSON.stringify(i % 2 ? { file_path: `src/module-${i}/a-rather-long-file-name-${i}.ts` } : { command: `bun test src/module-${i} --reporter=verbose ${"x".repeat(150)}` }), tool_id: `t${i}`, tool_name: i % 2 ? (i % 3 ? "Read" : "Edit") : "Bash" });
      calls.push({ type: "chunk", node: "impl", visit: 1, turn: 1, index: i * 2 + 1, kind: "tool_result", content: "ok", tool_id: `t${i}`, is_error: i % 5 === 0 });
    }
    calls.push({ type: "chunk", node: "impl", visit: 1, turn: 1, index: 5000, kind: "text", content: "I was about to ".repeat(400) });
    const h = deriveHandoff(stamp([...base, ...calls]), "impl", 1, ["summary"]);
    expect(h.commands.length).toBe(250);
    const block = handoffBlock(h);
    expect(block.length).toBeLessThanOrEqual(HANDOFF_CHARS);
    for (const heading of HEADINGS) expect(block).toContain(heading);
    expect(block).toMatch(/\+\d+ more files read; re-read a file to see it again/);
    expect(block).toMatch(/\+\d+ earlier commands; re-run one to see its output again/);
  });

  test("a visit that exhausted before any tool call says so — no empty headings", () => {
    const h = deriveHandoff(stamp([...base, { type: "chunk", node: "impl", visit: 1, turn: 1, index: 0, kind: "text", content: "Let me think about the whole design first." }]), "impl", 1, ["summary"]);
    expect(h.noToolCalls).toBe(true);
    const block = handoffBlock(h);
    expect(block).toContain("Visit 1 exhausted its context before calling any tool");
    expect(block).toContain("Let me think about the whole design first.");
    for (const heading of HEADINGS) expect(block).not.toContain(heading);
  });

  test("executor and engine notes are not the agent's intent", () => {
    const h = deriveHandoff(stamp([...base,
      { type: "chunk", node: "impl", visit: 1, turn: 1, index: 0, kind: "text", content: "I'll fix it next." },
      { type: "chunk", node: "impl", visit: 1, turn: 1, index: 1, kind: "text", content: "\n[claude ran out of context window space — this attempt cannot finish]" },
    ]), "impl", 1, []);
    expect(h.lastText).toBe("I'll fix it next.");
  });
});
