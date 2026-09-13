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
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../engine/run";
import { defaultExecutors } from "../engine/executors";
import { EventLog, readLog } from "../log/write";
import { AttentionCenter, osNotifier } from "../engine/attention";
import { GRAPHS, graphCatalog } from "../graphs/index";
import { howdahHome, loadConfig, resolveWorkspace } from "../config/config";

const base = howdahHome();
const runsDir = join(base, "runs");

function parseRunArgs(argv: string[]) {
  const inputs: Record<string, string> = {};
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
    else throw new Error(`unknown flag: ${a}`);
  }
  return { graphName, inputs, workspace, dir, id };
}

export async function runCommand(argv: string[]): Promise<string> {
  const { graphName, inputs, workspace, dir, id } = parseRunArgs(argv);
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
  const engine = new Engine(graph, { dir: runDir, executors: defaultExecutors(), cwd, folderKind });
  console.log(`run ${runId} starting (${cwd ?? "no folder"})`);
  const result = await engine.start(inputs);
  if (result.state === "parked") {
    const center = new AttentionCenter(join(base, "attention"), [osNotifier]);
    await center.raise({ run: runId, node: result.node, visit: 1, reason: result.reason }).catch(() => {});
  }
  console.log(`run ${runId}: ${JSON.stringify(result)}`);
  return runId;
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
    else if (verb === "graphs") console.log(JSON.stringify(graphCatalog(), null, 2));
    else {
      console.error("usage: howdah run <graph> [-i k=v]... [--workspace name|--dir path] | runs | reply <id> <text> | graphs");
      process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
