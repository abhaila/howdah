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
 * THE BRANCH STARTS FROM WHAT ORIGIN HAS, NOT FROM WHAT THE CLONE HAPPENS TO HAVE CHECKED OUT
 * (HOW-57, decision C). Before HOW-57 `git worktree add` had no start point, so every run
 * branched from the operator's clone's current HEAD — a feature branch, a stale main, unpushed
 * experiments. Now `create` fetches and branches from:
 *   1. `deps.base` when the node reads it (implement-stacked: the dependency's PR head), at
 *      `deps.base_tip` when that commit is present — refused, never guessed, when it is nowhere;
 *   2. otherwise `origin/<default>` (config `defaultBranch`, else origin's HEAD, else
 *      main/master), saying so when local HEAD has commits origin lacks ("not used");
 *   3. otherwise — no `origin`, a failed fetch, no remote default — HEAD, exactly as before,
 *      and the thread says why. A repo with no remote must keep working (regression-tested).
 * The chosen base, its sha and local HEAD are recorded on the effect and in worktree.json:
 * the log is the record, and the base sha is the first tip a restack replays from.
 *
 * COMMAND: `bash -c <script>` with a 10-minute default timeout (Orbital parity), stdout
 * streamed as chunks, and declared facts read from THE FINAL JSON LINE of stdout. The
 * built-in `probe:pr` routes through the reconciler: gh is the source, forge-unreachable
 * THROWS (parks the run) rather than reading as "no PR". The map built-ins (map:extract,
 * map:reextract, map:drift — system-map 1c, engine/executors/map.ts) dispatch from here too,
 * as does `runs:launch` (HOW-23, engine/executors/launch.ts), `verify:run` (HOW-12,
 * engine/executors/verify.ts) and HOW-57's `runs:await` / `git:restack` (await.ts, restack.ts). The spawn/stream/timeout half lives in ./shell.ts, shared with
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
import { evidenceBuiltinExecutor, isEvidenceBuiltin, type EvidenceBuiltinOpts } from "./evidence";
import { runShell } from "./shell";
import { awaitBuiltinExecutor, isAwaitBuiltin, type AwaitBuiltinOpts } from "./await";

export { type WorktreeRecord, worktreeRecordPath, readWorktreeRecord, effectiveCwd } from "./worktree-record";

function sh(cmd: string[], cwd?: string, timeoutMs?: number): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(cmd, {
    cwd, stdout: "pipe", stderr: "pipe",
    // never let git sit on a credential prompt nobody can answer
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  });
  return { code: r.exitCode ?? 1, stdout: new TextDecoder().decode(r.stdout), stderr: new TextDecoder().decode(r.stderr) };
}

/** How long a worktree create waits on `git fetch` before branching from HEAD instead. */
export const FETCH_TIMEOUT_MS = 60_000;

/** The ref and sha a new worktree branch starts from, and what the operator should be told. */
export interface WorktreeBase {
  /** what was passed to `git worktree add` as the start point */
  ref: string;
  sha: string;
  /** the clone's HEAD at the time — recorded beside the base, never used as it */
  localHead: string | null;
  /** commits HEAD has that the default base lacks (default-branch path only) */
  ahead?: number;
  /** thread lines: which base, and why when it is not the one asked for */
  notes: string[];
}

const revParse = (repo: string, ref: string): string | null => {
  const r = sh(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo);
  return r.code === 0 ? r.stdout.trim() || null : null;
};

/**
 * Decide where a new worktree branch starts (HOW-57, decision C). Throws only for a stack base
 * that cannot be found anywhere — branching a stacked slice from main instead would build it on
 * the wrong code and nobody would notice until review.
 */
export function resolveWorktreeBase(repo: string, opts: { stackBase?: string; stackTip?: string; defaultBranch?: string } = {}): WorktreeBase {
  const notes: string[] = [];
  const localHead = revParse(repo, "HEAD");
  const headLabel = sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo).stdout.trim() || "HEAD";
  const hasOrigin = sh(["git", "remote", "get-url", "origin"], repo).code === 0;
  let fetched = false;
  if (hasOrigin) {
    const f = sh(["git", "fetch", "--quiet", "--prune", "origin"], repo, FETCH_TIMEOUT_MS);
    fetched = f.code === 0;
    if (!fetched) notes.push(`git fetch origin failed (${(f.stderr.trim() || `exit ${f.code}`).slice(0, 200)}); using what this clone already has`);
  }

  const head = (why: string): WorktreeBase => {
    if (!localHead) throw new Error("worktree create: this repository has no commits to branch from");
    notes.push(`${why} — branching from HEAD (${headLabel} @ ${localHead.slice(0, 12)}), as before`);
    return { ref: "HEAD", sha: localHead, localHead, notes };
  };

  if (opts.stackBase) {
    const branch = opts.stackBase;
    // the exact commit the dependency published, when this clone has it; else its branch
    const candidates = [
      ...(opts.stackTip ? [opts.stackTip] : []),
      `refs/remotes/origin/${branch}`,
      `refs/heads/${branch}`,
    ];
    for (const ref of candidates) {
      const sha = revParse(repo, ref);
      if (!sha) continue;
      const shown = ref.replace(/^refs\/remotes\//, "").replace(/^refs\/heads\//, "");
      notes.push(`worktree base: stacked on ${branch} @ ${sha.slice(0, 12)} (from ${shown}${ref === opts.stackTip ? ", the tip the dependency published" : ""})`);
      return { ref: sha, sha, localHead, notes };
    }
    throw new Error(
      `base branch "${branch}" not found on origin${fetched ? "" : " (and the fetch did not succeed)"} or in this clone` +
        `${opts.stackTip ? `, nor its tip ${opts.stackTip.slice(0, 12)}` : ""} — the dependency's branch must be pushed before this slice can stack on it`,
    );
  }

  if (!hasOrigin) return head("no `origin` remote");
  const candidates = [
    ...(opts.defaultBranch ? [opts.defaultBranch] : []),
    sh(["git", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repo).stdout.trim().replace(/^origin\//, ""),
    "main",
    "master",
  ].filter((b) => b !== "");
  for (const b of candidates) {
    const sha = revParse(repo, `refs/remotes/origin/${b}`);
    if (!sha) continue;
    const ref = `origin/${b}`;
    const ahead = localHead ? Number(sh(["git", "rev-list", "--count", `${sha}..${localHead}`], repo).stdout.trim()) || 0 : 0;
    notes.push(`worktree base: ${ref} @ ${sha.slice(0, 12)}${fetched ? "" : " (not refreshed: the fetch failed)"}`);
    if (ahead > 0) notes.push(`your local ${headLabel} is ${ahead} commit${ahead === 1 ? "" : "s"} ahead of ${ref}; not used`);
    return { ref, sha, localHead, ahead, notes };
  }
  return head(fetched ? "origin has no default branch this clone can see" : "the fetch failed and origin has no default branch in this clone");
}

export interface WorktreeExecutorOpts {
  /** $HOWDAH_HOME/repos — each repo gets `<reposDir>/<name>/worktrees/<runId>` */
  reposDir: string;
  /** repo path → the folder name its worktrees live under (default: the directory name) */
  repoName?: (repoPath: string) => string;
  /** HOW-44: the workspace's verify command for a repo path — published as worktree.verify_command */
  verifyCommandFor?: (repoPath: string) => string | undefined;
  /** HOW-57: config.json `defaultBranch` for a repo path — the branch a new worktree starts from */
  defaultBranchFor?: (repoPath: string) => string | undefined;
}

const nonEmpty = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

export function worktreeExecutor(opts: WorktreeExecutorOpts): Executor {
  return async ({ def, nodeId, visit, runId, cwd, log, reads, effects }) => {
    if (def.kind !== "worktree") throw new Error("worktreeExecutor on non-worktree node");
    const runDir = dirname(log.path);
    let index = 0;
    const note = (content: string) => log.append({ type: "chunk", node: nodeId, visit, turn: 1, index: index++, kind: "text", content: `${content}\n` });

    if (def.action === "create") {
      // HOW-44: the verify command, when the step declares it — "" (never absent) when the
      // workspace has none, so a prompt's {{#if}} reads a defined value either way
      const writes: Record<string, unknown> = {};
      if (def.writes && "worktree.verify_command" in def.writes)
        writes["worktree.verify_command"] = (cwd && opts.verifyCommandFor?.(cwd)) || "";
      const existing = readWorktreeRecord(runDir);
      if (existing) return { status: "succeeded", writes }; // idempotent re-visit
      if (!cwd) throw new Error("worktree create needs a repo workspace (run has no cwd)");
      const branch = `howdah/${runId}`;
      // grouped by repo: one repo's runs sit together, and `git worktree list` in that repo
      // matches one directory instead of a flat pile shared with every other repo
      const worktreesDir = join(opts.reposDir, (opts.repoName ?? basename)(cwd), "worktrees");
      const path = join(worktreesDir, runId);
      let record: WorktreeRecord = { path, branch, repo: cwd };
      if (!effects.claim("worktree-create")) {
        mkdirSync(worktreesDir, { recursive: true });
        // HOW-57 (decision C): a deliberate start point, never the clone's checked-out HEAD
        const base = resolveWorktreeBase(cwd, {
          stackBase: nonEmpty(reads["deps.base"]),
          stackTip: nonEmpty(reads["deps.base_tip"]),
          defaultBranch: opts.defaultBranchFor?.(cwd),
        });
        for (const line of base.notes) note(line);
        const r = sh(["git", "worktree", "add", "-b", branch, path, base.sha], cwd);
        if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim().slice(0, 300)}`);
        record = { ...record, base: base.ref, base_sha: base.sha };
        effects.done("worktree-create", {
          path, branch, base: base.ref, base_sha: base.sha, local_head: base.localHead,
          ...(base.ahead !== undefined ? { ahead: base.ahead } : {}),
        });
      } else {
        // proven done on an earlier attempt that died before writing the record: the effect's
        // own result is where the base was written down
        const done = log.read().findLast((e) => e.type === "side-effect-done" && e.node === nodeId && e.effect === "worktree-create");
        const result = done?.type === "side-effect-done" && done.result && typeof done.result === "object" ? (done.result as Record<string, unknown>) : {};
        if (typeof result.base === "string" && typeof result.base_sha === "string") record = { ...record, base: result.base, base_sha: result.base_sha };
      }
      writeFileSync(worktreeRecordPath(runDir), JSON.stringify(record satisfies WorktreeRecord, null, 2));
      return { status: "succeeded", writes };
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
  /** HOW-52: which preview `evidence:screenshot` starts for a repo */
  evidence?: EvidenceBuiltinOpts;
  /** HOW-57: where `runs:await` reads dependency runs from, and the package check it runs */
  await?: AwaitBuiltinOpts;
}

export function commandExecutor(opts: CommandExecutorOpts = {}): Executor {
  const mapBuiltins = mapBuiltinExecutor(opts.map);
  const launchBuiltin = launchBuiltinExecutor(opts.launch);
  const verifyBuiltin = verifyBuiltinExecutor({ defaultTimeoutMs: opts.defaultTimeoutMs, ...opts.verify });
  const evidenceBuiltin = evidenceBuiltinExecutor(opts.evidence);
  const awaitBuiltin = awaitBuiltinExecutor(opts.await);
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
    // HOW-52: `evidence:screenshot` starts the preview and captures it — same rule as verify:
    // a preview that will not come up is evidence for the reviewer, not a failed attempt
    if (isEvidenceBuiltin(def.run)) return evidenceBuiltin(args);
    // HOW-57: `runs:await` reads OTHER runs' logs — a stacked run waits on its dependencies
    if (isAwaitBuiltin(def.run)) return awaitBuiltin(args);
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
