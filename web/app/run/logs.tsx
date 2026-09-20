/**
 * Logs (T24, stories 7 + 8) — Logfire's dense event list under Signal's filter bar.
 * Every row comes from deriveLogRows, whose switch is exhaustive over the event union, so
 * a new event type fails the build rather than rendering blank here.
 *
 * HOW-16 fixes both of this pane's defects at once: the filters were `<span>`s carrying
 * `.chip`, a class with NO base rule anywhere AND no keyboard handling, so they rendered as
 * bare words that only a mouse could press. They are Chips now — real `<button
 * aria-pressed>`s that style themselves. The search box was `.logs-search`, a hand-written
 * copy of Input; the rows were `<div onClick>`s, and are Rows.
 */
import { useState } from "react";
import type { LogRow } from "../../derive";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/chip";
import { Row } from "@/components/ui/row";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PanelTabs } from "@/components/ui/tabs";
import { ScrollShell } from "@/components/scroll-shell";
import { PanelResizer, PanelToggle } from "@/components/ui/panel";
import { usePanel } from "@/lib/panel";

const KINDS: Array<"all" | LogRow["kind"]> = ["all", "agent", "tool", "engine", "operator", "attention"];

export function RunLogs({ rows }: { rows: LogRow[] }) {
  const panel = usePanel({ key: "howdah.logs", min: 300, def: 420, minOther: 360, side: "right" });
  const [kind, setKind] = useState<"all" | LogRow["kind"]>("all");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<number | null>(null);

  const shown = rows.filter((r) => {
    if (kind !== "all" && r.kind !== kind) return false;
    if (!q.trim()) return true;
    const hay = `${r.type} ${r.node ?? ""} ${r.summary}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });
  const selected = rows.find((r) => r.seq === picked) ?? shown.at(-1) ?? null;

  return (
    <div
      className="logs-split"
      ref={panel.boxRef}
      data-pane={panel.collapsed ? "closed" : "open"}
      style={{ ["--sd-w" as string]: `${panel.width}px` }}
    >
      <div className="logs-col">
        <div className="logs-filters">
          <Input className="logs-search" aria-label="search events" placeholder="Search events…" value={q} onChange={(e) => setQ(e.target.value)} />
          {KINDS.map((k) => (
            <Chip key={k} on={kind === k} tone={k === "attention" ? "attention" : "default"} onClick={() => setKind(k)}>{k}</Chip>
          ))}
          <span className="m logs-count">{shown.length} of {rows.length}</span>
        </div>
        <ScrollShell className="logs-shell" followKey={`${shown.length}:${shown.at(-1)?.seq ?? "empty"}:${kind}:${q}`}>
          <div className="logs-rows">
            {shown.length === 0 && <EmptyState>nothing matches</EmptyState>}
            {shown.map((r) => (
              <Row
                key={r.seq}
                className={`log-row ${r.kind} depth-${r.depth}`}
                selected={selected?.seq === r.seq}
                onClick={() => setPicked(r.seq)}
                aria-label={`${r.type} at ${r.ts.slice(11, 23)}`}
              >
                <span className="m log-ts">{r.ts.slice(11, 23)}</span>
                <span className="m log-node">{r.node ?? "—"}{r.visit !== null && <span className="log-visit">@{r.visit}</span>}</span>
                <Badge className="log-type">{r.type}</Badge>
                <span className="log-summary">{r.summary}</span>
              </Row>
            ))}
          </div>
        </ScrollShell>
      </div>
      <PanelResizer panel={panel} label="the event detail panel">
        <div className="pane-controls">
          <PanelToggle panel={panel} label="the event detail" side="right" />
        </div>
      </PanelResizer>
      {!panel.collapsed && <EventDetail row={selected} />}
    </div>
  );
}

/** Story 8: the selected event with its ids and its exact stored form. */
export function EventDetail({ row }: { row: LogRow | null }) {
  const [pane, setPane] = useState<"details" | "raw">("details");
  if (!row) return <div className="step-detail"><EmptyState>pick an event</EmptyState></div>;
  return (
    <div className="step-detail">
      <div className="sd-head">
        <span className="m sd-node">{row.type}</span>
        <span className="m sd-total">{row.kind}</span>
      </div>
      <div className="sd-pills">
        <Badge>seq {row.seq}</Badge>
        <Badge>{row.ts.slice(11, 23)}</Badge>
        {row.node && <Badge variant="id">{row.node}{row.visit !== null ? `@${row.visit}` : ""}</Badge>}
      </div>
      <PanelTabs value={pane} onValueChange={setPane} items={[{ value: "details", label: "Details" }, { value: "raw", label: "Raw event" }]} />
      <div className="sd-body">
        {pane === "details" ? (
          <>
            <div className="kv"><span className="k">summary</span><span className="v">{row.summary}</span></div>
            <div className="kv"><span className="k">kind</span><span className="v">{row.kind}</span></div>
            <div className="kv"><span className="k">seq</span><span className="v">{row.seq}</span></div>
            <div className="kv"><span className="k">at</span><span className="v">{row.ts}</span></div>
          </>
        ) : (
          <pre className="sd-raw">{JSON.stringify(row.raw, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}
