/**
 * The draft card and its parts (HOW-65; HOW-56 D-2A, D-4A, D-6A, D-8A, D-9A, D-10A).
 *
 * A draft-graph run ends with a proposal, and SAVE IS THE APPROVAL — so what the operator sees
 * before pressing it has to lead with the one thing that matters: what in this draft can change
 * their code. The order is fixed by D-2A and shared by the card in the run's Chat and the review
 * page (screens/draft-review.tsx), which is why `DraftList` is one component and not two:
 *
 *   Can change your code → What changed → Unchanged (closed) → Worth a look
 *
 * Every number on the summary line counts a section below it, every glyph has its word next to
 * it (D-8A: a ◐ means nothing to a screen reader, and not much more to a new operator), and an
 * empty section says "Nothing flagged" rather than vanishing, so "no risk" is a statement and
 * not an absence.
 *
 * Save is offered on the card only when the draft grants no new write power (D-6A). When it
 * does, the primary button is "Review and save", which opens the page with the diagram — a
 * new writer is exactly the case where the picture matters. A refused save is shown WORD FOR
 * WORD and a name collision puts the cursor back in the name (D-9A). After Save the card is a
 * receipt, read back from the graph's own provenance (D-10A), so a reload never offers Save twice.
 *
 * Nothing here computes the diff: core/draft-diff.ts does, on the server (web/draft.ts).
 */
import { forwardRef, useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReadyDraft, RunDraft } from "../../draft";
import type { BodyChange, StepRow } from "../../../core/draft-diff";
import { BODY_COLLAPSE_LINES } from "../../../core/draft-diff";
import { nameTakenProblem, type SpecProblem } from "../../../core/graph-spec";
import type { GraphCatalog } from "@/lib/types";
import { getJSON } from "@/lib/net";
import { navigate } from "@/lib/nav";
import { problemProse } from "../builder/problem";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** The run's draft, re-read on demand; `poll` re-reads every 3s while it is still drafting. */
export function useRunDraft(runId: string, opts: { poll?: boolean } = {}): { draft: RunDraft | null; reload: () => void } {
  const [draft, setDraft] = useState<RunDraft | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let live = true;
    // not getJSON: a 404/409 here CARRIES the reason the page shows, so its body is the answer
    fetch(`/api/runs/${encodeURIComponent(runId)}/draft`)
      .then((r) => r.json())
      .then((d: RunDraft) => live && setDraft(d))
      .catch(() => live && setDraft({ state: "unknown", reason: "Could not reach Howdah to read this draft." }));
    return () => { live = false; };
  }, [runId, tick]);
  const drafting = draft?.state === "drafting";
  useEffect(() => {
    if (!opts.poll || !drafting) return;
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [opts.poll, drafting, reload]);
  return { draft, reload };
}

/** The card's Save. A refusal is returned as the server wrote it, with whether it was a 409. */
export async function saveDraft(runId: string, name: string): Promise<{ ok: true; name: string } | { ok: false; error: string; conflict: boolean }> {
  try {
    const r = await fetch(`/api/runs/${encodeURIComponent(runId)}/draft/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const body = (await r.json().catch(() => ({}))) as { name?: string; error?: string };
    if (r.ok) return { ok: true, name: body.name ?? name };
    return { ok: false, error: body.error ?? `the save was refused (${r.status})`, conflict: r.status === 409 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), conflict: false };
  }
}

/** What the summary line counts — one function, so the line and the sections cannot disagree. */
export function draftCounts(d: ReadyDraft): { risk: number; changed: number; advice: number } {
  return {
    risk: d.diff.permission.length,
    changed: d.diff.added.length + d.diff.removed.length + d.diff.changed.length + (d.diff.graph.length ? 1 : 0),
    advice: d.advice.length,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "based on X · N steps" or "New graph · N steps" */
export function draftBasis(d: ReadyDraft): string {
  const steps = plural(d.draft.spec.nodes.length, "step");
  return d.draft.based_on ? `based on ${d.draft.based_on} · ${steps}` : `New graph · ${steps}`;
}

export function DraftSummary({ draft }: { draft: ReadyDraft }) {
  const c = draftCounts(draft);
  return (
    <p className="draft-sum">
      <span><span aria-hidden className="draft-glyph risk">⚠</span> {plural(c.risk, "step")} can change your code</span>
      <span aria-hidden> · </span>
      <span><span aria-hidden className="draft-glyph">◐</span> {c.changed} changed</span>
      <span aria-hidden> · </span>
      <span><span aria-hidden className="draft-glyph">ⓘ</span> {c.advice} worth a look</span>
    </p>
  );
}

/** "<base> changed after this draft; copied steps use today's text" — or that it is gone */
export function BaseChangedBanner({ draft }: { draft: ReadyDraft }) {
  const b = draft.baseChanged;
  if (!b) return null;
  return (
    <p className="draft-banner" role="note">
      {b.gone
        ? `${b.base} no longer exists; this draft is compared with the graph as the drafter saw it, and copied steps use today's text`
        : `${b.base} changed after this draft; copied steps use today's text`}
    </p>
  );
}

/** Body text as `<del>`/`<ins>` lines, collapsed past BODY_COLLAPSE_LINES behind "show all N lines". */
export function BodyDiff({ body }: { body: BodyChange }) {
  const [all, setAll] = useState(false);
  if (body.unchangedFrom) return <p className="draft-note">Instructions unchanged from <code>{body.unchangedFrom}</code></p>;
  if (body.lines.length === 0) return null;
  const long = body.lines.length > BODY_COLLAPSE_LINES;
  const shown = long && !all ? body.lines.slice(0, BODY_COLLAPSE_LINES) : body.lines;
  return (
    <div className="draft-diff">
      {body.copyOf && <p className="draft-note">A copy of <code>{body.copyOf}</code>, against the base step's instructions:</p>}
      <pre aria-label={`instructions: ${body.added} added, ${body.removed} removed`}>
        {shown.map((l, i) =>
          l.op === "del" ? <del key={i}>{l.text}{"\n"}</del>
          : l.op === "ins" ? <ins key={i}>{l.text}{"\n"}</ins>
          : <span key={i}>{l.text}{"\n"}</span>)}
      </pre>
      {long && (
        <Button variant="link" size="inline" aria-expanded={all} onClick={() => setAll((a) => !a)}>
          {all ? "show the first 20 lines" : `show all ${body.lines.length} lines`}
        </Button>
      )}
    </div>
  );
}

const CHANGE_MARK: Record<StepRow["change"], { glyph: string; word: string }> = {
  added: { glyph: "+", word: "added" },
  removed: { glyph: "−", word: "removed" },
  changed: { glyph: "◐", word: "changed" },
  unchanged: { glyph: "=", word: "unchanged" },
};

/** One step's row. Focusable, so focusing it can highlight its box on the review page. */
function StepLine({ row, onFocusRow }: { row: StepRow; onFocusRow?: (id: string | null) => void }) {
  const mark = CHANGE_MARK[row.change];
  return (
    <li
      className="draft-row"
      data-change={row.change}
      tabIndex={0}
      data-step={row.id}
      aria-label={`${row.title}, ${mark.word}`}
      onFocus={() => onFocusRow?.(row.id)}
      onBlur={() => onFocusRow?.(null)}
      onMouseEnter={() => onFocusRow?.(row.id)}
      onMouseLeave={() => onFocusRow?.(null)}
    >
      <div className="draft-row-head">
        <span aria-hidden className="draft-glyph">{mark.glyph}</span>
        <span className="draft-tag">{mark.word}</span>
        <strong>{row.title}</strong>
        {row.title !== row.id && <code className="draft-id">{row.id}</code>}
        <span className="draft-kind">{row.kind}</span>
      </div>
      {row.changes.length > 0 && <ul className="draft-facts">{row.changes.map((c) => <li key={c}>{problemProse(c)}</li>)}</ul>}
      {row.cascades.length > 0 && <ul className="draft-facts">{row.cascades.map((c) => <li key={c}>{problemProse(c)}</li>)}</ul>}
      {row.body && <BodyDiff body={row.body} />}
    </li>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  const id = useId();
  const empty = count === 0;
  return (
    <section className="draft-sec" role="region" aria-labelledby={id}>
      <h3 id={id}>{title} · {count}</h3>
      {empty ? <p className="draft-none">Nothing flagged</p> : children}
    </section>
  );
}

/** The four sections, in D-2A's order. Shared by the card and the review page. */
export function DraftList({ draft, onFocusRow }: { draft: ReadyDraft; onFocusRow?: (id: string | null) => void }) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const unchangedId = useId();
  const { diff } = draft;
  const changedRows = [...diff.removed, ...diff.added, ...diff.changed];
  const focus = (id: string) => ({
    onFocus: () => onFocusRow?.(id), onBlur: () => onFocusRow?.(null),
    onMouseEnter: () => onFocusRow?.(id), onMouseLeave: () => onFocusRow?.(null),
  });
  return (
    <div className="draft-list">
      <Section title="Can change your code" count={diff.permission.length}>
        <ul>
          {diff.permission.map((p) => (
            <li key={p.id} className="draft-row risk" tabIndex={0} data-step={p.id} aria-label={`${p.title}, can change your code${p.isNew ? ", new" : ""}`} {...focus(p.id)}>
              <div className="draft-row-head">
                <span aria-hidden className="draft-glyph risk">⚠</span>
                <span className="draft-tag">{p.isNew ? "new" : "as before"}</span>
                <strong>{p.title}</strong>
              </div>
              <p className="draft-note">
                {p.lostReadOnly
                  ? `was read-only in ${diff.base}; in this draft it can change files`
                  : p.isNew
                    ? diff.base ? `a step ${diff.base} does not have, and it can change files` : "can change files"
                    : `can change files, as it does in ${diff.base}`}
              </p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={diff.base ? `What changed from ${diff.base}` : "What changed"} count={changedRows.length + (diff.graph.length ? 1 : 0)}>
        <ul>
          {diff.graph.length > 0 && (
            <li className="draft-row" tabIndex={0} aria-label="the graph itself, changed">
              <div className="draft-row-head">
                <span aria-hidden className="draft-glyph">◐</span>
                <span className="draft-tag">changed</span>
                <strong>The graph</strong>
              </div>
              <ul className="draft-facts">{diff.graph.map((g) => <li key={g}>{problemProse(g)}</li>)}</ul>
            </li>
          )}
          {changedRows.map((r) => <StepLine key={`${r.change}:${r.id}`} row={r} onFocusRow={onFocusRow} />)}
        </ul>
      </Section>

      <section className="draft-sec" role="region" aria-labelledby={`${unchangedId}-h`}>
        <h3 id={`${unchangedId}-h`}>
          <Button variant="ghost" size="sm" aria-expanded={showUnchanged} aria-controls={unchangedId} onClick={() => setShowUnchanged((s) => !s)}>
            Unchanged ({diff.unchanged.length})
          </Button>
        </h3>
        <div id={unchangedId} hidden={!showUnchanged}>
          {diff.unchanged.length === 0
            ? <p className="draft-none">Nothing flagged</p>
            : <ul>{diff.unchanged.map((r) => <StepLine key={r.id} row={r} onFocusRow={onFocusRow} />)}</ul>}
        </div>
      </section>

      <Section title="Worth a look" count={draft.advice.length}>
        <ul>
          {draft.advice.map((p: SpecProblem, i) => (
            <li key={i} className="draft-row" tabIndex={0} data-step={p.node} aria-label={`worth a look: ${p.message.replace(/\*\*|`/g, "")}`} {...(p.node ? focus(p.node) : {})}>
              <div className="draft-row-head">
                <span aria-hidden className="draft-glyph">ⓘ</span>
                <span className="draft-tag">worth a look</span>
              </div>
              <p className="draft-note">{problemProse(p.message)}</p>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

/** The graph's name, editable, with the live "already taken" check against the catalog. */
export const DraftName = forwardRef<HTMLInputElement, { value: string; onChange: (v: string) => void }>(function DraftName({ value, onChange }, ref) {
  const [taken, setTaken] = useState<string[]>([]);
  const hint = useId();
  useEffect(() => {
    getJSON<GraphCatalog>("/api/graphs").then((c) => setTaken(c.graphs.map((g) => g.name))).catch(() => setTaken([]));
  }, []);
  const problem = nameTakenProblem(value.trim(), taken);
  return (
    <div className="draft-name">
      <Label>
        Graph name
        <Input ref={ref} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} aria-describedby={problem ? hint : undefined} aria-invalid={problem ? true : undefined} />
      </Label>
      {problem && <p id={hint} className="field-error">{problemProse(problem.message)}</p>}
    </div>
  );
});

/** `✓ Saved as X · not edited | edited on canvas · Open · Run it` */
export function DraftReceipt({ saved }: { saved: { name: string; edited: boolean } }) {
  return (
    <p className="draft-receipt" role="status">
      <span aria-hidden className="draft-glyph ok">✓</span> Saved as <strong>{saved.name}</strong>
      <span aria-hidden> · </span>{saved.edited ? "edited on canvas" : "not edited"}
      <span aria-hidden> · </span><a href={`/graphs/${saved.name}/build`}>Open</a>
      <span aria-hidden> · </span><a href={`/new?graph=${encodeURIComponent(saved.name)}`}>Run it</a>
    </p>
  );
}

/**
 * The name box and the Save, with D-9A's refusal handling, shared by the card and the page.
 * `direct` is whether Save is offered at all here; when it is not, `onReview` is the primary.
 */
export function useDraftSave(runId: string, draft: ReadyDraft, onSaved: () => void) {
  const [name, setName] = useState(draft.draft.spec.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    const r = await saveDraft(runId, name.trim());
    setBusy(false);
    if (r.ok) { onSaved(); return; }
    setError(r.error);
    if (r.conflict) nameRef.current?.focus();
  }, [runId, name, onSaved]);
  return { name, setName, busy, error, save, nameRef };
}

/** The card at the foot of a finished draft-graph run's Chat (D-2A, D-6A). Never the diagram. */
export function DraftCard({ runId }: { runId: string }) {
  const { draft, reload } = useRunDraft(runId);
  if (!draft) return null;
  // refused twice: the standing park card already quotes every problem; a second card would not
  if (draft.state !== "ready") return null;
  return <ReadyCard runId={runId} draft={draft} onSaved={reload} />;
}

function ReadyCard({ runId, draft, onSaved }: { runId: string; draft: ReadyDraft; onSaved: () => void }) {
  const s = useDraftSave(runId, draft, onSaved);
  const reviewHref = `/runs/${encodeURIComponent(runId)}/draft`;
  return (
    <Card className="draft-card" aria-label="the drafted graph">
      <div className="draft-head">
        <h2>Draft ready</h2>
        <p className="draft-basis">{draftBasis(draft)}</p>
      </div>
      {draft.saved ? <DraftReceipt saved={draft.saved} /> : <DraftName ref={s.nameRef} value={s.name} onChange={s.setName} />}
      <DraftSummary draft={draft} />
      <BaseChangedBanner draft={draft} />
      {draft.draft.notes && <p className="draft-note">{draft.draft.notes}</p>}
      {!draft.saved && (
        <div className="actions">
          {draft.grantsNewWrite
            ? <Button onClick={() => navigate(reviewHref)}>Review and save</Button>
            : <Button onClick={s.save} disabled={s.busy}>{s.busy ? "Saving…" : "Save"}</Button>}
          <Button variant="outline" onClick={() => navigate(reviewHref)}>Review all changes</Button>
        </div>
      )}
      {draft.saved && <div className="actions"><Button variant="outline" onClick={() => navigate(reviewHref)}>Review all changes</Button></div>}
      {s.error && <p className="field-error wrap-pre" role="alert">{s.error}</p>}
      <DraftList draft={draft} />
    </Card>
  );
}
