/**
 * HOW-37: changing the render rules changes rendered_hash, so the rules are VERSIONED and a
 * past render is rebuilt by its own. Pinned two ways:
 *   - a run dir produced by the engine BEFORE HOW-37 (prompts/fixtures/pre-render-v2, made at
 *     b410e93 — no render_version on its events, a 70k value that today's cap would elide, and
 *     a `| dump`) still reconstructs VERIFIED;
 *   - a findings value that grows across 5 repair visits renders bounded every time, and every
 *     one of those renders reconstructs VERIFIED.
 */
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconstructRender } from "./library";
import { readLog } from "../log/write";
import { defineGraph } from "../core/graph";
import { Engine, type AttemptResult } from "../engine/run";
import { DEFAULT_CONTEXT_CAP } from "../core/template";
import type { LoggedEvent } from "../log/events";

const rendersOf = (events: LoggedEvent[]) => events.filter((e): e is Extract<LoggedEvent, { type: "prompt-rendered" }> => e.type === "prompt-rendered");

describe("a pre-HOW-37 run still reconstructs VERIFIED", () => {
  test("every render of the fixture run — v1 rules, no cap, `| dump` ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-prev2-"));
    cpSync(join(import.meta.dir, "fixtures", "pre-render-v2"), dir, { recursive: true });
    const renders = rendersOf(readLog(join(dir, "run.jsonl")));
    expect(renders).toHaveLength(2);
    expect(renders.every((r) => r.render_version === undefined)).toBe(true);
    // the case that matters: a value far over today's cap, rendered whole by the old rules
    const big = renders.find((r) => r.node === "review")!;
    expect(JSON.stringify(big.context_read.findings).length).toBeGreaterThan(DEFAULT_CONTEXT_CAP);
    for (const r of renders) {
      const rebuilt = reconstructRender(dir, r.rendered_hash);
      expect(rebuilt).toMatchObject({ verified: true });
    }
  });
});

describe("a value that grows across repair visits renders bounded (HOW-37)", () => {
  interface Ctx { goal: string; review_findings: unknown; summary: string; verdict: string }
  const CAP = 2000;
  const graph = () => defineGraph<Ctx>({
    name: "grow", entry: "review", inputs: ["goal"],
    defaults: { contextCap: CAP },
    nodes: {
      review: { kind: "agent", prompt: "g.review" as never, reads: ["goal"], writes: { review_findings: { scope: "sticky" }, verdict: { scope: "cleared" } }, maxVisits: 10 },
      repair: { kind: "agent", prompt: "g.repair" as never, reads: ["goal", "review_findings"], writes: { summary: { scope: "sticky" } }, maxVisits: 10 },
      done: { kind: "terminal", outcome: "success" },
    },
    edges: [
      { from: "review", to: "repair", condition: { reads: ["verdict"], test: (v) => v.verdict === "reject", label: "reject" }, weight: 2 },
      { from: "review", to: "done", condition: { reads: ["verdict"], test: (v) => v.verdict === "pass", label: "pass" }, weight: 1 },
      { from: "repair", to: "review" },
    ],
  });

  test("5 repair visits: every render is capped, and each one reconstructs VERIFIED", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-grow-"));
    const prompts = mkdtempSync(join(tmpdir(), "howdah-grow-p-"));
    writeFileSync(join(prompts, "g.review.md"), "---\nid: g.review\nversion: 1\n---\nReview {{ inputs.goal }}.\n");
    writeFileSync(join(prompts, "g.repair.md"), "---\nid: g.repair\nversion: 1\n---\nRepair {{ inputs.goal }}. Findings:\n{{ context.review_findings | dump }}\n");
    let reviews = 0;
    const findings: Array<{ evidence: string }> = [];
    const engine = new Engine(graph(), {
      dir, promptsDir: prompts,
      executors: {
        agent: async ({ nodeId }): Promise<AttemptResult> => {
          if (nodeId === "repair") return { status: "succeeded", writes: { summary: "tried" } };
          reviews++;
          findings.push({ evidence: `round ${reviews}: ${"e".repeat(1500)} 🐘` });
          return { status: "succeeded", writes: { review_findings: [...findings], verdict: reviews > 5 ? "pass" : "reject" } };
        },
      },
    });
    expect(await engine.start({ goal: "g" })).toEqual({ state: "finished", outcome: "success" });
    const events = readLog(join(dir, "run.jsonl"));
    const repairs = rendersOf(events).filter((r) => r.node === "repair");
    expect(repairs).toHaveLength(5);
    for (const r of repairs) {
      expect(r).toMatchObject({ render_version: 2, context_cap: CAP });
      const rebuilt = reconstructRender(dir, r.rendered_hash)!;
      expect(rebuilt).toMatchObject({ verified: true });
      // bounded: the template, the capped value, and one stub — however big the findings grew
      expect(rebuilt.text.length).toBeLessThan(CAP + 1500);
    }
    // the first repair's findings (1 entry) fit; every later one was elided, naming its producer
    expect(repairs[0]!.context_sources).toBeUndefined();
    expect(repairs[4]!.context_sources).toEqual({ review_findings: expect.stringContaining("the output of review@5") });
    // the stored value is untouched: context_read has every finding
    expect((repairs[4]!.context_read.review_findings as unknown[]).length).toBe(5);
  });
});

describe("an unknown filter is refused at the prompt store's accept guard (HOW-37)", () => {
  test("validateTemplateReads names the filter, before any graph is consulted", async () => {
    const { PromptStore } = await import("./store");
    const problems = new PromptStore(mkdtempSync(join(tmpdir(), "howdah-store-"))).validateTemplateReads("x.y", "Do {{ context.a | trim }}.", []);
    expect(problems).toEqual(['x.y: `{{ context.a | trim }}` uses the filter "trim", which does nothing — the only filter is `dump` (the value as JSON)']);
  });
});
