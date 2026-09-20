/**
 * Context (T24, stories 9 + 10) — the run's whole context in one table. Out of main.tsx.
 *
 * Nothing in the research showed this: trace tools show a span's input and output, and
 * Orbital's tab was per-step and usually empty (CUR5). Keys no step has reached yet stay
 * listed, because their absence is exactly what made the old tab useless.
 *
 * The scope pills were `<span className={`pill scope-${e.scope}`}>` — and `.pill` had no
 * base rule, so only `cleared` and `per-visit` (which had modifiers) rendered as anything
 * at all. They are Badge variants now: the styling comes with the component.
 */
import { useState } from "react";
import type { RunDetail } from "../../derive";
import { fmtValue } from "@/lib/format";
import { Badge, scopeVariant } from "@/components/ui/badge";
import { Row } from "@/components/ui/row";
import { EmptyState } from "@/components/ui/empty-state";

export const SCOPE_MEANS: Record<string, string> = {
  sticky: "the last good value stays visible when a writer re-enters, until a newer one lands",
  cleared: "hidden while its writer re-runs; if that attempt fails, the old answer is restored",
  "per-visit": "invalidated the moment its writer re-enters — freshness is part of its meaning",
};

export function RunContext({ entries }: { entries: RunDetail["context"] }) {
  const [picked, setPicked] = useState<string | null>(null);
  if (entries.length === 0) return <EmptyState>this graph declares no context keys</EmptyState>;
  const selected = entries.find((e) => e.key === picked) ?? entries.find((e) => e.written) ?? entries[0]!;
  return (
    <div className="ctx-split">
      <div className="ctx-col">
        <Row as="div" className="ctx-row ctx-header" role="presentation">
          <span className="ctx-key rh">key</span>
          <span className="ctx-value rh">value</span>
          <span className="ctx-scope rh">scope</span>
          <span className="ctx-writer rh">written by</span>
          <span className="ctx-at rh">at</span>
        </Row>
        <div className="ctx-rows">
          {entries.map((e) => {
            const last = e.writes.at(-1);
            return (
              <Row
                key={e.key}
                className={`ctx-row ${e.written ? "" : "unwritten"}`}
                selected={selected.key === e.key}
                onClick={() => setPicked(e.key)}
                aria-label={`context key ${e.key}`}
              >
                <span className="m ctx-key">{e.key}</span>
                <span className="ctx-value">
                  {e.veiled ? "veiled — its writer is mid-attempt" : e.written ? fmtValue(e.value) : "— not written yet"}
                </span>
                <span className="ctx-scope">{e.scope && <Badge variant={scopeVariant(e.scope)}>{e.scope}</Badge>}</span>
                <span className="m ctx-writer">{last ? `${last.node}@${last.visit}` : e.declared_writers.join(", ") || "—"}</span>
                <span className="m ctx-at">{last ? last.at.slice(11, 16) : "—"}</span>
              </Row>
            );
          })}
        </div>
      </div>
      <ContextDetail entry={selected} />
    </div>
  );
}

/** Story 10: one key — its value, who wrote it in what order, and which prompts read it. */
export function ContextDetail({ entry }: { entry: RunDetail["context"][number] }) {
  return (
    <div className="step-detail">
      <div className="sd-head"><span className="m sd-node">{entry.key}</span></div>
      <div className="sd-pills">
        {entry.scope && <Badge variant={scopeVariant(entry.scope)}>{entry.scope}</Badge>}
        <Badge>{entry.written ? `${entry.writes.length} write${entry.writes.length === 1 ? "" : "s"}` : "not written"}</Badge>
        {entry.declared_writers.length > 1 && <Badge>{entry.declared_writers.length} writers</Badge>}
      </div>
      {entry.scope && <div className="pd-note sd-scope-note">{SCOPE_MEANS[entry.scope]}</div>}
      <div className="sd-body">
        <h2 className="rh">Current value</h2>
        {entry.veiled ? (
          <div className="pd-note">veiled: its writer is mid-attempt, so the old value must not be read as current</div>
        ) : entry.written ? (
          <pre className="sd-raw">{fmtValue(entry.value)}</pre>
        ) : (
          <div className="pd-note">nothing has written this yet — {entry.declared_writers.join(", ") || "no declared writer"} would</div>
        )}

        <h2 className="rh">Write history</h2>
        {entry.writes.length === 0
          ? <div className="pd-note">no writes yet</div>
          : entry.writes.map((w, i) => (
              <div key={i} className="ctx-write">
                <span className="m ctx-write-at">{w.at.slice(11, 19)}</span>
                <span className="m ctx-write-node">{w.node}@{w.visit}</span>
                <span className="ctx-write-note">{w.replaced ? "replaced" : "first write"}</span>
              </div>
            ))}

        <h2 className="rh">Read by</h2>
        {entry.read_by.length === 0
          ? <div className="pd-note">no prompt has read this yet</div>
          : <div className="ctx-readers">{entry.read_by.map((r) => <Badge key={r} variant="id">{r}</Badge>)}</div>}
      </div>
    </div>
  );
}
