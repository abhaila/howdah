/**
 * HOW-78: the Report tab — the third of the run's homes (Plan → Build → Report).
 *
 * It frames the page `GET /api/runs/:id/report` renders (core/run-report.ts): the change map an
 * agent wrote as data, and the evidence and history the log already holds. The same page is what
 * "Download" saves and `howdah report` prints, so what the operator reads here is exactly what a
 * colleague receives. It is sandboxed with scripts and nothing else: the page needs its one
 * script for the map, and no access to this origin.
 *
 * A run whose graph has the report step but never ran it (one that started before HOW-78's step
 * existed, or that has not passed review yet) offers "Map this change": a jump to that step,
 * after which the run carries on to publish as its graph says. A live runner refuses the jump,
 * and the refusal is shown as the route words it.
 *
 * The frame reloads when the run moves to a new step rather than on every streamed chunk — a
 * report that flickers while the agent types is unreadable — and "Refresh" reloads it at will.
 */
import { useState } from "react";
import { Download, ExternalLink, Loader2, Network, RefreshCw } from "lucide-react";
import type { RunDetail } from "../../derive";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

/** the step that writes the change map the report is drawn around (prompts/implementation.report.md) */
export const REPORT_NODE = "implementation.report";
export const CHANGE_MAP_KEY = "change_map";

export const reportUrl = (runId: string, download = false) => `/api/runs/${encodeURIComponent(runId)}/report${download ? "?download=1" : ""}`;

/**
 * Whether "Map this change" applies: the run's graph declares `change_map` (so it has the step)
 * but no visit has written it — a run that started before the step existed, or one still building.
 */
export function canMapChange(detail: Pick<RunDetail, "context" | "summary">): boolean {
  const entry = detail.context.find((c) => c.key === CHANGE_MAP_KEY);
  return !!entry && !entry.written && detail.summary.outcome === null;
}

export function RunReport({ runId, detail, onChanged = () => {} }: { runId: string; detail: Pick<RunDetail, "timeline" | "summary" | "context">; onChanged?: () => void }) {
  const [bump, setBump] = useState(0);
  const [mapping, setMapping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  // the same jump the CLI takes; a live runner is refused with the route's own words
  const mapChange = async () => {
    setMapping(true);
    setError(null);
    try {
      const r = await fetch(`/api/runs/${runId}/jump`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ node: REPORT_NODE }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? "jump failed");
      toast(`sent — ${REPORT_NODE} maps the change, then the run carries on to publish`);
      setTimeout(onChanged, 300);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setError(why);
      toast(why, "error");
    } finally {
      setMapping(false);
    }
  };
  const last = detail.timeline.at(-1);
  // a new step, a finished step or a new status is a new report; a chunk is not
  const key = `${detail.timeline.length}:${last?.status ?? ""}:${detail.summary.status}:${bump}`;
  return (
    <div className="report-pane">
      <div className="report-bar">
        <span className="report-note">Derived from the run log each time it opens; nothing is stored. Works the same on every harness.</span>
        {canMapChange(detail) && (
          <Button variant="outline" size="sm" disabled={mapping} onClick={mapChange}>
            {mapping ? <Loader2 className="animate-spin" /> : <Network size={12} aria-hidden />}Map this change
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => setBump((b) => b + 1)}><RefreshCw size={12} aria-hidden />Refresh</Button>
        <a className="pr-link report-link" href={reportUrl(runId)} target="_blank" rel="noreferrer"><ExternalLink size={12} aria-hidden />Open</a>
        <a className="pr-link report-link" href={reportUrl(runId, true)} download><Download size={12} aria-hidden />Download HTML</a>
      </div>
      {error && <div className="field-error report-error">{error}</div>}
      <iframe key={key} className="report-frame" aria-label={`run report for ${runId}`} src={reportUrl(runId)} sandbox="allow-scripts" />
    </div>
  );
}
