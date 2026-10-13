/**
 * HOW-51: waiving an acceptance criterion — the ONE implementation behind `howdah waive` and
 * POST /api/runs/:id/acceptance/waive, decided and appended under the log lock exactly like an
 * approval decision (engine/control.ts): the criterion must exist in the run's latest list, be
 * live (not superseded) and unmet; a repeat waiver of the same criterion is idempotent.
 *
 * A waiver is how a criterion that cannot be checked mechanically ("feels right") gets past the
 * delivery gate — by a human saying so, on the record, with a reason. Never silently.
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { EventLog } from "../log/write";
import { latestAcceptance, unmetCriteria, waivedCriteria } from "../core/acceptance";

export { waivedCriteria } from "../core/acceptance";

export type WaiveResult =
  | { ok: true; appended: boolean; remaining: number }
  | { ok: false; message: string };

export function waiveCriterion(runDir: string, criterionId: string, reason: string): WaiveResult {
  const path = join(runDir, "run.jsonl");
  if (!existsSync(path)) return { ok: false, message: `unknown run: ${basename(runDir)}` };
  if (!criterionId.trim()) return { ok: false, message: "name the criterion to waive" };
  if (!reason.trim()) return { ok: false, message: "a waiver needs a reason — it is the record of why this was accepted unchecked" };
  let refusal: string | null = null;
  let remaining = 0;
  let already = false;
  const appended = new EventLog(path).appendIf((events) => {
    const latest = latestAcceptance(events);
    if (!latest) { refusal = "this run has no acceptance criteria to waive"; return null; }
    const row = latest.rows.find((r) => r.id === criterionId);
    if (!row) { refusal = `no criterion "${criterionId}" — have: ${latest.rows.map((r) => r.id).join(", ")}`; return null; }
    if (row.superseded) { refusal = `criterion "${criterionId}" was superseded — waive the row that replaced it`; return null; }
    if (row.passes) { refusal = `criterion "${criterionId}" already passes on evidence — there is nothing to waive`; return null; }
    const waived = waivedCriteria(events);
    if (waived.has(criterionId)) {
      already = true;
      remaining = unmetCriteria(latest.rows, waived).length;
      return null;
    }
    waived.set(criterionId, { reason, at: "" });
    remaining = unmetCriteria(latest.rows, waived).length;
    return { type: "acceptance-waived", criterion_id: criterionId, reason: reason.trim(), by: "operator" };
  });
  if (refusal) return { ok: false, message: refusal };
  return { ok: true, appended: !already && appended !== null, remaining };
}
