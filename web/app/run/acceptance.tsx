/**
 * HOW-51: the Acceptance card — the run's default-FAIL contract as a checklist. Red rows are
 * unmet, green rows name the evidence that flipped them, waived rows say who waived them and
 * why, superseded rows stay visible struck through (criteria are never deleted), and a row the
 * ticket did not ask for is tagged "proposed by plan" so nobody mistakes it for the ticket's.
 *
 * It LEADS a finished run's story: "done" used to be a paragraph of prose that could include
 * "the full suite was not run", and nothing on screen said a criterion was unmet. A run that
 * never wrote a contract (every run before HOW-51) shows no card at all — not an empty red one.
 *
 * Waiving is a decision, so it asks for a reason and posts it; the gate reads the decision
 * event (engine/acceptance-decision.ts), and a refusal is shown verbatim.
 *
 * HOW-59: each row says how it is checked; a row this run can never prove says WHY in place of
 * "no evidence yet", and one control waives all of those with one reason. An `after-publish`
 * row is drawn as pending, not red: it does not hold publication, which it cannot precede.
 */
import { useState } from "react";
import { CheckCircle2, CircleX, Clock, ShieldCheck, Ban } from "lucide-react";
import type { RunDetail } from "../../derive";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { evidenceUrl } from "./evidence";

type Row = NonNullable<RunDetail["acceptance"]>["rows"][number];

const ALL = "*unprovable";
const CHECK_LABEL: Record<NonNullable<Row["check"]>, string> = {
  tests: "checked by tests", screenshot: "checked on screen", command: "checked by a command",
  human: "human judgement", "after-publish": "checked after publish",
};

function EvidenceLink({ runId, row, verify }: { runId: string; row: Row; verify: string | null }) {
  const ev = row.evidence;
  if (!ev) return null;
  switch (ev.kind) {
    case "verify.result":
      return <span className="ac-evidence">tests passed{verify ? ` @ ${verify}` : ""}{ev.note ? ` — ${ev.note}` : ""}</span>;
    case "screenshot":
      return <a className="ac-evidence pr-link" href={evidenceUrl(runId, ev.file)} target="_blank" rel="noreferrer">screenshot {ev.file.split("/").at(-1)}{ev.note ? ` — ${ev.note}` : ""}</a>;
    case "command":
      return <span className="ac-evidence"><code>{ev.command}</code> → {ev.output.length > 120 ? `${ev.output.slice(0, 117)}…` : ev.output}</span>;
  }
}

export function AcceptanceCard({ runId, detail, onChanged }: { runId: string; detail: RunDetail; onChanged: () => void }) {
  const acc = detail.acceptance;
  const [waiving, setWaiving] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  if (!acc) return null;
  const live = acc.rows.filter((r) => !r.superseded);
  const met = live.filter((r) => r.passes || r.waived).length;
  const lastVerify = detail.context.find((c) => c.key === "verify.result")?.value as { commit?: string | null } | undefined;
  const verifyCommit = lastVerify?.commit ? lastVerify.commit.slice(0, 8) : null;

  // `ALL` is the HOW-59 one-decision waiver of every row this run cannot prove
  const waive = async (id: string) => {
    setBusy(true);
    setError(null);
    const all = id === ALL;
    const res = await fetch(`/api/runs/${runId}/acceptance/waive`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(all ? { unprovable: true, reason } : { criterion: id, reason }),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { error?: string; resumed?: boolean; waived?: string[] } | null;
    setBusy(false);
    if (!res?.ok) { setError(body?.error ?? "could not waive"); return; }
    const what = all ? `${body?.waived?.length ?? 0} unprovable criteria` : `"${id}"`;
    toast(body?.resumed ? `waived ${what} — every criterion is settled, resuming` : `waived ${what}`);
    setWaiving(null);
    setReason("");
    onChanged();
  };

  return (
    <section className="ac-card" data-met={acc.unmet === 0 ? "true" : "false"} aria-label="Acceptance criteria">
      <div className="ac-head">
        <ShieldCheck size={13} aria-hidden />
        <span className="ac-title">Acceptance</span>
        <span className="ac-score">{met} of {live.length} met</span>
        {acc.unmet > 0 && <Badge variant="destructive">{acc.unmet} unmet</Badge>}
        <span className="ac-by">judged by {acc.written_by.node}@{acc.written_by.visit}</span>
      </div>
      {acc.unprovable > 0 && detail.summary.outcome === null && (
        <div className="ac-unprovable">
          <span>{acc.unprovable} of the unmet criteria can never be proved in this run — say why once to settle them all.</span>
          {waiving === ALL ? (
            <span className="ac-waive">
              <Input aria-label="why the unprovable criteria are accepted without evidence" placeholder="why these are accepted without evidence" value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button size="sm" variant="destructive-outline" disabled={busy || !reason.trim()} onClick={() => waive(ALL)}>Waive {acc.unprovable}</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setWaiving(null); setError(null); }}>Cancel</Button>
            </span>
          ) : (
            <Button size="sm" variant="outline" onClick={() => { setWaiving(ALL); setReason(""); setError(null); }}>Waive all unprovable…</Button>
          )}
        </div>
      )}
      <ul className="ac-rows">
        {acc.rows.map((r) => {
          const state = r.superseded ? "superseded" : r.passes ? "pass" : r.waived ? "waived" : r.check === "after-publish" ? "later" : "fail";
          return (
            <li key={r.id} className="ac-row" data-state={state}>
              {state === "pass" ? <CheckCircle2 size={13} aria-hidden /> : state === "waived" ? <Ban size={13} aria-hidden /> : state === "later" ? <Clock size={13} aria-hidden /> : <CircleX size={13} aria-hidden />}
              <div className="ac-row-body">
                <span className="ac-text">{r.text}</span>
                <span className="ac-meta">
                  <span className="m">{r.id}</span>
                  {r.source === "plan" && <Badge variant="outline">proposed by plan</Badge>}
                  {r.check && <Badge variant="outline">{CHECK_LABEL[r.check]}</Badge>}
                  {state === "superseded" && <span>superseded</span>}
                  {state === "pass" && <EvidenceLink runId={runId} row={r} verify={verifyCommit} />}
                  {state === "waived" && <span className="ac-waived">waived by the operator — {r.waived!.reason}</span>}
                  {state === "fail" && <span>{r.unprovable ? `can't be proved in this run: ${r.unprovable}` : "no evidence yet"}</span>}
                  {state === "later" && <span>not held at publish — the delivery steps check it</span>}
                </span>
                {/* a finished run has no gate left to open: waiving there would change nothing */}
                {state === "fail" && detail.summary.outcome === null && (waiving === r.id ? (
                  <span className="ac-waive">
                    <Input aria-label={`why ${r.id} is accepted without evidence`} placeholder="why this is accepted without evidence" value={reason} onChange={(e) => setReason(e.target.value)} />
                    <Button size="sm" variant="destructive-outline" disabled={busy || !reason.trim()} onClick={() => waive(r.id)}>Waive</Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setWaiving(null); setError(null); }}>Cancel</Button>
                  </span>
                ) : (
                  <Button size="sm" variant="ghost" className="ac-waive-open" onClick={() => { setWaiving(r.id); setReason(""); setError(null); }}>Waive…</Button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
      {error && <div className="field-error">{error}</div>}
    </section>
  );
}
