/**
 * write-doc — non-code work as a first-class graph (shaping A8 / R5). Folder kind Plain:
 * no worktree, no PR probe, no forge facts anywhere. The run TERMINATES ON AGENT VERDICT —
 * doc.review saying "pass" is the finish line, there is no external system to wait on.
 *
 *   outline → draft → review ─┬─pass───▶ done
 *                             └─reject─▶ revise ─▶ review   (revise capped at 3 visits)
 */
import { defineGraph } from "../core/graph";

export interface WriteDocCtx {
  goal: string;
  work: string;
  doc_outline: string;
  doc_summary: string;
  review_verdict: "pass" | "reject";
  review_findings: unknown;
}

const sticky = { scope: "sticky" } as const;
const cleared = { scope: "cleared" } as const;

export const writeDoc = defineGraph<WriteDocCtx>({
  name: "write-doc",
  // Claude runs in auto mode by default; Codex uses full-access sandboxing in its executor.
  defaults: { permissionMode: "auto" },
  description: "Outline, draft, and review a document in a plain folder — no repo required",
  entry: "doc.outline",
  inputs: ["goal", "work"],
  nodes: {
    "doc.outline": {
      kind: "agent",
      prompt: "doc.outline",
      reads: ["goal", "work"],
      writes: { doc_outline: sticky },
    },
    "doc.draft": {
      kind: "agent",
      prompt: "doc.draft",
      reads: ["goal", "work", "doc_outline"],
      writes: { doc_summary: sticky },
    },
    "doc.review": {
      kind: "agent",
      prompt: "doc.review",
      reads: ["goal", "work", "doc_outline", "doc_summary"],
      writes: { review_verdict: cleared, review_findings: cleared },
    },
    "doc.revise": {
      kind: "agent",
      prompt: "doc.revise",
      reads: ["goal", "work", "doc_outline", "doc_summary", "review_findings"],
      writes: { doc_summary: sticky },
      maxVisits: 3,
    },
    done: { kind: "terminal", outcome: "success", label: "document approved" },
  },
  edges: [
    { from: "doc.outline", to: "doc.draft" },
    { from: "doc.draft", to: "doc.review" },
    {
      from: "doc.review",
      to: "doc.revise",
      condition: { reads: ["review_verdict"], test: (v) => v.review_verdict === "reject", label: "review_verdict == 'reject'" },
      weight: 2,
    },
    {
      from: "doc.review",
      to: "done",
      condition: { reads: ["review_verdict"], test: (v) => v.review_verdict === "pass", label: "review_verdict == 'pass'" },
      weight: 1,
    },
    { from: "doc.revise", to: "doc.review" },
  ],
});
