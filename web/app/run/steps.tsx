/**
 * The Steps tab and its detail panel (T24, stories 3-5), out of main.tsx (HOW-16 P1).
 *
 * This file hosts BOTH P0 defect 1 call sites: the pane switcher and the Step/Run scope
 * switcher. Their selected styling now comes from `PanelTabs` itself (a cva variant tied to
 * `aria-selected`) rather than from a `.tab.active` rule nothing emitted — see
 * components/ui/tabs.tsx. `itemClassName` is layout only now.
 */
import { useState } from "react";
import { ArrowUp, X } from "lucide-react";
import type { RunDetail } from "../../derive";
import { askRowKey } from "../status";
import { slicePanes, SlicePane, MapProgressLine, type SlicePaneId } from "../slice";
import { fmtDur, liveDuration } from "@/lib/format";
import { PanelTabs } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { Row } from "@/components/ui/row";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { PanelResizer, PanelToggle } from "@/components/ui/panel";
import { readStored, usePanel } from "@/lib/panel";
import { StandingAsk } from "./ask";
import { StepActivity } from "./activity";
import { PromptAndContext } from "./prompt-context";
import { OutputDocs, stepOutputs } from "./document";

/** Status is a SHAPE first (DESIGN.md): the glyph alone must carry the state. */
export function StepGlyph({ status }: { status: "running" | "succeeded" | "failed" | "needs-input" }) {
  const stroke = { strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };
  if (status === "needs-input")
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" className="step-glyph needs-input" aria-label="needs you">
        <path d="M8 2.2 L14.2 13.4 L1.8 13.4 Z" {...stroke} strokeWidth={1.6} />
        <path d="M8 6.4 L8 9.4" {...stroke} strokeWidth={1.6} />
        <circle cx="8" cy="11.4" r="0.9" fill="currentColor" />
      </svg>
    );
  if (status === "failed")
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" className="step-glyph failed" aria-label="failed">
        <path d="M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5" {...stroke} />
      </svg>
    );
  if (status === "running")
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" className="step-glyph running" aria-label="running">
        <circle cx="8" cy="8" r="5.4" {...stroke} strokeWidth={1.6} />
        <path d="M8 2.6 A5.4 5.4 0 0 1 8 13.4 Z" fill="currentColor" />
      </svg>
    );
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" className="step-glyph succeeded" aria-label="succeeded">
      <path d="M3.5 8.5 L6.5 11.5 L12.5 4.5" {...stroke} />
    </svg>
  );
}

/**
 * Steps (T24): one row per node visit on a shared time axis — Inngest's layout. Bars are
 * time-proportional so the shape of the run is legible; a sub-second step still gets 3px,
 * because an invisible mark is a lie about what happened.
 */
export function RunSteps({ timeline, ask, selected, now, onSelect, mapping }: {
  timeline: RunDetail["timeline"];
  ask: RunDetail["ask"];
  selected: string | null;
  now: number;
  onSelect: (key: string) => void;
  /** system-map 1d: an extraction in progress shows "mapping files done/total" on its row */
  mapping?: NonNullable<RunDetail["slice"]>["mapping"];
}) {
  if (timeline.length === 0) return <EmptyState>no steps yet</EmptyState>;
  const askKey = askRowKey(timeline, ask);
  const firstStartedAt = new Date(timeline[0]!.started_at).getTime();
  const liveSpan = Math.max(1, now - firstStartedAt);
  return (
    <div className="steps">
      {timeline.map((t, i) => {
        const span = t.finished_at ? t.run_span_ms || 1 : Math.max(t.run_span_ms || 1, liveSpan);
        const waiting = askKey === `${t.node}@${t.visit}`;
        const status = waiting ? "needs-input" : t.status;
        const total = liveDuration(t, now);
        // the split that makes R3.3 visible: agent time, then the part that was me not looking
        const work = Math.max(0, total - t.waiting_ms);
        const pct = (ms: number) => (ms / span) * 100;
        const key = `${t.node}@${t.visit}`;
        return (
          <Row
            key={`${key}#${i}`}
            className={`step-row ${status}`}
            selected={selected === key}
            needsInput={status === "needs-input"}
            onClick={() => onSelect(key)}
            aria-label={`${key} — ${status}, ${fmtDur(total)}`}
          >
            <span className="step-icon"><StepGlyph status={status} /></span>
            <span className="step-node">
              {t.node}
              {t.visit > 1 && <span className="step-visit">@{t.visit}</span>}
            </span>
            <span className="step-track">
              {/* the two widths are computed from this run's own timings — data, not style */}
              <span className="step-bar" style={{ left: `${pct(t.offset_ms)}%`, width: `${pct(work)}%` }} />
              {t.waiting_ms > 0 && (
                <span
                  className="step-bar waiting"
                  style={{ left: `${pct(t.offset_ms + work)}%`, width: `${pct(t.waiting_ms)}%` }}
                />
              )}
            </span>
            {mapping && mapping.node === t.node && mapping.visit === t.visit && t.status === "running" && <MapProgressLine progress={mapping} />}
            <span className="step-dur">
              {fmtDur(total)}
              {t.waiting_ms > 0 && <span className="step-wait">{fmtDur(t.waiting_ms)}</span>}
            </span>
          </Row>
        );
      })}
    </div>
  );
}

/**
 * The Steps split. The detail panel was a fixed 420px, which the approval card outgrew: a ghost
 * set is the densest thing this viewer renders, and reviewing one in a 420px gutter is the
 * difference between reading a design and squinting at it. Two affordances, because they answer
 * different needs: DRAG when you want both halves at once, FULL when the design is all you care
 * about (the list is one keystroke away again, and the panel header still names the step).
 *
 * The width is an operator preference, so it lives in localStorage and nowhere else — losing it
 * is harmless, it never needs to reach another viewer, and it is emphatically not a fact about
 * the run (the log is the only storage). Every access is wrapped: a private window or blocked
 * site data throws here, and a viewer that cannot remember a width must still render one.
 */
const DETAIL_MIN = 320;
const DETAIL_DEFAULT = 420;
const LIST_MIN = 240; // the waterfall stops being readable below this, so the drag stops here
export const DETAIL_KEY = "howdah.detail";

/**
 * Exported for the component tests. The geometry itself now lives in `lib/panel.ts` — this
 * panel was the only resizable one, and four more surfaces needed the same behaviour, so the
 * implementation moved rather than being copied. The stored key gained a `.width` suffix in
 * that move (it now sits beside `.collapsed`), which costs one remembered width on upgrade:
 * exactly the harmless loss the storage contract is written to tolerate.
 */
export function readDetailWidth(): number {
  return readStored(`${DETAIL_KEY}.width`, DETAIL_DEFAULT, (raw) => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= DETAIL_MIN ? n : null;
  });
}

/**
 * Exported for component tests (web/app/split.test.tsx).
 *
 * Three states now, not two. DRAG when you want both halves at once, FULL when the design is
 * all you care about, and CLOSED when you want the waterfall back on its own — the panel was
 * openable but never closable, which is the one affordance a pane this large has to have.
 * All three are driven from `usePanel`, the same hook the nav, the rail, Logs and Context use.
 */
export function StepsSplit({ list, detail }: { list: React.ReactNode; detail: React.ReactNode }) {
  const panel = usePanel({ key: DETAIL_KEY, min: DETAIL_MIN, def: DETAIL_DEFAULT, minOther: LIST_MIN, side: "right" });
  const [full, setFull] = useState(false);
  // a closed panel cannot also be full width; closing wins, because it is the explicit ask
  const state = panel.collapsed ? "closed" : full ? "full" : "split";

  return (
    // --sd-w is the operator's remembered width, computed from state — a custom property
    // fed by data is the one inline style DESIGN.md keeps (HOW-16 P3.13)
    <div
      className="steps-split"
      ref={panel.boxRef}
      data-detail={state === "full" ? "full" : "split"}
      data-pane={state === "closed" ? "closed" : "open"}
      style={{ ["--sd-w" as string]: `${panel.width}px` }}
    >
      {state !== "full" && list}
      <PanelResizer panel={panel} label="the detail panel" disabled={state === "full"}>
        <div className="pane-controls">
          <PanelToggle panel={panel} label="the detail panel" side="right" />
          {/* full width is a separate axis from open/closed, so it keeps its own control */}
          {state !== "closed" && (
            <Tooltip content={full ? "restore the step list" : "full width"}>
              <Button
                variant="outline"
                size="icon"
                className="pane-toggle"
                data-control="full"
                aria-pressed={full}
                aria-label={full ? "restore the step list" : "expand the detail panel to full width"}
                onPointerDown={(e) => e.stopPropagation()} /* the button is a click, never a drag */
                onClick={() => setFull(!full)}
              >
                {full ? <X size={11} /> : <ArrowUp size={11} className="-rotate-90" />}
              </Button>
            </Tooltip>
          )}
        </div>
      </PanelResizer>
      {state !== "closed" && detail}
    </div>
  );
}

/**
 * Step detail (T24, story 5) — Inngest's right-hand panel. The ask lives HERE rather than
 * floating in the thread, and the Run toggle keeps the run-level facts one click away.
 *
 * Exported for component tests (web/app/steps.test.tsx): the pane routing lives here.
 */
export function StepDetail({ runId, row, detail, ask, now, onResolved }: {
  runId: string;
  row: RunDetail["timeline"][number] | null;
  detail: RunDetail;
  ask: RunDetail["ask"];
  now: number;
  onResolved: () => void;
}) {
  const [scope, setScope] = useState<"step" | "run">("step");
  const [pane, setPane] = useState<"ask" | "activity" | "prompt" | "output" | SlicePaneId | null>(null);
  // an ask on a node that has no step row at all (e.g. approval-missing after a jump to a node
  // that never ran): no row can carry it, so the panel carries it — the operator is never left
  // with a needs-you banner and nothing to answer
  const rowlessAsk = ask !== null && askRowKey(detail.timeline, ask) === null ? ask : null;
  const rowlessAskCard = rowlessAsk && (
    <div className="sd-body sd-rowless-ask" data-testid="rowless-ask">
      <div className="pd-note">{rowlessAsk.node} has no step yet — it parked before its first attempt started</div>
      <StandingAsk key={`${rowlessAsk.node}@${rowlessAsk.visit}#${rowlessAsk.seq}`} runId={runId} ask={rowlessAsk} detail={detail} onResolved={onResolved} />
    </div>
  );
  if (!row) return <div className="step-detail">{rowlessAskCard ?? <EmptyState>pick a step</EmptyState>}</div>;

  const key = `${row.node}@${row.visit}`;
  const isAsking = ask !== null && askRowKey(detail.timeline, ask) === key;
  // system-map 1d: the slice panes (approval card, drift, map) live in THIS panel's slot.
  // Only an awaiting-approval ask IS the approval card (Ask is hidden then); any other park on
  // the step (attempt-failed, max-visits, …) is answered by a reply, so Ask stays and leads.
  const slicePaneList = slicePanes(detail.slice, row);
  const decidedOnCard = isAsking && ask!.code === "awaiting-approval" && slicePaneList.some((p) => p.value === "approval");
  const askFirst = isAsking && !decidedOnCard;
  const askPane = { value: "ask" as const, label: "Ask" };
  const panes: Array<{ value: NonNullable<typeof pane>; label: string }> = [
    ...(askFirst ? [askPane] : []),
    ...slicePaneList,
    // Activity leads whenever nothing is waiting on you. It used to sit BEHIND the Ask pane,
    // so opening any finished step landed on "this step is not waiting on you" — a dead pane
    // as the default view, with the step's actual story one click to the right.
    { value: "activity", label: "Activity" },
    ...(askFirst || decidedOnCard ? [] : [askPane]),
    { value: "prompt", label: "Prompt & context" },
    { value: "output", label: "Output" },
  ];
  const shown = panes.find((p) => p.value === pane)?.value ?? panes[0]!.value;
  const render = detail.renders.find((r) => r.node === row.node && r.visit === row.visit);
  const total = liveDuration(row, now);
  const work = Math.max(0, total - row.waiting_ms);
  const bar = (label: string, ms: number, of: number, cls: string) => (
    <div className="sd-seg">
      <div className="sd-seg-head"><span>{label}</span><span className="m">{fmtDur(ms)}</span></div>
      {/* the fill's width IS the timing — a custom value from data, not a static style */}
      <div className="sd-seg-track"><span className={`sd-seg-fill ${cls}`} style={{ width: `${of > 0 ? (ms / of) * 100 : 0}%` }} /></div>
    </div>
  );

  return (
    <div className="step-detail">
      <PanelTabs className="sd-scope" look="chip" value={scope} onValueChange={setScope} items={[{ value: "step", label: "Step" }, { value: "run", label: "Run" }]} />
      {rowlessAskCard}

      {scope === "run" ? (
        <div className="sd-body">
          <h2 className="rh">Identity</h2>
          <div className="kv"><span className="k">run</span><span className="v">{runId}</span></div>
          <div className="kv"><span className="k">graph</span><span className="v">{detail.summary.graph}</span></div>
          {detail.git?.intended?.branch && <div className="kv"><span className="k">branch</span><span className="v">{detail.git.intended.branch}</span></div>}
          {detail.git && (
            <>
              <h2 className="rh">Git</h2>
              <div className="kv"><span className="k">uncommitted</span><span className="v">{detail.git.git.uncommitted}</span></div>
              <div className="kv"><span className="k">unpushed</span><span className="v">{detail.git.git.unpushed ?? "no upstream"}</span></div>
            </>
          )}
          <h2 className="rh">Usage</h2>
          <div className="kv"><span className="k">input</span><span className="v">{detail.usage.input_tokens.toLocaleString()}</span></div>
          <div className="kv"><span className="k">output</span><span className="v">{detail.usage.output_tokens.toLocaleString()}</span></div>
          <div className="kv"><span className="k">cost</span><span className="v">${detail.usage.cost_usd.toFixed(4)}</span></div>
          {detail.allowance.map((a) => (
            <div key={a.harness} className="kv">
              <span className="k">{a.harness}</span>
              <span className={`v ${a.state === "exhausted" ? "allowance-exhausted" : ""}`}>
                {a.state === "ok" && a.remaining !== undefined ? `${Math.round(a.remaining * 100)}% left` : a.state}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="sd-head">
            <StepGlyph status={isAsking ? "needs-input" : row.status} />
            <span className="m sd-node">{row.node}</span>
            <span className="m sd-visit">@{row.visit}</span>
            <span className="m sd-total">{fmtDur(total)}</span>
          </div>
          <div className="sd-timing">
            {bar("agent working", work, total, "work")}
            {row.waiting_ms > 0 && bar("waiting on you", row.waiting_ms, total, "waiting")}
          </div>
          <PanelTabs value={shown} onValueChange={setPane} items={panes} />
          <div className="sd-body">
            {(shown === "approval" || shown === "drift" || shown === "map") && detail.slice && (
              <SlicePane pane={shown} runId={runId} slice={detail.slice} row={row} onChanged={onResolved} />
            )}
            {shown === "ask" && (isAsking
              ? <StandingAsk key={`${ask!.node}@${ask!.visit}#${ask!.seq}`} runId={runId} ask={ask!} detail={detail} onResolved={onResolved} />
              : <div className="pd-note">this step is not waiting on you</div>)}
            {shown === "activity" && (
              <StepActivity turns={detail.turns} render={render} row={row} context={detail.context} />
            )}
            {shown === "prompt" && (render
              ? <PromptAndContext runId={runId} render={render} />
              : <div className="pd-note">this step rendered no prompt (it is not an agent step)</div>)}
            {shown === "output" && (() => {
              const finished = detail.outcomes.find((o) => o.node === row.node && o.visit === row.visit);
              const published = stepOutputs(detail, row.node, row.visit);
              return (
                <>
                  <div className="kv"><span className="k">status</span><span className="v">{row.status}</span></div>
                  {finished?.verdict_downstream && <div className="kv"><span className="k">routed</span><span className="v">{finished.verdict_downstream}</span></div>}
                  {!finished && <div className="pd-note">no outcome recorded for {key} yet</div>}
                  {published && <h2 className="rh">Published</h2>}
                  {published && <OutputDocs outputs={published} />}
                </>
              );
            })()}
          </div>
        </>
      )}
    </div>
  );
}
