/**
 * `verify:run` — HOW-12's behavioural-evidence built-in. It runs the workspace's registered
 * verification command inside the run's worktree and publishes a `verify.verdict`
 * (core/verify.ts) that a graph routes on. Implement-slice runs it between `map.drift` and
 * `implementation.local_review`, so a change that parses the way it was designed but does not
 * RUN goes back to implement instead of out to publish.
 *
 * It lives IN-PROCESS behind the command executor, beside `probe:pr`, the map built-ins and
 * `runs:launch`, rather than being a shell step with the command pasted in, for three reasons:
 *   - THE COMMAND IS THE WORKSPACE'S, NOT THE GRAPH'S. One built-in graph serves every
 *     registered repo, and each repo verifies differently. The command is looked up from
 *     config.json through an injected `verifyCommandFor` — the engine stays free of config
 *     reading, exactly as `runs:launch` takes its workspace registry from cli/main.ts.
 *   - A FAILING COMMAND IS A FACT, NOT A FAILED ATTEMPT. The general command executor turns a
 *     non-zero exit into a failed attempt, which PARKS the run. A red test suite is the most
 *     ordinary outcome there is and it has an obvious next step (implement again), so the
 *     attempt succeeds and the verdict says `fail`. Only the harness itself breaking — the
 *     shell cannot be spawned — throws and parks.
 *   - IT HAS TO SAY WHICH CODE IT RAN. The verdict records the worktree's HEAD and its
 *     uncommitted count, observed just before the command started.
 *
 * Output: stdout and stderr are BOTH streamed as chunks (test runners report on stderr — bun
 * test does) and both feed a bounded tail kept in the verdict. The final JSON line of stdout is
 * carried as `facts`; the exit code alone decides pass/fail (see core/verify.ts).
 *
 * Timeout: `timeoutMs` on the node, else the executor default (10 minutes, as for any command).
 * The command runs in its OWN process group and the whole group is killed at the deadline — a
 * `bash -c` wrapper killed alone leaves `bun test` holding the pipes open, and the read loop
 * below would then wait on them forever.
 */
import type { AttemptResult, Executor } from "../run";
import { effectiveCwd } from "./worktree-record";
import { probeGit } from "../reconcile";
import {
  VERIFY_BUILTIN, VERIFY_KEY, VERIFY_PRODUCES, finalJsonFacts, outputTail,
  type VerifyVerdict,
} from "../../core/verify";

export { VERIFY_BUILTIN, VERIFY_PRODUCES, isVerifyBuiltin } from "../../core/verify";

/** What a workspace registered: the command, and the name it is registered under. */
export interface VerifyCommand {
  workspace: string;
  command: string;
}

export interface VerifyBuiltinOpts {
  /**
   * The verification command registered for the workspace at this path (the run's own cwd,
   * i.e. the repo the worktree was cut from), or null when nothing is registered there.
   */
  verifyCommandFor?: (repoPath: string) => VerifyCommand | null;
  defaultTimeoutMs?: number;
}

type Failed = AttemptResult & { status: "failed" };
const failed = (reason: string): Failed => ({ status: "failed", writes: {}, reason });

export function verifyBuiltinExecutor(opts: VerifyBuiltinOpts = {}): Executor {
  return async ({ def, nodeId, visit, cwd, log }) => {
    if (def.kind !== "command") throw new Error(`${VERIFY_BUILTIN} on a non-command node`);

    // a graph bug, refused before anything runs — a verification can take minutes, and
    // spending them only to throw at the declaredWrites below would be the launch bug again
    if (def.run.trim() !== VERIFY_BUILTIN)
      return failed(`${VERIFY_BUILTIN} takes no arguments — the command comes from the workspace (\`howdah workspace verify <name> <command>\`), not the graph: "${def.run}"`);
    const producible = VERIFY_PRODUCES as readonly string[];
    const unproducible = Object.keys(def.writes ?? {}).filter((k) => !producible.includes(k));
    if (unproducible.length)
      return failed(`${VERIFY_BUILTIN} cannot produce ${unproducible.join(", ")} — it publishes only ${producible.join(", ")}`);

    let index = 0;
    const chunk = (kind: "tool_call" | "tool_result" | "text", content: string) =>
      log.append({ type: "chunk", node: nodeId, visit, turn: 1, index: index++, kind, content });
    const publish = (verdict: VerifyVerdict, reason?: string): AttemptResult => ({
      status: "succeeded",
      writes: Object.keys(def.writes ?? {}).includes(VERIFY_KEY) ? { [VERIFY_KEY]: verdict } : {},
      ...(reason ? { reason } : {}),
    });

    const registered = cwd ? (opts.verifyCommandFor?.(cwd) ?? null) : null;
    const workDir = effectiveCwd(log.path, cwd);
    const git = workDir ? probeGit(workDir) : null;
    const observed = { commit: git?.head ?? null, uncommitted: git?.uncommitted ?? 0 };

    if (!registered || !registered.command.trim()) {
      const why = !cwd
        ? "this run has no workspace folder, so there is no verification command to look up"
        : `no verification command is registered for ${registered?.workspace ? `workspace "${registered.workspace}"` : cwd} — ` +
          `register one with \`howdah workspace verify <name> "<command>"\``;
      chunk("tool_result", `not run: ${why}`);
      return publish(
        { status: "not-configured", command: null, workspace: registered?.workspace ?? null, exit_code: null, timed_out: false, duration_ms: 0, ...observed, output_tail: why },
        // a THREAD NOTE, not a park: the run carries on, but nobody should read its end as
        // "verified" without having been told the code was never run
        `verification skipped — ${why}`,
      );
    }
    if (!workDir) return failed(`${VERIFY_BUILTIN} has no working directory to run "${registered.command}" in`);

    const { command, workspace } = registered;
    chunk("tool_call", command);
    const started = Date.now();
    const proc = Bun.spawn(["bash", "-c", command], {
      cwd: workDir, stdout: "pipe", stderr: "pipe", env: { ...process.env },
      // its own process group, so the deadline can kill the whole tree (see the header)
      detached: true,
    });
    const timeoutMs = def.timeoutMs ?? opts.defaultTimeoutMs ?? 600_000;
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL"); // the group is already gone; make sure the leader is too
      }
    }, timeoutMs);

    let combined = "";
    let stdout = "";
    const drain = async (stream: ReadableStream<Uint8Array>, isStdout: boolean) => {
      const decoder = new TextDecoder();
      for await (const bytes of stream) {
        const text = decoder.decode(bytes, { stream: true });
        if (!text) continue;
        combined += text;
        if (isStdout) stdout += text;
        chunk("text", text);
      }
    };
    await Promise.all([drain(proc.stdout, true), drain(proc.stderr, false)]);
    await proc.exited;
    clearTimeout(killer);

    const exitCode = timedOut ? null : proc.exitCode;
    const facts = finalJsonFacts(stdout);
    const verdict: VerifyVerdict = {
      status: !timedOut && exitCode === 0 ? "pass" : "fail",
      command,
      workspace,
      exit_code: exitCode,
      timed_out: timedOut,
      duration_ms: Date.now() - started,
      ...observed,
      output_tail: outputTail(combined),
      ...(facts ? { facts } : {}),
    };
    chunk(
      "tool_result",
      timedOut ? `fail: killed after ${timeoutMs}ms` : `${verdict.status}: exit ${exitCode}`,
    );
    return publish(verdict);
  };
}
