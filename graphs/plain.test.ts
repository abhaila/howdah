import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { writeDoc } from "./write-doc";
import { research } from "./research";
import { Engine } from "../engine/run";
import { probeGit, readsForgeFacts } from "../engine/reconcile";

const PROMPTS = join(dirname(import.meta.dir), "prompts");

describe("Plain-folder graphs (A8 / R5)", () => {
  test("write-doc and research validate clean", () => {
    expect(() => writeDoc.validateOrThrow()).not.toThrow();
    expect(() => research.validateOrThrow()).not.toThrow();
  });

  test("no node reads forge facts and no worktree nodes exist", () => {
    for (const g of [writeDoc, research]) {
      for (const def of Object.values(g.def.nodes)) {
        expect(def.kind).not.toBe("worktree");
        expect(readsForgeFacts(def)).toBe(false);
      }
    }
  });

  test("write-doc completes in a folder with NO git repo, terminating on agent verdict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-plain-"));
    expect(probeGit(dir).repo).toBe(false); // genuinely not a repo

    const verdicts: Array<"reject" | "pass"> = ["reject", "pass"];
    const engine = new Engine(writeDoc, {
      dir,
      promptsDir: PROMPTS,
      executors: {
        agent: async ({ nodeId }) => {
          switch (nodeId) {
            case "doc.outline": return { status: "succeeded", writes: { doc_outline: "1. intro 2. body" } };
            case "doc.draft": return { status: "succeeded", writes: { doc_summary: "draft v1 at doc.md" } };
            case "doc.revise": return { status: "succeeded", writes: { doc_summary: "draft v2 at doc.md" } };
            case "doc.review": return { status: "succeeded", writes: { review_verdict: verdicts.shift()!, review_findings: ["tighten intro"] } };
            default: throw new Error(`unexpected node ${nodeId}`);
          }
        },
      },
    });
    const result = await engine.start({ goal: "write the eng blog post", work: "sequence blog draft" });
    expect(result).toEqual({ state: "finished", outcome: "success" });

    const edges = engine.log.read().filter((e) => e.type === "edge-taken").map((e: any) => `${e.from}>${e.to}`);
    expect(edges).toEqual([
      "doc.outline>doc.draft",
      "doc.draft>doc.review",
      "doc.review>doc.revise",
      "doc.revise>doc.review",
      "doc.review>done", // the agent verdict IS the finish line
    ]);
  });

  test("research completes on pass verdict with pinned prompt versions recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-plain-"));
    const engine = new Engine(research, {
      dir,
      promptsDir: PROMPTS,
      executors: {
        agent: async ({ nodeId }) => {
          switch (nodeId) {
            case "research.plan": return { status: "succeeded", writes: { research_questions: "Q1, Q2" } };
            case "research.investigate": return { status: "succeeded", writes: { findings_summary: "answers with citations" } };
            case "research.synthesize": return { status: "succeeded", writes: { report_summary: "report.md written" } };
            case "research.review": return { status: "succeeded", writes: { review_verdict: "pass", review_findings: [] } };
            default: throw new Error(`unexpected node ${nodeId}`);
          }
        },
      },
    });
    expect(await engine.start({ goal: "compare BigQuery read-path options" })).toEqual({ state: "finished", outcome: "success" });
    const started: any = engine.log.read().find((e) => e.type === "run-started");
    expect(started.pinned_prompts["research.plan"]).toBe(1);
  });

  test("picky reviewer exhausts synthesize maxVisits and parks for the operator", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-plain-"));
    const engine = new Engine(research, {
      dir,
      promptsDir: PROMPTS,
      executors: {
        agent: async ({ nodeId }) => {
          if (nodeId === "research.review") return { status: "succeeded", writes: { review_verdict: "reject", review_findings: ["never satisfied"] } };
          return { status: "succeeded", writes: nodeId === "research.plan" ? { research_questions: "q" } : nodeId === "research.investigate" ? { findings_summary: "f" } : { report_summary: "r" } };
        },
      },
    });
    const result = await engine.start({ goal: "g" });
    expect(result).toMatchObject({ state: "parked", node: "research.synthesize" });
    expect((result as any).reason).toContain("maxVisits");
  });
});
