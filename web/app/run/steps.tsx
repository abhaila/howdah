/**
 * The Steps tab and its detail panel (T24, stories 3-5), out of main.tsx (HOW-16 P1).
 *
 * HOW-68 rebuilt the surface on the shared pieces (components/ui/panel.tsx): the list and the
 * detail sit in `SplitView`, the detail is a `DetailPanel`, and selection moves with J/K and
 * the arrows through `useListKeys`. What that cleared, from the audit:
 *
 *   §3.1.7 — the duration and wait columns were the tail of a flex row that the splitter cut
 *   ("8m 2", "21."). A row is a GRID now with two fixed numeric columns; the name and the
 *   timeline bar are what give way, and the name is a `Truncate` so what it cuts can be read.
 *   §3.1.4 — at 1024px the list was squeezed to 8px. Below 1100px of pane the detail replaces
 *   the list, with a Back control and Esc.
 *   §3.5 — the Step/Run scope chips measured 23px. It is a segmented control of 24px tabs.
 *
 * AMBER IS SAID ONCE. A step's wait used to be amber wherever it appeared — a column of amber
 * durations and amber bar segments on a run that needed nothing. Past waits are neutral now
 * (a lighter segment and a "Waited" column); only the step that is waiting on you RIGHT NOW
 * carries the amber glyph and the amber segment.
 */
import { useState } from "react";
import type { RunDetail } from "../../derive";
import { StatusGlyph, askRowKey, stepKey } from "../status";
import { slicePanes, SlicePane, MapProgressLine, type SlicePaneId } from "../slice";
import { fmtDur, liveDuration } from "@/lib/format";
import { PanelTabs } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { Row } from "@/components/ui/row";
import { KeyValue, type KeyValueItem } from "@/components/ui/key-value";
import { SectionLabel } from "@/components/ui/section-label";
import { ScrollPane } from "@/components/ui/scroll-pane";
import { Truncate } from "@/components/ui/truncate";
import { DetailPanel, SplitView, useListKeys, useSplit } from "@/components/ui/panel";
import { readStored } from "@/lib/panel";
import { StandingAsk } from "./ask";
import { StepActivity } from "./activity";
import { PromptAndContext } from "./prompt-context";
import { OutputDocs, stepOutputs } from "./document";
import { usageItems } from "./usage";
import { describeProfile } from "../../../log/trajectory";

type StepStatus = "running" | "succeeded" | "failed" | "needs-input";
const STEP_WORD: Record<StepStatus, string> = { running: "running", succeeded: "succeeded", failed: "failed", "needs-input": "waiting on you" };
/** a quiet line of explanation inside a pane */
const NOTE = "m-0 text-sm leading-[1.5] text-muted-foreground";

/**
 * Status is a SHAPE first (DESIGN.md): the glyph alone must carry the state. The shapes are
 * the app's ONE set (`StatusGlyph`, ../status.tsx) — a step's four states map onto the run
 * statuses that draw them, so a step and a run can never be drawn two ways.
 */
export function StepGlyph({ status }: { status: StepStatus }) {
  const as = status === "needs-input" ? "needs-input" : status === "failed" ? "failed-recoverable" : status === "running" ? "running" : "done";
  return <StatusGlyph status={as} label={STEP_WORD[status]} className={`step-glyph ${status}`} />;
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
  const split = useSplit();
  const keys = useListKeys({ ids: timeline.map(stepKey), selected, onSelect, name: "step" });
  if (timeline.length === 0)
    return <EmptyState title="No steps yet">Each step the run starts appears here as a row, with how long it took and how long it waited on you.</EmptyState>;
  const askKey = askRowKey(timeline, ask);
  const firstStartedAt = new Date(timeline[0]!.started_at).getTime();
  const liveSpan = Math.max(1, now - firstStartedAt);
  const row = (t: RunDetail["timeline"][number], i: number) => {
    const span = t.finished_at ? t.run_span_ms || 1 : Math.max(t.run_span_ms || 1, liveSpan);
    const waiting = askKey === stepKey(t);
    const status: StepStatus = waiting ? "needs-input" : t.status;
    const total = liveDuration(t, now);
    // the split that makes R3.3 visible: agent time, then the part that was me not looking
    const work = Math.max(0, total - t.waiting_ms);
    const pct = (ms: number) => (ms / span) * 100;
    // the row's identity: `node@visit`, or `node@visit#2` for a second attempt of the same visit
    const key = stepKey(t);
    const name = `${t.node}@${t.visit}`;
    const isMapping = mapping && mapping.node === t.node && mapping.visit === t.visit && t.status === "running";
    return (
      <Row
        key={key}
        className={`step-row ${status}${t.parallel ? " branch" : ""}`}
        data-status={status}
        selected={selected === key}
        needsInput={status === "needs-input"}
        onClick={() => { onSelect(key); split.open(); }}
        aria-label={`${name} — ${STEP_WORD[status]}, ${fmtDur(total)}${t.waiting_ms > 0 ? `, waited ${fmtDur(t.waiting_ms)}` : ""}`}
      >
        <StepGlyph status={status} />
        <span className="flex min-w-0 items-baseline gap-1">
          <Truncate mono middle={12} className={status === "succeeded" ? "text-sm text-muted-foreground" : "text-sm text-foreground"}>{t.node}</Truncate>
          {t.visit > 1 && <span className="shrink-0 font-mono text-xs text-faint">@{t.visit}</span>}
        </span>
        {isMapping ? <MapProgressLine progress={mapping} /> : (
          <span className="step-track" aria-hidden>
            {/* the two widths are computed from this run's own timings — data, not style */}
            <span className="step-bar" style={{ left: `${pct(t.offset_ms)}%`, width: `${pct(work)}%` }} />
            {t.waiting_ms > 0 && (
              <span className="step-bar waiting" style={{ left: `${pct(t.offset_ms + work)}%`, width: `${pct(t.waiting_ms)}%` }} />
            )}
          </span>
        )}
        <span className="text-right text-sm tabular-nums text-muted-foreground">{fmtDur(total)}</span>
        <span className="text-right text-sm tabular-nums text-faint">{t.waiting_ms > 0 ? fmtDur(t.waiting_ms) : ""}</span>
      </Row>
    );
  };
  return (
    <>
      {/* the columns are named once, in words — the wait column is not told apart by colour */}
      <div className="step-row step-head border-b border-border text-xs font-semibold text-muted-foreground" aria-hidden>
        <span />
        <span>Step</span>
        <span>Timeline</span>
        <span className="text-right">Took</span>
        <span className="text-right">Waited</span>
      </div>
      <ScrollPane label="Steps">
        <div className="steps" ref={keys.ref} onKeyDown={keys.onKeyDown}>
          {parallelBlocks(timeline).map((block) =>
            block.group ? (
              // HOW-73: the branches of one parallel visit, side by side in time — one block, so
              // their bars read as concurrent rather than as steps that happened to overlap
              <div key={`group-${block.first}`} className="step-group" role="group" aria-label={`${block.group} — ${block.rows.length} steps at once`}>
                {block.rows.map(([t, i]) => row(t, i))}
              </div>
            ) : (
              block.rows.map(([t, i]) => row(t, i))
            ),
          )}
        </div>
      </ScrollPane>
    </>
  );
}

/**
 * HOW-73: the timeline cut into runs of rows — consecutive branch rows of the same parallel
 * visit form one block (`group` = `node@visit` of the parallel step), every other row is a block
 * of its own. Order is the timeline's, so nothing moves; a branch re-run after a resume (its
 * parallel step's row comes first) starts a block of its own.
 */
export function parallelBlocks(timeline: RunDetail["timeline"]): Array<{ group: string | null; first: number; rows: Array<[RunDetail["timeline"][number], number]> }> {
  const out: Array<{ group: string | null; first: number; rows: Array<[RunDetail["timeline"][number], number]> }> = [];
  timeline.forEach((t, i) => {
    const group = t.parallel ? `${t.parallel.node}@${t.parallel.visit}` : null;
    const last = out.at(-1);
    if (group && last?.group === group) last.rows.push([t, i]);
    else out.push({ group, first: i, rows: [[t, i]] });
  });
  return out;
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
 * Three states: DRAG when you want both halves at once, FULL when the design is all you care
 * about, and CLOSED when you want the waterfall back on its own. HOW-68: the mechanics are
 * `SplitView` (components/ui/panel.tsx), shared with Logs and Context — which also adds the
 * narrow shape (the detail replaces the list under 1100px) and Esc.
 */
export function StepsSplit({ list, detail, openRequest }: {
  list: React.ReactNode;
  detail: React.ReactNode;
  /** bumped when a step is chosen from OUTSIDE the list (Build, the Details timeline): show its detail */
  openRequest?: number;
}) {
  return (
    <SplitView
      className="steps-split"
      openRequest={openRequest}
      storageKey={DETAIL_KEY}
      min={DETAIL_MIN}
      def={DETAIL_DEFAULT}
      minList={LIST_MIN}
      allowFull
      label="the detail panel"
      listLabel="Steps"
      list={list}
      detail={detail}
    />
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
    <div className="sd-rowless-ask flex flex-col gap-2" data-testid="rowless-ask">
      <p className={NOTE}><span className="font-mono">{rowlessAsk.node}</span> has no step yet — it parked before its first attempt started</p>
      <StandingAsk key={`${rowlessAsk.node}@${rowlessAsk.visit}#${rowlessAsk.seq}`} runId={runId} ask={rowlessAsk} detail={detail} onResolved={onResolved} />
    </div>
  );
  if (!row)
    return (
      <DetailPanel label="Step detail">
        {rowlessAskCard ?? <EmptyState title="No step selected">Pick a step on the left to see what it did, what it read and what it published.</EmptyState>}
      </DetailPanel>
    );

  const key = `${row.node}@${row.visit}`;
  // the ask belongs to the LATEST attempt of its visit (an earlier, failed attempt of the same
  // approval visit is history, and must not offer the decision a second time)
  const isAsking = ask !== null && askRowKey(detail.timeline, ask) === stepKey(row);
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
  const status: StepStatus = isAsking ? "needs-input" : row.status;
  const bar = (label: string, ms: number, of: number, cls: string) => (
    <div className="sd-seg">
      <div className="flex justify-between text-xs text-muted-foreground"><span>{label}</span><span className="tabular-nums">{fmtDur(ms)}</span></div>
      {/* the fill's width IS the timing — a custom value from data, not a static style */}
      <div className="sd-seg-track"><span className="sd-seg-fill" data-kind={cls} style={{ width: `${of > 0 ? (ms / of) * 100 : 0}%` }} /></div>
    </div>
  );

  const head = (
    <div className="flex flex-col gap-2 pb-3">
      <div className="sd-head flex min-w-0 items-center gap-2">
        {scope === "step" && <StepGlyph status={status} />}
        <h2 className="m-0 flex min-w-0 flex-1 items-baseline gap-1 text-md font-semibold">
          {scope === "step"
            ? <><Truncate mono middle={14}>{row.node}</Truncate><span className="shrink-0 font-mono text-xs font-normal text-faint">@{row.visit}</span></>
            : <Truncate>The whole run</Truncate>}
        </h2>
        <PanelTabs
          className="sd-scope" look="segment" value={scope} onValueChange={setScope}
          items={[{ value: "step", label: "Step" }, { value: "run", label: "Run" }]}
        />
      </div>
      {scope === "step" && (
        <>
          <div className="flex flex-wrap items-baseline gap-x-2 text-sm text-muted-foreground">
            <span>{STEP_WORD[status]}</span>
            <span aria-hidden>·</span>
            <span className="sd-total tabular-nums">{fmtDur(total)}</span>
            {row.waiting_ms > 0 && <><span aria-hidden>·</span><span className="tabular-nums">waited on you {fmtDur(row.waiting_ms)}</span></>}
          </div>
          <div className="flex flex-col gap-2">
            {bar("Agent working", work, total, "work")}
            {row.waiting_ms > 0 && bar("Waiting on you", row.waiting_ms, total, isAsking ? "waiting-now" : "waiting")}
          </div>
          {/* HOW-35: what the agent did, by rule from its tool calls */}
          {row.profile && <p className={NOTE} data-testid="step-profile">{describeProfile(row.profile)}</p>}
        </>
      )}
    </div>
  );

  if (scope === "run") {
    const identity: KeyValueItem[] = [
      { label: "Run", value: runId, mono: true, copy: true },
      { label: "Graph", value: detail.summary.graph, mono: true },
      ...(detail.git?.intended?.branch ? [{ label: "Branch", value: detail.git.intended.branch, mono: true, copy: true }] : []),
    ];
    return (
      <DetailPanel label="Run summary" head={head} bodyClassName="flex flex-col gap-2">
        {rowlessAskCard}
        <SectionLabel as="h3">Identity</SectionLabel>
        <KeyValue items={identity} labelWidth={104} />
        {detail.git && (
          <>
            <SectionLabel as="h3" className="mt-2">Git</SectionLabel>
            <KeyValue labelWidth={104} items={[
              { label: "Uncommitted", value: String(detail.git.git.uncommitted) },
              { label: "Unpushed", value: String(detail.git.git.unpushed ?? "no upstream") },
            ]} />
          </>
        )}
        <SectionLabel as="h3" className="mt-2">Usage</SectionLabel>
        <KeyValue labelWidth={104} items={[
          ...usageItems(detail.usage),
          ...detail.allowance.map((a) => ({
            label: a.harness,
            value: a.state === "exhausted"
              ? <span className="text-destructive">exhausted</span>
              : a.state === "ok" && a.remaining !== undefined ? `${Math.round(a.remaining * 100)}% left` : a.state,
          })),
        ]} />
      </DetailPanel>
    );
  }

  return (
    <DetailPanel
      label={`Step ${key}`}
      head={head}
      strip={<PanelTabs value={shown} onValueChange={setPane} items={panes} />}
    >
      {rowlessAskCard && <div className="mb-3">{rowlessAskCard}</div>}
      {(shown === "approval" || shown === "drift" || shown === "map") && detail.slice && (
        <SlicePane pane={shown} runId={runId} slice={detail.slice} row={row} onChanged={onResolved} />
      )}
      {shown === "ask" && (isAsking
        ? <StandingAsk key={`${ask!.node}@${ask!.visit}#${ask!.seq}`} runId={runId} ask={ask!} detail={detail} onResolved={onResolved} />
        : <p className={NOTE}>This step is not waiting on you.</p>)}
      {shown === "activity" && (
        <StepActivity
          turns={detail.turns} render={render} row={row} context={detail.context}
          state={detail.turn_states[`${row.node}@${row.visit}`]} lastActivityAt={detail.last_agent_event_at}
        />
      )}
      {shown === "prompt" && (render
        ? <PromptAndContext runId={runId} render={render} defaultOpen />
        : <p className={NOTE}>This step rendered no prompt — it is not an agent step.</p>)}
      {shown === "output" && (() => {
        const finished = detail.outcomes.find((o) => o.node === row.node && o.visit === row.visit);
        const published = stepOutputs(detail, row.node, row.visit);
        return (
          <div className="flex flex-col gap-2">
            <KeyValue labelWidth={104} items={[
              { label: "Status", value: row.status },
              ...(finished?.verdict_downstream ? [{ label: "Routed", value: finished.verdict_downstream, mono: true }] : []),
            ]} />
            {!finished && <p className={NOTE}>No outcome recorded for <span className="font-mono">{key}</span> yet.</p>}
            {published && <SectionLabel as="h3" className="mt-2">Published</SectionLabel>}
            {published && <OutputDocs outputs={published} />}
            {row.usage && <SectionLabel as="h3" className="mt-2">Usage{row.usage.harness ? ` · ${row.usage.harness}` : ""}</SectionLabel>}
            {row.usage && <KeyValue labelWidth={104} items={usageItems(row.usage)} />}
          </div>
        );
      })()}
    </DetailPanel>
  );
}
