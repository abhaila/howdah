/**
 * The runs list — the app's front door, out of main.tsx (HOW-16 P1).
 *
 * Rows come from `Row`, so the hover, selected and needs-input states are the same three
 * the Steps, Context and Logs rows use rather than a fourth copy (P1.6). Loading is a
 * `Skeleton` in the shape of the list instead of a card that reflows the screen when the
 * data lands, and the empty state is an `EmptyState` — the two are different facts and no
 * longer share a `.empty` div.
 *
 * HOW-50 made it a live BOARD. A single `running` dot beside fourteen `done` rows said nothing
 * about which step a run was on, how long it had been there, whether it had gone quiet, what
 * it had cost or whether it had committed anything. Each row now carries those vital signs
 * (web/board.ts derives them from the log, incrementally), and the list is grouped — Needs you
 * / Running / Recently finished / Older — with needs-you always first, because a run waiting
 * on a human outranks everything (CLAUDE.md). Every group still draws status through the ONE
 * `StatusBadge`. Updates arrive over one board-level SSE stream, never a poll per row.
 *
 * Column widths: the name is the column that gives (`minmax(0, 1fr)`, ellipsis); the vital
 * signs have fixed widths so a long name can never squeeze them. On a narrow screen the vitals
 * drop to a second line under the name rather than being cut.
 */
import { useCallback, useEffect, useState } from "react";
import type { RunBoardRow } from "../../board";
import { boardGroup, type BoardGroup } from "@/lib/board";
import type { AppInfo } from "@/lib/types";
import { getJSON } from "@/lib/net";
import { fmtWait, runLabel } from "@/lib/format";
import { fmtAgo, liveness } from "@/lib/liveness";
import { useAttentionSurfaces, useNow } from "@/lib/hooks";
import { Badge } from "@/components/ui/badge";
import { Row } from "@/components/ui/row";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingBlock } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { StatusBadge } from "../status";
import { Mark } from "../brand";

const GROUPS: Array<{ key: BoardGroup; label: string }> = [
  { key: "needs-you", label: "Needs you" },
  { key: "running", label: "Running" },
  { key: "recent", label: "Recently finished" },
  { key: "older", label: "Older" },
];

/** the slow safety refresh: a runner that DIES writes nothing, so the stream cannot see it */
export const BOARD_SAFETY_REFRESH_MS = 15_000;

/** rows into their groups, keeping the server's order (sortRuns) inside each */
export function groupRuns(runs: RunBoardRow[], now: number): Array<{ key: BoardGroup; label: string; rows: RunBoardRow[] }> {
  return GROUPS.map((g) => ({ ...g, rows: runs.filter((r) => boardGroup(r, now) === g.key) })).filter((g) => g.rows.length > 0);
}

const money = (n: number) => (n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`);

function Vitals({ r, now }: { r: RunBoardRow; now: number }) {
  const live = r.status === "running";
  const { ageMs, quiet } = liveness(r.last_activity_at, now);
  return (
    <span className="board-vitals">
      <span className="bv-step">
        {r.status === "needs-input" && r.waiting_since ? (
          <span className="wait-timer">waiting {fmtWait(r.waiting_since, now)}</span>
        ) : r.current ? (
          <Tooltip content={`${r.current.node}@${r.current.visit}, started ${new Date(r.current.since).toLocaleString()}`}>
            <span className="bv-step-text"><span className="bv-node">{r.current.node}@{r.current.visit}</span> · for {fmtAgo(now - new Date(r.current.since).getTime())}</span>
          </Tooltip>
        ) : (
          <span className="bv-faint">{r.graph}</span>
        )}
      </span>
      <span className="bv-activity" data-quiet={live && quiet ? "true" : "false"}>
        {live && ageMs !== null ? <>active {fmtAgo(ageMs)} ago</> : r.last_event_at ? <span className="bv-faint">{fmtAgo(now - new Date(r.last_event_at).getTime())} ago</span> : "—"}
      </span>
      <span className="bv-cost">
        {r.cost_usd === 0 && r.cost_partial ? (
          <Tooltip content="no cost reported yet: a turn is still running, or the harness reports none (HOW-34)">
            <span className="bv-faint">unknown</span>
          </Tooltip>
        ) : r.cost_usd > 0 ? (
          r.cost_partial ? (
            <Tooltip content="a floor, not the bill: a turn is still running, or a harness reported no cost (HOW-34)">
              <span>≥{money(r.cost_usd)}</span>
            </Tooltip>
          ) : money(r.cost_usd)
        ) : <span className="bv-faint">—</span>}
      </span>
      <span className="bv-commits">
        {r.commits == null ? <span className="bv-faint">—</span> : (
          <Tooltip content="commits between the first and latest HEAD the reconciler observed (as of the last step boundary)">
            <span>{r.commits} commit{r.commits === 1 ? "" : "s"}</span>
          </Tooltip>
        )}
      </span>
      <span className="bv-pr">
        {r.pr ? <Badge variant={r.pr.state === "MERGED" ? "success" : r.pr.state === "OPEN" ? "outline" : "destructive"}>PR {r.pr.state.toLowerCase()}</Badge> : null}
      </span>
    </span>
  );
}

export function RunsList() {
  const [runs, setRuns] = useState<RunBoardRow[] | null>(null);
  const [app, setApp] = useState<AppInfo | null>(null);
  const now = useNow();
  const load = useCallback(() => getJSON<RunBoardRow[]>("/api/runs").then(setRuns).catch(() => {}), []);
  useEffect(() => {
    getJSON<AppInfo>("/api/app").then(setApp).catch(() => {});
    void load();
    const t = setInterval(load, BOARD_SAFETY_REFRESH_MS);
    // one stream for the whole board; a change to any run refetches the (incremental) board
    const es = typeof EventSource === "undefined" ? null : new EventSource("/api/board/events");
    if (es) es.onmessage = () => void load();
    return () => { clearInterval(t); es?.close(); };
  }, [load]);
  useAttentionSurfaces(!!runs?.some((r) => r.status === "needs-input"));

  if (!runs) return <LoadingBlock label="Loading runs" rows={6} />;
  if (runs.length === 0)
    return (
      <EmptyState mark={<Mark className="mark" />}>
        no runs yet — <code>howdah run &lt;graph&gt;</code>
      </EmptyState>
    );
  return (
    <div>
      <h1>Runs</h1>
      {app && (
        <div className="home-strip">
          <span>Home</span><Tooltip content={app.home}><code>{app.home}</code></Tooltip>
          <span>Source</span><Tooltip content={app.repoRoot}><code>{app.source}</code></Tooltip>
          <span>Supervisor</span>
          <Tooltip
            content={app.supervisorHeartbeat
              ? "howdah up is running: a run whose runner dies is resumed automatically"
              : "not seen: no supervisor heartbeat, so a run whose runner dies will NOT be resumed automatically — run `bun cli/main.ts up` (or resume it by hand)"}
          >
            <Badge variant={app.supervisorHeartbeat ? "success" : "outline"}>{app.supervisorHeartbeat ? "heartbeat" : "not seen"}</Badge>
          </Tooltip>
          {!app.supervisorHeartbeat && <span className="home-strip-note">dead runs will not be resumed automatically — run <code>howdah up</code></span>}
        </div>
      )}
      {groupRuns(runs, now).map((g) => (
        <section key={g.key} className="board-group" aria-label={g.label}>
          <h2 className="board-group-head" data-group={g.key}>{g.label} <span className="bv-faint">{g.rows.length}</span></h2>
          {g.rows.map((r) => (
            <Row key={r.id} className="run-row board-row" needsInput={r.status === "needs-input"} href={`/run/${r.id}`}>
              <StatusBadge status={r.status} />
              <span className="run-goal">{runLabel(r)}</span>
              <Vitals r={r} now={now} />
            </Row>
          ))}
        </section>
      ))}
    </div>
  );
}
