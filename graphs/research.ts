/**
 * research — the second Plain-folder graph (shaping A8 / R5). No repo, no worktree, no
 * forge. Terminates on the reviewer's verdict; synthesis is capped so a picky reviewer
 * parks the run for the operator instead of burning visits forever.
 *
 *   plan → investigate → synthesize → review ─┬─pass───▶ done
 *                                             └─reject─▶ synthesize   (max 3 visits)
 */
import { defineGraph } from "../core/graph";

export interface ResearchCtx {
  goal: string;
  research_questions: string;
  findings_summary: string;
  report_summary: string;
  review_verdict: "pass" | "reject";
  review_findings: unknown;
}

const sticky = { scope: "sticky" } as const;
const cleared = { scope: "cleared" } as const;

export const research = defineGraph<ResearchCtx>({
  name: "research",
  description: "Plan, investigate, and synthesize a research question into a cited report",
  entry: "research.plan",
  inputs: ["goal"],
  nodes: {
    "research.plan": {
      kind: "agent",
      prompt: "research.plan",
      reads: ["goal"],
      writes: { research_questions: sticky },
    },
    "research.investigate": {
      kind: "agent",
      prompt: "research.investigate",
      reads: ["goal", "research_questions"],
      writes: { findings_summary: sticky },
    },
    "research.synthesize": {
      kind: "agent",
      prompt: "research.synthesize",
      reads: ["goal", "research_questions", "findings_summary"],
      writes: { report_summary: sticky },
      maxVisits: 3,
    },
    "research.review": {
      kind: "agent",
      prompt: "research.review",
      reads: ["goal", "report_summary"],
      writes: { review_verdict: cleared, review_findings: cleared },
    },
    done: { kind: "terminal", outcome: "success", label: "report approved" },
  },
  edges: [
    { from: "research.plan", to: "research.investigate" },
    { from: "research.investigate", to: "research.synthesize" },
    { from: "research.synthesize", to: "research.review" },
    {
      from: "research.review",
      to: "research.synthesize",
      condition: { reads: ["review_verdict"], test: (v) => v.review_verdict === "reject", label: "review_verdict == 'reject'" },
      weight: 2,
    },
    {
      from: "research.review",
      to: "done",
      condition: { reads: ["review_verdict"], test: (v) => v.review_verdict === "pass", label: "review_verdict == 'pass'" },
      weight: 1,
    },
  ],
});
