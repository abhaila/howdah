/**
 * Proposal review (screen 4, T21): nothing changes behaviour until you look at the diff and
 * accept it (R2). Out of main.tsx (HOW-16 P1).
 *
 * Reject is the destructive verb here — it closes a draft and writes the reason back as
 * feedback — and it used to be an inline reveal: press Reject, an input appears in the
 * button row, press Confirm. That is a confirmation living in the same pixel as the thing
 * it confirms. It is an AlertDialog now, with the reason typed INSIDE the dialog, so the
 * reason and the confirmation are one decision (P1.4). Accept, reject and re-draft all
 * report through a toast; the inline banner stays, because a toast that has faded cannot be
 * re-read.
 */
import { useCallback, useEffect, useState } from "react";
import { RotateCcw, ThumbsUp, X } from "lucide-react";
import type { ProposalView } from "../../../prompts/proposals";
import { PROPOSALS_CHANGED } from "@/lib/types";
import { getJSON } from "@/lib/net";
import { fmtWhen } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Row } from "@/components/ui/row";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingBlock } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { Diff } from "./prompts";

export function ProposalsScreen({ selected }: { selected: string | null }) {
  const [list, setList] = useState<ProposalView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const { toast } = useToast();
  const load = useCallback(() => getJSON<ProposalView[]>("/api/proposals").then(setList).catch(() => setList([])), []);
  useEffect(() => { load(); }, [load]);

  const act = async (file: string, verb: "accept" | "reject" | "redraft", body?: unknown) => {
    setBusy(verb);
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/proposals/${encodeURIComponent(file)}/${verb}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => null);
    const payload = (await res?.json().catch(() => null)) as any;
    setBusy(null);
    if (!res || !res.ok) {
      const why = payload?.error ?? `${verb} failed`;
      setError(why);
      toast(why, "error");
      return;
    }
    if (verb === "accept") {
      setNotice(`accepted — the prompt is now v${payload.version}. New runs pin it; runs in flight keep what they started with (OV-2).`);
      toast(`accepted — now v${payload.version}, for new runs only`);
    }
    if (verb === "redraft") {
      setNotice(`re-drafting ${payload.drafting} — the reviser is running${payload.stubbed ? " (stubbed)" : ""}. Reload in a minute.`);
      toast(`re-drafting ${payload.drafting}${payload.stubbed ? " (stubbed)" : ""}`);
    }
    if (verb === "reject") {
      setRejecting(false);
      setReason("");
      toast("rejected — the reviser reads your reason as feedback");
    }
    load();
    window.dispatchEvent(new Event(PROPOSALS_CHANGED));
  };

  if (!list) return <LoadingBlock label="Loading proposals" rows={6} />;
  if (list.length === 0)
    return <EmptyState>no proposals — add feedback to a prompt, then <code>bun reviser/revise.ts &lt;id&gt;</code></EmptyState>;

  const current = list.find((p) => p.file === selected) ?? list[0]!;
  return (
    <div className="library-layout">
      <div className="runs">
        {list.map((p) => (
          <Row key={p.file} className="run-row" selected={p.file === current.file} href={`/proposals/${encodeURIComponent(p.file)}`}>
            <span className="run-goal">{p.id}</span>
            <span className="run-meta">
              v{p.base_version}→v{p.proposed_version}
              <Badge variant={p.status === "pending" ? "attention" : p.status === "accepted" ? "success" : "outline"}>{p.status}</Badge>
              {p.stale && <Badge variant="destructive">stale</Badge>}
            </span>
          </Row>
        ))}
      </div>

      <div className="prompt-detail">
        <div className="topbar">
          <h1>{current.id}</h1>
          <Badge variant="outline">v{current.base_version} → v{current.proposed_version}</Badge>
          <Badge variant={current.status === "pending" ? "attention" : current.status === "accepted" ? "success" : "outline"}>{current.status}</Badge>
          <span className="meta">{current.created ? fmtWhen(current.created) : ""}</span>
          <a className="linkish" href={`/prompts/${encodeURIComponent(current.id)}`}>open prompt →</a>
        </div>

        {current.stale && (
          <div className="banner failed">
            Stale base — drafted against v{current.base_version}, but {current.id} is now v{current.current_version}.
            Accepting would silently drop whatever moved it (D7).
            <Button variant="destructive" size="sm" className="ml-auto" disabled={busy !== null} onClick={() => act(current.file, "redraft")}>
              <RotateCcw />{busy === "redraft" ? "re-drafting…" : "Re-draft (spends tokens)"}
            </Button>
          </div>
        )}
        {current.current_version === null && (
          <div className="banner failed">Orphaned — {current.id} no longer exists in <code>prompts/</code>.</div>
        )}
        {error && <div className="banner failed">{error}</div>}
        {notice && <div className="banner paused">{notice}</div>}

        {current.status === "pending" && !current.stale && current.current_version !== null && (
          <div className="proposal-actions">
            <Button size="sm" disabled={busy !== null} onClick={() => act(current.file, "accept")}>
              <ThumbsUp />{busy === "accept" ? "accepting…" : `Accept → v${current.proposed_version}`}
            </Button>
            <Button variant="destructive-outline" size="sm" disabled={busy !== null} onClick={() => setRejecting(true)}><X />Reject</Button>
          </div>
        )}

        <Dialog
          alert
          open={rejecting}
          onClose={() => setRejecting(false)}
          title={`Reject the ${current.id} revision?`}
          description="The draft is closed and your reason is filed as feedback — the reviser reads exactly this when it drafts the next one. Nothing about the live prompt changes."
        >
          <Input
            autoFocus
            aria-label="why this revision is rejected"
            placeholder="Why? The reviser reads this."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && reason.trim()) act(current.file, "reject", { reason }); }}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setRejecting(false)}>Cancel</Button>
            <Button variant="destructive" size="sm" disabled={!reason.trim() || busy !== null} onClick={() => act(current.file, "reject", { reason })}>
              {busy === "reject" ? "rejecting…" : "Reject the revision"}
            </Button>
          </div>
        </Dialog>

        {current.status === "rejected" && current.rejection_reason && (
          <div className="pd-note">rejected {fmtWhen(current.rejected_at)} — “{current.rejection_reason}” (the reviser reads this as feedback)</div>
        )}
        {current.status === "accepted" && (
          <div className="pd-note">accepted {fmtWhen(current.accepted_at)} — applies to new runs only (OV-2)</div>
        )}

        <section className="pd-section">
          <h2>Eval</h2>
          {current.eval.score
            ? <div className="kv"><span className="k">score</span><span>{current.eval.score} — {current.eval.verdict}</span></div>
            : current.eval.case
              ? <div className="pd-note">an eval case exists but has not been run: <code>bun {current.eval.case} --score-only --stamp</code></div>
              : <div className="pd-note">no eval case for this prompt yet — cases are authored at first feedback (D8), so judge the diff</div>}
        </section>

        <section className="pd-section">
          <h2>Evidence — feedback this answers ({current.feedback.length})</h2>
          {current.feedback.length === 0
            ? <div className="pd-note">no feedback on file for {current.id}</div>
            : current.feedback.map((f, i) => (
                <div key={i} className="fb-entry">
                  <div className="fb-head">
                    <Badge variant={f.verdict === "reject" ? "destructive" : "success"}>{f.verdict}</Badge>
                    <a href={`/run/${f.run}`}>{f.run}</a>
                    <span className="mono-note">{f.node}@{f.visit}</span>
                  </div>
                  <div className="fb-note">{f.note}</div>
                </div>
              ))}
        </section>

        {current.reflection && (
          <section className="pd-section">
            <h2>Reviser's reasoning</h2>
            <div className="fb-note">{current.reflection}</div>
          </section>
        )}

        <section className="pd-section">
          <h2>Diff</h2>
          {current.diff ? <Diff text={current.diff} /> : <div className="pd-note">no diff on file — compare the revision below by eye</div>}
        </section>

        <section className="pd-section">
          <h2>Proposed template (v{current.proposed_version})</h2>
          <pre className="pd-body">{current.body}</pre>
        </section>
      </div>
    </div>
  );
}
