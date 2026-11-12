/**
 * HOW-34 — usage rows, ONE renderer for the run inspector, the Run scope of the step panel,
 * and a single step. Every figure goes through log/usage.ts's describe*, so "unknown" and
 * "partial: 2 of 3 turns unpriced" read the same wherever usage is shown, and no panel can
 * print a plain number over a run that fell back to an unpriced harness.
 *
 * HOW-68: the rows are `KeyValue` items (labels in sans, figures in sans with tabular-nums —
 * a number that is READ is never mono, DESIGN.md Type). `usageItems` is the data, for a caller
 * that lists usage beside other facts in one list; `UsageRows` is the same rows on their own.
 */
import { describeCost, describeFigure, type UsageRollup } from "../../../log/usage";
import { KeyValue, type KeyValueItem } from "@/components/ui/key-value";

export function usageItems(usage: UsageRollup): KeyValueItem[] {
  const fig = (label: string, v: string): KeyValueItem => ({ label, value: <span className="tabular-nums">{v}</span> });
  return [
    fig("Input tokens", describeFigure(usage.input_tokens)),
    fig("Cache read", describeFigure(usage.cache_read_input_tokens)),
    fig("Cache write", describeFigure(usage.cache_creation_input_tokens)),
    fig("Output tokens", describeFigure(usage.output_tokens)),
    fig("Cost", describeCost(usage)),
  ];
}

export function UsageRows({ usage, labelWidth = 104 }: {
  usage: UsageRollup;
  labelWidth?: number;
  /** @deprecated the value's styling is KeyValue's now; accepted so older call sites compile */
  valueClass?: string;
}) {
  return <KeyValue items={usageItems(usage)} labelWidth={labelWidth} />;
}
