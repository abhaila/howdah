import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineGraph } from "../core/graph";
import { renderTemplate, renderedHash, templateReads, operatorInstructionSuffix, buildOutputInstruction, suffixBuilders } from "../core/template";
import { resolveReply } from "../engine/control";
import { Engine, type AttemptResult } from "../engine/run";
import { EventLog, readLog } from "../log/write";
import { PromptStore, PromptStoreError } from "./store";
import {
  appendFeedback, outcomeRows, promptDetail, promptHistory, promptSummaries,
  readFeedback, reconstructRender, repoRoot, scanRuns,
} from "./library";
import { listProposals, stampEval, viewProposal, evalCaseFor } from "./proposals";

// ---- fixtures -------------------------------------------------------------------

interface Ctx {
  goal: string;
  summary: string;
  verdict: "pass" | "reject";
}

/** two prompts, one consumed by two nodes — the multi-consumer case OV-3 cares about */
function promptFixtures(): string {
  const dir = mkdtempSync(join(tmpdir(), "howdah-lib-prompts-"));
  writeFileSync(join(dir, "work.md"), `---\nid: work\nversion: 3\ntags: [code, main]\naccepted: 2026-09-14T10:00:00Z\nprovenance: reviser proposal v3\n---\nDo {{ context.goal }} given {{ context.summary }}.\n`);
  writeFileSync(join(dir, "check.md"), `---\nid: check\nversion: 1\n---\nReview {{ context.summary }} against {{ context.goal }}. Leave {{ context.internal.note }} alone.\n`);
  return dir;
}

function miniGraph() {
  return defineGraph<Ctx>({
    name: "mini",
    entry: "work",
    inputs: ["goal", "summary"],
    nodes: {
      work: { kind: "agent", prompt: "work" as never, reads: ["goal", "summary"], writes: { summary: { scope: "sticky" } }, maxVisits: 3 },
      rework: { kind: "agent", prompt: "work" as never, reads: ["goal", "summary"], writes: { summary: { scope: "sticky" } } },
      check: { kind: "agent", prompt: "check" as never, reads: ["goal", "summary"], writes: { verdict: { scope: "cleared" } } },
      done: { kind: "terminal", outcome: "success" },
    },
    edges: [
      { from: "work", to: "check" },
      { from: "rework", to: "check" },
      { from: "check", to: "rework", condition: { reads: ["verdict"], test: (v) => v.verdict === "reject", label: "verdict == 'reject'" }, weight: 2 },
      { from: "check", to: "done", condition: { reads: ["verdict"], test: (v) => v.verdict === "pass", label: "verdict == 'pass'" }, weight: 1 },
    ],
  });
}

const ok = (writes: Record<string, unknown> = {}): AttemptResult => ({ status: "succeeded", writes });

/** run the real engine so the log under test is one the engine actually wrote */
async function realRun(runsDir: string, id: string, promptsDir: string, verdict: Ctx["verdict"] = "pass") {
  const engine = new Engine(miniGraph(), {
    dir: join(runsDir, id),
    promptsDir,
    executors: {
      agent: async ({ nodeId }) => (nodeId === "check" ? ok({ verdict }) : ok({ summary: "did the work" })),
    },
    maxSteps: 12,
  });
  const state = await engine.start({ goal: "ship the thing", summary: "nothing yet" });
  return { engine, state };
}

function paths(root: string, runsDir: string) {
  return { root, promptsDir: join(root, "prompts"), feedbackDir: join(root, "feedback"), proposalsDir: join(root, "reviser", "proposals"), runsDir };
}

/** a repo-shaped temp dir: prompts/, feedback/, reviser/proposals/ */
function fakeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "howdah-lib-root-"));
  mkdirSync(join(root, "prompts"), { recursive: true });
  mkdirSync(join(root, "feedback"), { recursive: true });
  mkdirSync(join(root, "reviser", "proposals"), { recursive: true });
  const src = promptFixtures();
  for (const f of ["work.md", "check.md"]) writeFileSync(join(root, "prompts", f), readFileSync(join(src, f), "utf8"));
  return root;
}

// ---- the shared template contract -----------------------------------------------

describe("core/template — one implementation, three callers", () => {
  test("templateReads skips the engine namespace and filters, and dedupes", () => {
    const body = "{{ context.a }} {{ inputs.b }} {{ context.a }} {{ context.c | upper }} {{ context.internal.x }}";
    expect(templateReads(body)).toEqual(["a", "b", "c"]);
  });

  test("renderTemplate interpolates strings raw and everything else as JSON", () => {
    const { text, read } = renderTemplate("{{ context.s }}|{{ context.n }}|{{ context.o }}", (k) =>
      ({ s: "str", n: 4, o: { k: true } })[k],
    );
    expect(text).toBe('str|4|{"k":true}');
    expect(read).toEqual({ s: "str", n: 4, o: { k: true } });
  });

  test("renderTemplate leaves context.internal.* verbatim and never records it as a read", () => {
    const { text, read } = renderTemplate("keep {{ context.internal.note }}", () => "SHOULD NOT APPEAR");
    expect(text).toBe("keep {{ context.internal.note }}");
    expect(read).toEqual({});
  });

  test("a fresh matcher per call — repeated renders of the same body are identical", () => {
    const body = "{{ context.a }} and {{ context.a }}";
    const once = renderTemplate(body, () => "x").text;
    expect(renderTemplate(body, () => "x").text).toBe(once);
    expect(once).toBe("x and x");
  });

  test("renderedHash is 16 hex chars and content-addressed", () => {
    expect(renderedHash("abc")).toMatch(/^[0-9a-f]{16}$/);
    expect(renderedHash("abc")).toBe(renderedHash("abc"));
    expect(renderedHash("abc")).not.toBe(renderedHash("abd"));
  });
});

// ---- feedback -------------------------------------------------------------------

describe("feedback capture (A2.1/A2.2)", () => {
  const good = { run: "r1", node: "work", visit: 2, note: "  PRs need a Why section  ", verdict: "reject" as const, rendered_hash: "abc123" };

  test("appends a reviser-format line, trims the note, stamps `at`", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-fb-"));
    const entry = appendFeedback(dir, "work", good);
    expect(entry.note).toBe("PRs need a Why section");
    expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(readFeedback(dir, "work")).toEqual([entry]);
    // a second entry appends rather than replacing — history, not state
    appendFeedback(dir, "work", { ...good, note: "second", verdict: "accept" });
    expect(readFeedback(dir, "work").map((f) => f.verdict)).toEqual(["reject", "accept"]);
  });

  test("creates the feedback dir on first write", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "howdah-fb-")), "nested", "feedback");
    appendFeedback(dir, "work", good);
    expect(existsSync(join(dir, "work.jsonl"))).toBe(true);
  });

  test("refuses junk the reviser would choke on", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-fb-"));
    expect(() => appendFeedback(dir, "work", { ...good, note: "   " })).toThrow(/note is empty/);
    expect(() => appendFeedback(dir, "work", { ...good, verdict: "meh" as never })).toThrow(/bad verdict/);
    expect(() => appendFeedback(dir, "work", { ...good, run: "" })).toThrow(/run and node/);
    expect(() => appendFeedback(dir, "work", { ...good, visit: 0 })).toThrow(/bad visit/);
    expect(() => appendFeedback(dir, "work", { ...good, visit: 1.5 })).toThrow(/bad visit/);
    expect(() => appendFeedback(dir, "work", { ...good, rendered_hash: "" })).toThrow(/rendered_hash/);
    expect(readFeedback(dir, "work")).toEqual([]); // nothing partial was written
  });

  test("a hand-mangled line is skipped, not fatal", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-fb-"));
    appendFeedback(dir, "work", good);
    writeFileSync(join(dir, "work.jsonl"), readFileSync(join(dir, "work.jsonl"), "utf8") + "{ not json\n");
    expect(readFeedback(dir, "work")).toHaveLength(1);
  });

  test("missing file reads as no feedback", () => {
    expect(readFeedback(mkdtempSync(join(tmpdir(), "howdah-fb-")), "nope")).toEqual([]);
  });
});

// ---- the attribution join --------------------------------------------------------

describe("outcome rows (A5.3 join by rendered_hash)", () => {
  test("joins verdicts and terminal outcomes onto each render, oldest first", async () => {
    const root = fakeRepo();
    const runsDir = mkdtempSync(join(tmpdir(), "howdah-runs-"));
    await realRun(runsDir, "run-a", join(root, "prompts"), "pass");
    const rows = outcomeRows(scanRuns(runsDir), "work");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ run: "run-a", node: "work", visit: 1, prompt_version: 3, terminal_outcome: "success" });

    const checkRows = outcomeRows(scanRuns(runsDir), "check");
    expect(checkRows[0]!.verdict_downstream).toBe("verdict == 'pass'");
  });

  test("a rejected review produces a second render of the same prompt via its other node", async () => {
    const root = fakeRepo();
    const runsDir = mkdtempSync(join(tmpdir(), "howdah-runs-"));
    // check rejects once then passes: work → check → rework → check → done
    let calls = 0;
    const engine = new Engine(miniGraph(), {
      dir: join(runsDir, "run-b"),
      promptsDir: join(root, "prompts"),
      executors: { agent: async ({ nodeId }) => (nodeId === "check" ? ok({ verdict: ++calls === 1 ? "reject" : "pass" }) : ok({ summary: `s${calls}` })) },
      maxSteps: 12,
    });
    await engine.start({ goal: "g", summary: "" });
    const rows = outcomeRows(scanRuns(runsDir), "work");
    expect(rows.map((r) => r.node)).toEqual(["work", "rework"]); // both consumers, one prompt
    expect(rows.every((r) => r.terminal_outcome === "success")).toBe(true);
  });

  test("a run still in flight leaves its renders pending, not failed", async () => {
    const root = fakeRepo();
    const runsDir = mkdtempSync(join(tmpdir(), "howdah-runs-"));
    const log = new EventLog(join(runsDir, "live", "run.jsonl"));
    log.append({ type: "run-started", graph: "mini", inputs: {}, pinned_prompts: { work: 3 } as never });
    log.append({ type: "prompt-rendered", node: "work", visit: 1, prompt: "work" as never, prompt_version: 3, rendered_hash: "h1", context_read: {} });
    const summaries = promptSummaries(paths(root, runsDir), [miniGraph()], new PromptStore(join(root, "prompts")));
    expect(summaries.find((s) => s.id === "work")!.outcomes).toEqual({ renders: 1, success: 0, failed: 0, aborted: 0, pending: 1, indirect: 0 });
  });

  test("a corrupt run log does not take the library down", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "howdah-runs-"));
    mkdirSync(join(runsDir, "bad"), { recursive: true });
    writeFileSync(join(runsDir, "bad", "run.jsonl"), "{ torn\n{ also torn\n");
    expect(scanRuns(runsDir)).toEqual([]);
  });
});

// ---- summaries + detail -----------------------------------------------------------

describe("prompt library", () => {
  test("summary carries version, tags, every consumer, feedback and proposal counts", async () => {
    const root = fakeRepo();
    const runsDir = mkdtempSync(join(tmpdir(), "howdah-runs-"));
    await realRun(runsDir, "run-a", join(root, "prompts"));
    appendFeedback(join(root, "feedback"), "work", { run: "run-a", node: "work", visit: 1, note: "too vague", verdict: "reject", rendered_hash: "x" });
    writeFileSync(join(root, "reviser", "proposals", "work.v4.proposal.md"), `---\nid: work\nbase_version: 3\nproposed_version: 4\nstatus: pending\ncreated: 2026-09-15T00:00:00Z\n---\nrevised body\n`);

    const store = new PromptStore(join(root, "prompts"));
    const summaries = promptSummaries(paths(root, runsDir), [miniGraph()], store);
    const work = summaries.find((s) => s.id === "work")!;
    expect(work).toMatchObject({ version: 3, tags: ["code", "main"], feedback: { count: 1, rejects: 1 }, proposals: { pending: 1, total: 1 } });
    expect(work.consumers).toEqual([{ graph: "mini", node: "work" }, { graph: "mini", node: "rework" }]);
    // pending proposals sort to the top: the screen opens on what is waiting for you
    expect(summaries[0]!.id).toBe("work");
  });

  test("detail adds body, provenance, feedback entries and outcome rows", async () => {
    const root = fakeRepo();
    const runsDir = mkdtempSync(join(tmpdir(), "howdah-runs-"));
    await realRun(runsDir, "run-a", join(root, "prompts"));
    appendFeedback(join(root, "feedback"), "work", { run: "run-a", node: "work", visit: 1, note: "needs a Why", verdict: "reject", rendered_hash: "x" });
    const d = promptDetail(paths(root, runsDir), [miniGraph()], "work", new PromptStore(join(root, "prompts")));
    expect(d.body).toContain("{{ context.goal }}");
    expect(d.accepted_at).toBe("2026-09-14T10:00:00Z");
    expect(d.provenance).toBe("reviser proposal v3");
    expect(d.feedback_entries.map((f) => f.note)).toEqual(["needs a Why"]);
    expect(d.outcome_rows).toHaveLength(1);
    expect(d.history).toEqual([]); // the temp root is not a git repo
  });

  test("an unknown prompt id throws rather than inventing an empty prompt", () => {
    const root = fakeRepo();
    expect(() => promptDetail(paths(root, mkdtempSync(join(tmpdir(), "r-"))), [miniGraph()], "nope", new PromptStore(join(root, "prompts")))).toThrow(PromptStoreError);
  });

  test("git history reads real commits for a committed prompt in this repo", () => {
    const history = promptHistory(repoRoot(), "delivery.publish");
    expect(history.length).toBeGreaterThan(0);
    expect(history[0]!.sha).toMatch(/^[0-9a-f]{8}$/);
    expect(history[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(history[0]!.subject.length).toBeGreaterThan(0);
    expect(promptHistory(repoRoot(), "no-such-prompt-anywhere")).toEqual([]);
  });
});

// ---- rendered-instance reconstruction ---------------------------------------------

describe("reconstructRender — proven against what the engine actually wrote", () => {
  test("reconstructs the exact text the engine hashed (verified)", async () => {
    const root = fakeRepo();
    const runsDir = mkdtempSync(join(tmpdir(), "howdah-runs-"));
    const { engine } = await realRun(runsDir, "run-a", join(root, "prompts"));
    const render: any = engine.log.read().find((e) => e.type === "prompt-rendered" && e.node === "work");

    const r = reconstructRender(join(runsDir, "run-a"), render.rendered_hash)!;
    expect(r.verified).toBe(true);
    // system-map 0.1: the outputs contract is part of what the agent read, so part of the proof
    expect(r.text).toBe("Do ship the thing given nothing yet.\n" + buildOutputInstruction(["summary"]));
    expect(render).toMatchObject({ skills: [], output_keys: ["summary"], suffix_version: 4 });
    expect(r).toMatchObject({ prompt: "work", prompt_version: 3, node: "work", visit: 1 });
    expect(r.context_read).toEqual({ goal: "ship the thing", summary: "nothing yet" });
  });

  test("the engine namespace survives reconstruction verbatim", async () => {
    const root = fakeRepo();
    const runsDir = mkdtempSync(join(tmpdir(), "howdah-runs-"));
    const { engine } = await realRun(runsDir, "run-a", join(root, "prompts"));
    const render: any = engine.log.read().find((e) => e.type === "prompt-rendered" && e.node === "check");
    const r = reconstructRender(join(runsDir, "run-a"), render.rendered_hash)!;
    expect(r.verified).toBe(true);
    expect(r.text).toContain("{{ context.internal.note }}");
  });

  test("a jumped-into turn verifies through the operator-instruction suffix", async () => {
    const root = fakeRepo();
    const runsDir = mkdtempSync(join(tmpdir(), "howdah-runs-"));
    const runDir = join(runsDir, "run-jump");
    // a run that parked, then was jumped back into `work` with an instruction
    let seen = 0;
    const first = new Engine(miniGraph(), {
      dir: runDir,
      promptsDir: join(root, "prompts"),
      executors: { agent: async ({ nodeId }) => (nodeId === "check" ? ({ status: "failed", writes: {} } as AttemptResult) : ok({ summary: "s" })) },
    });
    await first.start({ goal: "g", summary: "" });
    new EventLog(join(runDir, "run.jsonl")).append({ type: "operator-jump", to: "work", message: "focus on the error path" });
    const resumed = new Engine(miniGraph(), {
      dir: runDir,
      promptsDir: join(root, "prompts"),
      executors: { agent: async ({ nodeId }) => (nodeId === "check" ? ok({ verdict: "pass" }) : ok({ summary: `s${++seen}` })) },
    });
    await resumed.resume();

    const renders = resumed.log.read().filter((e: any) => e.type === "prompt-rendered" && e.node === "work") as any[];
    const jumped = renders.at(-1)!;
    const r = reconstructRender(runDir, jumped.rendered_hash)!;
    expect(r.verified).toBe(true);
    // fixed order (system-map 0.1): body → jump suffix → … → outputs contract
    expect(r.text).toBe("Do g given s.\n" + operatorInstructionSuffix("focus on the error path") + buildOutputInstruction(["summary"]));
  });

  test("an edited pinned prompt reports unverified instead of lying", async () => {
    const root = fakeRepo();
    const runsDir = mkdtempSync(join(tmpdir(), "howdah-runs-"));
    const { engine } = await realRun(runsDir, "run-a", join(root, "prompts"));
    const render: any = engine.log.read().find((e) => e.type === "prompt-rendered" && e.node === "work");
    const pinned = join(runsDir, "run-a", "prompts", "work.md");
    writeFileSync(pinned, readFileSync(pinned, "utf8").replace("Do ", "Please do "));

    const r = reconstructRender(join(runsDir, "run-a"), render.rendered_hash)!;
    expect(r.verified).toBe(false);
    expect(r.text).toContain("Please do"); // best effort, clearly labelled as unproven
  });

  test("unknown hash, missing log and missing pinned prompt all return null", async () => {
    const root = fakeRepo();
    const runsDir = mkdtempSync(join(tmpdir(), "howdah-runs-"));
    const { engine } = await realRun(runsDir, "run-a", join(root, "prompts"));
    const render: any = engine.log.read().find((e) => e.type === "prompt-rendered");
    expect(reconstructRender(join(runsDir, "run-a"), "deadbeef")).toBeNull();
    expect(reconstructRender(join(runsDir, "nope"), render.rendered_hash)).toBeNull();

    const bare = join(runsDir, "bare");
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, "run.jsonl"), JSON.stringify({ ...render, seq: 1, ts: render.ts }) + "\n");
    expect(reconstructRender(bare, render.rendered_hash)).toBeNull(); // no pinned snapshot
  });

  // ---- system-map 0.1: suffixes inside the proof, rebuilt by logged version ----------

  const V1_SKILL_HINT = "\n\nRelevant installed skills for this task: /review — invoke them where they apply.";

  test("a render with skills verifies, the skill hint sitting before the outputs contract", async () => {
    const root = fakeRepo();
    const runsDir = mkdtempSync(join(tmpdir(), "howdah-runs-"));
    const g = defineGraph<Ctx>({
      name: "mini-skilled",
      entry: "work",
      inputs: ["goal", "summary"],
      nodes: {
        work: { kind: "agent", prompt: "work" as never, reads: ["goal", "summary"], writes: { summary: { scope: "sticky" } }, skills: ["review"] },
        done: { kind: "terminal", outcome: "success" },
      },
      edges: [{ from: "work", to: "done" }],
    });
    let sent = "";
    const engine = new Engine(g, {
      dir: join(runsDir, "run-s"),
      promptsDir: join(root, "prompts"),
      executors: { agent: async ({ renderedPrompt }) => ((sent = renderedPrompt!), ok({ summary: "x" })) },
    });
    await engine.start({ goal: "g", summary: "s" });
    const render: any = engine.log.read().find((e) => e.type === "prompt-rendered");
    expect(render.skills).toEqual(["review"]);

    const r = reconstructRender(join(runsDir, "run-s"), render.rendered_hash)!;
    expect(r.verified).toBe(true);
    expect(r.text).toBe("Do g given s.\n" + V1_SKILL_HINT + buildOutputInstruction(["summary"]));
    expect(r.text).toBe(sent); // exactly what the executor was handed
  });

  /** a run dir holding the pinned `work` prompt and one hand-written prompt-rendered event */
  function handWrittenRender(fields: Record<string, unknown>, text: string, before: object[] = []) {
    const root = fakeRepo();
    const runDir = join(mkdtempSync(join(tmpdir(), "howdah-runs-")), "run-h");
    mkdirSync(join(runDir, "prompts"), { recursive: true });
    writeFileSync(join(runDir, "prompts", "work.md"), readFileSync(join(root, "prompts", "work.md"), "utf8"));
    const log = new EventLog(join(runDir, "run.jsonl"));
    log.append({ type: "run-started", graph: "mini", inputs: {}, pinned_prompts: { work: 3 } } as never);
    for (const e of before) log.append(e as never);
    const hash = renderedHash(text);
    log.append({ type: "prompt-rendered", node: "work", visit: 1, prompt: "work", prompt_version: 3, rendered_hash: hash, context_read: { goal: "g", summary: "s" }, ...fields } as never);
    return { runDir, hash };
  }

  test("an event rendered under suffix_version 1 verifies against the literal v1 wording", () => {
    // literal v1 strings — if a builder is reworded without a version bump, this fails
    const v1Contract =
      "\n\n## Output contract (required)\n" +
      "When your work is complete, the LAST line of your reply must be a single JSON object of the form\n" +
      '{"outputs": {"summary": <value>}}\n' +
      "containing exactly these keys: summary. No markdown fence, no trailing text.";
    const text = "Do g given s.\n" + V1_SKILL_HINT + v1Contract;
    const { runDir, hash } = handWrittenRender({ skills: ["review"], output_keys: ["summary"], suffix_version: 1 }, text);
    const r = reconstructRender(runDir, hash)!;
    expect(r.verified).toBe(true);
    expect(r.text).toBe(text);
  });

  test("an event with suffix_version 1 and no skills or output keys verifies with the summary-only tail", () => {
    const text = "Do g given s.\n" + "\n\n## Output\nWhen your work is complete, end your reply with a one-line summary of what you did.";
    const { runDir, hash } = handWrittenRender({ skills: [], output_keys: [], suffix_version: 1 }, text);
    expect(reconstructRender(runDir, hash)!.verified).toBe(true);
  });

  test("LEGACY: an event with none of the new fields still verifies against the old, shorter text", () => {
    const text = "Do g given s.\n"; // pre-0.1: the hash covered the template render only
    const { runDir, hash } = handWrittenRender({}, text);
    const r = reconstructRender(runDir, hash)!;
    expect(r.verified).toBe(true);
    expect(r.text).toBe(text);
  });

  test("LEGACY: a pre-0.1 jumped-into render still verifies through the jump suffix alone", () => {
    const text = "Do g given s.\n" + operatorInstructionSuffix("try again");
    const { runDir, hash } = handWrittenRender({}, text, [{ type: "operator-jump", to: "work", message: "try again" }]);
    const r = reconstructRender(runDir, hash)!;
    expect(r.verified).toBe(true);
    expect(r.text).toBe(text);
  });

  // ---- system-map 0.2: operator reply suffix -------------------------------------------

  const replyV2 = (m: string) => suffixBuilders(2)!.replyInstruction!(m);
  const parkAndReply = (reply: string, source?: string) => [
    { type: "attention-raised", node: "work", visit: 1, reason: "attempt failed", code: "attempt-failed" },
    { type: "attention-resolved", node: "work", visit: 1, reply, ...(source ? { source } : {}) },
  ];

  test("a retried turn carrying an operator reply verifies (engine-written, suffix_version 3)", async () => {
    const root = fakeRepo();
    const runsDir = mkdtempSync(join(tmpdir(), "howdah-runs-"));
    const runDir = join(runsDir, "run-reply");
    let attempt = 0;
    let sent = "";
    const engine = () =>
      new Engine(miniGraph(), {
        dir: runDir,
        promptsDir: join(root, "prompts"),
        executors: {
          agent: async ({ nodeId, renderedPrompt }) => {
            if (nodeId === "check") return ok({ verdict: "pass" });
            if (++attempt === 1) return { status: "failed", writes: {} } as AttemptResult;
            sent = renderedPrompt!;
            return ok({ summary: "s" });
          },
        },
      });
    await engine().start({ goal: "g", summary: "s" });
    expect(resolveReply(runDir, "mind the null case", { graphs: { mini: miniGraph() } })).toMatchObject({ ok: true, rendered: true });
    await engine().resume();

    const render: any = readLog(join(runDir, "run.jsonl")).find((e) => e.type === "prompt-rendered" && e.node === "work" && e.visit === 2);
    expect(render.suffix_version).toBe(4);
    const r = reconstructRender(runDir, render.rendered_hash)!;
    expect(r.verified).toBe(true);
    expect(r.text).toBe("Do g given s.\n" + replyV2("mind the null case") + buildOutputInstruction(["summary"]));
    expect(r.text).toBe(sent);
  });

  test("a reply render verifies when jumps and older replies also preceded it", () => {
    const text = "Do g given s.\n" + replyV2("newer hint") + buildOutputInstruction(["summary"]);
    const { runDir, hash } = handWrittenRender({ skills: [], output_keys: ["summary"], suffix_version: 2 }, text, [
      { type: "operator-jump", to: "work", message: "go back" },
      ...parkAndReply("older hint", "operator"),
      ...parkAndReply("newer hint", "operator"),
    ]);
    expect(reconstructRender(runDir, hash)!).toMatchObject({ verified: true, text });
  });

  test("a reply to a non-renderable park is never a candidate — the same rule replay applies", () => {
    const text = "Do g given s.\n" + replyV2("be lenient") + buildOutputInstruction(["summary"]);
    const { runDir, hash } = handWrittenRender({ skills: [], output_keys: ["summary"], suffix_version: 2 }, text, [
      { type: "attention-raised", node: "work", visit: 1, reason: "maxVisits exceeded", code: "max-visits" },
      { type: "attention-resolved", node: "work", visit: 1, reply: "be lenient", source: "operator" },
    ]);
    expect(reconstructRender(runDir, hash)!.verified).toBe(false);
  });

  test("resume's own resolution is never a reply candidate (source, or legacy reply \"resume\")", () => {
    for (const source of ["resume", undefined]) {
      const text = "Do g given s.\n" + replyV2("resume") + buildOutputInstruction(["summary"]);
      const { runDir, hash } = handWrittenRender({ skills: [], output_keys: ["summary"], suffix_version: 2 }, text, parkAndReply("resume", source));
      expect(reconstructRender(runDir, hash)!.verified).toBe(false);
    }
  });

  test("a v2 render without a reply still verifies when replies preceded it", () => {
    const text = "Do g given s.\n" + buildOutputInstruction(["summary"]);
    const { runDir, hash } = handWrittenRender({ skills: [], output_keys: ["summary"], suffix_version: 2 }, text, parkAndReply("hint", "operator"));
    expect(reconstructRender(runDir, hash)!).toMatchObject({ verified: true, text });
  });

  test("a v1 render is rebuilt without reply candidates even when a reply preceded it (regression)", () => {
    const text = "Do g given s.\n" + buildOutputInstruction(["summary"]);
    const { runDir, hash } = handWrittenRender({ skills: [], output_keys: ["summary"], suffix_version: 1 }, text, parkAndReply("hint", "operator"));
    expect(reconstructRender(runDir, hash)!).toMatchObject({ verified: true, text });
  });

  test("an unknown suffix_version reports unverified rather than guessing", () => {
    const text = "Do g given s.\nSOMETHING A FUTURE VERSION APPENDS";
    const { runDir, hash } = handWrittenRender({ skills: [], output_keys: ["summary"], suffix_version: 999 }, text);
    const r = reconstructRender(runDir, hash)!;
    expect(r.verified).toBe(false);
    expect(r.text).toBe("Do g given s.\n");
  });
});

// ---- proposal review surface ------------------------------------------------------

describe("proposal review (D7 staleness, evidence, eval)", () => {
  function seedProposal(root: string, id: string, base: number, status = "pending", created = "2026-09-15T00:00:00Z") {
    const dir = join(root, "reviser", "proposals");
    const file = `${id}.v${base + 1}.proposal.md`;
    writeFileSync(join(dir, file), `---\nid: ${id}\nbase_version: ${base}\nproposed_version: ${base + 1}\nstatus: ${status}\ncreated: ${created}\n---\nrevised ${id} body\n`);
    return { dir, file };
  }

  test("view carries diff, reflection, evidence and current version", () => {
    const root = fakeRepo();
    const { dir, file } = seedProposal(root, "work", 3);
    writeFileSync(join(dir, "work.v4.diff"), "--- current\n+++ proposed\n@@ -1 +1 @@\n-old\n+new\n");
    writeFileSync(join(dir, "work.v4.reflection.md"), "the feedback asks for a Why section\n");
    appendFeedback(join(root, "feedback"), "work", { run: "r", node: "work", visit: 1, note: "needs a Why", verdict: "reject", rendered_hash: "h" });

    const v = viewProposal(dir, file, new PromptStore(join(root, "prompts")), root);
    expect(v).toMatchObject({ id: "work", base_version: 3, proposed_version: 4, status: "pending", current_version: 3, stale: false });
    expect(v.diff).toContain("+new");
    expect(v.reflection).toContain("Why section");
    expect(v.feedback.map((f) => f.note)).toEqual(["needs a Why"]);
    expect(v.eval).toEqual({ case: null, score: null, verdict: null });
  });

  test("a base that no longer matches the prompt is stale (D7)", () => {
    const root = fakeRepo();
    const { dir, file } = seedProposal(root, "work", 2); // prompt is at v3
    const v = viewProposal(dir, file, new PromptStore(join(root, "prompts")), root);
    expect(v).toMatchObject({ stale: true, current_version: 3, base_version: 2 });
  });

  test("an accepted proposal is never stale — it is what moved the prompt", () => {
    const root = fakeRepo();
    const { dir, file } = seedProposal(root, "work", 2, "accepted"); // prompt is at v3
    const v = viewProposal(dir, file, new PromptStore(join(root, "prompts")), root);
    expect(v).toMatchObject({ status: "accepted", current_version: 3, stale: false });
  });

  test("a proposal for a deleted prompt is not stale, it is orphaned", () => {
    const root = fakeRepo();
    const { dir, file } = seedProposal(root, "ghost", 1);
    const v = viewProposal(dir, file, new PromptStore(join(root, "prompts")), root);
    expect(v.current_version).toBeNull();
    expect(v.stale).toBe(false);
  });

  test("listing puts pending first, then newest, and survives a malformed file", () => {
    const root = fakeRepo();
    const store = new PromptStore(join(root, "prompts"));
    seedProposal(root, "work", 3, "pending", "2026-09-10T00:00:00Z");
    seedProposal(root, "check", 1, "accepted", "2026-09-14T00:00:00Z");
    writeFileSync(join(root, "reviser", "proposals", "broken.v2.proposal.md"), "no front matter here");
    const list = listProposals(join(root, "reviser", "proposals"), store, root);
    expect(list.map((p) => `${p.id}:${p.status}`)).toEqual(["work:pending", "check:accepted"]);
  });

  test("stampEval writes the score onto the proposal, replacing any earlier stamp", () => {
    const root = fakeRepo();
    const { dir, file } = seedProposal(root, "work", 3);
    const path = join(dir, file);
    stampEval(path, "15/15", "matches the hand edit");
    stampEval(path, "14/15", "close");
    const v = viewProposal(dir, file, new PromptStore(join(root, "prompts")), root);
    expect(v.eval.score).toBe("14/15");
    expect(v.eval.verdict).toBe("close");
    expect(v.body).toBe("revised work body\n"); // the revision itself is untouched
    expect(v.status).toBe("pending");
  });

  test("evalCaseFor finds the authored case for delivery.publish and nothing for others", () => {
    expect(evalCaseFor("delivery.publish", repoRoot())).toBe("reviser/eval/delivery-publish.eval.ts");
    expect(evalCaseFor("doc.outline", repoRoot())).toBeNull();
  });
});
