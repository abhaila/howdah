/**
 * write-doc — non-code work as a first-class graph (shaping A8 / R5). Folder kind Plain:
 * no worktree, no PR probe, no forge facts anywhere. The run TERMINATES ON AGENT VERDICT —
 * doc.review saying "pass" is the finish line, there is no external system to wait on.
 *
 *   outline → draft → review ─┬─pass───▶ done
 *                             └─reject─▶ revise ─▶ review   (revise capped at 3 visits)
 *
 * B1 (HOW-31, docs/designs/graph-drafting.md): written as a `GraphSpec` literal compiled by
 * `buildGraph`, rather than hand-built with `defineGraph`. The compiled `Graph` is identical —
 * `graphs/spec-equivalence.test.ts` pins it against a snapshot taken before the conversion —
 * and `GraphDef.spec` now carries the spec, which is what lets the builder open this graph,
 * what a drafted proposal diffs against, and what `graphs/builder.ts` refuses to infer out of
 * TypeScript.
 *
 * SCOPE MOVED, meaning unchanged: `defineGraph` declares freshness per node per key, a
 * `GraphSpec` declares it once on the field. Checked across all eight built-ins: no key is
 * written at two different scopes, so nothing is lost.
 */
import { buildGraph, type GraphSpec } from "../core/graph-spec";

export interface WriteDocCtx {
  goal: string;
  work: string;
  doc_outline: string;
  doc_summary: string;
  review_verdict: "pass" | "reject";
  review_findings: unknown;
}

export const spec: GraphSpec = {
  version: 1,
  name: "write-doc",
  description: "Outline, draft, and review a document in a plain folder — no repo required",
  // Claude runs in auto mode by default; Codex uses full-access sandboxing in its executor.
  defaults: { permissionMode: "auto" },
  entry: "doc.outline",
  inputs: ["goal", "work"],
  fields: [
    { key: "goal", kind: "text", scope: "sticky" },
    { key: "work", kind: "text", scope: "sticky" },
    { key: "doc_outline", kind: "text", scope: "sticky" },
    { key: "doc_summary", kind: "text", scope: "sticky" },
    { key: "review_verdict", kind: "choice", scope: "cleared", choices: ["pass", "reject"] },
    { key: "review_findings", kind: "json", scope: "cleared" },
  ],
  nodes: [
    { id: "doc.outline", kind: "agent", prompt: "doc.outline", reads: ["goal", "work"], writes: ["doc_outline"] },
    { id: "doc.draft", kind: "agent", prompt: "doc.draft", reads: ["goal", "work", "doc_outline"], writes: ["doc_summary"] },
    {
      id: "doc.review",
      kind: "agent",
      prompt: "doc.review",
      reads: ["goal", "work", "doc_outline", "doc_summary"],
      writes: ["review_verdict", "review_findings"],
    },
    {
      id: "doc.revise",
      kind: "agent",
      prompt: "doc.revise",
      reads: ["goal", "work", "doc_outline", "doc_summary", "review_findings"],
      writes: ["doc_summary"],
      maxVisits: 3,
    },
    { id: "done", kind: "terminal", outcome: "success", label: "document approved" },
  ],
  edges: [
    { from: "doc.outline", to: "doc.draft" },
    { from: "doc.draft", to: "doc.review" },
    { from: "doc.review", to: "doc.revise", when: { op: "equals", key: "review_verdict", value: "reject" } },
    { from: "doc.review", to: "done", when: { op: "equals", key: "review_verdict", value: "pass" } },
    { from: "doc.revise", to: "doc.review" },
  ],
};

export const writeDoc = buildGraph(spec);
