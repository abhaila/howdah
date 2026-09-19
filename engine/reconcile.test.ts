import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { describeFingerprintChange, fingerprint, FingerprintError, isFingerprint, probeGit, Reconciler, readsForgeFacts, type ForgeObservation } from "./reconcile";
import type { NodeDef } from "../core/graph";

function realRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "howdah-git-"));
  const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir, stdio: "pipe" });
  git("init -q -b howdah/work-1");
  git("config user.email t@t && git config user.name t");
  writeFileSync(join(dir, "a.txt"), "hello\n");
  git("add a.txt && git commit -q -m init");
  return dir;
}

const forgeReader: NodeDef<any> = { kind: "command", run: "probe:pr", reads: ["pr.state"] as any };
const plainNode: NodeDef<any> = { kind: "agent", prompt: "discover", reads: ["goal"] as any };

describe("probeGit against a real repo", () => {
  test("reports branch, head, dirty count; unpushed null without upstream", () => {
    const dir = realRepo();
    const g = probeGit(dir);
    expect(g).toMatchObject({ repo: true, branch: "howdah/work-1", unpushed: null, uncommitted: 0 });
    expect(g.head).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(dir, "b.txt"), "dirty\n");
    expect(probeGit(dir).uncommitted).toBe(1);
  });

  test("a non-repo directory is observed as such, not an error", () => {
    const g = probeGit(mkdtempSync(join(tmpdir(), "howdah-norepo-")));
    expect(g).toEqual({ repo: false, branch: null, head: null, uncommitted: 0, unpushed: null });
  });
});

describe("intended vs observed (OV-5)", () => {
  test("branch renamed mid-run: disagreement surfaced, not auto-resolved", async () => {
    const dir = realRepo();
    const rec = new Reconciler(dir);
    rec.claim({ branch: "howdah/work-1" });

    expect((await rec.reconcile(plainNode)).disagreements).toEqual([]);

    // the agent (or a human) renames the branch mid-run — Orbital's R4 failure mode
    execSync("git branch -m howdah/work-1 feature/renamed-by-agent", { cwd: dir });
    const r = await rec.reconcile(plainNode);
    expect(r.git.branch).toBe("feature/renamed-by-agent");
    expect(r.disagreements).toEqual([
      'intended branch "howdah/work-1" but observed "feature/renamed-by-agent"',
    ]);
    // and the claim is untouched — reconcile never rewrites intent
    expect(rec.claimed.branch).toBe("howdah/work-1");
  });
});

describe("forge probing (D9)", () => {
  test("forge facts gate the probe: plain nodes never hit the forge", async () => {
    const dir = realRepo();
    let forgeCalls = 0;
    const rec = new Reconciler(dir, {
      forge: async () => (forgeCalls++, { kind: "no-pr" }),
    });
    await rec.reconcile(plainNode);
    expect(forgeCalls).toBe(0);
    expect((await rec.reconcile(plainNode)).forge).toBeNull();
    await rec.reconcile(forgeReader);
    expect(forgeCalls).toBe(1);
    expect(readsForgeFacts(forgeReader)).toBe(true);
    expect(readsForgeFacts(plainNode)).toBe(false);
  });

  test("forge outage is NOT read as no-PR: unreachable raises no disagreement", async () => {
    const dir = realRepo();
    const rec = new Reconciler(dir, {
      forge: async () => ({ kind: "unreachable", error: "api.github.com: connect timeout" }),
    });
    rec.claim({ branch: "howdah/work-1", prUrl: "https://github.com/x/y/pull/1" });
    const r = await rec.reconcile(forgeReader);
    expect(r.forge).toEqual({ kind: "unreachable", error: "api.github.com: connect timeout" });
    // absence of evidence, not evidence of absence — the intended PR is not contradicted
    expect(r.disagreements).toEqual([]);
  });

  test("a real no-PR observation against an intended PR IS a disagreement", async () => {
    const dir = realRepo();
    const rec = new Reconciler(dir, { forge: async () => ({ kind: "no-pr" }) });
    rec.claim({ branch: "howdah/work-1", prUrl: "https://github.com/x/y/pull/1" });
    const r = await rec.reconcile(forgeReader);
    expect(r.disagreements).toHaveLength(1);
    expect(r.disagreements[0]).toContain("no PR");
  });

  test("observed PR differing from intended PR is a disagreement", async () => {
    const dir = realRepo();
    const observed: ForgeObservation = { kind: "pr", state: "OPEN", url: "https://github.com/x/y/pull/99" };
    const rec = new Reconciler(dir, { forge: async () => observed });
    rec.claim({ prUrl: "https://github.com/x/y/pull/1" });
    const r = await rec.reconcile(forgeReader);
    expect(r.disagreements).toEqual([
      "intended PR https://github.com/x/y/pull/1 but observed https://github.com/x/y/pull/99",
    ]);
  });

  test("matching reality raises nothing", async () => {
    const dir = realRepo();
    const rec = new Reconciler(dir, {
      forge: async () => ({ kind: "pr", state: "OPEN", url: "https://github.com/x/y/pull/1" }),
    });
    rec.claim({ branch: "howdah/work-1", prUrl: "https://github.com/x/y/pull/1" });
    const r = await rec.reconcile(forgeReader);
    expect(r.disagreements).toEqual([]);
    expect(r.forge).toMatchObject({ kind: "pr", state: "OPEN" });
  });
});

describe("fingerprint (system-map 1a, D18)", () => {
  const sh = (dir: string, cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" });

  test("a clean repo is stable; a non-repo or missing cwd has no fingerprint", async () => {
    const dir = realRepo();
    const fp = (await fingerprint(dir))!;
    expect(fp.head).toMatch(/^[0-9a-f]{40}$/);
    expect(await fingerprint(dir)).toEqual(fp);
    expect(await fingerprint(mkdtempSync(join(tmpdir(), "howdah-norepo-")))).toBeNull();
    expect(await fingerprint(undefined)).toBeNull();
    expect(describeFingerprintChange(null, null)).toBeNull();
  });

  test("a DIRTY tree that does not change is not stale — only a change is", async () => {
    const dir = realRepo();
    writeFileSync(join(dir, "a.txt"), "edited\n");
    writeFileSync(join(dir, "new.txt"), "untracked\n");
    const dirty = await fingerprint(dir);
    expect(describeFingerprintChange(dirty, await fingerprint(dir))).toBeNull();
  });

  test("a tracked edit moves only the tracked part", async () => {
    const dir = realRepo();
    const before = (await fingerprint(dir))!;
    writeFileSync(join(dir, "a.txt"), "edited\n");
    const after = (await fingerprint(dir))!;
    expect(after.head).toBe(before.head);
    expect(after.untracked).toBe(before.untracked);
    expect(describeFingerprintChange(before, after)).toBe("tracked changes differ");
  });

  test("a staged change counts, and so do editing after staging and RE-staging different content", async () => {
    const dir = realRepo();
    const before = await fingerprint(dir);
    writeFileSync(join(dir, "a.txt"), "staged\n");
    sh(dir, "git add a.txt");
    const staged = await fingerprint(dir);
    expect(describeFingerprintChange(before, staged)).toBe("tracked changes differ");
    writeFileSync(join(dir, "a.txt"), "staged then edited\n");
    const edited = await fingerprint(dir);
    expect(describeFingerprintChange(staged, edited)).toBe("tracked changes differ");
    // same worktree bytes, different index: the staged blob id is in the status record
    sh(dir, "git add a.txt");
    expect(describeFingerprintChange(edited, await fingerprint(dir))).toBe("tracked changes differ");
  });

  test("an untracked file's CONTENT counts, not just its name", async () => {
    const dir = realRepo();
    writeFileSync(join(dir, "notes.txt"), "v1\n");
    const v1 = (await fingerprint(dir))!;
    writeFileSync(join(dir, "notes.txt"), "v2\n"); // same name, same status line
    const v2 = (await fingerprint(dir))!;
    expect(v2.tracked).toBe(v1.tracked);
    expect(describeFingerprintChange(v1, v2)).toBe("untracked files differ");
  });

  test("an ignored file never counts", async () => {
    const dir = realRepo();
    writeFileSync(join(dir, ".gitignore"), "build/\n");
    sh(dir, "git add .gitignore && git commit -q -m ignore");
    const before = await fingerprint(dir);
    sh(dir, "mkdir -p build && echo junk > build/out.bin");
    expect(describeFingerprintChange(before, await fingerprint(dir))).toBeNull();
  });

  test("a HEAD move is named with both commits", async () => {
    const dir = realRepo();
    const before = (await fingerprint(dir))!;
    sh(dir, "git commit -q --allow-empty -m next");
    const after = (await fingerprint(dir))!;
    const change = describeFingerprintChange(before, after)!;
    expect(change).toStartWith("HEAD moved (");
    expect(change).toContain(`${before.head!.slice(0, 7)} → ${after.head!.slice(0, 7)}`);
  });

  test("a delete, a rename and a binary edit each count", async () => {
    const dir = realRepo();
    writeFileSync(join(dir, "b.bin"), Buffer.from([0, 1, 2, 3, 255]));
    sh(dir, "git add b.bin && git commit -q -m bin");
    let prev = await fingerprint(dir);
    const step = async (label: string, act: () => void, want: string) => {
      act();
      const next = await fingerprint(dir);
      expect([label, describeFingerprintChange(prev, next)]).toEqual([label, want]);
      prev = next;
    };
    await step("binary edit", () => writeFileSync(join(dir, "b.bin"), Buffer.from([0, 1, 2, 4, 255])), "tracked changes differ");
    await step("delete", () => sh(dir, "rm a.txt"), "tracked changes differ");
    await step("staged rename", () => sh(dir, "git checkout -q -- a.txt && git mv a.txt renamed.txt"), "tracked changes differ");
  });

  test("an upstream/ahead-behind change is not a tree change (status headers are ignored)", async () => {
    const dir = realRepo();
    const remote = mkdtempSync(join(tmpdir(), "howdah-remote-"));
    sh(remote, "git init -q --bare");
    sh(dir, `git remote add origin ${remote} && git push -q -u origin howdah/work-1`);
    const before = await fingerprint(dir);
    sh(dir, "git commit -q --allow-empty -m local && git reset -q --soft HEAD~1"); // net: nothing, but upstream refs unchanged
    sh(dir, "git fetch -q origin");
    expect(describeFingerprintChange(before, await fingerprint(dir))).toBeNull();
  });

  test("REGRESSION: a change past a >2MB diff is still seen (no buffer truncation)", async () => {
    const dir = realRepo();
    const line = "x".repeat(99) + "\n";
    writeFileSync(join(dir, "big.txt"), line.repeat(30_000)); // ~3MB
    sh(dir, "git add big.txt && git commit -q -m big");
    writeFileSync(join(dir, "big.txt"), "y".repeat(99).concat("\n").repeat(30_000)); // a ~6MB diff
    writeFileSync(join(dir, "z_small.txt"), "v1\n");
    sh(dir, "git add z_small.txt");
    writeFileSync(join(dir, "z_small.txt"), "v1 dirty\n");
    const before = await fingerprint(dir);
    writeFileSync(join(dir, "z_small.txt"), "v2 -- teammate changed it after approval\n");
    expect(describeFingerprintChange(before, await fingerprint(dir))).toBe("tracked changes differ");
  }, 30_000);

  test("REGRESSION: thousands of untracked files (>2MB of paths) are all listed and hashed", async () => {
    const dir = realRepo();
    const deep = join(dir, "d".repeat(200), "e".repeat(200));
    mkdirSync(deep, { recursive: true });
    for (let i = 0; i < 4500; i++) writeFileSync(join(deep, `${String(i).padStart(5, "0")}-${"f".repeat(80)}.txt`), `${i}\n`);
    const before = await fingerprint(dir);
    writeFileSync(join(deep, `04499-${"f".repeat(80)}.txt`), "changed\n"); // the LAST path
    expect(describeFingerprintChange(before, await fingerprint(dir))).toBe("untracked files differ");
  }, 60_000);

  test("a git failure THROWS — never an unknown value that could compare equal", async () => {
    const dir = realRepo();
    writeFileSync(join(dir, ".git", "index"), "not an index");
    await expect(fingerprint(dir)).rejects.toThrow(FingerprintError);
    await expect(fingerprint(dir)).rejects.toThrow(/git status failed/);
  });

  test("every moved part is listed; a repo appearing or vanishing is named", async () => {
    const dir = realRepo();
    const before = (await fingerprint(dir))!;
    writeFileSync(join(dir, "a.txt"), "edited\n");
    writeFileSync(join(dir, "u.txt"), "u\n");
    sh(dir, "git commit -q --allow-empty -m next");
    expect(describeFingerprintChange(before, await fingerprint(dir))).toMatch(/^HEAD moved .*; tracked changes differ; untracked files differ$/);
    expect(describeFingerprintChange(before, null)).toBe("the folder is no longer a git work tree");
    expect(describeFingerprintChange(null, before)).toBe("the folder became a git work tree");
  });

  test("isFingerprint accepts the shape and null, rejects anything else", async () => {
    expect(isFingerprint(await fingerprint(realRepo()))).toBe(true);
    expect(isFingerprint(null)).toBe(true);
    expect(isFingerprint({ head: "x", tracked: "t" })).toBe(false);
    expect(isFingerprint("abc")).toBe(false);
  });
});
