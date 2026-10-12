/**
 * `howdah metrics` (T16) on fixture logs: slice runs vs the implement-ticket baseline — review
 * time, redraws, reject loops after approval, drift at publish, abandonment.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatMetrics, metricsReport, readRunMetrics, runMetrics } from "./metrics";
import type { LoggedEvent, RunEvent } from "../log/events";
import { emptyCounts } from "../map/drift";
import { emptyRollup } from "../log/usage";

const T0 = Date.parse("2026-09-19T10:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

/** stamp seq in order; each entry is [minute, event] */
function log(entries: Array<[number, RunEvent]>): LoggedEvent[] {
  return entries.map(([min, e], i) => ({ ...e, seq: i + 1, ts: at(min) }) as LoggedEvent);
}

const started = (graph: string): RunEvent => ({ type: "run-started", graph, inputs: {}, pinned_prompts: {} });
const proposed = (id: number): RunEvent => ({
  type: "ghost-proposed", node: "slice.propose", approval: "slice.approve", proposal_id: id, proposal_hash: `h${id}`, manifest_hash: "m", fingerprint: null, proposal: {},
});
const drift = (missing: number): RunEvent => ({
  type: "drift-detected", node: "map.drift", visit: 1, commit: "c", stamp: "c", dirty: false, base_commit: "b", manifest_hash: "a", base_manifest_hash: "m",
  counts: { ...emptyCounts(), missing, verified: 3 }, items: [], truncated: 0,
});
const nodeStarted = (node: string, visit = 1): RunEvent => ({ type: "node-started", node, visit, attempt_id: `${node}#${visit}` });
const reject = (to = "implementation.implement"): RunEvent => ({ type: "edge-taken", from: "implementation.local_review", to, label: "review_verdict == 'reject'" });
const turn = (node: string, cost: number | null, visit = 1): RunEvent => ({
  type: "turn-finalized", node, visit, turn: 1,
  usage: cost === null
    ? { input_tokens: 10, output_tokens: 5, cost_usd: null, cost_source: "unpriced" }
    : { input_tokens: 10, output_tokens: 5, cost_usd: cost, cost_source: "reported" },
});
const pass: RunEvent = { type: "edge-taken", from: "implementation.local_review", to: "delivery.publish", label: "review_verdict == 'pass'" };

// a slice run: v1 → feedback after 2m → v2 → approved after 1m → one reject → publish with drift → merged
const SLICE_OK = log([
  [0, started("implement-slice")],
  [1, proposed(2)],
  [2, { type: "comment-pinned", id: "c3", entity_id: "e", proposal_id: 2, text: "no" }],
  [3, { type: "slice-feedback-sent", proposal_id: 2, proposal_hash: "h2", manifest_hash: "m", comment_ids: ["c3"] }],
  [4, proposed(5)],
  [5, { type: "slice-approved", proposal_id: 5, proposal_hash: "h5", manifest_hash: "m" }],
  [6, nodeStarted("implementation.implement")],
  [6, turn("implementation.implement", 0.25)],
  [7, drift(2)],
  [8, reject()],
  [9, nodeStarted("implementation.implement", 2)],
  [10, drift(0)],
  [11, pass],
  [12, nodeStarted("delivery.publish")],
  [13, drift(1)], // a later repair's drift — after the publish, so not "at publish"
  [20, { type: "run-finished", outcome: "success" }],
]);

// a slice run the operator walked away from after seeing a proposal
const SLICE_ABANDONED = log([
  [0, started("implement-slice")],
  [30, proposed(2)],
  [40, { type: "run-finished", outcome: "aborted" }],
]);

// aborted before anything was proposed: not an abandoned DESIGN
const SLICE_ABORTED_EARLY = log([[0, started("implement-slice")], [1, { type: "run-finished", outcome: "aborted" }]]);

// the baseline: two reject loops (local_review → plan_review), published, no drift check
const TICKET = log([
  [0, started("implement-ticket")],
  [1, turn("implementation.implement", 0.5)],
  [2, turn("implementation.implement", null, 2)], // fell back to codex: unpriced
  [5, reject("implementation.plan_review")],
  [8, reject("implementation.plan_review")],
  [9, pass],
  [10, nodeStarted("delivery.publish")],
  [11, { type: "run-finished", outcome: "success" }],
]);
const TICKET_ABORTED = log([[0, started("implement-ticket")], [3, { type: "run-finished", outcome: "aborted" }]]);

describe("runMetrics", () => {
  test("a slice run: review time per decided round, redraws, rejects after approval, drift as published", () => {
    expect(runMetrics("s1", SLICE_OK)).toEqual({
      run: "s1",
      graph: "implement-slice",
      status: "success",
      started_at: at(0),
      proposals: 2,
      redraws: 1,
      review_ms: [2 * 60_000, 60_000],
      reject_loops: 1,
      drift_at_publish: { ...emptyCounts(), verified: 3 },
      abandoned: false,
      pr_closed: false,
      usage: expect.objectContaining({ turns: 1, cost_usd: 0.25, partial: false }),
    });
  });

  test("abandonment is an abort after a proposal; an undecided round has no review time", () => {
    expect(runMetrics("s2", SLICE_ABANDONED)).toMatchObject({ status: "aborted", abandoned: true, proposals: 1, redraws: 0, review_ms: [] });
    expect(runMetrics("s3", SLICE_ABORTED_EARLY)).toMatchObject({ status: "aborted", abandoned: false });
  });

  test("a PR closed on the forge ends aborted through the `closed` terminal: not an abandonment", () => {
    const closed = log([
      [0, started("implement-slice")],
      [1, proposed(2)],
      [2, { type: "slice-approved", proposal_id: 2, proposal_hash: "h2", manifest_hash: "m" }],
      [3, { type: "edge-taken", from: "cleanup_closed", to: "closed", label: "worktree.clean == true" }],
      [4, { type: "run-finished", outcome: "aborted" }],
    ]);
    expect(runMetrics("c", closed)).toMatchObject({ status: "aborted", abandoned: false, pr_closed: true });
  });

  test("the baseline: every local_review reject counts, no drift at publish, aborted = abandoned", () => {
    expect(runMetrics("t1", TICKET)).toMatchObject({ reject_loops: 2, drift_at_publish: null, proposals: 0, abandoned: false });
    expect(runMetrics("t2", TICKET_ABORTED)).toMatchObject({ abandoned: true });
  });

  test("a log without run-started is not a run; an unfinished run is running", () => {
    expect(runMetrics("x", [])).toBeNull();
    expect(runMetrics("y", SLICE_OK.slice(0, 6))).toMatchObject({ status: "running", drift_at_publish: null });
  });
});

describe("metricsReport over runs/*/run.jsonl", () => {
  function runsDir(): string {
    const dir = join(mkdtempSync(join(tmpdir(), "howdah-metrics-")), "runs");
    const write = (id: string, events: LoggedEvent[]) => {
      mkdirSync(join(dir, id), { recursive: true });
      writeFileSync(join(dir, id, "run.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    };
    write("slice-ok", SLICE_OK);
    write("slice-abandoned", SLICE_ABANDONED);
    write("slice-early", SLICE_ABORTED_EARLY);
    write("ticket", TICKET);
    write("ticket-aborted", TICKET_ABORTED);
    write("doc", log([[0, started("write-doc")]])); // other graphs are not compared
    mkdirSync(join(dir, "not-a-run")); // no run.jsonl
    // a torn final line is tolerated
    writeFileSync(join(dir, "ticket", "run.jsonl"), TICKET.map((e) => JSON.stringify(e)).join("\n") + '\n{"type":"chu');
    return dir;
  }

  test("slice runs are summarised against the implement-ticket baseline", () => {
    const report = metricsReport(readRunMetrics(runsDir()));
    expect(report.runs.map((r) => r.run).sort()).toEqual(["slice-abandoned", "slice-early", "slice-ok", "ticket", "ticket-aborted"]);
    expect(report.slice).toEqual({
      runs: 3, finished: 3, median_review_ms: 90_000, mean_redraws: 0.33, mean_reject_loops: 0.33, drift_problems_at_publish: 0, abandoned: 1,
      median_cost_usd: 0.25, total_cost_usd: 0.25, priced_runs: 1, partial_cost_runs: 0,
    });
    expect(report.baseline).toEqual({
      runs: 2, finished: 2, median_review_ms: null, mean_redraws: 0, mean_reject_loops: 1, drift_problems_at_publish: 0, abandoned: 1,
      // HOW-34: the ticket run fell back to an unpriced harness — counted, never averaged in
      median_cost_usd: null, total_cost_usd: null, priced_runs: 0, partial_cost_runs: 1,
    });
  });

  test("the text report names both rows and every run", () => {
    const text = formatMetrics(metricsReport(readRunMetrics(runsDir())));
    expect(text).toContain("implement-slice");
    expect(text).toContain("implement-ticket (base)");
    expect(text).toContain("slice-ok  implement-slice  success  rounds 2  review 2m/1m  rejects 1");
    expect(text).toContain("slice-abandoned  implement-slice  aborted (abandoned)");
    // HOW-34: the cost column, partial where the run was
    expect(text).toContain("cost(med)");
    expect(text).toContain("cost $0.2500");
    expect(text).toContain("cost $0.5000 (partial: 1 of 2 turns unpriced)");
    expect(text).toContain("— +1 partial");
  });

  test("HOW-34: a run with no turns has an empty rollup and no cost", () => {
    expect(runMetrics("t2", TICKET_ABORTED)?.usage).toEqual(emptyRollup());
  });

  test("no runs directory is an empty report, not an error", () => {
    expect(metricsReport(readRunMetrics(join(tmpdir(), "howdah-no-such-dir-xyz")))).toMatchObject({ runs: [], slice: { runs: 0, median_review_ms: null } });
  });
});

describe("CLI verbs (subprocess — the exit code is the contract)", () => {
  const MAIN = join(import.meta.dir, "main.ts");
  async function cli(home: string, ...args: string[]) {
    const p = Bun.spawn(["bun", MAIN, ...args], { env: { ...process.env, HOWDAH_HOME: home, HOWDAH_STUB: "1" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr };
  }

  test("metrics --json reads $HOWDAH_HOME/runs", async () => {
    const home = mkdtempSync(join(tmpdir(), "howdah-metrics-cli-"));
    mkdirSync(join(home, "runs", "s1"), { recursive: true });
    writeFileSync(join(home, "runs", "s1", "run.jsonl"), SLICE_OK.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const r = await cli(home, "metrics", "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ slice: { runs: 1, mean_redraws: 1 }, baseline: { runs: 0 } });
  });

  test("map <dir> wraps map/cli.ts: a summary for a repo, exit 2 with usage for no dir", async () => {
    const { sliceRepo } = await import("../graphs/slice-fixture");
    const home = mkdtempSync(join(tmpdir(), "howdah-map-cli-"));
    const ok = await cli(home, "map", sliceRepo().dir);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("entities    6");
    const bad = await cli(home, "map");
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("usage: bun map/cli.ts");
  });
});
