/**
 * The runs list — the app's front door, out of main.tsx (HOW-16 P1).
 *
 * Rows come from `Row`, so the hover, selected and needs-input states are the same three
 * the Steps, Context and Logs rows use rather than a fourth copy (P1.6). Loading is a
 * `Skeleton` in the shape of the list instead of a card that reflows the screen when the
 * data lands, and the empty state is an `EmptyState` — the two are different facts and no
 * longer share a `.empty` div.
 */
import { useEffect, useState } from "react";
import type { RunSummary } from "../../derive";
import type { AppInfo } from "@/lib/types";
import { getJSON } from "@/lib/net";
import { fmtWait, runLabel } from "@/lib/format";
import { useAttentionSurfaces, useNow } from "@/lib/hooks";
import { Badge } from "@/components/ui/badge";
import { Row } from "@/components/ui/row";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingBlock } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { StatusBadge } from "../status";
import { Mark } from "../brand";

export function RunsList() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [app, setApp] = useState<AppInfo | null>(null);
  const now = useNow();
  useEffect(() => {
    const load = () => getJSON<RunSummary[]>("/api/runs").then(setRuns).catch(() => {});
    getJSON<AppInfo>("/api/app").then(setApp).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
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
          <span>Supervisor</span><Badge variant={app.supervisorHeartbeat ? "success" : "outline"}>{app.supervisorHeartbeat ? "heartbeat" : "not seen"}</Badge>
        </div>
      )}
      {runs.map((r) => (
        <Row key={r.id} className="run-row" needsInput={r.status === "needs-input"} href={`/run/${r.id}`}>
          <StatusBadge status={r.status} />
          <span className="run-goal">{runLabel(r)}</span>
          <span className="run-meta">
            {r.status === "needs-input" && r.waiting_since
              ? <span className="wait-timer">waiting {fmtWait(r.waiting_since, now)}</span>
              : r.graph}
          </span>
        </Row>
      ))}
    </div>
  );
}
