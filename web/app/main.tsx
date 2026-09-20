/**
 * Howdah web app v0 (T11). Path routing: `/` runs list, `/run/:id` run view
 * (deep-linkable, `#needs-input` focuses the reply). Live via SSE. Served pre-bundled
 * as /app.js (bun build web/app/main.tsx — see web/server.ts startup).
 */
import "./globals.css";
import { createRoot } from "react-dom/client";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, PanelTabs, Select, Tabs, Textarea, Badge } from "./ui";
import {
  Rows3, Plus, Workflow, Settings as SettingsIcon, Play, Pause, OctagonX, RotateCcw, Send,
  ExternalLink, GitBranch, GitPullRequest, Clock, Coins, Pin, Fingerprint, MessagesSquare,
  CornerDownRight, FolderGit2, X, Library, FileDiff, MessageSquarePlus, ThumbsUp, ScrollText,
  SlidersHorizontal, RotateCcw as ResetIcon, Loader2, ArrowUp, ArrowDown, FolderOpen, Copy,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunDetail, RunSummary, LogRow } from "../derive";
import { citeParts } from "../cite";
import type { CoalescedTurn } from "../../log/coalesce";
// type-only: erased at bundle time, so the server's node imports never reach the browser
import type { PromptDetail, PromptSummary, ReconstructedRender } from "../../prompts/library";
import type { ProposalView } from "../../prompts/proposals";
import { GraphDag, useGraphShape, type GraphShapeDto, type AgentConfigDto } from "./graph-dag";
import { StatusBadge, askRowKey } from "./status";
import { slicePanes, SlicePane, MapProgressLine, type SlicePaneId } from "./slice";

interface AppInfo {
  home: string;
  runsDir: string;
  attentionDir: string;
  repoRoot: string;
  configPath: string;
  source: string;
  supervisorHeartbeat: string | null;
}

// ---- shared bits ---------------------------------------------------------------

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

/**
 * Every read model in this app arrives over fetch, and `fetch` only rejects on a transport
 * failure: a 404 resolves, and its error body parses as JSON just fine. `.then(r => r.json())
 * .then(setState)` therefore stores `{error: "unknown run"}` where a RunDetail belongs, which
 * is worse than no data — a truthy non-value walks straight past every `if (!x) return
 * <LoadingState/>` guard and the next property read throws mid-render. With no error boundary
 * in this app, that throw unmounts the tree and the operator gets a blank page.
 *
 * So: one door for every read, and a non-ok response leaves the page's state alone, which is
 * what makes the loading and empty states it already has do their job.
 */
class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`${status} from ${url}`);
  }
}

async function getJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new HttpError(r.status, url);
  return (await r.json()) as T;
}

function LoadingState({ title = "Loading", detail }: { title?: string; detail?: string }) {
  return (
    <Card className="max-w-[520px]">
      <CardContent className="flex-row items-center gap-3 pt-5">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <div>
          <div className="text-sm">{title}</div>
          {detail && <div className="text-xs text-muted-foreground">{detail}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

function useBottomPinnedScroll(followKey: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setAtTop(el.scrollTop <= 8);
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight <= 16);
  }, []);
  const scrollToTop = useCallback(() => {
    ref.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);
  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (atBottom) el.scrollTop = el.scrollHeight;
    measure();
  }, [followKey, atBottom, measure]);
  return { ref, atTop, atBottom, measure, scrollToTop, scrollToBottom };
}

function ScrollShell({ className = "", followKey, children }: {
  className?: string;
  followKey: unknown;
  children: React.ReactNode;
}) {
  const { ref, atTop, atBottom, measure, scrollToTop, scrollToBottom } = useBottomPinnedScroll(followKey);
  return (
    <div className={`scroll-shell ${className}`}>
      <div className="scroll-actions">
        <Button variant="outline" size="sm" disabled={atTop} onClick={scrollToTop}><ArrowUp />Top</Button>
        {!atBottom && <Button variant="outline" size="sm" onClick={scrollToBottom}><ArrowDown />Bottom</Button>}
      </div>
      <div className="scroll-viewport" ref={ref} onScroll={measure}>
        {children}
      </div>
    </div>
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
  const [app, setApp] = useState<AppInfo | null>(null);
  const now = useNow();
  useEffect(() => {
    const load = () => getJSON<RunSummary[]>("/api/runs").then(setRuns).catch(() => {});
    getJSON<AppInfo>("/api/app").then(setApp).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  useAttentionSurfaces(!!runs?.some((r) => r.status === "needs-input"));

  if (!runs) return <LoadingState title="Loading runs" detail="Reading the local run log index." />;
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
      {app && (
        <div className="home-strip">
          <span>Home</span><code title={app.home}>{app.home}</code>
          <span>Source</span><code title={app.repoRoot}>{app.source}</code>
          <span>Supervisor</span><Badge variant={app.supervisorHeartbeat ? "success" : "outline"}>{app.supervisorHeartbeat ? "heartbeat" : "not seen"}</Badge>
        </div>
      )}
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
    getJSON<ReconstructedRender>(`/api/runs/${runId}/render/${render.rendered_hash}`)
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

function RunThread({
  turns,
  renderByTurnKey,
  runId,
  ask,
  detail,
  onResolved,
  onReviewDesign,
}: {
  turns: CoalescedTurn[];
  renderByTurnKey: Map<string, RunDetail["renders"][number]>;
  runId: string;
  ask: RunDetail["ask"];
  detail: RunDetail;
  onResolved: () => void;
  /** system-map 1d: open the approval card in the Steps panel */
  onReviewDesign: () => void;
}) {
  const followKey = `${turns.length}:${ask?.seq ?? "no-ask"}:${turns.at(-1)?.parts.length ?? 0}`;
  return (
    <ScrollShell className="thread-shell" followKey={followKey}>
      <div className="thread-transcript">
        {turns.map((t) => (
          <Turn key={`${t.node}@${t.visit}#${t.turn}`} turn={t} render={renderByTurnKey.get(`${t.node}@${t.visit}`)} runId={runId} />
        ))}
        {ask && (ask.code === "awaiting-approval" && detail.slice?.approval === ask.node && detail.slice.proposal ? (
          // system-map 1d: an approval is decided on the card in the Steps panel, not by a reply
          <div className="ask-card" id="needs-input">
            <h3>Needs you — {ask.node}@{ask.visit}</h3>
            <div>{ask.reason}</div>
            <div className="actions">
              <Button onClick={onReviewDesign}>Review the design</Button>
            </div>
          </div>
        ) : ask.code === "ambiguous-effect" ? (
          // HOW-3: an ambiguous effect is answered by attesting to it, not by a reply (which
          // resolveReply refuses) — so the card offers the verdicts instead of a textarea
          <EffectCard key={`${ask.node}@${ask.visit}#${ask.seq}`} runId={runId} ask={ask} effects={detail.ambiguous_effects} onResolved={onResolved} />
        ) : <AskCard key={`${ask.node}@${ask.visit}#${ask.seq}`} runId={runId} ask={ask} detail={detail} onResolved={onResolved} />)}
        {!ask && detail.summary.status === "done" && <div className="operator-row">run complete</div>}
      </div>
    </ScrollShell>
  );
}

function RunControls({ runId, summary, onAction }: { runId: string; summary: RunDetail["summary"]; onAction: () => void }) {
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (verb: string) => {
    setPending(verb);
    setError(null);
    try {
      const r = await fetch(`/api/runs/${runId}/${verb}`, { method: "POST" });
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as any)?.error ?? `${verb} failed`);
      setConfirmAbort(false);
      setTimeout(onAction, 300);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };
  const resumable = summary.paused || ["harness-dead", "waiting", "failed-recoverable", "queued"].includes(summary.status);
  const active = ["running", "needs-input", "waiting", "failed-recoverable", "queued", "harness-dead"].includes(summary.status);
  if (!active) return null;
  const busy = pending !== null;
  return (
    <span className="run-controls">
      {resumable
        ? <Button variant="outline" size="sm" disabled={busy} onClick={() => act("resume")}>{pending === "resume" ? <Loader2 className="animate-spin" /> : <Play />}{pending === "resume" ? "Resuming…" : "Resume"}</Button>
        : summary.status === "running" && <Button variant="outline" size="sm" disabled={busy} onClick={() => act("pause")}>{pending === "pause" ? <Loader2 className="animate-spin" /> : <Pause />}{pending === "pause" ? "Pausing…" : "Pause"}</Button>}
      {confirmAbort
        ? <Button variant="destructive" size="sm" disabled={busy} onClick={() => act("abort")}>{pending === "abort" ? <Loader2 className="animate-spin" /> : <OctagonX />}{pending === "abort" ? "Aborting…" : "Really abort?"}</Button>
        : <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirmAbort(true)}><OctagonX />Abort</Button>}
      {error && <span className="field-error">{error}</span>}
    </span>
  );
}

function RunGraph({ runId, graph, timeline, status, onJumped }: { runId: string; graph: string; timeline: RunDetail["timeline"]; status: string; onJumped: () => void }) {
  const shape = useGraphShape(graph);
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "jumping" | "sent" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  if (!shape) return <LoadingState title="Loading graph" detail="Fetching node and edge metadata." />;
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
      setState("sent");
      setTimeout(onJumped, 300);
      setTimeout(() => {
        setJumpTo(null);
        setMessage("");
        setState("idle");
      }, 1400);
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
          {state === "sent" && <div className="field-hint">Jump requested. The runner is moving; the graph will refresh on the next log event.</div>}
          <div className="actions">
            <Button onClick={jump} disabled={state === "jumping" || state === "sent"}>
              {state === "jumping" ? <Loader2 className="animate-spin" /> : <CornerDownRight />}
              {state === "jumping" ? "Sending jump…" : state === "sent" ? "Jump sent" : "Jump here"}
            </Button>
            <Button variant="outline" size="sm" disabled={state === "jumping" || state === "sent"} onClick={() => { setJumpTo(null); setError(null); }}><X />Cancel</Button>
          </div>
        </div>
      )}
      {jumpable && !jumpTo && <div className="field-hint" style={{ marginBottom: 8 }}>Click a non-terminal node to jump the run there with instructions.</div>}
      {!jumpable && status === "running" && <div className="field-hint" style={{ marginBottom: 8 }}>Pause the run to enable jumping.</div>}
      <GraphDag
        shape={shape}
        current={current}
        visits={visits}
        onSelect={jumpable ? setJumpTo : undefined}
        selected={jumpTo ?? undefined}
        canSelect={(node) => node.kind !== "terminal"}
      />
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

function RunFolderButton({ runId }: { runId: string }) {
  return (
    <Button variant="outline" size="sm" onClick={() => fetch(`/api/runs/${runId}/open-run-folder`, { method: "POST" })}>
      <FolderOpen />Open run folder
    </Button>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button variant="outline" size="sm" onClick={async () => {
      await navigator.clipboard?.writeText(text).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }}>
      <Copy />{copied ? "Copied" : label}
    </Button>
  );
}

function attentionContext(detail: RunDetail, ask: NonNullable<RunDetail["ask"]>): string | null {
  const turn = detail.turns.findLast((t) => t.node === ask.node && t.visit === ask.visit);
  if (!turn) return null;
  const text = turn.parts.filter((p) => p.kind === "text").map((p) => p.content).join("");
  const markers = [...text.matchAll(/\[(attempt failed|output contract violation): ([^\]]+)\]/g)];
  const marker = markers.at(-1);
  if (marker) return `${marker[1]}: ${marker[2]}`;
  const failedTool = turn.parts.findLast((p) => p.kind === "tool_result" && /error|failed|exit \d|denied|no such file/i.test(p.content));
  if (failedTool) return failedTool.content.trim().slice(0, 1200);
  if (!turn.finalized) return "The agent stopped before finalizing its turn.";
  return null;
}

/**
 * The one park the operator cannot answer by typing: the harness CLI is not logged in. Agent
 * nodes run `claude -p` / `codex app-server`, which have no TTY, so there is no session to
 * log into from here. This opens a real terminal in the run's own folder with the login
 * command ready, and always shows the command too, because the terminal only opens on macOS
 * and a copyable command is never wrong.
 *
 * The harness name comes from the node's own `prompt-rendered` event rather than from parsing
 * the park reason — the reason is prose, the render is the record of which harness ran.
 */
function HarnessLogin({ runId, ask, detail }: { runId: string; ask: NonNullable<RunDetail["ask"]>; detail: RunDetail }) {
  const [result, setResult] = useState<{ command: string; error?: string } | null>(null);
  const harness = detail.renders.find((r) => r.node === ask.node && r.visit === ask.visit)?.harness ?? "claude";
  const open = async () => {
    try {
      const r = await fetch(`/api/runs/${runId}/harness-login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ harness }),
      });
      const body = (await r.json().catch(() => ({}))) as { command?: string; error?: string };
      setResult({ command: body.command ?? `${harness} login`, error: r.ok ? undefined : body.error });
    } catch (e) {
      setResult({ command: `${harness} login`, error: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div className="field-hint">
      <div className="actions">
        <Button variant="outline" size="sm" onClick={open}>Open a terminal to log in</Button>
      </div>
      {result && (
        <div>
          {result.error ? `${result.error} — run: ` : "Opened a terminal. Run: "}
          <code>{result.command}</code>
        </div>
      )}
      <div>Once you are logged in, send a reply (empty is fine) or resume the run to retry this step.</div>
    </div>
  );
}

function AskCard({ runId, ask, detail, onResolved }: { runId: string; ask: NonNullable<RunDetail["ask"]>; detail: RunDetail; onResolved: () => void }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "delivered" | "failed" | "refused">("idle");
  // a refusal (409) names the verb that WILL work for this park (system-map 0.2) — show it,
  // never collapse it into a generic "failed"
  const [refusal, setRefusal] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (location.hash === "#needs-input") ref.current?.focus(); }, []);
  const context = attentionContext(detail, ask);

  const send = useCallback(async () => {
    setState("sending");
    try {
      const r = await fetch(`/api/runs/${runId}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (r.status === 409) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setRefusal(body.error ?? "This park can't take a reply.");
        setState("refused");
        return;
      }
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
      {context && (
        <div className="field-error">
          {context}
        </div>
      )}
      {ask.code === "harness-unauthenticated" && <HarnessLogin runId={runId} ask={ask} detail={detail} />}
      {(ask.code === "attempt-failed" || ask.reason === "attempt failed") && (
        <div className="field-hint">Reply with instructions to change the retry, or send an empty reply to retry the step as-is.</div>
      )}
      <Textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} placeholder="Your reply…" disabled={state === "sending" || state === "delivered"} />
      <div className="actions">
        <Button onClick={send} disabled={state === "sending" || state === "delivered"}>
          <Send />{state === "sending" ? "Sending…" : state === "delivered" ? "Delivered" : "Reply"}
        </Button>
        {state === "failed" && <span className="send-state">failed — <a onClick={send} style={{ cursor: "pointer", textDecoration: "underline" }}>retry</a></span>}
      </div>
      {state === "refused" && refusal && <div className="send-state" role="alert">{refusal}</div>}
    </div>
  );
}

/**
 * HOW-3: the viewer half of `howdah resolve-effect`. A run parks on `ambiguous-effect` when
 * an effect was claimed but never proven done and the resume probe could not decide — the
 * human is the only source of truth about the outside world ("yes, the PR was published").
 * Each verdict is spelled out with its consequence, because the two are not symmetric: one
 * skips the step forever, the other runs it again.
 *
 * A 409 names what to do instead (a live runner, an effect already resolved the other way)
 * and is shown VERBATIM, never collapsed into a generic failure — the same rule as AskCard.
 */
export function EffectCard({
  runId,
  ask,
  effects,
  onResolved,
}: {
  runId: string;
  ask: NonNullable<RunDetail["ask"]>;
  effects: RunDetail["ambiguous_effects"];
  onResolved: () => void;
}) {
  const [state, setState] = useState<"idle" | "sending" | "recorded" | "failed">("idle");
  const [refusal, setRefusal] = useState<string | null>(null);

  const resolve = useCallback(
    async (effect: { node: string; effect: string }, verdict: "happened" | "not-happened") => {
      setState("sending");
      setRefusal(null);
      try {
        const r = await fetch(`/api/runs/${runId}/effects`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ effect: effect.effect, verdict, node: effect.node }),
        });
        if (r.status === 409) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          setRefusal(body.error ?? "This effect can't be resolved.");
          setState("idle");
          return;
        }
        if (!r.ok) throw new Error(await r.text());
        setState("recorded");
        setTimeout(onResolved, 420);
      } catch {
        setState("failed");
      }
    },
    [runId, onResolved],
  );

  const busy = state === "sending" || state === "recorded";
  return (
    <div className={`ask-card ${state === "recorded" ? "collapsing" : ""}`} id="needs-input">
      <h3>Needs you — {ask.node}@{ask.visit}</h3>
      <div>{ask.reason}</div>
      <div className="field-hint">
        The step was interrupted after it started this work, and nothing proved whether it finished. Only you can say.
      </div>
      {effects.length === 0 ? (
        <div className="send-state">Recorded — waiting for the run to resume.</div>
      ) : (
        effects.map((e) => (
          <div key={`${e.node}\u0000${e.effect}`} className="effect-row">
            <div>
              <code>{e.effect}</code> · {e.node}@{e.visit}
            </div>
            <div className="actions">
              <Button onClick={() => resolve(e, "happened")} disabled={busy}>
                It happened
              </Button>
              <Button onClick={() => resolve(e, "not-happened")} disabled={busy}>
                It didn't happen
              </Button>
            </div>
            <div className="field-hint">
              “It happened” skips this step's effect for good. “It didn't happen” runs it again on the retry.
            </div>
          </div>
        ))
      )}
      {state === "recorded" && <div className="send-state">Recorded — resuming…</div>}
      {state === "failed" && <div className="send-state" role="alert">failed — try again</div>}
      {refusal && <div className="send-state" role="alert">{refusal}</div>}
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

function liveDuration(row: Pick<RunDetail["timeline"][number], "duration_ms" | "started_at">, now: number): number {
  return row.duration_ms ?? Math.max(0, now - new Date(row.started_at).getTime());
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
function RunSteps({ timeline, ask, selected, now, onSelect, mapping }: {
  timeline: RunDetail["timeline"];
  ask: RunDetail["ask"];
  selected: string | null;
  now: number;
  onSelect: (key: string) => void;
  /** system-map 1d: an extraction in progress shows "mapping files done/total" on its row */
  mapping?: NonNullable<RunDetail["slice"]>["mapping"];
}) {
  if (timeline.length === 0) return <div className="empty">no steps yet</div>;
  const askKey = askRowKey(timeline, ask);
  const firstStartedAt = new Date(timeline[0]!.started_at).getTime();
  const liveSpan = Math.max(1, now - firstStartedAt);
  return (
    <div className="steps">
      {timeline.map((t, i) => {
        const span = t.finished_at ? t.run_span_ms || 1 : Math.max(t.run_span_ms || 1, liveSpan);
        const waiting = askKey === `${t.node}@${t.visit}`;
        const status = waiting ? "needs-input" : t.status;
        const total = liveDuration(t, now);
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
            {mapping && mapping.node === t.node && mapping.visit === t.visit && t.status === "running" && <MapProgressLine progress={mapping} />}
            <span className="step-dur">
              {fmtDur(total)}
              {t.waiting_ms > 0 && <span className="step-wait">{fmtDur(t.waiting_ms)}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The Steps split. The detail panel was a fixed 420px, which the approval card outgrew: a ghost
 * set is the densest thing this viewer renders, and reviewing one in a 420px gutter is the
 * difference between reading a design and squinting at it. Two affordances, because they answer
 * different needs: DRAG when you want both halves at once, FULL when the design is all you care
 * about (the list is one keystroke away again, and the panel header still names the step).
 *
 * The width is an operator preference, so it lives in localStorage and nowhere else — losing it
 * is harmless, it never needs to reach another viewer, and it is emphatically not a fact about
 * the run (the log is the only storage). Every access is wrapped: a private window or blocked
 * site data throws here, and a viewer that cannot remember a width must still render one.
 */
const DETAIL_MIN = 320;
const DETAIL_DEFAULT = 420;
const LIST_MIN = 240; // the waterfall stops being readable below this, so the drag stops here
const DETAIL_WIDTH_KEY = "howdah.detail-width";

export function readDetailWidth(): number {
  try {
    const raw = localStorage.getItem(DETAIL_WIDTH_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n >= DETAIL_MIN ? n : DETAIL_DEFAULT;
  } catch {
    return DETAIL_DEFAULT;
  }
}

/** Exported for component tests (web/app/split.test.tsx). */
export function StepsSplit({ list, detail }: { list: React.ReactNode; detail: React.ReactNode }) {
  const [width, setWidth] = useState(readDetailWidth);
  const [full, setFull] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // clamped against the LIVE container: the same drag at 1440 and at 1024 must both leave a
  // readable list, and a width remembered from a wide window must not strand a narrow one
  const clamp = useCallback((w: number) => {
    const total = box.current?.clientWidth ?? 0;
    const max = total > 0 ? Math.max(DETAIL_MIN, total - LIST_MIN) : Number.POSITIVE_INFINITY;
    return Math.round(Math.max(DETAIL_MIN, Math.min(w, max)));
  }, []);

  const commit = useCallback((w: number) => {
    const next = clamp(w);
    setWidth(next);
    try {
      localStorage.setItem(DETAIL_WIDTH_KEY, String(next));
    } catch {
      /* unremembered is fine; unrendered is not */
    }
  }, [clamp]);

  // width measured from the container's RIGHT edge, so the number IS the panel's width
  const widthAt = (clientX: number) => (box.current?.getBoundingClientRect().right ?? clientX) - clientX;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (full || e.button !== 0) return;
    e.preventDefault(); // or the pointer drag selects the step list's text instead
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setWidth(clamp(widthAt(ev.clientX)));
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up); // a cancelled drag still commits what it drew
      commit(widthAt(ev.clientX));
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  // a separator that only a mouse can move is not usable; arrows nudge, Home/End slam it open
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 96 : 24;
    const by = e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0;
    if (by !== 0) { e.preventDefault(); commit(width + by); }
    else if (e.key === "Home") { e.preventDefault(); commit(Number.POSITIVE_INFINITY); }
    else if (e.key === "End") { e.preventDefault(); commit(DETAIL_MIN); }
  };

  return (
    <div className="steps-split" ref={box} data-detail={full ? "full" : "split"} style={{ ["--sd-w" as string]: `${width}px` }}>
      {!full && list}
      <div
        className="sd-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="resize the detail panel"
        aria-valuenow={full ? 0 : width}
        aria-valuemin={DETAIL_MIN}
        tabIndex={full ? -1 : 0}
        onPointerDown={onPointerDown}
        onDoubleClick={() => commit(DETAIL_DEFAULT)}
        onKeyDown={onKeyDown}
      >
        <button
          className="sd-full"
          aria-pressed={full}
          aria-label={full ? "restore the step list" : "expand the detail panel to full width"}
          title={full ? "restore the step list" : "full width"}
          onPointerDown={(e) => e.stopPropagation()} /* the button is a click, never a drag */
          onClick={() => setFull(!full)}
        >
          {full ? <X size={11} /> : <ArrowUp size={11} style={{ transform: "rotate(-90deg)" }} />}
        </button>
      </div>
      {detail}
    </div>
  );
}

/**
 * Step detail (T24, story 5) — Inngest's right-hand panel. The ask lives HERE rather than
 * floating in the thread, and the Run toggle keeps the run-level facts one click away.
 */
/** Exported for component tests (web/app/steps.test.tsx): the pane routing lives here. */
export function StepDetail({ runId, row, detail, ask, now, onResolved }: {
  runId: string;
  row: RunDetail["timeline"][number] | null;
  detail: RunDetail;
  ask: RunDetail["ask"];
  now: number;
  onResolved: () => void;
}) {
  const [scope, setScope] = useState<"step" | "run">("step");
  const [pane, setPane] = useState<"ask" | "prompt" | "output" | SlicePaneId | null>(null);
  // an ask on a node that has no step row at all (e.g. approval-missing after a jump to a node
  // that never ran): no row can carry it, so the panel carries it — the operator is never left
  // with a needs-you banner and nothing to answer
  const rowlessAsk = ask !== null && askRowKey(detail.timeline, ask) === null ? ask : null;
  const rowlessAskCard = rowlessAsk && (
    <div className="sd-body sd-rowless-ask" data-testid="rowless-ask">
      <div className="pd-note">{rowlessAsk.node} has no step yet — it parked before its first attempt started</div>
      <AskCard key={`${rowlessAsk.node}@${rowlessAsk.visit}#${rowlessAsk.seq}`} runId={runId} ask={rowlessAsk} detail={detail} onResolved={onResolved} />
    </div>
  );
  if (!row) return <div className="step-detail">{rowlessAskCard ?? <div className="empty">pick a step</div>}</div>;

  const key = `${row.node}@${row.visit}`;
  const isAsking = ask !== null && askRowKey(detail.timeline, ask) === key;
  // system-map 1d: the slice panes (approval card, drift, map) live in THIS panel's slot.
  // Only an awaiting-approval ask IS the approval card (Ask is hidden then); any other park on
  // the step (attempt-failed, max-visits, …) is answered by a reply, so Ask stays and leads.
  const slicePaneList = slicePanes(detail.slice, row);
  const decidedOnCard = isAsking && ask!.code === "awaiting-approval" && slicePaneList.some((p) => p.value === "approval");
  const askFirst = isAsking && !decidedOnCard;
  const askPane = { value: "ask" as const, label: "Ask" };
  const panes: Array<{ value: NonNullable<typeof pane>; label: string }> = [
    ...(askFirst ? [askPane] : []),
    ...slicePaneList,
    ...(askFirst || decidedOnCard ? [] : [askPane]),
    { value: "prompt", label: "Prompt & context" },
    { value: "output", label: "Output" },
  ];
  const shown = panes.find((p) => p.value === pane)?.value ?? panes[0]!.value;
  const render = detail.renders.find((r) => r.node === row.node && r.visit === row.visit);
  const total = liveDuration(row, now);
  const work = Math.max(0, total - row.waiting_ms);
  const bar = (label: string, ms: number, of: number, cls: string) => (
    <div className="sd-seg">
      <div className="sd-seg-head"><span>{label}</span><span className="m">{fmtDur(ms)}</span></div>
      <div className="sd-seg-track"><span className={`sd-seg-fill ${cls}`} style={{ width: `${of > 0 ? (ms / of) * 100 : 0}%` }} /></div>
    </div>
  );

  return (
    <div className="step-detail">
      <PanelTabs className="sd-scope" itemClassName="chip" value={scope} onValueChange={setScope} items={[{ value: "step", label: "Step" }, { value: "run", label: "Run" }]} />
      {rowlessAskCard}

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
          <PanelTabs value={shown} onValueChange={setPane} items={panes} />
          <div className="sd-body">
            {(shown === "approval" || shown === "drift" || shown === "map") && detail.slice && (
              <SlicePane pane={shown} runId={runId} slice={detail.slice} row={row} onChanged={onResolved} />
            )}
            {shown === "ask" && (isAsking
              ? <AskCard key={`${ask!.node}@${ask!.visit}#${ask!.seq}`} runId={runId} ask={ask!} detail={detail} onResolved={onResolved} />
              : <div className="pd-note">this step is not waiting on you</div>)}
            {shown === "prompt" && (render
              ? <PromptAndContext runId={runId} render={render} />
              : <div className="pd-note">this step rendered no prompt (it is not an agent step)</div>)}
            {shown === "output" && (() => {
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
        <ScrollShell className="logs-shell" followKey={`${shown.length}:${shown.at(-1)?.seq ?? "empty"}:${kind}:${q}`}>
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
        </ScrollShell>
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
      <PanelTabs value={pane} onValueChange={setPane} items={[{ value: "details", label: "Details" }, { value: "raw", label: "Raw event" }]} />
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

/** how long a just-launched run may take to appear on disk before we say it is not coming */
export const OPEN_GRACE_MS = 10_000;
const OPEN_POLL_MS = 300;

/** `graceMs` is a seam for the component test (web/app/runview.test.tsx); nothing else sets it. */
export function RunView({ id, graceMs = OPEN_GRACE_MS }: { id: string; graceMs?: number }) {
  const [detail, setDetail] = useState<(RunDetail & { cwd_exists?: boolean; editor_configured?: boolean }) | null>(null);
  const [tab, setTab] = useState<"steps" | "thread" | "context" | "logs" | "chat" | "graph">("steps");
  const [picked, setPicked] = useState<string | null>(null);
  const [bannerAction, setBannerAction] = useState<"resume" | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const now = useNow();
  // a 404 here is normal for a moment: launching spawns the CLI detached and answers 202
  // before the run dir exists (web/server.ts POST /api/runs), so the viewer arrives ahead of
  // run.jsonl. Leaving `detail` null keeps the loading state this component already renders;
  // the poll below is what brings it back. Any other failure also leaves the last good view
  // in place rather than replacing it with an error body.
  const reload = useCallback(
    () => getJSON<RunDetail & { cwd_exists?: boolean; editor_configured?: boolean }>(`/api/runs/${id}`)
      .then((d) => { setDetail(d); setMissing(false); })
      .catch(() => {}),
    [id],
  );
  const runAction = useCallback(async (verb: "resume") => {
    setBannerAction(verb);
    setBannerError(null);
    try {
      const r = await fetch(`/api/runs/${id}/${verb}`, { method: "POST" });
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as any)?.error ?? `${verb} failed`);
      setTimeout(reload, 300);
    } catch (e) {
      setBannerError(e instanceof Error ? e.message : String(e));
    } finally {
      setBannerAction(null);
    }
  }, [id, reload]);
  // Waiting for a run that does not exist YET. The CLI needs a moment to boot and write its
  // first event, so poll while the page shows its loading state, and stop after OPEN_GRACE_MS
  // rather than spinning forever — a launch that died on boot never arrives, and a spinner
  // that never resolves is the same lie as a blank page.
  useEffect(() => {
    if (detail) return;
    setMissing(false);
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const tick = async () => {
      await reload();
      if (stop) return;
      if (Date.now() - started >= graceMs) setMissing(true);
      else timer = setTimeout(tick, OPEN_POLL_MS);
    };
    void tick();
    return () => { stop = true; if (timer !== undefined) clearTimeout(timer); };
  }, [detail, reload, graceMs]);
  useEffect(() => {
    if (!detail) return;
    const active = ["running", "needs-input", "waiting", "harness-dead", "failed-recoverable"].includes(detail.summary.status);
    if (!active) return;
    const t = setInterval(reload, 5000);
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [detail?.summary.status, reload]);
  useEffect(() => {
    if (detail?.ask || location.hash !== "#needs-input") return;
    history.replaceState(history.state, "", location.pathname + location.search);
  }, [detail?.ask]);
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

  if (!detail && missing)
    return (
      <Card className="max-w-[520px]">
        <CardContent className="pt-5">
          <div className="text-sm">No run <strong>{id}</strong></div>
          <div className="text-xs text-muted-foreground mt-1">
            Nothing was written to its log within {graceMs / 1000}s, so it probably failed to
            start. Check the launch settings and try again.
          </div>
          <div className="mt-3"><a href="/"><Button variant="outline" size="sm">Back to runs</Button></a></div>
        </CardContent>
      </Card>
    );
  if (!detail) return <LoadingState title="Loading run" detail={`Opening ${id}.`} />;
  const { summary, ask } = detail;
  const effectiveTimeline = detail.timeline.map((t) => ({ row: t, duration: liveDuration(t, now) }));
  const maxDur = Math.max(1, ...effectiveTimeline.map((t) => t.duration));
  const lastEventAgeMs = summary.last_event_at ? now - new Date(summary.last_event_at).getTime() : 0;
  const staleRunning = summary.status === "running" && lastEventAgeMs > 5 * 60_000;
  // the step that needs a human wins the selection; otherwise the newest one
  const askKey = askRowKey(detail.timeline, ask);
  const waitingRow = askKey ? detail.timeline.find((t) => `${t.node}@${t.visit}` === askKey) : undefined;
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
          <RunFolderButton runId={id} />
        </div>
        {summary.status === "needs-input" && summary.waiting_since && (
          <div className="banner">
            Waiting on you — {summary.needs_input_reason}
            <span className="timer">{fmtWait(summary.waiting_since, now)}</span>
          </div>
        )}
        {staleRunning && (
          <div className="banner failed">
            No run events for {fmtDur(lastEventAgeMs)}. The runner may be stuck even though its process is still alive.
          </div>
        )}
        {summary.status === "harness-dead" && (
          <div className="banner failed">
            Harness stopped before the current step finished.
            {bannerError && <span className="field-error ml-auto">{bannerError}</span>}
            <Button variant="destructive" size="sm" className="ml-auto" disabled={bannerAction === "resume"} onClick={() => runAction("resume")}>
              {bannerAction === "resume" ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              {bannerAction === "resume" ? "Resuming…" : "Resume"}
            </Button>
          </div>
        )}
        {summary.paused && (
          <div className="banner paused">
            Paused by you — the run holds at the node boundary.
            {bannerError && <span className="field-error ml-auto">{bannerError}</span>}
            <Button size="sm" className="ml-auto bg-[var(--status-waiting)]" disabled={bannerAction === "resume"} onClick={() => runAction("resume")}>
              {bannerAction === "resume" ? <Loader2 className="animate-spin" /> : <Play />}
              {bannerAction === "resume" ? "Resuming…" : "Resume"}
            </Button>
          </div>
        )}
        {summary.outcome === "aborted" && <div className="banner failed">Aborted by you.</div>}
        {summary.outcome !== "aborted" && (summary.status === "failed-recoverable" || summary.status === "failed-terminal") && (
          <div className="banner failed">
            {summary.failure
              ? <>Failed at {summary.failure.node}@{summary.failure.visit}{summary.failure.reason ? <> — {summary.failure.reason.replace(/^executor threw: /, "")}</> : null}</>
              : <>Run failed — see the last thread entry</>}
            {summary.status === "failed-recoverable" && (
              <>
                {bannerError && <span className="field-error ml-auto">{bannerError}</span>}
                <Button variant="destructive" size="sm" className="ml-auto" disabled={bannerAction === "resume"} onClick={() => runAction("resume")}>
                  {bannerAction === "resume" ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                  {bannerAction === "resume" ? "Retrying…" : "Retry"}
                </Button>
              </>
            )}
          </div>
        )}
        {tab === "steps" ? (
          <StepsSplit
            list={<RunSteps timeline={detail.timeline} ask={ask} selected={selectedKey} now={now} onSelect={setPicked} mapping={detail.slice?.mapping} />}
            detail={<StepDetail runId={id} row={selectedRow} detail={detail} ask={ask} now={now} onResolved={reload} />}
          />
        ) : tab === "context" ? (
          <RunContext entries={detail.context} />
        ) : tab === "chat" ? (
          <RunChat runId={id} detail={detail} ask={ask} onPickStep={(k) => { setPicked(k); setTab("steps"); }} />
        ) : tab === "logs" ? (
          <RunLogs rows={detail.log_rows} />
        ) : tab === "graph" ? (
          <RunGraph runId={id} graph={summary.graph} timeline={detail.timeline} status={summary.status} onJumped={reload} />
        ) : (
          <RunThread
            turns={resolvedTurns}
            renderByTurnKey={renderByTurnKey}
            runId={id}
            ask={ask}
            detail={detail}
            onResolved={reload}
            onReviewDesign={() => { setPicked(askKey); setTab("steps"); }}
          />
        )}
      </div>

      <div className="rail">
        <section>
          <h2><Fingerprint size={12} /> Identity</h2>
          <div className="kv"><span className="k">run</span><span>{id}</span></div>
          <div className="kv"><span className="k">graph</span><span>{summary.graph}</span></div>
          {detail.persistence && <div className="kv"><span className="k">home</span><span className="path" title={detail.persistence.home}>{detail.persistence.home}</span></div>}
          {detail.identity.cwd && <div className="kv"><span className="k">{detail.identity.folder_kind === "repo" ? "repo" : "folder"}</span><span className="path" title={detail.identity.cwd}>{detail.identity.cwd.split("/").slice(-2).join("/")}</span></div>}
          {detail.git?.intended?.branch && <div className="kv"><span className="k">branch</span><span>{detail.git.intended.branch}</span></div>}
        </section>
        {detail.persistence && (
          <section>
            <h2><FolderOpen size={12} /> Persistence</h2>
            <div className="kv"><span className="k">run dir</span><span className="path" title={detail.persistence.run_dir}>{detail.persistence.run_dir}</span></div>
            <div className="kv"><span className="k">log</span><span className="path" title={detail.persistence.log_path}>{detail.persistence.log_path.split("/").slice(-3).join("/")}</span></div>
            {detail.persistence.worktree_path && <div className="kv"><span className="k">worktree</span><span className="path" title={detail.persistence.worktree_path}>{detail.persistence.worktree_path.split("/").slice(-3).join("/")}</span></div>}
            <div className="kv"><span className="k">runner</span><span>{detail.persistence.runner_alive ? "alive" : "not running"}</span></div>
            <div className="rail-actions">
              <CopyButton text={`HOWDAH_HOME=${detail.persistence.home} bun cli/main.ts resume ${id}`} label="Copy resume" />
            </div>
          </section>
        )}
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
          {effectiveTimeline.map(({ row: t, duration }, i) => (
            <div key={i} className="tl-row" style={{ ["--status-color" as any]: `var(--status-${t.status === "succeeded" ? "done" : t.status === "failed" ? "failed-recoverable" : "running"})` }}>
              <span className="tl-node">{t.node}@{t.visit}</span>
              <span className="tl-bar-track"><span className="tl-bar" style={{ width: `${Math.max(4, (duration / maxDur) * 100)}%` }} /></span>
              <span className="tl-dur">{fmtDur(duration)}</span>
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

  const loadWorkspaces = () => getJSON<Workspaces>("/api/workspaces").then(setWorkspaces).catch(() => {});
  useEffect(() => {
    getJSON<GraphInfo[]>("/api/graphs").then(setGraphs).catch(() => {});
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
      location.assign(`/run/${id}`);
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

const HARNESSES = ["", "claude", "codex"];
const EFFORTS = ["", "low", "medium", "high", "xhigh"];
const PERMISSION_MODES = ["", "auto"];
const MODEL_SUGGESTIONS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-5", "gpt-5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const BULK_PRESETS: Array<{ id: string; label: string; target: string; cfg: AgentConfigDto }> = [
  { id: "codex-planning", label: "Planning: GPT-5", target: "role:planning", cfg: { harness: "codex", model: "gpt-5", effort: "high" } },
  { id: "claude-planning", label: "Planning: Opus 5", target: "role:planning", cfg: { harness: "claude", model: "claude-opus-5", effort: "high", permissionMode: "auto" } },
  { id: "delivery-cheap", label: "Delivery: cheap Codex", target: "class:delivery", cfg: { harness: "codex", model: "gpt-5.6-luna", effort: "low" } },
  { id: "delivery-balanced", label: "Delivery: balanced Codex", target: "class:delivery", cfg: { harness: "codex", model: "gpt-5.6-terra", effort: "medium" } },
];

type GraphTuningDto = { defaults?: AgentConfigDto; nodes?: Record<string, AgentConfigDto> };

function cleanConfig(c: AgentConfigDto | undefined): AgentConfigDto | undefined {
  if (!c) return undefined;
  const out: AgentConfigDto = {};
  for (const [key, raw] of Object.entries(c) as [keyof AgentConfigDto, unknown][]) {
    if (raw === undefined || raw === null || raw === "") continue;
    if (Array.isArray(raw) && raw.length === 0) continue;
    (out as any)[key] = raw;
  }
  return Object.keys(out).length ? out : undefined;
}

function mergeConfig(a: AgentConfigDto | undefined, b: AgentConfigDto): AgentConfigDto {
  return cleanConfig({ ...(a ?? {}), ...cleanConfig(b) }) ?? {};
}

function modelFitsHarness(harness: string, model: string): boolean {
  const claudeLike = /claude|opus|sonnet|haiku|fable/i.test(model);
  const codexLike = /gpt|codex|terra|luna|^o\d/i.test(model);
  if (harness === "codex") return !claudeLike || codexLike;
  if (harness === "claude") return !codexLike || claudeLike;
  return true;
}

function resolvePreview(layers: Array<AgentConfigDto | undefined>): AgentConfigDto {
  const pick = (k: keyof AgentConfigDto) => {
    for (const layer of layers) {
      const value = layer?.[k];
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const harness = String(pick("harness") ?? "claude");
  let model: string | undefined;
  for (const layer of layers) {
    if (layer?.model && modelFitsHarness(harness, layer.model)) {
      model = layer.model;
      break;
    }
  }
  return {
    harness,
    model,
    effort: pick("effort") as string | undefined,
    permissionMode: harness === "claude" ? "auto" : pick("permissionMode") as string | undefined,
    maxTurns: pick("maxTurns") as number | undefined,
    skills: pick("skills") as string[] | undefined,
  };
}

function previewShape(shape: GraphShapeDto, tuning: GraphTuningDto): GraphShapeDto {
  const tsDefaults = shape.defaults ?? {};
  return {
    ...shape,
    tuning,
    nodes: shape.nodes.map((n) => {
      if (n.kind !== "agent") return n;
      const nodeTuning = tuning.nodes?.[n.id];
      const effective = resolvePreview([nodeTuning, n.baseline, tuning.defaults, tsDefaults]);
      return { ...n, node_tuning: nodeTuning, effective, harness: effective.harness, model: effective.model, effort: effective.effort };
    }),
  };
}

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
          {HARNESSES.map((x) => <option key={x} value={x}>{x || ph("harness", "inherit (claude)")}</option>)}
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
  const [tuning, setTuning] = useState<GraphTuningDto>(shape.tuning ?? {});
  const [bulkTarget, setBulkTarget] = useState("class:delivery");
  const [bulkConfig, setBulkConfig] = useState<AgentConfigDto>({ harness: "codex", model: "gpt-5.6-luna", effort: "low" });
  const [dirty, setDirty] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  useEffect(() => { setTuning(shape.tuning ?? {}); setDirty(false); setSelectedNode(null); }, [shape.name]);

  const preview = useMemo(() => previewShape(shape, tuning), [shape, tuning]);
  const agentNodes = preview.nodes.filter((n) => n.kind === "agent");
  const classes = Array.from(new Set(agentNodes.map((n) => n.class).filter(Boolean) as string[])).sort();
  const node = preview.nodes.find((n) => n.id === selectedNode);
  const idsForTarget = (target: string) => agentNodes
    .filter((n) =>
      target === "all" ||
      target === `class:${n.class ?? ""}` ||
      (target === "role:planning" && /\bplan|planning/i.test(n.id)),
    )
    .map((n) => n.id);
  const selectedIds = idsForTarget(bulkTarget);
  const setNodeCfg = (id: string, v: AgentConfigDto) => {
    const cleaned = cleanConfig(v);
    const nodes = { ...(tuning.nodes ?? {}) };
    if (cleaned) nodes[id] = cleaned;
    else delete nodes[id];
    setTuning({ ...tuning, nodes });
    setDirty(true);
  };
  const clearNodeCfg = (id: string) => {
    const nodes = { ...(tuning.nodes ?? {}) };
    delete nodes[id];
    setTuning({ ...tuning, nodes });
    setDirty(true);
  };
  const applyBulk = (cfg = bulkConfig, target = bulkTarget) => {
    const nodes = { ...(tuning.nodes ?? {}) };
    for (const id of idsForTarget(target)) nodes[id] = mergeConfig(nodes[id], cfg);
    setTuning({ ...tuning, nodes });
    setDirty(true);
  };
  const clearBulk = (target = bulkTarget) => {
    const nodes = { ...(tuning.nodes ?? {}) };
    for (const id of idsForTarget(target)) delete nodes[id];
    setTuning({ ...tuning, nodes });
    setDirty(true);
  };
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
      <GraphDag key={`${shape.name}:${JSON.stringify(tuning)}`} shape={preview} onSelect={setSelectedNode} selected={selectedNode ?? undefined} />
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
          <CardHeader>
            <CardTitle>Bulk update</CardTitle>
            <CardDescription>Apply a model level to a whole graph slice. Node overrides are saved to tuning.json.</CardDescription>
          </CardHeader>
          <CardContent>
            <Label>
              Target
              <Select value={bulkTarget} onChange={(e) => setBulkTarget(e.target.value)}>
                <option value="all">all agent nodes</option>
                <option value="role:planning">planning nodes</option>
                {classes.map((c) => <option key={c} value={`class:${c}`}>{c} class</option>)}
              </Select>
            </Label>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Label>
                Harness
                <Select value={bulkConfig.harness ?? ""} onChange={(e) => setBulkConfig({ ...bulkConfig, harness: e.target.value || undefined })}>
                  {HARNESSES.map((x) => <option key={x} value={x}>{x || "keep current"}</option>)}
                </Select>
              </Label>
              <Label>
                Model
                <Input list="model-suggestions" value={bulkConfig.model ?? ""} placeholder="keep current" onChange={(e) => setBulkConfig({ ...bulkConfig, model: e.target.value || undefined })} />
              </Label>
              <Label>
                Effort
                <Select value={bulkConfig.effort ?? ""} onChange={(e) => setBulkConfig({ ...bulkConfig, effort: e.target.value || undefined })}>
                  {EFFORTS.map((x) => <option key={x} value={x}>{x || "keep current"}</option>)}
                </Select>
              </Label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => applyBulk()}><SlidersHorizontal />Apply to {selectedIds.length}</Button>
              {BULK_PRESETS.map((p) => (
                <Button key={p.id} variant="outline" size="sm" onClick={() => { setBulkTarget(p.target); setBulkConfig(p.cfg); applyBulk(p.cfg, p.target); }}>{p.label}</Button>
              ))}
              <Button variant="ghost" size="sm" onClick={() => clearBulk()}><ResetIcon />Clear target overrides</Button>
            </div>
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
                <Button variant="ghost" size="sm" className="self-start" onClick={() => clearNodeCfg(node.id)}><ResetIcon />Clear node override</Button>
              </CardContent>
            </>
          ) : (
            <CardContent className="pt-5"><div className="field-hint">Click an agent node (◆) in the graph to tune it.</div></CardContent>
          )}
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Agent nodes</CardTitle>
          <CardDescription>Scan the effective routing model and jump straight to a node override.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[13px]">
              <thead className="text-[11px] uppercase text-muted-foreground">
                <tr>
                  <th className="border-b border-border py-1.5 pr-3 font-normal">Node</th>
                  <th className="border-b border-border py-1.5 pr-3 font-normal">Class</th>
                  <th className="border-b border-border py-1.5 pr-3 font-normal">Harness</th>
                  <th className="border-b border-border py-1.5 pr-3 font-normal">Model</th>
                  <th className="border-b border-border py-1.5 pr-3 font-normal">Effort</th>
                  <th className="border-b border-border py-1.5 pr-3 font-normal">Override</th>
                </tr>
              </thead>
              <tbody>
                {agentNodes.map((n) => (
                  <tr key={n.id} className={`cursor-pointer hover:bg-muted ${selectedNode === n.id ? "bg-muted" : ""}`} onClick={() => setSelectedNode(n.id)}>
                    <td className="border-b border-border py-2 pr-3 font-mono">{n.id}</td>
                    <td className="border-b border-border py-2 pr-3">{n.class ?? "—"}</td>
                    <td className="border-b border-border py-2 pr-3 font-mono">{n.effective?.harness ?? "claude"}</td>
                    <td className="border-b border-border py-2 pr-3 font-mono">{n.effective?.model ?? "default"}</td>
                    <td className="border-b border-border py-2 pr-3 font-mono">{n.effective?.effort ?? "—"}</td>
                    <td className="border-b border-border py-2 pr-3">{n.node_tuning ? <Badge variant="attention">node</Badge> : <Badge variant="outline">inherit</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
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
  useEffect(() => { getJSON<Array<{ name: string; description: string; kind: string }>>("/api/graphs").then(setGraphs).catch(() => {}); }, []);
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
  const loadWs = () => getJSON<Workspaces>("/api/workspaces").then(setWs).catch(() => {});
  const removeWs = async (name: string) => {
    await fetch("/api/workspaces", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    loadWs();
  };
  useEffect(() => { getJSON<{ editorCommand?: string; slackWebhook?: string; chime?: boolean }>("/api/settings").then(setS).catch(() => {}); loadWs(); }, []);
  if (!s) return <LoadingState title="Loading settings" />;
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
  const load = useCallback(() => getJSON<PromptSummary[]>("/api/prompts").then(setList).catch(() => setList([])), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!selected) return void setDetail(null);
    setDetail(null);
    getJSON<PromptDetail>(`/api/prompts/${encodeURIComponent(selected)}`).then(setDetail).catch(() => setDetail(null));
  }, [selected]);

  if (!list) return <LoadingState title="Loading prompts" detail="Reading prompt history and outcomes." />;
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
              {p.outcomes.renders > 0 && <Badge variant="outline">{p.outcomes.renders} run{p.outcomes.renders === 1 ? "" : "s"}</Badge>}
            </span>
          </a>
        ))}
      </div>
      {!selected ? (
        <div className="empty">pick a prompt to see its history, feedback and outcomes</div>
      ) : !detail ? (
        <LoadingState title={`Loading ${selected}`} />
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
    if (!res || !res.ok) return setError(payload?.error ?? `${verb} failed`);
    if (verb === "accept") setNotice(`accepted — the prompt is now v${payload.version}. New runs pin it; runs in flight keep what they started with (OV-2).`);
    if (verb === "redraft") setNotice(`re-drafting ${payload.drafting} — the reviser is running${payload.stubbed ? " (stubbed)" : ""}. Reload in a minute.`);
    if (verb === "reject") { setRejecting(false); setReason(""); }
    load();
    window.dispatchEvent(new Event(PROPOSALS_CHANGED));
  };

  if (!list) return <LoadingState title="Loading proposals" detail="Reading pending prompt revisions." />;
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
    getJSON<ProposalView[]>("/api/proposals")
      .then((ps) => setPending(ps.filter((p) => p.status === "pending").length))
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
        <Button variant="ghost" size="sm" className="justify-start text-faint" onClick={() => setTheme(theme === "dark" ? "light" : theme === "light" ? "system" : "dark")}>
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

// guarded: component tests import this module (StepDetail) into a DOM with no #root
const mount = document.getElementById("root");
if (mount) createRoot(mount).render(<App />);
