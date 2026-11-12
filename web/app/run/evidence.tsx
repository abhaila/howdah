/**
 * HOW-52: the Evidence strip — what the harness SAW of the change, per step, as thumbnails that
 * open into a lightbox with the URL, the capture time and the page's console errors.
 *
 * The screenshots are the reviewer's evidence (prompts/ticket.local_review.md opens each one),
 * so the operator gets the same pixels the reviewer judged, not a description of them. A step
 * whose evidence is `failed` or `not-checked` says so with its reason, because "no screenshots"
 * and "nothing was looked at" must never read the same.
 *
 * HOW-68: the strip is a labelled row of thumbnails, not a box (it sits inside a transcript or
 * a panel, and a card inside either is the nested card DESIGN.md bans). The path under a
 * thumbnail is a `Truncate`, so a long route can be read; the console-error count is a red
 * count WITH its glyph and an accessible name, never a bare coloured pill. The lightbox lists
 * its facts with `KeyValue`, so the URL wraps and can be copied.
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
import { KeyValue } from "@/components/ui/key-value";
import { CodeBlock } from "@/components/ui/markdown";
import { SectionLabel } from "@/components/ui/section-label";
import { Truncate } from "@/components/ui/truncate";
import { fmtWhen } from "@/lib/format";

export const evidenceUrl = (runId: string, file: string) => `/api/runs/${encodeURIComponent(runId)}/file/${file.split("/").map(encodeURIComponent).join("/")}`;

const OUTCOME_WORD: Record<string, string> = { captured: "Captured", failed: "Failed", "not-checked": "Not checked" };

export function EvidenceStrip({ runId, entry }: { runId: string; entry: RunDetail["evidence"][number] }) {
  const [open, setOpen] = useState<EvidenceItem | null>(null);
  const { result } = entry;
  return (
    <div className="ev-strip" data-outcome={result.outcome}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        <Camera size={14} aria-hidden className="shrink-0" />
        <span className="min-w-0 [overflow-wrap:anywhere]">Evidence · <span className="font-mono text-code">{entry.node}@{entry.visit}</span></span>
        <Badge variant={result.outcome === "captured" ? "outline" : "destructive"}>{OUTCOME_WORD[result.outcome] ?? result.outcome}</Badge>
        {result.items.length > 0 && <span className="ml-auto shrink-0 text-xs tabular-nums">{result.items.length} screen{result.items.length === 1 ? "" : "s"}</span>}
      </div>
      {result.reason && <div className="ev-reason text-sm text-muted-foreground [overflow-wrap:anywhere]">{result.reason}</div>}
      {result.items.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {result.items.map((item) => (
            <Button key={item.file} variant="ghost" className="ev-thumb" aria-label={`open the screenshot of ${item.path}`} onClick={() => setOpen(item)}>
              <img src={evidenceUrl(runId, item.file)} alt={`screenshot of ${item.path}`} loading="lazy" />
              <span className="flex min-w-0 items-center gap-1.5">
                <Truncate mono className="ev-thumb-path flex-1 text-left text-xs font-normal text-muted-foreground">{item.path}</Truncate>
                {item.console_errors > 0 && (
                  <span className="ev-thumb-errors" aria-label={`${item.console_errors} console error${item.console_errors === 1 ? "" : "s"}`}>
                    <TriangleAlert aria-hidden />{item.console_errors}
                  </span>
                )}
              </span>
            </Button>
          ))}
        </div>
      )}
      <Dialog open={open !== null} onClose={() => setOpen(null)} title={open ? `Screenshot of ${open.path}` : "Screenshot"} className="w-[min(1100px,92vw)]">
        {open && (
          <>
            <img className="w-full rounded-[var(--radius-xs)] border border-border" src={evidenceUrl(runId, open.file)} alt={`screenshot of ${open.path}`} />
            <KeyValue labelWidth={112} items={[
              { label: "URL", value: open.url, mono: true, copy: true },
              { label: "Captured", value: fmtWhen(open.captured_at) },
              { label: "Console errors", value: String(open.console_errors) },
            ]} />
            {open.console_sample.length > 0 && (
              <>
                <SectionLabel>First console errors</SectionLabel>
                <CodeBlock wrap label="Console errors" className="ev-console">{open.console_sample.join("\n")}</CodeBlock>
              </>
            )}
            {result.console_file && (
              <a className="self-start text-sm text-primary underline underline-offset-2" href={evidenceUrl(runId, result.console_file)} target="_blank" rel="noreferrer">Open the full console log</a>
            )}
          </>
        )}
      </Dialog>
    </div>
  );
}
