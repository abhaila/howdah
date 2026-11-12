/**
 * The ONE status renderer (design review: one canonical RunStatus enum, one renderer).
 * Split out of main.tsx (system-map 1d) so it can be component-tested without booting the
 * app. Needs-input outranking failed is decided upstream in derive.ts deriveStatus; this
 * renderer must never re-rank — it draws whatever the read model says.
 *
 * HOW-68 (DESIGN.md "Status is a shape before it is a colour"). The badge used to be an 8px
 * dot whose only difference between states was its hue, and the running one pulsed forever.
 * Each status is now an inline SVG whose SHAPE alone says which it is — triangle waiting on
 * you, half-disc running, ring waiting on something else, cross failed, check done — at 14px,
 * with colour as the second channel and no animation at all. The labels are the operator's
 * words ("Waiting on you", not "needs input"); the `RunStatus` enum underneath is untouched,
 * and `data-status` still carries it for anything that needs the machine name.
 */
import type { RunStatus } from "../derive";

export const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued", running: "Running", "needs-input": "Waiting on you", waiting: "Waiting",
  "failed-recoverable": "Failed", "failed-terminal": "Failed", done: "Done", "harness-dead": "Runner died",
};

type Shape = "triangle" | "half" | "ring" | "cross" | "check";
const SHAPE: Record<RunStatus, Shape> = {
  queued: "ring", running: "half", "needs-input": "triangle", waiting: "ring",
  "failed-recoverable": "cross", "failed-terminal": "cross", done: "check", "harness-dead": "cross",
};

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

/**
 * The glyph alone. Decorative by default — the badge beside it carries the words — and named
 * (`label`) only where it stands with no text of its own.
 */
export function StatusGlyph({ status, size = 14, label, className }: { status: RunStatus; size?: number; label?: string; className?: string }) {
  const shape = SHAPE[status];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={`status-glyph${className ? ` ${className}` : ""}`}
      data-shape={shape}
      style={{ ["--status-color" as string]: `var(--status-${status})` }}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {shape === "triangle" && <path d="M8 2.4 L14.2 13.2 L1.8 13.2 Z" fill="currentColor" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" />}
      {shape === "half" && (
        <>
          <circle cx="8" cy="8" r="5.6" {...STROKE} />
          <path d="M8 2.4 A5.6 5.6 0 0 1 8 13.6 Z" fill="currentColor" />
        </>
      )}
      {shape === "ring" && <circle cx="8" cy="8" r="5.6" {...STROKE} />}
      {shape === "cross" && <path d="M4.2 4.2 L11.8 11.8 M11.8 4.2 L4.2 11.8" {...STROKE} strokeWidth={1.9} />}
      {shape === "check" && <path d="M3.2 8.6 L6.6 11.8 L12.8 4.6" {...STROKE} strokeWidth={1.9} />}
    </svg>
  );
}

export function StatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  return (
    <span className={`status ${status}${className ? ` ${className}` : ""}`} data-status={status}>
      <StatusGlyph status={status} /> {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * Which Steps row carries the ask: its exact node@visit, else that node's latest visit. A
 * pre-start park (max-visits, approval-missing, stale-base) is raised at a visit that never
 * started, so no row has it — without this fallback the needs-you row and its Ask pane would
 * be unreachable. One rule for the row glyph, the default selection and the detail panes.
 */
export function askRowKey(timeline: ReadonlyArray<{ node: string; visit: number }>, ask: { node: string; visit: number } | null): string | null {
  if (!ask) return null;
  const row = timeline.findLast((t) => t.node === ask.node && t.visit === ask.visit) ?? timeline.findLast((t) => t.node === ask.node);
  return row ? `${row.node}@${row.visit}` : null;
}
