/**
 * The run screen: its frame — header, tabs, body — and the Details drawer.
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
 *
 * HOW-68 rebuilt the frame, because the frame was the bug in the operator's screenshot ("I
 * can't read any of the text in the middle"): header, banner, pane head, suggestion cards and
 * composer were all fixed, the 344px inspector never stood down, and at 1024px the column
 * that was left hid its overflow. DESIGN.md Layout is the contract now:
 *
 *   A RUN IS header · tabs · body. The header is ONE row at every supported width: back, the
 *   name (the part that gives, through `Truncate`), one line of status, the action the run is
 *   waiting for, and everything else behind one More menu. The tabs are one underline strip
 *   with their number keys. The body is the pane, and the pane owns its one scroller.
 *   THE ALARM IS SAID ONCE. The amber banner that repeated the ask above the transcript is
 *   gone; the header's status line ("Waiting on you · 2h 53m") is a control that takes you to
 *   the card. The red and neutral notices that remain are one line each and carry no button —
 *   the header's primary action IS the Resume/Retry they used to duplicate.
 *   DETAILS IS A DRAWER (`components/ui/drawer`): closed by default below 1280px, ⌘I toggles,
 *   Esc closes, remembered. Its values wrap instead of being cut, labels are sans, ids and
 *   paths are mono with a copy button. The resizer lane and its 17px toggle are gone.
 *   KEYS: 1–7 tabs, ⌘I details, R reply, A the ask, O open in IDE, `.` More — all rows in
 *   `lib/shortcuts.ts`, so `?` lists them (E and / are registered by the Build pane).
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Play, Pause, OctagonX, RotateCcw, ExternalLink, CornerDownRight, X, FolderOpen, Copy, Hand,
  ArrowLeft, Ellipsis, PanelRight,
  RotateCw, ChevronRight, GitPullRequest, Maximize2, Minimize2,
} from "lucide-react";
import type { RunDetail } from "../../derive";
import { applyLiveEvent, type CoalescedTurn } from "../../../log/coalesce";
import type { LoggedEvent } from "../../../log/events";
import { GraphDag, takenKey, useGraphShape, type StepRunInfo } from "../graph-dag";
import { StatusBadge, StatusGlyph, askRowKey, resolveStepKey, stepInterrupted, stepKey } from "../status";
import { Row } from "@/components/ui/row";
import { getJSON, HttpError } from "@/lib/net";
import { fmtClock, fmtDur, fmtWait, liveDuration, runLabel } from "@/lib/format";
import { useAttentionSurfaces, useNow } from "@/lib/hooks";
import { submitOnEnter } from "@/lib/keys";
import { useEscapeLayer, useShortcuts } from "@/lib/shortcuts";
import { RUN_STATUS_ID, focusRunStatus, useDocumentTitle } from "@/lib/page";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import { AlertDialog } from "@/components/ui/dialog";
import { LoadingBlock } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { Menu, type MenuEntry } from "@/components/ui/menu";
import { Drawer, useDrawer } from "@/components/ui/drawer";
import { KeyValue, type KeyValueItem } from "@/components/ui/key-value";
import { Kbd } from "@/components/ui/kbd";
import { ScrollPane } from "@/components/ui/scroll-pane";
import { SectionLabel } from "@/components/ui/section-label";
import { Toolbar } from "@/components/ui/toolbar";
import { Truncate } from "@/components/ui/truncate";
import { RunSteps, StepDetail, StepsSplit } from "./steps";
import { RunLogs } from "./logs";
import { RunContext } from "./context";
import { RunChat } from "./chat";
import { usageItems } from "./usage";
import { ProgressPanel, liveStep, steerableTurn } from "./progress";
import { AcceptanceCard } from "./acceptance";
import { RunPlan } from "./plan";
import { RunReport } from "./report";
import { SOFT_STOP_ESCALATE_MS } from "../../../core/steer";
import type { LiveGit } from "../../live-git";

/** sessionStorage: focus is for this sitting, not a preference about the machine */
const FOCUS_KEY = "howdah.run.focus";

/** HOW-78: Plan → Build ("chat", the transcript) → Report lead; the rest are the instruments */
type RunTab = "plan" | "chat" | "report" | "steps" | "context" | "logs" | "graph";
/** in strip order: the number keys 1–7 are this list's indices */
const TABS: ReadonlyArray<{ value: RunTab; label: string }> = [
  { value: "plan", label: "Plan" },
  { value: "chat", label: "Build" },
  { value: "report", label: "Report" },
  { value: "steps", label: "Steps" },
  { value: "context", label: "Context" },
  { value: "logs", label: "Logs" },
  { value: "graph", label: "Graph" },
];
/** a PR opens in the operator's browser, in a new tab — never inside the viewer */
const EXTERNAL = { target: "_blank", rel: "noopener noreferrer" } as const;
const PR_LINK = `${buttonVariants({ variant: "ghost", size: "sm" })} shrink-0 font-normal text-foreground`;
/** links that read as buttons: going back to Runs is navigation, so each is an `<a>` */
const BACK_LINK = `${buttonVariants({ variant: "ghost", size: "icon-sm" })} shrink-0`;
const PRIMARY_LINK = buttonVariants({ variant: "default" });

/**
 * HOW-68 confirming review: the panes that do NOT read the clock. `RunFrame` re-renders once a
 * second (`now` drives the header's wait and the step durations), and it used to take the whole
 * open pane with it: on a 600-item transcript that was a 250–390ms main-thread task EVERY second
 * with nothing on screen changing — measured on a finished run, sitting idle — so scrolling and
 * typing hitched once a second for as long as the tab was open. Memoised, a pane renders when its
 * own props change: a new `detail` (a reload or a stream event), not a tick. Everything passed to
 * them from the frame is therefore kept referentially stable (`chatDetail` below, `reload`,
 * `showStep`, `loadEarlier`). The pieces that DO count time keep their own clock (`LiveNote`,
 * the ask card).
 */
export const TranscriptPane = memo(RunChat);
const PlanPane = memo(RunPlan);
const ReportPane = memo(RunReport);
const ContextPane = memo(RunContext);
const LogsPane = memo(RunLogs);
type DetailDto = RunDetail & { cwd_exists?: boolean; editor_configured?: boolean; soft_stop_escalate_ms?: number };

/** a soft stop that has not taken effect within the escalation window (HOW-48), and for how long */
export function softStopOverdue(softStop: RunDetail["soft_stop"], now: number, escalateMs: number): number | null {
  if (!softStop || (softStop.state !== "requested" && softStop.state !== "delivered")) return null;
  const waited = now - new Date(softStop.requested_at).getTime();
  return waited >= escalateMs ? waited : null;
}

const STOP_NOTE =
  "Stop now interrupts the agent wherever it is — mid-edit or mid-sentence — and the step starts again from scratch on resume. Stop at next tool call lets it finish its thought, leave the work consistent and say where it is.";

/**
 * The run's actions: the ONE the run is waiting for, visible, and the rest behind More.
 * Abort is the one irreversible verb in this app, so it is the one that asks — through an
 * AlertDialog rather than by relabelling itself in place.
 *
 * HOW-48: while an agent turn is live on a steerable harness, the PRIMARY action is "Stop at
 * next tool call" — the soft pause, which lets the agent finish its thought, leave the work
 * consistent and say where it is. The old Pause (SIGTERM, wherever the agent happens to be)
 * is "Stop now", in the menu, with a line saying how the two differ. A soft stop that has not
 * taken effect after `escalateMs` (the agent may be inside one long tool call) turns the
 * visible control into Stop now.
 *
 * HOW-68: this was five buttons in a row that wrapped at 1440px. DESIGN.md: "secondary
 * actions go behind one More menu; a header is one row at every supported width". `extra` is
 * the frame's own secondary actions (open in IDE, the run folder, the resume command), so
 * there is one menu and not two. A refusal is reported through `onError` when the frame has
 * somewhere to show it in full — a sentence does not fit in a one-row header — and inline
 * otherwise.
 */
export function RunControls({ runId, summary, onAction, softStoppable = false, softStopNode, softStop = null, escalateMs = SOFT_STOP_ESCALATE_MS, now = Date.now(), extra, onError, menuRef }: {
  runId: string;
  summary: RunDetail["summary"];
  onAction: () => void;
  /** a live turn on a harness with a steer channel (progress.tsx steerableTurn) */
  softStoppable?: boolean;
  /** HOW-73: the step whose turn a soft stop names — several branches can be live at once */
  softStopNode?: string;
  softStop?: RunDetail["soft_stop"];
  escalateMs?: number;
  now?: number;
  /** the frame's own secondary actions, listed first in the More menu */
  extra?: readonly MenuEntry[];
  /** where a refusal is shown; without it the reason is printed beside the controls */
  onError?: (why: string | null) => void;
  /** the More trigger, so a shortcut can open the menu */
  menuRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const act = async (verb: string) => {
    setPending(verb);
    setError(null);
    onError?.(null);
    try {
      const r = await fetch(`/api/runs/${runId}/${verb}`, verb === "soft-stop" && softStopNode
        ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ node: softStopNode }) }
        : { method: "POST" });
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as any)?.error ?? `${verb} failed`);
      toast(verb === "soft-stop" ? "Stop sent — the agent stops at its next tool call" : `${verb.charAt(0).toUpperCase()}${verb.slice(1)} accepted — the runner is acting on it`);
      setTimeout(onAction, 300);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      // the inline error stays: a toast that has faded cannot be re-read (see toast.tsx)
      setError(why);
      onError?.(why);
      toast(why, "error");
    } finally {
      setPending(null);
    }
  };
  const resumable = summary.paused || ["harness-dead", "waiting", "failed-recoverable", "queued"].includes(summary.status);
  const active = ["running", "needs-input", "waiting", "failed-recoverable", "queued", "harness-dead"].includes(summary.status);
  const busy = pending !== null;
  const soft = summary.status === "running" && softStoppable;
  const stopping = softStop && (softStop.state === "requested" || softStop.state === "delivered");
  const overdue = softStopOverdue(softStop, now, escalateMs);
  // Resume is THE action when the run is stopped and nothing else on the page is asking
  const resumeIsPrimary = summary.status !== "needs-input";
  const retry = summary.status === "failed-recoverable";

  const items: MenuEntry[] = [...(extra ?? [])];
  if (active) {
    if (items.length > 0) items.push({ separator: true });
    if (!resumable && soft) items.push({ label: "Stop now", icon: <Pause />, disabled: busy, onSelect: () => void act("pause") }, { note: STOP_NOTE });
    items.push({ label: "Abort the run…", icon: <OctagonX />, destructive: true, disabled: busy, onSelect: () => setConfirmAbort(true) });
  }
  if (!active && items.length === 0) return null;

  return (
    <span className="run-controls">
      {!active ? null : resumable ? (
        <Button variant={resumeIsPrimary ? "default" : "outline"} size="sm" loading={pending === "resume"} disabled={busy} onClick={() => act("resume")}>
          {pending !== "resume" && (retry ? <RotateCcw /> : <Play />)}
          {pending === "resume" ? (retry ? "Retrying…" : "Resuming…") : retry ? "Retry" : "Resume"}
        </Button>
      ) : soft && overdue !== null ? (
        <span className="run-escalate" role="status">
          <span className="sr-only">not stopped after {fmtDur(overdue)} — it may be in one long tool call.</span>
          <Tooltip content={`Not stopped after ${fmtDur(overdue)} — it may be inside one long tool call. Stop now interrupts it where it is.`} side="bottom" align="end">
            <Button variant="destructive-outline" size="sm" disabled={busy} onClick={() => act("pause")}><Pause />Stop now</Button>
          </Tooltip>
        </span>
      ) : soft ? (
        <Button variant="outline" size="sm" loading={pending === "soft-stop" || !!stopping} disabled={busy || !!stopping} onClick={() => act("soft-stop")}>
          {pending !== "soft-stop" && !stopping && <Hand />}
          {stopping ? (softStop!.state === "delivered" ? "Agent is stopping…" : "Stopping at next tool call…") : "Stop at next tool call"}
        </Button>
      ) : (
        summary.status === "running" && (
          <Button variant="outline" size="sm" loading={pending === "pause"} disabled={busy} onClick={() => act("pause")}>
            {pending !== "pause" && <Pause />}{pending === "pause" ? "Pausing…" : "Pause"}
          </Button>
        )
      )}
      <Menu
        label="More run actions"
        trigger={
          <Button ref={menuRef} variant="ghost" size="sm" loading={pending === "abort"} aria-label={pending === "abort" ? "Aborting…" : "More run actions"}>
            {pending !== "abort" && <Ellipsis />}More<Kbd keys="." decorative className="run-wide" />
          </Button>
        }
        items={items}
      />
      {/* The dialog closes BEFORE the verb is sent, the way every other confirmation in this
          app does (slice.tsx, settings.tsx). A modal dialog makes the rest of the document
          inert and covers it with its ::backdrop, and both explanations of a refusal — the
          notice under the tabs and the toast region — render outside it. Leaving it open
          across a failed abort would hide the only two places that say why. */}
      <AlertDialog
        open={confirmAbort}
        onClose={() => setConfirmAbort(false)}
        onConfirm={() => { setConfirmAbort(false); act("abort"); }}
        title="Abort this run?"
        description={<>The runner is interrupted mid-turn and the run stops at <strong>{summary.graph}</strong>. Work already committed in its worktree is untouched, but the run cannot be un-aborted — you would start a new one.</>}
        confirmLabel="Abort the run"
      />
      {error && !onError && <span className="field-error">{error}</span>}
    </span>
  );
}

/**
 * HOW-55: what the newest agent ran WITH, beyond the prompt its hash proves — which of the
 * operator's settings loaded, the hooks that ran before it started (and how much text they
 * injected), and how many skills, plugins and MCP servers it had. A run from before HOW-55 says
 * "not recorded" rather than guessing. HOW-68: the rows are `KeyValue` items, so they wrap.
 */
export function agentEnvItems(env: RunDetail["agent_env"]): KeyValueItem[] {
  if (!env) return [{ label: "Agent environment", value: "not recorded" }];
  const injected = (env.hooks ?? []).filter((h) => h.injected);
  const files = env.files.filter((f) => f.sha256 !== null);
  const items: KeyValueItem[] = [{
    label: "Agent environment",
    value: (
      <Tooltip content={env.setting_sources ? `--setting-sources ${env.setting_sources}` : `${env.harness} has no switch for the operator's own config; what it read is hashed`}>
        <span>{env.harness} · {env.setting_sources === null ? "its own config" : env.inherits_user ? "your user settings + project" : "project settings only"}</span>
      </Tooltip>
    ),
  }];
  if (env.hooks && env.hooks.length > 0)
    items.push({
      label: "Hooks ran",
      value: (
        <Tooltip content={injected.map((h) => `${h.name}: ${h.injected!.chars} chars, sha256 ${h.injected!.sha256.slice(0, 12)}`).join("\n") || "none injected context"}>
          <span className={injected.length ? "font-medium" : ""}>{env.hooks.length}{injected.length ? ` · ${injected.length} injected context` : ""}</span>
        </Tooltip>
      ),
    });
  if (env.skills) items.push({ label: "Loaded", value: `${env.skills.length} skills · ${env.plugins?.length ?? 0} plugins · ${env.mcp_servers?.length ?? 0} MCP` });
  items.push({
    label: "Settings files",
    value: (
      <Tooltip content={env.files.map((f) => `${f.scope} ${f.path}${f.sha256 ? ` ${f.sha256.slice(0, 12)}` : " (absent)"}`).join("\n")}>
        <span>{files.length} hashed</span>
      </Tooltip>
    ),
  });
  return items;
}

export function AgentEnvironment({ env }: { env: RunDetail["agent_env"] }) {
  return <KeyValue items={agentEnvItems(env)} labelWidth={LABEL_W} />;
}

/** the Details drawer is 320px: the label column fits "Agent environment" on two lines at most */
const LABEL_W = 96;

/**
 * HOW-68 feedback ("bring back link of PR"): the run's pull requests, wherever the log names them.
 *
 * The read model lists a PR only from a `reconciled` forge probe of the run's OWN branch
 * (web/derive.ts), and the drawer printed that list UNDER the timeline — on a run that had
 * polled its PR thirteen times that was thirty rows down. So the list leads the drawer now, and
 * when no probe has reported one it is read from where the run itself says what it opened:
 * `publication_summary`, the text `probe:pr` takes its PR refs from. A PR named there (the forge
 * was unreachable, or the probe has not run yet) is still a link — with no state, because none
 * has been observed and a guessed one would be a lie.
 *
 * `pr.state` is the routing fact the last `probe:pr` published. With ONE pull request it is
 * that PR's; with a stack it belongs to whichever PR decided it, so it is not pinned on any.
 */
export interface RunPullRequest { url: string; label: string; state: "open" | "merged" | "closed" | "changes requested" | "CI failed" | "conflicts" | null }
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
export function runPullRequests(detail: Pick<RunDetail, "pull_requests" | "context">): RunPullRequest[] {
  const seen = new Map<string, string | null>(detail.pull_requests.map((pr) => [pr.url, pr.state]));
  const value = (key: string) => { const c = detail.context.find((e) => e.key === key); return c?.written && !c.veiled ? c.value : undefined; };
  const published = value("publication_summary");
  const text = published === undefined ? "" : typeof published === "string" ? published : JSON.stringify(published) ?? "";
  // only when no probe has reported one: a summary may also MENTION a PR it did not open (the
  // one it is stacked on, a related change), and a probed PR is a fact where that is a reading
  if (seen.size === 0) for (const url of text.match(PR_URL) ?? []) if (!seen.has(url)) seen.set(url, null);
  const routing = seen.size === 1 ? value("pr.state") : undefined;
  return [...seen].map(([url, raw]) => {
    const m = url.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/);
    // the forge's own word when it is final; else the routing fact, when it is this PR's
    const state = prWord(raw === "MERGED" || raw === "CLOSED" ? raw : typeof routing === "string" && routing !== "OPEN" ? routing : raw);
    return { url, label: m ? `${m[1]} #${m[2]}` : url.replace(/^https?:\/\//, ""), state };
  });
}
const PR_WORD: Record<string, NonNullable<RunPullRequest["state"]>> = {
  OPEN: "open", MERGED: "merged", CLOSED: "closed", CHANGES_REQUIRED: "changes requested", CHANGES_REQUESTED: "changes requested", CI_FAILED: "CI failed", CONFLICTS: "conflicts",
};
/** a state this viewer has no word for reads as "open": the PR exists, and that much is known */
const prWord = (raw: string | null): RunPullRequest["state"] => (raw === null ? null : PR_WORD[raw] ?? "open");
const PR_CHIP: Record<NonNullable<RunPullRequest["state"]>, "outline" | "success" | "destructive" | "default"> = {
  open: "outline", merged: "success", closed: "destructive", "changes requested": "default", "CI failed": "destructive", conflicts: "destructive",
};
function PrState({ state }: { state: RunPullRequest["state"] }) {
  return state === null ? <Badge variant="outline">not probed yet</Badge> : <Badge variant={PR_CHIP[state]}>{state}</Badge>;
}

/**
 * The timeline, with a POLL folded into one row (HOW-68 feedback: the drawer was "dozens of
 * repeated `delivery.probe_pr@N` / `delivery.wait@N` rows").
 *
 * The rule is generic — it knows nothing of delivery: three or more consecutive visits of ONE
 * step, or four or more of the SAME TWO steps alternating, are the same thing happening again. All
 * of it but the LATEST visit folds into one row that says what repeated, how many times and for
 * how long; the latest stays a row of its own (it is where the run is), and the fold opens to
 * show every visit. A visit that did not succeed ends a run: a failure is never folded away.
 */
export type TimelineItem<T> = { kind: "row"; row: T } | { kind: "fold"; key: string; rows: T[]; nodes: string[]; times: number; duration_ms: number };
export function foldTimeline<T extends { node: string; visit: number; status: string; duration_ms: number | null }>(rows: readonly T[]): TimelineItem<T>[] {
  const out: TimelineItem<T>[] = [];
  let i = 0;
  while (i < rows.length) {
    const first = rows[i]!;
    // how far the pattern of `period` steps starting here repeats, stopping after a visit that did not succeed
    const extent = (period: 1 | 2) => {
      const second = rows[i + 1];
      if (period === 2 && (!second || second.node === first.node)) return 0;
      let j = i;
      while (j < rows.length && rows[j]!.node === rows[i + ((j - i) % period)]!.node) {
        j++;
        if (rows[j - 1]!.status !== "succeeded") break;
      }
      return j - i;
    };
    const one = extent(1), two = extent(2);
    // three of one step; or four of a pair — "probe, wait, probe" is one poll and a half, and a
    // fold that says ×1 hides two rows to tell the operator nothing repeated
    const period = one >= 3 && one >= two ? 1 : 2;
    const length = period === 1 ? one : two;
    if (length < (period === 1 ? 3 : 4)) { out.push({ kind: "row", row: first }); i++; continue; }
    const folded = rows.slice(i, i + length - 1);
    out.push({
      kind: "fold", key: `${first.node}@${first.visit}`, rows: folded,
      nodes: period === 1 ? [first.node] : [first.node, rows[i + 1]!.node],
      times: Math.ceil(folded.length / period),
      duration_ms: folded.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0),
    });
    out.push({ kind: "row", row: rows[i + length - 1]! });
    i += length;
  }
  return out;
}

export function RunGraph({ runId, graph, timeline, status, onJumped }: { runId: string; graph: string; timeline: RunDetail["timeline"]; status: string; onJumped: () => void }) {
  const shape = useGraphShape(graph);
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "jumping" | "sent" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  // what the run knows about each step, for the picture: how often it ran, how long the finished
  // visits took and how the latest stands; and which routes it walked. Derived from the timeline,
  // and memoised on it — the frame re-renders once a second and the picture must not.
  const { visits, info, taken } = useMemo(() => {
    const visits: Record<string, number> = {};
    const spent: Record<string, number> = {};
    const info: Record<string, StepRunInfo> = {};
    const taken = new Set<string>();
    timeline.forEach((t, i) => {
      visits[t.node] = Math.max(visits[t.node] ?? 0, t.visit);
      if (t.duration_ms != null) spent[t.node] = (spent[t.node] ?? 0) + t.duration_ms;
      info[t.node] = { state: t.status === "succeeded" ? "done" : t.status };
      const next = timeline[i + 1];
      if (next) taken.add(takenKey(t.node, next.node));
      // HOW-73: a branch was reached from its parallel step, and leaves for that step's join
      if (t.parallel) taken.add(takenKey(t.parallel.node, t.node));
    });
    for (const [node, ms] of Object.entries(spent)) info[node] = { ...info[node], took: fmtDur(ms) };
    return { visits, info, taken };
  }, [timeline]);
  if (!shape) return <LoadingBlock label={`Loading the ${graph} graph`} rows={3} className="p-6" />;
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
      toast(`Jumping to ${jumpTo}`);
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
        <div className="jump-card">
          <h3>Jump to <span className="m">{jumpTo}</span></h3>
          <div className="field-hint">Starts a fresh attempt at this node using the current context. Your instruction is injected into its prompt and takes precedence.</div>
          <Textarea autoFocus aria-label={`instructions for ${jumpTo}`} value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={submitOnEnter(() => void jump(), { enabled: state !== "jumping" && state !== "sent" })} placeholder="Instructions for this step (optional)…" />
          {error && <div className="field-error" role="alert">{error}</div>}
          {state === "sent" && <div className="field-hint" role="status">Jump requested. The runner is moving; the graph will refresh on the next log event.</div>}
          <div className="actions">
            <Button onClick={jump} loading={state === "jumping"} disabled={state === "jumping" || state === "sent"}>
              {state !== "jumping" && <CornerDownRight />}
              {state === "jumping" ? "Sending jump…" : state === "sent" ? "Jump sent" : "Jump here"}
            </Button>
            <Button variant="outline" disabled={state === "jumping" || state === "sent"} onClick={() => { setJumpTo(null); setError(null); }}><X />Cancel</Button>
          </div>
        </div>
      )}
      {jumpable && !jumpTo && <div className="field-hint run-graph-hint">Click a non-terminal node to jump the run there with instructions.</div>}
      {!jumpable && status === "running" && <div className="field-hint run-graph-hint">Pause the run to enable jumping.</div>}
      <GraphDag
        shape={shape}
        current={current}
        waiting={status === "needs-input"}
        visits={visits}
        info={info}
        taken={taken}
        onSelect={jumpable ? setJumpTo : undefined}
        selected={jumpTo ?? undefined}
        canSelect={(node) => node.kind !== "terminal"}
      />
    </div>
  );
}

/** Whether "Open in IDE" can do anything for this run, and why not when it cannot. */
function ideState(detail: DetailDto): "none" | "unconfigured" | "gone" | "ready" {
  if (!detail.identity.cwd) return "none"; // a Plain run without a folder
  if (!detail.editor_configured) return "unconfigured";
  if (!detail.cwd_exists) return "gone";
  return "ready";
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
  const waiting = askKey ? detail.timeline.find((t) => stepKey(t) === askKey) : undefined;
  const row = waiting ?? detail.timeline.at(-1);
  // a bare `node@visit` (picked in Build, or a step chosen before its visit was re-attempted)
  // means that visit's latest attempt
  return resolveStepKey(detail.timeline, picked) ?? (row ? stepKey(row) : null);
}

/** `graceMs` is a seam for the component test (web/app/runview.test.tsx); nothing else sets it. */
export function RunView({ id, graceMs = OPEN_GRACE_MS }: { id: string; graceMs?: number }) {
  const [detail, setDetail] = useState<DetailDto | null>(null);
  // HOW-25: Chat leads. The thing that needs interacting with — the agent's question — lives
  // in the conversation, and the ticket was filed because it had nowhere to be seen.
  const [tab, setTab] = useState<RunTab>("chat");
  const [picked, setPicked] = useState<string | null>(null);
  const [liveGit, setLiveGit] = useState<LiveGit | null>(null);
  const [missing, setMissing] = useState(false);
  // HOW-68: WHY the first read has not arrived. Only a 404 means "no such run (yet)"; a 500 or
  // a server that is not there is a different fact, and after the grace period it used to be
  // told as "There is no run <id>" — a guess presented as one.
  const [unreachable, setUnreachable] = useState(false);
  /** bumped by "Try again": the open poll below runs once more from the start */
  const [openAttempt, setOpenAttempt] = useState(0);
  /** index of the first loaded turn; above 0, the chat offers the previous window */
  const [transcriptStart, setTranscriptStart] = useState(0);
  const now = useNow();
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
      setUnreachable(false);
    } catch (e) {
      // a 404 while the run dir is still being created: leave the loading state. Anything else
      // is the server failing or absent, which the not-found screen must not call "no run".
      if (mine === gen.current) setUnreachable(!(e instanceof HttpError && e.status === 404));
    }
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
  }, [detail, reload, graceMs, openAttempt]);
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
  // A `#needs-input` that points at nothing is dropped — but only once the run HAS LOADED and
  // is seen to have no ask. This used to run while `detail` was still null, which is every
  // first render: the hash was stripped before the card existed, so the card's own "the deep
  // link lands on the control" never saw it. A notification's click opened the run with focus
  // on <body> (found by driving it in a browser, HOW-68 fix pass).
  const loaded = detail !== null;
  useEffect(() => {
    if (!loaded || detail?.ask || location.hash !== "#needs-input") return;
    history.replaceState(history.state, "", location.pathname + location.search);
  }, [loaded, detail?.ask]);
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
  const parked = detail?.summary.status === "needs-input";
  useAttentionSurfaces(parked, detail ? { waiting: parked ? [id] : [], cleared: parked ? [] : [id] } : null);



  // the frame names the tab once the run has loaded; a parent's effect runs after its child's,
  // so this must stay out of the way then (undefined = leave the title alone)
  useDocumentTitle(detail ? undefined : missing ? (unreachable ? "Run not loaded" : "Run not found") : "Run");
  if (!detail && missing && unreachable)
    return (
      <ScrollPane label="Run not loaded" className="p-8" data-screen="run-unreachable">
        <EmptyState
          as="h1"
          title="Could not load this run"
          actions={<><Button variant="outline" onClick={() => setOpenAttempt((n) => n + 1)}><RotateCw />Try again</Button><a className={PRIMARY_LINK} href="/">Back to runs</a></>}
        >
          <p className="m-0 mx-auto max-w-[60ch]" role="alert">
            The viewer's server did not answer for <code className="[overflow-wrap:anywhere]">{id}</code>. Check the terminal
            running <code>bun run web</code>, then try again. Nothing here says the run does not exist.
          </p>
        </EmptyState>
      </ScrollPane>
    );
  if (!detail && missing)
    return (
      <ScrollPane label="Run not found" className="p-8" data-screen="run-missing">
        <EmptyState
          as="h1"
          title="No run with this id"
          actions={<a className={PRIMARY_LINK} href="/">Back to runs</a>}
        >
          <p className="m-0 mx-auto max-w-[60ch]">
            There is no run <code className="[overflow-wrap:anywhere]">{id}</code>. Nothing was written to its log within{" "}
            {graceMs / 1000}s, so if you just launched it, it probably failed to start — check the launch settings and try again.
          </p>
        </EmptyState>
      </ScrollPane>
    );
  if (!detail)
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-8" data-screen="run-loading">
        <p className="m-0 text-base text-muted-foreground">Looking for this run…</p>
        <LoadingBlock label={`Loading run ${id}`} />
      </div>
    );
  return (
    <RunFrame
      id={id} detail={detail} tab={tab} setTab={setTab} picked={picked} setPicked={setPicked}
      liveGit={liveGit} now={now} reload={reload} transcriptStart={transcriptStart} loadEarlier={loadEarlier}
    />
  );
}

/** how long after a run's last event "no runner" reads as "resuming" rather than "died" */
const RESUME_GRACE_MS = 4000;

/** One line under the tabs for a fact about the run that is not an ask: it failed, it is paused. */
function Notice({ tone = "neutral", children }: { tone?: "neutral" | "failed"; children: string }) {
  return (
    <div className="run-notice" data-tone={tone} role={tone === "failed" ? "alert" : "status"}>
      {tone === "failed" && <StatusGlyph status="failed-recoverable" />}
      <Truncate className="flex-1">{children}</Truncate>
    </div>
  );
}

/**
 * The frame, once the run has loaded. Split from `RunView` (which owns loading, the stream
 * and the transcript window) so its hooks — the drawer and the shortcut registry — are not
 * behind the loader's early returns.
 */
function RunFrame({ id, detail, tab, setTab, picked, setPicked, liveGit, now, reload, transcriptStart, loadEarlier }: {
  id: string;
  detail: DetailDto;
  tab: RunTab;
  setTab: (t: RunTab) => void;
  picked: string | null;
  setPicked: (k: string | null) => void;
  liveGit: LiveGit | null;
  now: number;
  reload: () => Promise<void>;
  transcriptStart: number;
  loadEarlier: () => void;
}) {
  const { summary, ask } = detail;
  const { toast } = useToast();
  const drawer = useDrawer("howdah.run.details");
  // FOCUS (HOW-68 feedback: "would like full screen for the plan"): the sidebar, the run's
  // header and the Details drawer stand down and the open pane has the window. F or the control
  // toggles it, Esc leaves, and it is remembered for the session — a way of reading, not a
  // preference about this machine. The shell is not this component's, so it is told through one
  // attribute on <html> that howdah.css reads; it is taken back when the run is left.
  const [focus, setFocusState] = useState(() => { try { return sessionStorage.getItem(FOCUS_KEY) === "1"; } catch { return false; } });
  const setFocus = useCallback((on: boolean) => {
    setFocusState(on);
    try { sessionStorage.setItem(FOCUS_KEY, on ? "1" : "0"); } catch { /* unremembered is fine */ }
  }, []);
  useEffect(() => {
    if (!focus) return;
    document.documentElement.dataset.runFocus = "1";
    return () => { delete document.documentElement.dataset.runFocus; };
  }, [focus]);
  const leaveFocus = useCallback(() => setFocus(false), [setFocus]);
  useEscapeLayer(leaveFocus, { active: focus, kind: "drawer" });
  // ⌘I while focused means "I want the details": leave focus and show them
  const toggleDetails = useCallback(() => {
    if (focus) { setFocus(false); drawer.setOpen(true); } else drawer.toggle();
  }, [focus, setFocus, drawer]);
  const detailsButton = useRef<HTMLButtonElement | null>(null);
  const moreButton = useRef<HTMLButtonElement | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const parked = summary.status === "needs-input";
  const ide = ideState(detail);
  useDocumentTitle(runLabel({ ...summary, id }));

  // D20: an answered ask takes its card — and whatever had focus inside it — off the page, and
  // focus fell to <body>. When the standing ask goes (or is replaced) while focus was last
  // inside it, focus moves to the header's status line, which is where the run now says what
  // it is doing. ONE rule for every card (reply, answer, verdict, approval, retry, waive),
  // keyed on the read model rather than on each card remembering to do it. `focusRunStatus`
  // leaves focus alone if the operator has put it somewhere real in the meantime.
  const askKey = ask ? `${ask.node}@${ask.visit}#${ask.seq}` : null;
  const focusInAsk = useRef(false);
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      focusInAsk.current = (e.target as Element | null)?.closest?.("#needs-input, [data-slot='acceptance-card']") != null;
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);
  const lastAsk = useRef(askKey);
  useEffect(() => {
    const was = lastAsk.current;
    lastAsk.current = askKey;
    if (was === null || was === askKey || !focusInAsk.current) return;
    focusInAsk.current = false;
    focusRunStatus();
  }, [askKey]);

  const openIde = useCallback(async () => {
    const r = await fetch(`/api/runs/${id}/open-ide`, { method: "POST" }).catch(() => null);
    toast(r?.ok ? "Opening the run's folder in your editor" : "Could not open the editor", r?.ok ? "default" : "error");
  }, [id, toast]);
  const openFolder = useCallback(async () => {
    const r = await fetch(`/api/runs/${id}/open-run-folder`, { method: "POST" }).catch(() => null);
    toast(r?.ok ? "Opening the run folder" : "Could not open the run folder", r?.ok ? "default" : "error");
  }, [id, toast]);
  const resumeCommand = detail.persistence ? `HOWDAH_HOME=${detail.persistence.home} bun cli/main.ts resume ${id}` : null;
  const copyResume = useCallback(async () => {
    if (!resumeCommand) return;
    await navigator.clipboard?.writeText(resumeCommand).catch(() => {});
    toast("Copied to the clipboard");
  }, [resumeCommand, toast]);

  /** the Build pane is where the ask and both composers live; a tab switch needs a frame to land */
  const inBuild = useCallback((then: () => void) => {
    setTab("chat");
    setTimeout(then, 0);
  }, [setTab]);
  // A QUESTION is answered with its number keys, and those are handled by the questionnaire's
  // own form — so `A` has to land INSIDE it. Focus on the card around the form left `1`…`7`
  // to the tab shortcuts: "A, then 2" switched to another tab instead of picking option 2.
  // Focusing a choice does not choose it; the card is still what scrolls into view.
  const jumpToAsk = useCallback(() => inBuild(() => {
    const card = document.getElementById("needs-input");
    const choice = card?.querySelector<HTMLElement>("fieldset[data-active] input:not(:disabled)");
    // a question taller than half the window is brought in from its TOP, so its text is what
    // you see — "nearest" leaves a box taller than the view where it is, cut at the top
    const question = choice?.closest<HTMLElement>("fieldset") ?? null;
    if (question && question.getBoundingClientRect().height > window.innerHeight / 2) question.scrollIntoView({ block: "start" });
    else card?.scrollIntoView({ block: "nearest" });
    (choice ?? card)?.focus({ preventScroll: true });
  }), [inBuild]);
  const reply = useCallback(() => inBuild(() => {
    const field = document.querySelector<HTMLElement>("#needs-input textarea, #needs-input input[type='text']")
      ?? document.querySelector<HTMLElement>(".chat-input-field");
    field?.scrollIntoView({ block: "nearest" });
    field?.focus({ preventScroll: true });
  }), [inBuild]);

  useShortcuts([
    ...TABS.map((t, i) => ({ id: `run.tab.${t.value}`, scope: "A run", label: `Show ${t.label}`, keys: String(i + 1), run: () => setTab(t.value) })),
    { id: "run.details", scope: "A run", label: drawer.open && !focus ? "Hide details" : "Show details", keys: "mod+i", run: toggleDetails },
    { id: "run.focus", scope: "A run", label: focus ? "Leave focus" : "Focus the pane (hide the sidebar and details)", keys: "f", keywords: "full screen fullscreen zen wide", run: () => setFocus(!focus) },
    { id: "run.reply", scope: "A run", label: ask ? "Reply to the run" : "Ask about this run", keys: "r", run: reply },
    { id: "run.ask", scope: "A run", label: "Go to what the run is asking", keys: "a", run: jumpToAsk, disabled: !ask },
    { id: "run.open-ide", scope: "A run", label: "Open in IDE", keys: "o", run: () => void openIde(), disabled: ide !== "ready" },
    { id: "run.more", scope: "A run", label: "More run actions", keys: ".", run: () => moreButton.current?.click(), palette: false },
    { id: "run.open-folder", scope: "A run", label: "Open run folder", run: () => void openFolder() },
    ...(resumeCommand ? [{ id: "run.copy-resume", scope: "A run", label: "Copy resume command", run: () => void copyResume() }] : []),
  ]);

  const lastEventAgeMs = summary.last_event_at ? now - new Date(summary.last_event_at).getTime() : 0;
  const staleRunning = summary.status === "running" && lastEventAgeMs > 5 * 60_000;
  // BETWEEN RUNNERS IS NOT DEAD. A parked run has no live runner — it exited when it parked —
  // so the moment an answer, a verdict or a decision resolves the park, the read model sees a
  // run with nothing standing and no runner, and says `harness-dead` until the runner the
  // answer spawned takes the lock a second later. Found by answering from the page: every
  // approval and every question flashed "Runner died" and a red "Resume to pick the run back
  // up" at the operator who had just done exactly that. For a few seconds after the run's last
  // event the frame says "Resuming" instead; a runner that really is gone still reads as dead
  // once the grace is over.
  // (`now` ticks once a second, so a brand-new event can be "in the future": that is recent too)
  const resuming = summary.status === "harness-dead" && lastEventAgeMs < RESUME_GRACE_MS;
  // the step that needs a human wins the selection; otherwise the newest one
  const selectedKey = selectedStepKey(detail, picked);
  // the chat shows the loaded window. Steps above it stay on the Steps list; "Load earlier"
  // brings the next window in, and the newest step stays even before it has spoken.
  // memoised: a fresh object per render would defeat `TranscriptPane`'s memo on every tick
  const chatDetail = useMemo(() => {
    if (transcriptStart <= 0) return detail;
    const loaded = new Set(detail.turns.map((t) => `${t.node}@${t.visit}`));
    const first = detail.timeline.findIndex((r) => loaded.has(`${r.node}@${r.visit}`));
    return first <= 0 ? detail : { ...detail, timeline: detail.timeline.slice(first) };
  }, [detail, transcriptStart]);
  const selectedRow = detail.timeline.find((t) => stepKey(t) === selectedKey) ?? null;
  // D26: steps the timeline still calls running that nothing is running; their clock stops at
  // the run's last event rather than counting up for as long as the page is open
  const interrupted = {
    keys: new Set(detail.timeline.filter((t) => stepInterrupted(detail, t)).map(stepKey)),
    at: summary.last_event_at ? new Date(summary.last_event_at).getTime() : now,
  };
  // HOW-68: a step chosen OUTSIDE the Steps list (the Build transcript, the Details timeline)
  // lands on that step's detail — narrow, the split would otherwise show the list it is in.
  // Leaving Steps forgets the request, so coming back by the tab strip shows the list again.
  const [stepOpen, setStepOpen] = useState(0);
  useEffect(() => { if (tab !== "steps") setStepOpen(0); }, [tab]);
  const showStep = useCallback((key: string) => { setPicked(key); setTab("steps"); setStepOpen((n) => n + 1); }, [setPicked, setTab]);
  const steerable = steerableTurn(detail);
  const escalateMs = detail.soft_stop_escalate_ms ?? SOFT_STOP_ESCALATE_MS;
  const overdue = summary.status === "running" && steerable ? softStopOverdue(detail.soft_stop, now, escalateMs) : null;

  const extra: MenuEntry[] = [
    ...(ide === "ready" ? [{ label: "Open in IDE", icon: <ExternalLink />, keys: "o", onSelect: () => void openIde() }]
      : ide === "unconfigured" ? [{ label: "Open in IDE… choose an editor in Settings", icon: <ExternalLink />, href: "/settings" }]
      : ide === "gone" ? [{ label: "Open in IDE", icon: <ExternalLink />, disabled: true }, { note: "The folder is gone — the worktree was cleaned." }]
      : []),
    { label: "Open run folder", icon: <FolderOpen />, onSelect: () => void openFolder() },
    ...(resumeCommand ? [{ label: "Copy resume command", icon: <Copy />, onSelect: () => void copyResume() }] : []),
  ];
  const waited = parked && summary.waiting_since ? fmtWait(summary.waiting_since, now) : null;
  const prs = useMemo(() => runPullRequests(detail), [detail.pull_requests, detail.context]); // eslint-disable-line react-hooks/exhaustive-deps
  /* the status line is a focus TARGET (D20): where focus goes when an ask is answered.
     tabIndex -1 keeps it out of the Tab order; the ring is the global :focus-visible */
  const statusLine = (
    <span id={RUN_STATUS_ID} data-slot="run-status" tabIndex={-1} className="inline-flex shrink-0 items-center rounded-[var(--radius-sm)]">
      {parked ? (
        // the alarm, said once in the frame: one line that takes you to the card (DESIGN.md)
        <Button variant="ghost" size="sm" className="run-status-line" aria-label={`Waiting on you${waited ? ` for ${waited}` : ""} — go to what the run is asking`} onClick={jumpToAsk}>
          <StatusGlyph status="needs-input" />Waiting on you{waited && <span className="tabular-nums"> · {waited}</span>}
          <Kbd keys="a" decorative className="run-wide" />
        </Button>
      ) : (
        resuming ? <StatusBadge status="queued" label="Resuming" /> : <StatusBadge status={summary.status} />
      )}
    </span>
  );
  // the run's pull request, beside its status: the newest one, and a count when there are more
  // (all of them lead the Details drawer). It opens in the operator's browser.
  const pr = prs.at(-1);
  const prLink = pr && (
    <Tooltip side="bottom" content={<span className="flex flex-col gap-0.5"><span>{prs.length > 1 ? `${prs.length} pull requests — the newest opens; all are in Details` : "Open the pull request in your browser"}</span><span className="font-mono text-code">{pr.url.replace(/^https:\/\//, "")}</span></span>}>
      <a className={PR_LINK} href={pr.url} {...EXTERNAL} data-slot="run-pr" aria-label={`Pull request ${pr.label}${pr.state ? `, ${pr.state}` : ""} — opens in your browser`}>
        <GitPullRequest aria-hidden />
        <span className="tabular-nums">#{pr.url.match(/\/pull\/(\d+)/)?.[1] ?? "PR"}</span>
        {pr.state && <span className="run-wide text-muted-foreground">{pr.state}</span>}
        {prs.length > 1 && <span className="tabular-nums text-muted-foreground">+{prs.length - 1}</span>}
      </a>
    </Tooltip>
  );

  return (
    <div className="runview">
      <div className="thread-col @container">
        {!focus && (
        <header className="run-head">
          <Tooltip content="Back to runs" side="bottom">
            <a className={BACK_LINK} href="/" aria-label="back to runs"><ArrowLeft /></a>
          </Tooltip>
          <h1><Truncate>{runLabel({ ...summary, id })}</Truncate></h1>
          {statusLine}
          {prLink}
          <Toolbar label="Run actions" className="ml-auto">
            <RunControls
              runId={id} summary={summary} onAction={reload} now={now}
              softStoppable={steerable !== null} softStopNode={steerable?.node} softStop={detail.soft_stop}
              escalateMs={escalateMs} extra={extra} onError={setActionError} menuRef={moreButton}
            />
            {/* a convenience copy of the menu's item, shown only where the row has room for it */}
            {ide === "ready" && (
              <Button variant="ghost" size="sm" className="run-open-ide" onClick={() => void openIde()}>
                <ExternalLink />Open in IDE<Kbd keys="o" decorative />
              </Button>
            )}
            <Tooltip content={<span className="inline-flex items-center gap-2">Focus the pane: hide the sidebar and details <Kbd keys="f" /></span>} side="bottom" align="end">
              <Button variant="ghost" size="sm" aria-pressed={false} aria-label="Focus the pane" onClick={() => setFocus(true)}>
                <Maximize2 /><span className="run-wide">Focus</span><Kbd keys="f" decorative className="run-wide" />
              </Button>
            </Tooltip>
            <Button
              ref={detailsButton}
              variant="outline"
              size="sm"
              aria-pressed={drawer.open}
              aria-label={drawer.open ? "Hide details" : "Show details"}
              onClick={drawer.toggle}
            >
              <PanelRight />Details<Kbd keys="mod+i" decorative className="run-wide" />
            </Button>
          </Toolbar>
        </header>
        )}
        <div className="run-tabs flex items-center gap-3">
          <Tabs value={tab} onValueChange={(v) => setTab(v as RunTab)} items={TABS.map((t, i) => ({ ...t, hint: String(i + 1) }))} />
          {/* focused: the header is gone, so the strip carries what it said — which run, how it
              stands, its PR — and the way back out */}
          {focus && (
            <div className="ml-auto flex min-w-0 items-center gap-2" data-slot="run-focus-bar">
              <Truncate className="text-sm text-muted-foreground">{runLabel({ ...summary, id })}</Truncate>
              {statusLine}
              {prLink}
              <Button variant="outline" size="sm" aria-pressed aria-label="Leave focus" onClick={leaveFocus}>
                <Minimize2 />Leave focus<Kbd keys="f" decorative />
              </Button>
            </div>
          )}
        </div>
        {actionError && (
          <div className="run-notice" data-tone="failed" role="alert">
            <StatusGlyph status="failed-recoverable" />
            <span className="field-error">{actionError}</span>
            <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="dismiss this message" onClick={() => setActionError(null)}><X /></Button>
          </div>
        )}
        {overdue !== null && <Notice>{`The agent has not stopped after ${fmtDur(overdue)} — it may be inside one long tool call. Stop now interrupts it where it is.`}</Notice>}
        {staleRunning && <Notice tone="failed">{`No run events for ${fmtDur(lastEventAgeMs)}. The runner may be stuck even though its process is still alive.`}</Notice>}
        {summary.status === "harness-dead" && !resuming && <Notice tone="failed">The runner stopped before the current step finished. Resume to pick the run back up.</Notice>}
        {summary.paused && <Notice>Paused by you — the run holds at the node boundary until you resume it.</Notice>}
        {summary.outcome === "aborted" && <Notice tone="failed">Aborted by you.</Notice>}
        {summary.outcome !== "aborted" && (summary.status === "failed-recoverable" || summary.status === "failed-terminal") && (
          <Notice tone="failed">
            {summary.failure
              ? `Failed at ${summary.failure.node}@${summary.failure.visit}${summary.failure.reason ? ` — ${summary.failure.reason.replace(/^executor threw: /, "")}` : ""}`
              : "Run failed — see the last entry in Build"}
          </Notice>
        )}
        {/* every pane gets the same container: a flex column that fills the body and can shrink,
            so the pane's own scroller is the only thing that scrolls */}
        <div className="run-body" data-tab={tab}>
          {tab === "plan" ? (
            <PlanPane runId={id} detail={detail} onChanged={reload} />
          ) : tab === "report" ? (
            <ReportPane runId={id} detail={detail} onChanged={reload} />
          ) : tab === "context" ? (
            <ContextPane entries={detail.context} />
          ) : tab === "chat" ? (
            <TranscriptPane runId={id} detail={chatDetail} ask={ask} liveGit={liveGit} onResolved={reload} onPickStep={showStep} earlier={transcriptStart > 0} onEarlier={loadEarlier} />
          ) : tab === "logs" ? (
            <LogsPane runId={id} />
          ) : tab === "graph" ? (
            <RunGraph runId={id} graph={summary.graph} timeline={detail.timeline} status={summary.status} onJumped={reload} />
          ) : (
            <StepsSplit
              openRequest={stepOpen}
              list={<RunSteps timeline={detail.timeline} ask={ask} selected={selectedKey} now={now} onSelect={setPicked} mapping={detail.slice?.mapping} interrupted={interrupted} />}
              detail={<StepDetail runId={id} row={selectedRow} detail={detail} ask={ask} now={now} onResolved={reload} />}
            />
          )}
        </div>
      </div>

      <Drawer open={drawer.open && !focus} onClose={drawer.close} label="Run details" title="Details" returnFocus={detailsButton} resizeKey="howdah.run.details">
        <RunDetails prs={prs} id={id} detail={detail} liveGit={liveGit} now={now} tab={tab} reload={reload} resumeCommand={resumeCommand} onCopyResume={copyResume} onPickStep={showStep} />
      </Drawer>
    </div>
  );
}

const STEP_STATUS = { succeeded: "done", failed: "failed-recoverable", running: "running" } as const;

/** One group in the drawer: a `SectionLabel` heading over its rows. A `<section>`, so it has an outline entry. */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="run-details-group">
      <SectionLabel as="h3">{title}</SectionLabel>
      {children}
    </section>
  );
}

/**
 * The Details drawer's contents (HOW-68). The same facts the inspector rail held, as
 * `KeyValue` groups: labels in the reading face, ids/paths/branches in mono with a copy
 * button, and every value WRAPPED — the rail cut paths to 180px and timeline names to 150px
 * with nothing to read the rest by (455 hits in the audit). The timeline is a compact list
 * with the full `node@visit`; the proportional bars went, because Steps draws that picture at
 * a size where it can be read.
 */
function RunDetails({ id, detail, liveGit, now, tab, reload, resumeCommand, onCopyResume, onPickStep, prs }: {
  prs: readonly RunPullRequest[];
  /** open a step in Steps, on its detail */
  onPickStep: (key: string) => void;
  id: string;
  detail: DetailDto;
  liveGit: LiveGit | null;
  now: number;
  tab: RunTab;
  reload: () => Promise<void>;
  resumeCommand: string | null;
  onCopyResume: () => void;
}) {
  const { summary } = detail;
  const run: KeyValueItem[] = [
    ...(summary.name ? [{ label: "Name", value: summary.name }] : []),
    { label: "Run", value: id, mono: true, copy: true },
    // a queued run's log has no `run-started` yet, so the read model has no graph to name ("?")
    { label: "Graph", value: summary.graph === "?" ? null : summary.graph, mono: true },
    ...(detail.identity.cwd ? [{ label: detail.identity.folder_kind === "repo" ? "Repo" : "Folder", value: detail.identity.cwd, mono: true, copy: true }] : []),
    ...(detail.git?.intended?.branch ? [{ label: "Branch", value: detail.git.intended.branch, mono: true, copy: true }] : []),
    // HOW-23: a child of a fan-out says which run planned it. A link, not a status — the
    // parent's own log is the only thing that knows how the parent is doing.
    ...(summary.parent ? [{ label: "Planned by", value: <a href={`/run/${summary.parent}`} className="run-link m">{summary.parent}</a> }] : []),
  ];
  const folded = useMemo(() => foldTimeline(detail.timeline), [detail.timeline]);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const stepRow = (t: RunDetail["timeline"][number]) => {
    // D26: a dead run's last step is not running — the cross and the word, clock stopped
    const cut = stepInterrupted(detail, t);
    const word = cut ? "interrupted" : t.status;
    const took = fmtDur(liveDuration(t, cut && summary.last_event_at ? new Date(summary.last_event_at).getTime() : now));
    return (
      // a row is the way to its step: it opens Steps on that step's detail
      <Row className="run-details-row" data-step-status={word} onClick={() => onPickStep(stepKey(t))} aria-label={`open ${t.node}@${t.visit} in Steps — ${word}, ${took}`}>
        <StatusGlyph status={cut ? "harness-dead" : STEP_STATUS[t.status]} size={12} label={word} />
        <span className="m run-details-step">{t.node}@{t.visit}</span>
        <span className="run-details-dur">{took}</span>
      </Row>
    );
  };
  return (
    <div className="run-details">
      {/* FIRST: the one thing in this drawer the operator leaves the viewer for (see runPullRequests) */}
      {prs.length > 0 && (
        <Group title={prs.length === 1 ? "Pull request" : "Pull requests"}>
          <ul className="run-details-list">
            {prs.map((pr) => (
              <li key={pr.url} className="flex items-center gap-2">
                <a href={pr.url} {...EXTERNAL} className="run-link">
                  <GitPullRequest aria-hidden className="mr-1.5 inline size-3.5 align-[-2px] text-muted-foreground" />{pr.label}
                </a>
                <PrState state={pr.state} />
              </li>
            ))}
          </ul>
        </Group>
      )}
      {liveStep(detail) && (
        <Group title="Progress">
          <ProgressPanel detail={detail} liveGit={liveGit} variant="rail" runId={id} />
        </Group>
      )}
      <Group title="Run">
        <KeyValue items={run} labelWidth={LABEL_W} />
      </Group>
      <Group title="Timeline">
        {detail.timeline.length === 0 ? <p className="run-details-note">No step has started yet.</p> : (
          <ol className="run-details-list">
            {folded.map((item) => {
              if (item.kind === "row") return <li key={stepKey(item.row)}>{stepRow(item.row)}</li>;
              const open = opened.has(item.key);
              const what = item.nodes.join(" ↔ ");
              const took = fmtDur(item.duration_ms);
              return (
                <li key={`fold:${item.key}`}>
                  <Row
                    className="run-details-row" data-fold={open ? "open" : "closed"} aria-expanded={open}
                    aria-label={`${what}, ${item.times} times over ${took} — ${open ? "hide" : "show"} the ${item.rows.length} visits`}
                    onClick={() => setOpened((was) => { const next = new Set(was); if (!next.delete(item.key)) next.add(item.key); return next; })}
                  >
                    <ChevronRight aria-hidden size={12} className={open ? "rotate-90" : ""} />
                    <span className="m run-details-step">{what} <span className="font-sans tabular-nums text-muted-foreground">×{item.times}</span></span>
                    <span className="run-details-dur">{took}</span>
                  </Row>
                  {open && <ol className="run-details-list run-details-folded">{item.rows.map((t) => <li key={stepKey(t)}>{stepRow(t)}</li>)}</ol>}
                </li>
              );
            })}
          </ol>
        )}
      </Group>
      {/* HOW-23: the fan-out. One row per child run, with the slice and ticket it came from.
          No status per child: this run's log records that it launched them and nothing more,
          and a status invented here would be a live-looking lie. Follow the link instead. */}
      {detail.children.length > 0 && (
        <Group title="Launched runs">
          <KeyValue
            labelWidth={LABEL_W}
            items={detail.children.map((c) => ({ label: c.ticket ?? c.slice_id, value: <a href={`/run/${c.run_id}`} className="run-link m">{c.run_id}</a> }))}
          />
        </Group>
      )}
      {detail.identity.folder_kind === "repo" && (
        <Group title="Git">
          {detail.git ? (
            <>
              <KeyValue
                labelWidth={LABEL_W}
                items={[
                  { label: "Observed branch", value: detail.git.git.branch, mono: true },
                  { label: "Uncommitted", value: <span className="tabular-nums">{detail.git.git.uncommitted}</span> },
                  { label: "Unpushed", value: <span className="tabular-nums">{detail.git.git.unpushed ?? "no upstream"}</span> },
                  { label: "Probed", value: `${fmtWait(detail.git.ts, now)} ago` },
                  ...(detail.git.forge?.kind === "unreachable" ? [{ label: "Forge", value: "unreachable — not \"no PR\"" }] : []),
                ]}
              />
              {detail.git.disagreements.map((d, i) => <p key={i} className="run-details-note" data-tone="failed">{d}</p>)}
            </>
          ) : (
            <p className="run-details-note">Not probed yet.</p>
          )}
        </Group>
      )}
      {/* HOW-51: the contract while the run is still being judged; once finished it leads Build.
          HOW-78: the Plan tab draws it under the plan, so the drawer does not repeat it there.
          It is NOT repeated beside an opted-in gate either: the Build pane shows it with the ask */}
      {detail.acceptance && detail.summary.outcome === null && !(detail.ask?.code === "acceptance-unmet" && detail.acceptance.waivable) && tab !== "plan" && (
        <section className="run-details-group">
          <AcceptanceCard runId={id} detail={detail} onChanged={reload} />
        </section>
      )}
      <Group title="Agent">
        <AgentEnvironment env={detail.agent_env} />
      </Group>
      {detail.persistence && (
        <Group title="Persistence">
          <KeyValue
            labelWidth={LABEL_W}
            items={[
              { label: "Home", value: detail.persistence.home, mono: true, copy: true },
              { label: "Run folder", value: detail.persistence.run_dir, mono: true, copy: true },
              { label: "Log", value: detail.persistence.log_path, mono: true, copy: true },
              ...(detail.persistence.worktree_path ? [{ label: "Worktree", value: detail.persistence.worktree_path, mono: true, copy: true }] : []),
              { label: "Runner", value: detail.persistence.runner_alive ? "alive" : "not running" },
            ]}
          />
          {resumeCommand && <Button variant="outline" size="sm" className="self-start" onClick={onCopyResume}><Copy />Copy resume command</Button>}
        </Group>
      )}
      <Group title="Usage">
        <KeyValue
          labelWidth={LABEL_W}
          items={[
            ...usageItems(detail.usage),
            ...(detail.allowance.length === 0 ? [{ label: "Allowance", value: null }] : detail.allowance.map((a) => ({
              label: `${a.harness} allowance`,
              value: (
                <span className={a.state === "exhausted" ? "font-semibold text-destructive" : ""}>
                  {a.state === "ok" && a.remaining !== undefined ? `${Math.round(a.remaining * 100)}% left` : a.state}
                  {a.resets_at ? ` · resets ${fmtClock(a.resets_at)}` : ""}
                </span>
              ),
            }))),
          ]}
        />
      </Group>
      {Object.keys(detail.pinned_prompts).length > 0 && (
        <Group title="Pinned prompts">
          <ul className="run-details-list">
            {Object.entries(detail.pinned_prompts).map(([p, v]) => (
              <li key={p}>
                <span className="m run-details-step">{p}</span>
                <span className="run-details-dur">v{v}</span>
              </li>
            ))}
          </ul>
        </Group>
      )}
    </div>
  );
}
