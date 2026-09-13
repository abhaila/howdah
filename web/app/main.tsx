/**
 * Howdah web app v0 (T11). Path routing: `/` runs list, `/run/:id` run view
 * (deep-linkable, `#needs-input` focuses the reply). Live via SSE. Served pre-bundled
 * as /app.js (bun build web/app/main.tsx — see web/server.ts startup).
 */
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunDetail, RunSummary, RunStatus } from "../derive";
import type { CoalescedTurn } from "../../log/coalesce";

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
      <div className="who">{turn.node}@{turn.visit} · turn {turn.turn}{turn.finalized ? "" : " · interrupted"}</div>
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
  const [detail, setDetail] = useState<RunDetail | null>(null);
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
        </div>
        {summary.status === "needs-input" && summary.waiting_since && (
          <div className="banner">
            Waiting on you — {summary.needs_input_reason}
            <span className="timer">{fmtWait(summary.waiting_since, now)}</span>
          </div>
        )}
        {resolvedTurns.map((t) => (
          <Turn key={`${t.node}@${t.visit}#${t.turn}`} turn={t} render={renderByTurnKey.get(`${t.node}@${t.visit}`)} />
        ))}
        {ask && <AskCard runId={id} ask={ask} onResolved={reload} />}
        {!ask && summary.status === "done" && <div className="operator-row">run complete</div>}
      </div>

      <div className="rail">
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
  return (
    <div className="shell">
      <nav className="sidebar">
        <Mark className="mark" />
        <a className={`nav ${!runMatch ? "active" : ""}`} href="/"><span className="label">Runs</span></a>
        <div className="spacer" />
        <button className="theme-toggle" onClick={() => setTheme(theme === "dark" ? "light" : theme === "light" ? "system" : "dark")}>
          theme: {theme}
        </button>
      </nav>
      <main>{runMatch ? <RunView id={runMatch[1]!} /> : <div className="runs"><RunsList /></div>}</main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
