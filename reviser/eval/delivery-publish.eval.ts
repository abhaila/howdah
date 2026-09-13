#!/usr/bin/env bun
/**
 * T1 — the ground-truth eval, and the plan's designated escape hatch.
 *
 * Question it answers: given the STOCK delivery.publish prompt and the real feedback note,
 * does the reviser propose a revision close to the edit Areeb actually made by hand
 * (the implement-ticket-areeb fork)?
 *
 * Scoring: deterministic checklist in two halves —
 *   FEEDBACK CAPTURED — does the proposal encode each element the hand edit added?
 *   NOTHING LOST      — does the proposal preserve the stock prompt's constraints?
 * The human diff-read remains the final gate (shaping R2); this prints the evidence.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE, "..", "..");

// 1. Run the reviser (skippable with --score-only to re-score an existing proposal).
if (!process.argv.includes("--score-only")) {
  const run = spawnSync("bun", [join(ROOT, "reviser", "revise.ts"), "delivery.publish"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 300_000,
  });
  if (run.status !== 0) {
    console.error("reviser failed:\n" + (run.stderr || run.stdout));
    process.exit(1);
  }
  console.log(run.stdout);
}

const proposal = readFileSync(join(ROOT, "reviser", "proposals", "delivery.publish.v2.proposal.md"), "utf8");
const groundTruth = readFileSync(join(HERE, "ground-truth.md"), "utf8");
const stock = readFileSync(join(ROOT, "prompts", "delivery.publish.md"), "utf8");

type Check = { name: string; pass: boolean };
const has = (t: string, re: RegExp) => re.test(t);

// FEEDBACK CAPTURED — the elements the hand edit added (from the real fork diff).
const captured: Check[] = [
  { name: "'Why' section with business context", pass: has(proposal, /why/i) && has(proposal, /business context/i) },
  { name: "Linear named as the context source", pass: has(proposal, /linear/i) },
  { name: "'What' section as bullets", pass: has(proposal, /what/i) && has(proposal, /bullet/i) },
  { name: "simple english, no code references", pass: has(proposal, /simple english/i) && has(proposal, /(do not|don't|no|never|without)[^.]{0,60}(referenc\w*|quot\w*)[^.]{0,60}code|code (references|quotes|snippets)/i) },
  { name: "'Notes for testing / reviewing' section", pass: has(proposal, /notes for testing/i) || (has(proposal, /testing/i) && has(proposal, /reviewing/i)) },
];

// NOTHING LOST — stock constraints that must survive (verbatim anchors from the stock prompt).
const preserved: Check[] = [
  { name: "auto-merge instruction", pass: has(proposal, /auto-merge/i) },
  { name: "required checks / merge-queue respect", pass: has(proposal, /required checks/i) },
  { name: "returns publication_summary", pass: has(proposal, /publication_summary/) },
  { name: "avoid duplicate PRs", pass: has(proposal, /duplicate PRs?/i) },
  { name: "already-merged → new PR rule", pass: has(proposal, /already merged/i) },
  { name: "leaves tracker records unchanged", pass: has(proposal, /tracker records? unchanged/i) },
  { name: "templating untouched ({{ inputs.goal }})", pass: has(proposal, /\{\{\s*inputs\.goal\s*\}\}/) },
];

// GROUND-TRUTH PROXIMITY — the hand edit's distinctive phrases, found in the proposal?
const gtSections: Array<[string, RegExp]> = [
  ["Why section heading", /(^|\n)\s*(#+\s*)?[-`#* ]*why\b\s*[:—-]?/im],
  ["What section heading", /(^|\n)\s*(#+\s*)?[-`#* ]*what\b\s*[:—-]?/im],
  ["Notes for testing heading", /notes for testing/i],
];
const proximity: Check[] = gtSections.map(([name, re]) => ({
  name: `ground-truth section present: ${name}`,
  pass: re.test(proposal),
}));

function report(title: string, checks: Check[]): number {
  const passed = checks.filter((c) => c.pass).length;
  console.log(`\n${title}: ${passed}/${checks.length}`);
  for (const c of checks) console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  return passed;
}

const a = report("FEEDBACK CAPTURED", captured);
const b = report("NOTHING LOST", preserved);
const c = report("GROUND-TRUTH PROXIMITY", proximity);

const total = a + b + c;
const max = captured.length + preserved.length + proximity.length;
console.log(`\nSCORE: ${total}/${max}`);
console.log(
  total === max
    ? "VERDICT: proposal matches the hand edit's intent with nothing lost — read the diff and judge."
    : total >= max - 2
      ? "VERDICT: close — read the FAILs and the diff; likely accept-with-tweaks."
      : "VERDICT: reviser is not reproducing the hand edit — the escape hatch question is live.",
);
process.exit(total >= max - 2 ? 0 : 1);
