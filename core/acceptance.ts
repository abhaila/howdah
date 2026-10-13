/**
 * HOW-51: the default-FAIL acceptance contract — every criterion starts failing, and only
 * EVIDENCE can flip one.
 *
 * A finished run used to say what it achieved in prose. HOW-14's run ended `done` with a
 * 156-word summary that included "the full suite was not run", and nothing turned that sentence
 * into a visible unmet criterion. cwc's first primitive goes the other way: each criterion is a
 * row that starts `passes: false`, and a hook refuses to flip it until evidence was opened. Its
 * README is blunt that asking nicely in the prompt does not reliably stop an agent calling a
 * feature done after one curl.
 *
 * Howdah enforces it with the graph and the outputs check, not a hook:
 *
 *   WHO   a node that writes `acceptance` must be `readOnly` (core/graph.ts validate) — the
 *         criteria step and the evaluator. A builder that could flip a criterion could also
 *         change the code it is judged on, and the ContextStore already makes an UNDECLARED
 *         write throw, so a build node can neither declare nor sneak the write.
 *   HOW   every write is checked here before it is accepted (engine/executors/outputs.ts
 *         checkWrites); a bad one gets the outputs-repair turn, naming the problem:
 *           - the FIRST write (the criteria step reads no `acceptance`) must be all-failing,
 *             with no evidence — default-FAIL;
 *           - later writes keep every earlier row (same id, same text): a criterion is never
 *             deleted or reworded, only marked `superseded` and replaced by a new row;
 *           - a row that passes names its evidence, and the evidence must be REAL in this run:
 *             `verify.result` only when the tests passed, a screenshot only when it is one of
 *             the files the evidence step captured, a command only with the output it gave.
 *   GATE  delivery requires every live criterion to pass or to have been WAIVED by a human —
 *         a decision event (`acceptance-waived`), never a flag, so a plain resume never lets a
 *         failing contract through (engine/run.ts requiresGate).
 *
 * A criterion that cannot be checked mechanically ("feels right") has no evidence kind on
 * purpose: it can only pass by waiver, never silently.
 *
 * HOW-59: every row says HOW it will be checked (`check`), decided by the criteria step from
 * what this run can actually produce. It exists because the contract turned into a blocker: a
 * workspace with no verify command and no preview gives the read-only evaluator nothing it may
 * cite, so test- and screen-shaped criteria could never flip, the evaluator rejected for the
 * missing evidence, and the build loop rewrote code that was not wrong. Now:
 *   - `after-publish` rows (PR state, CI, reviewers, merges) are not held at publish — they
 *     cannot be true before it, and the delivery half probes them itself (probe:pr);
 *   - `unprovable()` names the rows this run CANNOT prove (no verify, no screenshots, a human
 *     judgement), so the gate says so in one sentence and one waiver settles them all.
 * `check` is kept like `text`: a later write may not change it. A row without one (a run that
 * pinned the criteria prompt before HOW-59) is gated exactly as before.
 *
 * Node-free: the viewer's Acceptance card reads rows through `asAcceptance`.
 */

import type { LoggedEvent } from "../log/events";

export const ACCEPTANCE_KEY = "acceptance";

export type AcceptanceSource = "ticket" | "plan";

/** HOW-59: how a criterion will be checked — chosen when the contract is opened */
export const ACCEPTANCE_CHECKS = ["tests", "screenshot", "command", "human", "after-publish"] as const;
export type AcceptanceCheck = (typeof ACCEPTANCE_CHECKS)[number];
const isCheck = (v: unknown): v is AcceptanceCheck => typeof v === "string" && (ACCEPTANCE_CHECKS as readonly string[]).includes(v);

export type AcceptanceEvidence =
  /** the workspace's tests passed (verify:run) — `note` says which tests cover the criterion */
  | { kind: "verify.result"; note?: string }
  /** a screenshot the evidence step captured: `file` is its run-dir path, `evidence/…png` */
  | { kind: "screenshot"; file: string; note?: string }
  /** a command the evaluator ran, and the output that convinced it */
  | { kind: "command"; command: string; output: string };

export interface AcceptanceRow {
  id: string;
  text: string;
  /** `ticket`: a checkbox from the ticket; `plan`: proposed when the ticket had none */
  source: AcceptanceSource;
  passes: boolean;
  evidence: AcceptanceEvidence | null;
  /** replaced by a later row after the plan changed; kept, never deleted (the log is append-only) */
  superseded?: boolean;
  /** HOW-59: how it will be checked; absent on rows written before HOW-59 */
  check?: AcceptanceCheck;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The rows a context value holds, or null when it is not an acceptance list at all. */
export function asAcceptance(v: unknown): AcceptanceRow[] | null {
  if (!Array.isArray(v)) return null;
  const rows: AcceptanceRow[] = [];
  for (const r of v) {
    if (!isObj(r) || typeof r.id !== "string" || typeof r.text !== "string" || typeof r.passes !== "boolean") return null;
    rows.push({
      id: r.id,
      text: r.text,
      source: r.source === "ticket" ? "ticket" : "plan",
      passes: r.passes,
      evidence: isObj(r.evidence) ? (r.evidence as unknown as AcceptanceEvidence) : null,
      ...(r.superseded === true ? { superseded: true } : {}),
      ...(isCheck(r.check) ? { check: r.check } : {}),
    });
  }
  return rows;
}

export interface AcceptanceContext {
  /** the value this node read — absent for the step that writes the first list */
  previous?: unknown;
  /** what verify:run published, when the node reads it */
  verify?: unknown;
  /** the screenshot files the evidence step published, when the node reads them */
  evidenceFiles?: readonly string[];
}

function evidenceProblem(row: AcceptanceRow, ctx: AcceptanceContext): string | null {
  const ev = row.evidence;
  const where = `criterion "${row.id}"`;
  if (!ev || !isObj(ev)) return `${where} passes but names no evidence — a criterion flips only on evidence (verify.result, a screenshot, or a command and its output); leave it false otherwise`;
  switch (ev.kind) {
    case "verify.result": {
      const outcome = isObj(ctx.verify) ? ctx.verify.outcome : undefined;
      if (outcome !== "pass")
        return `${where} cites verify.result, but the tests did not pass in this run (outcome: ${outcome ?? "no verify result"}) — that is not evidence it is met`;
      return null;
    }
    case "screenshot": {
      if (typeof ev.file !== "string" || !ev.file) return `${where} cites a screenshot with no file`;
      if (!ctx.evidenceFiles?.includes(ev.file))
        return `${where} cites screenshot "${ev.file}", which is not one the evidence step captured in this run (have: ${ctx.evidenceFiles?.length ? ctx.evidenceFiles.join(", ") : "none"})`;
      return null;
    }
    case "command": {
      if (typeof ev.command !== "string" || !ev.command.trim() || typeof ev.output !== "string" || !ev.output.trim())
        return `${where} cites a command without both the command and the output it gave`;
      return null;
    }
    default:
      return `${where} cites evidence of an unknown kind "${String((ev as { kind?: unknown }).kind)}" — use verify.result, screenshot or command`;
  }
}

/**
 * Why this write of `acceptance` must not be accepted, or null when it may. The outputs check
 * calls it for every write; its message is what the repair turn says back to the agent.
 */
export function acceptanceProblem(value: unknown, ctx: AcceptanceContext = {}): string | null {
  const rows = asAcceptance(value);
  if (!rows) return `"acceptance" must be an array of { id, text, source, passes, evidence } rows`;
  // HOW-59: a `check` that is present must be one we know. Absent is allowed — a run that
  // pinned the criteria prompt before HOW-59 never writes one, and must not be refused for it.
  const badCheck = (value as Array<Record<string, unknown>>).find((r) => r.check !== undefined && !isCheck(r.check));
  if (badCheck) return `criterion "${String(badCheck.id)}" has check "${String(badCheck.check)}" — use one of ${ACCEPTANCE_CHECKS.join(", ")}`;
  const ids = new Set<string>();
  for (const r of rows) {
    if (!r.id.trim()) return "every acceptance criterion needs a non-empty id";
    if (ids.has(r.id)) return `acceptance criterion id "${r.id}" appears twice`;
    ids.add(r.id);
    if (!r.text.trim()) return `acceptance criterion "${r.id}" has no text`;
  }
  const previous = ctx.previous === undefined ? null : asAcceptance(ctx.previous);
  if (previous === null) {
    if (rows.length === 0) return "list at least one acceptance criterion — from the ticket's checkboxes, or proposed from the plan when it has none";
    // default-FAIL: the list that opens the contract cannot already be satisfied
    const early = rows.find((r) => r.passes || r.evidence !== null);
    if (early) return `criterion "${early.id}" starts as passing — every criterion must start with passes: false and evidence: null; only the evaluator flips one, on evidence`;
    return null;
  }
  for (const before of previous) {
    const now = rows.find((r) => r.id === before.id);
    if (!now) return `criterion "${before.id}" was removed — criteria are never deleted; mark it superseded and add its replacement as a new row`;
    if (now.text !== before.text) return `criterion "${before.id}" was reworded — keep its text, mark it superseded, and add the new wording as a new row`;
    if (before.superseded && !now.superseded) return `criterion "${before.id}" was superseded and cannot be revived`;
    if (before.check !== undefined && now.check !== before.check)
      return `criterion "${before.id}" changed its check from "${before.check}" to "${now.check ?? "none"}" — keep it; supersede the row if it must be checked another way`;
  }
  for (const r of rows) {
    if (r.passes && !r.superseded) {
      const p = evidenceProblem(r, ctx);
      if (p) return p;
    }
  }
  return null;
}

/**
 * The live criteria that neither pass nor were waived — what holds delivery. An `after-publish`
 * row never holds it (HOW-59): it cannot be true until publication, which is what it would hold.
 */
export function unmetCriteria(rows: readonly AcceptanceRow[], waived: { has(id: string): boolean }): AcceptanceRow[] {
  return rows.filter((r) => !r.superseded && !r.passes && !waived.has(r.id) && r.check !== "after-publish");
}

/** HOW-59: what this run produced that a criterion could cite — each source's outcome and reason */
export interface EvidenceSources {
  verify?: { outcome: string; reason?: string };
  screenshots?: { outcome: string; reason?: string };
}

function outcomeOf(v: unknown): { outcome: string; reason?: string } | undefined {
  if (!isObj(v) || typeof v.outcome !== "string") return undefined;
  return { outcome: v.outcome, ...(typeof v.reason === "string" ? { reason: v.reason } : {}) };
}

/** HOW-59: the latest verify:run and evidence:screenshot outcomes in the run's log */
export function evidenceSources(events: readonly LoggedEvent[]): EvidenceSources {
  const latest = (key: string) => {
    const e = events.findLast((x) => x.type === "node-finished" && x.status === "succeeded" && key in x.writes);
    return e?.type === "node-finished" ? outcomeOf(e.writes[key]) : undefined;
  };
  const verify = latest("verify.result");
  const screenshots = latest("evidence.items");
  return { ...(verify ? { verify } : {}), ...(screenshots ? { screenshots } : {}) };
}

/**
 * HOW-59: why THIS run cannot prove a row, or null when it could. A test-shaped row needs a
 * verify run that actually ran; a screen-shaped one needs captured screens; a human judgement
 * never has evidence. "Could not" is not "did not": a red suite is a real failure, not this.
 */
export function unprovable(row: AcceptanceRow, sources: EvidenceSources): string | null {
  switch (row.check) {
    case "human":
      return "only a human can judge it";
    case "tests":
      return sources.verify?.outcome === "not-checked"
        ? `it needs the tests, and the tests were never run (${sources.verify.reason ?? "verify: not-checked"})`
        : null;
    case "screenshot":
      return sources.screenshots?.outcome === "not-checked" || sources.screenshots?.outcome === "failed"
        ? `it needs a screenshot, and none was captured (${sources.screenshots.reason ?? `evidence: ${sources.screenshots.outcome}`})`
        : null;
    default:
      return null;
  }
}

/** HOW-51: the criteria an operator waived, by id — from `acceptance-waived` decision events */
export function waivedCriteria(events: readonly LoggedEvent[]): Map<string, { reason: string; at: string }> {
  const out = new Map<string, { reason: string; at: string }>();
  for (const e of events) if (e.type === "acceptance-waived" && !out.has(e.criterion_id)) out.set(e.criterion_id, { reason: e.reason, at: e.ts });
  return out;
}

/** HOW-51: the latest acceptance list in the run, and which node@visit wrote it — or null */
export function latestAcceptance(events: readonly LoggedEvent[]): { rows: AcceptanceRow[]; node: string; visit: number; at: string } | null {
  const e = events.findLast((x) => x.type === "node-finished" && x.status === "succeeded" && ACCEPTANCE_KEY in x.writes);
  if (!e || e.type !== "node-finished") return null;
  const rows = asAcceptance(e.writes[ACCEPTANCE_KEY]);
  return rows ? { rows, node: e.node, visit: e.visit, at: e.ts } : null;
}
