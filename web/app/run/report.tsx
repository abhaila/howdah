/**
 * HOW-78: the Report tab — the third of the run's homes (Plan → Build → Report).
 *
 * It frames the page `GET /api/runs/:id/report` renders (core/run-report.ts): the change map an
 * agent wrote as data, and the evidence and history the log already holds. The same page is what
 * "Download" saves and `howdah report` prints, so what the operator reads here is exactly what a
 * colleague receives. It is sandboxed with scripts and nothing else: the page needs its one
 * script for the map, and no access to this origin.
 *
 * The frame reloads when the run moves to a new step rather than on every streamed chunk — a
 * report that flickers while the agent types is unreadable — and "Refresh" reloads it at will.
 */
import { useState } from "react";
import { Download, ExternalLink, RefreshCw } from "lucide-react";
import type { RunDetail } from "../../derive";
import { Button } from "@/components/ui/button";

export const reportUrl = (runId: string, download = false) => `/api/runs/${encodeURIComponent(runId)}/report${download ? "?download=1" : ""}`;

export function RunReport({ runId, detail }: { runId: string; detail: Pick<RunDetail, "timeline" | "summary"> }) {
  const [bump, setBump] = useState(0);
  const last = detail.timeline.at(-1);
  // a new step, a finished step or a new status is a new report; a chunk is not
  const key = `${detail.timeline.length}:${last?.status ?? ""}:${detail.summary.status}:${bump}`;
  return (
    <div className="report-pane">
      <div className="report-bar">
        <span className="report-note">Derived from the run log each time it opens; nothing is stored. Works the same on every harness.</span>
        <Button variant="ghost" size="sm" onClick={() => setBump((b) => b + 1)}><RefreshCw size={12} aria-hidden />Refresh</Button>
        <a className="pr-link report-link" href={reportUrl(runId)} target="_blank" rel="noreferrer"><ExternalLink size={12} aria-hidden />Open</a>
        <a className="pr-link report-link" href={reportUrl(runId, true)} download><Download size={12} aria-hidden />Download HTML</a>
      </div>
      <iframe key={key} className="report-frame" aria-label={`run report for ${runId}`} src={reportUrl(runId)} sandbox="allow-scripts" />
    </div>
  );
}
