/**
 * A review of repairs judges only the repairs' diff (core/graph.ts `reviewsWorkOf`): the
 * pure derivation over a synthetic log, then the engine over a REAL temp git repo — the sha in
 * the briefing is the one git had when the repair started, logged as `repair_scope`, and
 * prompts/library.ts rebuilds the same text from it (VERIFIED).
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type AttemptResult } from "./run";
import { defineGraph } from "../core/graph";
import { repairScope } from "./repair-scope";
import { Reconciler } from "./reconcile";
import { reconstructRender } from "../prompts/library";
import type { LoggedEvent } from "../log/events";

const ev = (e: object, seq: number): LoggedEvent => ({ seq, ts: new Date(seq * 1000).toISOString(), ...e }) as LoggedEvent;
const started = (node: string, visit: number, seq: number) => ev({ type: "node-started", node, visit, attempt_id: `${node}#${visit}` }, seq);
const finished = (node: string, visit: number, status: string, seq: number) => ev({ type: "node-finished", node, visit, status, writes: {} }, seq);
const probed = (node: string, head: string, seq: number, branch = "feature/x") =>
  ev({ type: "reconciled", node, git: { repo: true, branch, head, uncommitted: 0, unpushed: null }, intended: {}, disagreements: [] }, seq);

const REPAIRS = ["fix_ci", "address_reviews", "revise"];

describe("repairScope: the commit the earliest repair since the last verdict started from", () => {
  test("one repair since the last review → that repair's start commit, visit and branch", () => {
    const log = [
      probed("review", "aaa", 1), started("review", 1, 2), finished("review", 1, "succeeded", 3),
      probed("publish", "aaa", 4), started("publish", 1, 5), finished("publish", 1, "succeeded", 6),
      probed("fix_ci", "bbb", 7), started("fix_ci", 1, 8), finished("fix_ci", 1, "succeeded", 9),
      probed("review", "ccc", 10), started("review", 2, 11),
    ];
    expect(repairScope(log, "review", REPAIRS)).toEqual({ node: "fix_ci", visit: 1, sha: "bbb", branch: "feature/x" });
  });

  test("a streak of repair visits (one timed out, the next continued) is ONE scope from the first", () => {
    const log = [
      started("review", 1, 1), finished("review", 1, "succeeded", 2),
      probed("fix_ci", "b1", 3), started("fix_ci", 9, 4), finished("fix_ci", 9, "failed", 5),
      probed("fix_ci", "b2", 6), started("fix_ci", 10, 7), finished("fix_ci", 10, "succeeded", 8),
      probed("fix_ci", "b3", 9), started("fix_ci", 11, 10), finished("fix_ci", 11, "succeeded", 11),
      probed("review", "d", 12), started("review", 2, 13),
    ];
    expect(repairScope(log, "review", REPAIRS)).toMatchObject({ node: "fix_ci", visit: 9, sha: "b1" });
  });

  test("a review that failed before answering judged nothing: the scope still starts before it", () => {
    const log = [
      started("review", 1, 1), finished("review", 1, "succeeded", 2),
      probed("address_reviews", "r1", 3), started("address_reviews", 1, 4), finished("address_reviews", 1, "succeeded", 5),
      probed("review", "x", 6), started("review", 2, 7), finished("review", 2, "failed", 8),
      probed("review", "x", 9), started("review", 3, 10),
    ];
    expect(repairScope(log, "review", REPAIRS)).toMatchObject({ node: "address_reviews", visit: 1, sha: "r1" });
  });

  test("repairs before the last verdict are outside the scope; none since → no briefing at all", () => {
    const log = [
      probed("fix_ci", "old", 1), started("fix_ci", 1, 2), finished("fix_ci", 1, "succeeded", 3),
      probed("review", "y", 4), started("review", 1, 5), finished("review", 1, "succeeded", 6),
      probed("review", "y", 7), started("review", 2, 8),
    ];
    expect(repairScope(log, "review", REPAIRS)).toBeUndefined();
    // and a probe with no head (not a git repo) is no scope rather than a guessed one
    const noHead = [ev({ type: "reconciled", node: "fix_ci", git: { repo: false }, intended: {}, disagreements: [] }, 1), started("fix_ci", 1, 2), started("review", 1, 3)];
    expect(repairScope(noHead, "review", REPAIRS)).toBeUndefined();
    expect(repairScope([], "review", REPAIRS)).toBeUndefined();
  });
});

type C = { goal: string; summary: string; review_verdict: string; review_findings: unknown };
const ok = (writes: Record<string, unknown> = {}): AttemptResult => ({ status: "succeeded", writes });
const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).stdout.trim();

describe("the engine briefs a reviewsWorkOf step with the repair's real start commit", () => {
  test("second review carries repair_scope = HEAD when the repair started; first review carries none; reconstruction is VERIFIED", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-rs-"));
    const prompts = mkdtempSync(join(tmpdir(), "howdah-rs-p-"));
    for (const id of ["doc.draft", "doc.review"]) writeFileSync(join(prompts, `${id}.md`), `---\nid: ${id}\nversion: 1\n---\nDo {{ context.goal }}.\n`);
    const cwd = mkdtempSync(join(tmpdir(), "howdah-rs-repo-"));
    git(cwd, "init", "-q", "-b", "main");
    writeFileSync(join(cwd, "a.txt"), "a\n");
    git(cwd, "add", "-A"); git(cwd, "commit", "-q", "-m", "init");
    const graph = defineGraph<C>({
      name: "scoped", entry: "implement", inputs: ["goal"],
      nodes: {
        implement: { kind: "agent", prompt: "doc.draft", reads: ["goal"], writes: { summary: { scope: "sticky" } } },
        review: { kind: "agent", prompt: "doc.review", reads: ["goal", "summary"], writes: { review_verdict: { scope: "cleared" }, review_findings: { scope: "cleared" } }, readOnly: true, reviewsWorkOf: ["repair"] },
        repair: { kind: "agent", prompt: "doc.draft", reads: ["goal", "review_findings"], writes: { summary: { scope: "sticky" } }, maxVisits: 3 },
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
    const sent = new Map<string, string>();
    let afterImplement = "";
    const engine: Engine = new Engine(graph, {
      dir, promptsDir: prompts, cwd, folderKind: "repo",
      // the CLI's reconciler seat (cli/main.ts reconcilerHook): git is probed before every node
      beforeNode: async (nodeId, def) => {
        const r = await new Reconciler(cwd).reconcile(def);
        engine.log.append({ type: "reconciled", node: nodeId, git: r.git, intended: undefined, disagreements: r.disagreements });
      },
      executors: {
        agent: async ({ nodeId, visit, renderedPrompt }) => {
          sent.set(`${nodeId}@${visit}`, renderedPrompt ?? "");
          if (nodeId === "implement") {
            writeFileSync(join(cwd, "feature.ts"), "export const f = 1;\n");
            git(cwd, "add", "-A"); git(cwd, "commit", "-q", "-m", "feature");
            afterImplement = git(cwd, "rev-parse", "HEAD");
            return ok({ summary: "built" });
          }
          if (nodeId === "review") return ok(reviews++ === 0 ? { review_verdict: "reject", review_findings: ["also g"] } : { review_verdict: "pass", review_findings: [] });
          writeFileSync(join(cwd, "feature.ts"), "export const f = 1, g = 2;\n");
          git(cwd, "add", "-A"); git(cwd, "commit", "-q", "-m", "repair");
          return ok({ summary: "repaired" });
        },
      },
    });
    expect(await engine.start({ goal: "g" })).toEqual({ state: "finished", outcome: "success" });
    const renders = engine.log.read().filter((e): e is Extract<LoggedEvent, { type: "prompt-rendered" }> => e.type === "prompt-rendered" && e.node === "review");
    expect(renders).toHaveLength(2);
    // the first review has no repair to scope to: no briefing, nothing logged
    expect(renders[0]!.repair_scope).toBeUndefined();
    expect(sent.get("review@1")).not.toContain("## Repair scope");
    // the second is scoped to the commit the repair started from — what git had after implement
    expect(afterImplement).toMatch(/^[0-9a-f]{40}$/);
    expect(renders[1]!.repair_scope).toEqual({ node: "repair", visit: 1, sha: afterImplement, branch: "main" });
    expect(sent.get("review@2")).toContain(`## Repair scope\nThis is a review of a repair, not of the whole branch. The repair began at repair@1 from ${afterImplement.slice(0, 12)} on main;`);
    expect(sent.get("review@2")).toContain(`git log ${afterImplement.slice(0, 12)}..HEAD`);
    // reconstruction rebuilds the briefing from the logged repair_scope: VERIFIED, same bytes
    const r = reconstructRender(dir, renders[1]!.rendered_hash)!;
    expect(r.verified).toBe(true);
    expect(r.text).toBe(sent.get("review@2")!);
  });
});
