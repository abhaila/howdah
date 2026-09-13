import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { probeGit, Reconciler, readsForgeFacts, type ForgeObservation } from "./reconcile";
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
