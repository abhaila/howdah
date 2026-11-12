/**
 * Logs (T24, stories 7 + 8) — Logfire's dense event list under Signal's filter bar.
 * Every row comes from deriveLogRows, whose switch is exhaustive over the event union, so
 * a new event type fails the build rather than rendering blank here.
 *
 * HOW-68 — this was the audit's worst pane (§3.1.1). The summary cell was the last child of a
 * flex row whose fixed columns already took more than the 386px list, so it computed to 0px
 * wide with `white-space: pre-wrap`: every summary wrapped one character per line, rows ran a
 * median 945px tall, four events fit on a 900px screen and the type chip was cut in half.
 *
 *   A row is a GRID (`.log-row`, howdah.css): time · step · type · summary, the first and
 *   third fixed, the summary `minmax(0, 1fr)` — so it can never be squeezed to nothing — and
 *   cut to ONE line with `Truncate`. The whole summary is in the detail panel, wrapped.
 *   Rows are 28px (DESIGN.md Chrome: dense read-only lists).
 *   The list and the detail are the shared `SplitView`: under 1100px the detail replaces the
 *   list (it measured 8px wide at 1024, §3.1.4), Esc closes it, J/K and the arrows move.
 *   The `attention` filter and its rows were amber. An attention event in the LOG is history,
 *   not a run waiting on you, so neither is coloured any more — the type says what it is.
 *   Loading, failing to load and matching nothing are three different sentences now; the
 *   fetch used to fail silently into "nothing matches".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import type { LogRow } from "../../derive";
import type { LoggedEvent } from "../../../log/events";
import { getJSON } from "@/lib/net";
import { useBottomPinnedScroll } from "@/lib/hooks";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/chip";
import { Row } from "@/components/ui/row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingBlock } from "@/components/ui/skeleton";
import { PanelTabs } from "@/components/ui/tabs";
import { KeyValue } from "@/components/ui/key-value";
import { ScrollPane } from "@/components/ui/scroll-pane";
import { Truncate } from "@/components/ui/truncate";
import { DetailPanel, SplitView, useListKeys, useSplit } from "@/components/ui/panel";

const KINDS: Array<"all" | LogRow["kind"]> = ["all", "agent", "tool", "engine", "operator", "attention"];
const KIND_LABEL: Record<(typeof KINDS)[number], string> = {
  all: "All", agent: "Agent", tool: "Tool", engine: "Engine", operator: "Operator", attention: "Attention",
};
const LOG_PAGE = 200;

/** A log row as the page sends it: the stored event stays on GET /event/:seq until Raw is opened. */
type ListedRow = Omit<LogRow, "raw"> & { raw?: LoggedEvent };

type LogPage = { rows: ListedRow[]; total: number; oldest: number | null };

/** "14:02:07.531" — the part of an ISO stamp a dense list has room for */
const clock = (ts: string) => ts.slice(11, 23);

export function RunLogs({ runId }: { runId: string }) {
  const [kind, setKind] = useState<"all" | LogRow["kind"]>("all");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<number | null>(null);
  const [rows, setRows] = useState<ListedRow[]>([]);
  const [total, setTotal] = useState(0);
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  // once the operator pages backwards, a refresh of the tail would throw those rows away
  const pagedBack = useRef(false);

  useEffect(() => {
    let stop = false;
    pagedBack.current = false;
    setLoad("loading");
    const pull = () => {
      if (pagedBack.current || stop) return;
      getJSON<LogPage>(`/api/runs/${runId}/logs?limit=${LOG_PAGE}`)
        .then((p) => {
          if (stop || pagedBack.current || !p || !Array.isArray(p.rows)) return;
          setRows(p.rows);
          setTotal(p.total);
          setLoad("ready");
        })
        // a failed REFRESH keeps what is on screen; only a failed first load is an error state
        .catch(() => { if (!stop) setLoad((s) => (s === "loading" ? "error" : s)); });
    };
    pull();
    const t = setInterval(pull, 5000);
    return () => { stop = true; clearInterval(t); };
  }, [runId]);

  const loadEarlier = () => {
    const oldest = rows[0]?.seq;
    if (oldest === undefined) return;
    pagedBack.current = true;
    getJSON<LogPage>(`/api/runs/${runId}/logs?limit=${LOG_PAGE}&before=${oldest}`)
      .then((p) => {
        if (!p || !Array.isArray(p.rows) || p.rows.length === 0) return;
        setRows((prev) => [...p.rows, ...prev]);
        setTotal(p.total);
      })
      .catch(() => {});
  };

  const shown = rows.filter((r) => {
    if (kind !== "all" && r.kind !== kind) return false;
    if (!q.trim()) return true;
    const hay = `${r.type} ${r.node ?? ""} ${r.summary}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });
  const selected = rows.find((r) => r.seq === picked) ?? shown.at(-1) ?? null;

  return (
    <SplitView
      storageKey="howdah.logs"
      min={320}
      def={400}
      minList={520}
      label="the event detail"
      listLabel="Logs"
      list={
        <LogList
          rows={rows} shown={shown} total={total} load={load} selected={selected?.seq ?? null}
          kind={kind} onKind={setKind} q={q} onQ={setQ} onPick={setPicked} onEarlier={loadEarlier}
        />
      }
      detail={<EventDetail row={selected} runId={runId} />}
    />
  );
}

function LogList({ rows, shown, total, load, selected, kind, onKind, q, onQ, onPick, onEarlier }: {
  rows: ListedRow[]; shown: ListedRow[]; total: number; load: "loading" | "ready" | "error"; selected: number | null;
  kind: "all" | LogRow["kind"]; onKind: (k: "all" | LogRow["kind"]) => void;
  q: string; onQ: (q: string) => void; onPick: (seq: number) => void; onEarlier: () => void;
}) {
  const split = useSplit();
  const follow = useBottomPinnedScroll(`${shown.length}:${shown.at(-1)?.seq ?? "empty"}:${kind}:${q}`);
  const keys = useListKeys({ ids: shown.map((r) => r.seq), selected, onSelect: onPick, name: "event" });
  const clear = useCallback(() => { onQ(""); onKind("all"); }, [onQ, onKind]);
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-2 py-2">
        <Input className="h-7 min-w-[140px] max-w-[260px] flex-1" aria-label="Search events" placeholder="Search events…" value={q} onChange={(e) => onQ(e.target.value)} />
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by kind">
          {KINDS.map((k) => <Chip key={k} on={kind === k} onClick={() => onKind(k)}>{KIND_LABEL[k]}</Chip>)}
        </div>
        <span className="ml-auto flex items-center gap-2">
          {rows.length < total && <Button variant="outline" size="sm" onClick={onEarlier}>Load earlier</Button>}
          {!follow.atBottom && <Button variant="ghost" size="sm" onClick={follow.scrollToBottom}><ArrowDown aria-hidden />Latest</Button>}
          <span className="text-xs tabular-nums text-muted-foreground">{shown.length} of {total}</span>
        </span>
      </div>
      <ScrollPane label="Events" ref={follow.ref} onScroll={follow.measure}>
        {load === "loading" && <LoadingBlock label="Loading events" rows={8} className="p-3" />}
        {load === "error" && <EmptyState title="The log could not be read">The viewer server did not answer. It retries every five seconds.</EmptyState>}
        {load === "ready" && shown.length === 0 && (
          rows.length === 0
            ? <EmptyState title="No events yet">Every event the run appends to its log appears here.</EmptyState>
            : <EmptyState title="No events match" actions={<Button variant="outline" size="sm" onClick={clear}>Clear the filter</Button>}>Nothing in the loaded events matches this search and kind.</EmptyState>
        )}
        <div ref={keys.ref} onKeyDown={keys.onKeyDown}>
          {shown.map((r) => (
            <Row
              key={r.seq}
              className="log-row"
              selected={selected === r.seq}
              onClick={() => { onPick(r.seq); split.open(); }}
              aria-label={`${r.type} at ${clock(r.ts)}${r.node ? `, ${r.node}` : ""}`}
            >
              <span className="font-mono text-xs text-faint">{clock(r.ts)}</span>
              <span className={`log-node flex min-w-0 items-baseline${r.depth > 0 ? " pl-3" : ""}`}>
                {r.node
                  ? <><Truncate mono middle={10} className="text-xs text-muted-foreground">{r.node}</Truncate>{r.visit !== null && <span className="shrink-0 font-mono text-xs text-faint">@{r.visit}</span>}</>
                  : <span className="text-xs text-faint">—</span>}
              </span>
              <span className="flex min-w-0"><Badge variant="id" className="min-w-0 max-w-full"><Truncate>{r.type}</Truncate></Badge></span>
              <Truncate className="text-sm text-muted-foreground">{r.summary.replace(/\s+/g, " ")}</Truncate>
            </Row>
          ))}
        </div>
      </ScrollPane>
    </>
  );
}

/** Story 8: the selected event with its ids and its exact stored form. */
export function EventDetail({ row, runId }: { row: ListedRow | null; runId?: string }) {
  const [pane, setPane] = useState<"details" | "raw">("details");
  const [raw, setRaw] = useState<LoggedEvent | null>(row?.raw ?? null);
  const [rawFailed, setRawFailed] = useState(false);
  useEffect(() => {
    setRawFailed(false);
    if (!row) { setRaw(null); return; }
    if (row.raw) { setRaw(row.raw); return; }
    if (pane !== "raw" || !runId) { setRaw(null); return; }
    let stop = false;
    getJSON<LoggedEvent>(`/api/runs/${runId}/event/${row.seq}`)
      .then((e) => { if (!stop) setRaw(e); })
      .catch(() => { if (!stop) { setRaw(null); setRawFailed(true); } });
    return () => { stop = true; };
  }, [row, pane, runId]);
  if (!row)
    return (
      <DetailPanel label="Event detail">
        <EmptyState title="No event selected">Pick an event on the left to see its summary and its stored form.</EmptyState>
      </DetailPanel>
    );
  return (
    <DetailPanel
      label={`Event ${row.seq}`}
      head={
        <div className="flex min-w-0 items-baseline gap-2 pb-2">
          <h2 className="m-0 flex min-w-0 flex-1 text-md font-semibold"><Truncate mono>{row.type}</Truncate></h2>
          <span className="shrink-0 text-xs text-muted-foreground">{KIND_LABEL[row.kind]} event</span>
        </div>
      }
      strip={<PanelTabs value={pane} onValueChange={setPane} items={[{ value: "details", label: "Details" }, { value: "raw", label: "Raw event" }]} />}
    >
      {pane === "details" ? (
        <KeyValue labelWidth={72} items={[
          { label: "Summary", value: <span className="whitespace-pre-wrap">{row.summary}</span> },
          { label: "Step", value: row.node ? `${row.node}${row.visit !== null ? `@${row.visit}` : ""}` : null, mono: true },
          { label: "At", value: row.ts, mono: true },
          { label: "Seq", value: String(row.seq), mono: true },
          { label: "Kind", value: KIND_LABEL[row.kind] },
        ]} />
      ) : raw ? (
        <pre className="code-block">{JSON.stringify(raw, null, 2)}</pre>
      ) : rawFailed ? (
        <EmptyState title="The stored event could not be read">Switch tabs to try again.</EmptyState>
      ) : (
        <LoadingBlock label="Loading the stored event" rows={5} />
      )}
    </DetailPanel>
  );
}
