import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../run";
import { claudeExecutor } from "./claude";
import { codexExecutor } from "./codex";
import { buildOutputInstruction, parseOutputs } from "./outputs";
import { defineGraph } from "../../core/graph";
import { EventLog } from "../../log/write";
import { AttentionCenter } from "../attention";

const FAKE = join(import.meta.dir, "fake-claude.ts");
const FAKE_CODEX = join(import.meta.dir, "fake-codex.ts");

interface Ctx {
  goal: string;
  doc_summary: string;
  review_verdict: "pass" | "reject";
}

function promptDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "howdah-p-"));
  writeFileSync(join(dir, "doc.draft.md"), `---\nid: doc.draft\nversion: 1\n---\nDraft toward {{ context.goal }}.\n`);
  writeFileSync(join(dir, "doc.review.md"), `---\nid: doc.review\nversion: 1\n---\nReview {{ context.doc_summary }}.\n`);
  return dir;
}

const miniGraph = () =>
  defineGraph<Ctx>({
    name: "mini-doc",
    entry: "draft",
    inputs: ["goal"],
    nodes: {
      draft: { kind: "agent", prompt: "doc.draft", reads: ["goal"], writes: { doc_summary: { scope: "sticky" } } },
      review: { kind: "agent", prompt: "doc.review", reads: ["doc_summary"], writes: { review_verdict: { scope: "cleared" } } },
      done: { kind: "terminal", outcome: "success" },
    },
    edges: [
      { from: "draft", to: "review" },
      { from: "review", to: "done", condition: { reads: ["review_verdict"], test: (v) => v.review_verdict === "pass", label: "pass" }, weight: 1 },
    ],
  });

describe("outputs contract", () => {
  test("instruction lists the declared keys; none means summary-only", () => {
    expect(buildOutputInstruction(["a", "b"])).toContain('{"outputs": {"a": <value>, "b": <value>}}');
    expect(buildOutputInstruction([])).not.toContain("outputs");
  });

  test("parses the LAST outputs object, tolerating prose and nested braces", () => {
    const text = 'first try {"outputs": {"k": "old"}} then prose…\nfinal: {"outputs": {"k": {"nested": "v}alue"}}}';
    expect(parseOutputs(text, ["k"])).toEqual({ ok: true, writes: { k: { nested: "v}alue" } } });
  });

  test("missing keys and absent object are named problems", () => {
    expect(parseOutputs("no json here", ["k"]).problem).toContain("no {");
    expect(parseOutputs('{"outputs": {"other": 1}}', ["k"]).problem).toContain("missing keys: k");
  });
});

describe("claude executor over the fake wire", () => {
  function engineWith(env: Record<string, string>, attentionDir: string, dir: string) {
    // env vars steer the fake binary; the executor is exactly the production one
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    return new Engine(miniGraph(), {
      dir,
      promptsDir: promptDir(),
      executors: {
        agent: claudeExecutor({ attentionDir, binary: FAKE, askPollMs: 30, notifiers: [] }),
      },
    });
  }

  test("streams chunks, obeys the outputs contract, records usage — full run to terminal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-exec-"));
    const engine = engineWith({ FAKE_CLAUDE_ASK: "0", FAKE_CLAUDE_RATELIMIT: "1", FAKE_CLAUDE_VERDICT: "pass" }, join(dir, "attn"), dir);
    const result = await engine.start({ goal: "test the executor" });
    expect(result).toEqual({ state: "finished", outcome: "success" });

    const events = engine.log.read();
    const text = events.filter((e: any) => e.type === "chunk" && e.kind === "text").map((e: any) => e.content).join("");
    expect(text).toContain("Working on it — doing the thing. 🐘");
    const finalized: any = events.find((e) => e.type === "turn-finalized");
    expect(finalized.usage).toEqual({ input_tokens: 321, output_tokens: 45, cost_usd: 0.0042 });
    expect(events.some((e: any) => e.type === "allowance" && e.harness === "claude" && e.remaining === 0.31)).toBe(true);
    const finish: any = events.find((e: any) => e.type === "node-finished" && e.node === "draft");
    expect(finish.writes).toEqual({ doc_summary: "fake doc_summary" });
  });

  // every agent node asks under FAKE_CLAUDE_ASK=1, so the replier answers each new ask
  function autoReplier(dir: string, attentionDir: string, reply: string, stop: { done: boolean }) {
    return (async () => {
      const { readLog } = await import("../../log/write");
      const path = join(dir, "run.jsonl");
      let answered = 0;
      let sawTool: string | undefined;
      while (!stop.done) {
        await Bun.sleep(40);
        const events = readLog(path);
        const asks = events.filter((e) => e.type === "attention-raised");
        const resolutions = events.filter((e) => e.type === "attention-resolved").length;
        if (asks.length > resolutions) {
          const ask = asks[resolutions]! as any;
          sawTool = ask.ask?.tool_name;
          new EventLog(path).append({ type: "attention-resolved", node: ask.node, visit: ask.visit, reply });
          new AttentionCenter(attentionDir, []).resolve(`${ask.node}:${ask.visit}`);
          answered++;
        }
      }
      return { answered, sawTool };
    })();
  }

  test("permission round-trip: ask parks as attention, reply flows back to the wire", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-exec-"));
    const attentionDir = join(dir, "attn");
    const engine = engineWith({ FAKE_CLAUDE_ASK: "1", FAKE_CLAUDE_RATELIMIT: "0" }, attentionDir, dir);
    const stop = { done: false };
    const replier = autoReplier(dir, attentionDir, "allow", stop);

    const result = await engine.start({ goal: "ask me" });
    stop.done = true;
    const { answered, sawTool } = await replier;
    expect(result).toEqual({ state: "finished", outcome: "success" });
    expect(answered).toBeGreaterThanOrEqual(2); // draft AND review both asked
    expect(sawTool).toBe("Write");
    const text = engine.log.read().filter((e: any) => e.type === "chunk" && e.kind === "text").map((e: any) => e.content).join("");
    expect(text).toContain("Permission granted");
  }, 15000);

  test("denial travels too: a non-allow reply becomes a deny on the wire", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-exec-"));
    const attentionDir = join(dir, "attn");
    const engine = engineWith({ FAKE_CLAUDE_ASK: "1" }, attentionDir, dir);
    const stop = { done: false };
    const replier = autoReplier(dir, attentionDir, "no — use the scratch dir instead", stop);
    await engine.start({ goal: "deny me" });
    stop.done = true;
    await replier;
    const text = engine.log.read().filter((e: any) => e.type === "chunk").map((e: any) => e.content).join("");
    expect(text).toContain("Denied, skipping the write");
    expect(text).toContain("permission denied: no — use the scratch dir instead");
  }, 15000);
});

describe("codex executor over the fake app-server wire", () => {
  test("starts codex with a full-access sandbox by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-codex-"));
    const capture = join(dir, "thread-start.json");
    chmodSync(FAKE_CODEX, 0o755);
    process.env.FAKE_CODEX_CAPTURE = capture;
    const engine = new Engine(miniGraph(), {
      dir,
      promptsDir: promptDir(),
      executors: {
        agent: codexExecutor({ attentionDir: join(dir, "attn"), binary: FAKE_CODEX, notifiers: [] }),
      },
    });

    const result = await engine.start({ goal: "codex sandbox" });

    expect(result).toEqual({ state: "finished", outcome: "success" });
    expect(JSON.parse(readFileSync(capture, "utf8")).sandbox).toBe("danger-full-access");
    delete process.env.FAKE_CODEX_CAPTURE;
  });
});
