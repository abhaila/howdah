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
 *
 * HOW-68: the frame fills the pane (it had a 480px floor and a strip of 13px links above it),
 * and the page inside wears the viewer's own theme. It is sandboxed without same-origin, so it
 * cannot read this page's setting; the viewer's explicit choice travels as `?theme=`, which the
 * page's own script reads. With no explicit choice nothing is passed and both follow the
 * system, exactly as the standalone file does. Open and Download are real 28px controls.
 */
import { useEffect, useState } from "react";
import { Download, ExternalLink, Network, RefreshCw } from "lucide-react";
import type { RunDetail } from "../../derive";
import { Button, buttonVariants } from "@/components/ui/button";
import { Toolbar } from "@/components/ui/toolbar";
import { useToast } from "@/components/ui/toast";

/** the step that writes the change map the report is drawn around (prompts/implementation.report.md) */
export const REPORT_NODE = "implementation.report";
export const CHANGE_MAP_KEY = "change_map";

export const reportUrl = (runId: string, download = false) => `/api/runs/${encodeURIComponent(runId)}/report${download ? "?download=1" : ""}`;

type Theme = "light" | "dark" | null;
const explicitTheme = (): Theme => {
  const t = typeof document === "undefined" ? undefined : document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : null;
};
/** the viewer's EXPLICIT theme (null = follow the system), kept current as the toggle moves */
function useExplicitTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(explicitTheme);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(() => setTheme(explicitTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

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
      toast(`Sent — ${REPORT_NODE} maps the change, then the run carries on to publish`);
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
  const theme = useExplicitTheme();
  // a new step, a finished step or a new status is a new report; a chunk is not
  const key = `${detail.timeline.length}:${last?.status ?? ""}:${detail.summary.status}:${bump}:${theme ?? ""}`;
  const link = buttonVariants({ variant: "outline", size: "sm" });
  return (
    <div className="report-pane">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-2">
        <span className="min-w-0 flex-1 basis-60 text-xs text-muted-foreground">Derived from the run log each time it opens; nothing is stored. Works the same on every harness.</span>
        <Toolbar label="Report actions">
          {canMapChange(detail) && (
            <Button variant="outline" size="sm" loading={mapping} onClick={mapChange}>
              {!mapping && <Network aria-hidden />}Map this change
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setBump((b) => b + 1)}><RefreshCw aria-hidden />Refresh</Button>
          <a className={link} href={reportUrl(runId)} target="_blank" rel="noreferrer"><ExternalLink aria-hidden />Open</a>
          <a className={link} href={reportUrl(runId, true)} download><Download aria-hidden />Download HTML</a>
        </Toolbar>
      </div>
      {error && <div className="field-error px-4 py-1">{error}</div>}
      <iframe key={key} className="report-frame" aria-label={`Run report for ${runId}`} src={`${reportUrl(runId)}${theme ? `?theme=${theme}` : ""}`} sandbox="allow-scripts" />
    </div>
  );
}
