#!/usr/bin/env bun
/**
 * howdah — thin scripting verbs (design A9.2: the CLI is not a designed surface, the web
 * view is; these exist for scripts, launchd, and the start-run API).
 *
 *   howdah run <graph> [-i key=value]... [--workspace <name>] [--dir <path>] [--id <run-id>] [--name <text>] [--parent <run-id>]
 *     --name is a display label only (HOW-18); the run id stays identity
 *     --parent records which run launched this one (HOW-23) — lineage only, nothing routes on it
 *   howdah runs --json
 *   howdah reply <run-id> <text>
 *   howdah resolve-effect <run-id> <effect> happened|not-happened [--node <node>]
 *   howdah graphs --json
 *
 * Approval verbs (system-map 1a) — the same engine/control.ts functions the web routes call:
 *   howdah approve <run-id> [--proposal <id>]                        approve the current proposal round
 *   howdah comment <run-id> [--proposal <id>] <entity-id> <text...>  pin a comment to the current round
 *   howdah send-feedback <run-id> [--proposal <id>]                  send the round's comments back to the proposer
 * `--proposal` binds the action to the round you looked at: refused if it was superseded.
 *   howdah redesign <run-id> <msg...>                re-extract and redraw with an instruction
 * A refusal prints the reason and exits 1.
 *
 * System map (system-map 1b/1c):
 *   howdah map <repo-dir> [--json] [--commit <sha>] [--store <dir>] [--workers N] [--manifest-out <dir>]
 *                                                    extract + assemble a snapshot (map/cli.ts)
 *   howdah metrics [--json]                          implement-slice runs vs the implement-ticket baseline (cli/metrics.ts)
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../engine/run";
import { liveExecutors, stubExecutors } from "../engine/executors";
import { EventLog, readLog } from "../log/write";
import { AttentionCenter, osNotifier, writeHeartbeat } from "../engine/attention";
import { replayState } from "../engine/replay";
import { Reconciler, readsForgeFacts } from "../engine/reconcile";
import { effectiveCwd, readWorktreeRecord } from "../engine/executors/worktree";
import { probeAuth } from "../engine/executors/harness-failure";
import { harnessNames, harnessSpec, isHarness } from "../core/harnesses";
import { GRAPHS, graphCatalog } from "../graphs/index";
import { loadRegistry, catalogOf } from "../graphs/registry";
import { promptSearchPath } from "../graphs/local";
import { howdahHome, loadConfig, saveConfig, resolveWorkspace, repoNameFor, ensureHowdahHome } from "../config/config";
import { loadTuning } from "../config/tuning";
import { normalizeRunName } from "../core/run-name";
import {
  readControl, writeControl, clearControl, interruptRunner, markPaused, resolveReply, runnerAlive, supervisorShouldResume, jumpMissingReads, jumpRefusal, forceReleaseRunner,
  runnerHolder, raiseRunnerLock,
  approve, sendFeedback, pinComment, redesign, afterDecision, clearAsks, type DecisionResult,
  resolveEffect, EFFECT_VERDICTS, type EffectVerdict,
} from "../engine/control";

const base = howdahHome();
const ROOT = join(import.meta.dir, "..");
const runsDir = join(base, "runs");

function executors() {
  // HOWDAH_STUB short-circuits real agent spawns — tests and dry runs
  return process.env.HOWDAH_STUB
    ? stubExecutors()
    : liveExecutors({
        attentionDir: join(base, "attention"),
        reposDir: join(base, "repos"),
        repoName: (repoPath) => repoNameFor(loadConfig(base), repoPath),
      });
}

/** git before every node, forge before declared readers; observations land in the log */
function reconcilerHook(runDir: string, engineRef: () => import("../engine/run").Engine) {
  return async (nodeId: string, def: import("../core/graph").NodeDef<any>) => {
    if (process.env.HOWDAH_STUB) return;
    const started = replayState(readLog(join(runDir, "run.jsonl"))).started;
    const cwd = effectiveCwd(join(runDir, "run.jsonl"), started?.cwd);
    if (!cwd || started?.folder_kind !== "repo") return; // Plain runs never touch git
    const record = readWorktreeRecord(runDir);
    const rec = new Reconciler(cwd);
    if (record) rec.claim({ branch: record.branch });
    const r = await rec.reconcile(def);
    engineRef().log.append({
      type: "reconciled", node: nodeId, git: r.git,
      forge: readsForgeFacts(def) ? r.forge : undefined,
      intended: record ? { branch: record.branch } : undefined,
      disagreements: r.disagreements,
    });
  };
}

/**
 * HOW-17: the operator's harness settings, read from disk ONCE here and handed to the
 * engine. core/harnesses.ts stays pure (no fs), and a run's default harness and fallback
 * chain come from the same place whether it was launched, resumed or supervised.
 */
function harnessSettings(): { default?: string; fallbackChain?: string[] } {
  const config = loadConfig(base);
  return { default: config.defaultHarness, fallbackChain: config.fallbackChain };
}

function spawnResume(runId: string): void {
  Bun.spawn(["bun", import.meta.path, "resume", runId], { env: { ...process.env }, stdout: "ignore", stderr: "ignore" }).unref();
}

export function parseRunArgs(argv: string[]) {
  const inputs: Record<string, string> = {};
  const overrides: import("../core/graph").AgentConfig = {};
  let workspace: string | undefined, dir: string | undefined, id: string | undefined, name: string | undefined, parent: string | undefined;
  const [graphName, ...rest] = argv;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "-i" || a === "--input") {
      const kv = rest[++i] ?? "";
      const eq = kv.indexOf("=");
      if (eq < 1) throw new Error(`bad input: "${kv}" (want key=value)`);
      inputs[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === "--workspace") workspace = rest[++i];
    else if (a === "--dir") dir = rest[++i];
    else if (a === "--id") id = rest[++i];
    // HOW-23: set by `runs:launch` on every child of a plan-feature fan-out — lineage only
    else if (a === "--parent") parent = rest[++i];
    else if (a === "--name") {
      if (i + 1 >= rest.length) throw new Error("--name needs a value");
      const r = normalizeRunName(rest[++i]);
      if (!r.ok) throw new Error(r.error);
      name = r.name;
    }
    else if (a === "--model") overrides.model = rest[++i];
    else if (a === "--harness") {
      const name = rest[++i];
      // a leaked harness name reaches a spawn, so it is checked here rather than at the CLI
      if (!isHarness(name)) throw new Error(`unknown harness "${name ?? ""}" — have: ${harnessNames().join(", ")}`);
      overrides.harness = name;
    }
    else if (a === "--effort") overrides.effort = rest[++i] as any;
    else if (a === "--permission-mode") overrides.permissionMode = rest[++i] as any;
    else if (a === "--max-turns") overrides.maxTurns = Number(rest[++i]);
    else if (a === "--skills") overrides.skills = (rest[++i] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    else throw new Error(`unknown flag: ${a}`);
  }
  return { graphName, inputs, workspace, dir, id, name, parent, overrides };
}

export async function runCommand(argv: string[]): Promise<string> {
  const { graphName, inputs, workspace, dir, id, name, parent, overrides } = parseRunArgs(argv);
  // HOWDAH_MODEL is a run-level default so the RECORD shows what actually ran
  if (!overrides.model && process.env.HOWDAH_MODEL) overrides.model = process.env.HOWDAH_MODEL;
  // built-ins plus the operator's own from $HOWDAH_HOME; a local graph that does not load is
  // named with its reason rather than just missing from the list
  const registry = await loadRegistry(base, ROOT);
  const graph = graphName ? registry.graphs[graphName] : undefined;
  if (!graph) {
    const broken = registry.problems.find((p) => p.name === graphName);
    if (broken) throw new Error(`graph "${graphName}" does not load: ${broken.error}`);
    throw new Error(`unknown graph "${graphName}" — have: ${Object.keys(registry.graphs).join(", ")}`);
  }

  let cwd: string | undefined = dir;
  let folderKind: "repo" | "plain" | undefined = dir ? "plain" : undefined;
  if (workspace) {
    const ws = resolveWorkspace(loadConfig(base), workspace);
    if (!ws) throw new Error(`unknown workspace "${workspace}" — register it in ${base}/config.json`);
    cwd = ws.path;
    folderKind = ws.kind;
  }

  const runId = id ?? `${graphName}-${Date.now().toString(36)}`;
  const runDir = join(runsDir, runId);
  const engine: Engine = new Engine(graph, {
    dir: runDir, executors: executors(), cwd, folderKind, name, parent, overrides,
    promptsDir: promptSearchPath(base, ROOT),
    tuning: loadTuning(base)[graphName!],
    harnesses: harnessSettings(),
    control: () => readControl(runDir),
    beforeNode: reconcilerHook(runDir, () => engine),
    whileHeld: raiseParkAttention(runId),
  });
  console.log(`run ${runId}${name ? ` "${name}"` : ""} starting (${cwd ?? "no folder"})`);
  // the engine takes runner.pid as the run's runner lock (engine/control.ts claimRunner)
  const result = await engine.start(inputs);
  console.log(`run ${runId}: ${JSON.stringify(result)}`);
  return runId;
}

/**
 * A park's durable attention, raised while the engine still holds the runner lock (system-
 * map 1a review): a decision's wake cannot start the next runner — or clear this record —
 * until it has landed, so the watchdog never re-rings for a round already decided.
 */
function raiseParkAttention(runId: string) {
  return async (result: import("../engine/run").RunState) => {
    if (result.state !== "parked") return;
    const ask = readLog(join(runsDir, runId, "run.jsonl")).findLast((e) => e.type === "attention-raised");
    const visit = ask?.type === "attention-raised" && ask.node === result.node ? ask.visit : 1;
    const center = new AttentionCenter(join(base, "attention"), [osNotifier]);
    await center.raise({ run: runId, node: result.node, visit, reason: result.reason }).catch(() => {});
  };
}

/**
 * `resume <run> [--force]`. When another runner holds the run: a genuine live runner owns it
 * (exit 0, nothing to do); a holder that is NOT this run's runner (a legacy lock naming some
 * other process) raises attention and exits 1 naming `--force`, which breaks such a lock but
 * never a genuine runner's (engine/control.ts forceReleaseRunner).
 */
export async function resumeCommand(runId: string, opts: { force?: boolean } = {}): Promise<void> {
  const runDir = join(runsDir, runId);
  if (opts.force) {
    const refused = forceReleaseRunner(runDir);
    if (refused) throw new Error(`cannot force: ${refused.refused}`);
  }
  const path = join(runDir, "run.jsonl");
  if (!existsSync(path)) throw new Error(`unknown run: ${runId}`);
  const replayed = replayState(readLog(path));
  if (!replayed.started) throw new Error(`${runId}: empty log`);
  if (replayed.finished) return void console.log(`run ${runId} already finished: ${replayed.finished.outcome}`);
  const registry = await loadRegistry(base, ROOT);
  const graph = registry.graphs[replayed.started.graph];
  if (!graph) {
    const broken = registry.problems.find((p) => p.name === replayed.started!.graph);
    throw new Error(
      broken
        ? `run ${runId} uses local graph "${broken.name}", which no longer loads: ${broken.error}`
        : `run ${runId} uses unknown graph "${replayed.started!.graph}"`,
    );
  }
  const engine: Engine = new Engine(graph, {
    dir: runDir,
    executors: executors(),
    promptsDir: promptSearchPath(base, ROOT),
    cwd: replayed.started.cwd,
    folderKind: replayed.started.folder_kind,
    overrides: (replayed.started.overrides ?? undefined) as any, // the launch overrides survive resume
    tuning: loadTuning(base)[replayed.started.graph],
    harnesses: harnessSettings(),
    control: () => readControl(runDir),
    beforeNode: reconcilerHook(runDir, () => engine),
    probe: async () => "unknown", // ambiguous side effects park for `howdah resolve-effect`
    whileHeld: raiseParkAttention(runId),
  });
  const result = await engine.resume();
  if (result.state === "busy") {
    // another live runner holds this run (`up`, a decision route and a resume can race): it owns it
    if (result.holder.genuine)
      return void console.log(`run ${runId} already has a live runner (pid ${result.holder.pid ?? "?"}) — nothing to do`);
    throw new Error(await raiseRunnerLock(join(base, "attention"), [osNotifier], runId, result.holder));
  }
  console.log(`run ${runId}: ${JSON.stringify(result)}`);
}

/**
 * howdah up — the supervisor (A7.2's heartbeat + R7's resume-on-boot). Every tick:
 * write the heartbeat; resume any unfinished run whose runner process is dead and whose
 * park (if any) has been answered. Parked-and-unanswered runs stay parked — the human is
 * the unblock, not the supervisor.
 */
export async function jumpCommand(runId: string, node: string, message?: string): Promise<void> {
  const runDir = join(runsDir, runId);
  const path = join(runDir, "run.jsonl");
  // the precheck (live runner, finished, unknown node, missing reads) is shared with the
  // viewer's jump route — engine/control.ts jumpRefusal
  const check = jumpRefusal(runDir, node, GRAPHS);
  if (!check.ok) throw new Error(check.message);
  const { replayed } = check;

  // system-map 0.3: a jump resets every node's maxVisits budget (not its visit numbers),
  // otherwise jumping to a node parked on maxVisits re-parks it immediately
  new EventLog(path).append({ type: "operator-jump", to: node, message, reset_budgets: true });
  new AttentionCenter(join(base, "attention"), []).resolve(`${runId}:${replayed.parked?.node}:${replayed.parked?.visit}`);
  clearControl(runDir);
  console.log(`jumped ${runId} to ${node}${message ? " with instruction" : ""}; resuming`);
  await resumeCommand(runId);
}

export async function upCommand(opts: { intervalMs?: number; once?: boolean } = {}): Promise<void> {
  const interval = opts.intervalMs ?? 5000;
  console.log(`howdah up: supervising ${runsDir}`);
  for (;;) {
    writeHeartbeat(join(base, "heartbeat.json"));
    const ids = existsSync(runsDir) ? readdirSync(runsDir).filter((d) => existsSync(join(runsDir, d, "run.jsonl"))) : [];
    for (const id of ids) {
      const runDir = join(runsDir, id);
      try {
        const replayed = replayState(readLog(join(runDir, "run.jsonl")));
        if (runnerAlive(runDir)) {
          // a lock held by something that is not this run's runner never resolves by itself:
          // say so (once) instead of skipping the run silently every tick
          const holder = runnerHolder(runDir);
          if (holder && !holder.genuine) await raiseRunnerLock(join(base, "attention"), [osNotifier], id, holder);
          continue;
        }
        // parked = awaiting the human (the reply/decision flow resumes it); paused or a control
        // command = the operator holds it. A DECIDED awaiting-approval park is not parked (D17).
        if (!supervisorShouldResume(replayed, readControl(runDir))) continue;
        console.log(`resuming dead run ${id}`);
        const child = Bun.spawn(["bun", import.meta.path, "resume", id], {
          env: { ...process.env },
          stdout: "ignore",
          stderr: "ignore",
        });
        child.unref();
      } catch {
        /* torn log mid-write — next tick */
      }
    }
    if (opts.once) return;
    await Bun.sleep(interval);
  }
}

export async function doctorCommand(): Promise<boolean> {
  // [name, pass, detail, optional?] — an optional check that fails is reported, in its own
  // glyph, without making `doctor` say the install is broken
  const checks: Array<[string, boolean, string, boolean?]> = [];
  const probe = (cmd: string[]): string | null => {
    try {
      const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
      return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim().split("\n")[0] ?? "" : null;
    } catch {
      return null;
    }
  };
  /**
   * HOW-17: a loop over the harness table, not a hand-written claude/codex pair — the third
   * harness must not need an edit here to be reported on. An `optional` harness (cursor) is
   * reported honestly when it is missing without failing the whole check: not having it
   * installed is a choice, not a broken install. An `internal` one (opencode) has no CLI of
   * its own and is skipped rather than double-reported under claude's binary.
   *
   * Being on PATH is not being logged in, and a logged-out CLI fails every agent node while
   * `--version` still answers happily — so each installed harness is also asked its own
   * local, token-free status subcommand.
   */
  for (const name of harnessNames()) {
    const spec = harnessSpec(name);
    if (spec.status === "internal") continue;
    const optional = spec.status === "optional";
    const version = probe([spec.binary, "--version"]);
    checks.push([
      `${name} CLI`,
      version !== null,
      version ?? `not on PATH — install ${spec.binary}${optional ? " to use it as a harness or fallback" : " (subscription auth)"}`,
      optional,
    ]);
    if (version === null) continue;
    const auth = probeAuth(name);
    checks.push([
      `${name} logged in`,
      auth !== "out",
      auth === "in"
        ? "authenticated"
        : auth === "out"
          ? `NOT logged in — run \`${spec.binary} ${spec.loginVerb}\``
          : `could not tell (no ${spec.binary} status subcommand?)`,
      optional,
    ]);
  }
  const gh = probe(["gh", "--version"]);
  checks.push(["gh CLI", gh !== null, gh ?? "not on PATH — needed for PR probes (T18)"]);
  const git = probe(["git", "--version"]);
  checks.push(["git", git !== null, git ?? "not on PATH"]);
  const config = loadConfig(base);
  checks.push(["HOWDAH_HOME", true, base]);
  checks.push(["config", existsSync(join(base, "config.json")), join(base, "config.json")]);
  checks.push(["runs dir", existsSync(runsDir), runsDir]);
  for (const [name, r] of Object.entries(config.repos))
    checks.push([`repo ${name}`, existsSync(r.path), r.path]);
  for (const [name, f] of Object.entries(config.folders))
    checks.push([`folder ${name}`, existsSync(f.path), f.path]);
  const hb = existsSync(join(base, "heartbeat.json"));
  checks.push(["howdah up heartbeat", hb, hb ? join(base, "heartbeat.json") : "not running — start `howdah up`"]);

  let ok = true;
  for (const [name, pass, detail, optional] of checks) {
    if (!pass && !optional) ok = false;
    console.log(`${pass ? "✓" : optional ? "—" : "✗"} ${name.padEnd(24)} ${detail}`);
  }
  return ok;
}

export function setupCommand(): void {
  ensureHowdahHome(base);
  console.log("Howdah setup complete");
  console.log(`home: ${base}`);
  console.log(`config: ${join(base, "config.json")}`);
  console.log(`runs: ${runsDir}`);
  console.log(`repos: ${join(base, "repos")}`);
  console.log("");
  console.log("Next:");
  console.log("  howdah doctor");
  console.log("  howdah workspace add <name> <path>");
  console.log("  howdah up");
}

/**
 * system-map 0.2: the reply rules live in engine/control.ts resolveReply (shared with the
 * web route). A refusal names the verb that can move the run and exits non-zero.
 */
export function replyCommand(runId: string, text: string): void {
  const runDir = join(runsDir, runId);
  const result = resolveReply(runDir, text, { graphs: GRAPHS });
  if (!result.ok) throw new Error(result.message);
  new AttentionCenter(join(base, "attention"), []).resolve(`${runId}:${result.node}:${result.visit}`);
  // if the runner died while parked, kick a resume so the answer takes effect
  if (!runnerAlive(runDir)) spawnResume(runId);
  console.log(result.rendered ? "replied — the retry will carry your reply" : "replied");
}

/**
 * HOW-3: `resolve-effect <run> <effect> happened|not-happened [--node <n>]` — the only exit
 * from an `ambiguous-effect` park besides hand-editing run.jsonl. The rules and the append
 * live in engine/control.ts resolveEffect, shared with the web route; a refusal exits
 * non-zero and appends nothing. The resolution must MOVE the run, so a dead runner is kicked.
 */
export function resolveEffectCommand(runId: string, effect: string, verdict: string, node?: string): void {
  if (!EFFECT_VERDICTS.includes(verdict as EffectVerdict))
    throw new Error(`usage: howdah resolve-effect <run-id> <effect> ${EFFECT_VERDICTS.join("|")} [--node <node>]`);
  const runDir = join(runsDir, runId);
  const result = resolveEffect(runDir, effect, verdict as EffectVerdict, { node });
  if (!result.ok) throw new Error(`${result.message} [${result.code}]`);
  clearAsks(join(base, "attention"), runDir, result.asks);
  console.log(result.idempotent ? `"${effect}" was already resolved as ${verdict}` : `recorded: "${effect}" ${verdict}`);
  if (!runnerAlive(runDir)) spawnResume(runId);
}

// ---- system map (system-map 1b/1c) -------------------------------------------------------

/** `map <dir> [...]`: a thin wrapper — map/cli.ts owns the arguments and the output. */
export function mapCommand(args: string[]): number {
  const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "map", "cli.ts"), ...args], { stdout: "inherit", stderr: "inherit", env: { ...process.env } });
  return r.exitCode ?? 1;
}

/** `metrics [--json]` (T16): reads every runs/<id>/run.jsonl under HOWDAH_HOME. */
export async function metricsCommand(args: string[]): Promise<void> {
  const { formatMetrics, metricsReport, readRunMetrics } = await import("./metrics");
  const report = metricsReport(readRunMetrics(runsDir));
  console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatMetrics(report));
}

// ---- approval verbs (system-map 1a) ------------------------------------------------------

function decided(result: DecisionResult): Extract<DecisionResult, { ok: true }> {
  if (!result.ok) throw new Error(`${result.message} [${result.code}]`);
  return result;
}

async function wake(runId: string, result: Extract<DecisionResult, { ok: true }>): Promise<void> {
  await afterDecision(join(runsDir, runId), result, { attentionDir: join(base, "attention"), spawn: () => spawnResume(runId) });
}

/**
 * `--proposal <id>` binds a decision to that round (refused as superseded if it is no longer
 * current). It is a flag only among the LEADING arguments: before a `--` separator, and —
 * for `comment` — before the free text starts (after `<run> <entity-id>`), so a comment
 * whose text happens to contain "--proposal" is kept verbatim:
 *   comment r1 --proposal 7 e1 some text      flag
 *   comment r1 e1 the --proposal flag is odd  text
 *   comment r1 e1 -- --proposal as text       text (after `--`)
 * `textFrom` = how many positionals come before free text (Infinity: no free text).
 */
/** pull `--name <value>` out of an argument list wherever it sits; the rest keeps its order */
export function takeFlag(args: string[], name: string): { value: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) {
      value = args[++i];
      continue;
    }
    rest.push(args[i]!);
  }
  return { value, rest };
}

export function splitProposalFlag(args: string[], textFrom = Infinity): { proposalId: number | undefined; rest: string[] } {
  let proposalId: number | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const inText = rest.length >= textFrom;
    // `--` separates while no text has been taken yet (it may sit exactly where the text starts)
    if (a === "--" && rest.length <= textFrom) {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (a === "--proposal" && !inText) {
      const raw = args[++i] ?? "";
      if (!/^\d+$/.test(raw)) throw new Error(`--proposal needs a proposal id (a number), got "${raw}"`);
      proposalId = Number(raw);
      continue;
    }
    rest.push(a);
  }
  return { proposalId, rest };
}

export async function approveCommand(runId: string, proposalId?: number): Promise<void> {
  const r = decided(approve(join(runsDir, runId), { proposalId }));
  await wake(runId, r);
  console.log(r.idempotent ? `proposal #${r.proposal_id} was already approved` : `approved proposal #${r.proposal_id}`);
}

export async function sendFeedbackCommand(runId: string, proposalId?: number): Promise<void> {
  const r = decided(sendFeedback(join(runsDir, runId), { proposalId }));
  await wake(runId, r);
  console.log(r.idempotent ? `feedback on proposal #${r.proposal_id} was already sent` : `sent feedback on proposal #${r.proposal_id}`);
}

export function commentCommand(runId: string, entityId: string, text: string, proposalId?: number): void {
  const r = decided(pinComment(join(runsDir, runId), entityId, text, { proposalId }));
  console.log(`pinned ${r.comment_id} to ${entityId} on proposal #${r.proposal_id}`);
}

/** like jump: refused while a runner is live; resumes in-process once the jump is logged */
export async function redesignCommand(runId: string, message: string): Promise<void> {
  const runDir = join(runsDir, runId);
  const r = decided(redesign(runDir, message, { graphs: GRAPHS }));
  clearAsks(join(base, "attention"), runDir, r.asks);
  clearControl(runDir);
  console.log(`redesign requested — re-running from ${r.jumped_to}`);
  await resumeCommand(runId);
}

if (import.meta.main) {
  const [verb, ...rest] = process.argv.slice(2);
  try {
    if (verb === "run") await runCommand(rest);
    else if (verb === "runs") {
      const ids = existsSync(runsDir) ? readdirSync(runsDir).filter((d) => existsSync(join(runsDir, d, "run.jsonl"))) : [];
      console.log(JSON.stringify(ids));
    } else if (verb === "reply") replyCommand(rest[0] ?? "", rest.slice(1).join(" "));
    else if (verb === "resolve-effect") {
      const { value: node, rest: args } = takeFlag(rest, "--node");
      resolveEffectCommand(args[0] ?? "", args[1] ?? "", args[2] ?? "", node);
    }
    else if (verb === "resume") {
      const id = rest.find((a) => a !== "--force") ?? "";
      clearControl(join(runsDir, id));
      await resumeCommand(id, { force: rest.includes("--force") });
    }
    else if (verb === "pause") {
      const runDir = join(runsDir, rest[0] ?? "");
      if (!existsSync(join(runDir, "run.jsonl")))
        throw new Error(`unknown run: ${rest[0] ?? ""} (checked ${runsDir}; set HOWDAH_HOME to the home used by the web server)`);
      writeControl(runDir, "pause");
      markPaused(runDir);
      const interrupted = await interruptRunner(runDir);
      console.log(interrupted ? "pause requested — interrupted live runner" : "pause requested");
    }
    else if (verb === "abort") { writeControl(join(runsDir, rest[0] ?? ""), "abort"); console.log("abort requested — lands at the next node boundary"); }
    else if (verb === "jump") await jumpCommand(rest[0] ?? "", rest[1] ?? "", rest.slice(2).join(" ") || undefined);
    else if (verb === "approve" || verb === "send-feedback" || verb === "comment") {
      const { proposalId, rest: args } = splitProposalFlag(rest, verb === "comment" ? 2 : Infinity);
      if (verb === "approve") await approveCommand(args[0] ?? "", proposalId);
      else if (verb === "send-feedback") await sendFeedbackCommand(args[0] ?? "", proposalId);
      else commentCommand(args[0] ?? "", args[1] ?? "", args.slice(2).join(" "), proposalId);
    }
    else if (verb === "redesign") await redesignCommand(rest[0] ?? "", rest.slice(1).join(" "));
    else if (verb === "up") await upCommand({ once: rest.includes("--once") });
    else if (verb === "setup") setupCommand();
    else if (verb === "map") process.exit(mapCommand(rest));
    else if (verb === "metrics") await metricsCommand(rest);
    else if (verb === "doctor") process.exit((await doctorCommand()) ? 0 : 1);
    else if (verb === "graphs") {
      const reg = await loadRegistry(base, ROOT);
      console.log(JSON.stringify(catalogOf(reg), null, 2));
      // a local graph that does not load is NOT silently absent from the list
      for (const p of reg.problems) console.error(`! ${p.name}: ${p.error}`);
    }
    else if (verb === "workspace") {
      const [action, name, rawPath] = rest;
      const config = loadConfig(base);
      if (action === "add" && name && rawPath) {
        const p = rawPath.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
        if (!existsSync(p)) throw new Error(`path does not exist: ${p}`);
        if (config.repos[name] || config.folders[name]) throw new Error(`workspace "${name}" already exists`);
        const probe = Bun.spawnSync(["git", "-C", p, "rev-parse", "--is-inside-work-tree"], { stdout: "pipe", stderr: "pipe" });
        if (probe.exitCode === 0 && new TextDecoder().decode(probe.stdout).trim() === "true") {
          config.repos[name] = { path: p };
          console.log(`registered repo "${name}" → ${p}`);
        } else {
          config.folders[name] = { path: p };
          console.log(`registered folder "${name}" → ${p} (not a git repo — Plain workspace)`);
        }
        saveConfig(config, base);
      } else if (action === "add-github" && name) {
        const { registerGithubRepo } = await import("../config/github");
        const r = registerGithubRepo(config, name);
        saveConfig(config, base);
        console.log(`registered repo "${r.name}" → ${r.path} (${r.cloned ? "cloned" : "existing clone"}, default ${r.defaultBranch})`);
      } else if (action === "remove" && name) {
        delete config.repos[name];
        delete config.folders[name];
        saveConfig(config, base);
        console.log(`removed "${name}"`);
      } else if (action === "list" || action === undefined) {
        console.log(JSON.stringify({ repos: config.repos, folders: config.folders }, null, 2));
      } else throw new Error("usage: howdah workspace add <name> <path> | add-github <owner/name> | remove <name> | list");
    }
    else if (verb === "new-graph") {
      const { newGraph } = await import("./new-graph");
      const kind = (rest[rest.indexOf("--kind") + 1] ?? "custom") as import("./new-graph").GraphKind;
      const path = await newGraph(rest[0] ?? "", kind, base);
      console.log(`scaffolded ${path} — edit it, then: howdah run ${rest[0]}`);
    }
    else {
      console.error("usage: howdah setup|run|resume|pause|abort|jump|reply|resolve-effect|approve|comment|send-feedback|redesign|map|metrics|runs|graphs|new-graph|workspace|up|doctor");
      process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
