/**
 * The runs list — the app's front door, out of main.tsx (HOW-16 P1).
 *
 * HOW-50 made it a live BOARD: grouped — Needs you / Running / Finished / Older — with
 * needs-you always first, because a run waiting on a human outranks everything (CLAUDE.md),
 * each row carrying its vital signs (web/board.ts derives them from the log, incrementally)
 * and the whole list fed by ONE board-level SSE stream, never a poll per row.
 *
 * HOW-68 redrew the row (DESIGN.md; the audit's "tinted rows, three type styles per row, no
 * reason shown"). A row is five columns and one voice:
 *
 *   status glyph · name · WHAT IT IS WAITING FOR OR DOING · age · cost
 *
 * The third column is the point. A waiting run used to say "waiting 12m" — the age of a
 * question it never showed — so the operator had to open each run to learn what it wanted.
 * It now says the question, in the sentence its own ask card uses (`parkSummary`, through
 * lib/board.ts `runLine`); a running row names its step; a finished one says how it ended.
 *
 * THE ALARM IS SAID ONCE. A waiting row is marked by its amber triangle and a bold label and
 * by nothing else: no tinted row, no side stripe, no amber timer, and a live run that has gone
 * quiet says so in words ("no output for 6m") rather than turning amber — amber means "waiting
 * on you" and nothing else.
 *
 * NOTHING IS CUT WITHOUT A WAY TO READ IT. The name and the third column are `Truncate`s, so a
 * long name shows whole on hover and while its row has keyboard focus. The name column gives;
 * age and cost are fixed and `tabular-nums`, so a long name can never squeeze them, and the
 * row stays one 36px line down to 1024px wide.
 *
 * KEYBOARD (lib/list-nav.ts): J/K or the arrows move a visible selection, Enter opens it, `/`
 * focuses the filter. The filter is client-side over name, goal, id, graph, status and step.
 *
 * The home / source / supervisor strip that sat above the list is one quiet line now, and
 * only when it has something to say: a supervisor that is not running. Where the home and the
 * source are lives behind "About this home" — true every day, needed once.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Info, Plus, Search } from "lucide-react";
import type { RunBoardRow } from "../../board";
import { boardGroup, matchesFilter, prChip, runAge, runLine, type BoardGroup, type RunLine } from "@/lib/board";
import type { AppInfo } from "@/lib/types";
import { getJSON } from "@/lib/net";
import { fmtWhen, runLabel } from "@/lib/format";
import { useAttentionSurfaces, useNow } from "@/lib/hooks";
import { useListNav } from "@/lib/list-nav";
import { parkSummary } from "../../../core/park-summary";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { KeyValue } from "@/components/ui/key-value";
import { Popover } from "@/components/ui/popover";
import { Row } from "@/components/ui/row";
import { SectionLabel } from "@/components/ui/section-label";
import { Tooltip } from "@/components/ui/tooltip";
import { Truncate } from "@/components/ui/truncate";
import { STATUS_LABEL, StatusGlyph } from "../status";
import { Mark } from "../brand";
import { KeyHints, LoadError, Screen, ScreenLoading } from "./frame";

const GROUPS: Array<{ key: BoardGroup; label: string }> = [
  { key: "needs-you", label: "Needs you" },
  { key: "running", label: "Running" },
  { key: "recent", label: "Finished" },
  { key: "older", label: "Older" },
];

/** the slow safety refresh: a runner that DIES writes nothing, so the stream cannot see it */
export const BOARD_SAFETY_REFRESH_MS = 15_000;

/** rows into their groups, keeping the server's order (sortRuns) inside each */
export function groupRuns(runs: RunBoardRow[], now: number): Array<{ key: BoardGroup; label: string; rows: RunBoardRow[] }> {
  return GROUPS.map((g) => ({ ...g, rows: runs.filter((r) => boardGroup(r, now) === g.key) })).filter((g) => g.rows.length > 0);
}

/**
 * The number beside a group's label. "Needs you" holds two kinds of run: the ones WAITING ON
 * YOU (amber; what the rail's badge and the Needs you screen count) and the ones that stopped
 * and can be resumed or retried (a dead runner, a recoverable failure). A bare "24" under a
 * rail that says "21" reads as one of the two being wrong, so when the group holds both the
 * count says which is which. Neither number changes.
 */
export function groupCount(key: BoardGroup, rows: readonly Pick<RunBoardRow, "status">[]): string | number {
  if (key !== "needs-you") return rows.length;
  const waiting = rows.filter((r) => r.status === "needs-input").length;
  const stopped = rows.length - waiting;
  if (stopped === 0 || waiting === 0) return rows.length;
  return `${rows.length} · ${waiting} waiting on you, ${stopped} to resume or retry`;
}

const money = (n: number) => (n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`);

/**
 * The row's columns, shared by every list that speaks this row language (the inbox uses the
 * same shape with a step column). One line, 36px; the name and the line give, the numbers do not.
 */
export const RUN_ROW = "grid min-h-9 grid-cols-[16px_minmax(0,5fr)_minmax(0,7fr)_88px_60px] items-center gap-x-3 border-b border-border px-2 py-1.5 text-sm leading-[1.4] no-underline";

/** a `RunLine`'s parts, drawn: bold label, mono step id, read text */
export function Line({ line }: { line: RunLine }) {
  const full = line.parts.map((p) => p.value).join(" ");
  return (
    <Truncate text={full} className="text-muted-foreground">
      {line.parts.map((p, i) => (
        // the space between parts is its own text node: inside a mono span it would be a mono-width gap
        <Fragment key={i}>
          {i > 0 ? " " : ""}
          <span className={p.kind === "strong" ? "font-semibold text-foreground" : p.kind === "mono" ? "font-mono text-code text-foreground" : undefined}>{p.value}</span>
        </Fragment>
      ))}
    </Truncate>
  );
}

function Cost({ r }: { r: RunBoardRow }) {
  const cost = r.cost_usd ?? 0; // a row from an older read model carries no cost at all
  if (cost === 0 && r.cost_partial) {
    return <Tooltip side="left" content="No cost reported yet: a turn is still running, or this harness reports none."><span className="text-faint">unknown</span></Tooltip>;
  }
  if (cost <= 0) return <span className="text-faint">—</span>;
  if (r.cost_partial) {
    return <Tooltip side="left" content="A floor, not the bill: a turn is still running, or a harness reported no cost."><span>≥{money(cost)}</span></Tooltip>;
  }
  return <>{money(cost)}</>;
}

function RunRow({ r, now, selected }: { r: RunBoardRow; now: number; selected: boolean }) {
  const line = runLine(r, now);
  const age = runAge(r, now);
  const pr = prChip(r);
  return (
    <Row className={RUN_ROW} href={`/run/${r.id}`} needsInput={r.status === "needs-input"} selected={selected} data-nav-row={r.id}>
      <StatusGlyph status={r.status} label={STATUS_LABEL[r.status]} />
      <span data-col="name" className="flex min-w-0"><Truncate className="text-body font-medium text-foreground">{runLabel(r)}</Truncate></span>
      {/* the PR chip rides at the end of the line's cell: a column of its own would be `auto`, and
          every row is its own grid, so an auto column would knock the rows out of alignment */}
      <span data-col="line" data-quiet={line.quiet ? "true" : "false"} className="flex min-w-0 items-center gap-2">
        <Line line={line} />
        {pr !== null && <span data-col="pr" className="flex shrink-0"><Badge variant={r.pr?.state === "OPEN" || r.pr?.state === "MERGED" ? "outline" : "destructive"}>{pr}</Badge></span>}
      </span>
      <span data-col="age" className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
        <Tooltip side="left" content={age.at ? `${age.what} ${fmtWhen(age.at)}` : null}><span>{age.text}</span></Tooltip>
      </span>
      <span data-col="cost" className="text-right tabular-nums text-muted-foreground"><Cost r={r} /></span>
    </Row>
  );
}

/** what a notification about each waiting run says: its name, and the question (lib/notify.ts) */
export function waitingNotes(runs: readonly RunBoardRow[]): Record<string, { name: string; body: string }> {
  const out: Record<string, { name: string; body: string }> = {};
  for (const r of runs) {
    if (r.status === "needs-input") out[r.id] = { name: runLabel(r), body: parkSummary(r.park ?? { node: r.current?.node }).title };
  }
  return out;
}

function AboutHome({ app }: { app: AppInfo }) {
  return (
    <Popover
      align="end"
      title="This Howdah home"
      className="w-[min(420px,calc(100vw-16px))]"
      trigger={<Button variant="ghost" size="icon" aria-label="About this home: where runs are stored"><Info /></Button>}
    >
      <KeyValue
        labelWidth={84}
        items={[
          { label: "Home", value: app.home, mono: true, copy: true },
          { label: "Source", value: app.repoRoot, mono: true, copy: true },
          { label: "Supervisor", value: app.supervisorHeartbeat ? "Running: a run whose runner dies is resumed automatically." : "Not running." },
        ]}
      />
    </Popover>
  );
}

export function RunsList() {
  const [runs, setRuns] = useState<RunBoardRow[] | null>(null);
  const [app, setApp] = useState<AppInfo | null>(null);
  const [query, setQuery] = useState("");
  const filterRef = useRef<HTMLInputElement | null>(null);
  const now = useNow();
  const [failed, setFailed] = useState(false);
  // a failed refresh keeps the rows already on screen; only a failed FIRST load has nothing to show
  const load = useCallback(() => getJSON<RunBoardRow[]>("/api/runs").then((r) => { setRuns(r); setFailed(false); }).catch(() => setFailed(true)), []);
  useEffect(() => {
    getJSON<AppInfo>("/api/app").then(setApp).catch(() => {});
    void load();
    const t = setInterval(load, BOARD_SAFETY_REFRESH_MS);
    // one stream for the whole board; a change to any run refetches the (incremental) board
    const es = typeof EventSource === "undefined" ? null : new EventSource("/api/board/events");
    if (es) es.onmessage = () => void load();
    return () => { clearInterval(t); es?.close(); };
  }, [load]);
  const waitingIds = runs?.filter((r) => r.status === "needs-input").map((r) => r.id);
  // ALL waiting runs, never the filtered ones: a filter must not make a standing ask look answered
  useAttentionSurfaces(!!waitingIds?.length, runs && waitingIds ? { waiting: waitingIds, cleared: "others", info: waitingNotes(runs) } : null);
  const nav = useListNav({ noun: "run", filterRef, enabled: !!runs?.length });

  if (!runs) return failed ? <Screen name="runs" title="Runs"><LoadError what="the runs" onRetry={() => void load()} /></Screen> : <ScreenLoading name="runs" title="Runs" label="Loading runs" />;

  const shown = runs.filter((r) => matchesFilter(r, query));
  const groups = groupRuns(shown, now);
  const newRun = <a className={buttonVariants()} href="/new"><Plus aria-hidden />New run <Kbd keys="c" decorative /></a>;
  return (
    <Screen
      name="runs"
      title="Runs"
      actions={
        <>
          {runs.length > 0 && (
            <span className="relative block w-56 max-[1099px]:w-44">
              <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
              <Input
                ref={filterRef}
                type="search"
                aria-label="Filter runs by name, graph or status"
                placeholder="Filter runs"
                className="pl-7 pr-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { e.preventDefault(); if (query) setQuery(""); else e.currentTarget.blur(); }
                  if (e.key === "ArrowDown" || e.key === "Enter") { e.preventDefault(); nav.move(1); }
                }}
              />
              {query === "" && <Kbd keys="/" decorative className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2" />}
            </span>
          )}
          {app && <AboutHome app={app} />}
          {newRun}
        </>
      }
      footer={runs.length > 0 ? (
        <KeyHints hints={[{ keys: ["j", "k"], label: "move" }, { keys: ["enter"], label: "open" }, { keys: ["/"], label: "filter" }, { keys: ["g n"], label: "needs you" }, { keys: ["mod+k"], label: "commands" }, { keys: ["?"], label: "all shortcuts" }]} />
      ) : undefined}
    >
      {app && !app.supervisorHeartbeat && runs.length > 0 && (
        <p data-slot="supervisor-note" className="m-0 text-sm text-muted-foreground">
          The supervisor is not running, so a run whose runner dies will not be resumed automatically. Start it with <code className="font-mono text-code text-foreground">bun cli/main.ts up</code>.
        </p>
      )}
      {runs.length === 0 ? (
        <EmptyState mark={<Mark className="mark" />} title="No runs yet" actions={newRun}>
          A run is one graph of agent work against a workspace. Start one here, or from a terminal
          with <code>bun cli/main.ts run &lt;graph&gt;</code>.
        </EmptyState>
      ) : groups.length === 0 ? (
        <EmptyState actions={<Button variant="outline" onClick={() => { setQuery(""); filterRef.current?.focus(); }}>Clear the filter</Button>}>
          No run matches “{query}”. The filter looks at name, goal, id, graph, status and step.
        </EmptyState>
      ) : (
        <div ref={nav.ref} {...nav.containerProps} className="flex flex-col gap-5">
          {groups.map((g) => (
            <section key={g.key} data-group={g.key} aria-label={g.label} className="flex flex-col">
              <SectionLabel as="h2" count={groupCount(g.key, g.rows)} className="border-b border-border px-2 pb-1.5">{g.label}</SectionLabel>
              {g.rows.map((r) => <RunRow key={r.id} r={r} now={now} selected={nav.selected === r.id} />)}
            </section>
          ))}
        </div>
      )}
    </Screen>
  );
}
