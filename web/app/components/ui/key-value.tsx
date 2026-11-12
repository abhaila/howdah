/**
 * KeyValue — a label/value list (HOW-68).
 *
 * The run's Details pane, the Steps panel's `.kv` rows and Settings' workspace rows are all
 * the same shape, built three ways, and each got a different part wrong: values in a
 * right-aligned mono column that cut paths with an ellipsis nobody could read, labels in mono
 * (DESIGN.md: "a label is never mono"), and in Settings a path that ran out of its card and
 * under the remove button. A value here is the thing the operator came for, and it is usually
 * a path, a branch or an id — long, unbreakable, and wanted WHOLE. So:
 *
 *   The value WRAPS (`overflow-wrap: anywhere`), it is never cut. This is rule 5's first
 *   clause — "wrap where there is room" — and a details list always has room downward.
 *   Labels are sans in `--fg-muted`; `mono` is per row, for the values you would paste.
 *   `copy` adds the button that pasting needs. It is a real 24px control with a name that
 *   says what it copies, and it confirms in place (the icon and the name change) rather than
 *   only in a toast that a screen-reader user may already have missed.
 *
 * It is a real `<dl>`: a list of terms and their values is exactly what the element is for,
 * and assistive tech reads "Branch, howdah/implement-ticket-…" as a pair. Two columns on a
 * grid — a label column sized by `labelWidth`, the value taking the rest with `minmax(0,1fr)`
 * so a long value cannot widen the list.
 */
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Tooltip } from "./tooltip";

export interface KeyValueItem {
  label: string;
  /** null/undefined/"" renders `empty` instead, so an unknown is never a blank cell */
  value: React.ReactNode;
  /** machine text: an id, a path, a branch, a command */
  mono?: boolean;
  /** `true` copies a string `value`; a string copies that instead (when the value is a node) */
  copy?: boolean | string;
}

function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  const name = copied ? `Copied ${label}` : `Copy ${label}`;
  return (
    <Tooltip content={name} side="left" align="center">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={name}
        onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => setCopied(false)); }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </Tooltip>
  );
}

export function KeyValue({ items, labelWidth = 88, empty = "—", className }: {
  items: readonly KeyValueItem[];
  /** px for the label column; the value gets the rest */
  labelWidth?: number;
  /** what an absent value prints */
  empty?: string;
  className?: string;
}) {
  return (
    <dl
      data-slot="key-value"
      className={cn("m-0 grid items-start gap-x-3 gap-y-1 text-sm leading-[1.4]", className)}
      style={{ gridTemplateColumns: `${labelWidth}px minmax(0, 1fr)` }}
    >
      {items.map((it) => {
        const blank = it.value === null || it.value === undefined || it.value === "";
        const copyText = typeof it.copy === "string" ? it.copy : it.copy === true && typeof it.value === "string" ? it.value : null;
        return (
          <div key={it.label} className="contents">
            <dt className="py-0.5 text-muted-foreground">{it.label}</dt>
            <dd className="m-0 flex min-w-0 items-start gap-1">
              <span className={cn("min-w-0 flex-1 py-0.5 [overflow-wrap:anywhere]", it.mono && !blank && "font-mono text-code", blank && "text-faint")}>
                {blank ? empty : it.value}
              </span>
              {copyText !== null && !blank && <CopyButton label={it.label.toLowerCase()} text={copyText} />}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
