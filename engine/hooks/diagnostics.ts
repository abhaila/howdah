#!/usr/bin/env bun
/**
 * The post-edit diagnostics hook (HOW-39) — claude runs this after every Edit/Write/MultiEdit
 * of a node that opted in, and hands what it prints back to the model INSIDE the turn.
 *
 * Feedback used to reach an agent only after its turn (verify:run, map:drift): a type error it
 * just introduced cost a whole review/repair visit. The harness-design study (HOW-32) runs a
 * fast read-only check after every edit "so the model can fix them before spending a turn on
 * the tests" — though it held that component fixed and never ablated it, so the effect is
 * plausible, not measured: it stays opt-in until the A/B harness (HOW-42) says otherwise.
 *
 * Contract, probed against claude 2.1.296 (adapter/fixtures/claude-posttooluse-hook.jsonl):
 *   stdin   { hook_event_name: "PostToolUse", tool_name, tool_input, tool_response,
 *             tool_use_id, cwd, … }
 *   stdout  { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } } —
 *           the context reaches the model (the probe's model quoted it back). A PostToolUse
 *           hook emits NOTHING on claude's stream-json, so this script also appends a
 *           `diagnostics-ran` event to the run log, which the executor turns into a
 *           transcript line when the tool's result arrives.
 *
 * Configured through the environment claude passes to its hooks (engine/executors/claude.ts):
 *   HOWDAH_DIAG_CMD         the workspace's diagnosticsCommand
 *   HOWDAH_DIAG_TIMEOUT_MS  its own ceiling (default 20000) — a hung check says "timed out"
 *                           rather than blocking the turn
 *   HOWDAH_DIAG_LOG / _NODE / _VISIT   where to record what ran
 *
 * It never fails the turn: every path exits 0 with valid output, because a broken diagnostic
 * must cost the agent a sentence, not its edit.
 */
import { runShell } from "../executors/shell";
import { tail } from "../../core/verify";
import { EventLog } from "../../log/write";

/** a much smaller tail than verify's 4k: this lands inside the agent's context on EVERY edit */
export const DIAGNOSTICS_TAIL_CHARS = 2000;
export const DIAGNOSTICS_TIMEOUT_MS = 20_000;

/** the edit tools the hook fires after — claude's names (core/harnesses.ts editHooks) */
export const EDIT_TOOL_MATCHER = "Edit|Write|MultiEdit";

/**
 * The `--settings` JSON that installs this script as claude's PostToolUse hook. claude's own
 * `timeout` (seconds) sits above the script's, so the script always gets to say "timed out".
 */
export function diagnosticsSettings(timeoutMs = DIAGNOSTICS_TIMEOUT_MS): string {
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(import.meta.path)}`;
  return JSON.stringify({
    hooks: { PostToolUse: [{ matcher: EDIT_TOOL_MATCHER, hooks: [{ type: "command", command, timeout: Math.ceil(timeoutMs / 1000) + 10 }] }] },
  });
}

export interface DiagnosticsInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  cwd?: string;
}

export interface DiagnosticsRun {
  command: string;
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  output: string;
  file?: string;
}

/** the context the model is handed — what ran, how it ended, and the tail of what it said */
export function diagnosticsContext(r: DiagnosticsRun, tool: string): string {
  const what = `${tool}${r.file ? ` of ${r.file}` : ""}`;
  if (r.timed_out)
    return `[Howdah diagnostics] after your ${what}: \`${r.command}\` timed out after ${Math.round(r.duration_ms / 1000)}s, so nothing was checked. Carry on; the full suite still runs after your turn.`;
  if (r.exit_code === 0)
    return `[Howdah diagnostics] after your ${what}: \`${r.command}\` passed (${r.duration_ms}ms).`;
  return `[Howdah diagnostics] after your ${what}: \`${r.command}\` exited ${r.exit_code} (${r.duration_ms}ms). Fix what these say before moving on:\n${r.output}`;
}

export async function runDiagnostics(input: DiagnosticsInput, env: Record<string, string | undefined>): Promise<{ stdout: string; run: DiagnosticsRun | null }> {
  const command = env.HOWDAH_DIAG_CMD?.trim();
  const tool = input.tool_name ?? "edit";
  if (!command) return { stdout: "", run: null };
  const timeoutMs = Number(env.HOWDAH_DIAG_TIMEOUT_MS) > 0 ? Number(env.HOWDAH_DIAG_TIMEOUT_MS) : DIAGNOSTICS_TIMEOUT_MS;
  const file = typeof input.tool_input?.file_path === "string" ? input.tool_input.file_path : undefined;
  let run: DiagnosticsRun;
  try {
    const r = await runShell(command, { cwd: input.cwd ?? process.cwd(), timeoutMs, killGraceMs: 500 });
    run = {
      command, exit_code: r.exitCode, timed_out: r.timedOut, duration_ms: r.durationMs,
      output: tail(`${r.stdout}${r.stderr}`.trim(), DIAGNOSTICS_TAIL_CHARS), ...(file ? { file } : {}),
    };
  } catch (err) {
    run = { command, exit_code: null, timed_out: false, duration_ms: 0, output: `could not run: ${err instanceof Error ? err.message : String(err)}`, ...(file ? { file } : {}) };
  }
  if (env.HOWDAH_DIAG_LOG && env.HOWDAH_DIAG_NODE) {
    try {
      new EventLog(env.HOWDAH_DIAG_LOG).append({
        type: "diagnostics-ran", node: env.HOWDAH_DIAG_NODE, visit: Number(env.HOWDAH_DIAG_VISIT ?? 0),
        ...(input.tool_use_id ? { tool_use_id: input.tool_use_id } : {}), tool_name: tool, ...run,
      });
    } catch {
      // the record is best-effort; the agent still gets its feedback
    }
  }
  const stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: diagnosticsContext(run, tool) } });
  return { stdout, run };
}

if (import.meta.main) {
  let input: DiagnosticsInput = {};
  try {
    input = JSON.parse(await Bun.stdin.text()) as DiagnosticsInput;
  } catch {
    // no parseable input: run the check anyway, it is still the best feedback available
  }
  const { stdout } = await runDiagnostics(input, process.env);
  process.stdout.write(stdout);
  process.exit(0);
}
