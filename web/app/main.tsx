/**
 * Howdah web app v0 (T11). Path routing: `/` runs list, `/run/:id` run view
 * (deep-linkable, `#needs-input` focuses the reply). Live via SSE. Served pre-bundled
 * as /app.js (bun build web/app/main.tsx — see web/server.ts startup).
 */
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunDetail, RunSummary, RunStatus } from "../derive";
import type { CoalescedTurn } from "../../log/coalesce";
import { GraphDag, useGraphShape } from "./graph-dag";

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
      <circle cx="21" cy="30" r="3" fill="#f59e0b" />
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

function RunGraph({ graph, timeline }: { graph: string; timeline: RunDetail["timeline"] }) {
  const shape = useGraphShape(graph);
  if (!shape) return <div className="empty">loading graph…</div>;
  const visits: Record<string, number> = {};
  for (const t of timeline) visits[t.node] = Math.max(visits[t.node] ?? 0, t.visit);
  const running = timeline.findLast((t) => t.status === "running");
  const current = running?.node ?? timeline.at(-1)?.node;
  return <div style={{ paddingTop: 16 }}><GraphDag shape={shape} current={current} visits={visits} /></div>;
}

function OpenIdeButton({ runId, detail }: { runId: string; detail: RunDetail & { cwd_exists?: boolean; editor_configured?: boolean } }) {
  // design rules: hidden for Plain runs without a folder; disabled+tooltip for cleaned
  // worktrees; unconfigured routes to Settings
  if (!detail.identity.cwd) return null;
  if (!detail.editor_configured)
    return <a className="ide-btn" href="/settings" title="No editor configured">Open in IDE…</a>;
  if (!detail.cwd_exists)
    return <span className="ide-btn disabled" title="Folder is gone — worktree was cleaned">Open in IDE</span>;
  return (
    <button className="ide-btn" onClick={() => fetch(`/api/runs/${runId}/open-ide`, { method: "POST" })}>
      Open in IDE
    </button>
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
      setTimeout(onResolved, 400); // card collapses into an operator row — the motion moment
    } catch {
      setState("failed");
    }
  }, [runId, text, onResolved]);

  return (
    <div className="ask-card" id="needs-input">
      <h3>Needs you — {ask.node}@{ask.visit}</h3>
      <div>{ask.reason}</div>
      <textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} placeholder="Your reply…" disabled={state === "sending" || state === "delivered"} />
      <div className="actions">
        <button className="primary" onClick={send} disabled={state === "sending" || state === "delivered"}>
          {state === "sending" ? "Sending…" : state === "delivered" ? "Delivered" : "Reply"}
        </button>
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
          <span className="tabs">
            <button className={`tab ${tab === "thread" ? "active" : ""}`} onClick={() => setTab("thread")}>Thread</button>
            <button className={`tab ${tab === "graph" ? "active" : ""}`} onClick={() => setTab("graph")}>Graph</button>
          </span>
          <OpenIdeButton runId={id} detail={detail} />
        </div>
        {summary.status === "needs-input" && summary.waiting_since && (
          <div className="banner">
            Waiting on you — {summary.needs_input_reason}
            <span className="timer">{fmtWait(summary.waiting_since, now)}</span>
          </div>
        )}
        {(summary.status === "failed-recoverable" || summary.status === "failed-terminal") && (
          <div className="banner failed">
            {summary.failure
              ? <>Failed at {summary.failure.node}@{summary.failure.visit}{summary.failure.reason ? <> — {summary.failure.reason.replace(/^executor threw: /, "")}</> : null}</>
              : <>Run failed — see the last thread entry</>}
            {summary.status === "failed-recoverable" && (
              <button className="retry" onClick={() => fetch(`/api/runs/${id}/resume`, { method: "POST" }).then(reload)}>Retry</button>
            )}
          </div>
        )}
        {tab === "graph" ? (
          <RunGraph graph={summary.graph} timeline={detail.timeline} />
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
          <h2>Identity</h2>
          <div className="kv"><span className="k">run</span><span>{id}</span></div>
          <div className="kv"><span className="k">graph</span><span>{summary.graph}</span></div>
          {detail.identity.cwd && <div className="kv"><span className="k">{detail.identity.folder_kind === "repo" ? "repo" : "folder"}</span><span className="path" title={detail.identity.cwd}>{detail.identity.cwd.split("/").slice(-2).join("/")}</span></div>}
          {detail.git?.intended?.branch && <div className="kv"><span className="k">branch</span><span>{detail.git.intended.branch}</span></div>}
        </section>
        {detail.identity.folder_kind === "repo" && (
          <section>
            <h2>Git</h2>
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
            <h2>Pull requests</h2>
            {detail.pull_requests.map((pr) => (
              <div key={pr.url} className="kv">
                <a href={pr.url} target="_blank" rel="noreferrer" className="pr-link">{pr.url.replace(/^https:\/\/github\.com\//, "")}</a>
                <span className={`pr-state pr-${pr.state.toLowerCase()}`}>{pr.state}</span>
              </div>
            ))}
          </section>
        )}
        <section>
          <h2>Timeline</h2>
          {detail.timeline.map((t, i) => (
            <div key={i} className="tl-row" style={{ ["--status-color" as any]: `var(--status-${t.status === "succeeded" ? "done" : t.status === "failed" ? "failed-recoverable" : "running"})` }}>
              <span className="tl-node">{t.node}@{t.visit}</span>
              <span className="tl-bar-track"><span className="tl-bar" style={{ width: `${Math.max(4, ((t.duration_ms ?? maxDur) / maxDur) * 100)}%` }} /></span>
              <span className="tl-dur">{t.duration_ms === null ? "…" : t.duration_ms < 1000 ? `${t.duration_ms}ms` : `${Math.round(t.duration_ms / 1000)}s`}</span>
            </div>
          ))}
        </section>
        <section>
          <h2>Usage</h2>
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
          <h2>Pinned prompts</h2>
          {Object.entries(detail.pinned_prompts).map(([p, v]) => (
            <div key={p} className="kv"><span className="k">{p}</span><span>v{v}</span></div>
          ))}
        </section>
      </div>
    </div>
  );
}


// ---- workspace registration ------------------------------------------------------

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
  return (
    <div className="add-workspace">
      {hint && <div className="field-hint">{hint}</div>}
      <div className="add-workspace-row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name (e.g. platform-api)" />
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/areeb/code/… or ~/code/…" style={{ flex: 2 }} />
        <button className="primary" onClick={add} disabled={busy || !name.trim() || !path.trim()}>{busy ? "…" : "Add"}</button>
      </div>
      {error && <div className="field-error">{error}</div>}
      <div className="field-hint">A git repo registers as a repo (worktrees + PRs); any other folder registers as Plain.</div>
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
        body: JSON.stringify({ graph, inputs, workspace: workspace || undefined }),
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
      <div className="form-card">
        <label className="field">
          <span>Graph</span>
          <select value={graph} onChange={(e) => { setGraph(e.target.value); setInputs({}); }}>
            <option value="">choose…</option>
            {graphs.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}
          </select>
        </label>
        {selected && <div className="field-hint">{selected.description}</div>}
        {selected?.inputs.map((k) => (
          <label className="field" key={k}>
            <span>{k}</span>
            <input value={inputs[k] ?? ""} onChange={(e) => setInputs({ ...inputs, [k]: e.target.value })} placeholder={k} />
          </label>
        ))}
        {selected && (
          <label className="field">
            <span>Workspace {selected.kind === "repo" ? "(repo required)" : ""}</span>
            <select value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
              <option value="">{selected.kind === "repo" ? (options.length ? "choose a repo…" : "no repos registered") : "none (log-only)"}</option>
              {options.map((w) => <option key={w.name} value={w.name}>{w.name} — {w.path}</option>)}
            </select>
          </label>
        )}
        {selected?.kind === "repo" && options.length === 0 && (
          <AddWorkspace hint="This graph creates worktrees and PRs, so it needs a registered git repo:" onAdded={loadWorkspaces} />
        )}
        {error && <div className="field-error">{error}</div>}
        <button
          className="primary"
          disabled={busy || !selected || selected.inputs.some((k) => !(inputs[k] ?? "").trim()) || (selected.kind === "repo" && !workspace)}
          onClick={launch}
        >
          {busy ? "Launching…" : "Launch run"}
        </button>
      </div>
    </div>
  );
}



// ---- graphs screen (T20) ---------------------------------------------------------

function GraphsList() {
  const [graphs, setGraphs] = useState<Array<{ name: string; description: string; kind: string }>>([]);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { fetch("/api/graphs").then((r) => r.json()).then(setGraphs).catch(() => {}); }, []);
  const shape = useGraphShape(selected ?? undefined);
  return (
    <div className="runs" style={{ maxWidth: 1100 }}>
      <h1>Graphs</h1>
      <div className="graphs-layout">
        <div>
          {graphs.map((g) => (
            <div key={g.name} className={`run-row ${selected === g.name ? "selected" : ""}`} onClick={() => setSelected(g.name)}>
              <span className="run-goal">{g.name}</span>
              <span className="run-meta">{g.kind}</span>
            </div>
          ))}
          <div className="field-hint" style={{ marginTop: 12 }}>
            New graph: <code>howdah new-graph &lt;name&gt; --kind doc|custom</code> — scaffolds the TS file + prompts; tsc and validate() are the editor.
          </div>
        </div>
        <div>
          {shape ? <><div className="field-hint" style={{ marginBottom: 8 }}>{shape.description}</div><GraphDag shape={shape} /></> : <div className="empty">select a graph</div>}
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
      <div className="form-card">
        <label className="field">
          <span>Editor command (Open-in-IDE)</span>
          <input value={s.editorCommand ?? ""} onChange={(e) => setS({ ...s, editorCommand: e.target.value })} placeholder="idea — IntelliJ launcher on PATH (Tools → Create Command-line Launcher)" />
        </label>
        <label className="field">
          <span>Slack webhook (attention DMs)</span>
          <input value={s.slackWebhook ?? ""} onChange={(e) => setS({ ...s, slackWebhook: e.target.value })} placeholder="https://hooks.slack.com/…" />
        </label>
        <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={s.chime !== false} onChange={(e) => setS({ ...s, chime: e.target.checked })} style={{ width: "auto" }} />
          <span style={{ textTransform: "none", fontSize: 13, color: "var(--fg)" }}>Attention chime</span>
        </label>
        <button className="primary" onClick={save}>{saved ? "Saved" : "Save"}</button>
      </div>

      <h1 style={{ marginTop: 28 }}>Workspaces</h1>
      <div className="form-card">
        {[...ws.repos.map((w) => ({ ...w, kind: "repo" })), ...ws.folders.map((w) => ({ ...w, kind: "plain" }))].map((w) => (
          <div key={w.name} className="ws-row">
            <span className="ws-kind">{w.kind}</span>
            <span className="run-goal">{w.name}</span>
            <span className="run-meta" title={w.path}>{w.path}</span>
            <button className="ws-remove" onClick={() => removeWs(w.name)} title="Remove (files untouched)">✕</button>
          </div>
        ))}
        {ws.repos.length + ws.folders.length === 0 && <div className="field-hint">No workspaces yet.</div>}
        <AddWorkspace onAdded={loadWs} />
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
      <nav className="sidebar">
        <Mark className="mark" />
        <a className={`nav ${!runMatch && !isNew ? "active" : ""}`} href="/"><span className="label">Runs</span></a>
        <a className={`nav ${isNew ? "active" : ""}`} href="/new"><span className="label">New run</span></a>
        <a className={`nav ${isGraphs ? "active" : ""}`} href="/graphs"><span className="label">Graphs</span></a>
        <a className={`nav ${isSettings ? "active" : ""}`} href="/settings"><span className="label">Settings</span></a>
        <div className="spacer" />
        <button className="theme-toggle" onClick={() => setTheme(theme === "dark" ? "light" : theme === "light" ? "system" : "dark")}>
          theme: {theme}
        </button>
      </nav>
      <main>{runMatch ? <RunView id={runMatch[1]!} /> : isNew ? <StartRun /> : isSettings ? <Settings /> : isGraphs ? <GraphsList /> : <div className="runs"><RunsList /></div>}</main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
