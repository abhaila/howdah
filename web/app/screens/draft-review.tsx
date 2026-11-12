/**
 * /runs/:id/draft — the whole draft, reviewed (HOW-65; HOW-56 D-2A, D-3A, D-4A, D-6A, D-8A).
 *
 * The same list the card in the run's Chat draws (run/draft.tsx DraftList), with the draft
 * PICTURED beside it: a read-only GraphDag, 420px wide, where a step the draft removes is still
 * drawn — dashed, struck through, marked − — and nothing routes into it (D-3A). Focusing or
 * hovering a row lights its box, so "which one is that" is answered without reading ids.
 *
 * This is where "Review and save" lands when the draft grants a new write power (D-6A), so Save
 * is always offered here, beside "Open on canvas" (the builder's `?fromRun=`). Below 1280px the
 * two columns do not fit, and the picture moves under the list behind "Show the draft" — the
 * list carries the decision; the picture helps it.
 *
 * A run with no draft yet says why and links back to it; one still drafting is polled, so the
 * page fills in by itself when the drafter finishes (D-4A).
 *
 * HOW-68 put the page on the shared frame (screens/frame.tsx). The header carries what the
 * draft is and the ONE primary action — Save — so it is on screen however far the list has
 * scrolled; "Open on canvas" and the way back to the run sit beside it as outline controls.
 * The list is a 720px reading column and the picture is a column of its own beside it, with a
 * real height (the DAG's own scroller needs one). Everything about what a draft IS, what Save
 * sends and where provenance comes from is unchanged and still lives in run/draft.tsx and
 * web/draft.ts — this file only frames it.
 */
import { useMemo, useState } from "react";
import { ArrowLeft, PenLine } from "lucide-react";
import { predicateLabel, specFlowEdges } from "../../../core/graph-spec";
import type { ReadyDraft } from "../../draft";
import { GraphDag, type GraphShapeDto } from "../graph-dag";
import {
  BaseChangedBanner, DiscardedReceipt, DraftList, DraftName, DraftReceipt, DraftSummary, draftBasis, useDraftSave, useRunDraft,
} from "../run/draft";
import { Button, buttonVariants } from "@/components/ui/button";
import { navigate } from "@/lib/nav";
import { useMediaQuery } from "@/lib/hooks";
import { EmptyState } from "@/components/ui/empty-state";
import { Truncate } from "@/components/ui/truncate";
import { FieldError, Hint, Screen, ScreenLoading, Section } from "./frame";
import { LINK } from "./prompts";

/** links that wear a button's look: going back to the run is navigation, so they are `<a>`s */
const BACK_LINK = buttonVariants({ variant: "ghost" });
const OUTLINE_LINK = buttonVariants({ variant: "outline" });

/** the width at which the list and the 420px picture sit side by side */
export const WIDE_QUERY = "(min-width: 1280px)";

/**
 * The picture's shape: the draft's steps plus the base's removed ones, and only the draft's
 * routes — so a removed step is drawn and nothing leads into it. Pure, for the test.
 */
export function draftShape(d: ReadyDraft): GraphShapeDto {
  const spec = d.draft.spec;
  const removedIds = new Set(d.diff.removed.map((r) => r.id));
  const removed = (d.base?.nodes ?? []).filter((n) => removedIds.has(n.id));
  const node = (n: (typeof spec.nodes)[number]): GraphShapeDto["nodes"][number] => ({
    id: n.id,
    ...(n.title ? { title: n.title } : {}),
    kind: n.kind,
    ...(n.kind === "agent" ? { prompt: n.prompt } : {}),
    ...(n.kind === "command" ? { run: n.run } : {}),
    ...(n.kind === "wait" ? { duration: n.duration } : {}),
    ...(n.kind === "terminal" ? { outcome: n.outcome } : {}),
  });
  return {
    name: spec.name,
    description: spec.description,
    entry: spec.entry,
    nodes: [...spec.nodes.map(node), ...removed.map(node)],
    edges: specFlowEdges(spec).map((e) => ({ from: e.from, to: e.to, ...(e.when ? { label: predicateLabel(e.when) } : {}), ...(e.kind ? { kind: e.kind } : {}) })),
  };
}

export function DraftReview({ runId }: { runId: string }) {
  const { draft, reload } = useRunDraft(runId, { poll: true });
  const runHref = `/run/${encodeURIComponent(runId)}`;
  if (!draft) return <ScreenLoading name="draft-review" title="Review the draft" label="Reading the draft" />;
  if (draft.state !== "ready") {
    return (
      <Screen name="draft-review" title="Review the draft" width="form">
        <EmptyState title="No draft to review yet" actions={<a className={OUTLINE_LINK} href={runHref}>Back to the run</a>}>
          <p className="m-0 whitespace-pre-wrap">{draft.reason}</p>
        </EmptyState>
      </Screen>
    );
  }
  return <ReadyReview runId={runId} draft={draft} onSaved={reload} />;
}

function ReadyReview({ runId, draft, onSaved }: { runId: string; draft: ReadyDraft; onSaved: () => void }) {
  const s = useDraftSave(runId, draft, onSaved);
  const [focused, setFocused] = useState<string | null>(null);
  const [showPicture, setShowPicture] = useState(false);
  // absent matchMedia (a test DOM) reads as wide, as it always has
  const wide = useMediaQuery(WIDE_QUERY) || typeof window.matchMedia !== "function";
  const shape = useMemo(() => draftShape(draft), [draft]);
  const removed = useMemo(() => new Set(draft.diff.removed.map((r) => r.id)), [draft]);
  const runHref = `/run/${encodeURIComponent(runId)}`;
  const open = !draft.saved && !draft.discarded;
  const picture = (
    <div data-slot="draft-picture" aria-label="the draft, pictured" className="flex h-[min(520px,62dvh)] min-h-[280px] w-full flex-col">
      <GraphDag shape={shape} removed={removed} highlight={focused} />
    </div>
  );
  return (
    <Screen
      name="draft-review"
      title="Review the draft"
      width="full"
      actions={
        <>
          <a className={BACK_LINK} href={runHref}><ArrowLeft aria-hidden />Back to the run</a>
          <Button variant="outline" onClick={() => navigate(draft.saved ? `/graphs/${draft.saved.name}/build` : `/graphs/new?fromRun=${encodeURIComponent(runId)}`)}>
            <PenLine />Open on canvas
          </Button>
          {open && <Button onClick={s.save} loading={s.busy}>{s.busy ? "Saving" : "Save"}</Button>}
        </>
      }
    >
      <div className="flex items-start gap-8">
        <div data-slot="draft-main" className="flex w-full min-w-0 max-w-[720px] flex-col gap-5">
          <Hint className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <span>{draftBasis(draft)} · from run</span>
            <a className={`${LINK} min-w-0 max-w-full`} href={runHref}><Truncate mono middle={10}>{runId}</Truncate></a>
          </Hint>
          {draft.saved ? <DraftReceipt saved={draft.saved} /> : draft.discarded ? <DiscardedReceipt /> : <DraftName ref={s.nameRef} value={s.name} onChange={s.setName} />}
          {s.error && <FieldError pre>{s.error}</FieldError>}
          <DraftSummary draft={draft} />
          <BaseChangedBanner draft={draft} />
          {draft.draft.notes && (
            <Section title="The drafter's notes">
              <p className="m-0 whitespace-pre-wrap text-body leading-normal [overflow-wrap:anywhere]">{draft.draft.notes}</p>
            </Section>
          )}
          <DraftList draft={draft} onFocusRow={setFocused} />
          {!wide && (
            <div className="flex flex-col items-start gap-3">
              <Button variant="outline" size="sm" aria-expanded={showPicture} onClick={() => setShowPicture((v) => !v)}>
                {showPicture ? "Hide the draft" : "Show the draft"}
              </Button>
              {showPicture && picture}
            </div>
          )}
        </div>
        {wide && <div className="sticky top-5 w-[420px] flex-none">{picture}</div>}
      </div>
    </Screen>
  );
}
