/**
 * HOW-78: the run report is derived from the log — the route and `howdah report` serve the same
 * page, the PR poll folds into one row, and the operator's own interventions are on the record.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, readLog } from "../log/write";
import { createHowdahServer } from "./server";
import { loadRunReport, reportSteps } from "./report";

function run() {
  const home = mkdtempSync(join(tmpdir(), "howdah-report-"));
  const runDir = join(home, "runs", "r1");
  const log = new EventLog(join(runDir, "run.jsonl"));
  const step = (node: string, visit: number, writes: Record<string, unknown>, status: "succeeded" | "failed" = "succeeded") => {
    log.append({ type: "node-started", node, visit, attempt_id: `${node}#${visit}` });
    log.append({ type: "node-finished", node, visit, status, writes });
  };
  log.append({ type: "run-started", graph: "implement-ticket", inputs: { goal: "IE-4041 Xero overpayments\nmore", work: "w" }, pinned_prompts: {} });
  step("implementation.plan", 1, { implementation_plan: "## Plan\nTarget-vs-held model." });
  step("verify.run", 1, { "verify.result": { outcome: "pass", command: "bun test", output_tail: "ok", commit: "abcdef1234" } });
  mkdirSync(join(runDir, "evidence", "implementation.evidence@1"), { recursive: true });
  writeFileSync(join(runDir, "evidence", "implementation.evidence@1", "root.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  step("implementation.evidence", 1, { "evidence.items": { outcome: "captured", items: [{ path: "/", url: "http://127.0.0.1:1/", file: "evidence/implementation.evidence@1/root.png", abs_path: "", captured_at: "2026-10-30T00:00:00Z", console_errors: 0, console_sample: [] }] } });
  step("implementation.local_review", 1, { review_verdict: "pass", review_findings: [], acceptance: [{ id: "ac-1", text: "applies the gap", source: "ticket", passes: true, evidence: { kind: "verify.result" } }] });
  step("implementation.report", 1, { change_map: { title: "Xero overpayment applications", summary: "s", components: [{ id: "recon", label: "Recon", status: "new" }] } });
  step("delivery.publish", 1, { publication_summary: "PR https://github.com/o/r/pull/7" });
  for (let v = 1; v <= 3; v++) { step("delivery.probe_pr", v, { "pr.state": "OPEN" }); step("delivery.wait", v, {}); }
  log.append({ type: "operator-jump", to: "delivery.address_reviews", message: "handle Elizabeth's comments" });
  return { home, runsDir: join(home, "runs") };
}

test("a step that repeats back to back is one row with a count and its latest detail", () => {
  const home = mkdtempSync(join(tmpdir(), "howdah-report-fold-"));
  const path = join(home, "run.jsonl");
  const log = new EventLog(path);
  log.append({ type: "run-started", graph: "implement-stacked", inputs: {}, pinned_prompts: {} });
  for (let v = 1; v <= 18; v++) {
    log.append({ type: "node-started", node: "stacked.await", visit: v, attempt_id: `a#${v}` });
    log.append({ type: "node-finished", node: "stacked.await", visit: v, status: "succeeded", writes: { "deps.waiting": `waiting on be-1 · package (check ${v})` } });
  }
  log.append({ type: "node-started", node: "create_worktree", visit: 1, attempt_id: "w#1" });
  log.append({ type: "node-finished", node: "create_worktree", visit: 1, status: "succeeded", writes: {} });
  const steps = reportSteps(readLog(path));
  expect(steps.map((s) => s.title)).toEqual(["Await ×18", "Create worktree"]);
  expect(steps[0]!.detail).toBe("waiting on be-1 · package (check 18)");
});

describe("the run report", () => {
  test("is derived from the log: change map, plan, criteria, tests and an embedded screenshot", () => {
    const { runsDir } = run();
    const html = loadRunReport(runsDir, "r1")!;
    expect(html).toContain("Xero overpayment applications");
    expect(html).toContain("IE-4041 Xero overpayments");
    expect(html).toContain("Target-vs-held model.");
    expect(html).toContain("applies the gap");
    expect(html).toContain("pass @ abcdef12");
    expect(html).toContain('src="data:image/png;base64,iVBORw==');
    expect(loadRunReport(runsDir, "nope")).toBeNull();
  });

  test("the PR poll folds into one row, and the operator's jump is on the record", () => {
    const { home } = run();
    const steps = reportSteps(readLog(join(home, "runs", "r1", "run.jsonl")));
    expect(steps.filter((s) => s.title === "Waiting on the PR")).toHaveLength(1);
    expect(steps.find((s) => s.title === "Waiting on the PR")!.detail).toBe("Polled the PR 3 times; it is open and waiting.");
    expect(steps.at(-1)).toMatchObject({ title: "Your jump · Address reviews", detail: "handle Elizabeth's comments", kind: "operator" });
    expect(steps.find((s) => s.title.startsWith("Verify"))!.title).toBe("Verify · pass");
  });

  test("GET /api/runs/:id/report serves it as HTML with its own CSP, and ?download=1 as an attachment", async () => {
    const { home } = run();
    const server = createHowdahServer({ runsDir: join(home, "runs"), attentionDir: join(home, "attention"), port: 0, graphs: {} });
    try {
      const res = await fetch(`http://localhost:${server.port}/api/runs/r1/report`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(await res.text()).toContain("How the run got here");
      const dl = await fetch(`http://localhost:${server.port}/api/runs/r1/report?download=1`);
      expect(dl.headers.get("content-disposition")).toBe('attachment; filename="r1-report.html"');
      expect((await fetch(`http://localhost:${server.port}/api/runs/nope/report`)).status).toBe(404);
    } finally { server.stop(true); }
  });
});
