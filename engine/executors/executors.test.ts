import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../run";
import { claudeExecutor } from "./claude";
import { codexExecutor } from "./codex";
import { buildOutputInstruction, buildRepairInstruction, parseOutputs } from "./outputs";
import { defineGraph } from "../../core/graph";
import { EventLog } from "../../log/write";
import { AttentionCenter } from "../attention";
import { liveExecutors } from "./index";
import { renderedHash } from "../../core/template";
import type { Harness } from "../../core/graph";

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

  // Live failure: delivery.review_repairs on codex ended in prose after 40+ tool calls on
  // 3 of 6 attempts, failing the node and parking a run that had done all the work.
  test("a turn that ends in prose is repaired in-session instead of failing the node", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-repair-"));
    const engine = engineWith({ FAKE_CLAUDE_ASK: "0", FAKE_CLAUDE_DROP_OUTPUTS: "1", FAKE_CLAUDE_VERDICT: "pass" }, join(dir, "attn"), dir);
    const result = await engine.start({ goal: "repair me" }).finally(() => delete process.env.FAKE_CLAUDE_DROP_OUTPUTS);
    expect(result).toEqual({ state: "finished", outcome: "success" });

    const events = engine.log.read();
    // the miss is visible in the thread, and the node still published its writes
    const text = events.filter((e: any) => e.type === "chunk" && e.kind === "text").map((e: any) => e.content).join("");
    expect(text).toContain("outputs object missing — asking for it");
    expect(text).not.toContain("output contract violation");
    const draft: any = events.find((e: any) => e.type === "node-finished" && e.node === "draft");
    expect(draft.status).toBe("succeeded");
    expect(draft.writes).toEqual({ doc_summary: "fake doc_summary" });
  }, 20000);

  test("the repair is asked once per attempt, not looped", () => {
    expect(buildRepairInstruction(["a", "b"])).toContain('{"outputs": {"a": <value>, "b": <value>}}');
    expect(buildRepairInstruction(["a"])).toContain("Do not redo any work");
  });

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

// system-map 0.1: rendered_hash must cover the bytes the CLI actually receives — the skill
// hint and outputs contract included — for every harness the live registry dispatches.
describe("the prompt proof covers what is sent (system-map 0.1)", () => {
  const skilledGraph = (harness: Harness) =>
    defineGraph<Ctx>({
      name: "mini-doc-skilled",
      entry: "draft",
      inputs: ["goal"],
      defaults: { harness },
      nodes: {
        draft: { kind: "agent", prompt: "doc.draft", reads: ["goal"], writes: { doc_summary: { scope: "sticky" } }, skills: ["review", "qa"] },
        review: { kind: "agent", prompt: "doc.review", reads: ["doc_summary"], writes: { review_verdict: { scope: "cleared" } } },
        done: { kind: "terminal", outcome: "success" },
      },
      edges: [
        { from: "draft", to: "review" },
        { from: "review", to: "done", condition: { reads: ["review_verdict"], test: (v) => v.review_verdict === "pass", label: "pass" }, weight: 1 },
      ],
    });

  async function runCapturing(harness: Harness) {
    const dir = mkdtempSync(join(tmpdir(), "howdah-proof-"));
    const capture = join(dir, "sent.jsonl");
    writeFileSync(capture, "");
    Object.assign(process.env, { FAKE_CAPTURE: capture, FAKE_CLAUDE_ASK: "0", FAKE_CLAUDE_RATELIMIT: "0", FAKE_CLAUDE_VERDICT: "pass" });
    try {
      const engine = new Engine(skilledGraph(harness), {
        dir,
        promptsDir: promptDir(),
        executors: liveExecutors({ attentionDir: join(dir, "attn"), notifiers: [], claudeBinary: FAKE, codexBinary: FAKE_CODEX }),
      });
      const result = await engine.start({ goal: "prove the hash" });
      const sent = readFileSync(capture, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string);
      const renders = engine.log.read().filter((e) => e.type === "prompt-rendered") as Extract<ReturnType<typeof engine.log.read>[number], { type: "prompt-rendered" }>[];
      return { result, sent, renders };
    } finally {
      for (const k of ["FAKE_CAPTURE", "FAKE_CLAUDE_ASK", "FAKE_CLAUDE_RATELIMIT", "FAKE_CLAUDE_VERDICT"]) delete process.env[k];
    }
  }

  for (const harness of ["claude", "opencode", "codex"] as const) {
    test(`${harness}: hash(bytes sent to the CLI) === logged rendered_hash, every turn`, async () => {
      const { result, sent, renders } = await runCapturing(harness);
      expect(result).toEqual({ state: "finished", outcome: "success" });
      expect(sent).toHaveLength(2);
      expect(renders).toHaveLength(2);
      sent.forEach((text, i) => expect(renderedHash(text)).toBe(renders[i]!.rendered_hash));
      // the contract is inside the proof, not bolted on afterwards
      expect(sent[0]).toContain(buildOutputInstruction(["doc_summary"]));
      expect(renders[0]).toMatchObject({ output_keys: ["doc_summary"], suffix_version: 1, harness });
    }, 15000);
  }

  test("codex gets no skill hint; claude and opencode do (behaviour preserved)", async () => {
    const hint = "Relevant installed skills for this task: /review, /qa";
    for (const harness of ["claude", "opencode"] as const) {
      const { sent, renders } = await runCapturing(harness);
      expect(sent[0]).toContain(hint);
      expect(renders[0]!.skills).toEqual(["review", "qa"]);
      expect(sent[1]).not.toContain("Relevant installed skills"); // review declares none
    }
    const { sent, renders } = await runCapturing("codex");
    expect(sent[0]).not.toContain("Relevant installed skills");
    expect(renders[0]!.skills).toEqual([]);
  }, 30000);

  // Upstream 6a31486 added one in-session repair turn when the final message lacks the
  // contract. The repair is a follow-up user turn, so it is OUTSIDE rendered_hash by design:
  // the proof is over the FIRST turn of each attempt, and the repair asks for the same keys
  // the contract did.
  for (const harness of ["claude", "codex"] as const) {
    test(`${harness}: with a repair turn, hash(FIRST turn) === rendered_hash and the repair asks for the contract's keys`, async () => {
      const dropVar = harness === "codex" ? "FAKE_CODEX_DROP_OUTPUTS" : "FAKE_CLAUDE_DROP_OUTPUTS";
      process.env[dropVar] = "1";
      try {
        const { result, sent, renders } = await runCapturing(harness);
        expect(result).toEqual({ state: "finished", outcome: "success" });
        // two attempts, each a first turn followed by its repair turn
        expect(renders).toHaveLength(2);
        expect(sent).toHaveLength(4);
        renders.forEach((render, i) => {
          const first = sent[i * 2]!;
          const repair = sent[i * 2 + 1]!;
          expect(renderedHash(first)).toBe(render.rendered_hash);
          expect(renderedHash(repair)).not.toBe(render.rendered_hash);
          expect(repair).toBe(buildRepairInstruction(render.output_keys ?? []));
        });
      } finally {
        delete process.env[dropVar];
      }
    }, 20000);
  }
});
