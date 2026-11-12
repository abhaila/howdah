/**
 * The prompt library (screen 3, T21): the prompt as an object with its own history (R1) —
 * versions, consumers, outcomes, feedback. Out of main.tsx (HOW-16 P1).
 *
 * HOW-68 put it on the shared split frame (screens/frame.tsx): the list and the prompt are
 * each their own scroller, and below 1100px the prompt REPLACES the list, with Back and Esc,
 * instead of the two being squeezed side by side. What changed inside:
 *
 *   A list row is an id and what has happened to it, in words ("v3 · 12 runs · 2 rejected")
 *   — it used to be three coloured chips, one of them the amber attention badge for a pending
 *   proposal. A pending proposal is not a run waiting on you; it is a neutral chip.
 *   The prompt's sections are labelled rows (`Section`), not uppercase micro-headings; facts
 *   are a `KeyValue`; a run id that is too long is cut in the MIDDLE through `Truncate`.
 *   The template is mono, WRAPPED, and as tall as it is: it had its own 460px scroller inside
 *   the pane's scroller, which is two scrollers for one column.
 *   A feedback entry lost its 2px side stripe (DESIGN.md: no coloured side stripe).
 *
 * `Diff` lives here because the proposal screen and this one judge the same thing. Colour is
 * never the only channel: every added line carries `+` and every removed line `−` in a gutter
 * of its own, so the diff reads in monochrome and the wrapped part of a long line stays
 * aligned under its text rather than under its sign.
 */
import { useCallback, useEffect, useState } from "react";
import type { PromptDetail, PromptSummary } from "../../../prompts/library";
import { getJSON } from "@/lib/net";
import { fmtDay, fmtWhen } from "@/lib/format";
import { useListNav } from "@/lib/list-nav";
import { Badge } from "@/components/ui/badge";
import { Row } from "@/components/ui/row";
import { EmptyState } from "@/components/ui/empty-state";
import { KeyValue } from "@/components/ui/key-value";
import { Skeleton } from "@/components/ui/skeleton";
import { Truncate } from "@/components/ui/truncate";
import { cn } from "@/lib/utils";
import { CODE, Hint, KeyHints, LIST_HINTS, LoadError, Section, SplitScreen } from "./frame";

/** a link inside prose or a row: underlined, so it is not colour alone that says "link"; 24px tall, so it is a target */
export const LINK = "inline-flex min-h-6 items-center rounded-[2px] text-foreground underline decoration-[var(--border-strong)] underline-offset-2 hover:decoration-current";
/** a block of machine text that is READ: a template, a reviser's draft. Mono, wrapped, never its own scroller. */
export const PRE = "m-0 whitespace-pre-wrap rounded-[var(--radius-sm)] border border-border bg-muted px-3 py-2.5 font-mono text-code leading-[1.6] text-foreground [overflow-wrap:anywhere]";
/** one read-only row in a detail section: hairline-separated, 28px (DESIGN.md Chrome) */
export const DETAIL_ROW = "flex min-h-7 flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-border py-1 text-sm leading-[1.4]";

/** what has happened to a prompt, in words: "v3 · 12 runs · 2 rejected" */
export function promptFacts(p: { version: PromptSummary["version"]; feedback: { rejects: number }; outcomes: { renders: number } }): string {
  return [
    `v${p.version}`,
    p.outcomes.renders > 0 ? `${p.outcomes.renders} run${p.outcomes.renders === 1 ? "" : "s"}` : "",
    p.feedback.rejects > 0 ? `${p.feedback.rejects} rejected` : "",
  ].filter(Boolean).join(" · ");
}

/** one feedback entry: the verdict, where it was given, and the operator's words */
export function FeedbackEntry({ f }: { f: { verdict: string; run: string; node: string; visit: number; at?: string; note: string } }) {
  return (
    <div data-slot="feedback-entry" className="flex flex-col gap-1 border-b border-border py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <Badge variant={f.verdict === "reject" ? "destructive" : "default"}>{f.verdict === "reject" ? "rejected" : f.verdict}</Badge>
        <a className={cn(LINK, "min-w-0 max-w-[280px]")} href={`/run/${f.run}`}><Truncate mono middle={10}>{f.run}</Truncate></a>
        <span className="font-mono text-code">{f.node}@{f.visit}</span>
        {f.at && <span>{fmtWhen(f.at)}</span>}
      </div>
      <p className="m-0 max-w-[75ch] whitespace-pre-wrap text-body leading-normal text-foreground [overflow-wrap:anywhere]">{f.note}</p>
    </div>
  );
}

export function PromptsScreen({ selected }: { selected: string | null }) {
  const [list, setList] = useState<PromptSummary[] | null>(null);
  const [detail, setDetail] = useState<PromptDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => { setFailed(false); return getJSON<PromptSummary[]>("/api/prompts").then(setList).catch(() => setFailed(true)); }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    setDetail(null);
    setMissing(false);
    if (!selected) return;
    getJSON<PromptDetail>(`/api/prompts/${encodeURIComponent(selected)}`).then(setDetail).catch(() => { setDetail(null); setMissing(true); });
  }, [selected]);
  const nav = useListNav({ noun: "prompt", arrows: "list", enabled: !!list?.length });

  const listPane = failed && !list ? (
    <LoadError what="the prompts" onRetry={() => void load()} />
  ) : !list ? (
    <div role="status" aria-busy="true" className="flex flex-col gap-2 px-2"><span className="sr-only">Loading prompts</span>{Array.from({ length: 10 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
  ) : list.length === 0 ? (
    <Hint className="px-2">No prompts yet. A prompt is one <code className={CODE}>.md</code> file under <code className={CODE}>prompts/</code>; a graph's agent steps name them.</Hint>
  ) : (
    <div ref={nav.ref} {...nav.containerProps} className="flex flex-col">
      {list.map((p) => (
        <Row
          key={p.id}
          className="flex flex-col gap-0.5 border-b border-border px-2 py-1.5 text-sm leading-[1.4] no-underline"
          selected={p.id === selected} aria-current={p.id === selected ? "page" : undefined}
          href={`/prompts/${encodeURIComponent(p.id)}`} data-nav-row={p.id}
        >
          <Truncate mono className="text-code font-medium text-foreground">{p.id}</Truncate>
          <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">{promptFacts(p)}</span>
            {p.proposals.pending > 0 && <Badge>{p.proposals.pending} proposed</Badge>}
          </span>
        </Row>
      ))}
    </div>
  );

  const detailPane = !selected ? (
    <EmptyState title="Select a prompt">Its template, the steps that use it, how the runs that rendered it ended, and the feedback on it appear here.</EmptyState>
  ) : missing ? (
    <EmptyState title="No such prompt" actions={<a className={LINK} href="/prompts">Back to all prompts</a>}>
      There is no prompt called <code className="[overflow-wrap:anywhere]">{selected}</code>. It may have been renamed or removed.
    </EmptyState>
  ) : !detail ? (
    <div role="status" aria-busy="true" className="flex flex-col gap-3"><span className="sr-only">Loading {selected}</span><Skeleton className="h-6 w-64" /><Skeleton className="h-24 w-full" /><Skeleton className="h-64 w-full" /></div>
  ) : (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 font-mono text-lg font-medium leading-7 [overflow-wrap:anywhere]">{detail.id}</h2>
          <Badge variant="outline">v{detail.version}</Badge>
          {detail.tags.map((t) => <Badge key={t}>{t}</Badge>)}
        </div>
        {detail.proposals.pending > 0 && (
          <Hint><a className={LINK} href="/proposals">{detail.proposals.pending} proposed revision{detail.proposals.pending === 1 ? "" : "s"} waiting for review</a></Hint>
        )}
      </div>

      <Section title="Outcomes" description="How the runs that rendered this prompt ended.">
        <KeyValue
          labelWidth={132}
          className="tabular-nums"
          items={[
            { label: "Rendered in runs", value: String(detail.outcomes.renders) },
            { label: "Run succeeded", value: String(detail.outcomes.success) },
            { label: "Run failed", value: String(detail.outcomes.failed) },
            { label: "Aborted", value: String(detail.outcomes.aborted) },
            { label: "Still running", value: String(detail.outcomes.pending) },
          ]}
        />
        {detail.outcome_rows.length > 0 && (
          <div data-slot="outcome-rows" className="flex flex-col">
            {detail.outcome_rows.slice(-12).reverse().map((o) => (
              <div key={`${o.run}:${o.rendered_hash}:${o.visit}`} className={DETAIL_ROW}>
                <a className={cn(LINK, "min-w-0 max-w-[300px] flex-1 basis-[160px]")} href={`/run/${o.run}`}><Truncate mono middle={10}>{o.run}</Truncate></a>
                <span className="font-mono text-code text-muted-foreground">{o.node}@{o.visit} · v{o.prompt_version}</span>
                <span className="text-muted-foreground">{o.verdict_downstream ?? "no verdict"}</span>
                <span className={cn("ml-auto", o.terminal_outcome === "failed" ? "font-medium text-destructive" : "text-muted-foreground")}>{o.terminal_outcome ?? "in flight"}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Used by" count={detail.consumers.length}>
        {detail.consumers.length === 0
          ? <Hint>No graph step uses this prompt. It is either not wired up yet, or it is included by another prompt.</Hint>
          : (
            <div className="flex flex-col">
              {detail.consumers.map((c) => (
                <div key={`${c.graph}/${c.node}`} className={DETAIL_ROW}>
                  <a className={LINK} href="/graphs">{c.graph}</a>
                  <span className="font-mono text-code text-muted-foreground [overflow-wrap:anywhere]">{c.node}</span>
                </div>
              ))}
            </div>
          )}
      </Section>

      <Section title="Feedback" count={detail.feedback.count}>
        {detail.feedback_entries.length === 0
          ? <Hint>No feedback yet. Add it from any turn in a run's transcript; the reviser drafts the next version from it.</Hint>
          : <div className="flex flex-col">{detail.feedback_entries.slice().reverse().map((f, i) => <FeedbackEntry key={i} f={f} />)}</div>}
        {detail.feedback.rejects > 0 && (
          <Hint>Draft a revision from this feedback: <code className={CODE}>bun reviser/revise.ts {detail.id}</code></Hint>
        )}
      </Section>

      <Section title="Version history">
        {(detail.accepted_at || detail.provenance) && (
          <KeyValue
            labelWidth={132}
            items={[
              ...(detail.accepted_at ? [{ label: "Accepted", value: fmtWhen(detail.accepted_at) }] : []),
              ...(detail.provenance ? [{ label: "Provenance", value: detail.provenance }] : []),
            ]}
          />
        )}
        {detail.history.length === 0
          ? <Hint>No commit touches this file yet. Git is the version history.</Hint>
          : (
            <div className="flex flex-col">
              {detail.history.map((h) => (
                <div key={h.sha} className={DETAIL_ROW}>
                  <span className="font-mono text-code text-muted-foreground">{h.sha}</span>
                  <span className="tabular-nums text-muted-foreground">{fmtDay(h.at)}</span>
                  <span className="min-w-0 flex-1 basis-[200px] [overflow-wrap:anywhere]">{h.subject}</span>
                </div>
              ))}
            </div>
          )}
      </Section>

      <Section title={`Template, v${detail.version}`}>
        <pre data-slot="prompt-body" className={PRE}>{detail.body}</pre>
      </Section>
    </>
  );

  return (
    <SplitScreen
      name="prompts"
      title="Prompts"
      description="Every instruction an agent step is given, with its history."
      footer={<KeyHints hints={LIST_HINTS} />}
      list={listPane}
      listLabel="Prompts"
      detail={detailPane}
      detailLabel={selected ?? "Prompt"}
      hasDetail={selected !== null}
      backHref="/prompts"
      backLabel="Prompts"
    />
  );
}

const DIFF_LINE: Record<"meta" | "hunk" | "add" | "del" | "ctx", string> = {
  meta: "text-muted-foreground",
  hunk: "bg-[color-mix(in_srgb,var(--primary)_9%,transparent)] text-[var(--primary)]",
  add: "bg-[color-mix(in_srgb,var(--diff-add)_13%,transparent)] text-[var(--diff-add)]",
  del: "bg-[color-mix(in_srgb,var(--diff-del)_11%,transparent)] text-[var(--diff-del)]",
  ctx: "text-muted-foreground",
};

/** Unified diff — the thing you actually judge a proposal by. Sign AND colour, never colour alone. */
export function Diff({ text }: { text: string }) {
  return (
    <div data-slot="diff" role="group" aria-label="Diff" className="rounded-[var(--radius-sm)] border border-border bg-muted py-2 font-mono text-code leading-[1.6]">
      {text.split("\n").map((line, i) => {
        const kind = line.startsWith("+++") || line.startsWith("---") ? "meta"
          : line.startsWith("@@") ? "hunk"
          : line.startsWith("+") ? "add"
          : line.startsWith("-") ? "del"
          : "ctx";
        const signed = kind === "add" || kind === "del";
        return (
          <div key={i} data-line={kind} className={cn("flex px-3", DIFF_LINE[kind])}>
            {/* the sign in a gutter of its own, so a wrapped line continues under its text */}
            <span aria-hidden={!signed} className="w-[2ch] shrink-0 select-none font-medium">{kind === "add" ? "+" : kind === "del" ? "−" : ""}</span>
            {signed && <span className="sr-only">{kind === "add" ? "added: " : "removed: "}</span>}
            <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{(signed || (kind === "ctx" && line.startsWith(" ")) ? line.slice(1) : line) || " "}</span>
          </div>
        );
      })}
    </div>
  );
}
