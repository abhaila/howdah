import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../run";
import { claudeExecutor } from "./claude";
import { codexExecutor } from "./codex";
import { cursorApprovalMode, cursorExecutor } from "./cursor";
import { buildOutputInstruction, buildRepairInstruction, parseOutputs } from "./outputs";
import { defineGraph } from "../../core/graph";
import { EventLog } from "../../log/write";
import { AttentionCenter } from "../attention";
import { liveExecutors } from "./index";
import { renderedHash } from "../../core/template";
import type { Harness } from "../../core/graph";

const FAKE = join(import.meta.dir, "fake-claude.ts");
const FAKE_CODEX = join(import.meta.dir, "fake-codex.ts");
const FAKE_CURSOR = join(import.meta.dir, "fake-cursor.ts");

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
    // HOW-34: all three input figures, and the price with its source
    expect(finalized.usage).toEqual({
      input_tokens: 321, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 45,
      cost_usd: 0.0042, cost_source: "reported",
    });
    expect(events.some((e: any) => e.type === "allowance" && e.harness === "claude" && e.remaining === 0.31)).toBe(true);
    const finish: any = events.find((e: any) => e.type === "node-finished" && e.node === "draft");
    expect(finish.writes).toEqual({ doc_summary: "fake doc_summary" });
  });

  test("HOW-33: a node's resolved effort reaches the claude CLI as --effort", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-exec-"));
    const argvFile = join(dir, "argv.jsonl");
    process.env.FAKE_CLAUDE_ARGV = argvFile;
    try {
      const engine = new Engine(miniGraph(), {
        dir,
        promptsDir: promptDir(),
        overrides: { effort: "high" },
        executors: { agent: claudeExecutor({ attentionDir: join(dir, "attn"), binary: FAKE, askPollMs: 30, notifiers: [] }) },
      });
      process.env.FAKE_CLAUDE_VERDICT = "pass";
      expect(await engine.start({ goal: "g" })).toEqual({ state: "finished", outcome: "success" });
      const spawns = readFileSync(argvFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
      expect(spawns.length).toBe(2);
      for (const argv of spawns) expect(argv.slice(argv.indexOf("--effort"), argv.indexOf("--effort") + 2)).toEqual(["--effort", "high"]);
      const rendered = engine.log.read().filter((e: any) => e.type === "prompt-rendered") as any[];
      expect(rendered.every((e) => e.effort === "high" && e.effort_inert === undefined)).toBe(true);
    } finally {
      delete process.env.FAKE_CLAUDE_ARGV;
    }
  });

  test("HOW-49: a TodoWrite input is logged whole, even past the 400-char clip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-exec-"));
    const engine = engineWith({ FAKE_CLAUDE_ASK: "0", FAKE_CLAUDE_RATELIMIT: "0", FAKE_CLAUDE_VERDICT: "pass", FAKE_CLAUDE_TODO: "1" }, join(dir, "attn"), dir);
    try {
      expect(await engine.start({ goal: "keep a plan" })).toEqual({ state: "finished", outcome: "success" });
    } finally {
      delete process.env.FAKE_CLAUDE_TODO;
    }
    const events = engine.log.read();
    const todos = events.filter((e: any) => e.type === "chunk" && e.tool_name === "TodoWrite" && e.node === "draft") as any[];
    expect(todos).toHaveLength(2);
    expect(todos[1].content.length).toBeGreaterThan(400);
    const { derivePlan } = await import("../../web/derive");
    expect(derivePlan(events, "draft", 1)!.items.map((i) => i.status)).toEqual(["completed", "in_progress", "pending", "pending"]);
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

/**
 * HOW-25 — a skill that asks the operator a question. This is the ticket's whole subject: the
 * question used to be swallowed (the adapter dropped it, no attention was raised, and the
 * executor blocked on stdout for ever), so every test here is about the question REACHING a
 * human and the answer REACHING the model, plus the three ways the wait is allowed to end.
 */
describe("claude executor — asking the operator a question (HOW-25)", () => {
  const GRAPHS = { "mini-doc": miniGraph() } as Record<string, any>;

  function questionEngine(dir: string, attentionDir: string, env: Record<string, string>, opts: { askTimeoutMs?: number; notifiers?: any[] } = {}) {
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    return new Engine(miniGraph(), {
      dir,
      promptsDir: promptDir(),
      executors: {
        agent: claudeExecutor({
          attentionDir, binary: FAKE, askPollMs: 20, notifiers: opts.notifiers ?? [],
          ...(opts.askTimeoutMs !== undefined ? { askTimeoutMs: opts.askTimeoutMs } : {}),
        }),
      },
    });
  }

  const clearEnv = () => {
    for (const k of ["FAKE_CLAUDE_QUESTION", "FAKE_CLAUDE_QUESTION_DIE", "FAKE_CAPTURE_ANSWER", "FAKE_CLAUDE_ASK"]) delete process.env[k];
  };

  /** answer every `user-question` park the run raises, the way the card or the CLI would */
  function questionReplier(dir: string, attentionDir: string, answer: (qs: any[]) => { text: string; answers?: unknown }, stop: { done: boolean }) {
    return (async () => {
      const { readLog } = await import("../../log/write");
      const { resolveReply } = await import("../control");
      const path = join(dir, "run.jsonl");
      const seen: any[] = [];
      while (!stop.done) {
        await Bun.sleep(25);
        const events = readLog(path);
        const asks = events.filter((e: any) => e.type === "attention-raised");
        const resolutions = events.filter((e) => e.type === "attention-resolved").length;
        if (asks.length > resolutions) {
          const ask = asks[resolutions]! as any;
          seen.push(ask);
          const result = resolveReply(dir, answer(ask.ask?.questions ?? []), { graphs: GRAPHS });
          if (result.ok) new AttentionCenter(attentionDir, []).resolve(`${ask.node}:${ask.visit}`);
        }
      }
      return seen;
    })();
  }

  test("the question parks as itself — the questions are in the log and the reason IS the question", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-auq-"));
    const attentionDir = join(dir, "attn");
    // the notification must fire AFTER the durable append (engine/attention.ts)
    const rung: Array<{ body: string; seqAtRing: number }> = [];
    const { readLog } = await import("../../log/write");
    const notifier = async (n: any) => {
      rung.push({ body: n.body, seqAtRing: readLog(join(dir, "run.jsonl")).filter((e: any) => e.type === "attention-raised").length });
    };
    const engine = questionEngine(dir, attentionDir, { FAKE_CLAUDE_QUESTION: "1", FAKE_CLAUDE_ASK: "0" }, { notifiers: [notifier] });
    const stop = { done: false };
    const replier = questionReplier(dir, attentionDir, () => ({ text: "Approach A" }), stop);
    await engine.start({ goal: "ask me something" });
    stop.done = true;
    const asks = await replier;
    clearEnv();

    const first = asks[0];
    expect(first.ask.kind).toBe("user-question");
    expect(first.ask.tool_name).toBe("AskUserQuestion");
    // the operator is told WHAT is being asked, not that a tool wants permission
    expect(first.reason).toBe("Which approach should I take?");
    expect(first.reason).not.toContain("needs permission");
    expect(first.ask.questions[0].options.map((o: any) => o.label)).toEqual(["Approach A", "Approach B"]);
    expect(first.ask.questions[0].options[0].description).toBe("Take Approach A.");
    // durable BEFORE delivered: the raise was already in the log when the notifier ran
    expect(rung.length).toBeGreaterThan(0);
    expect(rung[0]!.seqAtRing).toBeGreaterThanOrEqual(1);
    expect(rung[0]!.body).toContain("Which approach should I take?");
  }, 20000);

  test("a clicked option reaches the model as an answer, and the turn carries on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-auq-"));
    const attentionDir = join(dir, "attn");
    const captured = join(dir, "answer.txt");
    const engine = questionEngine(dir, attentionDir, { FAKE_CLAUDE_QUESTION: "1", FAKE_CLAUDE_ASK: "0", FAKE_CAPTURE_ANSWER: captured });
    const stop = { done: false };
    const replier = questionReplier(dir, attentionDir, (qs) => ({ text: "", answers: [{ id: qs[0].id, selected: ["Approach B"] }] }), stop);
    const result = await engine.start({ goal: "ask me something" });
    stop.done = true;
    await replier;
    clearEnv();

    expect(result).toEqual({ state: "finished", outcome: "success" });
    // what the harness actually received — the CLI's own answered-question phrasing
    const message = readFileSync(captured, "utf8");
    expect(message).toContain("The user answered:");
    expect(message).toContain('"Which approach should I take?"="Approach B"');
    expect(message).not.toContain("permission denied");

    const events = engine.log.read();
    // ONE node-started for draft: the answer landed mid-turn, the node did not restart
    expect(events.filter((e: any) => e.type === "node-started" && e.node === "draft")).toHaveLength(1);
    const draft: any = events.find((e: any) => e.type === "node-finished" && e.node === "draft");
    expect(draft.status).toBe("succeeded");
    expect(draft.writes).toEqual({ doc_summary: "fake doc_summary" });
    // the answer is IN the transcript, pinned to the call it answered
    const answerChunk: any = events.find((e: any) => e.type === "chunk" && e.kind === "tool_result" && e.tool_name === "AskUserQuestion");
    expect(answerChunk.content).toBe("Approach: Approach B");
    expect(answerChunk.tool_id).toBe("toolu_fake_auq_01");
    // and the structured pick is on the resolution, beside the prose
    const resolved: any = events.find((e: any) => e.type === "attention-resolved");
    expect(resolved.answers).toEqual([{ id: "q0", selected: ["Approach B"] }]);
    expect(resolved.reply).toBe("Approach: Approach B");
  }, 20000);

  test("a typed reply answers it too — `howdah reply <run> \"Approach B\"` is not second-class", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-auq-"));
    const attentionDir = join(dir, "attn");
    const captured = join(dir, "answer.txt");
    const engine = questionEngine(dir, attentionDir, { FAKE_CLAUDE_QUESTION: "1", FAKE_CLAUDE_ASK: "0", FAKE_CAPTURE_ANSWER: captured });
    const stop = { done: false };
    // plain text, exactly what the CLI verb sends — no `answers` at all
    const replier = questionReplier(dir, attentionDir, () => ({ text: "approach b" }), stop);
    const result = await engine.start({ goal: "ask me something" });
    stop.done = true;
    await replier;
    clearEnv();

    expect(result).toEqual({ state: "finished", outcome: "success" });
    expect(readFileSync(captured, "utf8")).toContain('"Which approach should I take?"="Approach B"');
  }, 20000);

  test("words that match no option are carried to the model whole, not dropped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-auq-"));
    const attentionDir = join(dir, "attn");
    const captured = join(dir, "answer.txt");
    const engine = questionEngine(dir, attentionDir, { FAKE_CLAUDE_QUESTION: "1", FAKE_CLAUDE_ASK: "0", FAKE_CAPTURE_ANSWER: captured });
    const stop = { done: false };
    const replier = questionReplier(dir, attentionDir, () => ({ text: "neither — ask me again after you read the spec" }), stop);
    await engine.start({ goal: "ask me something" });
    stop.done = true;
    await replier;
    clearEnv();
    expect(readFileSync(captured, "utf8")).toContain("notes: neither — ask me again after you read the spec");
  }, 20000);

  test("several questions, including a multi-select, all travel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-auq-"));
    const attentionDir = join(dir, "attn");
    const captured = join(dir, "answer.txt");
    const engine = questionEngine(dir, attentionDir, { FAKE_CLAUDE_QUESTION: "multi", FAKE_CLAUDE_ASK: "0", FAKE_CAPTURE_ANSWER: captured });
    const stop = { done: false };
    const replier = questionReplier(dir, attentionDir, (qs) => ({
      text: "",
      answers: [{ id: qs[0].id, selected: ["Approach A"] }, { id: qs[1].id, selected: ["src", "tests"] }],
    }), stop);
    const result = await engine.start({ goal: "ask me twice" });
    stop.done = true;
    const asks = await replier;
    clearEnv();

    expect(result).toEqual({ state: "finished", outcome: "success" });
    expect(asks[0].ask.questions).toHaveLength(2);
    expect(asks[0].ask.questions[1].multiSelect).toBe(true);
    // the reason names the first question and says how many more are waiting
    expect(asks[0].reason).toBe("Which approach should I take? (+1 more)");
    const message = readFileSync(captured, "utf8");
    expect(message).toContain('"Which approach should I take?"="Approach A"');
    expect(message).toContain('"Which files may I touch?"="src", "tests"');
  }, 20000);

  test("a harness that dies with a question pending PARKS with a reason — it does not spin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-auq-"));
    const engine = questionEngine(dir, join(dir, "attn"), { FAKE_CLAUDE_QUESTION: "1", FAKE_CLAUDE_QUESTION_DIE: "1", FAKE_CLAUDE_ASK: "0" });
    // nobody answers: before HOW-25 this never returned
    const result: any = await engine.start({ goal: "die on me" });
    clearEnv();
    // parking IS the answer here — normal control flow with a reason, not a frozen `running`
    expect(result.state).toBe("parked");
    expect(result.reason).toContain("the harness exited while it was waiting for you to answer");
    expect(result.reason).toContain("Which approach should I take?");
    // and it is NOT reported as the model breaking its contract
    expect(result.reason).not.toContain("output contract violation");
    const park: any = engine.log.read().findLast((e: any) => e.type === "attention-raised");
    expect(park.code).toBe("attempt-failed");
    expect(park.reason).toBe(result.reason);
  }, 20000);

  test("a configured wait that runs out parks naming the wait, rather than answering into a closed door", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-auq-"));
    const engine = questionEngine(dir, join(dir, "attn"), { FAKE_CLAUDE_QUESTION: "1", FAKE_CLAUDE_ASK: "0" }, { askTimeoutMs: 150 });
    const result: any = await engine.start({ goal: "nobody is home" });
    clearEnv();
    expect(result.state).toBe("parked");
    expect(result.reason).toContain("nobody answered within the configured wait");
    expect(result.reason).toContain("Which approach should I take?");
    const park: any = engine.log.read().findLast((e: any) => e.type === "attention-raised");
    expect(park.reason).toBe(result.reason);
  }, 20000);

  test("an ordinary permission is still a permission — the question path did not swallow it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-auq-"));
    const attentionDir = join(dir, "attn");
    const engine = questionEngine(dir, attentionDir, { FAKE_CLAUDE_ASK: "1", FAKE_CLAUDE_QUESTION: "" });
    const stop = { done: false };
    const replier = questionReplier(dir, attentionDir, () => ({ text: "allow" }), stop);
    const result = await engine.start({ goal: "just a permission" });
    stop.done = true;
    const asks = await replier;
    clearEnv();
    expect(result).toEqual({ state: "finished", outcome: "success" });
    expect(asks[0].ask.kind).toBe("can_use_tool");
    expect(asks[0].reason).toBe("Write needs permission");
  }, 20000);
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

  // system-map 1a (D6/5A) over 9f59264's full-access default: a readOnly node resolves to
  // plan, and codex has no modes — so the thread itself must open read-only.
  test("a readOnly node opens a read-only codex sandbox, not the full-access default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-codex-ro-"));
    const capture = join(dir, "thread-start.json");
    chmodSync(FAKE_CODEX, 0o755);
    process.env.FAKE_CODEX_CAPTURE = capture;
    const ro = defineGraph<Ctx>({
      name: "mini-doc-ro",
      entry: "draft",
      inputs: ["goal"],
      defaults: { harness: "codex" },
      nodes: {
        draft: { kind: "agent", prompt: "doc.draft", readOnly: true, reads: ["goal"], writes: { doc_summary: { scope: "sticky" } } },
        done: { kind: "terminal", outcome: "success" },
      },
      edges: [{ from: "draft", to: "done" }],
    });
    try {
      const engine = new Engine(ro, {
        dir,
        promptsDir: promptDir(),
        overrides: { permissionMode: "bypassPermissions" },
        executors: { agent: codexExecutor({ attentionDir: join(dir, "attn"), binary: FAKE_CODEX, notifiers: [] }) },
      });
      expect(await engine.start({ goal: "read only" })).toEqual({ state: "finished", outcome: "success" });
      expect(JSON.parse(readFileSync(capture, "utf8")).sandbox).toBe("read-only");
    } finally {
      delete process.env.FAKE_CODEX_CAPTURE;
    }
  });

  // Every server→client request is answered on the wire or the turn hangs — the live failure
  // was ten hours inside an MCP connector's "reconnect me" request that nothing answered.
  // The fake raises one request per mode and writes what came back into its final text.
  function codexEngine(dir: string, env: Record<string, string>, opts: { askTimeoutMs?: number } = {}) {
    chmodSync(FAKE_CODEX, 0o755);
    Object.assign(process.env, env);
    return new Engine(miniGraph(), {
      dir,
      promptsDir: promptDir(),
      executors: { agent: codexExecutor({ attentionDir: join(dir, "attn"), binary: FAKE_CODEX, notifiers: [], askPollMs: 30, ...opts }) },
    });
  }
  function codexReplier(dir: string, answer: (ask: any) => { reply: string; answers?: unknown }, stop: { done: boolean }) {
    return (async () => {
      const path = join(dir, "run.jsonl");
      const seen: any[] = [];
      while (!stop.done) {
        await Bun.sleep(30);
        const events = new EventLog(path).read();
        const asks = events.filter((e) => e.type === "attention-raised");
        const resolutions = events.filter((e) => e.type === "attention-resolved").length;
        if (asks.length > resolutions) {
          const ask = asks[resolutions]! as any;
          seen.push(ask);
          const a = answer(ask);
          new EventLog(path).append({ type: "attention-resolved", node: ask.node, visit: ask.visit, reply: a.reply, ...(a.answers !== undefined ? { answers: a.answers } : {}) } as any);
          new AttentionCenter(join(dir, "attn"), []).resolve(`${ask.node}:${ask.visit}`);
        }
      }
      return seen;
    })();
  }
  const finalText = (engine: Engine) =>
    engine.log.read().filter((e: any) => e.type === "chunk" && e.kind === "text").map((e: any) => e.content).join("");

  test("codex: an MCP elicitation parks quoting the message and the URL; a refusal declines, anything else accepts", async () => {
    for (const [reply, action] of [["deny", "decline"], ["done, reconnected", "accept"], ["", "accept"]] as const) {
      const dir = mkdtempSync(join(tmpdir(), "howdah-codex-elicit-"));
      const engine = codexEngine(dir, { FAKE_CODEX_ELICIT: "1" });
      const stop = { done: false };
      const replier = codexReplier(dir, () => ({ reply }), stop);
      try {
        expect(await engine.start({ goal: "elicit" })).toEqual({ state: "finished", outcome: "success" });
      } finally {
        stop.done = true;
        delete process.env.FAKE_CODEX_ELICIT;
      }
      const [ask] = await replier;
      expect(ask.ask).toMatchObject({ kind: "mcp-elicitation", server: "codex_apps", mode: "url", url: "https://chatgpt.com/apps/linear/fake" });
      expect(ask.reason).toBe("codex_apps needs you: Reconnect Linear on ChatGPT to restore access for this request. https://chatgpt.com/apps/linear/fake");
      expect(finalText(engine)).toContain(`[fake: elicitation ${action}]`);
      // the MCP call itself is a tool call in the transcript now, with its outcome
      const chunks = engine.log.read().filter((e: any) => e.type === "chunk" && e.node === "draft") as any[];
      expect(chunks.find((c) => c.kind === "tool_call")?.tool_name).toBe("mcpToolCall");
      expect(chunks.find((c) => c.kind === "tool_result" && c.tool_id === "mcp1")?.is_error).toBe(action === "accept" ? undefined : true);
    }
  }, 30000);

  // codex's multi_agent feature: a `spawn_agent` child shares this connection. Its turn end
  // must not end OUR turn and its report is not OUR final message — live, a three-reviewer
  // turn failed the outputs contract on the first reviewer's report (fake-codex.ts header)
  test("codex: a sub-agent thread's turn end and report are not the attempt's own", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-codex-sub-"));
    const engine = codexEngine(dir, { FAKE_CODEX_SUBAGENT: "1" });
    try {
      expect(await engine.start({ goal: "sub-agents" })).toEqual({ state: "finished", outcome: "success" });
    } finally {
      delete process.env.FAKE_CODEX_SUBAGENT;
    }
    const events = engine.log.read() as any[];
    // one turn: the sub-agent's turn/completed did not end ours, so no repair turn was asked for
    expect(events.filter((e) => e.type === "turn-finalized" && e.node === "draft")).toHaveLength(1);
    const text = finalText(engine);
    expect(text).not.toContain("[outputs object missing");
    expect(text).not.toContain("SUB DELTA"); // its deltas never interleave with ours
    expect(text).toContain("[sub-agent fake-sub reported]\nSUB REPORT: one blocking finding");
    // its work is still on the record, under the tool's own name
    const call = events.find((e) => e.type === "chunk" && e.kind === "tool_call" && e.tool_id === "sub-cx1");
    expect(call?.tool_name).toBe("commandExecution");
    expect(events.find((e) => e.type === "chunk" && e.kind === "tool_result" && e.tool_id === "sub-cx1")?.content).toContain("diff --git");
  }, 30000);

  test("codex: a form elicitation is declined at once with a note — nothing here can draw a schema", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-codex-form-"));
    const engine = codexEngine(dir, { FAKE_CODEX_ELICIT: "1", FAKE_CODEX_ELICIT_MODE: "form" });
    try {
      expect(await engine.start({ goal: "form" })).toEqual({ state: "finished", outcome: "success" });
    } finally {
      for (const k of ["FAKE_CODEX_ELICIT", "FAKE_CODEX_ELICIT_MODE"]) delete process.env[k];
    }
    expect(engine.log.read().some((e) => e.type === "attention-raised")).toBe(false);
    expect(finalText(engine)).toContain("asked for a form form howdah cannot draw — declined");
    expect(finalText(engine)).toContain("[fake: elicitation decline]");
  }, 20000);

  test("codex: request_user_input is the HOW-25 question park, answered in codex's own shape", async () => {
    const { askQuestions } = await import("../../core/ask");
    for (const [name, answer] of [
      ["clicked", (ask: any) => ({ reply: "Blue", answers: [{ id: askQuestions(ask)![0]!.id, selected: ["Blue"], other: "the cool one" }] })],
      ["typed", () => ({ reply: "Blue" })],
    ] as const) {
      const dir = mkdtempSync(join(tmpdir(), `howdah-codex-ask-${name}-`));
      const engine = codexEngine(dir, { FAKE_CODEX_ASK: "1" });
      const stop = { done: false };
      const replier = codexReplier(dir, answer, stop);
      try {
        expect(await engine.start({ goal: "ask" })).toEqual({ state: "finished", outcome: "success" });
      } finally {
        stop.done = true;
        delete process.env.FAKE_CODEX_ASK;
      }
      const [ask] = await replier;
      expect(ask.ask.kind).toBe("user-question");
      expect(ask.reason).toBe("Which colour?");
      expect(askQuestions(ask)).toEqual([{ id: "q0", header: "Colour", question: "Which colour?", multiSelect: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }]);
      // keyed by codex's own question id, never q0
      expect(finalText(engine)).toContain(name === "clicked" ? '[fake: answered {"colour":{"answers":["Blue","the cool one"]}}]' : '[fake: answered {"colour":{"answers":["Blue"]}}]');
    }
  }, 30000);

  test("codex: a request kind howdah does not model is refused on the wire, and the turn goes on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-codex-unknown-"));
    const engine = codexEngine(dir, { FAKE_CODEX_UNKNOWN_REQUEST: "1" });
    try {
      expect(await engine.start({ goal: "unknown" })).toEqual({ state: "finished", outcome: "success" });
    } finally {
      delete process.env.FAKE_CODEX_UNKNOWN_REQUEST;
    }
    expect(engine.log.read().some((e) => e.type === "attention-raised")).toBe(false);
    const text = finalText(engine);
    expect(text).toContain("[codex asked for account/chatgptAuthTokens/refresh, which howdah does not handle — refused on the wire]");
    expect(text).toContain("[fake: token refresh refused: howdah does not handle account/chatgptAuthTokens/refresh]");
  }, 20000);

  test("codex: a park nobody answers within the configured wait fails the attempt with that reason", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-codex-wait-"));
    const engine = codexEngine(dir, { FAKE_CODEX_ELICIT: "1" }, { askTimeoutMs: 150 });
    try {
      expect(await engine.start({ goal: "wait" })).toMatchObject({ state: "parked" });
    } finally {
      delete process.env.FAKE_CODEX_ELICIT;
    }
    const parks = engine.log.read().filter((e) => e.type === "attention-raised") as any[];
    expect(parks.at(-1)).toMatchObject({ code: "attempt-failed", reason: expect.stringContaining("nobody answered within the configured wait: codex_apps needs you") });
    expect(finalText(engine)).toContain("[nobody answered within the configured wait: codex_apps needs you");
  }, 20000);
});

/**
 * Cursor (HOW-17). The fake speaks the DOCUMENTED cursor-agent envelope, not a captured one
 * (adapter/cursor.ts and fake-cursor.ts both say so), so what these pin is the executor's own
 * behaviour — the flag policy, the chunking, the resumed repair turn and the exit
 * classification — rather than that cursor-agent really talks this way.
 */
describe("cursor executor over the fake print-mode wire", () => {
  const cursorGraph = (readOnly?: true) =>
    defineGraph<Ctx>({
      name: readOnly ? "mini-cursor-ro" : "mini-cursor",
      entry: "draft",
      inputs: ["goal"],
      defaults: { harness: "cursor" },
      nodes: {
        draft: { kind: "agent", prompt: "doc.draft", ...(readOnly ? { readOnly } : {}), reads: ["goal"], writes: { doc_summary: { scope: "sticky" } } },
        done: { kind: "terminal", outcome: "success" },
      },
      edges: [{ from: "draft", to: "done" }],
    });

  async function runCursor(graph: ReturnType<typeof cursorGraph>, opts: { readOnly?: boolean; env?: Record<string, string>; engineOpts?: any } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "howdah-cursor-"));
    const capture = join(dir, "argv.jsonl");
    chmodSync(FAKE_CURSOR, 0o755);
    Object.assign(process.env, { FAKE_CURSOR_CAPTURE: capture, ...(opts.env ?? {}) });
    try {
      const engine = new Engine(graph, {
        dir,
        promptsDir: promptDir(),
        ...(opts.engineOpts ?? {}),
        executors: { agent: cursorExecutor({ binary: FAKE_CURSOR, readOnly: opts.readOnly }) },
      });
      const result = await engine.start({ goal: "cursor please" });
      const spawns = readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
      return { result, spawns, engine };
    } finally {
      for (const k of ["FAKE_CURSOR_CAPTURE", ...Object.keys(opts.env ?? {})]) delete process.env[k];
    }
  }

  test("one spawn per attempt: print mode, stream-json, prompt last, and the work lands", async () => {
    const { result, spawns, engine } = await runCursor(cursorGraph());
    expect(result).toEqual({ state: "finished", outcome: "success" });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.slice(0, 3)).toEqual(["-p", "--output-format", "stream-json"]);
    const finished: any = engine.log.read().findLast((e) => e.type === "node-finished");
    expect(finished.writes).toEqual({ doc_summary: "fake doc_summary" });
    // the stream reached the log as durable chunks, tool calls included
    const kinds = new Set(engine.log.read().filter((e) => e.type === "chunk").map((e: any) => e.kind));
    expect([...kinds]).toContain("tool_call");
    expect([...kinds]).toContain("tool_result");
  }, 15000);

  // system-map 1a (D6/5A) — the hard constraint that must survive a fallback to cursor
  test("a readOnly node never gets the auto-approve flag; an ordinary one does", async () => {
    const plan = await runCursor(cursorGraph(true), { engineOpts: { overrides: { permissionMode: "bypassPermissions" } } });
    expect(plan.result).toEqual({ state: "finished", outcome: "success" });
    expect(plan.spawns[0]).not.toContain("--force");

    const open = await runCursor(cursorGraph());
    expect(open.spawns[0]).toContain("--force");
  }, 20000);

  test("the read-only executor variant refuses --force whatever the resolved mode says", async () => {
    const { spawns } = await runCursor(cursorGraph(), { readOnly: true });
    expect(spawns[0]).not.toContain("--force");
  }, 15000);

  test("approval flags map from the permission mode, not from a default", () => {
    expect(cursorApprovalMode("plan")).toEqual([]);
    expect(cursorApprovalMode("manual")).toEqual([]); // print mode has nobody to ask
    expect(cursorApprovalMode("auto")).toEqual(["--force"]);
    expect(cursorApprovalMode(undefined)).toEqual(["--force"]);
  });

  test("a missing outputs contract is repaired by RESUMING the same chat, not re-running the node", async () => {
    const { result, spawns, engine } = await runCursor(cursorGraph(), { env: { FAKE_CURSOR_DROP_OUTPUTS: "1" } });
    expect(result).toEqual({ state: "finished", outcome: "success" });
    expect(spawns).toHaveLength(2);
    expect(spawns[1]).toContain("--resume");
    expect(spawns[1]![spawns[1]!.indexOf("--resume") + 1]).toBe("fake-cursor-chat-1");
    expect(spawns[1]!.at(-1)).toBe(buildRepairInstruction(["doc_summary"]));
    // one visit, not two: the repair is a turn, not a retry
    expect(engine.log.read().filter((e) => e.type === "node-started" && e.node === "draft")).toHaveLength(1);
  }, 20000);

  test("a cursor-side turn error is a turn error, even when cursor says nothing about it", async () => {
    // is_error with no words at all: the error text is empty at every level, and an empty
    // error reads as NO error to the executor's truthiness check — which would fall through
    // to parseOutputs and park the node as an output contract violation, blaming the model
    // for a turn cursor itself failed. `classifyHarnessExit` cannot catch it either: the CLI
    // spoke the protocol and exited 0, so the exit is not the failure.
    const { result } = await runCursor(cursorGraph(), { env: { FAKE_CURSOR_ERROR: "1" } });
    expect(result).toMatchObject({ state: "parked", code: "attempt-failed" });
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain("turn error:");
    expect(reason).toContain("cursor reported an error");
    expect(reason).not.toContain("output contract violation");
  }, 15000);

  test("a logged-out cursor-agent parks on the login verb, not on the outputs contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-cursor-auth-"));
    const bin = join(dir, "logged-out-cursor");
    writeFileSync(bin, "#!/bin/sh\necho 'Please log in: run cursor-agent login' >&2\nexit 1\n");
    chmodSync(bin, 0o755);
    const engine = new Engine(cursorGraph(), {
      dir,
      promptsDir: promptDir(),
      executors: { agent: cursorExecutor({ binary: bin }) },
    });
    const result = await engine.start({ goal: "no credentials" });
    expect(result).toMatchObject({ state: "parked", code: "harness-unauthenticated" });
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain("not logged in");
    expect(reason).not.toContain("output contract");
  }, 15000);
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
        executors: liveExecutors({ attentionDir: join(dir, "attn"), notifiers: [], claudeBinary: FAKE, codexBinary: FAKE_CODEX, cursorBinary: FAKE_CURSOR }),
      });
      const result = await engine.start({ goal: "prove the hash" });
      const sent = readFileSync(capture, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string);
      const events = engine.log.read();
      const renders = events.filter((e) => e.type === "prompt-rendered") as Extract<ReturnType<typeof engine.log.read>[number], { type: "prompt-rendered" }>[];
      return { result, sent, renders, events };
    } finally {
      for (const k of ["FAKE_CAPTURE", "FAKE_CLAUDE_ASK", "FAKE_CLAUDE_RATELIMIT", "FAKE_CLAUDE_VERDICT"]) delete process.env[k];
    }
  }

  for (const harness of ["claude", "opencode", "codex", "cursor"] as const) {
    test(`${harness}: hash(bytes sent to the CLI) === logged rendered_hash, every turn`, async () => {
      const { result, sent, renders } = await runCapturing(harness);
      expect(result).toEqual({ state: "finished", outcome: "success" });
      expect(sent).toHaveLength(2);
      expect(renders).toHaveLength(2);
      sent.forEach((text, i) => expect(renderedHash(text)).toBe(renders[i]!.rendered_hash));
      // the contract is inside the proof, not bolted on afterwards
      expect(sent[0]).toContain(buildOutputInstruction(["doc_summary"]));
      expect(renders[0]).toMatchObject({ output_keys: ["doc_summary"], suffix_version: 8, harness });
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
    // HOW-17: cursor joins codex on the no-hint side, and the LOGGED skills say so — a
    // harness credited with a hint it never got makes every reconstruction of that turn lie
    for (const harness of ["codex", "cursor"] as const) {
      const { sent, renders } = await runCapturing(harness);
      expect(sent[0]).not.toContain("Relevant installed skills");
      expect(renders[0]!.skills).toEqual([]);
    }
  }, 45000);

  // Upstream 6a31486 added one in-session repair turn when the final message lacks the
  // contract. The repair is a follow-up user turn, so it is OUTSIDE rendered_hash by design:
  // the proof is over the FIRST turn of each attempt, and the repair asks for the same keys
  // the contract did.
  const DROP_VAR = { claude: "FAKE_CLAUDE_DROP_OUTPUTS", codex: "FAKE_CODEX_DROP_OUTPUTS", cursor: "FAKE_CURSOR_DROP_OUTPUTS" } as const;
  for (const harness of ["claude", "codex", "cursor"] as const) {
    test(`${harness}: with a repair turn, hash(FIRST turn) === rendered_hash and the repair asks for the contract's keys`, async () => {
      const dropVar = DROP_VAR[harness];
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

    // HOW-34: the repair is its OWN turn — turn 2 of the visit, with its own usage — so it can
    // be told apart from the attempt's turn, and a cumulative report is never double-counted
    test(`${harness}: the outputs repair is numbered turn 2, with its own usage`, async () => {
      const dropVar = DROP_VAR[harness];
      process.env[dropVar] = "1";
      try {
        const { events } = await runCapturing(harness);
        const finals = events.filter((e) => e.type === "turn-finalized" && e.node === "draft") as any[];
        expect(finals.map((e) => e.turn)).toEqual([1, 2]);
        if (harness === "claude") {
          // the CLI said 0.0042 then 0.0084 (cumulative): each turn records its own share
          expect(finals.map((e) => e.usage.cost_usd)).toEqual([0.0042, 0.0042]);
        } else if (harness === "codex") {
          // thread totals 500/300/40 then 1000/600/80: the delta, cached input moved across
          expect(finals[0].usage).toEqual({ input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 40, cost_usd: null, cost_source: "unpriced" });
          expect(finals[1].usage).toEqual({ input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 40, cost_usd: null, cost_source: "unpriced" });
        }
      } finally {
        delete process.env[dropVar];
      }
    }, 20000);
  }

  // codex decides failure by "did the turn complete", NOT by "was there an error" — its error
  // notifications are startup noise it keeps working through (codex.ts). So the repair guard
  // is turnCompleted && !rpcFault: a notice must not cost a run the cheap repair, and an error
  // RESPONSE to one of our own requests must stop us asking that thread for anything more.
  test("codex: a startup notice still gets the repair turn", async () => {
    Object.assign(process.env, { FAKE_CODEX_DROP_OUTPUTS: "1", FAKE_CODEX_NOTICE: "1" });
    try {
      const { result, sent } = await runCapturing("codex");
      expect(result).toEqual({ state: "finished", outcome: "success" });
      expect(sent).toHaveLength(4); // two attempts, each first turn + repair
    } finally {
      for (const k of ["FAKE_CODEX_DROP_OUTPUTS", "FAKE_CODEX_NOTICE"]) delete process.env[k];
    }
  }, 20000);

  test("codex: an app-server fault gets no repair turn — the attempt fails on the contract", async () => {
    Object.assign(process.env, { FAKE_CODEX_DROP_OUTPUTS: "1", FAKE_CODEX_RPC_FAULT: "1" });
    try {
      const { result, sent } = await runCapturing("codex");
      expect(result).toMatchObject({ state: "parked" });
      expect(sent).toHaveLength(1); // the first turn only: no repair was asked for
    } finally {
      for (const k of ["FAKE_CODEX_DROP_OUTPUTS", "FAKE_CODEX_RPC_FAULT"]) delete process.env[k];
    }
  }, 20000);
});
