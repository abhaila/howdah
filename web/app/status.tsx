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

/**
 * A step the timeline still calls "running" that NOTHING is running any more (D26): its turn
 * was derived `died`, or the run's runner is dead. The Details timeline drew it with the
 * running glyph, so a dead run showed a step in progress beside "Runner died". Decided from
 * the read model's own two facts, never from a clock.
 */
export function stepInterrupted(
  detail: { summary: { status: RunStatus }; turn_states: Record<string, string | undefined> },
  row: { node: string; visit: number; status: string },
): boolean {
  if (row.status !== "running") return false;
  return detail.summary.status === "harness-dead" || detail.turn_states[`${row.node}@${row.visit}`] === "died";
}

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

export function StatusBadge({ status, className, label }: { status: RunStatus; className?: string; /** the words, when the frame knows a better one than the status's own (run/view.tsx "Resuming") */ label?: string }) {
  return (
    <span className={`status ${status}${className ? ` ${className}` : ""}`} data-status={status}>
      <StatusGlyph status={status} /> {label ?? STATUS_LABEL[status]}
    </span>
  );
}

/**
 * Which Steps row carries the ask: its exact node@visit, else that node's latest visit. A
 * pre-start park (max-visits, approval-missing, stale-base) is raised at a visit that never
 * started, so no row has it — without this fallback the needs-you row and its Ask pane would
 * be unreachable. One rule for the row glyph, the default selection and the detail panes.
 */
export function askRowKey(timeline: ReadonlyArray<StepRef>, ask: { node: string; visit: number } | null): string | null {
  if (!ask) return null;
  const row = timeline.findLast((t) => t.node === ask.node && t.visit === ask.visit) ?? timeline.findLast((t) => t.node === ask.node);
  return row ? stepKey(row) : null;
}

type StepRef = { node: string; visit: number; attempt?: number };
/**
 * A timeline row's IDENTITY in a list (HOW-68): `node@visit`, and `node@visit#2` for a second
 * attempt of the same visit (derive.ts `TimelineRow.attempt`). An approval step that failed and
 * was then decided is two rows of `approve@1`; keyed by `node@visit` alone they shared a React
 * key and lit up together when either was selected. Stable: rows are only ever appended.
 */
export function stepKey(t: StepRef): string {
  return `${t.node}@${t.visit}${t.attempt && t.attempt > 1 ? `#${t.attempt}` : ""}`;
}
/**
 * The row a bare `node@visit` means — its LATEST attempt, which is the one the conversation
 * draws. A key that already names a row (or names none) is returned unchanged.
 */
export function resolveStepKey(timeline: ReadonlyArray<StepRef>, key: string | null): string | null {
  if (key === null) return null;
  const row = timeline.findLast((t) => `${t.node}@${t.visit}` === key);
  return row ? stepKey(row) : key;
}
