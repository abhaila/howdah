/**
 * Howdah config (T15/T19): one JSON file at $HOWDAH_HOME/config.json.
 *
 * Workspaces are the two folder kinds from the shape (A8): `repos` get worktrees and forge
 * probes; `folders` are Plain — no git anywhere near them. Everything else is settings the
 * web app edits in place (T19).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RepoWorkspace {
  path: string;
  defaultBranch?: string;
  /** run after worktree create (copy .env, install deps) */
  setupScript?: string;
}

export interface PlainWorkspace {
  path: string;
}

export interface HowdahConfig {
  repos: Record<string, RepoWorkspace>;
  folders: Record<string, PlainWorkspace>;
  /** e.g. "idea" | "code" — the Open-in-IDE command (T19) */
  editorCommand?: string;
  slackWebhook?: string;
  viewerBase?: string;
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

export function saveConfig(config: HowdahConfig, base = howdahHome()): void {
  mkdirSync(base, { recursive: true });
  writeFileSync(configPath(base), JSON.stringify(config, null, 2) + "\n");
}

export type WorkspaceRef =
  | { kind: "repo"; name: string; path: string; repo: RepoWorkspace }
  | { kind: "plain"; name: string; path: string };

/** resolve a workspace by name — repos take precedence on a name clash */
export function resolveWorkspace(config: HowdahConfig, name: string): WorkspaceRef | null {
  const repo = config.repos[name];
  if (repo) return { kind: "repo", name, path: repo.path, repo };
  const folder = config.folders[name];
  if (folder) return { kind: "plain", name, path: folder.path };
  return null;
}
