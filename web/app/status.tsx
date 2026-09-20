/**
 * The ONE status renderer (design review: one canonical RunStatus enum, one renderer).
 * Split out of main.tsx (system-map 1d) so it can be component-tested without booting the
 * app. Needs-input outranking failed is decided upstream in derive.ts deriveStatus; this
 * renderer must never re-rank — it draws whatever the read model says.
 */
import type { RunStatus } from "../derive";

export const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "queued", running: "running", "needs-input": "needs input", waiting: "waiting",
  "failed-recoverable": "failed", "failed-terminal": "failed", done: "done", "harness-dead": "harness dead",
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className={`status ${status}`} data-status={status} style={{ ["--status-color" as any]: `var(--status-${status})` }}>
      <span className="dot" /> {STATUS_LABEL[status]}
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
