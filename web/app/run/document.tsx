/**
 * What a step published, drawn as documents (HOW-29).
 *
 * An agent step ends its turn with `{"outputs": {...}}` (the T16 contract). For a step that
 * publishes a verdict that is one short line; for `implementation.plan` it is the whole plan —
 * thousands of words of markdown JSON-escaped onto ONE line, which the Activity pane printed
 * verbatim underneath the agent's summary. The plan is the thing the operator most needs to
 * read before the implement step runs, and it was the least readable text on the screen.
 *
 * So the outputs object is taken out of the prose (`core/outputs.ts` splitOutputs, the same
 * scan the engine publishes from) and each value is drawn by what it is:
 *   - a short string is a value, shown inline beside its key;
 *   - a long string is a DOCUMENT: rendered markdown, clamped to a preview, expandable in place,
 *     and openable in a full-width reader for the "sit down and read the plan" case;
 *   - anything else is data, pretty-printed.
 *
 * The same card serves the Output pane and the Context detail, so a plan reads the same
 * wherever it is found.
 */
import { useState } from "react";
import { FileText, Maximize2, Copy, Check, ChevronDown, ChevronUp } from "lucide-react";
import { Markdown } from "@/components/ui/markdown";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { RunDetail } from "../../derive";
import { splitOutputs } from "../../../core/outputs";

/** a string at or under this, on one line, is a value rather than a document */
const SHORT = 160;

export function isDocument(v: unknown): v is string {
  return typeof v === "string" && (v.length > SHORT || v.includes("\n"));
}

function words(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/**
 * What one step visit published. The agent's own contract object is the exact record of that
 * visit, so it is read first — the context table holds only each key's CURRENT value, which a
 * later visit may have replaced. A step that speaks no contract (a command, a worktree) falls
 * back to the keys whose latest write is still this visit's.
 */
export function stepOutputs(detail: Pick<RunDetail, "turns" | "context">, node: string, visit: number): Record<string, unknown> | null {
  const texts = detail.turns
    .filter((t) => t.node === node && t.visit === visit)
    .flatMap((t) => t.parts.filter((p) => p.kind === "text").map((p) => p.content));
  for (const text of texts.reverse()) {
    const { outputs } = splitOutputs(text);
    if (outputs) return outputs;
  }
  const mine = detail.context.filter((c) => {
    const last = c.writes.at(-1);
    return c.written && !c.veiled && last?.node === node && last.visit === visit;
  });
  return mine.length ? Object.fromEntries(mine.map((c) => [c.key, c.value])) : null;
}

export function OutputDocs({ outputs }: { outputs: Record<string, unknown> }) {
  const keys = Object.keys(outputs);
  if (keys.length === 0) return null;
  return (
    <div className="out-docs" aria-label="outputs">
      {keys.map((k) => <OutputValue key={k} name={k} value={outputs[k]} />)}
    </div>
  );
}

export function OutputValue({ name, value }: { name: string; value: unknown }) {
  if (isDocument(value)) return <OutputDoc name={name} text={value} />;
  return (
    <div className="out-value">
      <span className="m out-doc-name">{name}</span>
      {typeof value === "string"
        ? <span className="out-value-v">{value || "—"}</span>
        : <pre className="act-pre">{JSON.stringify(value, null, 2)}</pre>}
    </div>
  );
}

export function OutputDoc({ name, text }: { name: string; text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [reading, setReading] = useState(false);
  return (
    <div className="out-doc" data-expanded={expanded ? "open" : "closed"}>
      <div className="out-doc-head">
        <FileText size={13} aria-hidden />
        <span className="m out-doc-name">{name}</span>
        <span className="out-doc-meta">{words(text).toLocaleString()} words</span>
        <span className="out-doc-actions">
          <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
            {expanded ? "Collapse" : "Expand"}
          </Button>
          <Button variant="outline" size="sm" aria-label={`read ${name}`} onClick={() => setReading(true)}>
            <Maximize2 size={12} aria-hidden />
            Read
          </Button>
        </span>
      </div>
      <Markdown className="out-doc-body" text={text} />
      <DocReader open={reading} onClose={() => setReading(false)} name={name} text={text} />
    </div>
  );
}

/** the full-width reader: the document and nothing else, Esc or a backdrop click to leave */
export function DocReader({ open, onClose, name, text }: { open: boolean; onClose: () => void; name: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    // clipboard is absent outside a secure context; the reader still works, it just cannot copy
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => {});
  };
  return (
    <Dialog open={open} onClose={onClose} title={name} className="w-[min(94vw,880px)]">
      <Markdown className="doc-reader" text={text} />
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
          {copied ? "Copied" : "Copy markdown"}
        </Button>
        <Button size="sm" autoFocus onClick={onClose}>Close</Button>
      </div>
    </Dialog>
  );
}
