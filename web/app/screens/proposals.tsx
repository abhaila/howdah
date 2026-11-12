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
 *
 * HOW-68 put it on the shared split frame (screens/frame.tsx), each side its own scroller,
 * the proposal replacing the list below 1100px. Inside:
 *
 *   ONE primary action: Accept. Reject is the destructive outline beside it; "Re-draft" spends
 *   tokens but destroys nothing, so it is an ordinary outline button, not a red one.
 *   A refusal, a stale base and an orphaned proposal are inline notices that say what is wrong
 *   and what to do, with the refusal VERBATIM — not full-bleed red banners.
 *   "pending" was the amber attention badge. A proposal waiting for review is not a run waiting
 *   on you (the nav counts it in grey for the same reason), so it is a neutral chip.
 *   The diff carries a sign as well as a colour (screens/prompts.tsx `Diff`), and neither it
 *   nor the proposed template is a scroller inside the scroller.
 *
 * The audit's "unexplained 502 in the console on /proposals" was not this screen and not a
 * proposals route: every request this screen makes was traced and answers 200. See the report
 * of this change for what it was.
 */
import { useCallback, useEffect, useState } from "react";
import { RotateCcw, ThumbsUp, X } from "lucide-react";
import type { ProposalView } from "../../../prompts/proposals";
import { PROPOSALS_CHANGED } from "@/lib/types";
import { getJSON } from "@/lib/net";
import { focusIfLost } from "@/lib/page";
import { fmtWhen } from "@/lib/format";
import { useListNav } from "@/lib/list-nav";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Row } from "@/components/ui/row";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { KeyValue } from "@/components/ui/key-value";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Truncate } from "@/components/ui/truncate";
import { useToast } from "@/components/ui/toast";
import { CODE, Hint, KeyHints, LIST_HINTS, LoadError, Screen, Section, SplitScreen } from "./frame";
import { Diff, FeedbackEntry, LINK, PRE } from "./prompts";

/** a fact about the proposal that changes what may be done with it; the refusal is shown whole */
function Notice({ tone = "plain", slot, children }: { tone?: "error" | "plain"; slot: string; children: React.ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"} data-slot={slot}
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-sm)] border border-border bg-card px-3 py-2 text-sm leading-5 [overflow-wrap:anywhere] ${tone === "error" ? "text-destructive" : "text-foreground"}`}
    >
      {children}
    </div>
  );
}

const statusBadge = (p: Pick<ProposalView, "status">) => <Badge variant={p.status === "pending" ? "default" : "outline"}>{p.status}</Badge>;

export function ProposalsScreen({ selected }: { selected: string | null }) {
  const [list, setList] = useState<ProposalView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const { toast } = useToast();
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => { setFailed(false); return getJSON<ProposalView[]>("/api/proposals").then(setList).catch(() => setFailed(true)); }, []);
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
      setNotice(`accepted — the prompt is now v${payload.version}. New runs pin it; runs in flight keep what they started with.`);
      toast(`Accepted — now v${payload.version}, for new runs only`);
    }
    if (verb === "redraft") {
      setNotice(`re-drafting ${payload.drafting} — the reviser is running${payload.stubbed ? " (stubbed)" : ""}. Reload in a minute.`);
      toast(`Re-drafting ${payload.drafting}${payload.stubbed ? " (stubbed)" : ""}`);
    }
    if (verb === "reject") {
      setReason("");
      toast("Rejected — the reviser reads your reason as feedback");
    }
    await load();
    window.dispatchEvent(new Event(PROPOSALS_CHANGED));
    // D20: the decision removes the buttons that made it, and focus fell to <body>. It goes to
    // what the screen now says about the proposal — the notice — or to the detail pane.
    requestAnimationFrame(() => focusIfLost(
      document.querySelector<HTMLElement>("[data-slot='proposal-notice']") ?? document.querySelector<HTMLElement>("[data-screen='proposals'] [data-pane='detail']"),
    ));
  };

  const nav = useListNav({ noun: "proposal", arrows: "list", enabled: !!list?.length });
  const frame = { name: "proposals", title: "Proposals", description: "Revisions the reviser drafted from your feedback. Nothing changes until you accept one.", listLabel: "Proposals", backHref: "/proposals", backLabel: "Proposals" } as const;

  if (!list && failed) {
    return <SplitScreen {...frame} list={<Hint className="px-2">Not loaded.</Hint>} detail={<LoadError what="the proposals" onRetry={() => void load()} />} detailLabel="Proposal" hasDetail />;
  }
  if (!list) {
    const bars = (n: number, h: string) => <div role="status" aria-busy="true" className="flex flex-col gap-2 px-2"><span className="sr-only">Loading proposals</span>{Array.from({ length: n }, (_, i) => <Skeleton key={i} className={h} />)}</div>;
    return <SplitScreen {...frame} list={bars(6, "h-10 w-full")} detail={bars(3, "h-24 w-full")} detailLabel="Proposal" hasDetail={false} />;
  }
  if (list.length === 0) {
    // nothing to list and nothing to detail: ONE pane saying so. As a split it printed "No
    // proposals yet." twice at 1440px, and under 1100px — where a split shows its list side —
    // only the bare line, with nothing about how a proposal comes to exist (HOW-68)
    return (
      <Screen name={frame.name} title={frame.title} description={frame.description}>
        <EmptyState title="No proposals yet" actions={<a className={buttonVariants({ variant: "outline" })} href="/prompts">Go to Prompts</a>}>
          A proposal is a drafted revision of a prompt. Add feedback to a turn in a run, then draft one with <code>bun reviser/revise.ts &lt;prompt-id&gt;</code>.
        </EmptyState>
      </Screen>
    );
  }

  const current = list.find((p) => p.file === selected) ?? list[0]!;
  const reject = () => { setRejecting(false); act(current.file, "reject", { reason }); };
  return (
    <SplitScreen
      {...frame}
      footer={<KeyHints hints={LIST_HINTS} />}
      detailLabel={current.id}
      hasDetail={selected !== null}
      list={
        <div ref={nav.ref} {...nav.containerProps} className="flex flex-col">
          {list.map((p) => (
            <Row
              key={p.file}
              className="flex flex-col gap-0.5 border-b border-border px-2 py-1.5 text-sm leading-[1.4] no-underline"
              selected={p.file === current.file} aria-current={p.file === current.file ? "page" : undefined}
              href={`/proposals/${encodeURIComponent(p.file)}`} data-nav-row={p.file}
            >
              <Truncate mono className="text-code font-medium text-foreground">{p.id}</Truncate>
              <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <span className="tabular-nums">v{p.base_version} to v{p.proposed_version}</span>
                {statusBadge(p)}
                {p.stale && <Badge variant="destructive">stale</Badge>}
              </span>
            </Row>
          ))}
        </div>
      }
      detail={
        <>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="m-0 font-mono text-lg font-medium leading-7 [overflow-wrap:anywhere]">{current.id}</h2>
              <Badge variant="outline">v{current.base_version} to v{current.proposed_version}</Badge>
              {statusBadge(current)}
            </div>
            <Hint>
              {current.created ? `Drafted ${fmtWhen(current.created)}. ` : ""}
              <a className={LINK} href={`/prompts/${encodeURIComponent(current.id)}`}>Open the prompt</a>
            </Hint>
          </div>

          {current.stale && (
            <Notice tone="error" slot="proposal-stale">
              <span className="min-w-0 flex-1 basis-[280px]">
                Stale base: this was drafted against v{current.base_version}, but {current.id} is now v{current.current_version}.
                Accepting it would silently drop whatever moved the prompt on.
              </span>
              <Button variant="outline" size="sm" disabled={busy !== null} loading={busy === "redraft"} onClick={() => act(current.file, "redraft")}>
                {busy !== "redraft" && <RotateCcw />}{busy === "redraft" ? "Re-drafting" : "Re-draft (spends tokens)"}
              </Button>
            </Notice>
          )}
          {current.current_version === null && (
            <Notice tone="error" slot="proposal-orphaned">Orphaned: {current.id} no longer exists in <code className={CODE}>prompts/</code>, so there is nothing to apply this to. Reject it to close it.</Notice>
          )}
          {error && <Notice tone="error" slot="proposal-error">{error}</Notice>}
          {notice && <Notice slot="proposal-notice">{notice}</Notice>}

          {/* Reject is offered on EVERY pending proposal: a stale one used to show only Re-draft,
              and one with no feedback to re-draft from was a dead end nothing on screen could close */}
          {current.status === "pending" && (
            <div data-slot="proposal-actions" className="flex flex-wrap items-center gap-2">
              {!current.stale && current.current_version !== null && (
                <Button disabled={busy !== null} loading={busy === "accept"} onClick={() => act(current.file, "accept")}>
                  {busy !== "accept" && <ThumbsUp />}{busy === "accept" ? "Accepting" : `Accept as v${current.proposed_version}`}
                </Button>
              )}
              <Button variant="destructive-outline" disabled={busy !== null} loading={busy === "reject"} onClick={() => setRejecting(true)}>{busy !== "reject" && <X />}Reject</Button>
            </div>
          )}

          <Dialog
            alert
            open={rejecting}
            onClose={() => setRejecting(false)}
            title={`Reject the ${current.id} revision?`}
            description="The draft is closed and your reason is filed as feedback — the reviser reads exactly this when it drafts the next one. Nothing about the live prompt changes."
          >
            <Label>
              Why? The reviser reads this.
              <Input
                autoFocus
                aria-label="why this revision is rejected"
                placeholder="What is wrong with this revision"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && reason.trim()) reject(); }}
              />
            </Label>
            {/* the dialog closes before the POST, like every other confirmation here: it is
                modal, so a refusal banner and a toast raised behind it are unreadable and
                non-interactive. The reason is kept on a refusal, so Reject reopens where it
                left off; it is cleared only once the reject lands. */}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setRejecting(false)}>Cancel</Button>
              <Button variant="destructive" size="sm" disabled={!reason.trim() || busy !== null} onClick={reject}>Reject the revision</Button>
            </div>
          </Dialog>

          {current.status === "rejected" && current.rejection_reason && (
            <Hint>Rejected {fmtWhen(current.rejected_at)}: “{current.rejection_reason}”. The reviser reads this as feedback.</Hint>
          )}
          {current.status === "accepted" && (
            <Hint>Accepted {fmtWhen(current.accepted_at)}. It applies to new runs only; a run in flight keeps the prompt it started with.</Hint>
          )}

          <Section title="Eval">
            {current.eval.score
              ? (
                <KeyValue
                  labelWidth={72}
                  items={[
                    { label: "Score", value: `${current.eval.score} — ${current.eval.verdict}` },
                    // HOW-42: the full A/B report — paired table, cost, trajectory deltas
                    ...(current.eval.report ? [{ label: "Report", value: current.eval.report, mono: true, copy: true }] : []),
                  ]}
                />
              )
              : current.eval.case
                ? <Hint>An eval case exists but has not been run: <code className={CODE}>bun {current.eval.case} --score-only --stamp</code></Hint>
                : <Hint>No eval case for this prompt yet. Cases are authored at first feedback, so judge the diff.</Hint>}
          </Section>

          <Section title="Feedback this answers" count={current.feedback.length}>
            {current.feedback.length === 0
              ? <Hint>No feedback on file for {current.id}.</Hint>
              : <div className="flex flex-col">{current.feedback.map((f, i) => <FeedbackEntry key={i} f={f} />)}</div>}
          </Section>

          {current.reflection && (
            <Section title="The reviser's reasoning">
              <p className="m-0 max-w-[72ch] whitespace-pre-wrap text-body leading-normal [overflow-wrap:anywhere]">{current.reflection}</p>
            </Section>
          )}

          <Section title="Diff">
            {current.diff ? <Diff text={current.diff} /> : <Hint>No diff on file. Compare the proposed template below with the prompt by eye.</Hint>}
          </Section>

          <Section title={`Proposed template, v${current.proposed_version}`}>
            <pre data-slot="proposal-body" className={PRE}>{current.body}</pre>
          </Section>
        </>
      }
    />
  );
}
