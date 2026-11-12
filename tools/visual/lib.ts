/**
 * Shared helpers for the HOW-68 baseline seed. Everything here drives the REAL engine with
 * in-process scripted executors (the same seam graphs/implement-ticket.test.ts uses), so every
 * run.jsonl is written by engine/run.ts + log/write.ts, prompts are really pinned and
 * `prompt-rendered` hashes reconstruct VERIFIED. Only the model's words are scripted.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { AttemptResult, ExecArgs, Executor } from "../../engine/run";
import type { TurnUsage } from "../../adapter/events";
import type { ParkCode } from "../../log/events";

export const REPO = resolve(import.meta.dir, "../..");
/** everything the harness writes goes here, never into the repo (override with HOWDAH_VISUAL_OUT) */
export const SCRATCH = process.env.HOWDAH_VISUAL_OUT ?? join(tmpdir(), "howdah-visual");
export const HOME = join(SCRATCH, "home");
export const ROOT = join(SCRATCH, "repo"); // a private copy of the repo: the server's repoRoot + build output
export const WORK = join(SCRATCH, "work"); // the demo workspaces (git repos)
export const RUNS = join(HOME, "runs");
export const ATTENTION = join(HOME, "attention");
export const PORT = Number(process.env.HOWDAH_VISUAL_PORT ?? 4799);

export type Step =
  | { t: "text"; s: string }
  | { t: "think"; s: string }
  | { t: "tool"; name: string; input: unknown; result: string; error?: boolean };

export interface NodeScript {
  steps?: Step[];
  /** the closing prose, before the outputs line */
  say?: string;
  writes?: Record<string, unknown>;
  usage?: TurnUsage;
  fail?: { reason: string; code?: ParkCode };
  /** run after the chunks, before returning — e.g. raise an ask and hang */
  then?: (a: ExecArgs) => Promise<AttemptResult | void>;
  harness?: "claude" | "codex";
}

export const text = (s: string): Step => ({ t: "text", s });
export const think = (s: string): Step => ({ t: "think", s });
export const tool = (name: string, input: unknown, result: string, error = false): Step => ({ t: "tool", name, input, result, error });
export const never = () => new Promise<never>(() => {});

let toolSeq = 0;
/** Append one scripted agent turn the way engine/executors/claude.ts does. */
export function streamTurn(a: ExecArgs, s: NodeScript, turn = 1): void {
  const { log, nodeId: node, visit } = a;
  let index = 0;
  const harness = s.harness ?? "claude";
  log.append({
    type: "agent-environment", node, visit, harness, setting_sources: harness === "claude" ? "project,local" : null, inherits_user: false,
    version: harness === "claude" ? "2.1.283" : "0.162.1", model: harness === "claude" ? "claude-fable-5" : "gpt-5.2-codex", permission_mode: a.def.kind === "agent" && a.def.readOnly ? "plan" : "auto",
    tools: ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "TodoWrite", "AskUserQuestion", "mcp__linear__get_issue"],
    skills: ["tdd", "investigate"], plugins: [{ name: "gstack", source: "project" }], mcp_servers: [{ name: "linear", source: "project" }],
    memory_paths: [`${a.cwd ?? "."}/CLAUDE.md`],
    hooks: [{ name: "SessionStart:startup", exit_code: 0, injected: { sha256: "9f2c1a77d0b4e6aa31c5", chars: 412, text: "Remember: run `bun test` before you say a change works." } }],
    files: [
      { path: ".claude/settings.json", scope: "project", sha256: "4be1c0ffee0d15ea5e4be1c0ffee0d15ea5e4be1c0ffee0d15ea5e4be1c0ffee" },
      { path: "CLAUDE.md", scope: "project", sha256: "77aa10c4d2f09b6e77aa10c4d2f09b6e77aa10c4d2f09b6e77aa10c4d2f09b6e" },
      { path: "~/.claude/settings.json", scope: "user", sha256: null },
    ],
  });
  for (const st of s.steps ?? []) {
    if (st.t === "text") log.append({ type: "chunk", node, visit, turn, index: index++, kind: "text", content: st.s });
    else if (st.t === "think") log.append({ type: "chunk", node, visit, turn, index: index++, kind: "thinking", content: st.s });
    else {
      const id = `toolu_${String(++toolSeq).padStart(4, "0")}`;
      const raw = typeof st.input === "string" ? st.input : JSON.stringify(st.input);
      // claude.ts clips every tool input to 400 chars except TodoWrite (HOW-49)
      const content = st.name === "TodoWrite" || raw.length <= 400 ? raw : raw.slice(0, 400) + "…";
      log.append({ type: "chunk", node, visit, turn, index: index++, kind: "tool_call", content, tool_id: id, tool_name: st.name, input_hash: Bun.hash(raw).toString(16) });
      // claude reports a verdict on EVERY result (`is_error` true or false); a step scripted with no
      // `error` at all is a log from before HOW-38, or a harness that only reports failures
      log.append({ type: "chunk", node, visit, turn, index: index++, kind: "tool_result", content: st.result, tool_id: id, tool_name: st.name, ...(st.error !== undefined ? { is_error: st.error } : {}) });
    }
  }
  if (s.fail === undefined && s.then === undefined) {
    const out = `${s.say ?? "Done."}\n\n${JSON.stringify({ outputs: s.writes ?? {} })}`;
    log.append({ type: "chunk", node, visit, turn, index: index++, kind: "text", content: out });
  } else if (s.say) log.append({ type: "chunk", node, visit, turn, index: index++, kind: "text", content: s.say });
  if (s.then === undefined) {
    const usage: TurnUsage = s.usage ?? (harness === "codex"
      ? { input_tokens: 48210, output_tokens: 3110, cost_usd: null, cost_source: "unpriced" }
      : { input_tokens: 1840 + 97 * index, cache_read_input_tokens: 212_400 + 3100 * index, cache_creation_input_tokens: 18_230, output_tokens: 2210 + 180 * index, cost_usd: Number((0.21 + 0.031 * index).toFixed(4)), cost_source: "reported" });
    log.append({ type: "turn-finalized", node, visit, turn, usage });
  }
}

export type ScriptFor = (nodeId: string, visit: number, a: ExecArgs) => NodeScript | undefined;

/** an agent executor that plays a script; an unscripted node publishes placeholder writes */
export function scriptedAgent(scriptFor: ScriptFor): Executor {
  return async (a) => {
    const def = a.def;
    const keys = def.kind === "agent" ? Object.keys(def.writes ?? {}) : [];
    const s = scriptFor(a.nodeId, a.visit, a) ?? {};
    const writes = s.writes ?? Object.fromEntries(keys.map((k) => [k, `${k} for ${a.nodeId}`]));
    streamTurn(a, { ...s, writes });
    if (s.then) {
      const r = await s.then(a);
      if (r) return r;
    }
    if (s.fail) return { status: "failed", writes: {}, reason: s.fail.reason, ...(s.fail.code ? { code: s.fail.code } : {}) };
    return { status: "succeeded", writes };
  };
}

export const ok = (writes: Record<string, unknown> = {}): AttemptResult => ({ status: "succeeded", writes });

/**
 * Spread a log's timestamps over [startAgoMin, endAgoMin] before now. The engine wrote the
 * events milliseconds apart; a baseline needs durations and "waiting 3h" to look like a real
 * day. Only `ts` changes — order, seq and every payload (hashes included) are untouched.
 */
export function retime(runDir: string, startAgoMin: number, endAgoMin: number): { first: string; last: string } {
  const path = join(runDir, "run.jsonl");
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { seq: number; ts: string; type: string });
  const weights = lines.map((e, i) => {
    if (i === 0) return 0;
    const jitter = ((e.seq * 2654435761) % 1000) / 1000; // deterministic
    if (e.type === "chunk") return 1 + jitter * 4;
    if (e.type === "turn-finalized" || e.type === "node-finished") return 6 + jitter * 20;
    if (e.type === "attention-raised") return 2;
    return 0.5 + jitter;
  });
  const total = weights.reduce((s, w) => s + w, 0) || 1;
  const now = Date.now();
  const start = now - startAgoMin * 60_000;
  const span = (startAgoMin - endAgoMin) * 60_000;
  let acc = 0;
  for (const [i, e] of lines.entries()) {
    acc += weights[i]!;
    e.ts = new Date(start + (acc / total) * span).toISOString();
  }
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { first: lines[0]!.ts, last: lines.at(-1)!.ts };
}

export function lastPark(runDir: string): { node: string; visit: number; reason: string; ts: string } | null {
  const path = join(runDir, "run.jsonl");
  if (!existsSync(path)) return null;
  const evs = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return evs.findLast((e: any) => e.type === "attention-raised") ?? null;
}
