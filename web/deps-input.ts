/**
 * HOW-57: `deps` picked in New run. `runs:launch` writes a stacked run's `deps` itself, for
 * siblings of one plan; an operator starting `implement-stacked` by hand picks existing runs
 * instead. The form sends only what a person chooses — `{ run_id, until }` per row — and this
 * fills in the rest FROM THE PICKED RUN'S OWN LOG, never from the browser: `slice` is the run's
 * id (the label runs:await prints) and `workspace` is the registered workspace its
 * `run-started.cwd` belongs to.
 *
 * Refused here, before anything is spawned, because past the spawn a bad value is a park on the
 * first step that nobody asked for: a run that does not exist, a run in no registered
 * workspace, a repeated run, more than one `published` (a run has ONE stack base), and a
 * `published` base in another workspace (a branch can only be stacked in the same repo).
 * The result is checked with `parseDeps`, the one reader `runs:await` uses.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readLog } from "../log/write";
import { DEP_UNTIL, parseDeps, type DepRef, type DepUntil } from "../core/stack";

export type DepsInput = { ok: true; deps: string } | { ok: false; error: string };

/** `picked` is the form's JSON string; anything a row carries beyond run_id and until is ignored. */
export function resolveDepsInput(
  picked: string,
  ctx: { runsDir: string; workspace: string | undefined; workspaceOf: (cwd: string) => string | null },
): DepsInput {
  let rows: unknown;
  try {
    rows = JSON.parse(picked);
  } catch {
    return { ok: false, error: `deps must be the list of runs this one waits for — got "${picked.length > 60 ? `${picked.slice(0, 57)}…` : picked}"` };
  }
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, error: "pick at least one run for this stacked run to wait for" };

  const deps: DepRef[] = [];
  for (const [i, row] of rows.entries()) {
    const r = (row ?? {}) as Record<string, unknown>;
    const runId = typeof r.run_id === "string" ? r.run_id.trim() : "";
    const until = r.until;
    if (!runId) return { ok: false, error: `dependency ${i + 1}: pick a run` };
    if (typeof until !== "string" || !(DEP_UNTIL as readonly string[]).includes(until))
      return { ok: false, error: `dependency ${i + 1}: "wait until" must be ${DEP_UNTIL.join(", ")}` };
    if (deps.some((d) => d.run_id === runId)) return { ok: false, error: `${runId} is picked twice` };
    const logPath = join(ctx.runsDir, runId, "run.jsonl");
    if (!existsSync(logPath)) return { ok: false, error: `no run called ${runId}` };
    const started = readLog(logPath).find((e) => e.type === "run-started");
    const cwd = started?.type === "run-started" ? started.cwd : undefined;
    const workspace = cwd ? ctx.workspaceOf(cwd) : null;
    if (!workspace) return { ok: false, error: `${runId} did not run in a registered workspace, so there is nothing to stack on or wait for` };
    deps.push({ slice: runId, until: until as DepUntil, run_id: runId, workspace });
  }

  const published = deps.filter((d) => d.until === "published");
  if (published.length > 1)
    return { ok: false, error: `only one dependency can be "published" — it is the branch this run stacks on; have ${published.map((d) => d.run_id).join(", ")}` };
  const base = published[0];
  if (base && ctx.workspace && base.workspace !== ctx.workspace)
    return { ok: false, error: `${base.run_id} ran in ${base.workspace}, so this run (in ${ctx.workspace}) cannot stack on its branch — wait for it to be merged instead` };

  const value = JSON.stringify(deps);
  const check = parseDeps(value);
  return check.ok ? { ok: true, deps: value } : { ok: false, error: check.reason };
}
