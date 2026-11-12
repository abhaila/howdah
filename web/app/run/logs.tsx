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
import { useShortcuts } from "@/lib/shortcuts";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
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

/** a row's height: `.log-row` is `height: 28px` with its hairline inside (howdah.css) */
export const LOG_ROW_HEIGHT = 28;
/** under this many rows the whole list is simply rendered */
export const WINDOW_FROM = 80;
/** rows kept rendered above and below what is on screen, so a wheel tick never shows a gap */
const OVERSCAN = 20;

/**
 * Which rows of a long list to render (HOW-68 final pass). Switching to Logs on a long run was
 * one 600–760ms task: 200 rows, each with three `Truncate`s that measure themselves. The rows
 * are a FIXED 28px, so the list is windowed exactly — what is on screen plus `OVERSCAN` either
 * side, with a spacer above and below standing in for the rest, so the scroller's height, the
 * bottom pin and "Latest" are unchanged.
 *
 * `keep` is the selected row and its neighbours, rendered wherever they are: J/K select the
 * next row and then FOCUS it (`useListKeys`), and a row that is not in the DOM cannot take
 * focus; once focused the browser scrolls it into view and the window follows.
 *
 * What it costs: the browser's own find-in-page only sees rendered rows. The pane's search
 * field filters all loaded events, which is what `/` focuses. Pure.
 */
export function windowRows(count: number, scrollTop: number, viewHeight: number, keep: number | null): Array<[start: number, end: number]> {
  if (count <= WINDOW_FROM) return count > 0 ? [[0, count]] : [];
  const first = Math.max(0, Math.floor(scrollTop / LOG_ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(count, Math.ceil((scrollTop + viewHeight) / LOG_ROW_HEIGHT) + OVERSCAN);
  const spans: Array<[number, number]> = [[first, Math.max(first, last)]];
  if (keep !== null && keep >= 0 && keep < count) {
    const a = Math.max(0, keep - 1), b = Math.min(count, keep + 2);
    if (b < first) spans.unshift([a, b]);
    else if (a > last) spans.push([a, b]);
    else spans[0] = [Math.min(first, a), Math.max(last, b)];
  }
  return spans.filter(([s, e]) => e > s);
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
  // where the scroller is, in whole rows: a re-render per row scrolled past, not per pixel
  const [view, setView] = useState({ top: 0, height: 900 });
  const onScroll = useCallback(() => {
    follow.measure();
    const el = follow.ref.current;
    if (!el) return;
    const top = Math.floor(el.scrollTop / LOG_ROW_HEIGHT) * LOG_ROW_HEIGHT;
    const height = el.clientHeight || 900;
    setView((was) => (was.top === top && was.height === height ? was : { top, height }));
  }, [follow]);
  // pinned to the bottom (the opening state): the window is the END of the list from the first
  // render, before the pin has scrolled there
  const scrollTop = follow.atBottom ? Math.max(0, shown.length * LOG_ROW_HEIGHT - view.height) : view.top;
  const selectedAt = selected === null ? -1 : shown.findIndex((r) => r.seq === selected);
  const spans = windowRows(shown.length, scrollTop, view.height, selectedAt >= 0 ? selectedAt : null);
  const spacer = (rowsHidden: number, key: string) => (rowsHidden > 0 ? <div key={key} aria-hidden style={{ height: rowsHidden * LOG_ROW_HEIGHT }} /> : null);
  // DESIGN.md Keyboard: "/" is the filter of whatever list is on screen. The Build tab's own
  // "/" (its composer) is unmounted while this pane is up, so the key did nothing here.
  const search = useRef<HTMLInputElement | null>(null);
  useShortcuts([{ id: "run.logs.search", scope: "A run", label: "Search the events", keys: "/", run: () => { search.current?.focus(); search.current?.select(); } }]);
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-2 py-2">
        <span className="relative flex min-w-[140px] max-w-[260px] flex-1">
          <Input
            ref={search}
            className="h-7 w-full pr-8"
            aria-label="Search events"
            placeholder="Search events…"
            value={q}
            onChange={(e) => onQ(e.target.value)}
            // Esc clears what was typed first, then lets go of the field — the Runs filter's rule
            onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (q) onQ(""); else e.currentTarget.blur(); } }}
          />
          {q === "" && <Kbd keys="/" decorative className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2" />}
        </span>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by kind">
          {KINDS.map((k) => <Chip key={k} on={kind === k} onClick={() => onKind(k)}>{KIND_LABEL[k]}</Chip>)}
        </div>
        <span className="ml-auto flex items-center gap-2">
          {rows.length < total && <Button variant="outline" size="sm" onClick={onEarlier}>Load earlier</Button>}
          {!follow.atBottom && <Button variant="ghost" size="sm" onClick={follow.scrollToBottom}><ArrowDown aria-hidden />Latest</Button>}
          <span className="text-xs tabular-nums text-muted-foreground">{shown.length} of {total}</span>
        </span>
      </div>
      <ScrollPane label="Events" ref={follow.ref} onScroll={onScroll}>
        {load === "loading" && <LoadingBlock label="Loading events" rows={8} className="p-3" />}
        {load === "error" && <EmptyState title="The log could not be read">The viewer server did not answer. It retries every five seconds.</EmptyState>}
        {load === "ready" && shown.length === 0 && (
          rows.length === 0
            ? <EmptyState title="No events yet">Every event the run appends to its log appears here.</EmptyState>
            : <EmptyState title="No events match" actions={<Button variant="outline" size="sm" onClick={clear}>Clear the filter</Button>}>Nothing in the loaded events matches this search and kind.</EmptyState>
        )}
        <div ref={keys.ref} onKeyDown={keys.onKeyDown}>
          {spans.flatMap(([start, end], n) => [
            // the rows not rendered above this span (the heights are data: a count of fixed rows)
            spacer(start - (n === 0 ? 0 : spans[n - 1]![1]), `gap-${n}`),
            ...shown.slice(start, end).map((r) => (
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
            )),
          ])}
          {spacer(shown.length - (spans.at(-1)?.[1] ?? shown.length), "gap-end")}
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
      strip={<PanelTabs label="Event panes" panel="event-pane" value={pane} onValueChange={setPane} items={[{ value: "details", label: "Details" }, { value: "raw", label: "Raw event" }]} />}
      tabs={{ panel: "event-pane", value: pane }}
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
