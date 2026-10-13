/**
 * HOW-51 — the default-FAIL acceptance contract: who may write it (the graph), what a write may
 * say (the outputs check), and what holds delivery (the gate's verdict).
 */
import { describe, expect, test } from "bun:test";
import { acceptanceProblem, asAcceptance, latestAcceptance, unmetCriteria, waivedCriteria, type AcceptanceRow } from "./acceptance";
import { defineGraph } from "./graph";
import { FakeLog } from "../web/slice.fixtures";

const row = (id: string, over: Partial<AcceptanceRow> = {}): AcceptanceRow => ({ id, text: `criterion ${id}`, source: "ticket", passes: false, evidence: null, ...over });
const SHOT = "evidence/implementation.evidence@1/01-index.png";
const ctx = { verify: { outcome: "pass" }, evidenceFiles: [SHOT] };

describe("the first list (the criteria step)", () => {
  test("all failing with no evidence is accepted", () => {
    expect(acceptanceProblem([row("ac-1"), row("ac-2", { source: "plan" })])).toBeNull();
  });
  test("a criterion that starts passing is refused — default-FAIL", () => {
    expect(acceptanceProblem([row("ac-1", { passes: true, evidence: { kind: "verify.result" } })])).toMatch(/starts as passing/);
    expect(acceptanceProblem([row("ac-1", { evidence: { kind: "verify.result" } })])).toMatch(/starts as passing/);
  });
  test("an empty list, a duplicate id, a blank text or a non-list is refused", () => {
    expect(acceptanceProblem([])).toMatch(/at least one/);
    expect(acceptanceProblem([row("a"), row("a")])).toMatch(/appears twice/);
    expect(acceptanceProblem([row("a", { text: " " })])).toMatch(/has no text/);
    expect(acceptanceProblem("done")).toMatch(/must be an array/);
  });
});

describe("a flip (the evaluator)", () => {
  const previous = [row("ac-1"), row("ac-2")];
  const flip = (evidence: AcceptanceRow["evidence"], c: object = ctx) =>
    acceptanceProblem([row("ac-1", { passes: true, evidence }), row("ac-2")], { previous, ...c });

  test("with no evidence is refused", () => {
    expect(flip(null)).toMatch(/names no evidence/);
  });
  test("on verify.result only when the tests passed in this run", () => {
    expect(flip({ kind: "verify.result" })).toBeNull();
    expect(flip({ kind: "verify.result" }, { ...ctx, verify: { outcome: "fail" } })).toMatch(/did not pass in this run \(outcome: fail\)/);
    expect(flip({ kind: "verify.result" }, { ...ctx, verify: { outcome: "not-checked" } })).toMatch(/did not pass/);
  });
  test("on a screenshot only when the evidence step captured that file", () => {
    expect(flip({ kind: "screenshot", file: SHOT })).toBeNull();
    expect(flip({ kind: "screenshot", file: "evidence/x@1/made-up.png" })).toMatch(/not one the evidence step captured/);
  });
  test("on a command only with the command AND the output it gave", () => {
    expect(flip({ kind: "command", command: "bun test x", output: "3 pass" })).toBeNull();
    expect(flip({ kind: "command", command: "bun test x", output: " " })).toMatch(/both the command and the output/);
  });
  test("on an unknown kind of evidence is refused", () => {
    expect(flip({ kind: "vibes" } as never)).toMatch(/unknown kind "vibes"/);
  });
  test("rows are never deleted or reworded, and a superseded one stays superseded", () => {
    expect(acceptanceProblem([row("ac-1")], { previous })).toMatch(/"ac-2" was removed/);
    expect(acceptanceProblem([row("ac-1", { text: "something easier" }), row("ac-2")], { previous })).toMatch(/was reworded/);
    const superseded = [row("ac-1", { superseded: true }), row("ac-2"), row("ac-3", { source: "plan" })];
    expect(acceptanceProblem(superseded, { previous })).toBeNull();
    expect(acceptanceProblem([row("ac-1"), row("ac-2"), row("ac-3")], { previous: superseded })).toMatch(/cannot be revived/);
  });
  test("a superseded row's stale pass is not judged — it no longer counts", () => {
    expect(acceptanceProblem([row("ac-1", { superseded: true, passes: true }), row("ac-2")], { previous })).toBeNull();
  });
});

describe("what holds delivery", () => {
  test("live criteria that neither pass nor were waived", () => {
    const rows = [row("a", { passes: true, evidence: { kind: "verify.result" } }), row("b"), row("c"), row("d", { superseded: true })];
    expect(unmetCriteria(rows, new Set(["c"])).map((r) => r.id)).toEqual(["b"]);
  });
  test("waivers and the latest list are folded from the log", () => {
    const log = new FakeLog();
    log.add({ type: "node-finished", node: "criteria", visit: 1, status: "succeeded", writes: { acceptance: [row("a")] } });
    log.add({ type: "node-finished", node: "review", visit: 1, status: "succeeded", writes: { acceptance: [row("a"), row("b")] } });
    log.add({ type: "node-finished", node: "review", visit: 2, status: "failed", writes: {} });
    log.add({ type: "acceptance-waived", criterion_id: "b", reason: "subjective", by: "operator" });
    expect(latestAcceptance(log.events)).toMatchObject({ node: "review", visit: 1 });
    expect(latestAcceptance(log.events)!.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect([...waivedCriteria(log.events).keys()]).toEqual(["b"]);
    expect(asAcceptance([{ id: 1 }])).toBeNull();
  });
});

describe("the graph's rules (core/graph.ts validate)", () => {
  type C = { goal: string; acceptance: unknown; out: string };
  const graph = (buildWrites: boolean, opts: { reviewReadOnly?: boolean; publishReads?: boolean } = {}) =>
    defineGraph<C>({
      name: "g", entry: "criteria", inputs: ["goal"],
      nodes: {
        criteria: { kind: "agent", prompt: "doc.draft", reads: ["goal"], writes: { acceptance: { scope: "sticky" } }, readOnly: true },
        build: { kind: "agent", prompt: "doc.draft", reads: ["goal"], writes: { out: { scope: "sticky" }, ...(buildWrites ? { acceptance: { scope: "sticky" } } : {}) } },
        review: { kind: "agent", prompt: "doc.review", reads: ["acceptance"], writes: { acceptance: { scope: "sticky" } }, ...(opts.reviewReadOnly === false ? {} : { readOnly: true as const }) },
        publish: { kind: "agent", prompt: "doc.draft", reads: opts.publishReads === false ? ["goal"] : ["goal", "acceptance"], writes: {}, requiresAcceptance: true },
        done: { kind: "terminal", outcome: "success" },
      },
      edges: [{ from: "criteria", to: "build" }, { from: "build", to: "review" }, { from: "review", to: "publish" }, { from: "publish", to: "done" }],
    });

  test("a legal contract validates", () => {
    expect(graph(false).validate().structural).toEqual([]);
  });
  test("a BUILD node that declares a write to acceptance fails Graph.validate()", () => {
    expect(graph(true).validate().structural).toContain(
      `node "build" writes "acceptance" but is not a read-only agent — only a read-only evaluator may set or flip acceptance criteria`,
    );
  });
  test("so does an evaluator that is not read-only", () => {
    expect(graph(false, { reviewReadOnly: false }).validate().structural.join("\n")).toMatch(/node "review" writes "acceptance" but is not a read-only agent/);
  });
  test("a node gated on the contract must read it", () => {
    expect(graph(false, { publishReads: false }).validate().structural).toContain(`node "publish" requires acceptance but does not read "acceptance"`);
  });
});
