#!/usr/bin/env bun
/**
 * Paired A/B evaluation (HOW-42) — run two (or more) prompts or agent configs on the SAME cases
 * and report success, cost and significance, the way the harness-design study (HOW-32) judged
 * every component it varied:
 *
 *   bun reviser/eval/ab.ts --cases <dir> --a <variant> --b <variant> [--b <variant>…]
 *                          [--repeat k] [--stamp <proposal.md>] [--json] [--out <file>]
 *                          [--include-fallback]
 *
 *   # a REVIEWER under test (HOW-53): planted-defect cases, judged from the review's own writes
 *   bun reviser/eval/ab.ts --cases reviser/eval/cases/local-review \
 *                          --a prompts/ticket.local_review.md --b reviser/proposals/<id>.vN.proposal.md
 *
 * A VARIANT is one of
 *   - a prompt file (prompts/<id>.md, the current text) or a reviser proposal
 *     (reviser/proposals/<id>.vN.proposal.md) — written as `<id>.md` into the isolated
 *     $HOWDAH_HOME's local prompts dir, which graphs/local.ts promptSearchPath puts FIRST, so the
 *     engine pins it exactly as it would pin an accepted revision (no engine change);
 *   - an agent-config overlay — inline JSON or a .json file: `{"effort":"high"}` (applied as the
 *     graph's tuning defaults) or `{"defaults":{…},"nodes":{"<node>":{…}}}` — written to the
 *     isolated home's tuning.json, i.e. the same layer the viewer's tuner writes.
 *
 * A CASE is a directory with case.json: the graph, its inputs, an optional repo (copied and
 * committed at a fixed date, so every arm starts from the same commit) and a pass ORACLE —
 * `command` (exit 0 in the worktree; `files` are copied in first, so the oracle's tests can be
 * hidden from the agent), `schema` (a context value of the right shape), `rubric` (a
 * separate judge call) or `review` (HOW-53: the verdict and findings a REVIEW step wrote, matched
 * deterministically against the case's planted defects — see judgeReview). The oracle kind is
 * recorded with every result. A case's repo may carry a `branch`: a second commit on top of the
 * baseline, left checked out, so a worktree (which branches from HEAD when there is no origin)
 * starts at that commit and its diff against main is exactly the change under review.
 *
 * Every run is the REAL engine through the CLI in its own fresh HOWDAH_HOME, and the arms are
 * INTERLEAVED (case 1 A, case 1 B, case 2 A, …) so allowance or rate-limit drift lands on both
 * arms evenly. Outcomes are bucketed, never silently failed:
 *   pass / fail     the run finished and the oracle said so
 *   parked          the run stopped for a human (ask, ambiguous effect, exhaustion) — by code
 *   fell back       the run hopped harness mid-case: the model under test changed, so the case
 *                   is EXCLUDED from the paired test by default (--include-fallback keeps it)
 *   unjudged        the oracle could not judge (a rubric under HOWDAH_STUB)
 * and cost from an unpriced harness is reported as partial (log/usage.ts), never compared as if
 * it were complete.
 *
 * The report: per arm success, total and median cost, median turns, trajectory means
 * (log/trajectory.ts); per comparison the paired 2×2 table, the exact McNemar p
 * (reviser/eval/stats.ts), Benjamini–Hochberg-adjusted p's when there are several B's, and a
 * verdict that says "not enough cases to tell" below MIN_DISCORDANT discordant pairs. With
 * --repeat k > 1 the per-case PASS RATES are reported and no paired test is run, because
 * repeated runs of a non-deterministic agent are not paired binaries.
 *
 * HOWDAH_STUB=1 runs the whole pipeline without spending a token: every agent node parks, so
 * the report is all `parked` — which is exactly the bucket a dry run should exercise.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { splitFrontMatter, frontMatterField } from "../../core/template";
import type { AgentConfig } from "../../core/graph";
import type { LoggedEvent } from "../../log/events";
import { readLog } from "../../log/write";
import { addRollup, describeCost, emptyRollup, rollupRun, type UsageRollup } from "../../log/usage";
import { deriveProfiles, type TrajectoryData } from "../../log/trajectory";
import { readWorktreeRecord } from "../../engine/executors/worktree-record";
import { runShell } from "../../engine/executors/shell";
import { ensureHowdahHome, saveConfig } from "../../config/config";
import { ensureLocalDirs, localGraphPath, localPromptsDir } from "../../graphs/local";
import { stampEval } from "../../prompts/proposals";
import { benjaminiHochberg, enoughDiscordant, mcnemarExact, median, MIN_DISCORDANT } from "./stats";

const ROOT = resolve(import.meta.dir, "..", "..");

// ---- variants -------------------------------------------------------------------------------

export type Variant =
  | { kind: "prompt"; label: string; id: string; version: number; body: string }
  | { kind: "config"; label: string; overlay: { defaults?: AgentConfig; nodes?: Record<string, AgentConfig> } };

/** a variant from its command-line spelling — a prompt/proposal path, inline JSON, or a .json file */
export function parseVariant(spec: string): Variant {
  const trimmed = spec.trim();
  if (trimmed.startsWith("{")) return configVariant(JSON.parse(trimmed), `config ${trimmed}`);
  if (!existsSync(trimmed)) throw new Error(`variant "${spec}" is neither a file nor inline JSON`);
  if (trimmed.endsWith(".json")) return configVariant(JSON.parse(readFileSync(trimmed, "utf8")), `config ${trimmed}`);
  const { frontmatter, body } = splitFrontMatter(readFileSync(trimmed, "utf8"));
  const id = frontMatterField(frontmatter, "id");
  if (!id) throw new Error(`${spec} has no front-matter id`);
  // a reviser proposal carries proposed_version; a prompt file carries version
  const proposed = frontMatterField(frontmatter, "proposed_version");
  const version = Number(proposed ?? frontMatterField(frontmatter, "version") ?? 1);
  return { kind: "prompt", label: `${id} v${version}${proposed ? " (proposal)" : ""}`, id, version, body };
}

function configVariant(json: unknown, label: string): Variant {
  if (!json || typeof json !== "object") throw new Error(`${label}: an overlay must be a JSON object`);
  const o = json as Record<string, unknown>;
  const overlay = "defaults" in o || "nodes" in o ? (o as { defaults?: AgentConfig; nodes?: Record<string, AgentConfig> }) : { defaults: o as AgentConfig };
  return { kind: "config", label, overlay };
}

// ---- cases ----------------------------------------------------------------------------------

export type Oracle =
  | { kind: "command"; run: string; files?: Record<string, string>; timeoutMs?: number }
  | { kind: "schema"; key: string; type?: "string" | "object" | "array" | "number" | "boolean"; required?: string[] }
  | { kind: "rubric"; rubric: string; key?: string }
  | ReviewOracle;

/**
 * HOW-53: a REVIEWER is scored, not a builder. `expect` is the verdict the review must return;
 * each defect is planted in the branch commit and must be NAMED by one finding (judgeReview).
 */
export interface ReviewOracle {
  kind: "review";
  /** the review step (default implementation.local_review) */
  node?: string;
  expect: "pass" | "reject";
  defects?: Array<{ id: string; match: string[] }>;
}

/** the change under review: committed on `name` on top of the baseline, and left checked out */
export interface RepoBranch {
  name: string;
  /** a directory copied OVER the baseline (relative to the case dir) */
  dir: string;
  message: string;
  /** baseline paths the change deletes */
  delete?: string[];
}

export interface EvalCase {
  name: string;
  /** the case's own directory — relative paths in case.json resolve from it */
  dir: string;
  graph: string;
  inputs: Record<string, string>;
  /** a repo to run against: copied, and committed at a fixed date unless it already is a repo */
  repo?: { dir: string; verifyCommand?: string; diagnosticsCommand?: string; branch?: RepoBranch };
  /** a local graph to install (placeholder __HOWDAH_ROOT__ → this checkout), e.g. one that stops before publish */
  graphFile?: string;
  /** a directory of extra prompt files the graph needs */
  prompts?: string;
  oracle: Oracle;
  /** per-run ceiling (default 45 minutes) */
  timeoutMs?: number;
}

/** every subdirectory of `dir` with a case.json, sorted by name */
export function loadCases(dir: string): EvalCase[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "case.json")))
    .map((d) => {
      const caseDir = join(dir, d.name);
      const raw = JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8")) as Omit<EvalCase, "dir" | "name"> & { name?: string };
      if (!raw.graph || !raw.oracle) throw new Error(`${caseDir}/case.json needs "graph" and "oracle"`);
      if (raw.oracle.kind === "review") checkReviewOracle(raw.oracle, `${caseDir}/case.json`);
      if (raw.repo?.branch && (!raw.repo.branch.name || !raw.repo.branch.dir || !raw.repo.branch.message))
        throw new Error(`${caseDir}/case.json: repo.branch needs "name", "dir" and "message"`);
      return { ...raw, name: raw.name ?? d.name, dir: caseDir, inputs: raw.inputs ?? {} };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** refuse a review oracle that could not judge what it claims to — named, at load time */
export function checkReviewOracle(o: ReviewOracle, where: string): void {
  if (o.expect !== "pass" && o.expect !== "reject") throw new Error(`${where}: a review oracle's "expect" must be "pass" or "reject", not ${JSON.stringify(o.expect)}`);
  const defects = o.defects ?? [];
  if (o.expect === "reject" && defects.length === 0) throw new Error(`${where}: a review oracle expecting "reject" must list the planted defects`);
  if (o.expect === "pass" && defects.length > 0) throw new Error(`${where}: a review oracle expecting "pass" (a clean control) cannot list defects`);
  const seen = new Set<string>();
  for (const d of defects) {
    if (!d.id) throw new Error(`${where}: every defect needs an "id"`);
    if (seen.has(d.id)) throw new Error(`${where}: defect "${d.id}" is listed twice`);
    seen.add(d.id);
    if (!Array.isArray(d.match) || d.match.length === 0) throw new Error(`${where}: defect "${d.id}" needs a non-empty "match" list`);
    for (const m of d.match) {
      try {
        new RegExp(m, "i");
      } catch (err) {
        throw new Error(`${where}: defect "${d.id}" has a regex that does not compile (${m}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

// ---- running one arm of one case ---------------------------------------------------------------

export interface ArmRun {
  /** the engine's events for the run, and where things are on disk */
  events: LoggedEvent[];
  runDir: string;
  /** the worktree the run worked in, or the repo, or null for a folderless run */
  workdir: string | null;
}

export type Runner = (c: EvalCase, v: Variant, repeat: number) => Promise<ArmRun>;

const FIXED_DATE = "2026-01-01T00:00:00Z";

/** git in `cwd`, as the eval identity at the fixed date — every commit is byte-identical across arms */
function evalGit(cwd: string): (...args: string[]) => void {
  const env = { ...process.env, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE, GIT_AUTHOR_NAME: "howdah-eval", GIT_AUTHOR_EMAIL: "eval@howdah", GIT_COMMITTER_NAME: "howdah-eval", GIT_COMMITTER_EMAIL: "eval@howdah" };
  return (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  };
}

/**
 * copy a repo dir into the home and commit it at a fixed date — every arm starts identical. With
 * a `branch`, the change under review is committed on top and left checked out (HOW-53).
 */
function materialiseRepo(src: string, dest: string, branch?: { dir: string } & Omit<RepoBranch, "dir">): void {
  cpSync(src, dest, { recursive: true });
  if (existsSync(join(dest, ".git"))) {
    if (branch) throw new Error(`${src} is already a git repo: a repo.branch needs a plain directory to commit onto`);
    return;
  }
  const git = evalGit(dest);
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "eval case baseline");
  if (!branch) return;
  git("checkout", "-q", "-b", branch.name);
  cpSync(branch.dir, dest, { recursive: true, force: true });
  for (const p of branch.delete ?? []) rmSync(join(dest, p), { recursive: true });
  git("add", "-A");
  git("commit", "-q", "-m", branch.message);
}

/** set up a fresh HOWDAH_HOME for one arm of one case; returns the home and the workspace name */
export function prepareHome(c: EvalCase, v: Variant): { home: string; workspace: string | null } {
  const home = mkdtempSync(join(tmpdir(), `howdah-ab-${c.name}-`));
  const config = ensureHowdahHome(home);
  ensureLocalDirs(home);
  let workspace: string | null = null;
  if (c.repo) {
    const path = join(home, "src", c.name);
    mkdirSync(dirname(path), { recursive: true });
    const branch = c.repo.branch;
    materialiseRepo(resolve(c.dir, c.repo.dir), path, branch ? { ...branch, dir: resolve(c.dir, branch.dir) } : undefined);
    workspace = "eval";
    config.repos[workspace] = {
      path, defaultBranch: "main",
      ...(c.repo.verifyCommand ? { verifyCommand: c.repo.verifyCommand } : {}),
      ...(c.repo.diagnosticsCommand ? { diagnosticsCommand: c.repo.diagnosticsCommand } : {}),
    };
    saveConfig(config, home);
  }
  if (c.graphFile) {
    const source = readFileSync(resolve(c.dir, c.graphFile), "utf8").replaceAll("__HOWDAH_ROOT__", ROOT);
    writeFileSync(localGraphPath(home, c.graph), source);
  }
  if (c.prompts) cpSync(resolve(c.dir, c.prompts), localPromptsDir(home), { recursive: true });
  if (v.kind === "prompt") {
    writeFileSync(join(localPromptsDir(home), `${v.id}.md`), `---\nid: ${v.id}\nversion: ${v.version}\n---\n${v.body}`);
  } else {
    writeFileSync(join(home, "tuning.json"), JSON.stringify({ [c.graph]: v.overlay }, null, 2) + "\n");
  }
  return { home, workspace };
}

/** the real runner: the CLI, in its own HOWDAH_HOME, to completion or a park */
export function cliRunner(): Runner {
  return async (c, v, repeat) => {
    const { home, workspace } = prepareHome(c, v);
    const runId = `ab-${c.name}-${repeat}`;
    const argv = [
      process.execPath, join(ROOT, "cli", "main.ts"), "run", c.graph,
      ...Object.entries(c.inputs).flatMap(([k, val]) => ["-i", `${k}=${val}`]),
      ...(workspace ? ["--workspace", workspace] : []),
      "--id", runId,
    ];
    const proc = Bun.spawn(argv, { env: { ...process.env, HOWDAH_HOME: home }, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), c.timeoutMs ?? 45 * 60_000);
    await proc.exited;
    clearTimeout(timer);
    const runDir = join(home, "runs", runId);
    const record = readWorktreeRecord(runDir);
    return {
      events: readLog(join(runDir, "run.jsonl")),
      runDir,
      workdir: record?.path ?? (workspace ? join(home, "src", c.name) : null),
    };
  };
}

// ---- judging one run ---------------------------------------------------------------------------

export type Outcome = "pass" | "fail" | "parked" | "unjudged" | "error";

export interface OracleResult {
  kind: Oracle["kind"];
  passed: boolean | null;
  detail: string;
}

/** a rubric judge: true/false, or null when it cannot judge (HOWDAH_STUB) */
export type Judge = (rubric: string, evidence: string) => Promise<boolean | null>;

export const claudeJudge: Judge = async (rubric, evidence) => {
  if (process.env.HOWDAH_STUB) return null;
  const prompt = `You are judging one result against a rubric. Reply with exactly PASS or FAIL on the last line.\n\nRUBRIC:\n${rubric}\n\nRESULT:\n${evidence}`;
  const r = Bun.spawnSync(["claude", "-p", "--output-format", "text", "--permission-mode", "plan"], { stdin: new TextEncoder().encode(prompt), stdout: "pipe", stderr: "pipe" });
  const last = new TextDecoder().decode(r.stdout).trim().split("\n").at(-1)?.trim().toUpperCase();
  return last === "PASS" ? true : last === "FAIL" ? false : null;
};

function latestWrite(events: readonly LoggedEvent[], key: string): unknown {
  const e = events.findLast((x) => x.type === "node-finished" && x.status === "succeeded" && key in x.writes);
  return e?.type === "node-finished" ? e.writes[key] : undefined;
}

/**
 * HOW-53: score a REVIEW from the log — deterministic, no LLM judge. The rule:
 *
 *   1. The review is the LAST succeeded `node-finished` of `oracle.node` (default
 *      implementation.local_review) that wrote `review_verdict`. None → fail ("never finished").
 *   2. Its `review_verdict` must equal `oracle.expect`, or the case fails.
 *   3. `expect: "pass"` (a clean control) is decided by the verdict alone — findings are ignored,
 *      because a passing review may carry non-blocking notes.
 *   4. `expect: "reject"`: every element of `review_findings` becomes ONE text (a string as is,
 *      anything else JSON.stringify'd; a non-array value is a single text). A defect is NAMED when
 *      ONE finding's text matches EVERY regex in its `match` list, each compiled case-insensitive —
 *      terms spread across different findings do not name it. The case passes only when every
 *      planted defect is named. Extra findings are not penalised: the clean controls are what
 *      penalise a reviewer that rejects everything.
 */
export function judgeReview(o: ReviewOracle, events: readonly LoggedEvent[]): OracleResult {
  const node = o.node ?? "implementation.local_review";
  const e = events.findLast((x) => x.type === "node-finished" && x.node === node && x.status === "succeeded" && "review_verdict" in x.writes);
  if (e?.type !== "node-finished") return { kind: "review", passed: false, detail: `the review (${node}) never finished` };
  const verdict = e.writes.review_verdict;
  if (verdict !== o.expect) return { kind: "review", passed: false, detail: `verdict ${typeof verdict === "string" ? verdict : JSON.stringify(verdict)}, expected ${o.expect}` };
  if (o.expect === "pass") return { kind: "review", passed: true, detail: "verdict pass, as expected" };
  const findings = e.writes.review_findings;
  const texts = (Array.isArray(findings) ? findings : [findings]).map((f) => (typeof f === "string" ? f : JSON.stringify(f) ?? ""));
  const defects = o.defects ?? [];
  const missed = defects.filter((d) => {
    const res = d.match.map((m) => new RegExp(m, "i"));
    return !texts.some((t) => res.every((r) => r.test(t)));
  });
  return missed.length
    ? { kind: "review", passed: false, detail: `verdict reject, but the findings miss ${missed.map((d) => d.id).join(", ")}` }
    : { kind: "review", passed: true, detail: `verdict reject, naming all ${defects.length} planted defect${defects.length === 1 ? "" : "s"}` };
}

export async function judge(c: EvalCase, run: ArmRun, judgeFn: Judge): Promise<OracleResult> {
  const o = c.oracle;
  if (o.kind === "review") return judgeReview(o, run.events);
  if (o.kind === "command") {
    if (!run.workdir || !existsSync(run.workdir)) return { kind: o.kind, passed: false, detail: "no worktree to run the oracle in" };
    for (const [dest, src] of Object.entries(o.files ?? {})) {
      mkdirSync(dirname(join(run.workdir, dest)), { recursive: true });
      cpSync(resolve(c.dir, src), join(run.workdir, dest));
    }
    const r = await runShell(o.run, { cwd: run.workdir, timeoutMs: o.timeoutMs ?? 10 * 60_000 });
    return { kind: o.kind, passed: r.exitCode === 0, detail: `\`${o.run}\` exited ${r.timedOut ? "(timed out)" : r.exitCode}` };
  }
  if (o.kind === "schema") {
    const value = latestWrite(run.events, o.key);
    if (value === undefined) return { kind: o.kind, passed: false, detail: `${o.key} was never written` };
    const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (o.type && type !== o.type) return { kind: o.kind, passed: false, detail: `${o.key} is ${type}, not ${o.type}` };
    const missing = (o.required ?? []).filter((k) => !(value && typeof value === "object" && k in (value as object)));
    return missing.length
      ? { kind: o.kind, passed: false, detail: `${o.key} lacks ${missing.join(", ")}` }
      : { kind: o.kind, passed: true, detail: `${o.key} has the expected shape` };
  }
  const evidence = JSON.stringify(o.key ? latestWrite(run.events, o.key) : run.events.filter((e) => e.type === "node-finished").map((e) => e.type === "node-finished" ? e.writes : {}));
  const verdict = await judgeFn(o.rubric, evidence);
  return { kind: o.kind, passed: verdict, detail: verdict === null ? "rubric not judged (no judge available — HOWDAH_STUB?)" : `rubric judged ${verdict ? "PASS" : "FAIL"}` };
}

export interface CaseResult {
  case: string;
  arm: string;
  variant: string;
  repeat: number;
  outcome: Outcome;
  park_code?: string;
  park_reason?: string;
  oracle: OracleResult | null;
  /** the run changed harness mid-case (a fallback hop): the model under test changed */
  fell_back: boolean;
  harnesses: string[];
  usage: UsageRollup;
  turns: number;
  profiles: TrajectoryData[];
  run_dir: string;
}

export async function classify(c: EvalCase, arm: string, v: Variant, repeat: number, run: ArmRun, judgeFn: Judge): Promise<CaseResult> {
  const events = run.events;
  const harnesses = [...new Set(events.flatMap((e) => (e.type === "prompt-rendered" && e.harness ? [e.harness] : [])))];
  const base = {
    case: c.name, arm, variant: v.label, repeat, harnesses,
    fell_back: harnesses.length > 1,
    usage: rollupRun(events),
    turns: events.filter((e) => e.type === "turn-finalized").length,
    profiles: deriveProfiles(events).filter((p): p is TrajectoryData => p.status === "ok"),
    run_dir: run.runDir,
  };
  const finished = events.findLast((e) => e.type === "run-finished");
  if (finished?.type === "run-finished") {
    if (finished.outcome !== "success") return { ...base, outcome: "fail", oracle: null };
    const oracle = await judge(c, run, judgeFn);
    return { ...base, outcome: oracle.passed === null ? "unjudged" : oracle.passed ? "pass" : "fail", oracle };
  }
  let open: Extract<LoggedEvent, { type: "attention-raised" }> | null = null;
  for (const e of events) {
    if (e.type === "attention-raised") open = e;
    else if (e.type === "attention-resolved" || e.type === "operator-jump") open = null;
  }
  if (open) return { ...base, outcome: "parked", park_code: open.code ?? "attempt-failed", park_reason: open.reason, oracle: null };
  return { ...base, outcome: "error", park_reason: events.length ? "the run neither finished nor parked" : "the run wrote no log", oracle: null };
}

// ---- the experiment ----------------------------------------------------------------------------

export interface ArmSummary {
  arm: string;
  variant: string;
  runs: number;
  pass: number;
  fail: number;
  unjudged: number;
  error: number;
  parked: Record<string, number>;
  fell_back: number;
  success_rate: number | null;
  /** summed usage over every run of the arm — `partial` when any turn was unpriced */
  usage: UsageRollup;
  median_cost_usd: number | null;
  /** runs whose cost is incomplete (an unpriced harness) — counted, never averaged in */
  partial_cost_runs: number;
  median_turns: number | null;
  trajectory: { visits: number; mean_calls: number | null; mean_edits: number | null; mean_verify_after_last_edit: number | null };
}

export interface Comparison {
  b: string;
  /** paired over cases where both arms have a judged pass/fail and (by default) neither fell back */
  table: { both: number; a_only: number; b_only: number; neither: number };
  excluded: Array<{ case: string; why: string }>;
  p: number;
  p_adjusted: number;
  verdict: string;
  trajectory_delta: { mean_calls: number | null; mean_edits: number | null; mean_verify_after_last_edit: number | null };
}

export interface ABReport {
  cases: string[];
  repeat: number;
  oracle_kinds: string[];
  arms: ArmSummary[];
  /** null under --repeat > 1: repeated runs are not paired binaries */
  comparisons: Comparison[] | null;
  per_case_pass_rates: Record<string, Record<string, string>> | null;
  results: CaseResult[];
}

const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);

function summariseArm(arm: string, variant: string, rs: CaseResult[]): ArmSummary {
  const usage = emptyRollup();
  for (const r of rs) addRollup(usage, r.usage);
  const parked: Record<string, number> = {};
  for (const r of rs) if (r.outcome === "parked") parked[r.park_code ?? "?"] = (parked[r.park_code ?? "?"] ?? 0) + 1;
  const judged = rs.filter((r) => r.outcome === "pass" || r.outcome === "fail");
  const complete = rs.filter((r) => r.usage.turns > 0 && !r.usage.partial && r.usage.cost_usd !== null).map((r) => r.usage.cost_usd!);
  const profiles = rs.flatMap((r) => r.profiles);
  return {
    arm, variant, runs: rs.length,
    pass: rs.filter((r) => r.outcome === "pass").length,
    fail: rs.filter((r) => r.outcome === "fail").length,
    unjudged: rs.filter((r) => r.outcome === "unjudged").length,
    error: rs.filter((r) => r.outcome === "error").length,
    parked,
    fell_back: rs.filter((r) => r.fell_back).length,
    success_rate: judged.length ? Math.round((judged.filter((r) => r.outcome === "pass").length / judged.length) * 1000) / 1000 : null,
    usage,
    median_cost_usd: median(complete),
    partial_cost_runs: rs.filter((r) => r.usage.turns > 0 && r.usage.partial).length,
    median_turns: median(rs.map((r) => r.turns)),
    trajectory: {
      visits: profiles.length,
      mean_calls: mean(profiles.map((p) => p.calls.total)),
      mean_edits: mean(profiles.map((p) => p.calls.edit)),
      mean_verify_after_last_edit: mean(profiles.flatMap((p) => (p.verify_after_last_edit === null ? [] : [p.verify_after_last_edit]))),
    },
  };
}

const delta = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.round((b - a) * 100) / 100);

function compare(cases: string[], a: CaseResult[], b: CaseResult[], bLabel: string, includeFallback: boolean): Omit<Comparison, "p_adjusted" | "trajectory_delta"> {
  const table = { both: 0, a_only: 0, b_only: 0, neither: 0 };
  const excluded: Comparison["excluded"] = [];
  for (const name of cases) {
    const ra = a.find((r) => r.case === name);
    const rb = b.find((r) => r.case === name);
    if (!ra || !rb) { excluded.push({ case: name, why: "an arm did not run" }); continue; }
    const judged = (r: CaseResult) => r.outcome === "pass" || r.outcome === "fail";
    if (!judged(ra) || !judged(rb)) {
      excluded.push({ case: name, why: `not a judged pass/fail (A ${ra.outcome}${ra.park_code ? ` ${ra.park_code}` : ""}, B ${rb.outcome}${rb.park_code ? ` ${rb.park_code}` : ""})` });
      continue;
    }
    if (!includeFallback && (ra.fell_back || rb.fell_back)) { excluded.push({ case: name, why: "an arm fell back to another harness" }); continue; }
    const pa = ra.outcome === "pass", pb = rb.outcome === "pass";
    if (pa && pb) table.both++;
    else if (pa) table.a_only++;
    else if (pb) table.b_only++;
    else table.neither++;
  }
  const p = mcnemarExact(table.a_only, table.b_only);
  return { b: bLabel, table, excluded, p, verdict: "" };
}

function verdictFor(c: Pick<Comparison, "table" | "p_adjusted">): string {
  const discordant = c.table.a_only + c.table.b_only;
  if (!enoughDiscordant(discordant))
    return `not enough cases to tell — ${discordant} discordant pair${discordant === 1 ? "" : "s"}; an exact test needs at least ${MIN_DISCORDANT} before any split could reach p < 0.05`;
  if (c.p_adjusted >= 0.05) return `no significant difference (p = ${c.p_adjusted.toFixed(3)})`;
  return c.table.b_only > c.table.a_only ? `B is better (p = ${c.p_adjusted.toFixed(3)})` : `A is better (p = ${c.p_adjusted.toFixed(3)})`;
}

export interface RunABOpts {
  cases: EvalCase[];
  a: Variant;
  b: Variant[];
  repeat?: number;
  runner?: Runner;
  judge?: Judge;
  includeFallback?: boolean;
  /** progress, one line per run */
  log?: (line: string) => void;
}

export async function runAB(opts: RunABOpts): Promise<ABReport> {
  const repeat = Math.max(1, opts.repeat ?? 1);
  const runner = opts.runner ?? cliRunner();
  const judgeFn = opts.judge ?? claudeJudge;
  const arms: Array<{ arm: string; v: Variant }> = [{ arm: "A", v: opts.a }, ...opts.b.map((v, i) => ({ arm: opts.b.length === 1 ? "B" : `B${i + 1}`, v }))];
  const results: CaseResult[] = [];
  // INTERLEAVED: within each repeat and case, every arm runs back to back
  for (let r = 1; r <= repeat; r++)
    for (const c of opts.cases)
      for (const { arm, v } of arms) {
        const run = await runner(c, v, r);
        const result = await classify(c, arm, v, r, run, judgeFn);
        results.push(result);
        opts.log?.(`${c.name} #${r} ${arm}: ${result.outcome}${result.park_code ? ` (${result.park_code})` : ""}${result.fell_back ? " [fell back]" : ""}`);
      }
  return buildReport(opts.cases.map((c) => c.name), repeat, arms.map(({ arm, v }) => ({ arm, label: v.label })), results, opts.includeFallback ?? false);
}

export function buildReport(
  cases: string[],
  repeat: number,
  arms: Array<{ arm: string; label: string }>,
  results: CaseResult[],
  includeFallback: boolean,
): ABReport {
  const of = (arm: string) => results.filter((r) => r.arm === arm);
  const summaries = arms.map(({ arm, label }) => summariseArm(arm, label, of(arm)));
  const oracleKinds = [...new Set(results.flatMap((r) => (r.oracle ? [r.oracle.kind] : [])))];
  if (repeat > 1) {
    const rates: Record<string, Record<string, string>> = {};
    for (const name of cases) {
      rates[name] = {};
      for (const { arm } of arms) {
        const rs = of(arm).filter((r) => r.case === name);
        const judged = rs.filter((r) => r.outcome === "pass" || r.outcome === "fail");
        rates[name][arm] = `${judged.filter((r) => r.outcome === "pass").length}/${judged.length} passed (${rs.length - judged.length} not judged)`;
      }
    }
    return { cases, repeat, oracle_kinds: oracleKinds, arms: summaries, comparisons: null, per_case_pass_rates: rates, results };
  }
  const a = of("A");
  const raw = arms.slice(1).map(({ arm, label }) => compare(cases, a, of(arm), label, includeFallback));
  const adjusted = benjaminiHochberg(raw.map((c) => c.p));
  const sa = summaries[0]!;
  const comparisons: Comparison[] = raw.map((c, i) => {
    const sb = summaries[i + 1]!;
    const full = {
      ...c, p_adjusted: adjusted[i]!,
      trajectory_delta: {
        mean_calls: delta(sa.trajectory.mean_calls, sb.trajectory.mean_calls),
        mean_edits: delta(sa.trajectory.mean_edits, sb.trajectory.mean_edits),
        mean_verify_after_last_edit: delta(sa.trajectory.mean_verify_after_last_edit, sb.trajectory.mean_verify_after_last_edit),
      },
    };
    return { ...full, verdict: verdictFor(full) };
  });
  return { cases, repeat, oracle_kinds: oracleKinds, arms: summaries, comparisons, per_case_pass_rates: null, results };
}

export function formatReport(r: ABReport): string {
  const lines: string[] = [];
  lines.push(`A/B over ${r.cases.length} case${r.cases.length === 1 ? "" : "s"} × ${r.repeat} repeat${r.repeat === 1 ? "" : "s"}; oracle: ${r.oracle_kinds.join(", ") || "none ran"}`);
  lines.push("");
  for (const s of r.arms) {
    const parked = Object.entries(s.parked).map(([k, n]) => `${k} ×${n}`).join(", ");
    lines.push(`${s.arm}  ${s.variant}`);
    lines.push(`   success ${s.success_rate === null ? "—" : `${Math.round(s.success_rate * 100)}%`} (${s.pass} pass, ${s.fail} fail${s.unjudged ? `, ${s.unjudged} unjudged` : ""}${s.error ? `, ${s.error} error` : ""}${parked ? `, parked: ${parked}` : ""}${s.fell_back ? `, ${s.fell_back} fell back` : ""})`);
    lines.push(`   cost ${describeCost(s.usage)} total · median ${s.median_cost_usd === null ? "—" : `$${s.median_cost_usd.toFixed(4)}`}${s.partial_cost_runs ? ` (+${s.partial_cost_runs} partial run${s.partial_cost_runs === 1 ? "" : "s"} not in the median)` : ""} · median turns ${s.median_turns ?? "—"}`);
    lines.push(`   trajectory over ${s.trajectory.visits} visit${s.trajectory.visits === 1 ? "" : "s"}: calls ${s.trajectory.mean_calls ?? "—"} · edits ${s.trajectory.mean_edits ?? "—"} · verify after last edit ${s.trajectory.mean_verify_after_last_edit ?? "—"}`);
  }
  if (r.comparisons) {
    for (const c of r.comparisons) {
      lines.push("");
      lines.push(`A vs ${c.b}`);
      lines.push(`               B pass   B fail`);
      lines.push(`   A pass      ${String(c.table.both).padStart(6)}   ${String(c.table.a_only).padStart(6)}`);
      lines.push(`   A fail      ${String(c.table.b_only).padStart(6)}   ${String(c.table.neither).padStart(6)}`);
      lines.push(`   exact McNemar p = ${c.p.toFixed(4)}${r.comparisons.length > 1 ? ` (BH-adjusted ${c.p_adjusted.toFixed(4)})` : ""}`);
      lines.push(`   trajectory B − A: calls ${c.trajectory_delta.mean_calls ?? "—"} · edits ${c.trajectory_delta.mean_edits ?? "—"} · verify after last edit ${c.trajectory_delta.mean_verify_after_last_edit ?? "—"}`);
      for (const x of c.excluded) lines.push(`   excluded ${x.case}: ${x.why}`);
      lines.push(`   verdict: ${c.verdict}`);
    }
  } else if (r.per_case_pass_rates) {
    lines.push("", `per-case pass rates (repeated runs are not paired binaries, so no paired test was run):`);
    for (const [name, arms] of Object.entries(r.per_case_pass_rates)) lines.push(`   ${name}: ${Object.entries(arms).map(([arm, v]) => `${arm} ${v}`).join(" · ")}`);
  }
  return lines.join("\n");
}

/** the line a proposal is stamped with — what the accept/reject screen shows */
export function stampLine(r: ABReport, opts: { dryRun?: boolean } = {}): { score: string; verdict: string } {
  const a = r.arms[0]!;
  const b = r.arms[1];
  const score = b
    ? `A ${a.pass}/${a.pass + a.fail} vs B ${b.pass}/${b.pass + b.fail} passed · cost A ${describeCost(a.usage)} vs B ${describeCost(b.usage)}`
    : `A ${a.pass}/${a.pass + a.fail} passed`;
  const verdict = r.comparisons?.[0]?.verdict ?? "repeated runs: see the per-case pass rates in the report";
  // a stamp made under HOWDAH_STUB proves the pipeline, not the prompt: it must say so
  return opts.dryRun ? { score: `DRY RUN (HOWDAH_STUB, no agent ran) — ${score}`, verdict: `dry run only; run the real A/B before deciding — ${verdict}` } : { score, verdict };
}

// ---- CLI ---------------------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const out: { cases?: string; a?: string; b: string[]; repeat: number; stamp?: string; json: boolean; out?: string; includeFallback: boolean } = { b: [], repeat: 1, json: false, includeFallback: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--cases") out.cases = next();
    else if (a === "--a") out.a = next();
    else if (a === "--b") out.b.push(next());
    else if (a === "--repeat") out.repeat = Number(next());
    else if (a === "--stamp") out.stamp = next();
    else if (a === "--out") out.out = next();
    else if (a === "--json") out.json = true;
    else if (a === "--include-fallback") out.includeFallback = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.cases || !out.a || out.b.length === 0) throw new Error("usage: bun reviser/eval/ab.ts --cases <dir> --a <variant> --b <variant> [--b …] [--repeat k] [--stamp <proposal>] [--json] [--out <file>] [--include-fallback]");
  if (!Number.isInteger(out.repeat) || out.repeat < 1) throw new Error("--repeat needs a positive integer");
  return out;
}

if (import.meta.main) {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  const report = await runAB({
    cases: loadCases(args.cases!),
    a: parseVariant(args.a!),
    b: args.b.map(parseVariant),
    repeat: args.repeat,
    includeFallback: args.includeFallback,
    log: (l) => console.error(l),
  });
  const json = JSON.stringify(report, null, 2);
  if (args.out) writeFileSync(args.out, json + "\n");
  if (args.stamp) {
    const reportPath = args.out ?? args.stamp.replace(/\.proposal\.md$/, "") + ".ab-report.json";
    if (!args.out) writeFileSync(reportPath, json + "\n");
    const { score, verdict } = stampLine(report, { dryRun: !!process.env.HOWDAH_STUB });
    stampEval(args.stamp, score, verdict, reportPath);
    console.error(`stamped ${args.stamp} (report: ${reportPath})`);
  }
  console.log(args.json ? json : formatReport(report));
}
