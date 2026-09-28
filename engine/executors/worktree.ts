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
 * engine/executors/verify.ts).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { effectiveCwd, readWorktreeRecord, worktreeRecordPath, type WorktreeRecord } from "./worktree-record";
import { basename, dirname, join } from "node:path";
import type { Executor } from "../run";
import { probeGit, ghForgeProbe, type ForgeProbe } from "../reconcile";
import { isMapBuiltin, mapBuiltinExecutor, type MapBuiltinOpts } from "./map";
import { isLaunchBuiltin, launchBuiltinExecutor, type LaunchBuiltinOpts } from "./launch";
import { isVerifyBuiltin, verifyBuiltinExecutor, type VerifyBuiltinOpts } from "./verify";

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

function publicationPrRef(publicationSummary: unknown): string | null {
  if (!publicationSummary) return null;
  if (typeof publicationSummary === "string") {
    const match = publicationSummary.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
    return match?.[0] ?? null;
  }
  if (typeof publicationSummary !== "object") return null;
  const obj = publicationSummary as Record<string, unknown>;
  for (const key of ["pr_url", "prUrl", "url", "pull_request", "pullRequest"]) {
    const value = obj[key];
    if (typeof value === "string" && value.includes("/pull/")) return value;
  }
  return null;
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
  /** HOW-12: where `verify:run` finds the workspace's registered verification command */
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
    // HOW-12: `verify:run` runs the WORKSPACE's command, and a red result is a verdict to
    // route on rather than a failed attempt to park on
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
      const prRef = publicationPrRef(reads.publication_summary) ?? branch;
      chunk("tool_call", `gh pr view ${prRef}`);
      const pr = (opts.prProbe ?? ghPrProbe)(record?.repo ?? workDir, prRef);
      if (pr === null) throw new Error(`no PR exists for "${prRef}" — was publish skipped?`);
      chunk("tool_result", `${pr.state} ${pr.url}`);
      log.append({
        type: "reconciled", node: nodeId,
        git: probeGit(workDir),
        forge: { kind: "pr", state: pr.state, url: pr.url },
        disagreements: [],
      });
      return { status: "succeeded", writes: declared.includes("pr.state") ? { "pr.state": pr.state } : {} };
    }

    // general command: bash -c, stream stdout, facts from the FINAL JSON line
    chunk("tool_call", def.run);
    const proc = Bun.spawn(["bash", "-c", def.run], { cwd: workDir, stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    const timeoutMs = def.timeoutMs ?? opts.defaultTimeoutMs ?? 600_000;
    const killer = setTimeout(() => proc.kill(), timeoutMs);
    let stdout = "";
    for await (const bytes of proc.stdout) {
      const text = new TextDecoder().decode(bytes);
      stdout += text;
      chunk("text", text);
    }
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    clearTimeout(killer);

    if (proc.exitCode !== 0) {
      chunk("tool_result", `exit ${proc.exitCode}: ${stderr.slice(0, 300)}`);
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
