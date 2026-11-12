/**
 * The "Needs you" inbox (HOW-20) — the answer to the second half of the complaint: the
 * notifications arrive, and then "what is the problem here, where are they so I can read
 * what the actual issues are?"
 *
 * One row per pending ask, linking to `/run/:id#needs-input`, the card that can actually
 * answer it. It is the same list the watchdog rings by (GET /api/attention runs it through
 * engine/attention-inbox.ts's `stillNeedsHuman`), so the badge and this screen always count
 * the same thing.
 *
 * HOW-68 gave it the Runs list's row language (the audit's 3.1.8: the badge wrapped inside a
 * 26px row, "waiting 19h 0m" printed over the next row, and a 100-character run id took the
 * row while the reason was cut to "output contract …"):
 *
 *   status glyph · run name · WHAT IT IS ASKING · step · how long
 *
 * Every column has a width and every cell that can be long is a `Truncate`, so a row is one
 * 36px line that cannot wrap into its neighbour, and the columns that can be long give in the
 * right order — the reason gets the most room, the step id the least, and an id is cut in the
 * MIDDLE so its distinguishing tail survives. What it is asking is `parkSummary()`'s sentence,
 * joined from the board (GET /api/runs carries each waiting run's park); a record the board
 * does not know — the supervisor's own "harness died", a run whose log cannot be read — falls
 * back to the first line of the record's own reason, which is what the row used to print.
 *
 * The wait comes from the server already phrased (`item.waited`, engine/attention.ts
 * formatWait) rather than being re-derived here — one wait phrasing for the notification and
 * the row. It is plain text now, not amber: the triangle says "waiting on you" once.
 *
 * HOW-67 (D-7A) adds a SECOND, quiet group under the asks: "Ready for you", the finished
 * drafts nobody has saved or discarded (GET /api/ready, web/draft.ts `readyDrafts`). It is a
 * separate list on purpose, and it never feeds `useAttentionSurfaces` — amber, the favicon
 * trunk-raise, the chime and the browser notification mean a run cannot proceed without you,
 * and a draft can wait. So its rows are plain (no `needsInput`), its glyph is the neutral
 * "done" check, and its chip is the outline one.
 */
import { useEffect, useState } from "react";
import { Inbox } from "lucide-react";
import type { InboxItem } from "../../../engine/attention-inbox";
import type { RunBoardRow } from "../../board";
import type { ReadyItem } from "../../draft";
import { runLine, type RunLine } from "@/lib/board";
import { getJSON } from "@/lib/net";
import { runLabel } from "@/lib/format";
import { fmtAgo } from "@/lib/liveness";
import { fmtWhen } from "@/lib/format";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * The server's reading of the wait ("waiting 19h 6m" — a sentence, written for the CLI's
 * inbox), as the column the Runs list prints: the number alone, hours padded ("19h 06m").
 * The figure stays the server's, measured at the moment it answered; only its spelling changes.
 */
export function waitedColumn(waited: string): string {
  return waited.replace(/^waiting\s+/i, "").replace(/^(\d+h) (\d)m$/, "$1 0$2m");
}
import { useAttentionSurfaces } from "@/lib/hooks";
import { useListNav } from "@/lib/list-nav";
import { parkSummary } from "../../../core/park-summary";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Row } from "@/components/ui/row";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionLabel } from "@/components/ui/section-label";
import { Truncate } from "@/components/ui/truncate";
import { Mark } from "../brand";
import { StatusGlyph } from "../status";
import { KeyHints, LIST_HINTS, LoadError, Screen, ScreenLoading } from "./frame";
import { Line } from "./runs";

/**
 * glyph · name · what it asks · how long — one 36px line, nothing wraps.
 *
 * D22: there is no step column. The sentence usually NAMES the step ("implementation.plan
 * failed."), so a fourth column printing the same id beside it cost the sentence a quarter of
 * the row and cut it at 1024. The step id is still on the row: where the sentence does not say
 * it ("Approve? A proposal is waiting for your decision."), it follows the sentence, in mono —
 * in a slot of its own that the sentence cannot push off the row (a first version appended it
 * to the sentence, and a long sentence cut it away entirely).
 */
const INBOX_ROW = "grid min-h-9 grid-cols-[16px_minmax(0,4fr)_minmax(0,9fr)_132px] items-center gap-x-3 border-b border-border px-2 py-1.5 text-sm leading-[1.4] no-underline";

/** the step id to print after the sentence: null when there is none, or the sentence already names it */
function stepAfter(line: RunLine, step: string | null): string | null {
  return step === null || line.parts.some((p) => p.value.includes(step)) ? null : step;
}

const firstLine = (s: string) => (s.split("\n").find((l) => l.trim() !== "") ?? "").trim();

/**
 * What one inbox row says, joined from the board when the board knows the run and its park is
 * THIS ask. Pure, for the test. A harness-level record (`__harness__`) has no step to name.
 */
export function inboxLine(item: InboxItem, row: RunBoardRow | undefined, now: number): { name: string; named: boolean; line: RunLine; body: string; step: string | null; /** the id to print after the sentence, when the sentence does not name it */ stepAfter: string | null } {
  const same = row !== undefined && row.status === "needs-input" && (row.park === null || row.park.node === item.node);
  const step = item.node.startsWith("__") ? null : item.node;
  if (row !== undefined && same) {
    const line = runLine(row, now);
    return { name: runLabel(row), named: !!(row.name || row.goal), line, body: parkSummary(row.park ?? { node: item.node }).title, step, stepAfter: stepAfter(line, step) };
  }
  const said = firstLine(item.reason);
  const fallback: RunLine = { parts: [{ kind: "strong", value: "Needs you." }, { kind: "text", value: said }], quiet: false };
  return {
    name: row ? runLabel(row) : item.run,
    named: !!(row && (row.name || row.goal)),
    line: fallback,
    body: said,
    step,
    stepAfter: stepAfter(fallback, step),
  };
}

export function AttentionInbox() {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [ready, setReady] = useState<ReadyItem[]>([]);
  const [board, setBoard] = useState<RunBoardRow[]>([]);
  // HOW-68: a first read that fails is SAID. This screen used to swallow it and stay on its
  // skeleton for as long as the server was down — on the one screen the operator opens to
  // learn whether anything needs them. Once a list has loaded, a failed poll keeps it.
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const load = () => {
      getJSON<InboxItem[]>("/api/attention").then((i) => { setItems(i); setFailed(false); }).catch(() => setFailed(true));
      getJSON<ReadyItem[]>("/api/ready").then(setReady).catch(() => {});
      // names and parks for the rows; the inbox is still whole without it
      getJSON<RunBoardRow[]>("/api/runs").then((b) => setBoard(Array.isArray(b) ? b : [])).catch(() => {});
    };
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [attempt]);
  const now = Date.now();
  const byId = new Map(board.map((r) => [r.id, r]));
  const rows = (items ?? []).map((item) => ({ item, ...inboxLine(item, byId.get(item.run), now) }));
  // the AMBER list only — a ready draft must never raise the favicon, chime or notify (HOW-67)
  useAttentionSurfaces(!!items?.length, items ? {
    waiting: items.map((i) => i.run),
    cleared: "others",
    info: Object.fromEntries(rows.map((r) => [r.item.run, { name: r.name, body: r.body }])),
  } : null);
  const nav = useListNav({ noun: "ask", enabled: (items?.length ?? 0) + ready.length > 0 });

  if (!items) return failed
    ? <Screen name="attention" title="Needs you"><LoadError what="what needs you" onRetry={() => { setFailed(false); setAttempt((n) => n + 1); }} /></Screen>
    : <ScreenLoading name="attention" title="Needs you" label="Loading what needs you" rows={4} />;
  const nothing = items.length === 0 && ready.length === 0;
  return (
    <Screen
      name="attention"
      title="Needs you"
      description="Runs that cannot go on until you answer."
      footer={nothing ? undefined : <KeyHints hints={LIST_HINTS} />}
    >
      {nothing ? (
        <EmptyState mark={<Mark className="mark" />} title="Nothing needs you" actions={<a className={buttonVariants({ variant: "outline" })} href="/">Go to Runs</a>}>
          Every run is on its own. A run that parks on a question, a failure or
          an approval appears here, and in the count beside “Needs you”.
        </EmptyState>
      ) : (
        <div ref={nav.ref} {...nav.containerProps} className="flex flex-col gap-6">
          {items.length === 0 ? (
            <p data-slot="inbox-note" className="m-0 text-sm text-muted-foreground">Nothing is waiting on you.</p>
          ) : (
            <section aria-label="Waiting on you" className="flex flex-col">
              <SectionLabel as="h2" count={items.length} className="border-b border-border px-2 pb-1.5">Waiting on you</SectionLabel>
              <div role="list" aria-label="Waiting on you">
              {rows.map(({ item, name, named, line, stepAfter: after }) => (
                <div role="listitem" key={item.id}>
                {/* href ?? undefined, never a guessed path: the harness record's "run" is the literal
                    string "howdah", and /run/howdah is a page that says the run failed to start. The
                    server decides what each row can link at (engine/attention-inbox.ts `href`); a row
                    with nothing to link at reads as plain text, its reason already naming `howdah up`.
                    (A `//` comment here is JSX TEXT: wrapping the Row in a listitem once printed this
                    paragraph above every row of the inbox.) */}
                <Row className={INBOX_ROW} needsInput href={item.href ?? undefined} selected={nav.selected === item.id} data-nav-row={item.href ? item.id : undefined}>
                  <StatusGlyph status="needs-input" label="waiting on you" />
                  <span data-col="name" className="flex min-w-0">
                    {named
                      ? <Truncate className="text-body font-medium text-foreground">{name}</Truncate>
                      : <Truncate mono middle={12} className="text-code text-foreground">{name}</Truncate>}
                  </span>
                  <span data-col="line" className="flex min-w-0 items-baseline gap-1.5">
                    <Line line={line} />
                    {after !== null && <span data-slot="inbox-step" className="flex min-w-0 max-w-[45%] shrink-0 items-baseline gap-1.5 text-muted-foreground"><span aria-hidden>·</span><Truncate mono middle={14} className="text-code">{after}</Truncate></span>}
                  </span>
                  {/* the wait, written the way the Runs list writes it ("19h 06m"): under a heading that
                      already says "Waiting on you", the server's "waiting …" said the word 21 times */}
                  {/* the CELL is right-aligned and the tooltip sits inside it, as on the Runs list: with the
                      tooltip outside, its wrapper was the grid cell and the number hung at the cell's left,
                      40px short of the row's edge and of the "finished … ago" column below it */}
                  <span data-col="waited" className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                    <Tooltip side="left" content={`Waiting on you since ${fmtWhen(item.raised_at)}`}><span>{waitedColumn(item.waited)}</span></Tooltip>
                  </span>
                </Row>
                </div>
              ))}
              </div>
            </section>
          )}
          {ready.length > 0 && (
            <section aria-label="Ready for you" className="flex flex-col">
              <SectionLabel as="h2" count={ready.length} className="border-b border-border px-2 pb-1.5">Ready for you</SectionLabel>
              <div role="list" aria-label="Ready for you">
              {ready.map((item) => (
                <div role="listitem" key={item.run}>
                <Row className={INBOX_ROW} href={item.href} selected={nav.selected === `ready:${item.run}`} data-nav-row={`ready:${item.run}`}>
                  <StatusGlyph status="done" label="finished" />
                  <span data-col="name" className="flex min-w-0"><Truncate className="text-body font-medium text-foreground">{item.name || item.intent || item.run}</Truncate></span>
                  <span data-col="line" className="flex min-w-0 items-center gap-2 text-muted-foreground">
                    <Badge variant="outline"><Inbox aria-hidden />ready</Badge>
                    {/* the run id follows the sentence (D22): the same shape as the rows above */}
                    <Truncate text={`A drafted graph, ready to review and save · ${item.run}`}>A drafted graph, ready to review and save · <span className="font-mono text-code">{item.run}</span></Truncate>
                  </span>
                  <span data-col="finished" className="whitespace-nowrap text-right tabular-nums text-muted-foreground">finished {fmtAgo(Date.now() - new Date(item.finished_at).getTime())} ago</span>
                </Row>
                </div>
              ))}
              </div>
            </section>
          )}
        </div>
      )}
    </Screen>
  );
}
