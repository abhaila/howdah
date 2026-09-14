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
  CornerDownRight, FolderGit2, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunDetail, RunSummary, RunStatus } from "../derive";
import type { CoalescedTurn } from "../../log/coalesce";
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

function Turn({ turn, render }: { turn: CoalescedTurn; render?: RunDetail["renders"][number] }) {
  const [open, setOpen] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const toolParts = turn.parts.filter((p) => p.kind === "tool_call" || p.kind === "tool_result");
  const textParts = turn.parts.filter((p) => p.kind === "text");
  return (
    <div className={`turn ${turn.finalized ? "" : "unfinalized"}`}>
      <div className="who">
        {turn.node}@{turn.visit} · turn {turn.turn}{turn.finalized ? "" : " · interrupted"}
        {render?.model && <span className="model-chip">{render.harness ?? "claude"} · {render.model}{render.effort ? ` · ${render.effort}` : ""}</span>}
      </div>
      {textParts.map((p, i) => <div key={i} className="prose">{p.content}</div>)}
      {toolParts.length > 0 && (
        <div className="tool-cluster" onClick={() => setOpen(!open)}>
          ⚒ {toolParts.filter((p) => p.kind === "tool_call").length} tool calls {open ? "▾" : "▸"}
          {open && toolParts.map((p, i) => (
            <div key={i} className="tool-detail">{p.kind === "tool_call" ? `→ ${p.tool_name ?? "tool"}: ` : "← "}{p.content}</div>
          ))}
        </div>
      )}
      {render && (
        <div className="prompt-context" onClick={() => setShowPrompt(!showPrompt)}>
          Prompt &amp; context · {render.prompt} v{render.prompt_version} {showPrompt ? "▾" : "▸"}
          {showPrompt && <pre>{JSON.stringify(render.context_read, null, 2)}</pre>}
        </div>
      )}
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

function RunView({ id }: { id: string }) {
  const [detail, setDetail] = useState<(RunDetail & { cwd_exists?: boolean; editor_configured?: boolean }) | null>(null);
  const [tab, setTab] = useState<"thread" | "graph">("thread");
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
            onValueChange={(v) => setTab(v as "thread" | "graph")}
            items={[
              { value: "thread", label: "Thread", icon: <MessagesSquare /> },
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
        {tab === "graph" ? (
          <RunGraph runId={id} graph={summary.graph} timeline={detail.timeline} status={summary.status} onJumped={reload} />
        ) : (
          <>
            {resolvedTurns.map((t) => (
              <Turn key={`${t.node}@${t.visit}#${t.turn}`} turn={t} render={renderByTurnKey.get(`${t.node}@${t.visit}`)} />
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
      <Card className="max-w-[560px]">
        <CardContent className="pt-4">
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
const PERMISSION_MODES = ["", "manual", "acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan"];
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
            <CardContent className="pt-4"><div className="field-hint">Click an agent node (◆) in the graph to tune it.</div></CardContent>
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
    <div className="runs" style={{ maxWidth: 1100 }}>
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
      <Card className="max-w-[560px]">
        <CardContent className="pt-4">
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
      <Card className="max-w-[560px]">
        <CardContent className="pt-4">
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
  const isNew = path === "/new";
  const isSettings = path === "/settings";
  const isGraphs = path === "/graphs";
  return (
    <div className="shell">
      {!splashDone && <Splash onDone={() => setSplashDone(true)} />}
      <nav className="sidebar">
        <a className="mark-btn" title="Replay the splash" onClick={() => setSplashDone(false)}><Mark className="mark" /></a>
        <a className={`nav ${!runMatch && !isNew && !isGraphs && !isSettings ? "active" : ""}`} href="/"><Rows3 size={15} /><span className="label">Runs</span></a>
        <a className={`nav ${isNew ? "active" : ""}`} href="/new"><Plus size={15} /><span className="label">New run</span></a>
        <a className={`nav ${isGraphs ? "active" : ""}`} href="/graphs"><Workflow size={15} /><span className="label">Graphs</span></a>
        <a className={`nav ${isSettings ? "active" : ""}`} href="/settings"><SettingsIcon size={15} /><span className="label">Settings</span></a>
        <div className="spacer" />
        <Button variant="outline" size="sm" onClick={() => setTheme(theme === "dark" ? "light" : theme === "light" ? "system" : "dark")}>
          theme: {theme}
        </Button>
      </nav>
      <main>{runMatch ? <RunView id={runMatch[1]!} /> : isNew ? <StartRun /> : isSettings ? <Settings /> : isGraphs ? <GraphsList /> : <div className="runs"><RunsList /></div>}</main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
