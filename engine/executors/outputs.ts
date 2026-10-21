/**
 * The outputs contract between an agent turn and the typed context (T16).
 *
 * Prompts stay prose; a contract is appended so the agent's LAST line is a
 * machine-readable JSON object carrying exactly the node's declared writes. Orbital does
 * the same job with `outputs="name:type"` DOT attributes; here the graph declaration is
 * the source and the instruction is generated from it.
 *
 * system-map 0.1: the contract's WORDING now lives in core/template.ts (versioned, applied
 * by the engine before hashing, so rendered_hash covers it). This file keeps the parsing
 * side; the builder is re-exported for existing callers.
 */
export { buildOutputInstruction } from "../../core/template";
import { locateOutputs } from "../../core/outputs";
import { ACCEPTANCE_KEY, acceptanceProblem } from "../../core/acceptance";
import { asEvidenceResult, EVIDENCE_KEY } from "../../core/evidence";
import { VERIFY_RESULT_KEY } from "../../core/verify";
import { asGraphsCatalog, GRAPH_DRAFT_KEY, GRAPHS_CATALOG_KEY } from "../../core/catalog";
import { checkGraphDraft, type MaterialiseBodies } from "../../core/graph-spec";

/**
 * Asked as a follow-up turn when the final message arrived without the contract. Observed
 * on long tool-heavy turns (codex, delivery.review_repairs: 3 of 6 attempts ended in prose
 * after 40+ tool calls). The thread still holds all the work, so this costs one short turn
 * instead of re-running the node.
 */
export function buildRepairInstruction(keys: string[], refused?: string): string {
  // HOW-51: the object arrived but a value broke a rule — say WHICH, so the fix is one turn
  if (refused !== undefined)
    return (
      `Your outputs object was refused, so this step cannot complete: ${refused}\n` +
      `Fix that value and reply with ONLY the corrected JSON object and nothing else:\n` +
      `{"outputs": {${keys.map((k) => `"${k}": <value>`).join(", ")}}}\n` +
      `containing exactly these keys: ${keys.join(", ")}.`
    );
  return (
    `Your previous message did not end with the required outputs object, so this step cannot complete.\n` +
    `Do not redo any work and do not use any tools — the analysis you just finished is what I need recorded.\n` +
    `Reply with ONLY this JSON object and nothing else:\n` +
    `{"outputs": {${keys.map((k) => `"${k}": <value>`).join(", ")}}}\n` +
    `containing exactly these keys: ${keys.join(", ")}.`
  );
}

export interface ParsedOutputs {
  ok: boolean;
  writes: Record<string, unknown>;
  problem?: string;
  /** HOW-51: the object parsed, but `check` refused a value — `problem` says why */
  refused?: true;
}

/** What the outputs check may need beyond the turn's writes and reads — injected by the CLI. */
export interface CheckDeps {
  /** HOW-56 T5: copies → the text Save would write (graphs/builder.ts materialiseBodies) */
  materialise?: MaterialiseBodies;
}

/**
 * HOW-51: the rules a write must satisfy beyond "the key is present". `acceptance`
 * (core/acceptance.ts) — the first list is all-failing, earlier rows survive, and a flip names
 * evidence that is real in this run, judged against what the node READ (its previous list, the
 * verify result, the captured screenshots). HOW-56 T5: `graph.draft` — see graphDraftProblem.
 * Null when every value may be accepted.
 */
export function checkWrites(writes: Record<string, unknown>, reads: Record<string, unknown>, deps: CheckDeps = {}): string | null {
  const stacked = stackedPublicationProblem(writes, reads);
  if (stacked) return stacked;
  if (GRAPH_DRAFT_KEY in writes) return graphDraftProblem(writes[GRAPH_DRAFT_KEY], reads, deps);
  if (ACCEPTANCE_KEY in writes) {
    const evidence = asEvidenceResult(reads[EVIDENCE_KEY]);
    return acceptanceProblem(writes[ACCEPTANCE_KEY], {
      ...(ACCEPTANCE_KEY in reads ? { previous: reads[ACCEPTANCE_KEY] } : {}),
      verify: reads[VERIFY_RESULT_KEY],
      evidenceFiles: evidence?.items.map((i) => i.file) ?? [],
    });
  }
  return null;
}

/**
 * HOW-56 T5 (decisions 1A, E): a drafted graph is published only if it would SAVE — the same
 * specProblems/draftRuleProblems/nameTakenProblem verdict the builder runs, over the catalog the
 * step was given (core/graph-spec.ts checkGraphDraft). Every blocking problem is one line, so the
 * repair turn and, on a second refusal, the park quote each sentence word for word.
 *
 * Fails CLOSED: a step that did not read `graphs.catalog` (or read something that is not one)
 * cannot be told which names are taken or which prompts may be copied, and an installation that
 * did not wire the prompt reader cannot judge a copy — neither is a reason to publish unchecked.
 */
export function graphDraftProblem(draft: unknown, reads: Record<string, unknown>, deps: CheckDeps): string | null {
  const catalog = GRAPHS_CATALOG_KEY in reads ? asGraphsCatalog(reads[GRAPHS_CATALOG_KEY]) : null;
  if (!catalog) return `catalog not available to this step — a ${GRAPH_DRAFT_KEY} is checked against \`${GRAPHS_CATALOG_KEY}\`, which the step must read`;
  if (!deps.materialise) return `this installation cannot read prompt bodies to check a ${GRAPH_DRAFT_KEY} — it did not wire one`;
  const problems = checkGraphDraft(draft, catalog, deps.materialise);
  return problems.length ? `the draft cannot be saved:\n${problems.map((p) => `- ${p}`).join("\n")}` : null;
}

/**
 * HOW-57 (G2): a STACKED publish — one that read `deps.base` — must name its own PRs as an
 * object, and none of the dependency PRs it was told about (`deps.prs`). A prose summary, or one
 * that lists the base's PR, would have probe:pr watch the wrong PR and finish when the BASE
 * merged. Not a stacked publish (no `deps.base` read): no rule.
 */
export function stackedPublicationProblem(writes: Record<string, unknown>, reads: Record<string, unknown>): string | null {
  if (!("publication_summary" in writes) || !("deps.base" in reads)) return null;
  const summary = writes.publication_summary;
  const isPr = (v: unknown): v is string => typeof v === "string" && v.includes("/pull/");
  if (typeof summary !== "object" || summary === null || Array.isArray(summary))
    return `publication_summary must be an object for a stacked change — { "pr_urls": [<this run's PR URLs>], "primary_pr_url": <its tip> } — not ${typeof summary === "string" ? "prose" : JSON.stringify(summary)}`;
  const o = summary as Record<string, unknown>;
  const own = [...(Array.isArray(o.pr_urls) ? o.pr_urls.filter(isPr) : []), ...(isPr(o.primary_pr_url) ? [o.primary_pr_url] : [])];
  if (own.length === 0) return `publication_summary names no PR of this run — list them in "pr_urls" and name the tip as "primary_pr_url"`;
  const foreign = new Set(Array.isArray(reads["deps.prs"]) ? (reads["deps.prs"] as unknown[]).filter(isPr) : []);
  const borrowed = own.filter((u) => foreign.has(u));
  if (borrowed.length)
    return `publication_summary lists ${borrowed.join(", ")}, which belong${borrowed.length === 1 ? "s" : ""} to a slice this one depends on — list only this run's own PRs`;
  return null;
}

/**
 * Find the LAST {"outputs": ...} object in the text; tolerate fences and surrounding prose.
 * The scan itself is `core/outputs.ts` locateOutputs, shared with the viewer (HOW-29).
 */
export function parseOutputs(text: string, expectedKeys: string[], check?: (writes: Record<string, unknown>) => string | null): ParsedOutputs {
  if (expectedKeys.length === 0) return { ok: true, writes: {} };
  const span = locateOutputs(text);
  if (!span)
    return { ok: false, writes: {}, problem: `no {"outputs": ...} object found in the final message` };
  const { start, end } = span;
  if (end === null) return { ok: false, writes: {}, problem: "unterminated outputs object" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end));
  } catch {
    return { ok: false, writes: {}, problem: "outputs object is not valid JSON" };
  }
  const outputs = (parsed as { outputs?: Record<string, unknown> }).outputs;
  if (!outputs || typeof outputs !== "object") return { ok: false, writes: {}, problem: "outputs key missing" };

  const missing = expectedKeys.filter((k) => !(k in outputs));
  if (missing.length) return { ok: false, writes: {}, problem: `outputs missing keys: ${missing.join(", ")}` };
  const writes: Record<string, unknown> = {};
  for (const k of expectedKeys) writes[k] = outputs[k];
  const refused = check?.(writes) ?? null;
  if (refused !== null) return { ok: false, writes: {}, problem: refused, refused: true };
  return { ok: true, writes };
}
