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
 *
 * HOW-67 (D-7A) adds a SECOND, quiet group under the asks: "Ready for you", the finished
 * drafts nobody has saved or discarded (GET /api/ready, web/draft.ts `readyDrafts`). It is a
 * separate list on purpose, and it never feeds `useAttentionSurfaces` — amber, the favicon
 * trunk-raise and the chime mean a run cannot proceed without you, and a draft can wait. So its
 * rows are plain (no `needsInput`), its badge is the outline one with a neutral glyph, and its
 * time sits in the muted meta rather than the amber wait timer.
 */
import { useEffect, useState } from "react";
import { Inbox } from "lucide-react";
import type { InboxItem } from "../../../engine/attention-inbox";
import type { ReadyItem } from "../../draft";
import { getJSON } from "@/lib/net";
import { fmtAgo } from "@/lib/liveness";
import { useAttentionSurfaces } from "@/lib/hooks";
import { Badge } from "@/components/ui/badge";
import { Row } from "@/components/ui/row";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingBlock } from "@/components/ui/skeleton";
import { Mark } from "../brand";

export function AttentionInbox() {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [ready, setReady] = useState<ReadyItem[]>([]);
  useEffect(() => {
    const load = () => {
      getJSON<InboxItem[]>("/api/attention").then(setItems).catch(() => {});
      getJSON<ReadyItem[]>("/api/ready").then(setReady).catch(() => {});
    };
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  // the AMBER list only — a ready draft must never raise the favicon or chime (HOW-67)
  useAttentionSurfaces(!!items?.length);

  if (!items) return <LoadingBlock label="Loading what needs you" rows={4} />;
  return (
    <div>
      <h1>Needs you</h1>
      {items.length === 0 ? (
        ready.length === 0 ? (
          <EmptyState mark={<Mark className="mark" />}>nothing needs you — every run is on its own</EmptyState>
        ) : (
          <p className="inbox-note">nothing is waiting on you</p>
        )
      ) : (
        items.map((item) => (
          // href ?? undefined, never a guessed path: the harness record's "run" is the literal
          // string "howdah", and /run/howdah is a page that says the run failed to start. The
          // server decides what each row can link at (engine/attention-inbox.ts `href`); a row
          // with nothing to link at reads as plain text, its reason already naming `howdah up`.
          <Row key={item.id} className="run-row" needsInput href={item.href ?? undefined}>
            <Badge variant="attention">needs you</Badge>
            <span className="run-goal">{item.reason}</span>
            <span className="run-meta">
              {item.run} · {item.node}
            </span>
            <span className="wait-timer">{item.waited}</span>
          </Row>
        ))
      )}
      {ready.length > 0 && (
        <section className="ready-group" aria-label="Ready for you">
          <h2 className="board-group-head" data-group="ready">Ready for you <span className="bv-faint">{ready.length}</span></h2>
          {ready.map((item) => (
            <Row key={item.run} className="run-row" href={item.href}>
              <Badge variant="outline"><Inbox aria-hidden />ready</Badge>
              <span className="run-goal">{item.name || item.intent || item.run}</span>
              <span className="run-meta">
                {item.run} · finished {fmtAgo(Date.now() - new Date(item.finished_at).getTime())} ago
              </span>
            </Row>
          ))}
        </section>
      )}
    </div>
  );
}
