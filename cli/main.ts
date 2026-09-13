#!/usr/bin/env bun
/**
 * howdah — thin scripting verbs (design A9.2: the CLI is not a designed surface, the web
 * view is; these exist for scripts, launchd, and the start-run API).
 *
 *   howdah run <graph> [-i key=value]... [--workspace <name>] [--dir <path>] [--id <run-id>]
 *   howdah runs --json
 *   howdah reply <run-id> <text>
 *   howdah graphs --json
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../engine/run";
import { liveExecutors, stubExecutors } from "../engine/executors";
import { EventLog, readLog } from "../log/write";
import { AttentionCenter, osNotifier, pidAlive, writeHeartbeat } from "../engine/attention";
import { replayState } from "../engine/replay";
import { Reconciler, readsForgeFacts } from "../engine/reconcile";
import { effectiveCwd, readWorktreeRecord } from "../engine/executors/worktree";
import { GRAPHS, graphCatalog } from "../graphs/index";
import { howdahHome, loadConfig, resolveWorkspace } from "../config/config";

const base = howdahHome();
const runsDir = join(base, "runs");

function executors() {
  // HOWDAH_STUB short-circuits real agent spawns — tests and dry runs
  return process.env.HOWDAH_STUB
    ? stubExecutors()
    : liveExecutors({ attentionDir: join(base, "attention"), worktreesDir: join(base, "worktrees") });
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

function writePid(runDir: string): void {
  writeFileSync(join(runDir, "runner.pid"), String(process.pid));
}

function runnerAlive(runDir: string): boolean {
  const p = join(runDir, "runner.pid");
  if (!existsSync(p)) return false;
  const pid = Number(readFileSync(p, "utf8").trim());
  return Number.isFinite(pid) && pid > 0 && pidAlive(pid);
}

function parseRunArgs(argv: string[]) {
  const inputs: Record<string, string> = {};
  const overrides: import("../core/graph").AgentConfig = {};
  let workspace: string | undefined, dir: string | undefined, id: string | undefined;
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
    else if (a === "--model") overrides.model = rest[++i];
    else if (a === "--harness") overrides.harness = rest[++i] as any;
    else if (a === "--effort") overrides.effort = rest[++i] as any;
    else throw new Error(`unknown flag: ${a}`);
  }
  return { graphName, inputs, workspace, dir, id, overrides };
}

export async function runCommand(argv: string[]): Promise<string> {
  const { graphName, inputs, workspace, dir, id, overrides } = parseRunArgs(argv);
  // HOWDAH_MODEL is a run-level default so the RECORD shows what actually ran
  if (!overrides.model && process.env.HOWDAH_MODEL) overrides.model = process.env.HOWDAH_MODEL;
  const graph = graphName ? GRAPHS[graphName] : undefined;
  if (!graph) throw new Error(`unknown graph "${graphName}" — have: ${Object.keys(GRAPHS).join(", ")}`);

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
    dir: runDir, executors: executors(), cwd, folderKind, overrides,
    beforeNode: reconcilerHook(runDir, () => engine),
  });
  console.log(`run ${runId} starting (${cwd ?? "no folder"})`);
  writePid(runDir);
  const result = await engine.start(inputs);
  if (result.state === "parked") {
    const center = new AttentionCenter(join(base, "attention"), [osNotifier]);
    await center.raise({ run: runId, node: result.node, visit: 1, reason: result.reason }).catch(() => {});
  }
  console.log(`run ${runId}: ${JSON.stringify(result)}`);
  return runId;
}

export async function resumeCommand(runId: string): Promise<void> {
  const runDir = join(runsDir, runId);
  const path = join(runDir, "run.jsonl");
  if (!existsSync(path)) throw new Error(`unknown run: ${runId}`);
  const replayed = replayState(readLog(path));
  if (!replayed.started) throw new Error(`${runId}: empty log`);
  if (replayed.finished) return void console.log(`run ${runId} already finished: ${replayed.finished.outcome}`);
  const graph = GRAPHS[replayed.started.graph];
  if (!graph) throw new Error(`run ${runId} uses unknown graph "${replayed.started.graph}"`);
  const engine: Engine = new Engine(graph, {
    dir: runDir,
    executors: executors(),
    cwd: replayed.started.cwd,
    folderKind: replayed.started.folder_kind,
    beforeNode: reconcilerHook(runDir, () => engine),
    probe: async () => "unknown", // ambiguous side effects park for the operator
  });
  writePid(runDir);
  const result = await engine.resume();
  if (result.state === "parked") {
    const center = new AttentionCenter(join(base, "attention"), [osNotifier]);
    const visit = replayed.visits[result.node] ?? 1;
    await center.raise({ run: runId, node: result.node, visit, reason: result.reason }).catch(() => {});
  }
  console.log(`run ${runId}: ${JSON.stringify(result)}`);
}

/**
 * howdah up — the supervisor (A7.2's heartbeat + R7's resume-on-boot). Every tick:
 * write the heartbeat; resume any unfinished run whose runner process is dead and whose
 * park (if any) has been answered. Parked-and-unanswered runs stay parked — the human is
 * the unblock, not the supervisor.
 */
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
        if (!replayed.started || replayed.finished) continue;
        if (runnerAlive(runDir)) continue;
        if (replayed.parked) continue; // awaiting the human; the reply flow resumes it
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
  const checks: Array<[string, boolean, string]> = [];
  const probe = (cmd: string[]): string | null => {
    try {
      const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
      return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim().split("\n")[0] ?? "" : null;
    } catch {
      return null;
    }
  };
  const claude = probe(["claude", "--version"]);
  checks.push(["claude CLI", claude !== null, claude ?? "not on PATH — install Claude Code (subscription auth)"]);
  const codex = probe(["codex", "--version"]);
  checks.push(["codex CLI", codex !== null, codex ?? "not on PATH — install Codex (subscription auth)"]);
  const gh = probe(["gh", "--version"]);
  checks.push(["gh CLI", gh !== null, gh ?? "not on PATH — needed for PR probes (T18)"]);
  const git = probe(["git", "--version"]);
  checks.push(["git", git !== null, git ?? "not on PATH"]);
  const config = loadConfig(base);
  for (const [name, r] of Object.entries(config.repos))
    checks.push([`repo ${name}`, existsSync(r.path), r.path]);
  for (const [name, f] of Object.entries(config.folders))
    checks.push([`folder ${name}`, existsSync(f.path), f.path]);
  const hb = existsSync(join(base, "heartbeat.json"));
  checks.push(["howdah up heartbeat", hb, hb ? join(base, "heartbeat.json") : "not running — start `howdah up`"]);

  let ok = true;
  for (const [name, pass, detail] of checks) {
    if (!pass) ok = false;
    console.log(`${pass ? "✓" : "✗"} ${name.padEnd(24)} ${detail}`);
  }
  return ok;
}

function replyCommand(runId: string, text: string): void {
  const path = join(runsDir, runId, "run.jsonl");
  if (!existsSync(path)) throw new Error(`unknown run: ${runId}`);
  const events = readLog(path);
  const ask = events.findLast((e) => e.type === "attention-raised");
  if (!ask || events.some((e) => e.type === "attention-resolved" && e.seq > ask.seq))
    throw new Error("nothing awaiting a reply");
  new EventLog(path).append({ type: "attention-resolved", node: ask.node, visit: ask.visit, reply: text });
  new AttentionCenter(join(base, "attention"), []).resolve(`${runId}:${ask.node}:${ask.visit}`);
  // if the runner died while parked, kick a resume so the answer takes effect
  if (!runnerAlive(join(runsDir, runId))) {
    Bun.spawn(["bun", import.meta.path, "resume", runId], { env: { ...process.env }, stdout: "ignore", stderr: "ignore" }).unref();
  }
  console.log("replied");
}

if (import.meta.main) {
  const [verb, ...rest] = process.argv.slice(2);
  try {
    if (verb === "run") await runCommand(rest);
    else if (verb === "runs") {
      const ids = existsSync(runsDir) ? readdirSync(runsDir).filter((d) => existsSync(join(runsDir, d, "run.jsonl"))) : [];
      console.log(JSON.stringify(ids));
    } else if (verb === "reply") replyCommand(rest[0] ?? "", rest.slice(1).join(" "));
    else if (verb === "resume") await resumeCommand(rest[0] ?? "");
    else if (verb === "up") await upCommand({ once: rest.includes("--once") });
    else if (verb === "doctor") process.exit((await doctorCommand()) ? 0 : 1);
    else if (verb === "graphs") console.log(JSON.stringify(graphCatalog(), null, 2));
    else if (verb === "new-graph") {
      const { newGraph } = await import("./new-graph");
      const kind = (rest[rest.indexOf("--kind") + 1] ?? "custom") as import("./new-graph").GraphKind;
      console.log(`scaffolded ${await newGraph(rest[0] ?? "", kind)}`);
    }
    else {
      console.error("usage: howdah run|resume|reply|runs|graphs|new-graph|up|doctor");
      process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
