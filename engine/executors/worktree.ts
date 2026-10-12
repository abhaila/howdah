/**
 * Worktree + command executors (T18).
 *
 * WORKTREE: `create` makes an isolated checkout under
 * $HOWDAH_HOME/repos/<repo>/worktrees/<runId> on a fresh `howdah/<runId>` branch and
 * records it in the run dir (worktree.json) — every
 * later executor resolves its effective cwd through that record, so the run "moves into"
 * the worktree without the engine mutating state. `remove` deletes worktree + branch and
 * emits the facts the graphs route on (worktree.clean / outcome). A dirty worktree
 * refuses to die (Orbital's cleanup semantics: preserve local work; the graph's
 * cleanup_pending edge handles it).
 *
 * COMMAND: `bash -c <script>` with a 10-minute default timeout (Orbital parity), stdout
 * streamed as chunks, and declared facts read from THE FINAL JSON LINE of stdout. The
 * built-in `probe:pr` routes through the reconciler: gh is the source, forge-unreachable
 * THROWS (parks the run) rather than reading as "no PR". The map built-ins (map:extract,
 * map:reextract, map:drift — system-map 1c, engine/executors/map.ts) dispatch from here too,
 * as does `runs:launch` (HOW-23, engine/executors/launch.ts) and `verify:run` (HOW-12,
 * engine/executors/verify.ts). The spawn/stream/timeout half lives in ./shell.ts, shared with
 * verify:run.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { effectiveCwd, readWorktreeRecord, worktreeRecordPath, type WorktreeRecord } from "./worktree-record";
import { basename, dirname, join } from "node:path";
import type { Executor } from "../run";
import { probeGit, ghForgeProbe, type ForgeProbe } from "../reconcile";
import { isMapBuiltin, mapBuiltinExecutor, type MapBuiltinOpts } from "./map";
import { isLaunchBuiltin, launchBuiltinExecutor, type LaunchBuiltinOpts } from "./launch";
import { isVerifyBuiltin, verifyBuiltinExecutor, type VerifyBuiltinOpts } from "./verify";
import { runShell } from "./shell";

export { type WorktreeRecord, worktreeRecordPath, readWorktreeRecord, effectiveCwd } from "./worktree-record";

function sh(cmd: string[], cwd?: string): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  return { code: r.exitCode ?? 1, stdout: new TextDecoder().decode(r.stdout), stderr: new TextDecoder().decode(r.stderr) };
}

export interface WorktreeExecutorOpts {
  /** $HOWDAH_HOME/repos — each repo gets `<reposDir>/<name>/worktrees/<runId>` */
  reposDir: string;
  /** repo path → the folder name its worktrees live under (default: the directory name) */
  repoName?: (repoPath: string) => string;
}

export function worktreeExecutor(opts: WorktreeExecutorOpts): Executor {
  return async ({ def, runId, cwd, log, effects }) => {
    if (def.kind !== "worktree") throw new Error("worktreeExecutor on non-worktree node");
    const runDir = dirname(log.path);

    if (def.action === "create") {
      const existing = readWorktreeRecord(runDir);
      if (existing) return { status: "succeeded", writes: {} }; // idempotent re-visit
      if (!cwd) throw new Error("worktree create needs a repo workspace (run has no cwd)");
      const branch = `howdah/${runId}`;
      // grouped by repo: one repo's runs sit together, and `git worktree list` in that repo
      // matches one directory instead of a flat pile shared with every other repo
      const worktreesDir = join(opts.reposDir, (opts.repoName ?? basename)(cwd), "worktrees");
      const path = join(worktreesDir, runId);
      if (!effects.claim("worktree-create")) {
        mkdirSync(worktreesDir, { recursive: true });
        const r = sh(["git", "worktree", "add", "-b", branch, path], cwd);
        if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim().slice(0, 300)}`);
        effects.done("worktree-create", { path, branch });
      }
      writeFileSync(worktreeRecordPath(runDir), JSON.stringify({ path, branch, repo: cwd } satisfies WorktreeRecord, null, 2));
      return { status: "succeeded", writes: {} };
    }

    // remove: refuse to destroy local work — dirty/unpushed keeps the worktree
    const record = readWorktreeRecord(runDir);
    const writes: Record<string, unknown> = {};
    const declared = new Set(Object.keys(def.writes ?? {}));
    if (!record) {
      if (declared.has("worktree.clean")) writes["worktree.clean"] = true; // nothing to clean
      if (declared.has("outcome")) writes["outcome"] = "removed";
      return { status: "succeeded", writes };
    }
    const g = probeGit(record.path);
    if (g.uncommitted > 0) {
      if (declared.has("worktree.clean")) writes["worktree.clean"] = false;
      if (declared.has("outcome")) writes["outcome"] = "failed";
      return { status: "succeeded", writes }; // the graph's retained/pending edge decides
    }
    const rm = sh(["git", "worktree", "remove", record.path], record.repo);
    if (rm.code !== 0) {
      if (declared.has("worktree.clean")) writes["worktree.clean"] = false;
      if (declared.has("outcome")) writes["outcome"] = "failed";
      return { status: "succeeded", writes };
    }
    sh(["git", "branch", "-D", record.branch], record.repo); // best-effort: merged branches may be gone
    rmSync(worktreeRecordPath(runDir), { force: true });
    if (declared.has("worktree.clean")) writes["worktree.clean"] = true;
    if (declared.has("outcome")) writes["outcome"] = "removed";
    return { status: "succeeded", writes };
  };
}

// ---- command --------------------------------------------------------------------

export type PrState = "OPEN" | "MERGED" | "CLOSED" | "CONFLICTS" | "CI_FAILED" | "CHANGES_REQUIRED";

/** derive the routing state the graphs consume from gh's PR view */
export function derivePrState(pr: { state: string; mergeable?: string; reviewDecision?: string; failedChecks?: boolean }): PrState {
  if (pr.state === "MERGED") return "MERGED";
  if (pr.state === "CLOSED") return "CLOSED";
  if (pr.mergeable === "CONFLICTING") return "CONFLICTS";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "CHANGES_REQUIRED";
  if (pr.failedChecks) return "CI_FAILED";
  return "OPEN";
}

function isFailedCheck(check: { conclusion?: string | null; state?: string | null; bucket?: string | null }): boolean {
  const status = (check.conclusion ?? check.state ?? check.bucket ?? "").toUpperCase();
  return ["FAILURE", "FAILED", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(status);
}

/**
 * Every PR a publish reported, base of the stack first. A stacked publish lists them all
 * (`pr_urls`) and names the tip as its primary; probe:pr watches EVERY one, because a ticket
 * shipped as a stack is only as healthy as its worst PR and only done when all of them land.
 * Empty means the summary names no PR and the run's branch is the fallback.
 */
export function publicationPrRefs(publicationSummary: unknown): string[] {
  if (!publicationSummary) return [];
  if (typeof publicationSummary === "string") {
    // prose may cite someone else's PR, so only its first link is taken to be the publish's own
    const match = publicationSummary.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
    return match ? [match[0]] : [];
  }
  if (typeof publicationSummary !== "object") return [];
  const obj = publicationSummary as Record<string, unknown>;
  const isPr = (v: unknown): v is string => typeof v === "string" && v.includes("/pull/");
  const refs: string[] = [];
  for (const key of ["pr_urls", "prUrls"]) {
    const value = obj[key];
    if (Array.isArray(value)) refs.push(...value.filter(isPr));
  }
  for (const key of ["primary_pr_url", "primaryPrUrl", "pr_url", "prUrl", "url", "pull_request", "pullRequest"]) {
    const value = obj[key];
    if (isPr(value)) refs.push(value);
  }
  return [...new Set(refs)];
}

/** most urgent first — the same precedence derivePrState gives one PR */
const REPAIR_ORDER: PrState[] = ["CONFLICTS", "CHANGES_REQUIRED", "CI_FAILED"];

/**
 * Fold a stack's PR states into the one `pr.state` delivery routes on. MERGED only when every
 * PR has landed. Otherwise the most urgent repair any PR needs wins, the LOWEST such PR in
 * the stack first, since a fix there carries up through every branch built on it. A PR that
 * closed while others are still open does not abandon the ticket (a stack PR is closed and
 * reopened, or superseded, mid-flight): the run keeps polling, and CLOSED is reported only
 * once nothing is open and not everything merged. Returns the index of the PR that decided.
 */
export function stackPrState(states: readonly PrState[]): { state: PrState; decidedBy: number } {
  if (states.length === 0) throw new Error("stackPrState: no PRs");
  if (states.every((s) => s === "MERGED")) return { state: "MERGED", decidedBy: states.length - 1 };
  for (const want of REPAIR_ORDER) {
    const i = states.indexOf(want);
    if (i !== -1) return { state: want, decidedBy: i };
  }
  const open = states.indexOf("OPEN");
  if (open !== -1) return { state: "OPEN", decidedBy: open };
  return { state: "CLOSED", decidedBy: states.indexOf("CLOSED") };
}

function requiredChecksFailed(cwd: string, prRef: string): boolean | null {
  const r = sh(["gh", "pr", "checks", prRef, "--required", "--json", "name,state,bucket"], cwd);
  if (r.code !== 0) return null;
  try {
    const checks = JSON.parse(r.stdout) as Array<{ state?: string | null; bucket?: string | null }>;
    return checks.some(isFailedCheck);
  } catch {
    return null;
  }
}

/** gh probe with the fields routing needs; unreachable THROWS — absence of evidence parks */
export const ghPrProbe = (cwd: string, prRef: string): { state: PrState; url: string } | null => {
  const r = sh(["gh", "pr", "view", prRef, "--json", "state,url,mergeable,reviewDecision,statusCheckRollup"], cwd);
  if (r.code !== 0) {
    if (/no pull requests? found/i.test(r.stderr + r.stdout)) return null;
    throw new Error(`forge unreachable: ${r.stderr.trim().slice(0, 200) || "gh failed"}`);
  }
  const j = JSON.parse(r.stdout) as { state: string; url: string; mergeable?: string; reviewDecision?: string; statusCheckRollup?: Array<{ conclusion?: string; state?: string }> };
  const failedChecks = requiredChecksFailed(cwd, j.url) ?? (j.statusCheckRollup ?? []).some(isFailedCheck);
  return { state: derivePrState({ ...j, failedChecks }), url: j.url };
};

export interface CommandExecutorOpts {
  /** injectable pr probe for tests; default gh */
  prProbe?: typeof ghPrProbe;
  defaultTimeoutMs?: number;
  /** the map built-ins' store / workers / throttle (system-map 1c) */
  map?: MapBuiltinOpts;
  /** HOW-23: where `runs:launch` launches children from, and what it launches them through */
  launch?: LaunchBuiltinOpts;
  /** HOW-12: which command `verify:run` runs for a repo, and its timeout */
  verify?: VerifyBuiltinOpts;
}

export function commandExecutor(opts: CommandExecutorOpts = {}): Executor {
  const mapBuiltins = mapBuiltinExecutor(opts.map);
  const launchBuiltin = launchBuiltinExecutor(opts.launch);
  const verifyBuiltin = verifyBuiltinExecutor({ defaultTimeoutMs: opts.defaultTimeoutMs, ...opts.verify });
  return async (args) => {
    const { nodeId, def, visit, cwd, log, reads } = args;
    if (def.kind !== "command") throw new Error("commandExecutor on non-command node");
    // built-ins: map:extract / map:reextract / map:drift run in-process with the node's reads
    if (isMapBuiltin(def.run)) return mapBuiltins(args);
    // HOW-23: `runs:launch` spawns a child run per approved slice — exactly-once, so it needs
    // the engine's effects handle rather than a shell
    if (isLaunchBuiltin(def.run)) return launchBuiltin(args);
    // HOW-12: `verify:run` runs the workspace's tests and publishes a verdict — a failing suite
    // is evidence for the reviewer, not a failed attempt, so it cannot share the general path
    if (isVerifyBuiltin(def.run)) return verifyBuiltin(args);
    const workDir = effectiveCwd(log.path, cwd);
    const declared = Object.keys(def.writes ?? {});
    let index = 0;
    const chunk = (kind: "tool_call" | "tool_result" | "text", content: string) =>
      log.append({ type: "chunk", node: nodeId, visit, turn: 1, index: index++, kind, content });

    // built-in: probe:pr — the reconciler is the only source of PR truth (A6.2)
    if (def.run === "probe:pr") {
      if (!workDir) throw new Error("probe:pr needs a working directory");
      const record = readWorktreeRecord(dirname(log.path));
      const branch = record?.branch ?? probeGit(workDir).branch;
      if (!branch) throw new Error("probe:pr: no branch to probe");
      const refs = publicationPrRefs(reads.publication_summary);
      const prRefs = refs.length > 0 ? refs : [branch];
      const probe = opts.prProbe ?? ghPrProbe;
      const prs = prRefs.map((prRef) => {
        chunk("tool_call", `gh pr view ${prRef}`);
        const pr = probe(record?.repo ?? workDir, prRef);
        if (pr === null) throw new Error(`no PR exists for "${prRef}" — was publish skipped?`);
        chunk("tool_result", `${pr.state} ${pr.url}`);
        return pr;
      });
      const { state, decidedBy } = stackPrState(prs.map((p) => p.state));
      const decider = prs[decidedBy];
      if (decider === undefined) throw new Error(`probe:pr: no PR at stack index ${decidedBy}`);
      if (prs.length > 1) chunk("text", `stack of ${prs.length} PRs → ${state} (decided by ${decider.url})`);
      log.append({
        type: "reconciled", node: nodeId,
        git: probeGit(workDir),
        forge: { kind: "pr", state, url: decider.url },
        disagreements: [],
      });
      return { status: "succeeded", writes: declared.includes("pr.state") ? { "pr.state": state } : {} };
    }

    // general command: bash -c, stream stdout, facts from the FINAL JSON line
    chunk("tool_call", def.run);
    const { stdout, stderr, exitCode } = await runShell(def.run, {
      cwd: workDir,
      timeoutMs: def.timeoutMs ?? opts.defaultTimeoutMs ?? 600_000,
      onStdout: (text) => chunk("text", text),
    });

    if (exitCode !== 0) {
      chunk("tool_result", `exit ${exitCode}: ${stderr.slice(0, 300)}`);
      return { status: "failed", writes: {} };
    }
    if (declared.length === 0) return { status: "succeeded", writes: {} };
    const lastLine = stdout.trim().split("\n").at(-1) ?? "";
    try {
      const facts = JSON.parse(lastLine) as Record<string, unknown>;
      const missing = declared.filter((k) => !(k in facts));
      if (missing.length) throw new Error(`facts missing: ${missing.join(", ")}`);
      return { status: "succeeded", writes: Object.fromEntries(declared.map((k) => [k, facts[k]])) };
    } catch (err) {
      chunk("tool_result", `final line is not the declared facts JSON: ${err instanceof Error ? err.message : String(err)}`);
      return { status: "failed", writes: {} };
    }
  };
}

export { type ForgeProbe };
