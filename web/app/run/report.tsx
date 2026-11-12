/**
 * HOW-78: the Report tab — the third of the run's homes (Plan → Build → Report).
 *
 * It frames the page `GET /api/runs/:id/report` renders (core/run-report.ts): the change map an
 * agent wrote as data, and the evidence and history the log already holds. The same page is what
 * "Download" saves and `howdah report` prints, so what the operator reads here is exactly what a
 * colleague receives. It is sandboxed: scripts for its map, a new tab for its links
 * (`REPORT_SANDBOX`), and no access to this origin.
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
 *
 * KEYS INSIDE THE FRAME (the confirming review). A sandboxed frame keeps every keystroke typed
 * while focus is in it, so `Esc`, `F` and `1`–`7` did nothing once you had clicked the report.
 * The page hands exactly those keys back (`REPORT_RELAY_KEYS`, core/run-report.ts) with
 * `postMessage`, and this pane replays one as a keydown on the document — accepted only from
 * ITS frame's window and only from that list, so a report cannot type anything else into the
 * viewer. What is NOT relayed, and stays the limitation the strip states: every other shortcut
 * (`⌘K`, `G` then a letter, `⌘I`, `.`). Tab leaves the frame for the controls around it.
 */
import { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, Network, RefreshCw } from "lucide-react";
import type { RunDetail } from "../../derive";
import { Button, buttonVariants } from "@/components/ui/button";
import { Toolbar } from "@/components/ui/toolbar";
import { useToast } from "@/components/ui/toast";
import { Kbd } from "@/components/ui/kbd";

/** the step that writes the change map the report is drawn around (prompts/implementation.report.md) */
export const REPORT_NODE = "implementation.report";
export const CHANGE_MAP_KEY = "change_map";

/**
 * What the framed page may do. Scripts, for its map; and OPEN A LINK IN A NEW TAB that is an
 * ordinary page (HOW-68 feedback: the report's PR link "tries to open it within howdah" — with
 * `allow-scripts` alone a `target="_blank"` link is blocked outright and a plain one loads the
 * forge inside the frame, which the forge refuses). `allow-popups` permits the new tab;
 * `allow-popups-to-escape-sandbox` is what makes that tab a normal one — without it GitHub would
 * open sandboxed, with no scripts and no session. Still NO same-origin, forms, top-navigation or
 * downloads: the page cannot read this origin or move this window.
 */
export const REPORT_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";

/** the keys the framed page hands back — core/run-report.ts REPORT_RELAY_KEYS, repeated so the
 *  browser bundle does not carry the whole report renderer for one list (plan.test.tsx pins them equal) */
export const RELAYED_KEYS: readonly string[] = ["Escape", "f", "?", "1", "2", "3", "4", "5", "6", "7"];

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
  const frame = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // only OUR frame, and only a key on the list: the page inside is derived from agent data
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const key = (e.data as { howdahKey?: unknown } | null)?.howdahKey;
      if (typeof key !== "string" || !RELAYED_KEYS.includes(key)) return;
      // the app must not think a field has focus: the frame gives focus back first
      frame.current.blur();
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  const last = detail.timeline.at(-1);
  const theme = useExplicitTheme();
  // a new step, a finished step or a new status is a new report; a chunk is not
  const key = `${detail.timeline.length}:${last?.status ?? ""}:${detail.summary.status}:${bump}:${theme ?? ""}`;
  const link = buttonVariants({ variant: "outline", size: "sm" });
  return (
    <div className="report-pane">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-2">
        <span className="min-w-0 flex-1 basis-60 text-xs text-muted-foreground">
          Derived from the run log each time it opens; nothing is stored. Inside the report, <Kbd keys="esc" />, <Kbd keys="f" /> and the tab numbers still work; for any other shortcut press <Kbd keys="tab" /> to leave it first.
        </span>
        <Toolbar label="Report actions">
          {canMapChange(detail) && (
            <Button variant="outline" size="sm" loading={mapping} onClick={mapChange}>
              {!mapping && <Network aria-hidden />}Map this change
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setBump((b) => b + 1)}><RefreshCw aria-hidden />Refresh</Button>
          <a className={link} href={reportUrl(runId)} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden />Open</a>
          <a className={link} href={reportUrl(runId, true)} download><Download aria-hidden />Download HTML</a>
        </Toolbar>
      </div>
      {error && <div className="field-error px-4 py-1">{error}</div>}
      <iframe ref={frame} key={key} className="report-frame" aria-label={`Run report for ${runId}`} src={`${reportUrl(runId)}${theme ? `?theme=${theme}` : ""}`} sandbox={REPORT_SANDBOX} />
    </div>
  );
}
