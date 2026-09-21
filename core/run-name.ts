/**
 * HOW-18: the one rule for an operator's run name. A run name is a display label only — the
 * run id (`<graph>-<base36 time>`) stays identity for the run dir, the worktree and the
 * `howdah/<run-id>` branch, because free text is not a safe path segment. The CLI (`run
 * --name`) and the launch route (POST /api/runs) both call this, so a name the web form sends
 * is refused with the same words as one typed at the shell; the route has to refuse BEFORE it
 * spawns, since a detached CLI failing on a bad name would fail silently.
 *
 * Dependency-free on purpose, like core/clock-time.ts: the browser bundle may import it.
 */
export const RUN_NAME_MAX = 120;

/** C0/C1 controls (newline and tab among them) and the Unicode line/paragraph separators */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export type RunNameResult = { ok: true; name?: string } | { ok: false; error: string };

/**
 * Trim; empty or whitespace-only means "no name" (`name` absent, so the run-started event keeps
 * its old shape). Refuses a non-string, a name over RUN_NAME_MAX characters (counted in code
 * points, so an emoji is one), or one containing a line break or control character.
 */
export function normalizeRunName(raw: unknown): RunNameResult {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "string") return { ok: false, error: "run name must be a string" };
  const name = raw.trim();
  if (!name) return { ok: true };
  if (CONTROL.test(name)) return { ok: false, error: "run name must be one line with no control characters" };
  const length = [...name].length;
  if (length > RUN_NAME_MAX) return { ok: false, error: `run name is ${length} characters — at most ${RUN_NAME_MAX}` };
  return { ok: true, name };
}
