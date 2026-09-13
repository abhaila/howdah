import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { listGithubRepos, registerGithubRepo, cloneMatches, ghExec, type Exec } from "./github";
import type { HowdahConfig } from "./config";

const REPO_LIST = JSON.stringify([
  { nameWithOwner: "abhaila/howdah", name: "howdah", defaultBranchRef: { name: "main" }, isPrivate: true, updatedAt: "2026-09-13T08:00:00Z" },
  { nameWithOwner: "abhaila/abstack", name: "abstack", defaultBranchRef: { name: "main" }, isPrivate: false, updatedAt: "2026-09-11T15:00:00Z" },
]);

/** fake gh/git: records calls; clone actually creates a real git repo so verification works */
function fakeExec(calls: string[][]): Exec {
  return (cmd) => {
    calls.push(cmd);
    const joined = cmd.join(" ");
    if (joined.startsWith("gh repo list")) return { code: 0, stdout: REPO_LIST, stderr: "" };
    if (joined.startsWith("gh repo view")) {
      const nwo = cmd[3]!;
      return { code: 0, stdout: JSON.stringify({ nameWithOwner: nwo, defaultBranchRef: { name: "main" } }), stderr: "" };
    }
    if (joined.startsWith("gh repo clone")) {
      const target = cmd[4]!;
      execSync(`git init -q -b main "${target}" && git -C "${target}" remote add origin git@github.com:${cmd[3]}.git`);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd[0] === "git") {
      const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
      return { code: r.exitCode ?? 1, stdout: new TextDecoder().decode(r.stdout), stderr: new TextDecoder().decode(r.stderr) };
    }
    return { code: 1, stdout: "", stderr: `unexpected: ${joined}` };
  };
}

function cfg(cloneRoot: string): HowdahConfig {
  return { repos: {}, folders: {}, cloneRoot };
}

describe("github workspace registration", () => {
  test("list marks existing clones and registrations; sorted by recency", () => {
    const root = mkdtempSync(join(tmpdir(), "howdah-gh-root-"));
    // a real clone of abstack already sits under the clone root
    execSync(`git init -q -b main "${join(root, "abstack")}" && git -C "${join(root, "abstack")}" remote add origin git@github.com:abhaila/abstack.git`);
    const calls: string[][] = [];
    const config = cfg(root);
    config.repos["howdah-ws"] = { path: join(root, "elsewhere") }; // registered but path mismatch — ignored

    const repos = listGithubRepos(config, { exec: fakeExec(calls) });
    expect(repos.map((r) => r.nameWithOwner)).toEqual(["abhaila/howdah", "abhaila/abstack"]);
    expect(repos[1]).toMatchObject({ localPath: join(root, "abstack"), registeredAs: null });
    expect(repos[0]!.localPath).toBeNull();
  });

  test("register reuses a matching clone without cloning", () => {
    const root = mkdtempSync(join(tmpdir(), "howdah-gh-root-"));
    const target = join(root, "abstack");
    execSync(`git init -q -b main "${target}" && git -C "${target}" remote add origin https://github.com/abhaila/abstack.git`);
    const calls: string[][] = [];
    const config = cfg(root);
    const r = registerGithubRepo(config, "abhaila/abstack", fakeExec(calls));
    expect(r).toMatchObject({ name: "abstack", path: target, cloned: false, defaultBranch: "main" });
    expect(config.repos["abstack"]).toMatchObject({ path: target });
    expect(calls.some((c) => c[2] === "clone")).toBe(false);
  });

  test("register clones when no local copy exists", () => {
    const root = mkdtempSync(join(tmpdir(), "howdah-gh-root-"));
    const calls: string[][] = [];
    const config = cfg(root);
    const r = registerGithubRepo(config, "abhaila/howdah", fakeExec(calls));
    expect(r).toMatchObject({ name: "howdah", cloned: true });
    expect(cloneMatches(r.path, "abhaila/howdah")).toBe(true);
  });

  test("refuses a directory that is NOT the picked repo (collision safety)", () => {
    const root = mkdtempSync(join(tmpdir(), "howdah-gh-root-"));
    mkdirSync(join(root, "howdah")); // same name, not a clone of it
    expect(() => registerGithubRepo(cfg(root), "abhaila/howdah", fakeExec([]))).toThrow(/not a clone of/);
  });

  test("double registration is refused; name collision falls back to owner-name", () => {
    const root = mkdtempSync(join(tmpdir(), "howdah-gh-root-"));
    const calls: string[][] = [];
    const config = cfg(root);
    registerGithubRepo(config, "abhaila/howdah", fakeExec(calls));
    expect(() => registerGithubRepo(config, "abhaila/howdah", fakeExec(calls))).toThrow(/already registered/);
  });

  test("ghExec strips GITHUB_TOKEN so the keyring login wins", () => {
    process.env.GITHUB_TOKEN = "ghp_stale_and_broken";
    const r = ghExec(["bash", "-c", "echo ${GITHUB_TOKEN:-EMPTY}"]);
    expect(r.stdout.trim()).toBe("EMPTY");
    delete process.env.GITHUB_TOKEN;
  });
});
