/**
 * Howdah web app v0 (T11). Path routing: `/` runs list, `/run/:id` run view
 * (deep-linkable, `#needs-input` focuses the reply). Live via SSE. Served pre-bundled
 * as /app.js (bun build web/app/main.tsx — see web/server.ts startup).
 */
import "./globals.css";
import { createRoot } from "react-dom/client";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select, Tabs, Textarea, Badge } from "./ui";
import {
  Rows3, Plus, Workflow, Settings as SettingsIcon, Play, Pause, OctagonX, RotateCcw, Send,
  ExternalLink, GitBranch, GitPullRequest, Clock, Coins, Pin, Fingerprint, MessagesSquare,
  CornerDownRight, FolderGit2, X, Library, FileDiff, MessageSquarePlus, ThumbsUp, ScrollText,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunDetail, RunSummary, RunStatus, LogRow } from "../derive";
import { citeParts } from "../derive";
import type { CoalescedTurn } from "../../log/coalesce";
// type-only: erased at bundle time, so the server's node imports never reach the browser
import type { PromptDetail, PromptSummary, ReconstructedRender } from "../../prompts/library";
import type { ProposalView } from "../../prompts/proposals";
import { GraphDag, useGraphShape, type GraphShapeDto, type AgentConfigDto } from "./graph-dag";

// ---- shared bits ---------------------------------------------------------------

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "queued", running: "running", "needs-input": "needs input", waiting: "waiting",
  "failed-recoverable": "failed", "failed-terminal": "failed", done: "done", "harness-dead": "harness dead",
};

function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className={`status ${status}`} style={{ ["--status-color" as any]: `var(--status-${status})` }}>
      <span className="dot" /> {STATUS_LABEL[status]}
    </span>
  );
}

function useNow(tickMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(t);
  }, [tickMs]);
  return now;
}

function fmtWait(sinceIso: string, now: number): string {
  const m = Math.floor(Math.max(0, now - new Date(sinceIso).getTime()) / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function Mark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" fill="none" aria-label="Howdah">
      <path d="M 52 46 C 57 38 57 24 48 18 L 41 18 L 41 11 L 28 11 L 28 18 L 22 18 C 13 20 9 27 9 33 C 9 41 7 47 11 53 C 13 56 18 56 19 52"
        stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="21" cy="30" r="3" fill="#cfac3f" />
    </svg>
  );
}

// needs-attention surfaces: trunk-raise favicon + one two-note chime on transition
function useAttentionSurfaces(needsInput: boolean) {
  const prev = useRef(needsInput);
  useEffect(() => {
    const fav = document.getElementById("favicon") as HTMLLinkElement | null;
    let timer: ReturnType<typeof setInterval> | undefined;
    if (needsInput) {
      let frame = 0;
      const frames = ["/favicon-raise-1.svg", "/favicon-raise-2.svg"];
      timer = setInterval(() => { if (fav) fav.href = frames[(frame = (frame + 1) % 2)]!; }, 900);
      if (!prev.current) new Audio("/chime.wav").play().catch(() => {});
    } else if (fav) fav.href = "/favicon.svg";
    prev.current = needsInput;
    return () => { if (timer) clearInterval(timer); if (fav) fav.href = "/favicon.svg"; };
  }, [needsInput]);
}


// ---- load splash: the mark draws itself, once per browser session ------------------
// Delight is rare-frequency only: sessionStorage gates repeats, and the app loads
// underneath — the splash never delays data. Reduced motion gets a plain fade.

function Splash({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    // autoplay is blocked until the user's first gesture on the origin — if the direct
    // play is refused, the jingle rides the first click/keypress instead (12s window)
    const audio = new Audio("/boot.wav");
    let cleanupUnlock = () => {};
    audio.play().catch(() => {
      const unlock = () => { audio.play().catch(() => {}); cleanupUnlock(); };
      addEventListener("pointerdown", unlock, { once: true });
      addEventListener("keydown", unlock, { once: true });
      const expire = setTimeout(cleanupUnlock, 12000);
      cleanupUnlock = () => { removeEventListener("pointerdown", unlock); removeEventListener("keydown", unlock); clearTimeout(expire); };
    });
    const hold = setTimeout(() => setLeaving(true), 1900);
    const gone = setTimeout(() => { sessionStorage.setItem("howdah-splash", "1"); onDone(); }, 2350);
    return () => { clearTimeout(hold); clearTimeout(gone); };
  }, [onDone]);
  return (
    <div className={`splash ${leaving ? "leaving" : ""}`}>
      <svg viewBox="0 0 64 64" fill="none" className="splash-mark" aria-label="Howdah">
        <path
          className="splash-stroke"
          pathLength={100}
          d="M 52 46 C 57 38 57 24 48 18 L 41 18 L 41 11 L 28 11 L 28 18 L 22 18 C 13 20 9 27 9 33 C 9 41 7 47 11 53 C 13 56 18 56 19 52"
          stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
        <circle className="splash-eye" cx="21" cy="30" r="3" fill="#cfac3f" />
      </svg>
      <div className="splash-word">Howdah</div>
    </div>
  );
}

// ---- runs list -----------------------------------------------------------------

function RunsList() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const now = useNow();
  useEffect(() => {
    const load = () => fetch("/api/runs").then((r) => r.json()).then(setRuns).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  useAttentionSurfaces(!!runs?.some((r) => r.status === "needs-input"));

  if (!runs) return <div className="empty">loading…</div>;
  if (runs.length === 0)
    return (
      <div className="empty">
        <Mark className="mark" />
        <div>no runs yet — <code>howdah run &lt;graph&gt;</code></div>
      </div>
    );
  return (
    <div>
      <h1>Runs</h1>
      {runs.map((r) => (
        <a key={r.id} className={`run-row ${r.status === "needs-input" ? "needs-input" : ""}`} href={`/run/${r.id}`}>
          <StatusBadge status={r.status} />
          <span className="run-goal">{r.goal || r.id}</span>
          <span className="run-meta">
            {r.status === "needs-input" && r.waiting_since
              ? <span className="wait-timer">waiting {fmtWait(r.waiting_since, now)}</span>
              : r.graph}
          </span>
        </a>
      ))}
    </div>
  );
}

// ---- run view ------------------------------------------------------------------

/**
 * Prompt & context (R3.1) plus Add feedback (R2's loop, T21).
 *
 * The log stores the rendered_hash, never the rendered text, so the text is fetched from
 * the server, which rebuilds it from the run's PINNED template and re-hashes to prove it.
 * An unproven reconstruction says so — showing a guess as fact is the failure mode here.
 */
function PromptAndContext({ runId, render }: { runId: string; render: RunDetail["renders"][number] }) {
  const [open, setOpen] = useState(false);
  const [instance, setInstance] = useState<ReconstructedRender | "missing" | null>(null);
  const [feedback, setFeedback] = useState(false);

  useEffect(() => {
    if (!open || instance) return;
    fetch(`/api/runs/${runId}/render/${render.rendered_hash}`)
      .then((r) => (r.ok ? r.json() : "missing"))
      .then(setInstance)
      .catch(() => setInstance("missing"));
  }, [open, instance, runId, render.rendered_hash]);

  return (
    <div className="prompt-context">
      <div className="pc-head">
        <span className="linkish" onClick={() => setOpen(!open)}>
          Prompt &amp; context · {render.prompt} v{render.prompt_version} {open ? "▾" : "▸"}
        </span>
        <button className="pc-feedback" onClick={() => { setFeedback(!feedback); setOpen(true); }}>
          <MessageSquarePlus size={12} /> Add feedback
        </button>
      </div>
      {open && (
        <>
          {instance === null && <div className="pc-note">rebuilding the rendered prompt…</div>}
          {instance === "missing" && (
            <div className="pc-note warn">
              the rendered prompt cannot be rebuilt — this run's pinned copy of {render.prompt} is gone
            </div>
          )}
          {instance && instance !== "missing" && (
            <>
              <div className={`pc-note ${instance.verified ? "" : "warn"}`}>
                {instance.verified
                  ? "verified against the recorded rendered_hash — this is exactly what the agent read"
                  : "UNVERIFIED — the rebuild does not match the recorded hash, so treat it as approximate"}
              </div>
              <pre className="pc-rendered">{instance.text}</pre>
            </>
          )}
          <div className="pc-note">context read</div>
          <pre>{JSON.stringify(render.context_read, null, 2)}</pre>
        </>
      )}
      {feedback && (
        <FeedbackForm
          promptId={render.prompt}
          runId={runId}
          node={render.node}
          visit={render.visit}
          renderedHash={render.rendered_hash}
          onDone={() => setFeedback(false)}
        />
      )}
    </div>
  );
}

/** Writes one reviser-format line, pre-filled with the turn it refers to (A2.2). */
function FeedbackForm({ promptId, runId, node, visit, renderedHash, onDone }: {
  promptId: string; runId: string; node: string; visit: number; renderedHash: string; onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [verdict, setVerdict] = useState<"reject" | "accept">("reject");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setState("saving");
    setError(null);
    const res = await fetch(`/api/prompts/${encodeURIComponent(promptId)}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run: runId, node, visit, note, verdict, rendered_hash: renderedHash }),
    }).catch(() => null);
    if (!res || !res.ok) {
      setError(((await res?.json().catch(() => null)) as any)?.error ?? "could not save feedback");
      setState("failed");
      return;
    }
    setState("saved");
  };

  if (state === "saved")
    return (
      <div className="feedback-card">
        <div className="pc-note">
          feedback recorded against {node}@{visit} — nothing changed yet (R2).{" "}
          <a href={`/prompts/${encodeURIComponent(promptId)}`}>Open {promptId}</a> to draft a revision.
        </div>
        <Button variant="ghost" size="sm" onClick={onDone}>Close</Button>
      </div>
    );

  return (
    <div className="feedback-card">
      <div className="pc-note">
        feedback on <strong>{promptId}</strong> at {node}@{visit} · hash {renderedHash}
      </div>
      <Tabs
        value={verdict}
        onValueChange={(v) => setVerdict(v as "reject" | "accept")}
        items={[{ value: "reject", label: "Needs work" }, { value: "accept", label: "Good" }]}
      />
      <Textarea
        autoFocus
        placeholder="What should this prompt do differently? Be specific — the reviser reflects on exactly this."
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      {error && <div className="field-error">{error}</div>}
      <div className="feedback-actions">
        <Button size="sm" disabled={!note.trim() || state === "saving"} onClick={send}>
          <Send />{state === "saving" ? "saving…" : "Save feedback"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

/** Row kinds in the transcript. Shape carries the kind; colour only seconds it. */
function RowGlyph({ kind }: { kind: "prompt" | "model" | "tool" | "error" | "operator" }) {
  const st = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const d = {
    prompt: "M3 8 H11 M8 5 L11 8 L8 11",
    model: "M4 5 H12 M4 8 H12 M4 11 H9",
    tool: "M5 4 L11 4 L11 12 L5 12 Z M7 7 H9",
    error: "M5 5 L11 11 M11 5 L5 11",
    operator: "M4 10 L7 7 L4 4 M8 11 H12",
  }[kind];
  return (
    <span className={`tr-icon ${kind}`}>
      <svg width="11" height="11" viewBox="0 0 16 16" aria-label={kind}><path d={d} {...st} /></svg>
    </span>
  );
}

function TranscriptRow({ kind, name, text, chips }: {
  kind: "prompt" | "model" | "tool" | "error" | "operator";
  name: string;
  text: string;
  chips: string[];
}) {
  return (
    <div className={`tr-row ${kind}`}>
      <RowGlyph kind={kind} />
      <div className="tr-body">
        <div className="tr-head">
          <span className="m tr-name">{name}</span>
          <span className="tr-chips">{chips.map((c, i) => <span key={i} className="m tr-chip">{c}</span>)}</span>
        </div>
        <div className="tr-text">{text}</div>
      </div>
    </div>
  );
}

/**
 * Thread (T24, story 6) — Laminar's transcript: one row per thing that happened, with
 * time, tokens and cost on the right. Replaces the flat delta stream that R3.2 complained
 * about. A tool result that failed becomes its own row rather than hiding in a cluster.
 */
function Turn({ turn, render, runId }: { turn: CoalescedTurn; render?: RunDetail["renders"][number]; runId: string }) {
  const rows: React.ReactNode[] = [];
  if (render) {
    rows.push(
      <TranscriptRow
        key="prompt"
        kind="prompt"
        name="prompt sent"
        text={`${render.prompt} v${render.prompt_version} · read ${Object.keys(render.context_read).join(", ") || "nothing"}`}
        chips={render.model ? [`${render.harness ?? "claude"} · ${render.model}`] : []}
      />,
    );
  }
  const allText = turn.parts.filter((p) => p.kind === "text").map((p) => p.content).join("");
  // engine/run.ts appends "[attempt failed: <why>]" as a text chunk when an executor throws
  const failure = allText.match(/\[attempt failed: ([^\]]+)\]/);
  const text = allText.replace(/\n?\[attempt failed: [^\]]+\]/, "").trim();
  if (text) {
    const u = turn.usage;
    const chips: string[] = [];
    if (u?.input_tokens !== undefined) chips.push(`${(u.input_tokens / 1000).toFixed(1)}K in`);
    if (u?.output_tokens !== undefined) chips.push(`${u.output_tokens} out`);
    if (u?.cost_usd !== undefined) chips.push(`$${u.cost_usd.toFixed(4)}`);
    rows.push(<TranscriptRow key="text" kind="model" name={render?.model ?? "agent"} text={text} chips={chips} />);
  }
  for (const [i, p] of turn.parts.entries()) {
    if (p.kind === "tool_call") rows.push(<TranscriptRow key={`t${i}`} kind="tool" name={p.tool_name ?? "tool"} text={p.content} chips={[]} />);
    else if (p.kind === "tool_result" && /error|failed|exit \d|denied/i.test(p.content))
      rows.push(<TranscriptRow key={`e${i}`} kind="error" name={`${p.tool_name ?? "tool"} failed`} text={p.content} chips={[]} />);
  }
  if (failure) rows.push(<TranscriptRow key="failure" kind="error" name="attempt failed" text={failure[1]!} chips={[]} />);
  return (
    <div className={`turn ${turn.finalized ? "" : "unfinalized"}`}>
      <div className="tr-node m">
        {turn.node}<span className="tr-visit">@{turn.visit}</span>
        {!turn.finalized && <span className="tr-interrupted">interrupted</span>}
      </div>
      {rows}
      {render && <PromptAndContext runId={runId} render={render} />}
    </div>
  );
}

function RunControls({ runId, summary, onAction }: { runId: string; summary: RunDetail["summary"]; onAction: () => void }) {
  const [confirmAbort, setConfirmAbort] = useState(false);
  const act = (verb: string) => fetch(`/api/runs/${runId}/${verb}`, { method: "POST" }).then(() => { setConfirmAbort(false); setTimeout(onAction, 300); });
  const active = ["running", "needs-input", "waiting", "failed-recoverable", "queued"].includes(summary.status);
  if (!active) return null;
  return (
    <span className="run-controls">
      {summary.paused
        ? <Button variant="outline" size="sm" onClick={() => act("resume")}><Play />Resume</Button>
        : summary.status === "running" && <Button variant="outline" size="sm" onClick={() => act("pause")}><Pause />Pause</Button>}
      {confirmAbort
        ? <Button variant="destructive" size="sm" onClick={() => act("abort")}><OctagonX />Really abort?</Button>
        : <Button variant="outline" size="sm" onClick={() => setConfirmAbort(true)}><OctagonX />Abort</Button>}
    </span>
  );
}

function RunGraph({ runId, graph, timeline, status, onJumped }: { runId: string; graph: string; timeline: RunDetail["timeline"]; status: string; onJumped: () => void }) {
  const shape = useGraphShape(graph);
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "jumping" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  if (!shape) return <div className="empty">loading graph…</div>;
  const visits: Record<string, number> = {};
  for (const t of timeline) visits[t.node] = Math.max(visits[t.node] ?? 0, t.visit);
  const running = timeline.findLast((t) => t.status === "running");
  const current = running?.node ?? timeline.at(-1)?.node;
  const jumpable = status !== "done" && status !== "failed-terminal" && status !== "running";

  const jump = async () => {
    setState("jumping");
    setError(null);
    try {
      const r = await fetch(`/api/runs/${runId}/jump`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ node: jumpTo, message: message || undefined }),
      });
      if (!r.ok) throw new Error(((await r.json()) as any).error);
      setJumpTo(null);
      setMessage("");
      setState("idle");
      setTimeout(onJumped, 500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("failed");
    }
  };

  return (
    <div style={{ paddingTop: 16 }}>
      {jumpTo && (
        <div className="ask-card jump-card" style={{ marginBottom: 12 }}>
          <h3>Jump to {jumpTo}</h3>
          <div className="field-hint">Starts a fresh attempt at this node using the current context. Your instruction is injected into its prompt and takes precedence.</div>
          <Textarea autoFocus value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Instructions for this step (optional)…" />
          {error && <div className="field-error">{error}</div>}
          <div className="actions">
            <Button onClick={jump} disabled={state === "jumping"}><CornerDownRight />{state === "jumping" ? "Jumping…" : "Jump here"}</Button>
            <Button variant="outline" size="sm" onClick={() => { setJumpTo(null); setError(null); }}><X />Cancel</Button>
          </div>
        </div>
      )}
      {jumpable && !jumpTo && <div className="field-hint" style={{ marginBottom: 8 }}>Click an agent node to jump the run there with instructions.</div>}
      {!jumpable && status === "running" && <div className="field-hint" style={{ marginBottom: 8 }}>Pause the run to enable jumping.</div>}
      <GraphDag shape={shape} current={current} visits={visits} onSelect={jumpable ? setJumpTo : undefined} selected={jumpTo ?? undefined} />
    </div>
  );
}

function OpenIdeButton({ runId, detail }: { runId: string; detail: RunDetail & { cwd_exists?: boolean; editor_configured?: boolean } }) {
  // design rules: hidden for Plain runs without a folder; disabled+tooltip for cleaned
  // worktrees; unconfigured routes to Settings
  if (!detail.identity.cwd) return null;
  if (!detail.editor_configured)
    return <a href="/settings" title="No editor configured"><Button variant="outline" size="sm"><ExternalLink />Open in IDE…</Button></a>;
  if (!detail.cwd_exists)
    return <Button variant="outline" size="sm" disabled title="Folder is gone — worktree was cleaned"><ExternalLink />Open in IDE</Button>;
  return (
    <Button variant="outline" size="sm" onClick={() => fetch(`/api/runs/${runId}/open-ide`, { method: "POST" })}>
      <ExternalLink />Open in IDE
    </Button>
  );
}

function AskCard({ runId, ask, onResolved }: { runId: string; ask: NonNullable<RunDetail["ask"]>; onResolved: () => void }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "delivered" | "failed">("idle");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (location.hash === "#needs-input") ref.current?.focus(); }, []);

  const send = useCallback(async () => {
    setState("sending");
    try {
      const r = await fetch(`/api/runs/${runId}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) throw new Error(await r.text());
      setState("delivered");
      setTimeout(onResolved, 420); // the collapse plays, then the thread takes over — the motion moment
    } catch {
      setState("failed");
    }
  }, [runId, text, onResolved]);

  return (
    <div className={`ask-card ${state === "delivered" ? "collapsing" : ""}`} id="needs-input">
      <h3>Needs you — {ask.node}@{ask.visit}</h3>
      <div>{ask.reason}</div>
      <Textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} placeholder="Your reply…" disabled={state === "sending" || state === "delivered"} />
      <div className="actions">
        <Button onClick={send} disabled={state === "sending" || state === "delivered"}>
          <Send />{state === "sending" ? "Sending…" : state === "delivered" ? "Delivered" : "Reply"}
        </Button>
        {state === "failed" && <span className="send-state">failed — <a onClick={send} style={{ cursor: "pointer", textDecoration: "underline" }}>retry</a></span>}
      </div>
    </div>
  );
}

/** ms → the shortest honest reading: 0.9s / 3m 10s / 1h 04m */
function fmtDur(ms: number | null): string {
  if (ms === null) return "…";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Status is a SHAPE first (DESIGN.md): the glyph alone must carry the state. */
function StepGlyph({ status }: { status: "running" | "succeeded" | "failed" | "needs-input" }) {
  const stroke = { strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };
  if (status === "needs-input")
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" className="step-glyph needs-input" aria-label="needs you">
        <path d="M8 2.2 L14.2 13.4 L1.8 13.4 Z" {...stroke} strokeWidth={1.6} />
        <path d="M8 6.4 L8 9.4" {...stroke} strokeWidth={1.6} />
        <circle cx="8" cy="11.4" r="0.9" fill="currentColor" />
      </svg>
    );
  if (status === "failed")
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" className="step-glyph failed" aria-label="failed">
        <path d="M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5" {...stroke} />
      </svg>
    );
  if (status === "running")
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" className="step-glyph running" aria-label="running">
        <circle cx="8" cy="8" r="5.4" {...stroke} strokeWidth={1.6} />
        <path d="M8 2.6 A5.4 5.4 0 0 1 8 13.4 Z" fill="currentColor" />
      </svg>
    );
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" className="step-glyph succeeded" aria-label="succeeded">
      <path d="M3.5 8.5 L6.5 11.5 L12.5 4.5" {...stroke} />
    </svg>
  );
}

/**
 * Steps (T24): one row per node visit on a shared time axis — Inngest's layout. Bars are
 * time-proportional so the shape of the run is legible; a sub-second step still gets 3px,
 * because an invisible mark is a lie about what happened.
 */
function RunSteps({ timeline, ask, selected, onSelect }: {
  timeline: RunDetail["timeline"];
  ask: RunDetail["ask"];
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  if (timeline.length === 0) return <div className="empty">no steps yet</div>;
  return (
    <div className="steps">
      {timeline.map((t, i) => {
        const span = t.run_span_ms || 1;
        const waiting = ask !== null && ask.node === t.node && ask.visit === t.visit;
        const status = waiting ? "needs-input" : t.status;
        const total = t.duration_ms ?? span - t.offset_ms;
        // the split that makes R3.3 visible: agent time, then the part that was me not looking
        const work = Math.max(0, total - t.waiting_ms);
        const pct = (ms: number) => (ms / span) * 100;
        const key = `${t.node}@${t.visit}`;
        return (
          <div
            key={`${key}#${i}`}
            className={`step-row ${status} ${selected === key ? "selected" : ""}`}
            onClick={() => onSelect(key)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(key); } }}
          >
            <span className="step-icon"><StepGlyph status={status} /></span>
            <span className="step-node">
              {t.node}
              {t.visit > 1 && <span className="step-visit">@{t.visit}</span>}
            </span>
            <span className="step-track">
              <span className="step-bar" style={{ left: `${pct(t.offset_ms)}%`, width: `${pct(work)}%` }} />
              {t.waiting_ms > 0 && (
                <span
                  className="step-bar waiting"
                  title={`waiting on you ${fmtDur(t.waiting_ms)}`}
                  style={{ left: `${pct(t.offset_ms + work)}%`, width: `${pct(t.waiting_ms)}%` }}
                />
              )}
            </span>
            <span className="step-dur">
              {fmtDur(t.duration_ms ?? total)}
              {t.waiting_ms > 0 && <span className="step-wait">{fmtDur(t.waiting_ms)}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Step detail (T24, story 5) — Inngest's right-hand panel. The ask lives HERE rather than
 * floating in the thread, and the Run toggle keeps the run-level facts one click away.
 */
function StepDetail({ runId, row, detail, ask, onResolved }: {
  runId: string;
  row: RunDetail["timeline"][number] | null;
  detail: RunDetail;
  ask: RunDetail["ask"];
  onResolved: () => void;
}) {
  const [scope, setScope] = useState<"step" | "run">("step");
  const [pane, setPane] = useState<"ask" | "prompt" | "output">("ask");
  if (!row) return <div className="step-detail"><div className="empty">pick a step</div></div>;

  const key = `${row.node}@${row.visit}`;
  const isAsking = ask !== null && ask.node === row.node && ask.visit === row.visit;
  const render = detail.renders.find((r) => r.node === row.node && r.visit === row.visit);
  const total = row.duration_ms ?? row.run_span_ms - row.offset_ms;
  const work = Math.max(0, total - row.waiting_ms);
  const bar = (label: string, ms: number, of: number, cls: string) => (
    <div className="sd-seg">
      <div className="sd-seg-head"><span>{label}</span><span className="m">{fmtDur(ms)}</span></div>
      <div className="sd-seg-track"><span className={`sd-seg-fill ${cls}`} style={{ width: `${of > 0 ? (ms / of) * 100 : 0}%` }} /></div>
    </div>
  );

  return (
    <div className="step-detail">
      <div className="sd-scope">
        <span className={`chip ${scope === "step" ? "on" : ""}`} onClick={() => setScope("step")}>Step</span>
        <span className={`chip ${scope === "run" ? "on" : ""}`} onClick={() => setScope("run")}>Run</span>
      </div>

      {scope === "run" ? (
        <div className="sd-body">
          <h2 className="rh">Identity</h2>
          <div className="kv"><span className="k">run</span><span className="v">{runId}</span></div>
          <div className="kv"><span className="k">graph</span><span className="v">{detail.summary.graph}</span></div>
          {detail.git?.intended?.branch && <div className="kv"><span className="k">branch</span><span className="v">{detail.git.intended.branch}</span></div>}
          {detail.git && (
            <>
              <h2 className="rh">Git</h2>
              <div className="kv"><span className="k">uncommitted</span><span className="v">{detail.git.git.uncommitted}</span></div>
              <div className="kv"><span className="k">unpushed</span><span className="v">{detail.git.git.unpushed ?? "no upstream"}</span></div>
            </>
          )}
          <h2 className="rh">Usage</h2>
          <div className="kv"><span className="k">input</span><span className="v">{detail.usage.input_tokens.toLocaleString()}</span></div>
          <div className="kv"><span className="k">output</span><span className="v">{detail.usage.output_tokens.toLocaleString()}</span></div>
          <div className="kv"><span className="k">cost</span><span className="v">${detail.usage.cost_usd.toFixed(4)}</span></div>
          {detail.allowance.map((a) => (
            <div key={a.harness} className="kv">
              <span className="k">{a.harness}</span>
              <span className={`v ${a.state === "exhausted" ? "allowance-exhausted" : ""}`}>
                {a.state === "ok" && a.remaining !== undefined ? `${Math.round(a.remaining * 100)}% left` : a.state}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="sd-head">
            <StepGlyph status={isAsking ? "needs-input" : row.status} />
            <span className="m sd-node">{row.node}</span>
            <span className="m sd-visit">@{row.visit}</span>
            <span className="m sd-total">{fmtDur(total)}</span>
          </div>
          <div className="sd-timing">
            {bar("agent working", work, total, "work")}
            {row.waiting_ms > 0 && bar("waiting on you", row.waiting_ms, total, "waiting")}
          </div>
          <div className="sd-tabs">
            <span className={`tab ${pane === "ask" ? "on" : ""}`} onClick={() => setPane("ask")}>Ask</span>
            <span className={`tab ${pane === "prompt" ? "on" : ""}`} onClick={() => setPane("prompt")}>Prompt &amp; context</span>
            <span className={`tab ${pane === "output" ? "on" : ""}`} onClick={() => setPane("output")}>Output</span>
          </div>
          <div className="sd-body">
            {pane === "ask" && (isAsking
              ? <AskCard runId={runId} ask={ask!} onResolved={onResolved} />
              : <div className="pd-note">this step is not waiting on you</div>)}
            {pane === "prompt" && (render
              ? <PromptAndContext runId={runId} render={render} />
              : <div className="pd-note">this step rendered no prompt (it is not an agent step)</div>)}
            {pane === "output" && (() => {
              const finished = detail.outcomes.find((o) => o.node === row.node && o.visit === row.visit);
              return (
                <>
                  <div className="kv"><span className="k">status</span><span className="v">{row.status}</span></div>
                  {finished?.verdict_downstream && <div className="kv"><span className="k">routed</span><span className="v">{finished.verdict_downstream}</span></div>}
                  {!finished && <div className="pd-note">no outcome recorded for {key} yet</div>}
                </>
              );
            })()}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Logs (T24, stories 7 + 8) — Logfire's dense event list under Signal's filter bar.
 * Every row comes from deriveLogRows, whose switch is exhaustive over the event union, so
 * a new event type fails the build rather than rendering blank here.
 */
function RunLogs({ rows }: { rows: LogRow[] }) {
  const [kind, setKind] = useState<"all" | LogRow["kind"]>("all");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<number | null>(null);

  const shown = rows.filter((r) => {
    if (kind !== "all" && r.kind !== kind) return false;
    if (!q.trim()) return true;
    const hay = `${r.type} ${r.node ?? ""} ${r.summary}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });
  const selected = rows.find((r) => r.seq === picked) ?? shown.at(-1) ?? null;
  const KINDS: Array<"all" | LogRow["kind"]> = ["all", "agent", "tool", "engine", "operator", "attention"];

  return (
    <div className="logs-split">
      <div className="logs-col">
        <div className="logs-filters">
          <input className="logs-search" placeholder="Search events…" value={q} onChange={(e) => setQ(e.target.value)} />
          {KINDS.map((k) => (
            <span key={k} className={`chip ${kind === k ? "on" : ""} ${k === "attention" ? "attention" : ""}`} onClick={() => setKind(k)}>{k}</span>
          ))}
          <span className="m logs-count">{shown.length} of {rows.length}</span>
        </div>
        <div className="logs-rows">
          {shown.length === 0 && <div className="empty">nothing matches</div>}
          {shown.map((r) => (
            <div
              key={r.seq}
              className={`log-row ${r.kind} depth-${r.depth} ${selected?.seq === r.seq ? "selected" : ""}`}
              onClick={() => setPicked(r.seq)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPicked(r.seq); } }}
            >
              <span className="m log-ts">{r.ts.slice(11, 23)}</span>
              <span className="m log-node">{r.node ?? "—"}{r.visit !== null && <span className="log-visit">@{r.visit}</span>}</span>
              <span className="pill log-type">{r.type}</span>
              <span className="log-summary">{r.summary}</span>
            </div>
          ))}
        </div>
      </div>
      <EventDetail row={selected} />
    </div>
  );
}

/** Story 8: the selected event with its ids and its exact stored form. */
function EventDetail({ row }: { row: LogRow | null }) {
  const [pane, setPane] = useState<"details" | "raw">("details");
  if (!row) return <div className="step-detail"><div className="empty">pick an event</div></div>;
  return (
    <div className="step-detail">
      <div className="sd-head">
        <span className="m sd-node">{row.type}</span>
        <span className="m sd-total">{row.kind}</span>
      </div>
      <div className="sd-pills">
        <span className="pill">seq {row.seq}</span>
        <span className="pill">{row.ts.slice(11, 23)}</span>
        {row.node && <span className="pill id">{row.node}{row.visit !== null ? `@${row.visit}` : ""}</span>}
      </div>
      <div className="sd-tabs">
        <span className={`tab ${pane === "details" ? "on" : ""}`} onClick={() => setPane("details")}>Details</span>
        <span className={`tab ${pane === "raw" ? "on" : ""}`} onClick={() => setPane("raw")}>Raw event</span>
      </div>
      <div className="sd-body">
        {pane === "details" ? (
          <>
            <div className="kv"><span className="k">summary</span><span className="v">{row.summary}</span></div>
            <div className="kv"><span className="k">kind</span><span className="v">{row.kind}</span></div>
            <div className="kv"><span className="k">seq</span><span className="v">{row.seq}</span></div>
            <div className="kv"><span className="k">at</span><span className="v">{row.ts}</span></div>
          </>
        ) : (
          <pre className="sd-raw">{JSON.stringify(row.raw, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}

const SCOPE_MEANS: Record<string, string> = {
  sticky: "the last good value stays visible when a writer re-enters, until a newer one lands",
  cleared: "hidden while its writer re-runs; if that attempt fails, the old answer is restored",
  "per-visit": "invalidated the moment its writer re-enters — freshness is part of its meaning",
};

function fmtValue(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v) ?? String(v);
}

/**
 * Context (T24, stories 9 + 10) — the run's whole context in one table.
 *
 * Nothing in the research showed this: trace tools show a span's input and output, and
 * Orbital's tab was per-step and usually empty (CUR5). Keys no step has reached yet stay
 * listed, because their absence is exactly what made the old tab useless.
 */
function RunContext({ entries }: { entries: RunDetail["context"] }) {
  const [picked, setPicked] = useState<string | null>(null);
  if (entries.length === 0) return <div className="empty">this graph declares no context keys</div>;
  const selected = entries.find((e) => e.key === picked) ?? entries.find((e) => e.written) ?? entries[0]!;
  return (
    <div className="ctx-split">
      <div className="ctx-col">
        <div className="ctx-row ctx-header">
          <span className="ctx-key rh">key</span>
          <span className="ctx-value rh">value</span>
          <span className="ctx-scope rh">scope</span>
          <span className="ctx-writer rh">written by</span>
          <span className="ctx-at rh">at</span>
        </div>
        <div className="ctx-rows">
          {entries.map((e) => {
            const last = e.writes.at(-1);
            return (
              <div
                key={e.key}
                className={`ctx-row ${e.written ? "" : "unwritten"} ${selected.key === e.key ? "selected" : ""}`}
                onClick={() => setPicked(e.key)}
                role="button"
                tabIndex={0}
                onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setPicked(e.key); } }}
              >
                <span className="m ctx-key">{e.key}</span>
                <span className="ctx-value">
                  {e.veiled ? "veiled — its writer is mid-attempt" : e.written ? fmtValue(e.value) : "— not written yet"}
                </span>
                <span className="ctx-scope">{e.scope && <span className={`pill scope-${e.scope}`}>{e.scope}</span>}</span>
                <span className="m ctx-writer">{last ? `${last.node}@${last.visit}` : e.declared_writers.join(", ") || "—"}</span>
                <span className="m ctx-at">{last ? last.at.slice(11, 16) : "—"}</span>
              </div>
            );
          })}
        </div>
      </div>
      <ContextDetail entry={selected} />
    </div>
  );
}

/** Story 10: one key — its value, who wrote it in what order, and which prompts read it. */
function ContextDetail({ entry }: { entry: RunDetail["context"][number] }) {
  return (
    <div className="step-detail">
      <div className="sd-head"><span className="m sd-node">{entry.key}</span></div>
      <div className="sd-pills">
        {entry.scope && <span className="pill">{entry.scope}</span>}
        <span className="pill">{entry.written ? `${entry.writes.length} write${entry.writes.length === 1 ? "" : "s"}` : "not written"}</span>
        {entry.declared_writers.length > 1 && <span className="pill">{entry.declared_writers.length} writers</span>}
      </div>
      {entry.scope && <div className="pd-note sd-scope-note">{SCOPE_MEANS[entry.scope]}</div>}
      <div className="sd-body">
        <h2 className="rh">Current value</h2>
        {entry.veiled ? (
          <div className="pd-note">veiled: its writer is mid-attempt, so the old value must not be read as current</div>
        ) : entry.written ? (
          <pre className="sd-raw">{fmtValue(entry.value)}</pre>
        ) : (
          <div className="pd-note">nothing has written this yet — {entry.declared_writers.join(", ") || "no declared writer"} would</div>
        )}

        <h2 className="rh">Write history</h2>
        {entry.writes.length === 0
          ? <div className="pd-note">no writes yet</div>
          : entry.writes.map((w, i) => (
              <div key={i} className="ctx-write">
                <span className="m ctx-write-at">{w.at.slice(11, 19)}</span>
                <span className="m ctx-write-node">{w.node}@{w.visit}</span>
                <span className="ctx-write-note">{w.replaced ? "replaced" : "first write"}</span>
              </div>
            ))}

        <h2 className="rh">Read by</h2>
        {entry.read_by.length === 0
          ? <div className="pd-note">no prompt has read this yet</div>
          : <div className="ctx-readers">{entry.read_by.map((r) => <span key={r} className="pill id">{r}</span>)}</div>}
      </div>
    </div>
  );
}

/**
 * Chat (T24, stories 11-13) — LangSmith's Polly pattern: ask about THIS run instead of
 * scrolling it. READ-ONLY by decision: it cannot reply to the agent or move the run.
 *
 * Model output is untrusted input, so citations are matched against a whitelist of this
 * run's own node@visit keys and rendered as TEXT — never as markup.
 */
function suggestionsFor(detail: RunDetail, ask: RunDetail["ask"]): string[] {
  const out: string[] = [];
  if (ask) out.push("What is it waiting for?");
  const failed = detail.timeline.find((t) => t.status === "failed");
  if (failed) out.push(`Why did ${failed.node}@${failed.visit} fail?`);
  const rewritten = detail.context.find((c) => c.writes.length > 1);
  if (rewritten) out.push(`What changed in ${rewritten.key}?`);
  return out.slice(0, 3);
}

function RunChat({ runId, detail, ask, onPickStep }: {
  runId: string;
  detail: RunDetail;
  ask: RunDetail["ask"];
  onPickStep: (key: string) => void;
}) {
  const [turns, setTurns] = useState<Array<{ q: string; a: string | null; error?: string; cost?: number }>>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const known = new Set(detail.timeline.map((t) => `${t.node}@${t.visit}`));

  const send = async (question: string) => {
    if (!question.trim() || busy) return;
    setBusy(true);
    setQ("");
    setTurns((t) => [...t, { q: question, a: null }]);
    const res = await fetch(`/api/runs/${runId}/ask`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as any;
    setTurns((t) => t.map((turn, i) => (i === t.length - 1
      ? { ...turn, a: res?.ok ? String(body?.answer ?? "") : null, error: res?.ok ? undefined : (body?.error ?? "could not ask"), cost: body?.cost_usd }
      : turn)));
    setBusy(false);
  };

  return (
    <div className="chat-panel">
      <div className="chat-head">
        <span className="chat-title">Ask about this run</span>
        <span className="pill">read-only</span>
      </div>
      {turns.length === 0 && (
        <div className="chat-suggestions">
          {suggestionsFor(detail, ask).map((sug) => (
            <span key={sug} className="chip" onClick={() => send(sug)}>{sug}</span>
          ))}
        </div>
      )}
      <div className="chat-log">
        {turns.map((t, i) => (
          <div key={i}>
            <div className="chat-q">{t.q}</div>
            {t.a === null && !t.error && <div className="chat-a pd-note">thinking…</div>}
            {t.error && <div className="chat-a chat-error">{t.error}</div>}
            {t.a !== null && (
              <div className="chat-a">
                {citeParts(t.a, known).map((part, j) =>
                  part.cite
                    ? <span key={j} className="pill id chat-cite" onClick={() => onPickStep(part.text)}>{part.text}</span>
                    : <span key={j}>{part.text}</span>)}
                {t.cost !== undefined && <span className="m chat-cost">${t.cost.toFixed(4)}</span>}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="chat-input">
        <input
          placeholder="Ask about this run…"
          value={q}
          disabled={busy}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(q); }}
        />
        <div className="chat-note">Reads this run's steps, prompts and context. It cannot reply to the agent or move the run.</div>
      </div>
    </div>
  );
}

function RunView({ id }: { id: string }) {
  const [detail, setDetail] = useState<(RunDetail & { cwd_exists?: boolean; editor_configured?: boolean }) | null>(null);
  const [tab, setTab] = useState<"steps" | "thread" | "context" | "logs" | "chat" | "graph">("steps");
  const [picked, setPicked] = useState<string | null>(null);
  const now = useNow();
  const reload = useCallback(() => fetch(`/api/runs/${id}`).then((r) => r.json()).then(setDetail).catch(() => {}), [id]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (!detail) return;
    const es = new EventSource(`/api/runs/${id}/events?since=${detail.events_seq}`);
    es.onmessage = () => reload();
    return () => es.close();
    // subscribe once per run; reload() refetches the derived view on any new event
  }, [id, detail === null]); // eslint-disable-line react-hooks/exhaustive-deps
  useAttentionSurfaces(detail?.summary.status === "needs-input");

  const renderByTurnKey = useMemo(() => {
    const m = new Map<string, RunDetail["renders"][number]>();
    for (const r of detail?.renders ?? []) m.set(`${r.node}@${r.visit}`, r);
    return m;
  }, [detail]);

  if (!detail) return <div className="empty">loading…</div>;
  const { summary, ask } = detail;
  const maxDur = Math.max(1, ...detail.timeline.map((t) => t.duration_ms ?? 0));
  // the step that needs a human wins the selection; otherwise the newest one
  const waitingRow = ask ? detail.timeline.find((t) => t.node === ask.node && t.visit === ask.visit) : undefined;
  const defaultRow = waitingRow ?? detail.timeline.at(-1);
  const selectedKey = picked ?? (defaultRow ? `${defaultRow.node}@${defaultRow.visit}` : null);
  const selectedRow = detail.timeline.find((t) => `${t.node}@${t.visit}` === selectedKey) ?? null;
  const resolvedTurns = detail.turns;

  return (
    <div className="runview">
      <div className="thread-col">
        <div className="topbar">
          <a href="/" style={{ textDecoration: "none", color: "var(--fg-muted)" }}>←</a>
          <h1>{summary.goal || id}</h1>
          <StatusBadge status={summary.status} />
          <span className="meta">{summary.graph}</span>
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as "steps" | "thread" | "context" | "logs" | "chat" | "graph")}
            items={[
              { value: "steps", label: "Steps", icon: <Rows3 /> },
              { value: "thread", label: "Thread", icon: <MessagesSquare /> },
              { value: "context", label: "Context", icon: <Fingerprint /> },
              { value: "logs", label: "Logs", icon: <ScrollText /> },
              { value: "chat", label: "Chat", icon: <MessagesSquare /> },
              { value: "graph", label: "Graph", icon: <Workflow /> },
            ]}
          />
          <RunControls runId={id} summary={summary} onAction={reload} />
          <OpenIdeButton runId={id} detail={detail} />
        </div>
        {summary.status === "needs-input" && summary.waiting_since && (
          <div className="banner">
            Waiting on you — {summary.needs_input_reason}
            <span className="timer">{fmtWait(summary.waiting_since, now)}</span>
          </div>
        )}
        {summary.paused && (
          <div className="banner paused">
            Paused by you — the run holds at the node boundary.
            <Button size="sm" className="ml-auto bg-[var(--status-waiting)]" onClick={() => fetch(`/api/runs/${id}/resume`, { method: "POST" }).then(reload)}><Play />Resume</Button>
          </div>
        )}
        {summary.outcome === "aborted" && <div className="banner failed">Aborted by you.</div>}
        {summary.outcome !== "aborted" && (summary.status === "failed-recoverable" || summary.status === "failed-terminal") && (
          <div className="banner failed">
            {summary.failure
              ? <>Failed at {summary.failure.node}@{summary.failure.visit}{summary.failure.reason ? <> — {summary.failure.reason.replace(/^executor threw: /, "")}</> : null}</>
              : <>Run failed — see the last thread entry</>}
            {summary.status === "failed-recoverable" && (
              <Button variant="destructive" size="sm" className="ml-auto" onClick={() => fetch(`/api/runs/${id}/resume`, { method: "POST" }).then(reload)}><RotateCcw />Retry</Button>
            )}
          </div>
        )}
        {tab === "steps" ? (
          <div className="steps-split">
            <RunSteps timeline={detail.timeline} ask={ask} selected={selectedKey} onSelect={setPicked} />
            <StepDetail runId={id} row={selectedRow} detail={detail} ask={ask} onResolved={reload} />
          </div>
        ) : tab === "context" ? (
          <RunContext entries={detail.context} />
        ) : tab === "chat" ? (
          <RunChat runId={id} detail={detail} ask={ask} onPickStep={(k) => { setPicked(k); setTab("steps"); }} />
        ) : tab === "logs" ? (
          <RunLogs rows={detail.log_rows} />
        ) : tab === "graph" ? (
          <RunGraph runId={id} graph={summary.graph} timeline={detail.timeline} status={summary.status} onJumped={reload} />
        ) : (
          <>
            {resolvedTurns.map((t) => (
              <Turn key={`${t.node}@${t.visit}#${t.turn}`} turn={t} render={renderByTurnKey.get(`${t.node}@${t.visit}`)} runId={id} />
            ))}
            {ask && <AskCard runId={id} ask={ask} onResolved={reload} />}
            {!ask && summary.status === "done" && <div className="operator-row">run complete</div>}
          </>
        )}
      </div>

      <div className="rail">
        <section>
          <h2><Fingerprint size={12} /> Identity</h2>
          <div className="kv"><span className="k">run</span><span>{id}</span></div>
          <div className="kv"><span className="k">graph</span><span>{summary.graph}</span></div>
          {detail.identity.cwd && <div className="kv"><span className="k">{detail.identity.folder_kind === "repo" ? "repo" : "folder"}</span><span className="path" title={detail.identity.cwd}>{detail.identity.cwd.split("/").slice(-2).join("/")}</span></div>}
          {detail.git?.intended?.branch && <div className="kv"><span className="k">branch</span><span>{detail.git.intended.branch}</span></div>}
        </section>
        {detail.identity.folder_kind === "repo" && (
          <section>
            <h2><GitBranch size={12} /> Git</h2>
            {detail.git ? (
              <>
                <div className="kv"><span className="k">observed branch</span><span>{detail.git.git.branch ?? "—"}</span></div>
                <div className="kv"><span className="k">uncommitted</span><span>{detail.git.git.uncommitted}</span></div>
                <div className="kv"><span className="k">unpushed</span><span>{detail.git.git.unpushed ?? "no upstream"}</span></div>
                <div className="kv"><span className="k">probed</span><span>{fmtWait(detail.git.ts, now)} ago</span></div>
                {detail.git.disagreements.map((d, i) => <div key={i} className="disagreement">⚠ {d}</div>)}
                {detail.git.forge?.kind === "unreachable" && <div className="kv"><span className="k">forge</span><span className="allowance-unreachable">unreachable — not "no PR"</span></div>}
              </>
            ) : (
              <div className="kv"><span className="k">git</span><span>not probed yet</span></div>
            )}
          </section>
        )}
        {detail.pull_requests.length > 0 && (
          <section>
            <h2><GitPullRequest size={12} /> Pull requests</h2>
            {detail.pull_requests.map((pr) => (
              <div key={pr.url} className="kv">
                <a href={pr.url} target="_blank" rel="noreferrer" className="pr-link">{pr.url.replace(/^https:\/\/github\.com\//, "")}</a>
                <Badge variant={pr.state === "MERGED" ? "success" : pr.state === "OPEN" ? "outline" : "destructive"}>{pr.state}</Badge>
              </div>
            ))}
          </section>
        )}
        <section>
          <h2><Clock size={12} /> Timeline</h2>
          {detail.timeline.map((t, i) => (
            <div key={i} className="tl-row" style={{ ["--status-color" as any]: `var(--status-${t.status === "succeeded" ? "done" : t.status === "failed" ? "failed-recoverable" : "running"})` }}>
              <span className="tl-node">{t.node}@{t.visit}</span>
              <span className="tl-bar-track"><span className="tl-bar" style={{ width: `${Math.max(4, ((t.duration_ms ?? maxDur) / maxDur) * 100)}%` }} /></span>
              <span className="tl-dur">{t.duration_ms === null ? "…" : t.duration_ms < 1000 ? `${t.duration_ms}ms` : `${Math.round(t.duration_ms / 1000)}s`}</span>
            </div>
          ))}
        </section>
        <section>
          <h2><Coins size={12} /> Usage</h2>
          <div className="kv"><span className="k">input tokens</span><span>{detail.usage.input_tokens.toLocaleString()}</span></div>
          <div className="kv"><span className="k">output tokens</span><span>{detail.usage.output_tokens.toLocaleString()}</span></div>
          <div className="kv"><span className="k">cost</span><span>${detail.usage.cost_usd.toFixed(4)}</span></div>
          {detail.allowance.map((a) => (
            <div key={a.harness} className="kv">
              <span className="k">{a.harness} allowance</span>
              <span className={a.state === "exhausted" ? "allowance-exhausted" : a.state !== "ok" ? "allowance-unreachable" : ""}>
                {a.state === "ok" && a.remaining !== undefined ? `${Math.round(a.remaining * 100)}% left` : a.state}
                {a.resets_at ? ` · resets ${new Date(a.resets_at).toLocaleTimeString()}` : ""}
              </span>
            </div>
          ))}
          {detail.allowance.length === 0 && <div className="kv"><span className="k">allowance</span><span>—</span></div>}
        </section>
        <section>
          <h2><Pin size={12} /> Pinned prompts</h2>
          {Object.entries(detail.pinned_prompts).map(([p, v]) => (
            <div key={p} className="kv"><span className="k">{p}</span><span>v{v}</span></div>
          ))}
        </section>
      </div>
    </div>
  );
}


// ---- workspace registration ------------------------------------------------------

interface GhRepoDto { nameWithOwner: string; name: string; defaultBranch: string; isPrivate: boolean; updatedAt: string; localPath: string | null; registeredAs: string | null }

function GithubRepoPicker({ onAdded }: { onAdded: () => void }) {
  const [repos, setRepos] = useState<GhRepoDto[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // nameWithOwner being registered
  const [error, setError] = useState<string | null>(null);

  const load = (q?: string) =>
    fetch(`/api/github/repos${q ? `?q=${encodeURIComponent(q)}` : ""}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error((body as any).error);
        setRepos(body as GhRepoDto[]);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    // owner/name queries hit gh directly (any accessible repo); plain text filters locally
    if (query.includes("/")) {
      const t = setTimeout(() => load(query), 400);
      return () => clearTimeout(t);
    }
  }, [query]);

  const add = async (nameWithOwner: string) => {
    setBusy(nameWithOwner);
    setError(null);
    try {
      const r = await fetch("/api/workspaces/github", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nameWithOwner }),
      });
      const body = (await r.json()) as any;
      if (!r.ok) throw new Error(body.error);
      onAdded();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const shown = (repos ?? []).filter((r) => !query || query.includes("/") || r.nameWithOwner.toLowerCase().includes(query.toLowerCase())).slice(0, 8);
  return (
    <div className="gh-picker">
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your GitHub repos, or type owner/name for any repo…" />
      {error && <div className="field-error">{error}</div>}
      {repos === null && !error && <div className="field-hint">loading your repos from GitHub…</div>}
      {shown.map((r) => (
        <div key={r.nameWithOwner} className="gh-repo-row">
          <span className="run-goal">{r.nameWithOwner}</span>
          <span className="gh-meta">
            {r.isPrivate ? "private" : "public"}
            {r.registeredAs ? ` · registered as ${r.registeredAs}` : r.localPath ? " · clone found" : " · will clone"}
          </span>
          {r.registeredAs
            ? <span className="gh-added">✓</span>
            : <Button size="sm" disabled={busy !== null} onClick={() => add(r.nameWithOwner)}>
                <Plus />{busy === r.nameWithOwner ? (r.localPath ? "Adding…" : "Cloning…") : "Add"}
              </Button>}
        </div>
      ))}
      {repos !== null && shown.length === 0 && <div className="field-hint">no matches — try owner/name</div>}
    </div>
  );
}

function AddWorkspace({ onAdded, hint }: { onAdded: () => void; hint?: string }) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, path }),
      });
      const body = (await r.json()) as any;
      if (!r.ok) throw new Error(body.error ?? "failed");
      setName("");
      setPath("");
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const [manual, setManual] = useState(false);
  return (
    <div className="add-workspace">
      {hint && <div className="field-hint">{hint}</div>}
      <GithubRepoPicker onAdded={onAdded} />
      {!manual ? (
        <div className="field-hint">
          Plain folder (notes, docs — no git)? <a className="linkish" onClick={() => setManual(true)}>register a local path</a>
        </div>
      ) : (
        <>
          <div className="add-workspace-row">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="name (e.g. notes)" className="flex-1" />
            <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/notes or /Users/areeb/…" className="flex-[2]" />
            <Button onClick={add} disabled={busy || !name.trim() || !path.trim()}><Plus />{busy ? "…" : "Add"}</Button>
          </div>
          {error && <div className="field-error">{error}</div>}
          <div className="field-hint">A git repo registers as a repo; any other folder registers as Plain.</div>
        </>
      )}
    </div>
  );
}

// ---- start-run form (screen 6) ---------------------------------------------------

interface GraphInfo { name: string; description: string; inputs: string[]; kind: "repo" | "plain" }
interface Workspaces { repos: Array<{ name: string; path: string }>; folders: Array<{ name: string; path: string }> }

function StartRun() {
  const [graphs, setGraphs] = useState<GraphInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspaces>({ repos: [], folders: [] });
  const [graph, setGraph] = useState<string>("");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [workspace, setWorkspace] = useState<string>("");
  const [overrides, setOverrides] = useState<AgentConfigDto>({});
  const [showOverrides, setShowOverrides] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadWorkspaces = () => fetch("/api/workspaces").then((r) => r.json()).then(setWorkspaces).catch(() => {});
  useEffect(() => {
    fetch("/api/graphs").then((r) => r.json()).then(setGraphs).catch(() => {});
    loadWorkspaces();
  }, []);
  const selected = graphs.find((g) => g.name === graph);
  const options = selected?.kind === "repo" ? workspaces.repos : [...workspaces.repos, ...workspaces.folders];

  const launch = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ graph, inputs, workspace: workspace || undefined, overrides }),
      });
      if (!r.ok) throw new Error((await r.json() as any).error ?? "launch failed");
      const { id } = (await r.json()) as { id: string };
      history.pushState(null, "", `/run/${id}`);
      dispatchEvent(new PopStateEvent("popstate"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="runs">
      <h1>Start a run</h1>
      <Card className="max-w-[640px]">
        <CardContent className="pt-5">
        <Label>
          Graph
          <Select value={graph} onChange={(e) => { setGraph(e.target.value); setInputs({}); }}>
            <option value="">choose…</option>
            {graphs.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}
          </Select>
        </Label>
        {selected && <div className="field-hint">{selected.description}</div>}
        {selected?.inputs.map((k) => (
          <Label key={k}>
            {k}
            <Input value={inputs[k] ?? ""} onChange={(e) => setInputs({ ...inputs, [k]: e.target.value })} placeholder={k} />
          </Label>
        ))}
        {selected && (
          <Label>
            Workspace {selected.kind === "repo" ? "(repo required)" : ""}
            <Select value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
              <option value="">{selected.kind === "repo" ? (options.length ? "choose a repo…" : "no repos registered") : "none (log-only)"}</option>
              {options.map((w) => <option key={w.name} value={w.name}>{w.name} — {w.path}</option>)}
            </Select>
          </Label>
        )}
        {selected?.kind === "repo" && options.length === 0 && (
          <AddWorkspace hint="This graph creates worktrees and PRs, so it needs a registered git repo:" onAdded={loadWorkspaces} />
        )}
        {selected && (
          <div className="field-hint">
            <a className="linkish" onClick={() => setShowOverrides(!showOverrides)}>
              Run overrides {showOverrides ? "▾" : "▸"}
            </a>{" "}
            — beat every node and graph setting for this run only
          </div>
        )}
        {selected && showOverrides && (
          <ConfigFields value={overrides} onChange={setOverrides} />
        )}
        {error && <div className="field-error">{error}</div>}
        <Button
          disabled={busy || !selected || selected.inputs.some((k) => !(inputs[k] ?? "").trim()) || (selected.kind === "repo" && !workspace)}
          onClick={launch}
        >
          <Play />{busy ? "Launching…" : "Launch run"}
        </Button>
        </CardContent>
      </Card>
    </div>
  );
}




// ---- graph tuning editor (UI-editable per-node config) ----------------------------

const EFFORTS = ["", "low", "medium", "high", "xhigh"];
const PERMISSION_MODES = ["", "auto"];
const MODEL_SUGGESTIONS = ["claude-opus-5", "claude-sonnet-5", "haiku", "gpt-5.6-terra"];

function ConfigFields({ value, baseline, onChange }: { value: AgentConfigDto; baseline?: AgentConfigDto; onChange: (v: AgentConfigDto) => void }) {
  const ph = (k: keyof AgentConfigDto, fallback: string) => {
    const b = baseline?.[k];
    return b !== undefined && b !== null && String(b) !== "" ? `inherits: ${Array.isArray(b) ? b.join(", ") : b}` : fallback;
  };
  return (
    <>
      <Label>
        Harness
        <Select value={value.harness ?? ""} onChange={(e) => onChange({ ...value, harness: (e.target.value || undefined) as any })}>
          <option value="">{ph("harness", "inherit (claude)")}</option>
          <option value="claude">claude</option>
          <option value="codex">codex</option>
        </Select>
      </Label>
      <Label>
        Model
        <Input list="model-suggestions" value={value.model ?? ""} placeholder={ph("model", "harness default")} onChange={(e) => onChange({ ...value, model: e.target.value || undefined })} />
        <datalist id="model-suggestions">{MODEL_SUGGESTIONS.map((m) => <option key={m} value={m} />)}</datalist>
      </Label>
      <Label>
        Effort
        <Select value={value.effort ?? ""} onChange={(e) => onChange({ ...value, effort: (e.target.value || undefined) as any })}>
          {EFFORTS.map((x) => <option key={x} value={x}>{x || ph("effort", "inherit")}</option>)}
        </Select>
      </Label>
      <Label>
        Permission mode
        <Select value={value.permissionMode ?? ""} onChange={(e) => onChange({ ...value, permissionMode: (e.target.value || undefined) as any })}>
          {PERMISSION_MODES.map((x) => <option key={x} value={x}>{x || ph("permissionMode", "inherit")}</option>)}
        </Select>
      </Label>
      <Label>
        Max turns
        <Input type="number" min="1" value={value.maxTurns ?? ""} placeholder={ph("maxTurns", "unlimited")} onChange={(e) => onChange({ ...value, maxTurns: e.target.value ? Number(e.target.value) : undefined })} />
      </Label>
      <Label>
        Skills (comma-separated)
        <Input value={(value.skills ?? []).join(", ")} placeholder={ph("skills", "none")} onChange={(e) => onChange({ ...value, skills: e.target.value ? e.target.value.split(",").map((x) => x.trim()).filter(Boolean) : undefined })} />
      </Label>
    </>
  );
}

function GraphTuner({ shape, onSaved }: { shape: GraphShapeDto; onSaved: () => void }) {
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [tuning, setTuning] = useState<{ defaults?: AgentConfigDto; nodes?: Record<string, AgentConfigDto> }>(shape.tuning ?? {});
  const [dirty, setDirty] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  useEffect(() => { setTuning(shape.tuning ?? {}); setDirty(false); setSelectedNode(null); }, [shape.name]);

  const node = shape.nodes.find((n) => n.id === selectedNode);
  const setNodeCfg = (id: string, v: AgentConfigDto) => { setTuning({ ...tuning, nodes: { ...tuning.nodes, [id]: v } }); setDirty(true); };
  const save = async () => {
    setState("saving");
    try {
      const r = await fetch(`/api/graphs/${shape.name}/tuning`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(tuning) });
      if (!r.ok) throw new Error(((await r.json()) as any).error);
      setState("saved");
      setDirty(false);
      onSaved();
      setTimeout(() => setState("idle"), 1500);
    } catch { setState("failed"); }
  };

  return (
    <div className="tuner">
      <GraphDag key={`${shape.name}:${JSON.stringify(shape.tuning ?? {})}`} shape={shape} onSelect={setSelectedNode} selected={selectedNode ?? undefined} />
      <div className="tuner-panels">
        <Card>
          <CardHeader>
            <CardTitle>Graph defaults</CardTitle>
            <CardDescription>Applies to every agent node unless the node sets its own. Cleared fields fall back to the graph file.</CardDescription>
          </CardHeader>
          <CardContent>
            <ConfigFields value={tuning.defaults ?? {}} baseline={shape.defaults} onChange={(v) => { setTuning({ ...tuning, defaults: v }); setDirty(true); }} />
          </CardContent>
        </Card>
        <Card>
          {node?.kind === "agent" ? (
            <>
              <CardHeader>
                <CardTitle className="font-mono">{node.id}</CardTitle>
                <CardDescription>prompt: {node.prompt} · effective now: {node.effective?.harness}{node.effective?.model ? ` · ${node.effective.model}` : ""}{node.effective?.effort ? ` · ${node.effective.effort}` : ""}{node.effective?.permissionMode ? ` · ${node.effective.permissionMode}` : ""}</CardDescription>
              </CardHeader>
              <CardContent>
                <ConfigFields value={tuning.nodes?.[node.id] ?? {}} baseline={node.baseline} onChange={(v) => setNodeCfg(node.id, v)} />
              </CardContent>
            </>
          ) : (
            <CardContent className="pt-5"><div className="field-hint">Click an agent node (◆) in the graph to tune it.</div></CardContent>
          )}
        </Card>
      </div>
      <div className="tuner-save">
        <Button onClick={save} disabled={!dirty || state === "saving"}>
          {state === "saving" ? "Saving…" : state === "saved" ? "Saved — applies to new runs" : state === "failed" ? "Failed — retry" : "Save tuning"}
        </Button>
        {dirty && <span className="field-hint">unsaved changes</span>}
      </div>
    </div>
  );
}

// ---- graphs screen (T20) ---------------------------------------------------------

function GraphsList() {
  const [graphs, setGraphs] = useState<Array<{ name: string; description: string; kind: string }>>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => { fetch("/api/graphs").then((r) => r.json()).then(setGraphs).catch(() => {}); }, []);
  const shape = useGraphShape(selected ? `${selected}?v=${reloadKey}` as any : undefined);
  return (
    <div className="runs">
      <h1>Graphs</h1>
      <div className="graphs-layout">
        <div>
          {graphs.map((g) => (
            <div key={g.name} className={`run-row ${selected === g.name ? "selected" : ""}`} onClick={() => setSelected(g.name)}>
              <span className="run-goal">{g.name}</span>
              <Badge variant="outline" className="ml-auto">{g.kind === "repo" ? <GitBranch /> : <FolderGit2 />}{g.kind}</Badge>
            </div>
          ))}
          <div className="field-hint" style={{ marginTop: 12 }}>
            New graph: <code>howdah new-graph &lt;name&gt; --kind doc|custom</code> — scaffolds the TS file + prompts; tsc and validate() are the editor.
          </div>
        </div>
        <div>
          {shape ? <><div className="field-hint" style={{ marginBottom: 8 }}>{shape.description}</div><GraphTuner shape={shape} onSaved={() => setReloadKey((k) => k + 1)} /></> : <div className="empty">select a graph</div>}
        </div>
      </div>
    </div>
  );
}

// ---- settings (screen 5) ---------------------------------------------------------

function Settings() {
  const [s, setS] = useState<{ editorCommand?: string; slackWebhook?: string; chime?: boolean } | null>(null);
  const [saved, setSaved] = useState(false);
  const [ws, setWs] = useState<Workspaces>({ repos: [], folders: [] });
  const loadWs = () => fetch("/api/workspaces").then((r) => r.json()).then(setWs).catch(() => {});
  const removeWs = async (name: string) => {
    await fetch("/api/workspaces", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    loadWs();
  };
  useEffect(() => { fetch("/api/settings").then((r) => r.json()).then(setS).catch(() => {}); loadWs(); }, []);
  if (!s) return <div className="empty">loading…</div>;
  const save = async () => {
    await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(s) });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  return (
    <div className="runs">
      <h1>Settings</h1>
      <Card className="max-w-[640px]">
        <CardContent className="pt-5">
          <Label>
            Editor command (Open-in-IDE)
            <Input value={s.editorCommand ?? ""} onChange={(e) => setS({ ...s, editorCommand: e.target.value })} placeholder="idea — IntelliJ launcher on PATH (Tools → Create Command-line Launcher)" />
          </Label>
          <Label>
            Slack webhook (attention DMs)
            <Input value={s.slackWebhook ?? ""} onChange={(e) => setS({ ...s, slackWebhook: e.target.value })} placeholder="https://hooks.slack.com/…" />
          </Label>
          <Label className="flex-row items-center gap-2 normal-case tracking-normal text-[13px] text-foreground">
            <input type="checkbox" checked={s.chime !== false} onChange={(e) => setS({ ...s, chime: e.target.checked })} className="w-auto" />
            Attention chime
          </Label>
          <Button onClick={save} className="self-start">{saved ? "Saved" : "Save"}</Button>
        </CardContent>
      </Card>

      <h1 style={{ marginTop: 28 }}>Workspaces</h1>
      <Card className="max-w-[640px]">
        <CardContent className="pt-5">
          {[...ws.repos.map((w) => ({ ...w, kind: "repo" })), ...ws.folders.map((w) => ({ ...w, kind: "plain" }))].map((w) => (
            <div key={w.name} className="ws-row">
              <Badge variant="outline">{w.kind === "repo" ? <GitBranch /> : <FolderGit2 />}{w.kind}</Badge>
              <span className="run-goal">{w.name}</span>
              <span className="run-meta" title={w.path}>{w.path}</span>
              <Button variant="ghost" size="icon" className="ml-auto size-6 text-faint hover:text-destructive" onClick={() => removeWs(w.name)} title="Remove (files untouched)"><X /></Button>
            </div>
          ))}
          {ws.repos.length + ws.folders.length === 0 && <div className="field-hint">No workspaces yet.</div>}
          <AddWorkspace onAdded={loadWs} />
        </CardContent>
      </Card>
    </div>
  );
}

// ---- prompt library (screen 3) + proposal review (screen 4) — T21 ----------------

function fmtWhen(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/** accept/reject/redraft changed the queue — the sidebar's pending count must follow */
const PROPOSALS_CHANGED = "howdah:proposals-changed";

/** The prompt as an object with its own history (R1): versions, consumers, outcomes, feedback. */
function PromptsScreen({ selected }: { selected: string | null }) {
  const [list, setList] = useState<PromptSummary[] | null>(null);
  const [detail, setDetail] = useState<PromptDetail | null>(null);
  const load = useCallback(() => fetch("/api/prompts").then((r) => r.json()).then(setList).catch(() => setList([])), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!selected) return void setDetail(null);
    setDetail(null);
    fetch(`/api/prompts/${encodeURIComponent(selected)}`).then((r) => (r.ok ? r.json() : null)).then(setDetail).catch(() => setDetail(null));
  }, [selected]);

  if (!list) return <div className="empty">loading prompts…</div>;
  if (list.length === 0) return <div className="empty">no prompts in <code>prompts/</code> yet</div>;

  return (
    <div className="library-layout">
      <div className="runs">
        {list.map((p) => (
          <a key={p.id} className={`run-row ${p.id === selected ? "selected" : ""}`} href={`/prompts/${encodeURIComponent(p.id)}`}>
            <span className="run-goal">{p.id}</span>
            <span className="run-meta">
              v{p.version}
              {p.proposals.pending > 0 && <Badge variant="attention">{p.proposals.pending} pending</Badge>}
              {p.feedback.rejects > 0 && <Badge variant="destructive">{p.feedback.rejects} ✗</Badge>}
              {p.outcomes.renders > 0 && <Badge variant="outline">{p.outcomes.renders} runs</Badge>}
            </span>
          </a>
        ))}
      </div>
      {!selected ? (
        <div className="empty">pick a prompt to see its history, feedback and outcomes</div>
      ) : !detail ? (
        <div className="empty">loading {selected}…</div>
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
function Diff({ text }: { text: string }) {
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

/** Screen 4: nothing changes behaviour until you look at the diff and accept it (R2). */
function ProposalsScreen({ selected }: { selected: string | null }) {
  const [list, setList] = useState<ProposalView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const load = useCallback(() => fetch("/api/proposals").then((r) => r.json()).then(setList).catch(() => setList([])), []);
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
    if (!res || !res.ok) return setError(payload?.error ?? `${verb} failed`);
    if (verb === "accept") setNotice(`accepted — the prompt is now v${payload.version}. New runs pin it; runs in flight keep what they started with (OV-2).`);
    if (verb === "redraft") setNotice(`re-drafting ${payload.drafting} — the reviser is running${payload.stubbed ? " (stubbed)" : ""}. Reload in a minute.`);
    if (verb === "reject") { setRejecting(false); setReason(""); }
    load();
    window.dispatchEvent(new Event(PROPOSALS_CHANGED));
  };

  if (!list) return <div className="empty">loading proposals…</div>;
  if (list.length === 0)
    return <div className="empty">no proposals — add feedback to a prompt, then <code>bun reviser/revise.ts &lt;id&gt;</code></div>;

  const current = list.find((p) => p.file === selected) ?? list[0]!;
  return (
    <div className="library-layout">
      <div className="runs">
        {list.map((p) => (
          <a key={p.file} className={`run-row ${p.file === current.file ? "selected" : ""}`} href={`/proposals/${encodeURIComponent(p.file)}`}>
            <span className="run-goal">{p.id}</span>
            <span className="run-meta">
              v{p.base_version}→v{p.proposed_version}
              <Badge variant={p.status === "pending" ? "attention" : p.status === "accepted" ? "success" : "outline"}>{p.status}</Badge>
              {p.stale && <Badge variant="destructive">stale</Badge>}
            </span>
          </a>
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
            {rejecting ? (
              <>
                <Input autoFocus placeholder="Why? The reviser reads this." value={reason} onChange={(e) => setReason(e.target.value)} />
                <Button variant="destructive" size="sm" disabled={!reason.trim() || busy !== null} onClick={() => act(current.file, "reject", { reason })}>
                  Confirm reject
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setRejecting(false)}>Cancel</Button>
              </>
            ) : (
              <Button variant="destructive-outline" size="sm" onClick={() => setRejecting(true)}><X />Reject</Button>
            )}
          </div>
        )}
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

// ---- shell + routing ----------------------------------------------------------

function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a[href^='/']");
      if (a && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        history.pushState(null, "", (a as HTMLAnchorElement).href);
        setPath(location.pathname);
      }
    };
    const onPop = () => setPath(location.pathname);
    document.addEventListener("click", onClick);
    window.addEventListener("popstate", onPop);
    return () => { document.removeEventListener("click", onClick); window.removeEventListener("popstate", onPop); };
  }, []);

  const [splashDone, setSplashDone] = useState<boolean>(() => sessionStorage.getItem("howdah-splash") === "1");
  const [theme, setTheme] = useState<string>(() => localStorage.getItem("howdah-theme") ?? "system");
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    localStorage.setItem("howdah-theme", theme);
  }, [theme]);

  const runMatch = path.match(/^\/run\/([^/]+)/);
  const promptMatch = path.match(/^\/prompts(?:\/(.+))?$/);
  const proposalMatch = path.match(/^\/proposals(?:\/(.+))?$/);
  const isNew = path === "/new";
  const isSettings = path === "/settings";
  const isGraphs = path === "/graphs";
  const isRuns = !runMatch && !isNew && !isGraphs && !isSettings && !promptMatch && !proposalMatch;

  // how many drafts are waiting for you to look — R2's whole point is that you look, so a
  // count that goes stale after an accept is worse than no count: it is a live-looking lie
  const [pending, setPending] = useState(0);
  const countPending = useCallback(() => {
    fetch("/api/proposals")
      .then((r) => r.json())
      .then((ps: ProposalView[]) => setPending(ps.filter((p) => p.status === "pending").length))
      .catch(() => setPending(0));
  }, []);
  useEffect(() => {
    countPending();
    window.addEventListener(PROPOSALS_CHANGED, countPending);
    return () => window.removeEventListener(PROPOSALS_CHANGED, countPending);
  }, [countPending, path]);

  return (
    <div className="shell">
      {!splashDone && <Splash onDone={() => setSplashDone(true)} />}
      <nav className="sidebar">
        {/* the mark goes home like every other logo; it does NOT replay the splash —
            the boot jingle belongs to an actual load, not to navigating back to Runs */}
        <a className="mark-btn" href="/" title="Howdah — runs"><Mark className="mark" /><span className="wordmark">Howdah</span></a>
        <a className={`nav ${isRuns ? "active" : ""}`} href="/"><Rows3 size={15} /><span className="label">Runs</span></a>
        <a className={`nav ${isNew ? "active" : ""}`} href="/new"><Plus size={15} /><span className="label">New run</span></a>
        <a className={`nav ${isGraphs ? "active" : ""}`} href="/graphs"><Workflow size={15} /><span className="label">Graphs</span></a>
        <a className={`nav ${promptMatch ? "active" : ""}`} href="/prompts"><Library size={15} /><span className="label">Prompts</span></a>
        <a className={`nav ${proposalMatch ? "active" : ""}`} href="/proposals">
          <FileDiff size={15} /><span className="label">Proposals</span>
          {pending > 0 && <span className="nav-badge">{pending}</span>}
        </a>
        <a className={`nav ${isSettings ? "active" : ""}`} href="/settings"><SettingsIcon size={15} /><span className="label">Settings</span></a>
        <div className="spacer" />
        <Button variant="outline" size="sm" onClick={() => setTheme(theme === "dark" ? "light" : theme === "light" ? "system" : "dark")}>
          theme: {theme}
        </Button>
      </nav>
      <main>
        {runMatch ? <RunView id={runMatch[1]!} />
          : isNew ? <StartRun />
          : isSettings ? <Settings />
          : isGraphs ? <GraphsList />
          : promptMatch ? <PromptsScreen selected={promptMatch[1] ? decodeURIComponent(promptMatch[1]) : null} />
          : proposalMatch ? <ProposalsScreen selected={proposalMatch[1] ? decodeURIComponent(proposalMatch[1]) : null} />
          : <div className="runs"><RunsList /></div>}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
