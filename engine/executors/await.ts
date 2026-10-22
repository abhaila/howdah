/**
 * `runs:await` — HOW-57's wait built-in (decision 1A): a stacked run reads ANOTHER run's log
 * and decides whether that run has got far enough for this one to start. The CHILD waits; the
 * parent never supervises (HOW-23's invariant holds: `runs:launch` still starts everything at
 * once and finishes).
 *
 * Two modes, chosen by what the node DECLARES it writes (core/stack.ts):
 *
 *   AWAIT (`deps.ready`, …) — before the worktree. For each dependency `<parent>--<slice>`:
 *     - no run dir, and the parent logged `run-spawned` for it → not started yet; wait (G1:
 *       children are detached and may not have written their first line);
 *     - no run dir and no spawn record → PARK "never launched" (nothing will ever come);
 *     - its PR CLOSED unmerged, or the run finished failed/aborted short of `until` → PARK,
 *       naming the dependency and its state (G6: only a non-success END parks the dependent);
 *     - running, parked or paused short of `until` → keep waiting, and say on what (G6: a
 *       park is normal control flow, and cascading it would only be noise);
 *     - `published`: it has a publication summary and its PR is open or merged;
 *       `merged`: every PR it published merged; `package`: merged AND the workspace's
 *       `packageCheck` exits 0 (no command → merged, and the note says so).
 *     Publishes `deps.ready`, `deps.waiting` ("waiting on fe-1 · published (parked: needs
 *     you)"), `deps.base` + `deps.base_tip` (the head of the published dependency's PRIMARY PR —
 *     G7, falling back to its worktree branch) and `deps.prs` (every dependency PR, which
 *     probe:pr then ignores — G2).
 *
 *   PROBE (`deps.base_moved`, `deps.base_merged`, `deps.restack`) — in the delivery loop.
 *     Re-reads the stack base's primary PR: merged, or its head moved off the tip this branch is
 *     stacked on (the latest `base-restacked`, else the worktree's recorded base). `deps.restack`
 *     is what the graph routes on: merged, or moved while THIS run's own PR is not approved
 *     (decision B) — so it reads this run's PR too, and an approval it cannot read is not one.
 *
 * A forge that cannot be reached is NOT "no PR" (reconcile's rule) — but it is not a park here
 * either: waiting is the safe action, so the run keeps waiting and says the forge is unreachable.
 * The dependency's log is read with readLog, which tolerates a torn final line.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AttemptResult, Executor, ExecArgs } from "../run";
import { readLog } from "../../log/write";
import type { LoggedEvent } from "../../log/events";
import { replayState } from "../replay";
import { declaredWrites } from "./map";
import { readWorktreeRecord } from "./worktree-record";
import { runShell } from "./shell";
import { ForgeUnreachableError } from "./git";
import {
  AWAIT_BUILTIN, AWAIT_PRODUCES, AWAIT_PROBE_PRODUCES, AWAIT_READS, DEPS_KEY,
  parseDeps, stackBaseDep, type DepRef,
} from "../../core/stack";

export { AWAIT_BUILTIN } from "../../core/stack";

export function isAwaitBuiltin(run: string): boolean {
  return run.trim().split(/\s+/)[0] === AWAIT_BUILTIN;
}

/** What a stacked run needs to know about one PR: where it is, and what its head is. */
export interface PrHead {
  state: "OPEN" | "MERGED" | "CLOSED";
  url: string;
  headRefName: string;
  headRefOid: string;
  baseRefName?: string;
  /** reviewDecision === APPROVED */
  approved?: boolean;
}

/** `prView(cwd, ref)`: null when no PR exists; THROWS when the forge cannot be reached. */
export type PrView = (cwd: string, ref: string) => PrHead | null;

export const ghPrView: PrView = (cwd, ref) => {
  const r = Bun.spawnSync(["gh", "pr", "view", ref, "--json", "state,url,headRefName,headRefOid,baseRefName,reviewDecision"], {
    cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env },
  });
  const out = new TextDecoder().decode(r.stdout);
  const err = new TextDecoder().decode(r.stderr);
  if (r.exitCode !== 0) {
    if (/no pull requests? found/i.test(err + out)) return null;
    throw new ForgeUnreachableError(err.trim().slice(0, 200) || "gh failed");
  }
  const j = JSON.parse(out) as { state: string; url: string; headRefName: string; headRefOid: string; baseRefName?: string; reviewDecision?: string };
  const state = j.state === "MERGED" || j.state === "CLOSED" ? j.state : "OPEN";
  return { state, url: j.url, headRefName: j.headRefName, headRefOid: j.headRefOid, baseRefName: j.baseRefName, approved: j.reviewDecision === "APPROVED" };
};

export interface AwaitBuiltinOpts {
  /** `$HOWDAH_HOME/runs` — where every dependency's (and the parent's) run dir lives */
  runsDir?: string;
  prView?: PrView;
  /** config.json `packageCheck` for a repo path (HOW-57 G10) */
  packageCheckFor?: (repoPath: string) => string | undefined;
  packageCheckTimeoutMs?: number;
}

type Failed = AttemptResult & { status: "failed" };
const failed = (reason: string): Failed => ({ status: "failed", writes: {}, reason });

/** The parent's spawn record is what makes a missing dir "not yet" rather than "never" (G1). */
function spawnedByParent(runsDir: string, parent: string | undefined, child: string): boolean {
  if (!parent) return false;
  return readLog(join(runsDir, parent, "run.jsonl")).some((e) => e.type === "run-spawned" && e.child === child);
}

/** The PRs a run's publication names — the primary (the tip of its own stack) and all of them. */
export function publishedPrs(summary: unknown): { primary: string | null; all: string[] } {
  const isPr = (v: unknown): v is string => typeof v === "string" && v.includes("/pull/");
  if (typeof summary === "string") {
    const m = summary.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
    return m ? { primary: m[0], all: [m[0]] } : { primary: null, all: [] };
  }
  if (!summary || typeof summary !== "object") return { primary: null, all: [] };
  const o = summary as Record<string, unknown>;
  const list = [o.pr_urls, o.prUrls].flatMap((v) => (Array.isArray(v) ? v.filter(isPr) : []));
  const named = ["primary_pr_url", "primaryPrUrl", "pr_url", "prUrl", "url", "pull_request", "pullRequest"].map((k) => o[k]).find(isPr);
  const primary = named ?? list.at(-1) ?? null;
  return { primary, all: [...new Set([...list, ...(primary ? [primary] : [])])] };
}

/** The latest value a run published for `key`, from its own log. */
function latestWrite(events: readonly LoggedEvent[], key: string): unknown {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "node-finished" && e.status === "succeeded" && key in e.writes) return e.writes[key];
  }
  return undefined;
}

/** What one dependency looks like right now. */
export interface DepState {
  dep: DepRef;
  ready: boolean;
  /** "fe-1 · published (parked: needs you)" — the waiting line's clause for this dependency */
  line: string;
  prs: string[];
  /** the primary PR's head — the stack base when this is the published dependency */
  head?: { branch: string; sha: string };
  primary?: PrHead | null;
}

/** Why the dependent must park instead of waiting — a non-success end short of `until`. */
export class DependencyFailed extends Error {}

/**
 * Read one dependency. Throws DependencyFailed for a park; anything else it cannot decide is
 * "not ready", with a line that says why.
 */
export async function readDependency(
  dep: DepRef,
  ctx: { runsDir: string; parent: string | undefined; prView: PrView; packageCheckFor?: (repo: string) => string | undefined; packageCheckTimeoutMs?: number },
): Promise<DepState> {
  const label = `${dep.slice} · ${dep.until}`;
  const wait = (why: string, extra: Partial<DepState> = {}): DepState => ({ dep, ready: false, line: `${label} (${why})`, prs: [], ...extra });
  const runDir = join(ctx.runsDir, dep.run_id);
  const logPath = join(runDir, "run.jsonl");
  if (!existsSync(logPath)) {
    if (spawnedByParent(ctx.runsDir, ctx.parent, dep.run_id)) return wait("launched, not started yet");
    throw new DependencyFailed(
      `dependency ${dep.slice} (run ${dep.run_id}) was never launched — there is no run at ${runDir} and ` +
        `${ctx.parent ? `the parent ${ctx.parent} recorded no launch of it` : "this run has no parent to have launched it"}. ` +
        `Start it, or jump this run past the wait.`,
    );
  }
  const events = readLog(logPath);
  const replayed = replayState(events);
  const status = replayed.finished
    ? `finished ${replayed.finished.outcome}`
    : replayed.parked ? "parked: needs you"
    : replayed.paused ? "paused"
    : "running";

  const summary = latestWrite(events, "publication_summary");
  const record = readWorktreeRecord(runDir);
  const repo = record?.repo ?? replayed.started?.cwd;
  const { primary: primaryRef, all } = publishedPrs(summary);
  const refs = all.length ? all : summary !== undefined && record?.branch ? [record.branch] : [];
  const primaryAt = primaryRef ?? refs.at(-1);

  const ended = replayed.finished && replayed.finished.outcome !== "success";
  if (refs.length === 0 || !repo) {
    if (ended) throw new DependencyFailed(`dependency ${dep.slice} (run ${dep.run_id}) ${status} without publishing a PR, so "${dep.until}" can never be reached`);
    return wait(summary === undefined ? status : `${status}; published no PR`);
  }

  let prs: PrHead[];
  try {
    prs = refs.flatMap((ref) => {
      const pr = ctx.prView(repo, ref);
      return pr ? [pr] : [];
    });
  } catch (err) {
    return wait(`${status}; ${err instanceof Error ? err.message : String(err)}`);
  }
  const urls = prs.map((p) => p.url);
  const primary = prs.find((p) => p.url === primaryAt || p.headRefName === primaryAt) ?? prs.at(-1) ?? null;
  const head = primary
    ? { branch: primary.headRefName, sha: primary.headRefOid }
    : record?.branch ? { branch: record.branch, sha: "" } : undefined;
  const known: Partial<DepState> = { prs: urls, primary, ...(head ? { head } : {}) };

  if (prs.length === 0) {
    if (ended) throw new DependencyFailed(`dependency ${dep.slice} (run ${dep.run_id}) ${status} and its PR cannot be found`);
    return wait(`${status}; no PR found yet`, known);
  }
  // a closed PR beside open ones is a stack PR mid-flight (stackPrState's rule); with none open
  // it is the end of the line
  const closed = prs.find((p) => p.state === "CLOSED");
  if (closed && !prs.some((p) => p.state === "OPEN"))
    throw new DependencyFailed(`dependency ${dep.slice} (run ${dep.run_id}): its PR ${closed.url} was CLOSED without merging, so "${dep.until}" can never be reached`);

  const merged = prs.every((p) => p.state === "MERGED");
  if (dep.until === "published") return { dep, ready: true, line: `${label} (${merged ? "merged" : "published"})`, ...known, prs: urls };
  if (!merged) {
    if (ended) throw new DependencyFailed(`dependency ${dep.slice} (run ${dep.run_id}) ${status} before its PR merged, so "${dep.until}" can never be reached`);
    return wait(`${status}; PR open`, known);
  }
  if (dep.until === "merged") return { dep, ready: true, line: `${label} (merged)`, ...known, prs: urls };

  // package (G10): merged AND the workspace's package check passes
  const command = repo ? ctx.packageCheckFor?.(repo) : undefined;
  if (!command) return { dep, ready: true, line: `${label} (merged; no packageCheck configured for ${dep.workspace}, so merged counts as published)`, ...known, prs: urls };
  const r = await runShell(command, { cwd: repo, timeoutMs: ctx.packageCheckTimeoutMs ?? 120_000 });
  if (r.exitCode === 0) return { dep, ready: true, line: `${label} (merged; package check passed)`, ...known, prs: urls };
  return wait(`merged; package not available yet — \`${command}\` ${r.timedOut ? "timed out" : `exited ${r.exitCode}`}`, known);
}

/** The sha this run's branch is stacked on now: the latest restack's target, else the worktree's base. */
export function recordedBaseTip(events: readonly LoggedEvent[], runDir: string): string | null {
  const restacked = events.findLast((e) => e.type === "base-restacked");
  if (restacked?.type === "base-restacked") return restacked.to.sha;
  return readWorktreeRecord(runDir)?.base_sha ?? null;
}

export function awaitBuiltinExecutor(opts: AwaitBuiltinOpts = {}): Executor {
  return async (args) => {
    const { def, nodeId, visit, log, reads } = args;
    if (def.kind !== "command") throw new Error("runs:await on a non-command node");
    const runsDir = opts.runsDir;
    if (!runsDir) return failed(`${AWAIT_BUILTIN} has no runs directory to read dependencies from (the executor was built without one)`);
    const checked = precheck(def);
    if (typeof checked === "object") return checked;
    const mode = checked;
    const parsed = parseDeps(reads[DEPS_KEY]);
    if (!parsed.ok) return failed(`${AWAIT_BUILTIN}: ${parsed.reason}`);

    let index = 0;
    const note = (content: string) => log.append({ type: "chunk", node: nodeId, visit, turn: 1, index: index++, kind: "text", content: `${content}\n` });
    const events = log.read();
    const started = events.find((e) => e.type === "run-started");
    const parent = started?.type === "run-started" ? started.parent : undefined;
    const ctx = { runsDir, parent, prView: opts.prView ?? ghPrView, packageCheckFor: opts.packageCheckFor, packageCheckTimeoutMs: opts.packageCheckTimeoutMs };

    if (mode === "probe") return probe(args, parsed.deps, ctx, note, events);

    // a DependencyFailed throw parks the run, naming the dependency and its state
    const states: DepState[] = [];
    for (const dep of parsed.deps) states.push(await readDependency(dep, ctx));
    for (const s of states) note(`${s.ready ? "ready" : "waiting"}: ${s.line}`);
    const pending = states.filter((s) => !s.ready);
    const base = stackBaseDep(parsed.deps);
    const head = (base ? states.find((s) => s.dep === base) : undefined)?.head;
    const waiting = pending.length ? `waiting on ${pending.map((s) => s.line).join("; ")}` : "";
    const prs = [...new Set(states.flatMap((s) => s.prs))];
    return {
      status: "succeeded",
      writes: declaredWrites(AWAIT_BUILTIN, def, {
        "deps.ready": pending.length === 0,
        "deps.waiting": waiting,
        "deps.base": head?.branch ?? "",
        "deps.base_tip": head?.sha ?? "",
        "deps.prs": prs,
      }),
    };
  };
}

async function probe(
  args: ExecArgs,
  deps: DepRef[],
  ctx: Parameters<typeof readDependency>[1],
  note: (s: string) => void,
  events: readonly LoggedEvent[],
): Promise<AttemptResult> {
  const { def, reads, log } = args;
  const produced = (moved: boolean, merged: boolean, restack: boolean) => ({
    status: "succeeded" as const,
    writes: declaredWrites(AWAIT_BUILTIN, def, { "deps.base_moved": moved, "deps.base_merged": merged, "deps.restack": restack }),
  });
  const base = stackBaseDep(deps);
  // `deps.base` is "" once a merged base was restacked away: this run is not stacked any more
  const current = typeof reads["deps.base"] === "string" ? (reads["deps.base"] as string) : undefined;
  if (!base || current === "") {
    note(base ? "the stack base already merged and this branch was replayed onto the default branch" : "no stack base");
    return produced(false, false, false);
  }
  const state = await readDependency({ ...base, until: "published" }, ctx);
  const pr = state.primary;
  if (!pr) {
    note(`stack base ${base.slice}: ${state.line}`);
    return produced(false, false, false);
  }
  // this run's own PR: a merged or closed one is not restacked, and an approved one only when
  // its base merged (decision B) — an approval that cannot be read is not one
  const own = ownPr(args, ctx.prView, note);
  if (own && own.state !== "OPEN") {
    note(`this run's PR is ${own.state} — nothing to restack`);
    return produced(false, pr.state === "MERGED", false);
  }
  if (pr.state === "MERGED") {
    note(`stack base ${base.slice} MERGED (${pr.url})`);
    return produced(false, true, true);
  }
  const recorded = recordedBaseTip(events, dirname(log.path));
  const moved = recorded !== null && pr.headRefOid !== "" && pr.headRefOid !== recorded;
  const approved = own?.approved === true;
  note(
    `stack base ${base.slice} @ ${pr.headRefOid.slice(0, 12)}${moved ? ` — MOVED from ${recorded!.slice(0, 12)}` : " — unchanged"}` +
      (moved && approved ? "; this PR is approved, so it is not restacked until the base merges" : ""),
  );
  return produced(moved, false, moved && !approved);
}

/** This run's own primary PR, from its publication (else its branch); null when unreadable. */
function ownPr(args: ExecArgs, prView: PrView, note: (s: string) => void): PrHead | null {
  const record = readWorktreeRecord(dirname(args.log.path));
  if (!record) return null;
  const ref = publishedPrs(args.reads.publication_summary).primary ?? record.branch;
  try {
    return prView(record.repo, ref);
  } catch (err) {
    note(`could not read this run's PR (${err instanceof Error ? err.message : String(err)}) — treating it as not approved is unsafe, so a moved base waits`);
    return { state: "OPEN", url: ref, headRefName: record.branch, headRefOid: "", approved: true };
  }
}

/** The mode the node's declaration asks for, or the refusal — before anything is read. */
function precheck(def: Extract<ExecArgs["def"], { kind: "command" }>): "await" | "probe" | Failed {
  const declaredReads = (def.reads ?? []) as readonly string[];
  for (const key of AWAIT_READS)
    if (!declaredReads.includes(key))
      return failed(`${AWAIT_BUILTIN} reads "${key}", which this node does not declare (it declares: ${declaredReads.join(", ") || "nothing"})`);
  const writes = Object.keys(def.writes ?? {});
  const probeKeys = AWAIT_PROBE_PRODUCES as readonly string[];
  const awaitKeys = AWAIT_PRODUCES as readonly string[];
  const isProbe = writes.some((k) => probeKeys.includes(k));
  const allowed = isProbe ? probeKeys : awaitKeys;
  const wrong = writes.filter((k) => !allowed.includes(k));
  if (wrong.length)
    return failed(
      `${AWAIT_BUILTIN} ${isProbe ? "in probe mode publishes only" : "publishes only"} ${allowed.join(", ")} — ` +
        `it cannot produce ${wrong.join(", ")}${isProbe ? "" : ` (declare ${probeKeys.join(" / ")} for probe mode, and nothing else)`}`,
    );
  return isProbe ? "probe" : "await";
}
