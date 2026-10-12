/**
 * HOW-53 — the skeptical-evaluator rewrite is a PROPOSAL, not an edit: it stays `pending` until
 * the A/B harness (HOW-42) measures it against v2 on planted-defect cases. What can be checked
 * now is that it is acceptable at all — current base, no undeclared reads — and that it says what
 * the ticket asked: ticket and criteria first, the builder's summary last and as a claim, missing
 * evidence is NEEDS_WORK, and the evaluator never offers to fix anything.
 */
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProposal } from "../prompts/proposals";
import { PromptStore } from "../prompts/store";
import { GRAPHS } from "../graphs/index";

const ROOT = join(import.meta.dir, "..");
const PATH = join(ROOT, "reviser", "proposals", "ticket.local_review.v3.proposal.md");

describe("ticket.local_review v3 (the skeptical evaluator)", () => {
  const p = loadProposal(PATH);

  test("is pending against the current version — not accepted on assumption", () => {
    expect(p.status).toBe("pending");
    expect(p.base_version).toBe(2);
    expect(new PromptStore(join(ROOT, "prompts")).load("ticket.local_review").version).toBe(2);
  });

  test("would pass every accept guard (checked on a COPY of the prompts dir, never the repo)", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-proposal-dry-"));
    cpSync(join(ROOT, "prompts"), dir, { recursive: true });
    expect(new PromptStore(dir).accept(p, [GRAPHS["implement-ticket"]!])).toBe(3);
    expect(readFileSync(join(ROOT, "prompts", "ticket.local_review.md"), "utf8")).toContain("version: 2");
  });

  test("reads in cwc's order: ticket + contract, diff, evidence, and the summary LAST as a claim", () => {
    const at = (s: string) => p.body.indexOf(s);
    expect(at("{{ context.acceptance }}")).toBeLessThan(at("## 2. What changed"));
    expect(at("## 2. What changed")).toBeLessThan(at("{{ context.verify.result }}"));
    expect(at("{{ context.evidence.items }}")).toBeLessThan(at("{{ context.implementation_summary }}"));
    expect(p.body).toContain("Plausibility is not correctness");
    expect(p.body).toContain("Missing evidence for any criterion is NEEDS_WORK");
    expect(p.body).toContain("Do not offer to fix anything yourself");
  });
});
