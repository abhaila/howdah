/**
 * HOW-48 — "stop at the next tool call", over the fake wire. The stop rides the steer channel
 * (written while a tool call is in flight, proven by the harness's echo). A turn that ends after
 * reading it is `paused-by-operator` — never a success and never a contract violation, because
 * the agent did what the operator asked.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../run";
import { claudeExecutor } from "./claude";
import { defineGraph } from "../../core/graph";
import { EventLog, readLog } from "../../log/write";
import { softStop } from "../steer";
import { STOP_MESSAGE, stopTurnText } from "../../core/steer";
import { reconstructRender } from "../../prompts/library";
import { renderedHash } from "../../core/template";

const FAKE = join(import.meta.dir, "fake-claude.ts");
const ENV = ["FAKE_CLAUDE_STEER", "FAKE_CLAUDE_STEER_WAIT_MS", "FAKE_CLAUDE_HOLD_MS", "FAKE_CAPTURE", "FAKE_CLAUDE_ASK", "FAKE_CLAUDE_ASK_DELAY_MS",
  "FAKE_CLAUDE_RATELIMIT", "FAKE_CLAUDE_QUESTION", "FAKE_CLAUDE_IGNORE_STOP"];
afterEach(() => { for (const k of ENV) delete process.env[k]; });

interface Ctx { goal: string; doc_summary: string; review_verdict: string }

function setup(dir = mkdtempSync(join(tmpdir(), "howdah-softstop-"))) {
  const prompts = join(dir, "..", `${dir.split("/").at(-1)}-p`);
  if (!existsSync(prompts)) {
    mkdirSync(prompts, { recursive: true });
    writeFileSync(join(prompts, "doc.draft.md"), `---\nid: doc.draft\nversion: 1\n---\nDraft toward {{ context.goal }}.\n`);
    writeFileSync(join(prompts, "doc.review.md"), `---\nid: doc.review\nversion: 1\n---\nReview {{ context.doc_summary }}.\n`);
  }
  const graph = defineGraph<Ctx>({
    name: "mini-doc", entry: "draft", inputs: ["goal"],
    nodes: {
      draft: { kind: "agent", prompt: "doc.draft", reads: ["goal"], writes: { doc_summary: { scope: "sticky" } } },
      review: { kind: "agent", prompt: "doc.review", reads: ["doc_summary"], writes: { review_verdict: { scope: "cleared" } } },
      done: { kind: "terminal", outcome: "success" },
    },
    edges: [{ from: "draft", to: "review" }, { from: "review", to: "done" }],
  });
  const engine = new Engine(graph, {
    dir, promptsDir: prompts,
    executors: { agent: claudeExecutor({ attentionDir: join(dir, "attn"), binary: FAKE, askPollMs: 20, notifiers: [] }) },
  });
  return { dir, engine, path: join(dir, "run.jsonl") };
}

async function until(path: string, pred: (events: ReturnType<typeof readLog>) => boolean, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    let events: ReturnType<typeof readLog> = [];
    try { events = readLog(path); } catch {}
    if (pred(events)) return events;
    if (Date.now() > end) throw new Error("timed out waiting on the log");
    await Bun.sleep(15);
  }
}

const firstToolCall = (ev: ReturnType<typeof readLog>) => ev.some((e) => e.type === "chunk" && e.kind === "tool_call" && e.node === "draft");

describe("stop at the next tool call", () => {
  test("delivered at the tool boundary → the turn ends → parks paused-by-operator, quoting the agent; no repair turn", async () => {
    const { dir, engine, path } = setup();
    const capture = join(dir, "capture.jsonl");
    Object.assign(process.env, { FAKE_CLAUDE_STEER: "1", FAKE_CAPTURE: capture, FAKE_CLAUDE_ASK: "0", FAKE_CLAUDE_RATELIMIT: "0" });
    const running = engine.start({ goal: "stop me" });
    await until(path, firstToolCall);
    expect(softStop(dir)).toMatchObject({ ok: true, node: "draft", visit: 1, already: false });
    expect(softStop(dir)).toMatchObject({ ok: true, already: true }); // asking twice is one stop
    const res = await running;
    expect(res).toMatchObject({ state: "parked", node: "draft", code: "paused-by-operator" });
    expect((res as { reason: string }).reason).toContain("paused by the operator at a tool boundary — the agent said: \"Stopping here as asked.");

    const events = readLog(path);
    expect(events.filter((e) => e.type === "soft-stop-requested")).toHaveLength(1);
    expect(events.find((e) => e.type === "soft-stop-delivered")).toMatchObject({ after_tool_id: "toolu_fake_steer_01" });
    expect(events.find((e) => e.type === "soft-stop-honored")).toMatchObject({ last_message: expect.stringContaining("the panel is not started yet") });
    expect(events.find((e) => e.type === "attention-raised")).toMatchObject({ code: "paused-by-operator" });
    // never a success, never a contract violation, never a hop to another harness
    const text = events.filter((e: any) => e.type === "chunk" && e.kind === "text").map((e: any) => e.content).join("");
    expect(text).not.toContain("output contract violation");
    expect(text).not.toContain("allowance exhausted");
    // the harness got the prompt and the stop — no outputs-repair turn
    const turns = readFileSync(capture, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toBe(stopTurnText());
  }, 20_000);

  test("resume renders the agent's own last message into the next visit, and reconstruction is VERIFIED", async () => {
    const { dir, engine, path } = setup();
    Object.assign(process.env, { FAKE_CLAUDE_STEER: "1", FAKE_CLAUDE_ASK: "0", FAKE_CLAUDE_RATELIMIT: "0" });
    const running = engine.start({ goal: "stop then resume" });
    await until(path, firstToolCall);
    softStop(dir);
    expect(await running).toMatchObject({ code: "paused-by-operator" });

    delete process.env.FAKE_CLAUDE_STEER;
    const capture = join(dir, "capture2.jsonl");
    process.env.FAKE_CAPTURE = capture;
    const again = setup(dir).engine;
    expect(await again.resume()).toEqual({ state: "finished", outcome: "success" });
    const events = readLog(path);
    const honored = events.find((e) => e.type === "soft-stop-honored")!;
    const retry = events.find((e) => e.type === "prompt-rendered" && e.node === "draft" && e.visit === 2)!;
    expect(retry).toMatchObject({ resumed_after_stop: honored.seq });
    const sent = JSON.parse(readFileSync(capture, "utf8").split("\n")[0]!) as string;
    expect(sent).toContain("## Resuming after an operator stop");
    expect(sent).toContain("> Stopping here as asked. The derivation is written and committed; the panel is not started yet.");
    const hash = retry.type === "prompt-rendered" ? retry.rendered_hash : "";
    expect(renderedHash(sent)).toBe(hash);
    expect(reconstructRender(dir, hash)).toMatchObject({ verified: true, text: sent });
    // briefed once: the next node's render does not carry it
    expect(events.find((e) => e.type === "prompt-rendered" && e.node === "review")!).not.toHaveProperty("resumed_after_stop");
  }, 20_000);

  test("edge: a stop that arrives while a mid-turn question is pending applies AFTER the answer", async () => {
    const { dir, engine, path } = setup();
    Object.assign(process.env, { FAKE_CLAUDE_QUESTION: "1", FAKE_CLAUDE_STEER: "1", FAKE_CLAUDE_ASK: "0", FAKE_CLAUDE_RATELIMIT: "0" });
    const running = engine.start({ goal: "ask then stop" });
    const asked = await until(path, (ev) => ev.some((e) => e.type === "attention-raised"));
    const ask = asked.find((e) => e.type === "attention-raised")!;
    // the question holds the turn open — a soft stop is accepted, not refused as "waiting on you"
    expect(softStop(dir)).toMatchObject({ ok: true });
    await Bun.sleep(150); // awaitOperator is NOT interrupted: nothing is written into the pending ask
    expect(readLog(path).some((e) => e.type === "soft-stop-delivered")).toBe(false);
    new EventLog(path).append({ type: "attention-resolved", node: "draft", visit: 1, reply: "Approach A", source: "operator", answers: [{ id: "q0", selected: ["Approach A"] }] });
    expect(await running).toMatchObject({ code: "paused-by-operator" });
    const events = readLog(path);
    const answered = events.find((e) => e.type === "attention-resolved")!;
    const delivered = events.find((e) => e.type === "soft-stop-delivered")!;
    expect(delivered.seq).toBeGreaterThan(answered.seq);
    expect(ask.seq).toBeLessThan(answered.seq);
  }, 20_000);

  test("edge: a turn that ends on its own before another tool call — the stop is moot and the run holds at the boundary", async () => {
    const { dir, engine, path } = setup();
    Object.assign(process.env, { FAKE_CLAUDE_HOLD_MS: "400", FAKE_CLAUDE_ASK: "0", FAKE_CLAUDE_RATELIMIT: "0" });
    const running = engine.start({ goal: "finish first" });
    await until(path, (ev) => ev.some((e) => e.type === "chunk" && e.node === "draft"));
    expect(softStop(dir).ok).toBe(true);
    expect(await running).toEqual({ state: "paused", node: "review" });
    const events = readLog(path);
    expect(events.find((e) => e.type === "node-finished" && e.node === "draft")).toMatchObject({ status: "succeeded", writes: { doc_summary: "fake doc_summary" } });
    expect(events.some((e) => e.type === "soft-stop-moot")).toBe(true);
    expect(events.some((e) => e.type === "attention-raised")).toBe(false); // a completed step is not parked
    expect(events.at(-1)).toMatchObject({ type: "run-paused" });
    expect(events.some((e) => e.type === "node-started" && e.node === "review")).toBe(false);
  }, 20_000);

  test("a permission the agent asks for after the stop is refused with the stop, never put to the operator", async () => {
    const { dir, engine, path } = setup();
    Object.assign(process.env, { FAKE_CLAUDE_ASK: "1", FAKE_CLAUDE_ASK_DELAY_MS: "400", FAKE_CLAUDE_RATELIMIT: "0" });
    const running = engine.start({ goal: "deny" });
    await until(path, (ev) => ev.some((e) => e.type === "chunk" && e.node === "draft"));
    softStop(dir);
    expect(await running).toEqual({ state: "paused", node: "review" }); // no tool was in flight: moot
    const events = readLog(path);
    expect(events.some((e) => e.type === "attention-raised")).toBe(false);
    const text = events.filter((e: any) => e.type === "chunk" && e.node === "draft").map((e: any) => e.content).join(" ");
    expect(text).toContain("refused: the operator asked the agent to stop");
    expect(text).toContain("Denied, skipping the write.");
    expect(STOP_MESSAGE).toContain("end your turn");
  }, 20_000);

  test("an agent that keeps calling tools after reading the stop is stopped hard, and says so", async () => {
    const { dir, engine, path } = setup();
    Object.assign(process.env, { FAKE_CLAUDE_STEER: "1", FAKE_CLAUDE_IGNORE_STOP: "1", FAKE_CLAUDE_ASK: "0", FAKE_CLAUDE_RATELIMIT: "0" });
    const running = engine.start({ goal: "ignore me" });
    await until(path, firstToolCall);
    softStop(dir);
    const res = await running;
    expect(res).toMatchObject({ code: "paused-by-operator" });
    expect((res as { reason: string }).reason).toContain("stopped hard");
    expect(readLog(path).find((e) => e.type === "soft-stop-honored")).toMatchObject({ forced: true });
  }, 20_000);
});
