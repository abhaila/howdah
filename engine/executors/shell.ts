/**
 * `bash -c` with streaming and a timeout — the ONE copy shared by the general command executor
 * (T18, engine/executors/worktree.ts) and `verify:run` (HOW-12, engine/executors/verify.ts),
 * so the two cannot drift on how a script is spawned, streamed or killed.
 *
 * The script runs in its own process group (`detached`) and a timeout signals the GROUP: a
 * test runner forks workers, and killing only `bash` left those holding stdout open, so the
 * read loop — and the node — waited for them however long they took. SIGTERM first, then
 * SIGKILL after a short grace, so a runner that cleans up on TERM gets to.
 *
 * stderr is drained concurrently with stdout: reading it only after stdout closed let a
 * chatty stderr fill its pipe and block the child forever.
 */

export interface ShellResult {
  stdout: string;
  stderr: string;
  /** null when the process ended on a signal */
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export interface ShellOpts {
  cwd?: string;
  timeoutMs: number;
  /** each decoded stdout piece, as it arrives (the executors log these as chunks) */
  onStdout?: (text: string) => void;
  /** grace between SIGTERM and SIGKILL on timeout (default 2000ms) */
  killGraceMs?: number;
  /** injectable clock */
  now?: () => number;
}

export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // the group is already gone
  }
}

/**
 * HOW-38: end a whole process group — SIGTERM, then SIGKILL after the grace — so a harness
 * killed for being stuck or past its ceiling leaves no grandchild (a test runner's workers, a
 * tool's shell) holding on. The group exists because the harness was spawned `detached`.
 */
export function killGroup(pid: number, graceMs = 2000): void {
  signalGroup(pid, "SIGTERM");
  setTimeout(() => signalGroup(pid, "SIGKILL"), graceMs).unref?.();
}

export async function runShell(script: string, opts: ShellOpts): Promise<ShellResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const proc = Bun.spawn(["bash", "-c", script], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
    detached: true,
  });
  let timedOut = false;
  let hardKill: ReturnType<typeof setTimeout> | undefined;
  const killer = setTimeout(() => {
    timedOut = true;
    signalGroup(proc.pid, "SIGTERM");
    hardKill = setTimeout(() => signalGroup(proc.pid, "SIGKILL"), opts.killGraceMs ?? 2000);
  }, opts.timeoutMs);

  const stderrText = new Response(proc.stderr).text();
  const decoder = new TextDecoder();
  let stdout = "";
  for await (const bytes of proc.stdout) {
    const text = decoder.decode(bytes, { stream: true });
    if (!text) continue;
    stdout += text;
    opts.onStdout?.(text);
  }
  const stderr = await stderrText;
  await proc.exited;
  clearTimeout(killer);
  if (hardKill) clearTimeout(hardKill);
  return { stdout, stderr, exitCode: proc.exitCode, timedOut, durationMs: now() - started };
}
