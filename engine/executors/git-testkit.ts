/**
 * Real-git fixtures for HOW-57's tests (decision 8A): a local BARE repository standing in for
 * `origin`, and a clone of it standing in for the operator's checkout. Every stacked-slice
 * operation — fetch, branch from a base, rebase --onto, push --force-with-lease — is proven
 * against these before it touches a real stack. Test-only; imported by *.test.ts files.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).toString().trim();
}

/** write `file` in `cwd`, commit it, and return the new sha */
export function commit(cwd: string, file: string, content: string, message = `edit ${file}`): string {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function configure(dir: string): void {
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
}

/** a repo with one commit on `main` and NO remote */
export function lonelyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "howdah-git-lonely-"));
  git(dir, "init", "-q", "-b", "main");
  configure(dir);
  commit(dir, "README.md", "hello\n", "init");
  return dir;
}

export interface OriginFixture {
  /** the bare repository — `origin` */
  origin: string;
  /** the operator's clone, on main, tracking origin */
  clone: string;
  /** a second clone — a teammate (or GitHub) pushing behind the operator's back */
  other: string;
}

/** a bare origin with one commit on main, the operator's clone of it, and a teammate's */
export function originFixture(): OriginFixture {
  const root = mkdtempSync(join(tmpdir(), "howdah-git-origin-"));
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const seed = join(root, "seed");
  git(root, "clone", "-q", origin, seed);
  configure(seed);
  git(seed, "checkout", "-q", "-b", "main");
  commit(seed, "README.md", "hello\n", "init");
  git(seed, "push", "-q", "origin", "main");
  const clone = join(root, "clone");
  git(root, "clone", "-q", origin, clone);
  configure(clone);
  const other = join(root, "other");
  git(root, "clone", "-q", origin, other);
  configure(other);
  return { origin, clone, other };
}

/** the sha a ref points at in `cwd` */
export const sha = (cwd: string, ref: string): string => git(cwd, "rev-parse", ref);
