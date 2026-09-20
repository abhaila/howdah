/**
 * The slice UI — system-map slice 1d ("Render"): the approval card, the drift view and the
 * map-progress line. A FLAT render (isometric and motion are roadmap), drawn into the existing
 * Steps detail panel's slot: main.tsx StepDetail stays the one detail component (DESIGN.md),
 * and this module only supplies the panes it hosts (`slicePanes` / `SlicePane`).
 *
 * Everything shown comes from derive.ts `deriveSlice` (server-side, over the run log); this
 * file imports it as TYPES only, so no engine/ or map/ code reaches the browser bundle.
 *
 * Rules this file keeps (DESIGN.md + eng review):
 *   - Colour is the alarm. Amber (`--attention`) appears ONLY on the card while the round is
 *     `awaiting` — the needs-you moment, the same treatment as AskCard. Nothing else is amber.
 *   - Shape before colour. Ops (add / modify / remove / keep), tiers and drift outcomes are
 *     distinct SVG shapes that carry the meaning alone. The only colour second channel is the
 *     failure red on drift outcomes where the built code DISAGREES with the approved design —
 *     engine/slice-map PROBLEM_OUTCOMES, the one list routing, prompts and metrics also read,
 *     delivered as `problem` on each drift group. DESIGN.md grants that red to "a second thing
 *     a human must judge", and a disagreement is exactly that. `verified` and `not-checked` are
 *     neutral — a clean report shows no saturated colour at all.
 *   - One decision per round (D5/4A, D15): Approve is disabled once the round is decided, with
 *     the reason in words; a 409 refusal is shown VERBATIM, never a bare "failed"; a double
 *     click sends one request (an in-flight guard, and the route is idempotent anyway).
 *   - Comments pin to ghost identity keys (edges: `from→to:kind`); ones a redraw dropped are
 *     listed as orphaned, never hidden.
 *   - `verified` refers to a commit (D21): the drift view is stamped with the engine's name for the
 *     snapshot it checked ("<sha>" or "<sha> + uncommitted changes").
 */
import { useRef, useState } from "react";
import type { GhostGroup, GhostRow, RunDetail, SliceComment, SliceDecision, SliceDrift, SliceMapProgress, SliceMapSnapshot, SliceView } from "../derive";
import { Button, Input, Textarea } from "./ui";
// the ONE "14:02" reading, shared with the decision routes' refusals (dependency-free leaf)
import { clockTime as clock } from "../../core/clock-time";

// ---- formatting ---------------------------------------------------------------------

/** 12 characters — the length the engine's snapshot stamps use, so every sha on screen agrees. */
export const shortSha = (sha: string | null): string => (sha ? sha.slice(0, 12) : "(no commit)");

// ---- glyphs: shape carries the meaning --------------------------------------------------

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

type Op = GhostRow["op"];
const OP_PATH: Record<Op, string> = {
  add: "M8 3.5 V12.5 M3.5 8 H12.5", // plus
  modify: "M2.8 9.6 C4.6 5.2 6.6 5.2 8 8 C9.4 10.8 11.4 10.8 13.2 6.4", // wave
  remove: "M3.5 8 H12.5", // minus
  keep: "M3.8 6 H12.2 M3.8 10 H12.2", // equals
};

export function OpGlyph({ op }: { op: Op }) {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" className="op-glyph" data-op={op} role="img" aria-label={`op ${op}`}>
      <title>{op}</title>
      <path d={OP_PATH[op]} {...STROKE} />
    </svg>
  );
}

type Tier = NonNullable<GhostRow["tier"]>;
/**
 * SM-D4 tiers, strongest first: filled disc > ring with a heavy centre > square > diamond >
 * open brackets. Drawn at 12px with at most two round shapes, and no sub-pixel details (dots,
 * dashes): DESIGN.md records a glyph set that failed at 12px because its shapes read alike.
 */
export function TierGlyph({ tier }: { tier: Tier }) {
  const shape = {
    observed: <circle cx="8" cy="8" r="5" fill="currentColor" />,
    resolved: <><circle cx="8" cy="8" r="5" {...STROKE} /><circle cx="8" cy="8" r="2.4" fill="currentColor" /></>,
    syntactic: <rect x="3.2" y="3.2" width="9.6" height="9.6" {...STROKE} />,
    "evidence-checked": <path d="M8 2.2 L13.8 8 L8 13.8 L2.2 8 Z" {...STROKE} />,
    // brackets around nothing: a join the map could not prove
    unresolved: <path d="M6.2 3 H3.5 V13 H6.2 M9.8 3 H12.5 V13 H9.8" {...STROKE} />,
  }[tier];
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" className="tier-glyph" data-tier={tier} role="img" aria-label={`tier ${tier}`}>
      <title>{`tier: ${tier}`}</title>
      {shape}
    </svg>
  );
}

type Outcome = SliceDrift["groups"][number]["outcome"];

export const OUTCOME_LABEL: Record<Outcome, string> = {
  missing: "missing",
  "changed-unexpectedly": "changed unexpectedly",
  "still-present": "still present",
  unchanged: "unchanged (a change was expected)",
  unexpected: "unexpected change",
  partial: "partial",
  "not-checked": "not checked",
  verified: "verified",
};

/** `problem`: the code disagrees with the approved design — the only drift outcome that gets red. */
export function DriftGlyph({ outcome, problem }: { outcome: Outcome; problem: boolean }) {
  const shape = {
    missing: <path d="M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5" {...STROKE} />,
    "changed-unexpectedly": <path d="M2.6 9.4 L5.6 5 L8.8 11 L13.4 5.6" {...STROKE} />,
    "still-present": <rect x="4.2" y="4.2" width="7.6" height="7.6" fill="currentColor" />,
    unchanged: <circle cx="8" cy="8" r="4.8" {...STROKE} />,
    unexpected: <path d="M8 3 V13 M3.7 5.5 L12.3 10.5 M12.3 5.5 L3.7 10.5" {...STROKE} />,
    partial: <><rect x="3.6" y="3.6" width="8.8" height="8.8" {...STROKE} /><rect x="3.6" y="3.6" width="4.4" height="8.8" fill="currentColor" /></>,
    "not-checked": <path d="M5.8 6 C5.8 3.4 10.2 3.4 10.2 6 C10.2 7.8 8 8 8 10 M8 12.6 V12.8" {...STROKE} />,
    verified: <path d="M3.5 8.5 L6.5 11.5 L12.5 4.5" {...STROKE} />,
  }[outcome];
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" className={`drift-glyph${problem ? " problem" : ""}`} data-outcome={outcome} role="img" aria-label={OUTCOME_LABEL[outcome]}>
      <title>{OUTCOME_LABEL[outcome]}</title>
      {shape}
    </svg>
  );
}

// ---- panes hosted by the Steps detail panel ---------------------------------------------

export type SlicePaneId = "approval" | "drift" | "map";
type TimelineRow = RunDetail["timeline"][number];

const at = (x: { node: string; visit: number }, row: TimelineRow) => x.node === row.node && x.visit === row.visit;

/** The slice panes a step row gets, most specific first (the first is the default pane). */
export function slicePanes(slice: SliceView | null, row: TimelineRow): Array<{ value: SlicePaneId; label: string }> {
  if (!slice) return [];
  const out: Array<{ value: SlicePaneId; label: string }> = [];
  if (slice.proposal && slice.approval === row.node) out.push({ value: "approval", label: "Approval" });
  if (slice.drifts.some((d) => at(d, row))) out.push({ value: "drift", label: "Drift" });
  if ((slice.mapping && at(slice.mapping, row)) || slice.maps.some((m) => at(m, row))) out.push({ value: "map", label: "Map" });
  return out;
}

export function SlicePane({ pane, runId, slice, row, onChanged }: {
  pane: SlicePaneId;
  runId: string;
  slice: SliceView;
  row: TimelineRow;
  onChanged: () => void;
}) {
  // every visit of the approval node shows the CURRENT round; earlier rounds are listed in it
  if (pane === "approval") return <ApprovalCard runId={runId} slice={slice} onChanged={onChanged} />;
  if (pane === "drift") {
    const drift = slice.drifts.findLast((d) => at(d, row));
    return drift ? <DriftView drift={drift} /> : <div className="pd-note">no drift report for this step</div>;
  }
  const progress = slice.mapping && at(slice.mapping, row) ? slice.mapping : null;
  const snap = slice.maps.findLast((m) => at(m, row)) ?? null;
  return <MapPane progress={progress} snapshot={snap} />;
}

// ---- map progress -----------------------------------------------------------------------

/** "mapping files 412/1300" — the slim line a cold parse shows while map.extract runs. */
export function MapProgressLine({ progress }: { progress: SliceMapProgress }) {
  const pct = progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0;
  return (
    <span className="map-progress" data-testid="map-progress">
      <span className="m">mapping files {progress.done}/{progress.total}</span>
      {progress.skipped > 0 && <span className="m mp-skipped"> · {progress.skipped} skipped</span>}
      <span className="mp-track"><span className="mp-fill" style={{ width: `${pct}%` }} /></span>
    </span>
  );
}

function MapPane({ progress, snapshot }: { progress: SliceMapProgress | null; snapshot: SliceMapSnapshot | null }) {
  return (
    <div className="map-pane">
      {progress && <MapProgressLine progress={progress} />}
      {snapshot && (
        <>
          <h2 className="rh">Snapshot</h2>
          <div className="kv"><span className="k">commit</span><span className="v m" title={snapshot.commit ?? ""}>{snapshot.stamp}</span></div>
          <div className="kv"><span className="k">manifest</span><span className="v m" title={snapshot.manifest_hash}>{snapshot.manifest_hash.slice(0, 12)}</span></div>
          <div className="kv"><span className="k">files</span><span className="v m">{snapshot.files}</span></div>
          <div className="kv"><span className="k">skipped</span><span className="v m">{snapshot.skipped}</span></div>
          <div className="kv"><span className="k">not checked</span><span className="v m">{snapshot.not_checked}</span></div>
          <div className="kv"><span className="k">unparsed regions</span><span className="v m">{snapshot.unparsed}</span></div>
          <div className="kv"><span className="k">tiers run</span><span className="v m">{snapshot.tiers_run.join(", ") || "none"}</span></div>
        </>
      )}
      {!progress && !snapshot && <div className="pd-note">no extraction recorded for this step</div>}
    </div>
  );
}

// ---- the approval card --------------------------------------------------------------------

/** Why Approve (and every other decision) is closed for this round, or null while it is open. */
export function decisionBlock(d: SliceDecision | null): string | null {
  if (!d) return "nothing has been proposed yet";
  switch (d.kind) {
    case "awaiting":
    case "undecided":
      return null;
    case "parked-other":
      return d.decided ? `${d.decided.kind === "approved" ? "approved" : "feedback sent"} at ${clock(d.decided.at)}` : null;
    case "approved":
      return `approved at ${clock(d.at)}`;
    case "feedback":
      return `feedback sent at ${clock(d.at)}`;
    case "stale":
      return `stale since ${clock(d.at)}`;
    case "redesigning":
      return `redesign requested at ${clock(d.at)}`;
    case "closed":
      return `run finished (${d.outcome})`;
  }
}

/** The round's state explained in words — the card never leaves a state unexplained. */
function explain(d: SliceDecision, approval: string): string {
  switch (d.kind) {
    case "awaiting":
      return "The run is parked until you decide. Pin comments on rows and send them as feedback, approve the design, or ask for a redesign.";
    case "undecided":
      return `The run is not parked on this round yet — it asks when it reaches ${approval}. You can already pin comments.`;
    case "parked-other":
      return `The run parked on ${approval}${d.code ? ` (${d.code})` : ""}: ${d.reason}. Answer it in the Ask tab — a reply, not a design decision, moves it on.` +
        (d.decided ? ` This round was already ${d.decided.kind === "approved" ? "approved" : "sent back with feedback"} at ${clock(d.decided.at)}.` : "");
    case "approved":
      return `Approved at ${clock(d.at)}. Implementation is gated on this approval; a redraw or a moved base needs a new one.`;
    case "feedback":
      return `Feedback sent at ${clock(d.at)} with ${d.comments} comment${d.comments === 1 ? "" : "s"}. The proposer is redrawing; the next round supersedes this one.`;
    case "stale":
      return `Stale: ${d.reason ?? "the worktree changed after this proposal was drawn"}. The map is re-extracted and a fresh proposal drawn — nothing to decide on this round.`;
    case "redesigning":
      return `Redesign requested at ${clock(d.at)}: “${d.message}”. The map is re-extracted and a new proposal supersedes this one.`;
    case "closed":
      return `The run finished (${d.outcome}) — nothing can be decided now.`;
  }
}

/**
 * The card's local action state, bound to the round it was taken on: a "done" on round 1 must
 * not disable round 2 when the redraw arrives in the same card. A refusal stays visible across
 * the reload it triggers — it explains why the round changed under the operator.
 */
type Act = { round: number } & (
  | { state: "idle" }
  | { state: "sending"; what: string }
  | { state: "done"; text: string }
  | { state: "refused"; text: string }
  | { state: "error"; text: string }
);

/**
 * POST a decision-route body. A 409 carries the refusal text the rules wrote — returned
 * verbatim. A transport failure says so, never a bare "failed".
 */
async function post(url: string, body: unknown): Promise<{ ok: true; json: any } | { ok: false; refused: boolean; text: string }> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (err) {
    return { ok: false, refused: false, text: `could not reach the viewer server: ${err instanceof Error ? err.message : String(err)}` };
  }
  const json = (await res.json().catch(() => null)) as any;
  if (res.ok) return { ok: true, json };
  const text = typeof json?.error === "string" ? json.error : `the server answered ${res.status}`;
  return { ok: false, refused: res.status === 409, text };
}

export function ApprovalCard({ runId, slice, onChanged }: { runId: string; slice: SliceView; onChanged: () => void }) {
  const p = slice.proposal;
  const [act, setAct] = useState<Act>({ state: "idle", round: 0 });
  const inFlight = useRef(false); // a double click must issue ONE request, whatever React batches
  const [redesignOpen, setRedesignOpen] = useState(false);
  const [redesignText, setRedesignText] = useState("");

  if (!p || !slice.approval) return <div className="pd-note">nothing has been proposed yet</div>;
  const decision = slice.decision;
  const block = decisionBlock(decision);
  // both need the human now: a decision (awaiting) or a reply in the Ask pane (parked-other)
  const needsYou = decision?.kind === "awaiting" || decision?.kind === "parked-other";
  const finished = decision?.kind === "closed";
  const roundComments = [...Object.values(slice.comments).flat(), ...slice.orphaned].filter((c) => c.proposal_id === p.proposal_id);
  const busy = act.state === "sending";
  const decidedHere = act.state === "done" && act.round === p.proposal_id;

  const run = async (what: string, url: string, body: unknown, done: (json: any) => string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const round = p.proposal_id;
    setAct({ state: "sending", what, round });
    try {
      const r = await post(url, body);
      if (r.ok) {
        setAct({ state: "done", text: done(r.json), round });
        onChanged();
      } else {
        setAct({ state: r.refused ? "refused" : "error", text: r.text, round });
        if (r.refused) onChanged(); // a refusal means the log moved on: show the state it moved to
      }
    } finally {
      inFlight.current = false;
    }
  };

  const decide = (approved: boolean) =>
    run(approved ? "approve" : "feedback", `/api/runs/${runId}/approval`, { approved, proposal_id: p.proposal_id }, (json) =>
      json?.idempotent
        ? `already ${approved ? "approved" : "sent as feedback"} — nothing new was recorded`
        : approved ? "approved — the run resumes into implementation" : "feedback sent — the proposer redraws");

  const feedbackBlock = block ?? (roundComments.length === 0 ? "pin at least one comment on this round first" : null);

  return (
    <div className={`approval-card${needsYou ? " needs-you" : ""}`} data-state={decision?.kind ?? "none"} id={decision?.kind === "awaiting" ? "needs-input" : undefined}>
      <div className="ap-head">
        <h3>
          {decision?.kind === "awaiting" ? "Needs you — approve this design"
            : decision?.kind === "parked-other" ? "Needs you — see the Ask tab"
            : "Proposed design"}
        </h3>
        {/* "current": an older visit's panel shows today's round, never that visit's state */}
        <span className="m ap-round">current round {p.round} · proposal #{p.proposal_id}</span>
      </div>
      {decision && <div className="ap-explain" data-testid="ap-explain">{explain(decision, slice.approval)}</div>}

      {p.ghosts ? (
        <>
          <TierSummary proposal={p} />
          <div className="ghost-list">
            {p.groups.map((g) => (
              <GhostGroupView key={g.block || "(other)"} group={g} slice={slice} runId={runId} canPin={block === null} proposalId={p.proposal_id} onChanged={onChanged} />
            ))}
          </div>
          {p.traces.length > 0 && (
            <div className="ap-traces">
              <h2 className="rh">Traces <span className="ap-aside">the proposer's scenarios — drift checks them after the build</span></h2>
              {p.traces.map((t, i) => (
                <div key={i} className="ap-trace">
                  <span className="ap-trace-name">{t.scenario}</span>
                  <span className="m ap-trace-steps">{t.steps.join(" → ")}</span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="pd-note">this proposal is not a ghost set — shown as proposed</div>
          <pre className="sd-raw">{JSON.stringify(p.raw, null, 2)}</pre>
        </>
      )}

      {slice.orphaned.length > 0 && (
        <div className="ap-orphans" data-testid="orphaned">
          <h2 className="rh">Orphaned (no longer in this proposal)</h2>
          {slice.orphaned.map((c) => <CommentLine key={c.id} c={c} showKey />)}
        </div>
      )}

      <div className="actions ap-actions">
        <Button size="sm" variant="outline" disabled={busy || decidedHere || finished || feedbackBlock !== null} title={feedbackBlock ?? undefined} onClick={() => decide(false)}>
          {busy && act.what === "feedback" ? "Sending…" : "Send feedback"}
        </Button>
        <Button size="sm" disabled={busy || decidedHere || block !== null} title={block ?? undefined} onClick={() => decide(true)}>
          {busy && act.what === "approve" ? "Approving…" : "Approve"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy || finished} aria-expanded={redesignOpen} onClick={() => setRedesignOpen(!redesignOpen)}>Redesign</Button>
        {block && <span className="send-state ap-block" data-testid="ap-block">{block}</span>}
        {!block && feedbackBlock && <span className="send-state">{feedbackBlock} to send feedback</span>}
      </div>

      {redesignOpen && (
        <div className="ap-redesign">
          <Textarea
            autoFocus
            aria-label="redesign message"
            placeholder="What should the proposer do differently? The map is re-extracted and this message reaches the next proposal once."
            value={redesignText}
            onChange={(e) => setRedesignText(e.target.value)}
          />
          <div className="actions">
            <Button
              size="sm"
              disabled={busy || redesignText.trim() === ""}
              onClick={() =>
                run("redesign", `/api/runs/${runId}/redesign`, { message: redesignText }, () => {
                  setRedesignOpen(false);
                  setRedesignText("");
                  return "redesign requested — re-extracting the map for a new proposal";
                })}
            >
              {busy && act.what === "redesign" ? "Requesting…" : "Request redesign"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRedesignOpen(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {decidedHere && act.state === "done" && <div className="send-state" role="status">{act.text}</div>}
      {(act.state === "refused" || act.state === "error") && (
        <div className="send-state ap-refusal" role="alert">
          {/* kept across the reload a refusal triggers (it explains why the round moved), but
              named by its round once a newer one is on screen */}
          {act.round !== p.proposal_id && <span className="m">proposal #{act.round}: </span>}
          {act.text}
        </div>
      )}

      {slice.rounds.length > 1 && (
        <div className="ap-rounds">
          <h2 className="rh">Earlier rounds</h2>
          {slice.rounds.filter((r) => r.proposal_id !== p.proposal_id).map((r) => (
            <div key={r.proposal_id} className="ap-round-row">
              <span className="m">round {r.round} · #{r.proposal_id}</span>
              <span>
                {r.outcome === "approved" ? `approved at ${clock(r.decided_at!)}`
                  : r.outcome === "feedback" ? `feedback sent at ${clock(r.decided_at!)}`
                  : r.outcome === "stale" ? `went stale at ${clock(r.decided_at!)}`
                  : "never decided"}
                {" · superseded"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TierSummary({ proposal }: { proposal: NonNullable<SliceView["proposal"]> }) {
  if (!proposal.tiers_known) return <div className="pd-note ap-tiers">tiers unknown — the base snapshot could not be read</div>;
  const known = Object.entries(proposal.tier_counts);
  return (
    <div className="pd-note ap-tiers">
      {known.map(([t, n]) => <span key={t} className="ap-tier"><TierGlyph tier={t as Tier} /> {t} {n}</span>)}
      {proposal.untiered > 0 && <span className="ap-tier">{proposal.untiered} new (no tier until built)</span>}
    </div>
  );
}

function GhostGroupView({ group, slice, runId, canPin, proposalId, onChanged }: {
  group: GhostGroup; slice: SliceView; runId: string; canPin: boolean; proposalId: number; onChanged: () => void;
}) {
  const shared = { slice, runId, canPin, proposalId, onChanged };
  return (
    <section className="ghost-group" data-block={group.block}>
      {group.row
        ? <GhostRowView row={group.row} {...shared} />
        : <div className="ghost-row ghost-context"><span className="m gr-id">{group.block || "other edges"}</span>{group.block && <span className="gr-kind">existing block</span>}</div>}
      <div className="ghost-children">
        {group.entities.map((r) => <GhostRowView key={r.id} row={r} {...shared} />)}
        {group.edges.map((r) => <GhostRowView key={r.id} row={r} {...shared} />)}
      </div>
    </section>
  );
}

function GhostRowView({ row, slice, runId, canPin, proposalId, onChanged }: {
  row: GhostRow; slice: SliceView; runId: string; canPin: boolean; proposalId: number; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [state, setState] = useState<{ sending: boolean; error: string | null }>({ sending: false, error: null });
  const comments = slice.comments[row.id] ?? [];

  const pin = async () => {
    if (state.sending || text.trim() === "") return;
    setState({ sending: true, error: null });
    const r = await post(`/api/runs/${runId}/comments`, { entity_id: row.id, text, proposal_id: proposalId });
    if (r.ok) {
      setState({ sending: false, error: null });
      setText("");
      setOpen(false);
      onChanged();
    } else {
      setState({ sending: false, error: r.text });
      if (r.refused) onChanged(); // like a refused decision: the log moved on, show where
    }
  };

  return (
    <div className="ghost-item" data-id={row.id}>
      <div className="ghost-row">
        <OpGlyph op={row.op} />
        <span className="gr-tier">{row.tier && <TierGlyph tier={row.tier} />}</span>
        <span className="m gr-id" title={row.id}>
          {row.edge ? <>{row.edge.from} <span className="gr-arrow">→</span> {row.edge.to}</> : row.id}
        </span>
        <span className="gr-kind">{row.edge ? `${row.edge.kind} edge` : row.subject}</span>
        {canPin && (
          <button className="gr-pin" aria-label={`pin a comment on ${row.id}`} onClick={() => setOpen(!open)}>pin</button>
        )}
      </div>
      {(row.expected_file || row.prose) && (
        <div className="gr-sub">
          {row.expected_file && <span className="m gr-file">{row.expected_file}</span>}
          {row.prose && <span className="gr-prose">{row.prose} <span className="gr-unverified">prose, not verified</span></span>}
        </div>
      )}
      {comments.map((c) => <CommentLine key={c.id} c={c} current={c.proposal_id === proposalId} />)}
      {open && (
        <div className="gr-pin-form">
          <Input
            autoFocus
            aria-label={`comment on ${row.id}`}
            placeholder="Comment for the proposer…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void pin(); }}
          />
          <Button size="sm" disabled={state.sending || text.trim() === ""} onClick={() => void pin()}>{state.sending ? "Pinning…" : "Pin"}</Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          {state.error && <div className="send-state ap-refusal" role="alert">{state.error}</div>}
        </div>
      )}
    </div>
  );
}

function CommentLine({ c, current = true, showKey = false }: { c: SliceComment; current?: boolean; showKey?: boolean }) {
  return (
    <div className="ap-comment" data-comment={c.id}>
      {showKey && <span className="m ap-comment-key">{c.entity_id}</span>}
      <span className="ap-comment-text">{c.text}</span>
      <span className="m ap-comment-meta">
        {current ? "" : `round ${c.round} · `}{clock(c.at)}{c.sent ? " · sent" : ""}
      </span>
    </div>
  );
}

// ---- the drift view -----------------------------------------------------------------------

/** Drift after the build: grouped by outcome, worst first, stamped with the commit it checked (D21). */
export function DriftView({ drift }: { drift: SliceDrift }) {
  const listed = drift.groups.reduce((n, g) => n + g.items.length, 0);
  return (
    <div className="drift-view">
      <div className="dv-head">
        <span className="dv-title">Drift</span>
        <span className="m dv-stamp" data-testid="drift-stamp" title={drift.commit ?? ""}>checked at {drift.stamp}</span>
        {drift.base_commit && <span className="m dv-base" title={drift.base_commit}>base {shortSha(drift.base_commit)}</span>}
      </div>
      {drift.dirty && (
        <div className="pd-note">The checked snapshot had uncommitted changes, so nothing in it is reported verified — commit them and drift can verify against a commit.</div>
      )}
      {drift.extractor_mismatch && (
        <div className="pd-note">
          Base and after were extracted by different map versions (<span className="m">{drift.extractor_mismatch.base}</span> vs{" "}
          <span className="m">{drift.extractor_mismatch.after}</span>), so every ghost is not checked.
        </div>
      )}
      {drift.base_reextracted && <div className="pd-note">The base was re-extracted at its commit with the current map version before comparing.</div>}
      {drift.outdated && (
        <div className="pd-note">HEAD is now <span className="m">{shortSha(drift.head_now)}</span> — this check does not cover the latest code.</div>
      )}
      {drift.groups.length === 0 && <div className="pd-note">nothing to check — the approved design names nothing drift can see</div>}
      {drift.groups.map((g) => (
        <section key={g.outcome} className="dv-group" data-outcome={g.outcome}>
          <h2 className="rh dv-group-head"><DriftGlyph outcome={g.outcome} problem={g.problem} /> {OUTCOME_LABEL[g.outcome]} <span className="m dv-count">{g.count}</span></h2>
          {g.items.map((it, i) => (
            <div key={`${it.key}#${i}`} className="dv-item" data-outcome={it.outcome}>
              <div className="dv-row">
                <DriftGlyph outcome={it.outcome} problem={g.problem} />
                <span className="m dv-key" title={it.key}>{it.key}</span>
                <span className="dv-kind">{it.kind}{it.op ? ` · ${it.op}` : ""}</span>
              </div>
              {(it.reason || it.evidence) && (
                <div className="dv-sub">
                  {it.reason && <span className="dv-reason">{it.reason}</span>}
                  {it.evidence && <span className="m dv-evidence">{it.evidence}</span>}
                </div>
              )}
            </div>
          ))}
          {g.count > g.items.length && <div className="pd-note">{g.count - g.items.length} more not listed</div>}
        </section>
      ))}
      {drift.truncated > 0 && (
        <div className="pd-note" data-testid="drift-truncated">{drift.truncated} item{drift.truncated === 1 ? "" : "s"} not listed ({listed} shown); the counts above cover every item</div>
      )}
    </div>
  );
}
