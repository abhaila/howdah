/**
 * HOW-47 — steering a running agent over the fake wire. The fake speaks the exact shape the
 * spike recorded against claude 2.1.296 (adapter/fixtures/claude-steer.jsonl): a steer written
 * while a tool call is in flight is delivered after that tool's result and echoed back.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../run";
import { claudeExecutor } from "./claude";
import { defineGraph } from "../../core/graph";
import { readLog } from "../../log/write";
import { steer } from "../steer";
import { steerStates } from "../steer-state";
import { steerTurnText } from "../../core/steer";
import { reconstructRender } from "../../prompts/library";
import { renderedHash } from "../../core/template";

const FAKE = join(import.meta.dir, "fake-claude.ts");
const ENV = ["FAKE_CLAUDE_STEER", "FAKE_CLAUDE_STEER_WAIT_MS", "FAKE_CLAUDE_HOLD_MS", "FAKE_CAPTURE", "FAKE_CLAUDE_ASK", "FAKE_CLAUDE_RATELIMIT"];
afterEach(() => { for (const k of ENV) delete process.env[k]; });

interface Ctx { goal: string; doc_summary: string; review_verdict: string }

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "howdah-steer-"));
  const prompts = mkdtempSync(join(tmpdir(), "howdah-steer-p-"));
  writeFileSync(join(prompts, "doc.draft.md"), `---\nid: doc.draft\nversion: 1\n---\nDraft toward {{ context.goal }}.\n`);
  writeFileSync(join(prompts, "doc.review.md"), `---\nid: doc.review\nversion: 1\n---\nReview {{ context.doc_summary }}.\n`);
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

/** wait until the log satisfies `pred`, then return its events */
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

describe("a steer sent mid-turn", () => {
  test("is delivered at the next tool boundary, logged with the tool call it rode in on, and adopted", async () => {
    const { dir, engine, path } = setup();
    const capture = join(dir, "capture.jsonl");
    Object.assign(process.env, { FAKE_CLAUDE_STEER: "1", FAKE_CAPTURE: capture, FAKE_CLAUDE_ASK: "0", FAKE_CLAUDE_RATELIMIT: "0" });
    const running = engine.start({ goal: "steer me" });
    await until(path, (ev) => ev.some((e) => e.type === "chunk" && e.kind === "tool_call" && e.node === "draft"));
    const sent = steer(dir, "use the existing helper in core/ instead");
    expect(sent).toMatchObject({ ok: true, node: "draft", visit: 1 });
    delete process.env.FAKE_CLAUDE_STEER; // the review step is an ordinary turn
    const res = await running;
    if ((res as any).state !== "finished") console.log(readLog(path).filter((e) => e.type === "chunk" || e.type==="turn-finalized").map((e: any) => `${e.node} ${e.kind} ${e.content?.slice(0,120)}`).join("\n"));
    expect(res).toEqual({ state: "finished", outcome: "success" });

    const events = readLog(path);
    const delivered = events.find((e) => e.type === "steer-delivered");
    expect(delivered).toMatchObject({ node: "draft", visit: 1, steer_seq: (sent as { seq: number }).seq, after_tool_id: "toolu_fake_steer_01" });
    // it landed AFTER the tool's result, exactly where the harness delivered it
    const result = events.find((e) => e.type === "chunk" && e.kind === "tool_result" && e.node === "draft")!;
    expect(delivered!.seq).toBeGreaterThan(result.seq);
    // the tool call was not lost, and the agent adopted the steer in the same turn
    expect(events.filter((e) => e.type === "turn-finalized" && e.node === "draft")).toHaveLength(1);
    const text = events.filter((e: any) => e.type === "chunk" && e.kind === "text" && e.node === "draft").map((e: any) => e.content).join("");
    expect(text).toContain("Steered: use the existing helper in core/ instead.");
    // what reached the harness is the operator-labelled wording, byte for byte
    const turns = readFileSync(capture, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(turns[1]).toBe(steerTurnText("use the existing helper in core/ instead"));
    // a delivered steer is NOT carried into the next render as well
    expect(events.find((e) => e.type === "prompt-rendered" && e.node === "review")!).not.toHaveProperty("steers_carried");
    expect(steerStates(events)[0]).toMatchObject({ delivered: { after_tool_id: "toolu_fake_steer_01" }, carried: null });
  }, 20_000);

  test("racing the end of the turn: never written, carried into the next render, reconstruction VERIFIED", async () => {
    const { dir, engine, path } = setup();
    const capture = join(dir, "capture.jsonl");
    // no tool call at all: the turn just talks, holds, and ends — there is no boundary to deliver at
    Object.assign(process.env, { FAKE_CLAUDE_HOLD_MS: "400", FAKE_CAPTURE: capture, FAKE_CLAUDE_ASK: "0", FAKE_CLAUDE_RATELIMIT: "0" });
    const running = engine.start({ goal: "too late" });
    await until(path, (ev) => ev.some((e) => e.type === "chunk" && e.node === "draft"));
    const sent = steer(dir, "also update the docs");
    expect(sent.ok).toBe(true);
    delete process.env.FAKE_CLAUDE_HOLD_MS;
    expect(await running).toEqual({ state: "finished", outcome: "success" });

    const events = readLog(path);
    expect(events.some((e) => e.type === "steer-delivered")).toBe(false);
    const review = events.find((e) => e.type === "prompt-rendered" && e.node === "review")!;
    expect(review).toMatchObject({ steers_carried: [(sent as { seq: number }).seq], suffix_version: 5 });
    // the next agent's first turn carried it, and that is inside rendered_hash
    const turns = readFileSync(capture, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string);
    const reviewPrompt = turns.find((t) => t.startsWith("Review "))!;
    expect(reviewPrompt).toContain("## Operator steering");
    expect(reviewPrompt).toContain("- also update the docs");
    const hash = review.type === "prompt-rendered" ? review.rendered_hash : "";
    expect(renderedHash(reviewPrompt)).toBe(hash);
    const rebuilt = reconstructRender(dir, hash)!;
    expect(rebuilt.verified).toBe(true);
    expect(rebuilt.text).toBe(reviewPrompt);
    // the draft step's own steer was never written to the harness: one user turn only
    expect(turns.filter((t) => t.includes("OPERATOR STEERING"))).toHaveLength(0);
    expect(steerStates(events)[0]).toMatchObject({ delivered: null, carried: { node: "review", visit: 1 } });
    // carried once: a later render does not carry it again
    expect(events.filter((e) => e.type === "prompt-rendered" && e.steers_carried)).toHaveLength(1);
  }, 20_000);
});
