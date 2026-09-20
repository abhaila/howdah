/**
 * The prompt library (screen 3, T21): the prompt as an object with its own history (R1) —
 * versions, consumers, outcomes, feedback. Out of main.tsx (HOW-16 P1).
 *
 * The list rows are `Row`s and the "N proposal pending →" jump is a real link rather than a
 * `.linkish` span; the loading state is a Skeleton in the shape of the list.
 */
import { useCallback, useEffect, useState } from "react";
import type { PromptDetail, PromptSummary } from "../../../prompts/library";
import { getJSON } from "@/lib/net";
import { fmtWhen } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Row } from "@/components/ui/row";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingBlock } from "@/components/ui/skeleton";

export function PromptsScreen({ selected }: { selected: string | null }) {
  const [list, setList] = useState<PromptSummary[] | null>(null);
  const [detail, setDetail] = useState<PromptDetail | null>(null);
  const load = useCallback(() => getJSON<PromptSummary[]>("/api/prompts").then(setList).catch(() => setList([])), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!selected) return void setDetail(null);
    setDetail(null);
    getJSON<PromptDetail>(`/api/prompts/${encodeURIComponent(selected)}`).then(setDetail).catch(() => setDetail(null));
  }, [selected]);

  if (!list) return <LoadingBlock label="Loading prompts" rows={8} />;
  if (list.length === 0) return <EmptyState>no prompts in <code>prompts/</code> yet</EmptyState>;

  return (
    <div className="library-layout">
      <div className="runs">
        {list.map((p) => (
          <Row key={p.id} className="run-row" selected={p.id === selected} href={`/prompts/${encodeURIComponent(p.id)}`}>
            <span className="run-goal">{p.id}</span>
            <span className="run-meta">
              v{p.version}
              {p.proposals.pending > 0 && <Badge variant="attention">{p.proposals.pending} pending</Badge>}
              {p.feedback.rejects > 0 && <Badge variant="destructive">{p.feedback.rejects} ✗</Badge>}
              {p.outcomes.renders > 0 && <Badge variant="outline">{p.outcomes.renders} run{p.outcomes.renders === 1 ? "" : "s"}</Badge>}
            </span>
          </Row>
        ))}
      </div>
      {!selected ? (
        <EmptyState>pick a prompt to see its history, feedback and outcomes</EmptyState>
      ) : !detail ? (
        <LoadingBlock label={`Loading ${selected}`} />
      ) : (
        <div className="prompt-detail">
          <div className="topbar">
            <h1>{detail.id}</h1>
            <Badge variant="outline">v{detail.version}</Badge>
            {detail.tags.map((t) => <Badge key={t}>{t}</Badge>)}
            {detail.proposals.pending > 0 && <a className="linkish" href="/proposals">{detail.proposals.pending} proposal pending →</a>}
          </div>

          <section className="pd-section">
            <h2>Outcomes</h2>
            <div className="kv"><span className="k">rendered in runs</span><span>{detail.outcomes.renders}</span></div>
            <div className="kv"><span className="k">run succeeded</span><span>{detail.outcomes.success}</span></div>
            <div className="kv"><span className="k">run failed</span><span>{detail.outcomes.failed}</span></div>
            <div className="kv"><span className="k">aborted</span><span>{detail.outcomes.aborted}</span></div>
            <div className="kv"><span className="k">still running</span><span>{detail.outcomes.pending}</span></div>
            {detail.outcome_rows.length > 0 && (
              <div className="pd-rows">
                {detail.outcome_rows.slice(-12).reverse().map((o) => (
                  <div key={`${o.run}:${o.rendered_hash}:${o.visit}`} className="pd-row">
                    <a href={`/run/${o.run}`}>{o.run}</a>
                    <span className="mono-note">{o.node}@{o.visit} · v{o.prompt_version}</span>
                    <span className="mono-note">{o.verdict_downstream ?? "—"}</span>
                    <span className={o.terminal_outcome === "failed" ? "allowance-exhausted" : ""}>{o.terminal_outcome ?? "in flight"}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="pd-section">
            <h2>Consumers</h2>
            {detail.consumers.length === 0
              ? <div className="pd-note">no graph node uses this prompt — it is dead weight or not wired up yet</div>
              : detail.consumers.map((c) => (
                  <div key={`${c.graph}/${c.node}`} className="kv">
                    <span className="k">{c.graph}</span><a href="/graphs">{c.node}</a>
                  </div>
                ))}
          </section>

          <section className="pd-section">
            <h2>Feedback ({detail.feedback.count})</h2>
            {detail.feedback_entries.length === 0
              ? <div className="pd-note">no feedback yet — add it from any turn in a run's thread</div>
              : detail.feedback_entries.slice().reverse().map((f, i) => (
                  <div key={i} className="fb-entry">
                    <div className="fb-head">
                      <Badge variant={f.verdict === "reject" ? "destructive" : "success"}>{f.verdict}</Badge>
                      <a href={`/run/${f.run}`}>{f.run}</a>
                      <span className="mono-note">{f.node}@{f.visit} · {fmtWhen(f.at)}</span>
                    </div>
                    <div className="fb-note">{f.note}</div>
                  </div>
                ))}
            {detail.feedback.rejects > 0 && (
              <div className="pd-note">
                draft a revision from this feedback: <code>bun reviser/revise.ts {detail.id}</code>
              </div>
            )}
          </section>

          <section className="pd-section">
            <h2>Version history</h2>
            {detail.accepted_at && <div className="kv"><span className="k">accepted</span><span>{fmtWhen(detail.accepted_at)}</span></div>}
            {detail.provenance && <div className="kv"><span className="k">provenance</span><span>{detail.provenance}</span></div>}
            {detail.history.length === 0
              ? <div className="pd-note">no commits touch this file yet — git is the version history (A1.1)</div>
              : detail.history.map((h) => (
                  <div key={h.sha} className="pd-row">
                    <span className="mono-note">{h.sha}</span>
                    <span className="mono-note">{new Date(h.at).toLocaleDateString()}</span>
                    <span>{h.subject}</span>
                  </div>
                ))}
          </section>

          <section className="pd-section">
            <h2>Template (v{detail.version})</h2>
            <pre className="pd-body">{detail.body}</pre>
          </section>
        </div>
      )}
    </div>
  );
}

/** Unified diff, colour-coded — the thing you actually judge a proposal by. */
export function Diff({ text }: { text: string }) {
  return (
    <pre className="diff">
      {text.split("\n").map((line, i) => {
        const cls = line.startsWith("+++") || line.startsWith("---") ? "meta"
          : line.startsWith("@@") ? "hunk"
          : line.startsWith("+") ? "add"
          : line.startsWith("-") ? "del"
          : "ctx";
        return <span key={i} className={`dl ${cls}`}>{line || " "}{"\n"}</span>;
      })}
    </pre>
  );
}
