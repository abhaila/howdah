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
 */
import { useEffect, useMemo, useState } from "react";
import { predicateLabel } from "../../../core/graph-spec";
import type { ReadyDraft } from "../../draft";
import { GraphDag, type GraphShapeDto } from "../graph-dag";
import {
  BaseChangedBanner, DraftList, DraftName, DraftReceipt, DraftSummary, draftBasis, useDraftSave, useRunDraft,
} from "../run/draft";
import { Button } from "@/components/ui/button";
import { navigate } from "@/lib/nav";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingBlock } from "@/components/ui/skeleton";

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
    edges: spec.edges.map((e) => ({ from: e.from, to: e.to, ...(e.when ? { label: predicateLabel(e.when) } : {}) })),
  };
}

function useWide(): boolean {
  const query = useMemo(() => (typeof window.matchMedia === "function" ? window.matchMedia(WIDE_QUERY) : null), []);
  const [wide, setWide] = useState(query?.matches ?? true);
  useEffect(() => {
    if (!query) return;
    const on = () => setWide(query.matches);
    query.addEventListener?.("change", on);
    return () => query.removeEventListener?.("change", on);
  }, [query]);
  return wide;
}

export function DraftReview({ runId }: { runId: string }) {
  const { draft, reload } = useRunDraft(runId, { poll: true });
  const runHref = `/run/${encodeURIComponent(runId)}`;
  if (!draft) return <div className="runs"><LoadingBlock label="Reading the draft" rows={6} /></div>;
  if (draft.state !== "ready") {
    return (
      <div className="runs">
        <h1>Review the draft</h1>
        <EmptyState>
          <p className="wrap-pre">{draft.reason}</p>
          <p><a href={runHref}>Back to the run</a></p>
        </EmptyState>
      </div>
    );
  }
  return <ReadyReview runId={runId} draft={draft} onSaved={reload} />;
}

function ReadyReview({ runId, draft, onSaved }: { runId: string; draft: ReadyDraft; onSaved: () => void }) {
  const s = useDraftSave(runId, draft, onSaved);
  const [focused, setFocused] = useState<string | null>(null);
  const [showPicture, setShowPicture] = useState(false);
  const wide = useWide();
  const shape = useMemo(() => draftShape(draft), [draft]);
  const removed = useMemo(() => new Set(draft.diff.removed.map((r) => r.id)), [draft]);
  const picture = (
    <div className="draft-picture" aria-label="the draft, pictured">
      <GraphDag shape={shape} removed={removed} highlight={focused} />
    </div>
  );
  return (
    <div className="runs draft-page">
      <div className="draft-page-main">
        <div className="draft-head">
          <h1>Review the draft</h1>
          <p className="draft-basis">{draftBasis(draft)} · from run <a href={`/run/${encodeURIComponent(runId)}`}>{runId}</a></p>
        </div>
        {draft.saved ? <DraftReceipt saved={draft.saved} /> : <DraftName ref={s.nameRef} value={s.name} onChange={s.setName} />}
        <DraftSummary draft={draft} />
        <BaseChangedBanner draft={draft} />
        {draft.draft.notes && <p className="draft-note">{draft.draft.notes}</p>}
        <div className="actions">
          {!draft.saved && <Button onClick={s.save} disabled={s.busy}>{s.busy ? "Saving…" : "Save"}</Button>}
          <Button variant="outline" onClick={() => navigate(`/run/${encodeURIComponent(runId)}`)}>Back to the chat</Button>
          <Button variant="outline" onClick={() => navigate(draft.saved ? `/graphs/${draft.saved.name}/build` : `/graphs/new?fromRun=${encodeURIComponent(runId)}`)}>
            Open on canvas
          </Button>
        </div>
        {s.error && <p className="field-error wrap-pre" role="alert">{s.error}</p>}
        <DraftList draft={draft} onFocusRow={setFocused} />
        {!wide && (
          <div className="draft-picture-below">
            <Button variant="outline" size="sm" aria-expanded={showPicture} onClick={() => setShowPicture((v) => !v)}>
              {showPicture ? "Hide the draft" : "Show the draft"}
            </Button>
            {showPicture && picture}
          </div>
        )}
      </div>
      {wide && picture}
    </div>
  );
}
