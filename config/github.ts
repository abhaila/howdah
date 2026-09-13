/**
 * GitHub-backed workspace registration: repos are PICKED from `gh repo list`, never typed.
 * A picked repo resolves to a local clone — an existing checkout under cloneRoot is reused
 * (verified by its origin remote, so a name collision never silently binds the wrong
 * repo), otherwise `gh repo clone` fetches it. Registration then goes through the same
 * config.repos as manual paths.
 *
 * Auth note: gh's keyring login is the source of truth. A GITHUB_TOKEN env var (often a
 * stale CI leftover) OVERRIDES the keyring inside gh, so it is stripped from every spawn.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HowdahConfig } from "./config";

export interface GhRepo {
  nameWithOwner: string;
  name: string;
  defaultBranch: string;
  isPrivate: boolean;
  updatedAt: string;
  /** existing local clone under cloneRoot, when its origin matches */
  localPath: string | null;
  /** already registered as a workspace under this name */
  registeredAs: string | null;
}

export type Exec = (cmd: string[]) => { code: number; stdout: string; stderr: string };

export const ghExec: Exec = (cmd) => {
  const env = { ...process.env };
  delete env.GITHUB_TOKEN; // stale env tokens override the keyring inside gh — never trust them
  delete env.GH_TOKEN;
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", env });
  return { code: r.exitCode ?? 1, stdout: new TextDecoder().decode(r.stdout), stderr: new TextDecoder().decode(r.stderr) };
};

export function defaultCloneRoot(config: HowdahConfig): string {
  return config.cloneRoot ?? join(homedir(), "code");
}

/** does dir exist AND point at this repo? (origin must match — name collisions never bind silently) */
export function cloneMatches(dir: string, nameWithOwner: string, exec: Exec = ghExec): boolean {
  if (!existsSync(dir)) return false;
  const r = exec(["git", "-C", dir, "remote", "get-url", "origin"]);
  return r.code === 0 && r.stdout.toLowerCase().includes(nameWithOwner.toLowerCase());
}

function registeredName(config: HowdahConfig, nameWithOwner: string, localPath: string | null, exec: Exec): string | null {
  for (const [name, repo] of Object.entries(config.repos)) {
    if (localPath && repo.path === localPath) return name;
    if (cloneMatches(repo.path, nameWithOwner, exec)) return name;
  }
  return null;
}

export function listGithubRepos(config: HowdahConfig, opts: { query?: string; exec?: Exec } = {}): GhRepo[] {
  const exec = opts.exec ?? ghExec;
  const fields = "nameWithOwner,name,defaultBranchRef,isPrivate,updatedAt";
  const query = opts.query?.trim();
  const cmd = query?.includes("/")
    ? ["gh", "repo", "view", query, "--json", fields] // exact owner/name lookup (any accessible repo)
    : ["gh", "repo", "list", "--json", fields, "--limit", "100"];
  const r = exec(cmd);
  if (r.code !== 0) throw new Error(`gh failed: ${r.stderr.trim().slice(0, 200) || "is gh logged in? run: gh auth login"}`);
  const parsed = JSON.parse(r.stdout) as any;
  const rows: any[] = Array.isArray(parsed) ? parsed : [parsed];
  const root = defaultCloneRoot(config);
  return rows
    .map((x): GhRepo => {
      const candidate = join(root, x.name);
      const localPath = cloneMatches(candidate, x.nameWithOwner, exec) ? candidate : null;
      return {
        nameWithOwner: x.nameWithOwner,
        name: x.name,
        defaultBranch: x.defaultBranchRef?.name ?? "main",
        isPrivate: Boolean(x.isPrivate),
        updatedAt: x.updatedAt ?? "",
        localPath,
        registeredAs: registeredName(config, x.nameWithOwner, localPath, exec),
      };
    })
    .filter((x) => !query || query.includes("/") || x.nameWithOwner.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Register a picked repo: reuse a matching local clone or clone fresh under cloneRoot.
 * Returns what config.repos now holds.
 */
export function registerGithubRepo(
  config: HowdahConfig,
  nameWithOwner: string,
  exec: Exec = ghExec,
): { name: string; path: string; defaultBranch: string; cloned: boolean } {
  const [owner, short] = nameWithOwner.split("/");
  if (!owner || !short) throw new Error(`expected owner/name, got "${nameWithOwner}"`);

  const existing = registeredName(config, nameWithOwner, null, exec);
  if (existing) throw new Error(`already registered as workspace "${existing}"`);

  const view = exec(["gh", "repo", "view", nameWithOwner, "--json", "defaultBranchRef,nameWithOwner"]);
  if (view.code !== 0) throw new Error(`gh cannot see ${nameWithOwner}: ${view.stderr.trim().slice(0, 200)}`);
  const defaultBranch = (JSON.parse(view.stdout).defaultBranchRef?.name as string) ?? "main";

  const root = defaultCloneRoot(config);
  const target = join(root, short);
  let cloned = false;
  if (!cloneMatches(target, nameWithOwner, exec)) {
    if (existsSync(target))
      throw new Error(`${target} exists but is not a clone of ${nameWithOwner} — move it or set a different cloneRoot`);
    mkdirSync(root, { recursive: true });
    const clone = exec(["gh", "repo", "clone", nameWithOwner, target]);
    if (clone.code !== 0) throw new Error(`clone failed: ${clone.stderr.trim().slice(0, 300)}`);
    cloned = true;
  }

  // short name unless taken; then owner-name
  const wsName = config.repos[short] || config.folders[short] ? `${owner}-${short}` : short;
  config.repos[wsName] = { path: target, defaultBranch };
  return { name: wsName, path: target, defaultBranch, cloned };
}
