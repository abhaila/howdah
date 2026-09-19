/**
 * Lockfiles with stale-PID recovery (system-map 0.5, shared since 1a). Two locks use this:
 *   - `<run.jsonl>.lock` — held for one append (log/write.ts EventLog.withLock);
 *   - `<runDir>/runner.pid` — held for a whole engine run (engine/control.ts claimRunner),
 *     so at most one runner drives a run: `howdah up`, a decision route and a manual
 *     resume can all race to resume the same run and exactly one wins.
 *
 * A lock is a file created O_EXCL holding its owner's IDENTITY: `<pid> <start time>`, the
 * start time as `ps -o lstart=` prints it (LC_ALL=C, TZ=UTC so every reader formats it the
 * same). A lock is broken when its holder is not that process any more:
 *   - the PID is dead;
 *   - the PID is alive but started at a different time — REUSED (system-map 1a review: a
 *     runner that died abnormally, then a reboot, and launchd's `up` found runner.pid naming
 *     some unrelated live process: the run looked "running" forever and nothing woke it);
 *   - a legacy PID-only lock (no start time) whose live PID is not a bun/howdah process;
 *   - empty and older than `staleMs` (the holder died between create and write).
 * When the identity cannot be checked (ps unavailable), the holder counts as LIVE — a lock
 * is never broken on a guess; the runner lock's operator escape hatch is `resume --force`.
 * `lstart` has 1-second resolution: a PID reused within the same second as its previous
 * owner started is undetectable (negligible: PIDs cycle far slower than that).
 * ps is `/bin/ps` by absolute path (no PATH lookup); HOWDAH_PS overrides it for tests.
 * `held` records the locks THIS process holds, so our own PID on a lock we do not hold reads
 * as a leftover (stale) while one we do hold is live. One inspect path serves both locks.
 */
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";

const MAX_BACKOFF_MS = 20;

/** Lock paths this process holds right now. */
export const held = new Set<string>();


export function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String(err.code) : undefined;
}

// ---- holder identity -----------------------------------------------------------------

/** `ps` for one PID, normalised so every process formats the answer identically; null = no answer */
function psField(pid: number, field: "lstart" | "command"): string | null {
  const ps = process.env.HOWDAH_PS ?? "/bin/ps";
  const r = spawnSync(ps, ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  if (r.error || r.status !== 0) return null;
  const out = (r.stdout ?? "").trim();
  return out.length > 0 ? out : null;
}

/** a PID's start time (cached for a second: an acquire loop polls a live holder often) */
const startCache = new Map<number, { at: number; start: string | null }>();
export function processStart(pid: number): string | null {
  const hit = startCache.get(pid);
  if (hit && Date.now() - hit.at < 1000) return hit.start;
  const start = psField(pid, "lstart");
  startCache.set(pid, { at: Date.now(), start });
  return start;
}

export function processCommand(pid: number): string | null {
  return psField(pid, "command");
}

let ownIdentity: string | null = null;
/** what a lock we create holds: `<pid> <start>` (just the pid if ps cannot say) */
export function lockIdentity(): string {
  if (ownIdentity === null) {
    const start = psField(process.pid, "lstart");
    ownIdentity = start ? `${process.pid} ${start}` : String(process.pid);
  }
  return ownIdentity;
}

export interface Holder {
  pid: number;
  /** recorded start time; undefined on a legacy PID-only lock */
  start: string | undefined;
}

export function parseHolder(content: string): Holder | undefined {
  const m = content.trim().match(/^(\d+)(?:\s+(.+))?$/);
  return m && m[1] !== undefined ? { pid: Number(m[1]), start: m[2] } : undefined;
}

/** a process that could be one of ours: bun running howdah, or any bun (tests, the viewer) */
export const looksLikeHowdah = (command: string): boolean => /(^|\/)bun(\s|$)|howdah|cli\/main\.ts/.test(command);

/**
 * Is the lock's holder still the process that took it?
 *   live        yes (or cannot tell — never broken on a guess)
 *   dead        the PID is gone, or reused by another process
 */
export function holderLiveness(h: Holder): "live" | "dead" {
  if (!pidAlive(h.pid)) return "dead";
  if (h.start !== undefined) {
    const now = processStart(h.pid);
    return now === null || now === h.start ? "live" : "dead";
  }
  const command = processCommand(h.pid);
  return command === null || looksLikeHowdah(command) ? "live" : "dead";
}

/** Create `lockPath` exclusively, holding our identity. Returns false if it already exists. */
export function tryCreate(lockPath: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if (errCode(err) === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, lockIdentity());
  } catch (err) {
    closeSync(fd);
    unlinkQuiet(lockPath); // never leave an empty lock behind on our own failure
    throw err;
  }
  closeSync(fd);
  return true;
}

export function unlinkQuiet(p: string): void {
  try {
    unlinkSync(p);
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errCode(err) !== "ESRCH"; // EPERM = exists under another user: alive
  }
}

export type LockState =
  | { kind: "gone" }
  | { kind: "held"; pid: number | undefined; stale: boolean; holder?: Holder };

export function inspectLock(lockPath: string, staleMs: number): LockState {
  let content: string;
  let mtimeMs: number;
  try {
    content = readFileSync(lockPath, "utf8").trim();
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch (err) {
    if (errCode(err) === "ENOENT") return { kind: "gone" };
    throw err;
  }
  const holder = parseHolder(content);
  if (holder === undefined) {
    // empty/garbled: a holder between open("wx") and writing its PID, or one that died there
    return { kind: "held", pid: undefined, stale: Date.now() - mtimeMs > staleMs };
  }
  // our own PID on a lock we do not hold (withLock checked) can only be a leftover
  const stale = holder.pid === process.pid ? !held.has(lockPath) : holderLiveness(holder) === "dead";
  return { kind: "held", pid: holder.pid, stale, holder };
}

/**
 * Break a stale lock. Guarded by `<lock>.break` so two waiters that both judged the same
 * lock stale cannot race: the second re-inspects under the guard, finds the first one's
 * fresh (live) lock, and leaves it alone. Returns false when another live process is mid-
 * break, so the caller backs off instead of spinning.
 */
export function breakStaleLock(lockPath: string, staleMs: number): boolean {
  const guard = `${lockPath}.break`;
  if (!tryCreate(guard)) {
    const g = inspectLock(guard, staleMs);
    if (g.kind === "held" && g.stale) {
      unlinkQuiet(guard); // a breaker died mid-break
      return true;
    }
    return g.kind === "gone"; // a live breaker is on it — back off like any other wait
  }
  try {
    const again = inspectLock(lockPath, staleMs);
    if (again.kind === "held" && again.stale) unlinkQuiet(lockPath);
    return true;
  } finally {
    unlinkQuiet(guard);
  }
}

export function acquireLock(lockPath: string, timeoutMs: number, staleMs: number): void {
  const deadline = Date.now() + timeoutMs;
  let backoff = 1;
  for (;;) {
    if (tryCreate(lockPath)) return;
    const state = inspectLock(lockPath, staleMs);
    if (state.kind === "gone") continue; // released between our create and our read
    if (state.stale && breakStaleLock(lockPath, staleMs)) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for log lock ${lockPath} (held by pid ${state.pid ?? "unknown — lock file has no PID yet"})`,
      );
    }
    Bun.sleepSync(Math.min(backoff, remaining));
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

/**
 * Release only a lock that is still ours. If a waiter wrongly judged ours stale and took
 * the lock (a frozen holder past staleLockMs, or PID reuse), unlinking by path would delete
 * THEIR live lock and let a third writer in — the loss of exclusion would cascade. Reading
 * then unlinking is itself check-then-act, but it bounds the damage to one overlapping pair.
 */
export function releaseLock(lockPath: string): void {
  let holder: string;
  try {
    holder = readFileSync(lockPath, "utf8").trim();
  } catch {
    return; // already gone
  }
  if (holder === lockIdentity() || holder === String(process.pid)) unlinkQuiet(lockPath);
}

/**
 * Take `lockPath` now or report who holds it — never waits on a live holder. A stale lock
 * is broken and retried. On success the lock is recorded in `held`; release it with
 * releaseHeld().
 */
export function tryAcquireLock(lockPath: string, staleMs: number): { ok: true } | { ok: false; holder: number | undefined } {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (tryCreate(lockPath)) {
      held.add(lockPath);
      return { ok: true };
    }
    const state = inspectLock(lockPath, staleMs);
    if (state.kind === "gone") continue;
    if (state.stale && breakStaleLock(lockPath, staleMs)) continue;
    return { ok: false, holder: state.pid };
  }
  const state = inspectLock(lockPath, staleMs);
  return { ok: false, holder: state.kind === "held" ? state.pid : undefined };
}

/** Release a lock taken with tryAcquireLock (only if it is still ours). */
export function releaseHeld(lockPath: string): void {
  held.delete(lockPath);
  releaseLock(lockPath);
}
