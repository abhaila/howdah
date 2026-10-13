/**
 * Howdah config (T15/T19): one JSON file at $HOWDAH_HOME/config.json.
 *
 * Workspaces are the two folder kinds from the shape (A8): `repos` get worktrees and forge
 * probes; `folders` are Plain — no git anywhere near them. Everything else is settings the
 * web app edits in place (T19).
 */
import type { PreviewContract } from "../core/evidence";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface RepoWorkspace {
  path: string;
  defaultBranch?: string;
  /** run after worktree create (copy .env, install deps) */
  setupScript?: string;
  /**
   * HOW-12: the command `verify:run` runs in a run's worktree before the local review (e.g.
   * "bun test", "./gradlew test") — exit 0 is a pass. Unset, the verdict is `not-checked`,
   * never a pass. HOW-15's environment contract is the wider home for this and may subsume it.
   */
  verifyCommand?: string;
  /**
   * HOW-39: a FAST, read-only check (seconds — `bunx tsc --noEmit -p . --incremental`, a
   * one-file lint) run after every Edit/Write/MultiEdit of a claude node that opts in
   * (`diagnostics: true`), its output handed to the agent inside its turn. Part of "how to run
   * this workspace" (HOW-15's environment contract).
   */
  diagnosticsCommand?: string;
  /**
   * HOW-52: how to start this repo's app so `evidence:screenshot` can capture it — the command
   * (run in the worktree on a free port, with a temp HOWDAH_HOME) and the paths to capture.
   * Part of HOW-15's environment contract, like verifyCommand. Unset: `not-checked`.
   */
  preview?: PreviewContract;
  /** HOW-55: agents in this workspace load the operator's USER-level settings too (default: project only) */
  inheritUserSettings?: true;
}

export interface PlainWorkspace {
  path: string;
  /** HOW-55: as on a repo workspace */
  inheritUserSettings?: true;
}

export interface HowdahConfig {
  repos: Record<string, RepoWorkspace>;
  folders: Record<string, PlainWorkspace>;
  /** e.g. "idea" | "code" — the Open-in-IDE command (T19) */
  editorCommand?: string;
  /** HOW-48: ms before the run header offers to escalate an unanswered soft stop (default 2 min) */
  softStopEscalateMs?: number;
  /** where GitHub-picked repos are cloned; default ~/code */
  cloneRoot?: string;
  /**
   * HOW-17: the harness a node with no declared one runs on ("claude" unless set), and the
   * order an exhausted harness hands off along (claude → codex → cursor unless set).
   * HOWDAH_HARNESS overrides `defaultHarness` for one run. Names are validated where they
   * are used (core/harnesses.ts) — a typo here is ignored, never fatal.
   */
  defaultHarness?: string;
  fallbackChain?: string[];
  slackWebhook?: string;
  /**
   * TypeSafe (Jev) API key for the System One decision calls — see
   * docs/notes/2026-09-26-typesafe-jev-research.md. `TYPESAFE_API_KEY` in the environment
   * beats it, the same way HOWDAH_HARNESS beats `defaultHarness`: the env var is how one
   * shell or one run uses a different key without editing the file every operator's viewer
   * writes to. Absent from both is not an error anywhere — every call site falls back to the
   * behaviour it had before Jev existed (decision 2A).
   */
  typesafeApiKey?: string;
  viewerBase?: string;
  /**
   * HOW-38: stuck detection's streak lengths — warn (and remind claude) at `warn` identical
   * calls, stop and park `stuck` at `stop` identical FAILING calls. Default 5 / 8, the
   * harness-design study's values. Read through stuckThresholds(), which ignores nonsense.
   */
  stuck?: { warn?: number; stop?: number };
  theme?: "system" | "dark" | "light";
  chime?: boolean;
}

const DEFAULTS: HowdahConfig = { repos: {}, folders: {} };

export function howdahHome(): string {
  return process.env.HOWDAH_HOME ?? join(homedir(), ".howdah");
}

export function configPath(base = howdahHome()): string {
  return join(base, "config.json");
}

export function loadConfig(base = howdahHome()): HowdahConfig {
  const p = configPath(base);
  if (!existsSync(p)) return structuredClone(DEFAULTS);
  return { ...structuredClone(DEFAULTS), ...(JSON.parse(readFileSync(p, "utf8")) as HowdahConfig) };
}

/**
 * HOW-38: config.json `stuck`, cleaned — a missing, non-integer or non-positive value falls
 * back to its default, and `stop` is never below `warn` (a stop before the warning would park
 * a run nobody was told was spinning).
 */
export function stuckThresholds(config: HowdahConfig): { warn: number; stop: number } {
  const ok = (v: unknown, d: number) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : d);
  const warn = ok(config.stuck?.warn, 5);
  return { warn, stop: Math.max(warn, ok(config.stuck?.stop, 8)) };
}

export function saveConfig(config: HowdahConfig, base = howdahHome()): void {
  mkdirSync(base, { recursive: true });
  writeFileSync(configPath(base), JSON.stringify(config, null, 2) + "\n");
}

export function ensureHowdahHome(base = howdahHome()): HowdahConfig {
  mkdirSync(base, { recursive: true });
  mkdirSync(join(base, "runs"), { recursive: true });
  mkdirSync(join(base, "repos"), { recursive: true });
  mkdirSync(join(base, "attention"), { recursive: true });
  if (!existsSync(configPath(base))) saveConfig(structuredClone(DEFAULTS), base);
  return loadConfig(base);
}

export type WorkspaceRef =
  | { kind: "repo"; name: string; path: string; repo: RepoWorkspace }
  | { kind: "plain"; name: string; path: string };

/**
 * The name a repo's worktrees live under: `$HOWDAH_HOME/repos/<name>/worktrees/<run>`.
 *
 * The registered workspace name wins because it is unique by construction — two clones of
 * different `api` repos would otherwise share one folder. An unregistered path (a run
 * launched with --dir) falls back to the directory name.
 */
export function repoNameFor(config: HowdahConfig, repoPath: string): string {
  const registered = Object.entries(config.repos).find(([, r]) => r.path === repoPath);
  return registered ? registered[0] : basename(repoPath);
}

/**
 * HOW-12: the verify command registered for a repo path, or undefined. Matched by path, as
 * `repoNameFor` is — the run knows its repo by path (worktree.json `repo`), not by name. A
 * blank command counts as unset: a half-filled setting must read as "not configured", never as
 * a script `bash -c` runs as a no-op and reports as a pass.
 */
export function verifyCommandFor(config: HowdahConfig, repoPath: string): string | undefined {
  const cmd = Object.values(config.repos).find((r) => r.path === repoPath)?.verifyCommand?.trim();
  return cmd ? cmd : undefined;
}

/** HOW-57: the registered default branch for a repo path (blank = unset) — what a worktree starts from */
export function defaultBranchFor(config: HowdahConfig, repoPath: string): string | undefined {
  const b = Object.values(config.repos).find((r) => r.path === repoPath)?.defaultBranch?.trim();
  return b ? b : undefined;
}

/**
 * HOW-55: does the workspace at this path load the operator's user-level settings? Matched by
 * path like verifyCommandFor, over repos AND plain folders. Default no: an agent is configured by
 * the project alone, so its hooks, plugins and CLAUDE.md are the repository's, not the operator's.
 */
export function inheritsUserSettings(config: HowdahConfig, path: string): boolean {
  return [...Object.values(config.repos), ...Object.values(config.folders)].some((w) => w.path === path && w.inheritUserSettings === true);
}

/** HOW-55: opt a workspace in to (or out of) the operator's user-level settings */
export function setInheritUserSettings(config: HowdahConfig, name: string, on: boolean): void {
  const w = config.repos[name] ?? config.folders[name];
  if (!w) throw new Error(`unknown workspace "${name}"`);
  if (on) w.inheritUserSettings = true;
  else delete w.inheritUserSettings;
}

/** HOW-52: the preview contract registered for a repo path, or undefined (matched like verifyCommandFor) */
export function previewFor(config: HowdahConfig, repoPath: string): PreviewContract | undefined {
  const p = Object.values(config.repos).find((r) => r.path === repoPath)?.preview;
  return p?.command?.trim() && p.paths?.length ? p : undefined;
}

/**
 * HOW-52: set an existing repo workspace's preview, or clear it with a blank command. Paths are
 * normalised to start with "/" and empty ones dropped; a command with no path is refused, since
 * it could never capture anything.
 */
export function setPreview(config: HowdahConfig, name: string, command: string | undefined, paths: string[]): void {
  const repo = config.repos[name];
  if (!repo) {
    if (config.folders[name]) throw new Error(`"${name}" is a Plain folder — evidence:screenshot only runs from a repo's worktree`);
    throw new Error(`unknown repo workspace "${name}"`);
  }
  const cmd = command?.trim();
  if (!cmd) { delete repo.preview; return; }
  const clean = paths.map((p) => p.trim()).filter(Boolean).map((p) => (p.startsWith("/") ? p : `/${p}`));
  if (!clean.length) throw new Error('a preview needs at least one path to capture, e.g. --paths "/"');
  repo.preview = { command: cmd, paths: clean };
}

/**
 * HOW-12: set an existing REPO workspace's verify command, or clear it with a blank one.
 * Throws in words for an unknown name or a Plain folder (which has no worktree to run in).
 */
export function setVerifyCommand(config: HowdahConfig, name: string, command: string | undefined): void {
  const repo = config.repos[name];
  if (!repo) {
    if (config.folders[name]) throw new Error(`"${name}" is a Plain folder — verify:run only runs in a repo's worktree`);
    throw new Error(`unknown repo workspace "${name}"`);
  }
  const cmd = command?.trim();
  if (cmd) repo.verifyCommand = cmd;
  else delete repo.verifyCommand;
}

/** HOW-39: the diagnostics command registered for a repo path, or undefined (blank = unset) */
export function diagnosticsCommandFor(config: HowdahConfig, repoPath: string): string | undefined {
  const cmd = Object.values(config.repos).find((r) => r.path === repoPath)?.diagnosticsCommand?.trim();
  return cmd ? cmd : undefined;
}

/** HOW-39: set (or clear, with a blank one) an existing REPO workspace's diagnostics command */
export function setDiagnosticsCommand(config: HowdahConfig, name: string, command: string | undefined): void {
  const repo = config.repos[name];
  if (!repo) {
    if (config.folders[name]) throw new Error(`"${name}" is a Plain folder — diagnostics only run in a repo's worktree`);
    throw new Error(`unknown repo workspace "${name}"`);
  }
  const cmd = command?.trim();
  if (cmd) repo.diagnosticsCommand = cmd;
  else delete repo.diagnosticsCommand;
}

/**
 * HOW-39: what doctor says about a diagnostics command — the binary its first word names must
 * resolve on PATH (or be a path that exists), or every opted-in edit runs a hook that fails.
 */
export function diagnosticsCommandProblem(command: string, which: (bin: string) => string | null, exists: (p: string) => boolean): string | null {
  const first = command.trim().split(/\s+/)[0] ?? "";
  if (!first) return "the command is blank";
  if (first.includes("/")) return exists(first) ? null : `${first} does not exist`;
  return which(first) ? null : `${first} is not on PATH`;
}

/**
 * HOW-23: the REGISTERED name for a path, or null when nothing is registered at it.
 *
 * The strict half of `repoNameFor`, and strict for a reason: `runs:launch` uses it to inherit
 * the parent run's workspace for a slice that named none, and a child must be launched with
 * `--workspace` (a `--dir` run is Plain, so `implement-ticket`'s create_worktree would throw).
 * A basename guess would be a name `resolveWorkspace` then cannot find — so an unregistered
 * path answers null and the launcher refuses in words, before anything is spawned.
 */
export function workspaceNameFor(config: HowdahConfig, path: string): string | null {
  const repo = Object.entries(config.repos).find(([, r]) => r.path === path);
  if (repo) return repo[0];
  const folder = Object.entries(config.folders).find(([, f]) => f.path === path);
  return folder ? folder[0] : null;
}

/** resolve a workspace by name — repos take precedence on a name clash */
export function resolveWorkspace(config: HowdahConfig, name: string): WorkspaceRef | null {
  const repo = config.repos[name];
  if (repo) return { kind: "repo", name, path: repo.path, repo };
  const folder = config.folders[name];
  if (folder) return { kind: "plain", name, path: folder.path };
  return null;
}

/**
 * The TypeSafe key in force, or undefined. Env first (see `typesafeApiKey` above); an
 * all-whitespace value in either place counts as unset, because a half-filled settings box
 * must read as "no key" rather than as a key the API will 401 on.
 */
export function resolveTypesafeApiKey(config: HowdahConfig = loadConfig()): string | undefined {
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const fromConfig = config.typesafeApiKey?.trim();
  return fromConfig ? fromConfig : undefined;
}

/** Where the key in force came from — what the settings screen reports, never the key itself. */
export function typesafeKeyState(config: HowdahConfig = loadConfig()): "env" | "saved" | "unset" {
  if (process.env.TYPESAFE_API_KEY?.trim()) return "env";
  return config.typesafeApiKey?.trim() ? "saved" : "unset";
}
