/**
 * HOW-55: the files an agent's harness reads besides its prompt, hashed for `agent-environment`.
 *
 * `rendered_hash` proves the prompt, but a spawned `claude` also read the project's settings and
 * CLAUDE.md files — and, before HOW-55, the operator's user-level ones, whose SessionStart hooks
 * injected text no run recorded. What is hashed here is what the harness COULD have read:
 *
 *   project  CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md, .claude/settings.json and
 *            .claude/settings.local.json, from the working directory up to its git root — the
 *            files `--setting-sources project,local` still loads;
 *   user     the harness's `userConfig` (core/harnesses.ts) — only when they are loaded: the
 *            workspace opted in, or the harness has no switch to stop it (codex, cursor).
 *
 * An absent file is recorded as absent (`sha256: null`), never skipped: "there was no CLAUDE.md"
 * is a fact about the run too.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { harnessSpec, isHarness } from "../../core/harnesses";

const PROJECT_FILES = ["CLAUDE.md", "CLAUDE.local.md", join(".claude", "CLAUDE.md"), join(".claude", "settings.json"), join(".claude", "settings.local.json")];

export const sha256 = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

function hashFile(path: string): string | null {
  try {
    return existsSync(path) ? sha256(readFileSync(path)) : null;
  } catch {
    return null;
  }
}

/** the directories from `cwd` up to (and including) its git root — or just `cwd` outside git */
function projectDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    dirs.push(dir);
    if (existsSync(join(dir, ".git"))) return dirs;
    const up = dirname(dir);
    if (up === dir) return [resolve(cwd)];
    dir = up;
  }
}

export function environmentFiles(
  harness: string,
  cwd: string | undefined,
  loadsUser: boolean,
  home: string = homedir(),
): Array<{ path: string; scope: "project" | "user"; sha256: string | null }> {
  const out: Array<{ path: string; scope: "project" | "user"; sha256: string | null }> = [];
  if (cwd && (!isHarness(harness) || harnessSpec(harness).settingSources !== null))
    for (const dir of projectDirs(cwd)) for (const f of PROJECT_FILES) {
      const path = join(dir, f);
      const h = hashFile(path);
      // a project file that is not there is only noise below the working dir; at the cwd say so
      if (h !== null || dir === resolve(cwd)) out.push({ path, scope: "project", sha256: h });
    }
  if (loadsUser && isHarness(harness))
    for (const f of harnessSpec(harness).userConfig) {
      const path = f.replace(/^~(?=\/)/, home);
      out.push({ path, scope: "user", sha256: hashFile(path) });
    }
  return out;
}

/** the text a hook injected, as the log keeps it: hashed in full, its text bounded */
export function injectedRecord(text: string, max = 4000): { sha256: string; chars: number; text: string } {
  return { sha256: sha256(text), chars: text.length, text: text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text };
}

/**
 * HOW-55: what `doctor` says about the operator's user-level hooks — the ones an opted-in
 * workspace's agents would run before they read a word of their prompt. One line per workspace
 * that opted in, naming each hook event and its commands; one line overall when none did.
 */
export function userHookReport(
  workspaces: Array<{ name: string; inherits: boolean }>,
  home: string = homedir(),
): Array<{ name: string; detail: string }> {
  const path = join(home, ".claude", "settings.json");
  let hooks: Record<string, unknown> = {};
  try {
    if (existsSync(path)) hooks = ((JSON.parse(readFileSync(path, "utf8")) as { hooks?: Record<string, unknown> }).hooks ?? {}) as Record<string, unknown>;
  } catch {
    return [{ name: "user settings", detail: `${path} is not valid JSON — cannot say which hooks an opted-in agent would inherit` }];
  }
  const commands = (entry: unknown): string[] =>
    (Array.isArray(entry) ? entry : []).flatMap((m: any) => (Array.isArray(m?.hooks) ? m.hooks : [])).map((h: any) => String(h?.command ?? h?.type ?? "?"));
  const events = Object.entries(hooks).map(([event, entry]) => ({ event, commands: commands(entry) })).filter((e) => e.commands.length);
  const total = events.reduce((n, e) => n + e.commands.length, 0);
  const listing = events.map((e) => `${e.event}: ${e.commands.map((c) => (c.length > 60 ? `${c.slice(0, 57)}…` : c)).join(", ")}`).join("; ");
  const opted = workspaces.filter((w) => w.inherits);
  if (!opted.length)
    return [{ name: "user settings", detail: `not inherited — agents load project settings only (--setting-sources project,local); ${total} user hook${total === 1 ? "" : "s"} stay out` }];
  return opted.map((w) => ({
    name: `user settings — ${w.name}`,
    detail: total ? `inherits ${total} user hook${total === 1 ? "" : "s"}: ${listing}` : "inherits your user settings (no user hooks configured)",
  }));
}
