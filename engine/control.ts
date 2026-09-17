/**
 * Run control file (T22): the operator's channel INTO a live runner. The engine reads it
 * at every node boundary — pause and abort therefore land between attempts, never
 * mid-write. The file also gates `howdah up`: a paused/aborted run is never auto-resumed.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "./attention";

export type ControlCommand = "pause" | "abort";

export function controlPath(runDir: string): string {
  return join(runDir, "control.json");
}

export function readControl(runDir: string): ControlCommand | null {
  const p = controlPath(runDir);
  if (!existsSync(p)) return null;
  try {
    const c = (JSON.parse(readFileSync(p, "utf8")) as { command?: string }).command;
    return c === "pause" || c === "abort" ? c : null;
  } catch {
    return null;
  }
}

export function writeControl(runDir: string, command: ControlCommand): void {
  writeFileSync(controlPath(runDir), JSON.stringify({ command, at: new Date().toISOString() }));
}

export function clearControl(runDir: string): void {
  rmSync(controlPath(runDir), { force: true });
}

/** Stop a live runner and its direct harness child; the event log remains resumable. */
export async function interruptRunner(runDir: string, graceMs = 500): Promise<boolean> {
  const pidFile = join(runDir, "runner.pid");
  if (!existsSync(pidFile)) return false;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isFinite(pid) || pid <= 0 || !pidAlive(pid)) return false;
  try {
    Bun.spawnSync(["pkill", "-TERM", "-P", String(pid)]);
    process.kill(pid, "SIGTERM");
    await Bun.sleep(graceMs);
    if (pidAlive(pid)) process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}
