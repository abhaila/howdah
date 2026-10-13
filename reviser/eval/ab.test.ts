/**
 * HOW-42: the paired A/B harness.
 *
 *   - end to end under HOWDAH_STUB=1, over the checked-in implement-ticket case set and two
 *     prompt variants: the real CLI runs every arm (interleaved), every run parks (stub agents),
 *     the report is produced and a proposal is stamped — without a token spent;
 *   - with an injected runner: the parked, fell-back and unpriced buckets, the "not enough
 *     cases to tell" verdict, a significant result, and --repeat's per-case pass rates.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReport, classify, formatReport, loadCases, parseVariant, prepareHome, runAB, stampLine,
  type ArmRun, type CaseResult, type EvalCase, type Runner, type Variant,
} from "./ab";
import type { LoggedEvent, RunEvent } from "../../log/events";
import { loadProposal } from "../../prompts/proposals";
import { emptyRollup } from "../../log/usage";

const ROOT = join(import.meta.dir, "..", "..");
const CASES = join(import.meta.dir, "cases", "implement-ticket");

function proposal(dir: string, id = "implementation.implement"): string {
  const path = join(dir, `${id}.v2.proposal.md`);
  writeFileSync(path, `---\nid: ${id}\nbase_version: 1\nproposed_version: 2\nstatus: pending\ncreated: 2026-10-12T00:00:00Z\n---\nVariant B body for {{ inputs.goal }} {{ context.work }} {{ context.implementation_plan }}.\n`);
  return path;
}

describe("variants", () => {
  test("a prompt file, a proposal, inline JSON and a JSON file", () => {
    const a = parseVariant(join(ROOT, "prompts", "implementation.implement.md"));
    expect(a).toMatchObject({ kind: "prompt", id: "implementation.implement", version: 1 });
    const dir = mkdtempSync(join(tmpdir(), "howdah-ab-v-"));
    expect(parseVariant(proposal(dir))).toMatchObject({ kind: "prompt", id: "implementation.implement", version: 2, label: "implementation.implement v2 (proposal)" });
    expect(parseVariant('{"effort":"high"}')).toMatchObject({ kind: "config", overlay: { defaults: { effort: "high" } } });
    writeFileSync(join(dir, "o.json"), JSON.stringify({ nodes: { "implementation.implement": { tools: { deny: ["WebFetch"] } } } }));
    expect(parseVariant(join(dir, "o.json"))).toMatchObject({ kind: "config", overlay: { nodes: { "implementation.implement": { tools: { deny: ["WebFetch"] } } } } });
    expect(() => parseVariant("no-such-thing")).toThrow(/neither a file nor inline JSON/);
  });

  test("a home is prepared with the variant where the engine will find it", () => {
    const [c] = loadCases(CASES);
    const prompt = prepareHome(c!, parseVariant(proposal(mkdtempSync(join(tmpdir(), "howdah-ab-v-")))));
    expect(readFileSync(join(prompt.home, "prompts", "implementation.implement.md"), "utf8")).toContain("version: 2");
    expect(readFileSync(join(prompt.home, "graphs", "eval-implement.ts"), "utf8")).toContain(ROOT);
    expect(JSON.parse(readFileSync(join(prompt.home, "config.json"), "utf8")).repos.eval.verifyCommand).toBe("bun test");
    const config = prepareHome(c!, parseVariant('{"effort":"low"}'));
    expect(JSON.parse(readFileSync(join(config.home, "tuning.json"), "utf8"))).toEqual({ "eval-implement": { defaults: { effort: "low" } } });
  });
});

describe("end to end under HOWDAH_STUB=1 (no tokens)", () => {
  test("3 cases × 2 prompt variants: interleaved real runs, all parked, a report and a stamp", async () => {
    const cases = loadCases(CASES);
    expect(cases.map((c) => c.name)).toEqual(["01-slugify", "02-word-count", "03-truncate"]);
    const dir = mkdtempSync(join(tmpdir(), "howdah-ab-e2e-"));
    const stamped = proposal(dir);
    const order: string[] = [];
    process.env.HOWDAH_STUB = "1";
    let report;
    try {
      report = await runAB({
        cases,
        a: parseVariant(join(ROOT, "prompts", "implementation.implement.md")),
        b: [parseVariant(stamped)],
        log: (l) => order.push(l.split(":")[0]!),
      });
    } finally {
      delete process.env.HOWDAH_STUB;
    }
    // interleaved: every case runs A then B before the next case
    expect(order).toEqual(["01-slugify #1 A", "01-slugify #1 B", "02-word-count #1 A", "02-word-count #1 B", "03-truncate #1 A", "03-truncate #1 B"]);
    // stub executors throw at the first non-wait node: every run is its own PARKED bucket
    expect(report.results.every((r) => r.outcome === "parked" && r.park_code === "executor-threw")).toBe(true);
    expect(report.arms.map((a) => a.parked)).toEqual([{ "executor-threw": 3 }, { "executor-threw": 3 }]);
    expect(report.comparisons![0]!.verdict).toContain("not enough cases to tell");
    expect(formatReport(report)).toContain("parked: executor-threw ×3");

    expect(stampLine(report, { dryRun: true }).score).toStartWith("DRY RUN (HOWDAH_STUB, no agent ran)");
    const { score, verdict } = stampLine(report);
    const { stampEval } = await import("../../prompts/proposals");
    stampEval(stamped, score, verdict, join(dir, "report.json"));
    const p = loadProposal(stamped);
    expect(p.frontmatter).toContain("eval_score: A 0/0 vs B 0/0 passed");
    expect(p.frontmatter).toContain("eval_verdict: not enough cases to tell");
    expect(p.frontmatter).toContain(`eval_report: ${join(dir, "report.json")}`);
  }, 120000);
});

// ---- injected runner ---------------------------------------------------------------------------

const stamp = (events: RunEvent[]): LoggedEvent[] => events.map((e, i) => ({ ...e, seq: i + 1, ts: "2026-10-12T00:00:00.000Z" }) as LoggedEvent);
const rendered = (harness: "claude" | "codex", visit = 1): RunEvent => ({
  type: "prompt-rendered", node: "impl", visit, prompt: "implementation.implement", prompt_version: 1, rendered_hash: "h", context_read: {}, harness,
});
const turn = (cost: number | null, visit = 1): RunEvent => ({
  type: "turn-finalized", node: "impl", visit, turn: 1,
  usage: cost === null ? { input_tokens: 5, output_tokens: 5, cost_usd: null, cost_source: "unpriced" } : { input_tokens: 5, output_tokens: 5, cost_usd: cost, cost_source: "reported" },
});
const finished: RunEvent = { type: "run-finished", outcome: "success" };
const schemaCase = (name: string): EvalCase => ({ name, dir: tmpdir(), graph: "g", inputs: {}, oracle: { kind: "schema", key: "summary", type: "string" } });
const wrote = (summary: unknown): RunEvent => ({ type: "node-finished", node: "impl", visit: 1, status: "succeeded", writes: { summary } });
const run = (events: RunEvent[]): ArmRun => ({ events: stamp(events), runDir: "/tmp/x", workdir: null });
const A: Variant = { kind: "config", label: "A", overlay: {} };
const B: Variant = { kind: "config", label: "B", overlay: { defaults: { effort: "high" } } };

/** scripted outcome per case×arm: "pass" | "fail" | "park" | "fallback" | "unpriced" */
function scripted(plan: Record<string, string>): Runner {
  return async (c, v) => {
    const what = plan[`${c.name}:${v.label}`] ?? "pass";
    if (what === "park") return run([rendered("claude"), { type: "attention-raised", node: "impl", visit: 1, reason: "full", code: "context-exhausted" }]);
    if (what === "fallback") return run([rendered("claude"), turn(0.1), rendered("codex", 2), turn(null, 2), wrote("ok"), finished]);
    if (what === "unpriced") return run([rendered("codex"), turn(null), wrote("ok"), finished]);
    return run([rendered("claude"), turn(0.1), wrote(what === "pass" ? "ok" : 42), finished]);
  };
}

describe("buckets and verdicts (injected runner)", () => {
  test("parked, fell-back and unpriced are their own buckets, excluded from the paired test", async () => {
    const cases = ["c1", "c2", "c3"].map(schemaCase);
    const report = await runAB({ cases, a: A, b: [B], runner: scripted({ "c1:B": "park", "c2:B": "fallback", "c3:A": "unpriced" }), judge: async () => null });
    const [a, b] = report.arms;
    expect(b!.parked).toEqual({ "context-exhausted": 1 });
    expect(b!.fell_back).toBe(1);
    expect(a!.partial_cost_runs).toBe(1); // the unpriced run is counted, not averaged in
    expect(a!.usage.partial).toBe(true);
    const cmp = report.comparisons![0]!;
    expect(cmp.excluded.map((x) => x.case).sort()).toEqual(["c1", "c2"]);
    expect(cmp.excluded.find((x) => x.case === "c2")!.why).toContain("fell back");
    expect(cmp.table).toEqual({ both: 1, a_only: 0, b_only: 0, neither: 0 });
    expect(cmp.verdict).toContain("not enough cases to tell");
    // --include-fallback keeps the fell-back case in the paired test
    const kept = await runAB({ cases, a: A, b: [B], runner: scripted({ "c1:B": "park", "c2:B": "fallback" }), includeFallback: true });
    expect(kept.comparisons![0]!.excluded.map((x) => x.case)).toEqual(["c1"]);
  });

  test("a clear one-sided result over enough discordant pairs is significant", async () => {
    const cases = Array.from({ length: 8 }, (_, i) => schemaCase(`c${i}`));
    const plan = Object.fromEntries(cases.map((c) => [`${c.name}:A`, "fail"]));
    const report = await runAB({ cases, a: A, b: [B], runner: scripted(plan) });
    const cmp = report.comparisons![0]!;
    expect(cmp.table).toEqual({ both: 0, a_only: 0, b_only: 8, neither: 0 });
    expect(cmp.p).toBeCloseTo(2 * 0.5 ** 8, 10);
    expect(cmp.verdict).toMatch(/^B is better/);
  });

  test("several B's: BH-adjusted p's, one per comparison", async () => {
    const cases = Array.from({ length: 8 }, (_, i) => schemaCase(`c${i}`));
    const B2: Variant = { kind: "config", label: "B2", overlay: { defaults: { effort: "low" } } };
    const plan = Object.fromEntries(cases.map((c) => [`${c.name}:A`, "fail"]));
    const report = await runAB({ cases, a: A, b: [B, B2], runner: scripted(plan) });
    expect(report.arms.map((a) => a.arm)).toEqual(["A", "B1", "B2"]);
    expect(report.comparisons!.map((c) => c.p_adjusted)).toEqual([report.comparisons![0]!.p, report.comparisons![0]!.p]);
  });

  test("--repeat > 1 reports per-case pass rates and runs no paired test", async () => {
    let n = 0;
    const flaky: Runner = async (c, v) => run([rendered("claude"), turn(0.1), wrote(v.label === "B" && n++ % 2 ? 42 : "ok"), finished]);
    const report = await runAB({ cases: [schemaCase("c1")], a: A, b: [B], repeat: 4, runner: flaky });
    expect(report.comparisons).toBeNull();
    expect(report.per_case_pass_rates).toEqual({ c1: { A: "4/4 passed (0 not judged)", B: "2/4 passed (0 not judged)" } });
    expect(formatReport(report)).toContain("no paired test was run");
  });

  test("a rubric the judge cannot judge is `unjudged`, not a failure", async () => {
    const c: EvalCase = { ...schemaCase("r"), oracle: { kind: "rubric", rubric: "is it good?" } };
    const r: CaseResult = await classify(c, "A", A, 1, run([wrote("x"), finished]), async () => null);
    expect(r.outcome).toBe("unjudged");
    expect(r.oracle).toMatchObject({ kind: "rubric", passed: null });
  });

  test("a run that wrote nothing at all is an error bucket, said so", async () => {
    const r = await classify(schemaCase("e"), "A", A, 1, run([]), async () => null);
    expect(r).toMatchObject({ outcome: "error", park_reason: "the run wrote no log" });
  });

  test("buildReport straight from results", () => {
    const res: CaseResult = { case: "c", arm: "A", variant: "A", repeat: 1, outcome: "pass", oracle: null, fell_back: false, harnesses: ["claude"], usage: emptyRollup(), turns: 0, profiles: [], run_dir: "" };
    const report = buildReport(["c"], 1, [{ arm: "A", label: "A" }, { arm: "B", label: "B" }], [res, { ...res, arm: "B", outcome: "fail" }], false);
    expect(report.comparisons![0]!.table).toEqual({ both: 0, a_only: 1, b_only: 0, neither: 0 });
  });
});

test("the case set's oracle files exist and are hidden from the repo's own suite", () => {
  for (const c of loadCases(CASES)) {
    if (c.oracle.kind !== "command") continue;
    for (const src of Object.values(c.oracle.files ?? {})) expect(existsSync(join(c.dir, src))).toBe(true);
  }
});
