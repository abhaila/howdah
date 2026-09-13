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
import { howdahHome, loadConfig, saveConfig, resolveWorkspace } from "../config/config";
import { loadTuning } from "../config/tuning";
import { readControl, writeControl, clearControl } from "../engine/control";

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
    else if (a === "--permission-mode") overrides.permissionMode = rest[++i] as any;
    else if (a === "--max-turns") overrides.maxTurns = Number(rest[++i]);
    else if (a === "--skills") overrides.skills = (rest[++i] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
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
    tuning: loadTuning(base)[graphName!],
    control: () => readControl(runDir),
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
    tuning: loadTuning(base)[replayed.started.graph],
    control: () => readControl(runDir),
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
export async function jumpCommand(runId: string, node: string, message?: string): Promise<void> {
  const runDir = join(runsDir, runId);
  const path = join(runDir, "run.jsonl");
  if (!existsSync(path)) throw new Error(`unknown run: ${runId}`);
  if (runnerAlive(runDir)) throw new Error("runner is live — pause or abort first, then jump");
  const replayed = replayState(readLog(path));
  if (!replayed.started) throw new Error("empty run");
  if (replayed.finished) throw new Error(`run already finished (${replayed.finished.outcome})`);
  const graph = GRAPHS[replayed.started.graph];
  if (!graph) throw new Error(`unknown graph ${replayed.started.graph}`);
  const def = graph.def.nodes[node];
  if (!def) throw new Error(`unknown node "${node}" — have: ${Object.keys(graph.def.nodes).join(", ")}`);
  if (def.kind === "terminal") throw new Error("cannot jump to a terminal node");

  // precheck: the target's declared reads must be satisfiable from the replayed context,
  // otherwise the jump is refused with the missing keys named — never a runtime surprise
  const { ContextStore } = await import("../core/context");
  const declared = graph.declarations() as Record<string, { scope: any; writer: string[] }>;
  for (const k of graph.def.inputs) {
    if (declared[k]) declared[k]!.writer.push("__inputs__");
    else declared[k] = { scope: "sticky", writer: ["__inputs__"] };
  }
  const ctx = new ContextStore(declared as any);
  ctx.beginAttempt("__inputs__", 0);
  for (const k of graph.def.inputs) ctx.set(k as never, (replayed.started.inputs as any)[k] as never);
  ctx.endAttempt("succeeded");
  for (const f of replayed.finishes) {
    ctx.beginAttempt(f.node, f.visit);
    for (const [k, v] of Object.entries(f.writes)) ctx.set(k as never, v as never);
    ctx.endAttempt(f.status);
  }
  const reads: string[] = "reads" in def && def.reads ? def.reads : [];
  const missing = reads.filter((k) => !ctx.has(k as never));
  if (missing.length)
    throw new Error(`cannot jump to "${node}": context missing ${missing.join(", ")} — those writers have not run`);

  new EventLog(path).append({ type: "operator-jump", to: node, message });
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
        if (!replayed.started || replayed.finished) continue;
        if (runnerAlive(runDir)) continue;
        if (replayed.parked) continue; // awaiting the human; the reply flow resumes it
        if (replayed.paused || readControl(runDir)) continue; // operator holds it — never auto-resume
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
    else if (verb === "resume") { clearControl(join(runsDir, rest[0] ?? "")); await resumeCommand(rest[0] ?? ""); }
    else if (verb === "pause") { writeControl(join(runsDir, rest[0] ?? ""), "pause"); console.log("pause requested — lands at the next node boundary"); }
    else if (verb === "abort") { writeControl(join(runsDir, rest[0] ?? ""), "abort"); console.log("abort requested — lands at the next node boundary"); }
    else if (verb === "jump") await jumpCommand(rest[0] ?? "", rest[1] ?? "", rest.slice(2).join(" ") || undefined);
    else if (verb === "up") await upCommand({ once: rest.includes("--once") });
    else if (verb === "doctor") process.exit((await doctorCommand()) ? 0 : 1);
    else if (verb === "graphs") console.log(JSON.stringify(graphCatalog(), null, 2));
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
      console.log(`scaffolded ${await newGraph(rest[0] ?? "", kind)}`);
    }
    else {
      console.error("usage: howdah run|resume|pause|abort|jump|reply|runs|graphs|new-graph|workspace|up|doctor");
      process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
