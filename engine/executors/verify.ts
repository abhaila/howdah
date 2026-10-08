/**
 * `verify:run` (HOW-12) — the command built-in that RUNS the code before it is reviewed.
 *
 * Drift is structural: a `verified` ghost proves the code parses the way it was designed to,
 * not that it works. This built-in runs the workspace's configured test command
 * (`RepoWorkspace.verifyCommand`, config/config.ts) in the run's worktree and publishes one
 * fact, `verify.result` (core/verify.ts VerifyResult):
 *
 *   exit 0                          → pass
 *   non-zero exit, or a timeout     → fail — and the ATTEMPT STILL SUCCEEDS. A failing suite is
 *                                     evidence about the code, not an executor error: it must
 *                                     reach the reviewer (who rejects on it), not park the run.
 *   no command, no worktree/repo    → not-checked, with a reason that says how to configure one.
 *                                     Never a silent pass; never a park either, or every
 *                                     implement-slice run would stop until HOW-15's environment
 *                                     contract exists.
 *
 * The full output streams into the log as `chunk` events, exactly as a general command's does;
 * context carries only a bounded tail (VERIFY_OUTPUT_TAIL_CHARS). If the command's final stdout
 * line is a JSON object it rides along as `facts` — the "facts from the final JSON line"
 * contract, optional here. `commit` (+ `dirty`) ties the verdict to the code it ran against.
 *
 * Refused BEFORE anything is spawned: a node declaring a write other than `verify.result`
 * (the graph is wrong, and declaredWrites() would only notice after the suite ran).
 */
import { dirname } from "node:path";
import type { AttemptResult, Executor } from "../run";
import { probeGit } from "../reconcile";
import { readWorktreeRecord, effectiveCwd } from "./worktree-record";
import { declaredWrites } from "./map";
import { runShell, type ShellResult } from "./shell";
import { VERIFY_BUILTIN, VERIFY_PRODUCES, VERIFY_RESULT_KEY, tail, type VerifyResult } from "../../core/verify";

export { VERIFY_BUILTIN, VERIFY_PRODUCES } from "../../core/verify";

export function isVerifyBuiltin(run: string): boolean {
  return run.trim().split(/\s+/)[0] === VERIFY_BUILTIN;
}

export interface VerifyBuiltinOpts {
  /**
   * The workspace's verify command for a repo path, or undefined when none is configured.
   * Injected (cli/main.ts reads config.json), so the engine stays free of config loading —
   * the same seam as the worktree executor's `repoName`.
   */
  commandFor?: (repoPath: string) => string | undefined;
  /** a node's own `timeoutMs` wins; default 10 minutes, the general command's default */
  defaultTimeoutMs?: number;
  /** injectable for tests; default ./shell.ts runShell */
  run?: typeof runShell;
}

const HOW_TO_CONFIGURE =
  'register one with `howdah workspace add <name> <path> --verify "<cmd>"`, or set ' +
  '"verifyCommand" on the repo in $HOWDAH_HOME/config.json';

export function verifyBuiltinExecutor(opts: VerifyBuiltinOpts = {}): Executor {
  return async (args) => {
    const { def, nodeId, visit, log, cwd } = args;
    if (def.kind !== "command") throw new Error("verify built-in on a non-command node");
    const extra = def.run.trim().split(/\s+/).slice(1);
    if (extra.length) return failed(`${VERIFY_BUILTIN} takes no arguments (got "${extra.join(" ")}") — the command comes from the workspace`);
    const producible = VERIFY_PRODUCES as readonly string[];
    const unproducible = Object.keys(def.writes ?? {}).filter((k) => !producible.includes(k));
    if (unproducible.length)
      return failed(`${VERIFY_BUILTIN} cannot produce ${unproducible.join(", ")} — it publishes only ${producible.join(", ")}. Nothing was run.`);

    const publish = (result: VerifyResult): AttemptResult => ({
      status: "succeeded",
      writes: declaredWrites(VERIFY_BUILTIN, def, { [VERIFY_RESULT_KEY]: result }),
    });
    let index = 0;
    const chunk = (kind: "tool_call" | "tool_result" | "text", content: string) =>
      log.append({ type: "chunk", node: nodeId, visit, turn: 1, index: index++, kind, content });
    const notChecked = (reason: string) => {
      chunk("tool_result", `not-checked: ${reason}`);
      return publish({ outcome: "not-checked", output_tail: "", reason });
    };

    const record = readWorktreeRecord(dirname(log.path));
    const repo = record?.repo ?? cwd;
    const workDir = effectiveCwd(log.path, cwd);
    if (!repo || !workDir) return notChecked("the run has no repo or worktree to run tests in, so the code was never run");
    const command = opts.commandFor?.(repo)?.trim();
    if (!command) return notChecked(`no verify command is configured for the workspace at ${repo}, so the code was never run — ${HOW_TO_CONFIGURE}`);

    const git = probeGit(workDir);
    chunk("tool_call", command);
    const timeoutMs = def.timeoutMs ?? opts.defaultTimeoutMs ?? 600_000;
    const r = await (opts.run ?? runShell)(command, { cwd: workDir, timeoutMs, onStdout: (text) => chunk("text", text) });
    if (r.stderr) chunk("text", r.stderr);

    const passed = r.exitCode === 0 && !r.timedOut;
    const facts = finalJsonLine(r.stdout);
    const result: VerifyResult = {
      outcome: passed ? "pass" : "fail",
      command,
      exit_code: r.exitCode,
      duration_ms: r.durationMs,
      timed_out: r.timedOut,
      output_tail: tail(combined(r)),
      commit: git.head,
      dirty: git.uncommitted > 0,
      ...(facts ? { facts } : {}),
      ...(passed ? {} : { reason: failReason(r, timeoutMs) }),
    };
    chunk("tool_result", passed ? `pass (exit 0, ${r.durationMs}ms)` : `fail: ${result.reason}`);
    return publish(result);
  };
}

type Failed = AttemptResult & { status: "failed" };
const failed = (reason: string): Failed => ({ status: "failed", writes: {}, reason });

/** stdout then stderr — the tail is what the reviewer sees, and runners print failures last */
function combined(r: ShellResult): string {
  if (!r.stderr) return r.stdout;
  if (!r.stdout) return r.stderr;
  return `${r.stdout}${r.stdout.endsWith("\n") ? "" : "\n"}${r.stderr}`;
}

function failReason(r: ShellResult, timeoutMs: number): string {
  if (r.timedOut) return `timed out after ${timeoutMs}ms and was killed`;
  return r.exitCode === null ? "ended on a signal" : `exited ${r.exitCode}`;
}

/** The final non-empty stdout line, when it is a JSON OBJECT — anything else is just output. */
export function finalJsonLine(stdout: string): Record<string, unknown> | undefined {
  const last = stdout.trim().split("\n").at(-1)?.trim() ?? "";
  if (!last.startsWith("{")) return undefined;
  try {
    const v: unknown = JSON.parse(last);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
