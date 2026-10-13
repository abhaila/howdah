/**
 * HOW-52: the Evidence strip — what the harness SAW of the change, per step, as thumbnails that
 * open into a lightbox with the URL, the capture time and the page's console errors.
 *
 * The screenshots are the reviewer's evidence (prompts/ticket.local_review.md opens each one),
 * so the operator gets the same pixels the reviewer judged, not a description of them. A step
 * whose evidence is `failed` or `not-checked` says so with its reason, because "no screenshots"
 * and "nothing was looked at" must never read the same.
 *
 * Files are served by the guarded `/api/runs/:id/file/evidence/…` route; the paths come from
 * derive.ts, which has already dropped any that are not under the run's evidence folder.
 */
import { useState } from "react";
import { Camera, TriangleAlert } from "lucide-react";
import type { RunDetail } from "../../derive";
import type { EvidenceItem } from "../../../core/evidence";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

export const evidenceUrl = (runId: string, file: string) => `/api/runs/${encodeURIComponent(runId)}/file/${file.split("/").map(encodeURIComponent).join("/")}`;

export function EvidenceStrip({ runId, entry }: { runId: string; entry: RunDetail["evidence"][number] }) {
  const [open, setOpen] = useState<EvidenceItem | null>(null);
  const { result } = entry;
  return (
    <div className="ev-strip" data-outcome={result.outcome}>
      <div className="ev-head">
        <Camera size={12} aria-hidden />
        <span>Evidence · {entry.node}@{entry.visit}</span>
        <Badge variant={result.outcome === "captured" ? "outline" : "destructive"}>{result.outcome}</Badge>
        {result.items.length > 0 && <span className="ev-count">{result.items.length} screen{result.items.length === 1 ? "" : "s"}</span>}
      </div>
      {result.reason && <div className="ev-reason">{result.reason}</div>}
      {result.items.length > 0 && (
        <div className="ev-thumbs">
          {result.items.map((item) => (
            <Button key={item.file} variant="ghost" className="ev-thumb" aria-label={`open the screenshot of ${item.path}`} onClick={() => setOpen(item)}>
              <img src={evidenceUrl(runId, item.file)} alt={`screenshot of ${item.path}`} loading="lazy" />
              <span className="ev-thumb-path">{item.path}</span>
              {item.console_errors > 0 && (
                <span className="ev-thumb-errors"><TriangleAlert size={11} aria-hidden />{item.console_errors}</span>
              )}
            </Button>
          ))}
        </div>
      )}
      <Dialog open={open !== null} onClose={() => setOpen(null)} title={open ? `Screenshot of ${open.path}` : "Screenshot"} className="ev-lightbox">
        {open && (
          <div className="ev-lightbox-body">
            <img src={evidenceUrl(runId, open.file)} alt={`screenshot of ${open.path}`} />
            <div className="kv"><span className="k">url</span><span className="m">{open.url}</span></div>
            <div className="kv"><span className="k">captured</span><span>{new Date(open.captured_at).toLocaleString()}</span></div>
            <div className="kv"><span className="k">console errors</span><span>{open.console_errors}</span></div>
            {open.console_sample.length > 0 && (
              <pre className="ev-console">{open.console_sample.join("\n")}</pre>
            )}
            {result.console_file && (
              <a className="pr-link" href={evidenceUrl(runId, result.console_file)} target="_blank" rel="noreferrer">the full console log</a>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}
