/**
 * HOW-14: a turn whose context window filled.
 *
 * Pinned here, end to end: the executors fail it with its own code instead of blaming the
 * outputs contract; the engine parks it and NEVER hops harnesses for it (not in-process, not
 * after a resume), even when the attempt's text happens to say "rate limit"; the next attempt
 * of that node — after a resume in a fresh process, or an operator reply — is rendered with
 * the re-entry briefing, logged as `reentry_after_visit` and reconstructed VERIFIED; and a
 * mid-turn compaction is a transcript line that changes nothing else.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineGraph } from "../core/graph";
import { Engine, type AttemptResult, type Executor } from "./run";
import { resolveReply } from "./control";
import { claudeExecutor } from "./executors/claude";
import { codexExecutor } from "./executors/codex";
import { contextExhaustedFailure } from "./executors/harness-failure";
import { readLog } from "../log/write";
import type { LoggedEvent } from "../log/events";
import { SUFFIX_VERSION, renderedHash } from "../core/template";
import { reconstructRender } from "../prompts/library";

const FAKE_CLAUDE = join(import.meta.dir, "executors", "fake-claude.ts");
const FAKE_CODEX = join(import.meta.dir, "executors", "fake-codex.ts");
const BRIEFING = "## Re-entering this step";
const REPLY_HEADING = "## Operator reply";

interface Ctx {
  goal: string;
  summary: string;
  review_verdict: "pass" | "reject";
}

function promptsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "howdah-ctx-p-"));
  writeFileSync(join(dir, "slice.implement.md"), `---\nid: slice.implement\nversion: 1\n---\nImplement {{ context.goal }}.\n`);
  writeFileSync(join(dir, "slice.review.md"), `---\nid: slice.review\nversion: 1\n---\nReview {{ context.summary }}.\n`);
  return dir;
}

/** implement → review → (reject: implement again | pass: done) */
const graph = () =>
  defineGraph<Ctx>({
    name: "ctx-exhaustion",
    entry: "implement",
    inputs: ["goal"],
    nodes: {
      implement: { kind: "agent", prompt: "slice.implement" as any, reads: ["goal"], writes: { summary: { scope: "sticky" } }, maxVisits: 5 },
      review: { kind: "agent", prompt: "slice.review" as any, reads: ["summary"], writes: { review_verdict: { scope: "cleared" } } },
      done: { kind: "terminal", outcome: "success" },
    },
    edges: [
      { from: "implement", to: "review" },
      { from: "review", to: "implement", condition: { reads: ["review_verdict"], test: (v) => v.review_verdict === "reject", label: "reject" }, weight: 2 },
      { from: "review", to: "done", condition: { reads: ["review_verdict"], test: (v) => v.review_verdict === "pass", label: "pass" }, weight: 1 },
    ],
  });
const GRAPHS = { "ctx-exhaustion": graph() };

const ok = (writes: Record<string, unknown>): AttemptResult => ({ status: "succeeded", writes });
const renders = (events: LoggedEvent[], node: string) =>
  events.filter((e): e is Extract<LoggedEvent, { type: "prompt-rendered" }> => e.type === "prompt-rendered" && e.node === node);
const parks = (events: LoggedEvent[]) => events.filter((e): e is Extract<LoggedEvent, { type: "attention-raised" }> => e.type === "attention-raised");
const transcript = (events: LoggedEvent[]) => events.filter((e) => e.type === "chunk").map((e) => (e.type === "chunk" ? e.content : "")).join("");

/**
 * A scripted agent executor: `script["node@visit"]` decides each attempt, and every prompt it
 * was handed is recorded under the same key. "full" is a context-exhausted failure whose
 * transcript deliberately contains allowance words, so only the explicit guard can stop a hop.
 */
type Outcome = "ok" | "full" | "fail";
function scripted(script: Record<string, Outcome>, seen: Map<string, { prompt: string; harness?: string }>): Executor {
  return async ({ nodeId, visit, renderedPrompt, agentConfig, log }) => {
    const key = `${nodeId}@${visit}`;
    seen.set(key, { prompt: renderedPrompt ?? "", harness: agentConfig?.harness });
    const outcome = script[key] ?? "ok";
    if (outcome === "full") {
      log.append({ type: "chunk", node: nodeId, visit, turn: 1, index: 0, kind: "text", content: "Adding a rate limit to the API; quota handling is exhausted next." });
      const f = contextExhaustedFailure(agentConfig?.harness ?? "claude");
      return { status: "failed", writes: {}, reason: f.reason, code: f.code };
    }
    if (outcome === "fail") return { status: "failed", writes: {}, reason: "turn error: something else" };
    return nodeId === "review" ? ok({ review_verdict: "pass" }) : ok({ summary: `done on visit ${visit}` });
  };
}

function engine(dir: string, prompts: string, script: Record<string, Outcome>, seen: Map<string, { prompt: string; harness?: string }>) {
  return new Engine(graph(), {
    dir,
    promptsDir: prompts,
    // a chain is configured on purpose: the hop is AVAILABLE, and must still not be taken
    harnesses: { fallbackChain: ["claude", "codex", "cursor"] },
    executors: { agent: scripted(script, seen) },
  });
}

describe("engine: a context-exhausted attempt parks, never hops, and the retry re-enters (HOW-14)", () => {
  test("parks with its own code even though the transcript reads like a rate limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-ctx-"));
    const seen = new Map<string, { prompt: string; harness?: string }>();
    const result = await engine(dir, promptsDir(), { "implement@1": "full" }, seen).start({ goal: "g" });

    expect(result).toMatchObject({ state: "parked", node: "implement", code: "context-exhausted" });
    expect([...seen.keys()]).toEqual(["implement@1"]); // no fallback visit
    const events = readLog(join(dir, "run.jsonl"));
    expect(parks(events).at(-1)).toMatchObject({ node: "implement", visit: 1, code: "context-exhausted" });
    expect(transcript(events)).not.toContain("retrying this node with");
  });

  test("resume in a FRESH engine: same harness, re-entry briefing rendered, logged and reconstructed VERIFIED", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-ctx-"));
    const prompts = promptsDir();
    const seen = new Map<string, { prompt: string; harness?: string }>();
    const script: Record<string, Outcome> = { "implement@1": "full" };
    await engine(dir, prompts, script, seen).start({ goal: "g" });

    expect(await engine(dir, prompts, script, seen).resume()).toEqual({ state: "finished", outcome: "success" });

    // the run did not decide claude was spent: the retry and the rest of the run stay on it
    expect(seen.get("implement@2")?.harness).toBe("claude");
    expect(seen.get("review@1")?.harness).toBe("claude");

    const retry = seen.get("implement@2")!.prompt;
    expect(retry).toContain(BRIEFING);
    expect(retry).toContain("Visit 1 of this step ran out of context window space");
    expect(retry.indexOf(BRIEFING)).toBeLessThan(retry.indexOf("## Output contract"));
    expect(seen.get("implement@1")!.prompt).not.toContain(BRIEFING);
    expect(seen.get("review@1")!.prompt).not.toContain(BRIEFING); // another node is not re-entering

    const events = readLog(join(dir, "run.jsonl"));
    const [first, second] = renders(events, "implement");
    expect(first).not.toHaveProperty("reentry_after_visit");
    expect(second).toMatchObject({ visit: 2, reentry_after_visit: 1, suffix_version: SUFFIX_VERSION });
    expect(SUFFIX_VERSION).toBe(5);
    expect(renderedHash(retry)).toBe(second!.rendered_hash);

    const rebuilt = reconstructRender(dir, second!.rendered_hash);
    expect(rebuilt).toMatchObject({ verified: true, text: retry });
  });

  test("reconstruction with the field stripped reads UNVERIFIED — it is an input, not a guess", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-ctx-"));
    const prompts = promptsDir();
    const seen = new Map<string, { prompt: string; harness?: string }>();
    const script: Record<string, Outcome> = { "implement@1": "full" };
    await engine(dir, prompts, script, seen).start({ goal: "g" });
    await engine(dir, prompts, script, seen).resume();

    const path = join(dir, "run.jsonl");
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const target = lines.find((e) => e.type === "prompt-rendered" && e.node === "implement" && e.visit === 2);
    delete target.reentry_after_visit;
    writeFileSync(path, lines.map((e) => JSON.stringify(e)).join("\n") + "\n");
    expect(reconstructRender(dir, target.rendered_hash)).toMatchObject({ verified: false });

    // and a v3 render claiming a re-entry is refused rather than thrown on
    target.reentry_after_visit = 1;
    target.suffix_version = 3;
    writeFileSync(path, lines.map((e) => JSON.stringify(e)).join("\n") + "\n");
    expect(reconstructRender(dir, target.rendered_hash)).toMatchObject({ verified: false });
  });

  test("an operator reply to the park is rendered together with the briefing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-ctx-"));
    const prompts = promptsDir();
    const seen = new Map<string, { prompt: string; harness?: string }>();
    const script: Record<string, Outcome> = { "implement@1": "full" };
    await engine(dir, prompts, script, seen).start({ goal: "g" });

    const r = resolveReply(dir, "skip the docs, land the migration", { graphs: GRAPHS });
    expect(r).toMatchObject({ ok: true, node: "implement", visit: 1, code: "context-exhausted", rendered: true });

    await engine(dir, prompts, script, seen).resume();
    const retry = seen.get("implement@2")!.prompt;
    expect(retry).toContain(REPLY_HEADING);
    expect(retry).toContain("skip the docs, land the migration");
    expect(retry).toContain(BRIEFING);
    // fixed order: reply → re-entry → outputs contract
    expect(retry.indexOf(REPLY_HEADING)).toBeLessThan(retry.indexOf(BRIEFING));
    expect(retry.indexOf(BRIEFING)).toBeLessThan(retry.indexOf("## Output contract"));

    const render = renders(readLog(join(dir, "run.jsonl")), "implement")[1]!;
    expect(reconstructRender(dir, render.rendered_hash)).toMatchObject({ verified: true });
  });

  test("the briefing follows the LAST finished visit: a success since ends it, a later failure keeps it off", async () => {
    // implement@1 full → resume → implement@2 ok (briefed) → review rejects → implement@3 must NOT be briefed
    const dir = mkdtempSync(join(tmpdir(), "howdah-ctx-"));
    const prompts = promptsDir();
    const seen = new Map<string, { prompt: string; harness?: string }>();
    let reviews = 0;
    const base = scripted({ "implement@1": "full" }, seen);
    const make = () => new Engine(graph(), {
      dir, promptsDir: prompts,
      executors: {
        agent: async (args) => (args.nodeId === "review" && reviews++ === 0 ? ok({ review_verdict: "reject" }) : base(args)),
      },
    });
    await make().start({ goal: "g" });
    expect(await make().resume()).toEqual({ state: "finished", outcome: "success" });
    expect(seen.get("implement@2")!.prompt).toContain(BRIEFING);
    expect(seen.get("implement@3")!.prompt).not.toContain(BRIEFING);
    expect(renders(readLog(join(dir, "run.jsonl")), "implement")[2]).not.toHaveProperty("reentry_after_visit");
  });

  test("an ordinary attempt-failed park gets no briefing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-ctx-"));
    const prompts = promptsDir();
    const seen = new Map<string, { prompt: string; harness?: string }>();
    const script: Record<string, Outcome> = { "implement@1": "fail" };
    expect(await engine(dir, prompts, script, seen).start({ goal: "g" })).toMatchObject({ code: "attempt-failed" });
    await engine(dir, prompts, script, seen).resume();
    expect(seen.get("implement@2")!.prompt).not.toContain(BRIEFING);
    expect(renders(readLog(join(dir, "run.jsonl")), "implement")[1]).not.toHaveProperty("reentry_after_visit");
  });
});

// ---- the real executors over the fake wires ---------------------------------------------

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
  }
}

function liveEngine(dir: string, prompts: string, agent: Executor) {
  return new Engine(graph(), {
    dir, promptsDir: prompts,
    harnesses: { fallbackChain: ["claude", "codex", "cursor"] },
    executors: { agent },
  });
}

describe("claude executor (HOW-14, fake wire)", () => {
  const claude = (dir: string) => claudeExecutor({ attentionDir: join(dir, "attn"), binary: FAKE_CLAUDE, askPollMs: 30, notifiers: [] });

  test("'Prompt is too long' fails context-exhausted, sends NO repair turn, and does not hop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-ctx-claude-"));
    const capture = join(dir, "sent.jsonl");
    writeFileSync(capture, "");
    const result = await withEnv({ FAKE_CLAUDE_CONTEXT: "exceed", FAKE_CAPTURE: capture }, () =>
      liveEngine(dir, promptsDir(), claude(dir)).start({ goal: "g" }));

    expect(result).toMatchObject({ state: "parked", node: "implement", code: "context-exhausted" });
    expect(readFileSync(capture, "utf8").trim().split("\n")).toHaveLength(1); // the first turn only
    const events = readLog(join(dir, "run.jsonl"));
    expect(renders(events, "implement")).toHaveLength(1); // no fallback visit
    const text = transcript(events);
    expect(text).toContain("ran out of context window space");
    expect(text).not.toContain("output contract violation");
    expect(text).not.toContain("outputs object missing");
  }, 20000);

  test("exceed, then resume: the retry is briefed and finishes the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-ctx-claude-"));
    const prompts = promptsDir();
    const capture = join(dir, "sent.jsonl");
    writeFileSync(capture, "");
    await withEnv({ FAKE_CLAUDE_CONTEXT: "exceed-once", FAKE_CLAUDE_CONTEXT_STATE: join(dir, "exceeded"), FAKE_CAPTURE: capture, FAKE_CLAUDE_VERDICT: "pass" }, async () => {
      expect(await liveEngine(dir, prompts, claude(dir)).start({ goal: "g" })).toMatchObject({ code: "context-exhausted" });
      expect(await liveEngine(dir, prompts, claude(dir)).resume()).toEqual({ state: "finished", outcome: "success" });
    });
    const sent = readFileSync(capture, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string);
    expect(sent[0]).not.toContain(BRIEFING);
    expect(sent[1]).toContain(BRIEFING);
    const second = renders(readLog(join(dir, "run.jsonl")), "implement")[1]!;
    expect(second).toMatchObject({ reentry_after_visit: 1, harness: "claude" });
    expect(renderedHash(sent[1]!)).toBe(second.rendered_hash);
  }, 30000);

  test("a mid-turn compaction is a transcript line; the attempt still succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-ctx-claude-"));
    const result = await withEnv({ FAKE_CLAUDE_CONTEXT: "compact", FAKE_CLAUDE_VERDICT: "pass" }, () =>
      liveEngine(dir, promptsDir(), claude(dir)).start({ goal: "g" }));
    expect(result).toEqual({ state: "finished", outcome: "success" });
    expect(transcript(readLog(join(dir, "run.jsonl")))).toContain("[context compacted (auto): ~167000 tokens summarised");
  }, 20000);
});

describe("codex executor (HOW-14, fake wire)", () => {
  const codex = (dir: string) => codexExecutor({ attentionDir: join(dir, "attn"), binary: FAKE_CODEX, askPollMs: 30, notifiers: [] });
  const codexGraphEngine = (dir: string, agent: Executor) =>
    new Engine(defineGraph<Ctx>({ ...graph().def, defaults: { harness: "codex" } } as any), {
      dir, promptsDir: promptsDir(), harnesses: { fallbackChain: ["claude", "codex", "cursor"] }, executors: { agent },
    });

  test("contextWindowExceeded fails context-exhausted, with no repair turn and no hop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-ctx-codex-"));
    const capture = join(dir, "sent.jsonl");
    writeFileSync(capture, "");
    const result = await withEnv({ FAKE_CODEX_CONTEXT: "exceed", FAKE_CAPTURE: capture }, () =>
      codexGraphEngine(dir, codex(dir)).start({ goal: "g" }));
    expect(result).toMatchObject({ state: "parked", node: "implement", code: "context-exhausted" });
    expect(readFileSync(capture, "utf8").trim().split("\n")).toHaveLength(1);
    const events = readLog(join(dir, "run.jsonl"));
    expect(renders(events, "implement")).toHaveLength(1);
    expect(renders(events, "implement")[0]!.harness).toBe("codex");
    expect(transcript(events)).not.toContain("output contract violation");
  }, 20000);

  test("regression: any FAILED codex turn is a turn error, not an output contract violation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-ctx-codex-"));
    const capture = join(dir, "sent.jsonl");
    writeFileSync(capture, "");
    const result = await withEnv({ FAKE_CODEX_FAIL: "1", FAKE_CAPTURE: capture }, () =>
      codexGraphEngine(dir, codex(dir)).start({ goal: "g" }));
    expect(result).toMatchObject({ state: "parked", code: "attempt-failed", reason: "turn error: stream disconnected before completion" });
    expect(readFileSync(capture, "utf8").trim().split("\n")).toHaveLength(1); // no repair turn on a failed turn
    expect(transcript(readLog(join(dir, "run.jsonl")))).not.toContain("output contract violation");
  }, 20000);

  test("a contextCompaction item is a transcript line; the attempt still succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-ctx-codex-"));
    const result = await withEnv({ FAKE_CODEX_CONTEXT: "compact", FAKE_CLAUDE_VERDICT: "pass" }, () =>
      codexGraphEngine(dir, codex(dir)).start({ goal: "g" }));
    expect(result).toEqual({ state: "finished", outcome: "success" });
    expect(transcript(readLog(join(dir, "run.jsonl")))).toContain("[context compacted: earlier turns summarised");
  }, 20000);
});
