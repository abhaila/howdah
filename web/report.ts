/**
 * HOW-78: gathers a run's report model from its log — the half of core/run-report.ts that needs
 * the disk. `GET /api/runs/:id/report` and `howdah report` both come through `buildRunReport`,
 * so the viewer's Report tab and a file handed to a colleague are the same page.
 *
 * Every value here is DERIVED: the change map is the latest `change_map` an agent published,
 * the plan and summaries are context values, the criteria are the acceptance contract with its
 * waivers, the steps are folded from node and operator events. Nothing is cached or written.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import type { LoggedEvent } from "../log/events";
import { readLog } from "../log/write";
import type { Graph } from "../core/graph";
import { deriveDetail, type RunDetail } from "./derive";
import {
  asChangeMap, CHANGE_MAP_KEY, renderRunReport,
  type ReportCriterion, type ReportShot, type ReportStep, type RunReportModel,
} from "../core/run-report";
import type { VerifyResult } from "../core/verify";

/** a screenshot larger than this is linked by path, not embedded — the file must stay mailable */
export const EMBED_MAX_BYTES = 1_500_000;
/** and the page stops embedding once this much is in it */
export const EMBED_TOTAL_BYTES = 8_000_000;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function contextValue(detail: Pick<RunDetail, "context">, key: string): unknown {
  const e = detail.context.find((c) => c.key === key);
  return e && e.written && !e.veiled ? e.value : undefined;
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** "implementation.local_review" → "Local review"; "verify.run" → "Verify" (the verb says nothing) */
export function stepName(node: string): string {
  const parts = node.split(".");
  const last = parts.length > 1 && parts.at(-1) === "run" ? parts[0]! : parts.at(-1) ?? node;
  const words = last.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : node;
}

function fmtMin(ms: number): string | null {
  if (ms < 60_000) return null;
  const m = Math.round(ms / 60_000);
  return m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
}

function firstLine(s: string, n = 180): string {
  const line = s.split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) ?? "";
  return line.length <= n ? line : `${line.slice(0, n - 1)}…`;
}

/** what a finished step published, in one line — the facts, never a model's paraphrase of them */
function writesDetail(writes: Record<string, unknown>): { title?: string; detail?: string } {
  const verify = writes["verify.result"];
  if (isObj(verify) && typeof verify.outcome === "string") return { title: verify.outcome, detail: text(verify.reason) ?? (typeof verify.command === "string" ? verify.command : undefined) };
  if (typeof writes.review_verdict === "string") {
    const f = writes.review_findings;
    const n = Array.isArray(f) ? f.length : null;
    return { title: writes.review_verdict, detail: n === null ? undefined : n === 0 ? "No findings." : `${n} finding${n === 1 ? "" : "s"}.` };
  }
  if (typeof writes["pr.state"] === "string") return { title: writes["pr.state"] };
  const cm = asChangeMap(writes[CHANGE_MAP_KEY]);
  if (cm) return { detail: `${cm.title} — ${cm.components.length} components mapped.` };
  if (Array.isArray(writes.acceptance)) return { title: `${writes.acceptance.length} rows` };
  for (const v of Object.values(writes)) {
    const t = text(v);
    if (t) return { detail: firstLine(t) };
  }
  return {};
}

/**
 * The run's own account of itself, oldest first. The PR poll (probe → wait → probe, while the PR
 * is OPEN) is folded into one row, or a run waiting a day on a reviewer would be 500 rows long.
 */
export function reportSteps(events: readonly LoggedEvent[]): ReportStep[] {
  const out: ReportStep[] = [];
  const started = new Map<string, string>();
  let polling: ReportStep | null = null;
  let polls = 0;
  for (const e of events) {
    if (e.type === "node-started") { started.set(`${e.node}@${e.visit}`, e.ts); continue; }
    if (e.type === "node-finished") {
      const at = started.get(`${e.node}@${e.visit}`) ?? e.ts;
      const dur = fmtMin(new Date(e.ts).getTime() - new Date(at).getTime());
      if (e.node.endsWith(".wait") || e.node === "wait") continue;
      const w = writesDetail(e.writes ?? {});
      if (e.status === "succeeded" && e.writes?.["pr.state"] === "OPEN") {
        if (polling) { polls += 1; polling.detail = `Polled the PR ${polls} times; it is open and waiting.`; continue; }
        polling = { at, title: "Waiting on the PR", detail: "Polled the PR; it is open and waiting.", kind: "step" };
        polls = 1;
        out.push(polling);
        continue;
      }
      polling = null;
      const name = `${stepName(e.node)}${e.visit > 1 ? ` #${e.visit}` : ""}`;
      out.push({
        at,
        title: [name, e.status === "failed" ? "failed" : w.title, dur].filter(Boolean).join(" · "),
        ...(w.detail || e.refused ? { detail: e.refused ?? w.detail } : {}),
        kind: e.status === "failed" ? "failed" : "step",
      });
      continue;
    }
    if (e.type === "operator-jump") {
      polling = null;
      out.push({ at: e.ts, title: `Your jump · ${stepName(e.to)}`, ...(e.message ? { detail: e.message } : {}), kind: "operator" });
    } else if (e.type === "operator-steered") {
      out.push({ at: e.ts, title: `You steered · ${stepName(e.node)}`, detail: e.text, kind: "operator" });
    } else if (e.type === "attention-resolved" && e.source === "operator" && e.reply) {
      polling = null;
      out.push({ at: e.ts, title: `Your reply · ${stepName(e.node)}`, detail: e.reply, kind: "operator" });
    } else if (e.type === "acceptance-waived") {
      out.push({ at: e.ts, title: "You waived a criterion", detail: (e as { reason?: string }).reason, kind: "operator" });
    } else if (e.type === "attention-raised") {
      polling = null;
      out.push({ at: e.ts, title: `Parked · ${stepName(e.node)}`, detail: firstLine(e.reason, 240), kind: "failed" });
    } else if (e.type === "run-finished") {
      out.push({ at: e.ts, title: `Finished · ${e.outcome}`, kind: "finished" });
    }
  }
  return out;
}

function criteria(detail: Pick<RunDetail, "acceptance">): ReportCriterion[] {
  if (!detail.acceptance) return [];
  return detail.acceptance.rows.map((r) => {
    const state: ReportCriterion["state"] = r.superseded ? "superseded" : r.passes ? "pass" : r.waived ? "waived" : "fail";
    const ev = r.evidence;
    const note = r.waived && !r.passes ? `waived: ${r.waived.reason}`
      : ev?.kind === "verify.result" ? `tests${ev.note ? ` — ${ev.note}` : ""}`
      : ev?.kind === "screenshot" ? `screenshot ${ev.file}${ev.note ? ` — ${ev.note}` : ""}`
      : ev?.kind === "command" ? `\`${ev.command}\` → ${firstLine(ev.output, 160)}`
      : r.unprovable && !r.passes ? `cannot be proven by this run: ${r.unprovable}`
      : undefined;
    return { id: r.id, text: r.text, state, ...(note ? { note } : {}) };
  });
}

/** the newest evidence result, its screenshots embedded while they fit */
function screens(runDir: string, detail: Pick<RunDetail, "evidence">): RunReportModel["screens"] {
  const latest = detail.evidence.at(-1);
  if (!latest) return null;
  let budget = EMBED_TOTAL_BYTES;
  let root: string | null = null;
  try { root = realpathSync(join(runDir, "evidence")); } catch { /* no folder: nothing embeds */ }
  const shots: ReportShot[] = latest.result.items.map((item) => {
    let src: string | null = null;
    try {
      const real = realpathSync(join(runDir, item.file));
      // the same containment the evidence route enforces: derive.ts already filtered the paths
      if (root && real.startsWith(root + sep) && real.endsWith(".png")) {
        const size = statSync(real).size;
        if (size <= EMBED_MAX_BYTES && size <= budget) {
          src = `data:image/png;base64,${readFileSync(real).toString("base64")}`;
          budget -= size;
        }
      }
    } catch { /* missing on disk: shown as not embedded */ }
    return { path: item.path, src, console_errors: item.console_errors };
  });
  return { outcome: latest.result.outcome, ...(latest.result.reason ? { reason: latest.result.reason } : {}), shots };
}

export function reportModel(id: string, detail: RunDetail, events: readonly LoggedEvent[], runDir: string, now = new Date()): RunReportModel {
  // `goal` is a run INPUT: it reaches context only once a step writes it, so the run's own
  // inputs are the authority, with context as the fallback for a graph that derives it
  const started = events.find((e) => e.type === "run-started");
  const goal = text(started?.type === "run-started" ? started.inputs.goal : undefined) ?? text(contextValue(detail, "goal"));
  const verify = contextValue(detail, "verify.result") as VerifyResult | undefined;
  const verdict = text(contextValue(detail, "review_verdict"));
  return {
    run_id: id,
    ...(detail.summary.name ? { name: detail.summary.name } : {}),
    graph: detail.summary.graph,
    status: detail.summary.status,
    ...(goal ? { ticket: firstLine(goal, 120) } : {}),
    generated_at: now.toISOString(),
    change: asChangeMap(contextValue(detail, CHANGE_MAP_KEY)),
    ...(text(contextValue(detail, "implementation_plan")) ? { plan: contextValue(detail, "implementation_plan") as string } : {}),
    ...(text(contextValue(detail, "implementation_summary")) ? { implementation_summary: contextValue(detail, "implementation_summary") as string } : {}),
    criteria: criteria(detail),
    tests: isObj(verify) && typeof verify.outcome === "string"
      ? {
        outcome: verify.outcome,
        ...(verify.command ? { command: verify.command } : {}),
        ...(verify.commit !== undefined ? { commit: verify.commit } : {}),
        ...(verify.reason ? { reason: verify.reason } : {}),
        ...(verify.output_tail ? { tail: verify.output_tail } : {}),
      }
      : null,
    screens: existsSync(runDir) ? screens(runDir, detail) : null,
    review: verdict ? { verdict, findings: contextValue(detail, "review_findings") } : null,
    pull_requests: detail.pull_requests.map((p) => ({ url: p.url, state: p.state })),
    steps: reportSteps(events),
    usage: { cost_usd: detail.usage.cost_usd, partial: detail.usage.partial },
  };
}

export function buildRunReport(id: string, detail: RunDetail, events: readonly LoggedEvent[], runDir: string, now = new Date()): string {
  return renderRunReport(reportModel(id, detail, events, runDir, now));
}

/**
 * The report for run `id` under `runsDir`, or null when there is no such run. `graphs` supplies
 * the run's declarations (so a cleared key mid-attempt stays veiled, as in the viewer); a run
 * whose graph is gone still reports from its log.
 */
export function loadRunReport(runsDir: string, id: string, graphs: Record<string, Graph<any>> = {}, now = new Date()): string | null {
  const runDir = join(runsDir, id);
  const path = join(runDir, "run.jsonl");
  if (!existsSync(path)) return null;
  const events = readLog(path);
  const started = events.find((e) => e.type === "run-started");
  const graph = started?.type === "run-started" ? graphs[started.graph] : undefined;
  let declarations = {};
  try { declarations = graph ? graph.declarations() : {}; } catch { /* the report still renders from the log */ }
  const detail = deriveDetail(id, events, declarations, { omitTurns: true, skipLogRows: true });
  return buildRunReport(id, detail, events, runDir, now);
}
