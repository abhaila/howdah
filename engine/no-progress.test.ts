/**
 * HOW-54 — a build → review → repair cycle that changes nothing parks, instead of spending
 * another visit judging the same code. Stub executors over a REAL temp git repo: the tree the
 * engine records is the one git computes, so "changed nothing" means what it says.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type AttemptResult } from "./run";
import { defineGraph } from "../core/graph";
import { readLog } from "../log/write";
import { worktreeTree } from "./reconcile";
import { madeNoProgress } from "./no-progress";

type C = { goal: string; summary: string; review_verdict: string; review_findings: unknown };
const ok = (writes: Record<string, unknown> = {}): AttemptResult => ({ status: "succeeded", writes });
const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "howdah-np-repo-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** implement → review ⇄ repair; the reviewer is read-only; `repair(visit, cwd)` does the work */
function setup(repair: (visit: number, cwd: string) => void, verdicts: string[], maxRepairs = 5) {
  const dir = mkdtempSync(join(tmpdir(), "howdah-np-"));
  const prompts = mkdtempSync(join(tmpdir(), "howdah-np-p-"));
  for (const id of ["doc.draft", "doc.review"]) writeFileSync(join(prompts, `${id}.md`), `---\nid: ${id}\nversion: 1\n---\nDo {{ context.goal }}.\n`);
  const cwd = repo();
  const graph = defineGraph<C>({
    name: "loop", entry: "implement", inputs: ["goal"],
    nodes: {
      implement: { kind: "agent", prompt: "doc.draft", reads: ["goal"], writes: { summary: { scope: "sticky" } } },
      review: { kind: "agent", prompt: "doc.review", reads: ["goal", "summary"], writes: { review_verdict: { scope: "cleared" }, review_findings: { scope: "cleared" } }, readOnly: true },
      repair: { kind: "agent", prompt: "doc.draft", reads: ["goal", "review_findings"], writes: { summary: { scope: "sticky" } }, maxVisits: maxRepairs },
      done: { kind: "terminal", outcome: "success" },
    },
    edges: [
      { from: "implement", to: "review" },
      { from: "review", to: "repair", condition: { reads: ["review_verdict"], test: (v) => v.review_verdict === "reject", label: "reject" }, weight: 2 },
      { from: "review", to: "done", condition: { reads: ["review_verdict"], test: (v) => v.review_verdict === "pass", label: "pass" }, weight: 1 },
      { from: "repair", to: "review" },
    ],
  });
  let reviews = 0;
  const prompts_: Map<string, string> = new Map();
  const engine = () => new Engine(graph, {
    dir, promptsDir: prompts, cwd, folderKind: "repo",
    executors: {
      agent: async ({ nodeId, visit, renderedPrompt }) => {
        prompts_.set(`${nodeId}@${visit}`, renderedPrompt ?? "");
        if (nodeId === "implement") { writeFileSync(join(cwd, "feature.ts"), "export const f = 1;\n"); return ok({ summary: "built" }); }
        if (nodeId === "review") {
          const v = verdicts[Math.min(reviews++, verdicts.length - 1)]!;
          return ok({ review_verdict: v, review_findings: v === "reject" ? ["feature.ts must export g as well"] : [] });
        }
        repair(visit, cwd);
        return ok({ summary: `repair ${visit}` });
      },
    },
  });
  return { engine, dir, cwd, graph, sent: prompts_, path: join(dir, "run.jsonl") };
}

const visits = (path: string, node: string) => readLog(path).filter((e) => e.type === "node-started" && e.node === node).map((e) => (e as { visit: number }).visit);

describe("a repair that changes nothing", () => {
  test("the reviewer rejects twice, the second repair changes nothing → park no-progress, findings quoted", async () => {
    const { engine, path } = setup((visit, cwd) => { if (visit === 1) writeFileSync(join(cwd, "feature.ts"), "export const f = 2;\n"); }, ["reject", "reject", "reject"]);
    const res = await engine().start({ goal: "g" });
    expect(res).toMatchObject({ state: "parked", node: "repair", code: "no-progress" });
    const reason = (res as { reason: string }).reason;
    expect(reason).toContain("repair@2 changed nothing in the worktree since visit 1");
    expect(reason).toContain('["feature.ts must export g as well"]');
    expect(visits(path, "repair")).toEqual([1, 2]); // no third repair, no third review
    expect(visits(path, "review")).toEqual([1, 2]);
    // the reviewer is read-only and the builder is off the cycle: neither records a tree
    const trees = readLog(path).filter((e) => e.type === "node-finished" && e.tree !== undefined).map((e) => (e as { node: string }).node);
    expect(trees).toEqual(["repair", "repair"]);
  });

  test("a repair that DOES change files keeps looping as today, until maxVisits", async () => {
    const { engine, path } = setup((visit, cwd) => writeFileSync(join(cwd, "feature.ts"), `export const f = ${visit};\n`), ["reject"], 3);
    const res = await engine().start({ goal: "g" });
    expect(res).toMatchObject({ state: "parked", node: "repair", code: "max-visits" });
    expect(visits(path, "repair")).toEqual([1, 2, 3]);
  });

  test("a repair that only COMMITS work already on disk changed nothing — the tree, not HEAD, is compared", async () => {
    const { engine } = setup((visit, cwd) => {
      if (visit === 1) writeFileSync(join(cwd, "feature.ts"), "export const g = 1;\n"); // real change, left uncommitted
      else { git(cwd, "add", "-A"); git(cwd, "commit", "-q", "-m", "commit what is there"); } // no file changes
    }, ["reject"]);
    expect(await engine().start({ goal: "g" })).toMatchObject({ code: "no-progress", node: "repair" });
  });

  test("a first visit is never a no-change, even when it changes nothing", async () => {
    const { engine, path } = setup(() => {}, ["reject", "pass"]);
    expect(await engine().start({ goal: "g" })).toEqual({ state: "finished", outcome: "success" });
    expect(visits(path, "repair")).toEqual([1]);
  });

  test("replayed in a fresh process the decision is the same; a reply reaches the next attempt", async () => {
    const { engine, dir, path, graph, sent } = setup((visit, cwd) => { if (visit === 1) writeFileSync(join(cwd, "feature.ts"), "export const f = 2;\n"); }, ["reject"]);
    await engine().start({ goal: "g" });
    expect(madeNoProgress(readLog(path), "repair", 2)).toBe(true);
    const { resolveReply } = await import("./control");
    const r = resolveReply(dir, "export g from feature.ts", { attentionDir: join(dir, "attn"), graphs: { loop: graph } } as never);
    expect(JSON.stringify(r)).toContain('"ok":true');
    const again = await engine().resume(); // a NEW engine over the same log
    expect(again).toMatchObject({ state: "parked", node: "repair", code: "no-progress" });
    expect((again as { reason: string }).reason).toContain("repair@3 changed nothing in the worktree since visit 2");
    expect(sent.get("repair@3")).toContain("## Operator reply");
    expect(sent.get("repair@3")).toContain("export g from feature.ts");
  });
});

describe("worktreeTree", () => {
  test("content identity: edits and untracked files move it, ignored files and commits do not; the real index is untouched", () => {
    const cwd = repo();
    const t0 = worktreeTree(cwd)!;
    expect(t0).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(cwd, ".gitignore"), "*.log\n");
    const t1 = worktreeTree(cwd)!;
    expect(t1).not.toBe(t0);
    writeFileSync(join(cwd, "debug.log"), "noise");
    expect(worktreeTree(cwd)).toBe(t1); // ignored
    writeFileSync(join(cwd, "new.ts"), "x");
    const t2 = worktreeTree(cwd)!;
    expect(t2).not.toBe(t1); // untracked counts
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", "c");
    expect(worktreeTree(cwd)).toBe(t2); // a commit of what is there changes nothing
    expect(git(cwd, "status", "--porcelain").stdout).toBe(""); // and the real index was never staged into
    expect(worktreeTree(mkdtempSync(join(tmpdir(), "plain-")))).toBeNull();
  });
});

describe("replies that retry a step are rendered into it", () => {
  test("every park whose reply rule retries with the reply also renders it (no-progress, paused-by-operator)", async () => {
    const { REPLY_RULES } = await import("./control");
    const { RENDERABLE_REPLY_CODES, rendersReply } = await import("./replay");
    // the parks retried WITH the reply (retryWithReply) — a login failure accepts a reply too,
    // but deliberately does not render it: the fix there is a human logging in
    for (const code of ["attempt-failed", "executor-threw", "context-exhausted", "paused-by-operator", "no-progress"] as const) {
      expect([code, REPLY_RULES[code]({ run: "r", node: "n", kind: "agent" } as never).accept]).toEqual([code, true]);
      expect([code, RENDERABLE_REPLY_CODES.has(code)]).toEqual([code, true]);
    }
    const ask = (code: string) => ({ type: "attention-raised", node: "n", visit: 1, reason: "r", code, seq: 1, ts: "" }) as never;
    for (const code of ["no-progress", "paused-by-operator"])
      expect(rendersReply(ask(code), { node: "n", reply: "do it differently", source: "operator" })).toBe("do it differently");
  });
});
