/**
 * HOW-34 — usage rows, ONE renderer for the run inspector, the Run scope of the step panel,
 * and a single step. Every figure goes through log/usage.ts's describe*, so "unknown" and
 * "partial: 2 of 3 turns unpriced" read the same wherever usage is shown, and no panel can
 * print a plain number over a run that fell back to an unpriced harness.
 */
import { describeCost, describeFigure, type UsageRollup } from "../../../log/usage";

export function UsageRows({ usage, valueClass }: { usage: UsageRollup; valueClass?: string }) {
  const row = (k: string, v: string) => (
    <div key={k} className="kv"><span className="k">{k}</span><span className={valueClass}>{v}</span></div>
  );
  return (
    <>
      {row("input tokens", describeFigure(usage.input_tokens))}
      {row("cache read", describeFigure(usage.cache_read_input_tokens))}
      {row("cache write", describeFigure(usage.cache_creation_input_tokens))}
      {row("output tokens", describeFigure(usage.output_tokens))}
      {row("cost", describeCost(usage))}
    </>
  );
}
