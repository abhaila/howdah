/**
 * HOW-49: "where is it at?" — the git half of the live progress panel.
 *
 * `engine/reconcile.ts` probes git BEFORE each node, so a 27-minute implement step is invisible
 * to the rail's Git section for its whole duration ("probed 27m ago") while its commits and
 * dirty files sit on disk. This module looks at that worktree WHILE the step runs.
 *
 * It is OBSERVATION, not state — "observed reality beats recorded state":
 *   - nothing is appended to the log, written to the run dir, or cached across requests;
 *   - nothing routes on it; the engine never reads it;
 *   - it runs only while a step is live AND someone is watching (an SSE subscriber), and stops
 *     the moment either stops being true, so an idle viewer costs no git spawns.
 *
 * Every git call is read-only and passes `--no-optional-locks`: a plain `git status` refreshes
 * the index and takes `index.lock`, which would race the agent's own `git add` in the same
 * worktree. Commits are scoped to the step by the HEAD the reconciler observed just before the
 * step started (`<base>..HEAD`); with no observation they fall back to commits dated after the
 * step began, which is the best the log can say.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { LoggedEvent } from "../log/events";

export interface LiveGit {
  node: string;
  visit: number;
  /** commits made since the step started, newest first (capped at COMMIT_CAP) */
  commits: Array<{ sha: string; subject: string; at: string }>;
  /** how many commits there were before the cap */
  commit_count: number;
  /** files `git status --porcelain` reports — tracked changes and untracked files */
  uncommitted: number;
  /** the newest commit on HEAD (not only this step's), so "time since last commit" is honest */
  last_commit_at: string | null;
  /** the HEAD the step started from, when the reconciler observed one */
  base: string | null;
  probed_at: string;
}

export const COMMIT_CAP = 20;
export const LIVE_GIT_INTERVAL_MS = 15_000;

type Git = (args: string[], cwd: string) => { code: number; stdout: string };
const realGit: Git = (args, cwd) => {
  const r = spawnSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", timeout: 10_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "" };
};

/** the step a live probe is for, and where it starts from — or null when nothing is live */
export interface LiveTarget {
  node: string;
  visit: number;
  cwd: string;
  base: string | null;
  since: string;
}

/**
 * The live step of a run, read from its log: the newest `node-started` with no `node-finished`
 * yet, on a run that has not finished. Its base is the HEAD the reconciler observed for that
 * node just before it started. Pure, so the hub and its tests share one answer.
 */
export function liveTargetOf(events: readonly LoggedEvent[], cwd: string | undefined): LiveTarget | null {
  if (!cwd) return null;
  if (events.some((e) => e.type === "run-finished")) return null;
  let started: Extract<LoggedEvent, { type: "node-started" }> | null = null;
  let startIndex = -1;
  events.forEach((e, i) => {
    if (e.type === "node-started") { started = e; startIndex = i; }
  });
  if (!started) return null;
  const s = started as Extract<LoggedEvent, { type: "node-started" }>;
  if (events.slice(startIndex).some((e) => e.type === "node-finished" && e.node === s.node && e.visit === s.visit)) return null;
  let base: string | null = null;
  for (let i = startIndex - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "node-started") break; // only the probe for THIS step counts
    if (e.type === "reconciled" && e.node === s.node) { base = e.git.head; break; }
  }
  return { node: s.node, visit: s.visit, cwd, base, since: s.ts };
}

/** one read-only look at the worktree. Null when it is not a git work tree (or is gone). */
export function probeLiveGit(target: LiveTarget, git: Git = realGit, now: () => Date = () => new Date()): LiveGit | null {
  if (!existsSync(target.cwd)) return null;
  const inside = git(["rev-parse", "--is-inside-work-tree"], target.cwd);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return null;

  const fmt = "--format=%h%x09%cI%x09%s";
  const log = target.base
    ? git(["log", fmt, `${target.base}..HEAD`], target.cwd)
    : git(["log", fmt, `--since=${target.since}`, "HEAD"], target.cwd);
  const rows = log.code === 0 ? log.stdout.split("\n").filter((l) => l.trim()) : [];
  const commits = rows.map((l) => {
    const [sha = "", at = "", ...subject] = l.split("\t");
    return { sha, at, subject: subject.join("\t") };
  });
  const status = git(["status", "--porcelain", "--untracked-files=all"], target.cwd);
  const last = git(["log", "-1", "--format=%cI", "HEAD"], target.cwd);
  return {
    node: target.node,
    visit: target.visit,
    commits: commits.slice(0, COMMIT_CAP),
    commit_count: commits.length,
    uncommitted: status.code === 0 ? status.stdout.split("\n").filter((l) => l.trim()).length : 0,
    last_commit_at: last.code === 0 && last.stdout.trim() ? last.stdout.trim() : null,
    base: target.base,
    probed_at: now().toISOString(),
  };
}

/**
 * One timer per WATCHED run, shared by all of that run's subscribers. A tick asks `target()`
 * whether a step is live; when none is, it spawns nothing. The timer is cleared when the last
 * subscriber leaves, so the probe "stops when the step ends or the last subscriber leaves".
 */
export class LiveGitHub {
  private readonly runs = new Map<string, { subs: Set<(g: LiveGit) => void>; timer: ReturnType<typeof setInterval> }>();

  constructor(
    private readonly opts: {
      target: (runId: string) => LiveTarget | null;
      probe?: (t: LiveTarget) => LiveGit | null;
      intervalMs?: number;
    },
  ) {}

  /** start watching; returns the unsubscribe. The first probe runs immediately. */
  subscribe(runId: string, push: (g: LiveGit) => void): () => void {
    let entry = this.runs.get(runId);
    if (!entry) {
      entry = { subs: new Set(), timer: setInterval(() => this.tick(runId), this.opts.intervalMs ?? LIVE_GIT_INTERVAL_MS) };
      this.runs.set(runId, entry);
    }
    entry.subs.add(push);
    this.tick(runId, push);
    return () => {
      const e = this.runs.get(runId);
      if (!e) return;
      e.subs.delete(push);
      if (e.subs.size === 0) {
        clearInterval(e.timer);
        this.runs.delete(runId);
      }
    };
  }

  /** runs being watched right now — what the tests assert stops */
  watching(): string[] {
    return [...this.runs.keys()];
  }

  private tick(runId: string, only?: (g: LiveGit) => void): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    let target: LiveTarget | null = null;
    try {
      target = this.opts.target(runId);
    } catch {
      return; // a torn log mid-read: the next tick sees it whole
    }
    if (!target) return;
    const got = (this.opts.probe ?? probeLiveGit)(target);
    if (!got) return;
    for (const push of only ? [only] : entry.subs) {
      try { push(got); } catch { /* a closed stream; its cancel() unsubscribes it */ }
    }
  }
}
