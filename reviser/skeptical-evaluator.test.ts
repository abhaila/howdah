/**
 * HOW-53 — the skeptical-evaluator rewrite, proposed against v2 and accepted by the operator on
 * 2026-10-13 ahead of the HOW-42 A/B measurement. What is pinned: the live prompt IS the accepted
 * proposal, and it says what the ticket asked: ticket and criteria first, the builder's summary last and as a claim, missing
 * evidence is NEEDS_WORK, and the evaluator never offers to fix anything.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadProposal } from "../prompts/proposals";
import { PromptStore } from "../prompts/store";

const ROOT = join(import.meta.dir, "..");
const PATH = join(ROOT, "reviser", "proposals", "ticket.local_review.v3.proposal.md");

describe("ticket.local_review v3 (the skeptical evaluator)", () => {
  const p = loadProposal(PATH);

  test("was accepted from v2, and the live prompt is exactly its body", () => {
    expect(p.status).toBe("accepted");
    expect(p.base_version).toBe(2);
    const live = new PromptStore(join(ROOT, "prompts")).load("ticket.local_review");
    expect(live.version).toBe(3);
    expect(live.body.trim()).toBe(p.body.trim());
  });

  test("reads in cwc's order: ticket + contract, diff, evidence, and the summary LAST as a claim", () => {
    const at = (s: string) => p.body.indexOf(s);
    expect(at("{{ context.acceptance }}")).toBeLessThan(at("## 2. What changed"));
    expect(at("## 2. What changed")).toBeLessThan(at("{{> review._verify_result }}"));
    expect(at("{{> review._verify_result }}")).toBeLessThan(at("{{ context.implementation_summary }}"));
    expect(at("{{ context.evidence.items }}")).toBeLessThan(at("{{ context.implementation_summary }}"));
    expect(p.body).toContain("Plausibility is not correctness");
    expect(p.body).toContain("Missing evidence for any criterion is NEEDS_WORK");
    expect(p.body).toContain("Do not offer to fix anything yourself");
  });
});
