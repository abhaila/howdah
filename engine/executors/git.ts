/**
 * The git primitives HOW-57's executors share (a LEAF module, like worktree-record.ts): a
 * synchronous `git` that never waits on a credential prompt, `rev-parse` that answers null
 * rather than throwing, and the one rule for "origin's default branch" — used by the worktree
 * create (where a new branch starts) and by `git:restack` (what a merged base is replaced by).
 */

/**
 * HOW-69: the forge (gh) could not be reached — a network timeout, a 5xx, a dropped
 * connection. Its own TYPE, not a message to grep, because the engine retries exactly this
 * failure on a read-only probe and nothing else: "no PR" is a null answer, never this, so the
 * two outcomes reconcile.ts keeps distinct stay distinct here too. The message is unchanged
 * ("forge unreachable: …"), so every park and log line reads as before.
 */
export class ForgeUnreachableError extends Error {
  constructor(detail: string) {
    super(`forge unreachable: ${detail}`);
    this.name = "ForgeUnreachableError";
  }
}

export function sh(cmd: string[], cwd?: string, timeoutMs?: number): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(cmd, {
    cwd, stdout: "pipe", stderr: "pipe",
    // never let git sit on a credential prompt nobody can answer
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  });
  return { code: r.exitCode ?? 1, stdout: new TextDecoder().decode(r.stdout), stderr: new TextDecoder().decode(r.stderr) };
}

/** the commit `ref` names, or null when it names none */
export function revParse(repo: string, ref: string): string | null {
  const r = sh(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo);
  return r.code === 0 ? r.stdout.trim() || null : null;
}

/**
 * The default branch origin has, as this clone sees it: the configured one, else origin's HEAD,
 * else main, else master — the first that exists as a remote-tracking ref. Null when none does.
 * Shared with `git:restack`, which replays a branch onto it after its stack base merged.
 */
export function remoteDefaultBranch(repo: string, configured?: string): { branch: string; sha: string } | null {
  const candidates = [
    ...(configured ? [configured] : []),
    sh(["git", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repo).stdout.trim().replace(/^origin\//, ""),
    "main",
    "master",
  ].filter((b) => b !== "");
  for (const branch of candidates) {
    const sha = revParse(repo, `refs/remotes/origin/${branch}`);
    if (sha) return { branch, sha };
  }
  return null;
}
