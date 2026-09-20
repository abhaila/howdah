/**
 * The "Needs you" inbox (HOW-20) — the answer to the second half of the complaint: the
 * notifications arrive, and then "what is the problem here, where are they so I can read
 * what the actual issues are?"
 *
 * One row per pending ask: which run, which node, the reason in the operator's own words,
 * and how long it has been standing — linking to `/run/:id#needs-input`, the card that can
 * actually answer it. It is the same list the watchdog rings by (GET /api/attention runs it
 * through engine/attention-inbox.ts's `stillNeedsHuman`), so the badge, the banner and this
 * screen always count the same thing.
 *
 * The wait comes from the server already phrased (`item.waited`, engine/attention.ts
 * formatWait) rather than being re-derived here — one wait phrasing for the notification and
 * the row, which is exactly what made the two disagree before.
 */
import { useEffect, useState } from "react";
import type { InboxItem } from "../../../engine/attention-inbox";
import { getJSON } from "@/lib/net";
import { useAttentionSurfaces } from "@/lib/hooks";
import { Badge } from "@/components/ui/badge";
import { Row } from "@/components/ui/row";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingBlock } from "@/components/ui/skeleton";
import { Mark } from "../brand";

export function AttentionInbox() {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  useEffect(() => {
    const load = () => getJSON<InboxItem[]>("/api/attention").then(setItems).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  useAttentionSurfaces(!!items?.length);

  if (!items) return <LoadingBlock label="Loading what needs you" rows={4} />;
  return (
    <div>
      <h1>Needs you</h1>
      {items.length === 0 ? (
        <EmptyState mark={<Mark className="mark" />}>nothing needs you — every run is on its own</EmptyState>
      ) : (
        items.map((item) => (
          <Row key={item.id} className="run-row" needsInput href={`/run/${item.run}#needs-input`}>
            <Badge variant="attention">needs you</Badge>
            <span className="run-goal">{item.reason}</span>
            <span className="run-meta">
              {item.run} · {item.node}
            </span>
            <span className="wait-timer">{item.waited}</span>
          </Row>
        ))
      )}
    </div>
  );
}
