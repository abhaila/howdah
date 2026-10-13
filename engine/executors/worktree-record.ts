/**
 * The run's worktree record (T18) — a LEAF module: which checkout a run works in, recorded in
 * the run dir (worktree.json) by the worktree executor's `create`. Every executor and the
 * engine resolve their cwd through effectiveCwd(), so a run "moves into" its worktree without
 * the engine mutating state. Kept apart from worktree.ts so modules the command executor
 * dispatches to (engine/executors/map.ts) can read it without an import cycle.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface WorktreeRecord {
  path: string;
  branch: string;
  repo: string;
  /**
   * HOW-57 (decision C): the ref the branch was started from (`origin/main`, `origin/<stack
   * base>`, or `HEAD` when there is no remote) and its sha — the first "recorded tip" a
   * `git:restack` replays from. Absent on a record written before HOW-57.
   */
  base?: string;
  base_sha?: string;
}

export function worktreeRecordPath(runDir: string): string {
  return join(runDir, "worktree.json");
}

export function readWorktreeRecord(runDir: string): WorktreeRecord | null {
  const p = worktreeRecordPath(runDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as WorktreeRecord;
  } catch {
    return null;
  }
}

/** where a node actually works: the run's worktree once one exists, else the run cwd */
export function effectiveCwd(logPath: string, cwd: string | undefined): string | undefined {
  return readWorktreeRecord(dirname(logPath))?.path ?? cwd;
}
