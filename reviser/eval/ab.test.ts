/**
 * HOW-42: the paired A/B harness.
 *
 *   - end to end under HOWDAH_STUB=1, over the checked-in implement-ticket case set and two
 *     prompt variants: the real CLI runs every arm (interleaved), every run parks (stub agents),
 *     the report is produced and a proposal is stamped — without a token spent;
 *   - with an injected runner: the parked, fell-back and unpriced buckets, the "not enough
 *     cases to tell" verdict, a significant result, and --repeat's per-case pass rates;
 *   - HOW-53, the REVIEW oracle: judgeReview's matching rule over synthetic logs, loadCases
 *     refusing a malformed one, and the local-review case set itself — its invariants, every
 *     case materialised (baseline on main, the defective commit on `ticket`, the suite still
 *     green) with its graph loading, and a stub dry run over all of it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReport, classify, formatReport, judgeReview, loadCases, parseVariant, prepareHome, runAB, stampLine,
  type ArmRun, type CaseResult, type EvalCase, type ReviewOracle, type Runner, type Variant,
} from "./ab";
import type { LoggedEvent, RunEvent } from "../../log/events";
import { loadProposal } from "../../prompts/proposals";
import { emptyRollup } from "../../log/usage";
import { loadLocalGraph } from "../../graphs/local";

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
    expect(a).toMatchObject({ kind: "prompt", id: "implementation.implement", version: 2 });
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

// ---- HOW-53: the review oracle -----------------------------------------------------------------

const REVIEW_CASES = join(import.meta.dir, "cases", "local-review");
const REVIEW = "implementation.local_review";
const reviewed = (verdict: unknown, findings: unknown, visit = 1, node = REVIEW): RunEvent => ({
  type: "node-finished", node, visit, status: "succeeded", writes: { review_verdict: verdict, review_findings: findings },
});
const rejectOracle: ReviewOracle = {
  kind: "review", expect: "reject",
  defects: [
    { id: "unsorted", match: ["sort"] },
    { id: "even", match: ["even", "average|mean"] },
  ],
};

describe("judgeReview: the matching rule", () => {
  test("reject, naming every planted defect, passes", () => {
    const r = judgeReview(rejectOracle, stamp([reviewed("reject", ["median never sorts its input", "an even-length list should return the mean of the two middles"])]));
    expect(r).toEqual({ kind: "review", passed: true, detail: "verdict reject, naming all 2 planted defects" });
  });

  test("a missed defect fails, and the detail names it", () => {
    const r = judgeReview(rejectOracle, stamp([reviewed("reject", ["median never sorts its input"])]));
    expect(r.passed).toBe(false);
    expect(r.detail).toBe("verdict reject, but the findings miss even");
  });

  test("terms satisfied by DIFFERENT findings do not name a defect", () => {
    const r = judgeReview(rejectOracle, stamp([reviewed("reject", ["input is not sorted; even lists are wrong", "uses the mean incorrectly"])]));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("miss even");
  });

  test("the wrong verdict fails either way round", () => {
    expect(judgeReview(rejectOracle, stamp([reviewed("pass", ["sort", "even mean"])]))).toMatchObject({ passed: false, detail: "verdict pass, expected reject" });
    const clean: ReviewOracle = { kind: "review", expect: "pass" };
    expect(judgeReview(clean, stamp([reviewed("reject", ["nit"])]))).toMatchObject({ passed: false, detail: "verdict reject, expected pass" });
  });

  test("a clean control passes on the verdict alone, notes and all", () => {
    expect(judgeReview({ kind: "review", expect: "pass" }, stamp([reviewed("pass", ["non-blocking: consider a docstring"])]))).toMatchObject({ passed: true });
  });

  test("object findings are stringified, and matching ignores case", () => {
    const r = judgeReview(rejectOracle, stamp([reviewed("reject", [{ requirement: "SORT the input" }, { defect: "EVEN length", fix: "return the AVERAGE" }])]));
    expect(r.passed).toBe(true);
  });

  test("a non-array findings value is one text", () => {
    expect(judgeReview({ kind: "review", expect: "reject", defects: [{ id: "s", match: ["sort"] }] }, stamp([reviewed("reject", "not sorted")])).passed).toBe(true);
  });

  test("the latest succeeded visit of the review node wins", () => {
    const events: RunEvent[] = [
      reviewed("reject", ["sort", "even: mean"], 1),
      reviewed("pass", [], 2),
      { type: "node-finished", node: REVIEW, visit: 3, status: "failed", writes: {} },
      reviewed("reject", ["sort", "even: mean"], 1, "some.other_review"),
    ];
    expect(judgeReview(rejectOracle, stamp(events))).toMatchObject({ passed: false, detail: "verdict pass, expected reject" });
    expect(judgeReview({ ...rejectOracle, node: "some.other_review" }, stamp(events)).passed).toBe(true);
  });

  test("no review write at all fails, said so", () => {
    expect(judgeReview(rejectOracle, stamp([wrote("x")]))).toEqual({ kind: "review", passed: false, detail: `the review (${REVIEW}) never finished` });
  });
});

describe("review cases through classify and runAB (injected runner)", () => {
  const reviewCase = (name: string, oracle: ReviewOracle): EvalCase => ({ name, dir: tmpdir(), graph: "eval-review", inputs: {}, oracle });

  test("classify buckets a review into pass and fail from the log", async () => {
    const c = reviewCase("r", rejectOracle);
    const good = await classify(c, "A", A, 1, run([rendered("claude"), turn(0.1), reviewed("reject", ["unsorted input", "even lists need the mean"]), finished]), async () => null);
    expect(good).toMatchObject({ outcome: "pass", oracle: { kind: "review", passed: true } });
    const bad = await classify(c, "A", A, 1, run([rendered("claude"), turn(0.1), reviewed("pass", []), finished]), async () => null);
    expect(bad).toMatchObject({ outcome: "fail", oracle: { kind: "review", passed: false } });
  });

  test("8 review cases reach the paired table and a verdict", async () => {
    const cases = Array.from({ length: 8 }, (_, i) => reviewCase(`c${i}`, rejectOracle));
    // A rubber-stamps every change; B rejects naming both defects
    const runner: Runner = async (_c, v) =>
      run([rendered("claude"), turn(0.1), v.label === "A" ? reviewed("pass", []) : reviewed("reject", ["did not sort", "even length: no average"]), finished]);
    const report = await runAB({ cases, a: A, b: [B], runner });
    expect(report.oracle_kinds).toEqual(["review"]);
    expect(report.comparisons![0]!.table).toEqual({ both: 0, a_only: 0, b_only: 8, neither: 0 });
    expect(report.comparisons![0]!.verdict).toMatch(/^B is better/);
  });
});

describe("loadCases refuses a malformed review oracle", () => {
  const write = (oracle: unknown, extra: Record<string, unknown> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-ab-bad-"));
    mkdirSync(join(dir, "c1"));
    writeFileSync(join(dir, "c1", "case.json"), JSON.stringify({ graph: "eval-review", oracle, ...extra }));
    return dir;
  };
  test.each([
    [{ kind: "review", expect: "maybe" }, /"expect" must be "pass" or "reject"/],
    [{ kind: "review", expect: "reject" }, /must list the planted defects/],
    [{ kind: "review", expect: "reject", defects: [] }, /must list the planted defects/],
    [{ kind: "review", expect: "pass", defects: [{ id: "x", match: ["y"] }] }, /cannot list defects/],
    [{ kind: "review", expect: "reject", defects: [{ id: "x", match: ["a"] }, { id: "x", match: ["b"] }] }, /"x" is listed twice/],
    [{ kind: "review", expect: "reject", defects: [{ id: "x", match: ["(unclosed"] }] }, /does not compile/],
    [{ kind: "review", expect: "reject", defects: [{ id: "x", match: [] }] }, /non-empty "match"/],
  ])("%j", (oracle, err) => {
    expect(() => loadCases(write(oracle))).toThrow(err);
  });

  test("a repo.branch missing its message", () => {
    expect(() => loadCases(write({ kind: "review", expect: "pass" }, { repo: { dir: ".", branch: { name: "t", dir: "change" } } }))).toThrow(/repo.branch needs/);
  });

  test("the error names the case", () => {
    expect(() => loadCases(write({ kind: "review", expect: "maybe" }))).toThrow(/c1\/case\.json/);
  });
});

describe("the local-review case set", () => {
  const cases = loadCases(REVIEW_CASES);
  const oracles = cases.map((c) => c.oracle as ReviewOracle);

  test("at least six cases, every one a review, with at least one clean control", () => {
    expect(cases.length).toBeGreaterThanOrEqual(6);
    expect(oracles.every((o) => o.kind === "review")).toBe(true);
    expect(oracles.filter((o) => o.expect === "pass").length).toBeGreaterThanOrEqual(1);
    expect(oracles.filter((o) => o.expect === "reject").length).toBeGreaterThanOrEqual(1);
  });

  test("every case runs the review graph on a pre-made branch, with a plan and a summary to doubt", () => {
    for (const c of cases) {
      expect(c.graph).toBe("eval-review");
      expect(c.repo?.branch?.name).toBe("ticket");
      for (const k of ["goal", "work", "implementation_plan", "implementation_summary"]) expect(c.inputs[k]?.trim().length ?? 0).toBeGreaterThan(0);
      // the builder's claim the reviewer must not take on trust
      expect(c.inputs.implementation_summary).toContain("verified");
    }
  });

  test("every defective case's regexes compile, and its own summary does not name its defects", () => {
    for (const [i, o] of oracles.entries()) {
      if (o.expect !== "reject") continue;
      expect(o.defects!.length).toBeGreaterThan(0);
      // a reviewer that pasted the summary back as its finding must not score
      const echoed = judgeReview(o, stamp([reviewed("reject", [cases[i]!.inputs.implementation_summary])]));
      expect({ case: cases[i]!.name, passed: echoed.passed }).toEqual({ case: cases[i]!.name, passed: false });
    }
  });

  test("a competent reviewer's plain findings name every planted defect", () => {
    // written the way a reviewer would, not the way the regexes are — the rule must not be too tight
    const findings: Record<string, string[]> = {
      "01-paginate-off-by-one": ["Off-by-one: the offset is page*size, so paginate(ten, 1, 3) returns the second page; the offset must be (page - 1) * size"],
      "02-slugify-missing-trim": ["slugify(\"Hello, World!\") returns \"hello-world-\": the trailing hyphen is never stripped, against the work scope"],
      "03-escape-html-ampersand": ["Security: the ampersand is not escaped, so \"&lt;\" passes through unchanged and the entity table lacks &amp;"],
      "04-scope-creep": ["truncate was changed (it now appends \"...\" beyond max) — outside the scope of a titleCase ticket"],
      "05-median-two-defects": ["median does not sort its input: median([3,1,2]) returns 1", "For an even-length list it returns the upper middle instead of the mean of the two middle values"],
      "06-skipped-test": ["The regression test for repeated whitespace is marked test.skip, so the suite passes without the fix working"],
    };
    for (const [i, o] of oracles.entries()) {
      if (o.expect !== "reject") continue;
      const sample = findings[cases[i]!.name];
      expect({ case: cases[i]!.name, sampled: sample !== undefined }).toEqual({ case: cases[i]!.name, sampled: true });
      const r = judgeReview(o, stamp([reviewed("reject", sample)]));
      expect({ case: cases[i]!.name, detail: r.detail }).toEqual({ case: cases[i]!.name, detail: expect.stringContaining("naming all") });
    }
  });

  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim() };
  };

  test.each(cases.map((c) => [c.name, c] as const))("%s materialises: baseline on main, the change on `ticket`, the suite green, the graph loads", async (_name, c) => {
    const { home } = prepareHome(c, parseVariant(join(ROOT, "prompts", "ticket.local_review.md")));
    const repo = join(home, "src", c.name);
    expect(git(repo, "log", "--format=%s", "main").out).toBe("eval case baseline");
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").out).toBe("ticket");
    expect(git(repo, "rev-list", "--count", "main..HEAD").out).toBe("1");
    expect(git(repo, "status", "--porcelain").out).toBe("");
    expect(git(repo, "diff", "--name-only", "main..HEAD").out.length).toBeGreaterThan(0);
    // every planted defect is invisible to the repo's own suite: verify.run says pass
    const t = Bun.spawnSync(["bun", "test"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    expect({ case: c.name, exit: t.exitCode }).toEqual({ case: c.name, exit: 0 });
    // the template compiles, validates (every review read has a writer) and finds its prompts
    const graph = await loadLocalGraph(home, "eval-review", ROOT);
    expect(Object.keys(graph.def.nodes).sort()).toEqual(["create_worktree", "done", "implementation.criteria", "implementation.evidence", "implementation.local_review", "verify.run"]);
    expect(Object.values(graph.def.nodes).some((n) => n.kind === "agent" && /publish|deliver/.test((n as { prompt: string }).prompt))).toBe(false);
    for (const id of ["implementation.criteria", "implementation.local_review"]) expect((graph.def.nodes[id] as { readOnly?: boolean }).readOnly).toBe(true);
    expect(readFileSync(join(home, "prompts", "ticket.local_review.md"), "utf8")).toContain("id: ticket.local_review");
  }, 30000);

  test("end to end under HOWDAH_STUB=1: every case parks, interleaved, and a dry-run stamp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-ab-review-e2e-"));
    const b = proposal(dir, "ticket.local_review");
    const order: string[] = [];
    process.env.HOWDAH_STUB = "1";
    let report;
    try {
      report = await runAB({ cases, a: parseVariant(join(ROOT, "prompts", "ticket.local_review.md")), b: [parseVariant(b)], log: (l) => order.push(l.split(":")[0]!) });
    } finally {
      delete process.env.HOWDAH_STUB;
    }
    expect(order).toEqual(cases.flatMap((c) => [`${c.name} #1 A`, `${c.name} #1 B`]));
    expect(report.results.every((r) => r.outcome === "parked" && r.park_code === "executor-threw")).toBe(true);
    expect(report.comparisons![0]!.verdict).toContain("not enough cases to tell");
    expect(stampLine(report, { dryRun: true }).score).toStartWith("DRY RUN (HOWDAH_STUB, no agent ran)");
  }, 300000);
});
