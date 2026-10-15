/**
 * The run screen: the thread column, its banners, the controls and the inspector rail.
 * Out of main.tsx (HOW-16 P1), which keeps only the shell and the router.
 *
 * Three HOW-16 fixes land here rather than in a primitive:
 *  - Abort was a button that RELABELLED itself to "Really abort?" and aborted on the second
 *    click. A confirmation that lives in the same pixel as the thing it confirms is not a
 *    confirmation — a double-click hits it. It is an AlertDialog now: focus-trapped, Esc
 *    cancels, and Cancel holds focus so Enter is never the destructive answer.
 *  - Every write (resume, pause, abort, jump, open-in-IDE, copy) reports through a toast, so
 *    an outcome is ANNOUNCED rather than inferred from a button that stopped spinning.
 *  - The native `title=` tooltips on the rail's truncated paths are Tooltips, and every
 *    icon-only control carries an aria-label (P2.11).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Rows3, Workflow, Play, Pause, OctagonX, RotateCcw, ExternalLink, GitBranch, GitPullRequest,
  Clock, Coins, Pin, Fingerprint, MessagesSquare, CornerDownRight, X, ScrollText, Loader2,
  FolderOpen, Copy, GitFork, Activity, Hand, ChevronDown,
} from "lucide-react";
import type { RunDetail } from "../../derive";
import { applyLiveEvent, type CoalescedTurn } from "../../../log/coalesce";
import type { LoggedEvent } from "../../../log/events";
import { GraphDag, useGraphShape } from "../graph-dag";
import { StatusBadge, askRowKey } from "../status";
import { getJSON } from "@/lib/net";
import { fmtDur, fmtWait, liveDuration, runLabel } from "@/lib/format";
import { useAttentionSurfaces, useNow } from "@/lib/hooks";
import { usePanel } from "@/lib/panel";
import { submitOnEnter } from "@/lib/keys";
import { PanelResizer, PanelToggle } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import { AlertDialog } from "@/components/ui/dialog";
import { LoadingBlock } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ScrollShell } from "@/components/scroll-shell";
import { PromptAndContext } from "./prompt-context";
import { RunSteps, StepDetail, StepsSplit } from "./steps";
import { RunLogs } from "./logs";
import { RunContext } from "./context";
import { RunChat } from "./chat";
import { UsageRows } from "./usage";
import { ProgressPanel, liveStep, steerableTurn } from "./progress";
import { AcceptanceCard } from "./acceptance";
import { SOFT_STOP_ESCALATE_MS } from "../../../core/steer";
import type { LiveGit } from "../../live-git";

type RunTab = "steps" | "context" | "logs" | "chat" | "graph";
type DetailDto = RunDetail & { cwd_exists?: boolean; editor_configured?: boolean; soft_stop_escalate_ms?: number };

/**
 * Pause / resume / abort. Abort is the one irreversible verb in this app, so it is the one
 * that asks — through an AlertDialog rather than by relabelling itself in place.
 *
 * HOW-48: while an agent turn is live on a steerable harness, the PRIMARY action is "Stop at
 * next tool call" — the soft pause, which lets the agent finish its thought, leave the work
 * consistent and say where it is. The old Pause (SIGTERM, wherever the agent happens to be)
 * becomes "Stop now" in a menu, with a line saying how the two differ. A soft stop that has not
 * taken effect after `escalateMs` (the agent may be inside one long tool call) offers Stop now.
 */
export function RunControls({ runId, summary, onAction, softStoppable = false, softStop = null, escalateMs = SOFT_STOP_ESCALATE_MS, now = Date.now() }: {
  runId: string;
  summary: RunDetail["summary"];
  onAction: () => void;
  /** a live turn on a harness with a steer channel (progress.tsx steerableTurn) */
  softStoppable?: boolean;
  softStop?: RunDetail["soft_stop"];
  escalateMs?: number;
  now?: number;
}) {
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const act = async (verb: string) => {
    setPending(verb);
    setError(null);
    setMenuOpen(false);
    try {
      const r = await fetch(`/api/runs/${runId}/${verb}`, { method: "POST" });
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as any)?.error ?? `${verb} failed`);
      toast(verb === "soft-stop" ? "stop sent — the agent stops at its next tool call" : `${verb} accepted — the runner is acting on it`);
      setTimeout(onAction, 300);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      // the inline error stays: a toast that has faded cannot be re-read (see toast.tsx)
      setError(why);
      toast(why, "error");
    } finally {
      setPending(null);
    }
  };
  const resumable = summary.paused || ["harness-dead", "waiting", "failed-recoverable", "queued"].includes(summary.status);
  const active = ["running", "needs-input", "waiting", "failed-recoverable", "queued", "harness-dead"].includes(summary.status);
  if (!active) return null;
  const busy = pending !== null;
  const soft = summary.status === "running" && softStoppable;
  const stopping = softStop && (softStop.state === "requested" || softStop.state === "delivered");
  const overdue = stopping && now - new Date(softStop.requested_at).getTime() >= escalateMs;
  return (
    <span className="run-controls">
      {resumable ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => act("resume")}>{pending === "resume" ? <Loader2 className="animate-spin" /> : <Play />}{pending === "resume" ? "Resuming…" : "Resume"}</Button>
      ) : soft ? (
        <>
          <Button variant="outline" size="sm" className="run-soft-stop" disabled={busy || !!stopping} onClick={() => act("soft-stop")}>
            {pending === "soft-stop" || stopping ? <Loader2 className="animate-spin" /> : <Hand />}
            {stopping ? (softStop!.state === "delivered" ? "Agent is stopping…" : "Stopping at next tool call…") : "Stop at next tool call"}
          </Button>
          <span className="run-menu-wrap" onKeyDown={(e) => { if (e.key === "Escape") setMenuOpen(false); }}>
            <Button variant="outline" size="sm" aria-label="more ways to stop" aria-expanded={menuOpen} aria-haspopup="menu" disabled={busy} onClick={() => setMenuOpen((o) => !o)}>
              <ChevronDown />
            </Button>
            {menuOpen && (
              <div className="run-menu" role="menu" aria-label="stop options">
                <Button variant="ghost" size="sm" role="menuitem" className="run-menu-item" onClick={() => act("pause")}>
                  <Pause />Stop now
                </Button>
                <p className="run-menu-note">
                  Stop now interrupts the agent wherever it is — mid-edit or mid-sentence — and the
                  step starts again from scratch on resume. Stop at next tool call lets it finish its
                  thought, leave the work consistent and say where it is.
                </p>
              </div>
            )}
          </span>
        </>
      ) : (
        summary.status === "running" && <Button variant="outline" size="sm" disabled={busy} onClick={() => act("pause")}>{pending === "pause" ? <Loader2 className="animate-spin" /> : <Pause />}{pending === "pause" ? "Pausing…" : "Pause"}</Button>
      )}
      <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirmAbort(true)}>{pending === "abort" ? <Loader2 className="animate-spin" /> : <OctagonX />}{pending === "abort" ? "Aborting…" : "Abort"}</Button>
      {overdue && (
        <span className="run-escalate" role="status">
          not stopped after {fmtDur(now - new Date(softStop!.requested_at).getTime())} — it may be in one long tool call.
          <Button variant="destructive-outline" size="sm" disabled={busy} onClick={() => act("pause")}><Pause />Stop now</Button>
        </span>
      )}
      {/* The dialog closes BEFORE the verb is sent, the way every other confirmation in this
          app does (slice.tsx, settings.tsx). A modal dialog makes the rest of the document
          inert and covers it with its ::backdrop, and both explanations of a refusal — the
          inline field-error below and the toast region — render outside it. Leaving it open
          across a failed abort would hide the only two places that say why. */}
      <AlertDialog
        open={confirmAbort}
        onClose={() => setConfirmAbort(false)}
        onConfirm={() => { setConfirmAbort(false); act("abort"); }}
        title="Abort this run?"
        description={<>The runner is interrupted mid-turn and the run stops at <strong>{summary.graph}</strong>. Work already committed in its worktree is untouched, but the run cannot be un-aborted — you would start a new one.</>}
        confirmLabel="Abort the run"
      />
      {error && <span className="field-error">{error}</span>}
    </span>
  );
}

/**
 * HOW-55: what the newest agent ran WITH, beyond the prompt its hash proves — which of the
 * operator's settings loaded, the hooks that ran before it started (and how much text they
 * injected), and how many skills, plugins and MCP servers it had. A run from before HOW-55 says
 * "not recorded" rather than guessing.
 */
export function AgentEnvironment({ env }: { env: RunDetail["agent_env"] }) {
  if (!env) return <div className="kv"><span className="k">agent environment</span><span>not recorded</span></div>;
  const injected = (env.hooks ?? []).filter((h) => h.injected);
  const files = env.files.filter((f) => f.sha256 !== null);
  return (
    <>
      <div className="kv">
        <span className="k">agent environment</span>
        <Tooltip content={env.setting_sources ? `--setting-sources ${env.setting_sources}` : `${env.harness} has no switch for the operator's own config; what it read is hashed`}>
          <span>{env.harness} · {env.setting_sources === null ? "its own config" : env.inherits_user ? "your user settings + project" : "project settings only"}</span>
        </Tooltip>
      </div>
      {env.hooks && env.hooks.length > 0 && (
        <div className="kv">
          <span className="k">hooks ran</span>
          <Tooltip content={injected.map((h) => `${h.name}: ${h.injected!.chars} chars, sha256 ${h.injected!.sha256.slice(0, 12)}`).join("\n") || "none injected context"}>
            <span className={injected.length ? "allowance-unreachable" : ""}>{env.hooks.length}{injected.length ? ` · ${injected.length} injected context` : ""}</span>
          </Tooltip>
        </div>
      )}
      {env.skills && (
        <div className="kv"><span className="k">loaded</span><span>{env.skills.length} skills · {env.plugins?.length ?? 0} plugins · {env.mcp_servers?.length ?? 0} MCP</span></div>
      )}
      <div className="kv">
        <span className="k">settings files</span>
        <Tooltip content={env.files.map((f) => `${f.scope} ${f.path}${f.sha256 ? ` ${f.sha256.slice(0, 12)}` : " (absent)"}`).join("\n")}>
          <span>{files.length} hashed</span>
        </Tooltip>
      </div>
    </>
  );
}

export function RunGraph({ runId, graph, timeline, status, onJumped }: { runId: string; graph: string; timeline: RunDetail["timeline"]; status: string; onJumped: () => void }) {
  const shape = useGraphShape(graph);
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "jumping" | "sent" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  if (!shape) return <LoadingBlock label={`Loading the ${graph} graph`} rows={3} />;
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
      toast(`jumping to ${jumpTo}`);
      setTimeout(onJumped, 300);
      setTimeout(() => {
        setJumpTo(null);
        setMessage("");
        setState("idle");
      }, 1400);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setError(why);
      setState("failed");
      toast(why, "error");
    }
  };

  return (
    <div className="run-graph">
      {jumpTo && (
        <div className="ask-card jump-card">
          <h3>Jump to {jumpTo}</h3>
          <div className="field-hint">Starts a fresh attempt at this node using the current context. Your instruction is injected into its prompt and takes precedence.</div>
          <Textarea autoFocus aria-label={`instructions for ${jumpTo}`} value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={submitOnEnter(() => void jump(), { enabled: state !== "jumping" && state !== "sent" })} placeholder="Instructions for this step (optional)…" />
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
      {jumpable && !jumpTo && <div className="field-hint run-graph-hint">Click a non-terminal node to jump the run there with instructions.</div>}
      {!jumpable && status === "running" && <div className="field-hint run-graph-hint">Pause the run to enable jumping.</div>}
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

export function OpenIdeButton({ runId, detail }: { runId: string; detail: DetailDto }) {
  const { toast } = useToast();
  // design rules: hidden for Plain runs without a folder; disabled+tooltip for cleaned
  // worktrees; unconfigured routes to Settings
  if (!detail.identity.cwd) return null;
  if (!detail.editor_configured)
    return (
      <Tooltip content="No editor configured — opens Settings">
        <a href="/settings"><Button variant="outline" size="sm"><ExternalLink />Open in IDE…</Button></a>
      </Tooltip>
    );
  if (!detail.cwd_exists)
    return (
      <Tooltip content="Folder is gone — the worktree was cleaned">
        <Button variant="outline" size="sm" disabled><ExternalLink />Open in IDE</Button>
      </Tooltip>
    );
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        const r = await fetch(`/api/runs/${runId}/open-ide`, { method: "POST" }).catch(() => null);
        toast(r?.ok ? "opening the run's folder in your editor" : "could not open the editor", r?.ok ? "default" : "error");
      }}
    >
      <ExternalLink />Open in IDE
    </Button>
  );
}

export function RunFolderButton({ runId }: { runId: string }) {
  const { toast } = useToast();
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        const r = await fetch(`/api/runs/${runId}/open-run-folder`, { method: "POST" }).catch(() => null);
        toast(r?.ok ? "opening the run folder" : "could not open the run folder", r?.ok ? "default" : "error");
      }}
    >
      <FolderOpen />Open run folder
    </Button>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();
  return (
    <Button variant="outline" size="sm" onClick={async () => {
      await navigator.clipboard?.writeText(text).catch(() => {});
      setCopied(true);
      toast("copied to the clipboard");
      setTimeout(() => setCopied(false), 1200);
    }}>
      <Copy />{copied ? "Copied" : label}
    </Button>
  );
}

/** A rail value that is a truncated path: the full one is a Tooltip, never a native title. */
function PathValue({ full, shown }: { full: string; shown?: string }) {
  return <Tooltip content={full}><span className="path">{shown ?? full}</span></Tooltip>;
}

export const OPEN_GRACE_MS = 10_000;
const OPEN_POLL_MS = 300;
/**
 * The gap between one shell refetch finishing and the next one starting when structural
 * events kept arriving. Streaming chunks are NOT a refetch: the page folds them into the
 * open turn itself. Refetching the whole view per chunk was a blank page — the server
 * re-derived a 15 MB log and the browser parsed it, continuously.
 */
const RELOAD_GAP_MS = 750;
/** How many turns the chat loads at once. Older ones arrive through "Load earlier". */
const TRANSCRIPT_WINDOW = 40;

type TranscriptPage = { turns: CoalescedTurn[]; total: number; start: number; last_seq: number };

function mergeTurns(base: CoalescedTurn[], extra: CoalescedTurn[]): CoalescedTurn[] {
  if (extra.length === 0) return base;
  const seen = new Set(base.map((t) => `${t.node}\0${t.visit}\0${t.turn}`));
  const out = base.slice();
  for (const t of extra) {
    const k = `${t.node}\0${t.visit}\0${t.turn}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** The step the Steps pane is showing: the one the operator picked, else the one that needs them, else the newest. */
function selectedStepKey(detail: DetailDto, picked: string | null): string | null {
  const askKey = askRowKey(detail.timeline, detail.ask);
  const waiting = askKey ? detail.timeline.find((t) => `${t.node}@${t.visit}` === askKey) : undefined;
  const row = waiting ?? detail.timeline.at(-1);
  return picked ?? (row ? `${row.node}@${row.visit}` : null);
}

/** `graceMs` is a seam for the component test (web/app/runview.test.tsx); nothing else sets it. */
export function RunView({ id, graceMs = OPEN_GRACE_MS }: { id: string; graceMs?: number }) {
  const [detail, setDetail] = useState<DetailDto | null>(null);
  // HOW-25: Chat leads. The thing that needs interacting with — the agent's question — lives
  // in the conversation, and the ticket was filed because it had nowhere to be seen.
  const [tab, setTab] = useState<RunTab>("chat");
  const [picked, setPicked] = useState<string | null>(null);
  const [liveGit, setLiveGit] = useState<LiveGit | null>(null);
  const [bannerAction, setBannerAction] = useState<"resume" | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  /** index of the first loaded turn; above 0, the chat offers the previous window */
  const [transcriptStart, setTranscriptStart] = useState(0);
  // the inspector rail: collapsible and drag-resizable, remembered per operator. Declared
  // with the other state because the early `!detail` return below is after every hook.
  const rail = usePanel({ key: "howdah.rail", min: 260, def: 344, minOther: 520, side: "right" });
  const now = useNow();
  const { toast } = useToast();
  // a 404 here is normal for a moment: launching spawns the CLI detached and answers 202
  // before the run dir exists (web/server.ts POST /api/runs), so the viewer arrives ahead of
  // run.jsonl. Leaving `detail` null keeps the loading state this component already renders;
  // the poll below is what brings it back. Any other failure also leaves the last good view
  // in place rather than replacing it with an error body.
  // the transcript is loaded once and then extended. A shell refetch must not replace it:
  // the shell document deliberately carries no turns.
  const turnsRef = useRef<CoalescedTurn[] | null>(null);
  const windowRef = useRef({ start: 0, total: 0 });
  const triedSteps = useRef(new Set<string>());
  const gen = useRef(0);
  const fetchDetail = useCallback(async () => {
    const mine = gen.current;
    try {
      // shell and transcript are two reads of a growing file. The turns and the seq the
      // stream resumes from have to be the SAME snapshot, or a chunk already in the window
      // is appended again when the stream replays it. The transcript names that seq; if the
      // shell was read earlier, it is read once more so a step that finished in between is
      // on the page, and the stream still resumes where the turns left off.
      let shell = await getJSON<DetailDto>(`/api/runs/${id}/shell`);
      if (mine !== gen.current) return;
      if (turnsRef.current === null) {
        let page: TranscriptPage | null = null;
        try {
          const t = await getJSON<TranscriptPage>(`/api/runs/${id}/transcript?limit=${TRANSCRIPT_WINDOW}`);
          if (t && Array.isArray(t.turns) && typeof t.last_seq === "number") page = t;
        } catch { /* the shell's own turns still draw; a short fixture has them */ }
        if (mine !== gen.current) return;
        if (page && shell.events_seq < page.last_seq) {
          try {
            const again = await getJSON<DetailDto>(`/api/runs/${id}/shell`);
            if (mine !== gen.current) return;
            shell = again;
          } catch { /* the first shell still draws; the stream covers what it missed */ }
        }
        if (page) {
          turnsRef.current = page.turns;
          windowRef.current = { start: page.start, total: page.total };
          shell = { ...shell, events_seq: page.last_seq };
        } else {
          turnsRef.current = shell.turns;
          windowRef.current = { start: 0, total: shell.turns.length };
        }
        setTranscriptStart(windowRef.current.start);
      }
      setDetail({ ...shell, turns: turnsRef.current ?? shell.turns });
      setMissing(false);
    } catch { /* a 404 while the run dir is still being created: leave the loading state */ }
  }, [id]);
  // one fetch in flight at a time; a request that arrives during it marks the view dirty and
  // is served by ONE follow-up fetch after RELOAD_GAP_MS, however many arrived
  const inflight = useRef<Promise<void> | null>(null);
  const dirty = useRef(false);
  const reload = useCallback((): Promise<void> => {
    if (inflight.current) { dirty.current = true; return inflight.current; }
    const loop = async (): Promise<void> => {
      do {
        dirty.current = false;
        await fetchDetail();
        if (dirty.current) await new Promise((r) => setTimeout(r, RELOAD_GAP_MS));
      } while (dirty.current);
      inflight.current = null;
    };
    inflight.current = loop();
    return inflight.current;
  }, [fetchDetail]);
  const runAction = useCallback(async (verb: "resume") => {
    setBannerAction(verb);
    setBannerError(null);
    try {
      const r = await fetch(`/api/runs/${id}/${verb}`, { method: "POST" });
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as any)?.error ?? `${verb} failed`);
      toast("resume accepted — the runner is picking the run back up");
      setTimeout(reload, 300);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setBannerError(why);
      toast(why, "error");
    } finally {
      setBannerAction(null);
    }
  }, [id, reload, toast]);
  const loadEarlier = useCallback(async () => {
    const before = windowRef.current.start;
    if (before <= 0) return;
    const mine = gen.current;
    try {
      const t = await getJSON<TranscriptPage>(`/api/runs/${id}/transcript?limit=${TRANSCRIPT_WINDOW}&before=${before}`);
      if (mine !== gen.current || !t || !Array.isArray(t.turns) || t.turns.length === 0) return;
      const have = new Set((turnsRef.current ?? []).map((turn) => `${turn.node}\0${turn.visit}\0${turn.turn}`));
      const older = t.turns.filter((turn) => !have.has(`${turn.node}\0${turn.visit}\0${turn.turn}`));
      const next = [...older, ...(turnsRef.current ?? [])];
      turnsRef.current = next;
      windowRef.current = { start: t.start, total: t.total };
      setTranscriptStart(t.start);
      setDetail((d) => d ? { ...d, turns: next } : d);
    } catch { /* the window already on screen stays */ }
  }, [id]);
  // a different run is a different log. Drop the previous transcript before the next fetch,
  // or the new page would keep drawing the previous run's turns.
  useEffect(() => {
    gen.current += 1;
    turnsRef.current = null;
    windowRef.current = { start: 0, total: 0 };
    triedSteps.current.clear();
    setTranscriptStart(0);
    setDetail(null);
    setMissing(false);
  }, [id]);
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
    es.onmessage = (msg) => {
      let event: LoggedEvent;
      try { event = JSON.parse(String((msg as MessageEvent).data)) as LoggedEvent; } catch { return; }
      // a streaming chunk joins the open turn here. Reloading the shell per chunk is what
      // blanked the page: one text delta used to re-derive and re-download the whole run.
      if (event.type === "chunk" || event.type === "turn-finalized") {
        const turns = applyLiveEvent(turnsRef.current ?? [], event);
        turnsRef.current = turns;
        setDetail((d) => d ? {
          ...d,
          turns,
          events_seq: event.seq,
          last_agent_event_at: event.ts,
          summary: { ...d.summary, last_event_at: event.ts },
        } : d);
        if (event.type === "chunk") return;
      }
      reload();
    };
    // HOW-49: the live worktree probe arrives as its own named event — never a log event
    es.addEventListener("git-live", (m) => {
      try { setLiveGit(JSON.parse((m as MessageEvent).data) as LiveGit); } catch { /* a torn frame: the next probe replaces it */ }
    });
    return () => es.close();
    // subscribe once per run; a chunk updates the open turn, anything else refetches the shell
  }, [id, detail === null]); // eslint-disable-line react-hooks/exhaustive-deps
  // a step the window does not cover (an earlier visit, opened from the Steps list) is fetched
  // once. Chunks for the step in view arrive on the stream, so this is only for history.
  // Keyed on the step, not on `detail`: a chunk replaces detail and must not cancel the fetch.
  const stepKey = detail && tab === "steps" ? selectedStepKey(detail, picked) : null;
  useEffect(() => {
    if (!stepKey) return;
    if (triedSteps.current.has(stepKey)) return;
    const at = stepKey.lastIndexOf("@");
    const node = stepKey.slice(0, at);
    const visit = Number(stepKey.slice(at + 1));
    if (!node || !Number.isFinite(visit)) return;
    if ((turnsRef.current ?? []).some((t) => t.node === node && t.visit === visit)) return;
    triedSteps.current.add(stepKey);
    const mine = gen.current;
    let stop = false;
    getJSON<TranscriptPage>(`/api/runs/${id}/transcript?node=${encodeURIComponent(node)}&visit=${visit}`)
      .then((t) => {
        // a cleanup means the operator moved on; forget the attempt so coming back fetches it
        if (stop || mine !== gen.current) { triedSteps.current.delete(stepKey); return; }
        if (!t || !Array.isArray(t.turns) || t.turns.length === 0) return;
        const merged = mergeTurns(turnsRef.current ?? [], t.turns);
        turnsRef.current = merged;
        setDetail((d) => d ? { ...d, turns: merged } : d);
      })
      .catch(() => { triedSteps.current.delete(stepKey); });
    return () => { stop = true; };
  }, [stepKey, id]);
  useAttentionSurfaces(detail?.summary.status === "needs-input");


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
  if (!detail) return <LoadingBlock label={`Loading run ${id}`} />;
  const { summary, ask } = detail;
  const effectiveTimeline = detail.timeline.map((t) => ({ row: t, duration: liveDuration(t, now) }));
  const maxDur = Math.max(1, ...effectiveTimeline.map((t) => t.duration));
  const lastEventAgeMs = summary.last_event_at ? now - new Date(summary.last_event_at).getTime() : 0;
  const staleRunning = summary.status === "running" && lastEventAgeMs > 5 * 60_000;
  // the step that needs a human wins the selection; otherwise the newest one
  const selectedKey = selectedStepKey(detail, picked);
  // the chat shows the loaded window. Steps above it stay on the Steps list; "Load earlier"
  // brings the next window in, and the newest step stays even before it has spoken.
  const chatDetail = transcriptStart <= 0 ? detail : (() => {
    const loaded = new Set(detail.turns.map((t) => `${t.node}@${t.visit}`));
    const first = detail.timeline.findIndex((r) => loaded.has(`${r.node}@${r.visit}`));
    return first <= 0 ? detail : { ...detail, timeline: detail.timeline.slice(first) };
  })();
  const selectedRow = detail.timeline.find((t) => `${t.node}@${t.visit}` === selectedKey) ?? null;

  return (
    <div
      className="runview"
      ref={rail.boxRef}
      data-pane={rail.collapsed ? "closed" : "open"}
      style={{ ["--rail-w" as string]: `${rail.width}px` }}
    >
      <div className="thread-col">
        <div className="topbar">
          <a className="topbar-back" href="/" aria-label="back to runs">←</a>
          <h1>{runLabel({ ...summary, id })}</h1>
          <StatusBadge status={summary.status} />
          <span className="meta">{summary.graph}</span>
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as RunTab)}
            items={[
              { value: "chat", label: "Chat", icon: <MessagesSquare /> },
              { value: "steps", label: "Steps", icon: <Rows3 /> },
              { value: "context", label: "Context", icon: <Fingerprint /> },
              { value: "logs", label: "Logs", icon: <ScrollText /> },
              { value: "graph", label: "Graph", icon: <Workflow /> },
            ]}
          />
          <RunControls
            runId={id} summary={summary} onAction={reload} now={now}
            softStoppable={steerableTurn(detail) !== null} softStop={detail.soft_stop}
            escalateMs={detail.soft_stop_escalate_ms ?? SOFT_STOP_ESCALATE_MS}
          />
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
        {tab === "context" ? (
          <RunContext entries={detail.context} />
        ) : tab === "chat" ? (
          <RunChat runId={id} detail={chatDetail} ask={ask} liveGit={liveGit} onResolved={reload} onPickStep={(k) => { setPicked(k); setTab("steps"); }} earlier={transcriptStart > 0} onEarlier={loadEarlier} />
        ) : tab === "logs" ? (
          <RunLogs runId={id} />
        ) : tab === "graph" ? (
          <RunGraph runId={id} graph={summary.graph} timeline={detail.timeline} status={summary.status} onJumped={reload} />
        ) : (
          <StepsSplit
            list={<RunSteps timeline={detail.timeline} ask={ask} selected={selectedKey} now={now} onSelect={setPicked} mapping={detail.slice?.mapping} />}
            detail={<StepDetail runId={id} row={selectedRow} detail={detail} ask={ask} now={now} onResolved={reload} />}
          />
        )}
      </div>

      <PanelResizer panel={rail} label="the inspector rail">
        <div className="pane-controls">
          <PanelToggle panel={rail} label="the inspector" side="right" />
        </div>
      </PanelResizer>

      <div className="rail" aria-label="Run inspector">
        {liveStep(detail) && (
          <section>
            <h2><Activity size={12} /> Progress</h2>
            <ProgressPanel detail={detail} liveGit={liveGit} variant="rail" runId={id} />
          </section>
        )}
        {/* HOW-51: the contract while the run is still being judged; once finished it leads Chat */}
        {detail.acceptance && detail.summary.outcome === null && detail.ask?.code !== "acceptance-unmet" && (
          <section>
            <AcceptanceCard runId={id} detail={detail} onChanged={reload} />
          </section>
        )}
        <section>
          <h2><Fingerprint size={12} /> Identity</h2>
          <div className="kv"><span className="k">run</span><span>{id}</span></div>
          {summary.name && <div className="kv"><span className="k">name</span><span>{summary.name}</span></div>}
          <div className="kv"><span className="k">graph</span><span>{summary.graph}</span></div>
          {detail.persistence && <div className="kv"><span className="k">home</span><PathValue full={detail.persistence.home} /></div>}
          {detail.identity.cwd && <div className="kv"><span className="k">{detail.identity.folder_kind === "repo" ? "repo" : "folder"}</span><PathValue full={detail.identity.cwd} shown={detail.identity.cwd.split("/").slice(-2).join("/")} /></div>}
          {detail.git?.intended?.branch && <div className="kv"><span className="k">branch</span><span>{detail.git.intended.branch}</span></div>}
          {/* HOW-23: a child of a fan-out says which run planned it. A link, not a status —
              the parent's own log is the only thing that knows how the parent is doing. */}
          {summary.parent && <div className="kv"><span className="k">planned by</span><a href={`/run/${summary.parent}`} className="pr-link">{summary.parent}</a></div>}
          <AgentEnvironment env={detail.agent_env} />
        </section>
        {detail.persistence && (
          <section>
            <h2><FolderOpen size={12} /> Persistence</h2>
            <div className="kv"><span className="k">run dir</span><PathValue full={detail.persistence.run_dir} /></div>
            <div className="kv"><span className="k">log</span><PathValue full={detail.persistence.log_path} shown={detail.persistence.log_path.split("/").slice(-3).join("/")} /></div>
            {detail.persistence.worktree_path && <div className="kv"><span className="k">worktree</span><PathValue full={detail.persistence.worktree_path} shown={detail.persistence.worktree_path.split("/").slice(-3).join("/")} /></div>}
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
        {/* HOW-23: the fan-out. One row per child run, with the slice and ticket it came from.
            No status per child: this run's log records that it launched them and nothing more,
            and a status invented here would be a live-looking lie. Follow the link instead. */}
        {detail.children.length > 0 && (
          <section>
            <h2><GitFork size={12} /> Launched runs</h2>
            {detail.children.map((c) => (
              <div key={c.run_id} className="kv">
                <span className="k">{c.ticket ?? c.slice_id}</span>
                <a href={`/run/${c.run_id}`} className="pr-link">{c.run_id}</a>
              </div>
            ))}
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
            // --status-color is computed from this row's own status, and the bar's width from
            // its own timing: a custom property fed by data is the inline style P3.13 keeps
            <div key={i} className="tl-row" style={{ ["--status-color" as any]: `var(--status-${t.status === "succeeded" ? "done" : t.status === "failed" ? "failed-recoverable" : "running"})` }}>
              <span className="tl-node">{t.node}@{t.visit}</span>
              <span className="tl-bar-track"><span className="tl-bar" style={{ width: `${Math.max(4, (duration / maxDur) * 100)}%` }} /></span>
              <span className="tl-dur">{fmtDur(duration)}</span>
            </div>
          ))}
        </section>
        <section>
          <h2><Coins size={12} /> Usage</h2>
          <UsageRows usage={detail.usage} />
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
