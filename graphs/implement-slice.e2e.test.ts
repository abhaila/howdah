/**
 * implement-slice end to end (system-map 1c, E2E D11/10A) — the tracer bullet on the fixture
 * repo (graphs/fixtures/slice-repo: one http4k route + one React-side fetch), with every piece
 * real except the model:
 *
 *   real engine · real worktree executor (git worktree add/remove) · real map built-ins
 *   (tree-sitter extraction, manifests, drift) · real approval executor · the REAL claude
 *   executor speaking stream-json to engine/executors/fake-claude.ts, scripted turn by turn
 *   (FAKE_CLAUDE_SCRIPT) · decisions through a REAL viewer server (web/server.ts
 *   createHowdahServer): comment, approval and redesign are HTTP requests to its routes
 *
 * No real agents and no spawned `resume`: the server's resumeRun is injected as a recorder —
 * the test waits for the wake, then resumes the engine itself where a runner would.
 *
 *   proposer v1 → comment pinned → send-feedback → proposer v2 (the prompt carries the comment)
 *     → restart without a decision re-parks → approve → fake implement edits + commits v2
 *     → re-extract → drift: every implemented ghost verified at the implement commit → delivery
 *   plus: redesign reaches the proposer exactly once; a worktree edit between approve and
 *   implement parks stale-base.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { implementSlice } from "./implement-slice";
import { Engine, type Executor } from "../engine/run";
import { claudeExecutor } from "../engine/executors/claude";
import { commandExecutor, readWorktreeRecord, worktreeExecutor } from "../engine/executors/worktree";
import { approvalExecutor } from "../engine/executors/approval";
import { createHowdahServer } from "../web/server";
import { replayState } from "../engine/replay";
import type { LoggedEvent } from "../log/events";
import type { MapAfter } from "../engine/slice-map";
import {
  sliceRepo, implementedV2, COMMENT_V1, GHOSTS_V1, GHOSTS_V2, DELETE_ROUTE, DELETE_USER_TS, SLICE_GOAL, SLICE_WORK, APP_KT,
} from "./slice-fixture";

const FAKE = join(dirname(import.meta.dir), "engine", "executors", "fake-claude.ts");
const PROMPTS = join(dirname(import.meta.dir), "prompts");
const ENV_KEYS = ["HOWDAH_HOME", "FAKE_CLAUDE_SCRIPT", "FAKE_CAPTURE", "FAKE_CLAUDE_VERDICT"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) if (process.env[k] !== undefined) saved[k] = process.env[k];
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

type Turn = { match: string; outputs?: Record<string, unknown>; edits?: Array<{ path: string; content: string }>; commit?: string };

/** One run: a fresh HOWDAH_HOME, fixture repo, fake-claude script and prompt capture. */
function e2e(turns: Turn[], opts: { approval?: Executor } = {}) {
  const home = mkdtempSync(join(tmpdir(), "howdah-slice-e2e-"));
  process.env.HOWDAH_HOME = home;
  const script = join(home, "script.json");
  writeFileSync(script, JSON.stringify({ turns }));
  process.env.FAKE_CLAUDE_SCRIPT = script;
  process.env.FAKE_CAPTURE = join(home, "prompts.jsonl");
  const { dir: repo } = sliceRepo();
  const runDir = join(home, "runs", "slice-e2e");
  const engine = () =>
    new Engine(implementSlice, {
      dir: runDir,
      cwd: repo,
      folderKind: "repo",
      promptsDir: PROMPTS,
      executors: {
        worktree: worktreeExecutor({ reposDir: join(home, "repos") }),
        command: commandExecutor({ map: { workers: 0 }, prProbe: () => ({ state: "MERGED", url: "https://example.test/pr/7" }) }),
        agent: claudeExecutor({ attentionDir: join(home, "attention"), binary: FAKE, notifiers: [] }),
        approval: opts.approval ?? approvalExecutor,
        wait: async () => ({ status: "succeeded", writes: {} }),
      },
    });
  const events = () => engine().log.read();
  const web = viewer(join(home, "runs"), join(home, "attention"), "slice-e2e");
  servers.push(web);
  return { home, repo, runDir, engine, events, web };
}

const servers: Array<{ stop: () => void }> = [];
afterAll(() => {
  for (const s of servers) s.stop();
});

/**
 * The viewer's decision routes for one run, with resumeRun recorded. Every write that wakes the
 * runner resolves only once the wake landed, so the test's own resume never races it.
 */
function viewer(runsDir: string, attentionDir: string, id: string) {
  const woken: string[] = [];
  const server = createHowdahServer({ runsDir, attentionDir, port: 0, pollMs: 20, resumeRun: (run) => woken.push(run) });
  const post = async (sub: string, body: unknown) => {
    const res = await fetch(`http://localhost:${server.port}/api/runs/${id}/${sub}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const waitForWake = async (before: number) => {
    for (let i = 0; i < 100 && woken.length <= before; i++) await Bun.sleep(20);
    expect(woken.length).toBeGreaterThan(before);
    expect(woken.at(-1)).toBe(id);
  };
  return {
    woken,
    stop: () => server.stop(true),
    comment: (entity_id: string, text: string) => post("comments", { entity_id, text }),
    /** approve (true) or send the round's comments back (false) — on the round the operator saw */
    decide: async (approved: boolean, proposal_id: number) => {
      const before = woken.length;
      const r = await post("approval", { approved, proposal_id });
      if (r.status === 200) await waitForWake(before);
      return r;
    },
    redesign: async (message: string) => {
      const before = woken.length;
      const r = await post("redesign", { message });
      if (r.status === 202) await waitForWake(before);
      return r;
    },
  };
}

/** the current proposal round's id */
const currentRound = (events: LoggedEvent[]): number => {
  const round = events.findLast((e) => e.type === "ghost-proposed");
  if (round?.type !== "ghost-proposed") throw new Error("no proposal round yet");
  return round.proposal_id;
};

/** every prompt the fake received, in order */
const sentPrompts = (home: string): string[] =>
  existsSync(join(home, "prompts.jsonl")) ? readFileSync(join(home, "prompts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string) : [];

const byType = <T extends LoggedEvent["type"]>(events: LoggedEvent[], type: T) => events.filter((e): e is Extract<LoggedEvent, { type: T }> => e.type === type);
const startedNodes = (events: LoggedEvent[]) => events.flatMap((e) => (e.type === "node-started" ? [e.node] : []));

/** The turns of the happy path; `implement` edits are computed against the fixture's base files. */
function happyTurns(repo: string): Turn[] {
  return [
    { match: "slice.ghosts", outputs: { "slice.ghosts": GHOSTS_V1 } },
    { match: "slice.ghosts", outputs: { "slice.ghosts": GHOSTS_V2 } },
    { match: "implementation_summary", edits: implementedV2(repo), commit: "implement the delete-user slice", outputs: { implementation_summary: "built v2" } },
    { match: "review_verdict", outputs: { review_verdict: "pass", review_findings: [] } },
    { match: "publication_summary", outputs: { publication_summary: "opened PR #7" } },
    { match: "completion_summary", outputs: { completion_summary: "merged" } },
  ];
}

const START = { goal: SLICE_GOAL, work: SLICE_WORK };
const AWAITING = { state: "parked", node: "slice.approve", code: "awaiting-approval" } as const;

describe("implement-slice E2E (fake-claude, real map, real decisions)", () => {
  test("v1 → comment → feedback → v2 → restart re-parks → approve → implement → drift verified → delivered", async () => {
    const seedRepo = sliceRepo().dir; // the same files the run's repo starts from
    const run = e2e(happyTurns(seedRepo));

    // round 1: extract, propose v1, wait for the operator
    expect(await run.engine().start(START)).toMatchObject(AWAITING);
    const wt = readWorktreeRecord(run.runDir);
    expect(wt?.branch).toBe("howdah/slice-e2e");
    const [round1] = byType(run.events(), "ghost-proposed");
    expect(round1).toMatchObject({ node: "slice.propose", approval: "slice.approve", proposal: GHOSTS_V1 });
    expect(round1!.manifest_hash).toBe(byType(run.events(), "map-extracted")[0]!.manifest_hash);
    // the proposer saw the map neighbourhood of the entities the ticket names
    const firstPropose = sentPrompts(run.home)[0]!;
    expect(firstPropose).toContain("Map neighbourhood");
    expect(firstPropose).toContain("`GET /api/users/{*}`");
    expect(firstPropose).toContain("READ-ONLY");

    // the operator pins a comment on v1 and sends it back
    const pinned = await run.web.comment(COMMENT_V1.entity_id, COMMENT_V1.text);
    expect(pinned).toMatchObject({ status: 201, body: { ok: true, proposal_id: round1!.proposal_id } });
    expect(await run.web.decide(false, round1!.proposal_id)).toMatchObject({ status: 200, body: { ok: true, idempotent: false } });

    // round 2: the redraw carries the comment and answers it
    expect(await run.engine().resume()).toMatchObject(AWAITING);
    const rounds = byType(run.events(), "ghost-proposed");
    expect(rounds.map((r) => r.proposal)).toEqual([GHOSTS_V1, GHOSTS_V2]);
    const secondPropose = sentPrompts(run.home)[1]!;
    expect(secondPropose).toContain(COMMENT_V1.text);
    expect(secondPropose).toContain(DELETE_ROUTE);

    // a restart without a decision re-parks on the same round — nothing is built
    expect(await run.engine().resume()).toMatchObject(AWAITING);
    expect(startedNodes(run.events())).not.toContain("implementation.implement");
    expect(byType(run.events(), "ghost-proposed")).toHaveLength(2);

    // approve v2 through the decision module; the runner (here: the test) picks it up
    // deciding on the superseded round is refused; the current one is approved
    expect(await run.web.decide(true, rounds[0]!.proposal_id)).toMatchObject({ status: 409, body: { code: "superseded" } });
    expect(await run.web.decide(true, rounds[1]!.proposal_id)).toMatchObject({ status: 200, body: { ok: true, proposal_id: rounds[1]!.proposal_id, idempotent: false } });
    expect(await run.engine().resume()).toEqual({ state: "finished", outcome: "success" });

    const events = run.events();
    // the milestones, in order
    const milestone = (e: LoggedEvent): string | null => {
      if (e.type === "ghost-proposed") return `proposed #${e.proposal_id}`;
      if (e.type === "comment-pinned") return "comment";
      if (e.type === "slice-feedback-sent") return "feedback";
      if (e.type === "slice-approved") return "approved";
      if (e.type === "map-extracted") return `extracted by ${e.node}`;
      if (e.type === "drift-detected") return `drift by ${e.node}`;
      if (e.type === "node-started" && ["implementation.implement", "implementation.local_review", "delivery.publish"].includes(e.node)) return e.node;
      if (e.type === "run-finished") return `finished ${e.outcome}`;
      return null;
    };
    expect(events.map(milestone).filter((m) => m !== null)).toEqual([
      "extracted by map.extract",
      `proposed #${rounds[0]!.proposal_id}`,
      "comment",
      "feedback",
      `proposed #${rounds[1]!.proposal_id}`,
      "approved",
      "implementation.implement",
      "extracted by map.reextract",
      "drift by map.drift",
      "implementation.local_review",
      "delivery.publish",
      "finished success",
    ]);

    // drift: every implemented ghost verified, stamped with the implement commit (D21)
    const after = events.find((e) => e.type === "node-finished" && e.node === "map.reextract");
    const afterSnap = (after?.type === "node-finished" ? after.writes["map.after"] : null) as MapAfter;
    const [drift] = byType(events, "drift-detected");
    expect(drift!.commit).toBe(afterSnap.commit);
    expect(drift!.commit).not.toBe(byType(events, "map-extracted")[0]!.commit);
    for (const g of GHOSTS_V2.entities) expect(drift!.items.find((i) => i.key === g.id && i.op !== null)).toMatchObject({ outcome: "verified" });
    expect(drift!.counts.missing + drift!.counts["changed-unexpectedly"] + drift!.counts["still-present"]).toBe(0);

    // the implement prompt carried the approved design; the reviewer saw the drift
    const prompts = sentPrompts(run.home);
    const implement = prompts.find((p) => p.includes("## The approved design") && p.includes("implementation_summary"))!;
    expect(implement).toContain(DELETE_USER_TS);
    const review = prompts.find((p) => p.includes("Drift: the design vs the code"))!;
    expect(review).toContain(`"outcome":"verified"`);

    // the worktree was cleaned up after the merge
    expect(readWorktreeRecord(run.runDir)).toBeNull();
    expect(replayState(events).finished?.outcome).toBe("success");
  }, 60_000);

  test("redesign: the message reaches the proposer exactly once, and re-extraction sees it as seed text", async () => {
    const run = e2e([
      { match: "slice.ghosts", outputs: { "slice.ghosts": GHOSTS_V1 } },
      { match: "slice.ghosts", outputs: { "slice.ghosts": GHOSTS_V2 } },
      { match: "slice.ghosts", outputs: { "slice.ghosts": GHOSTS_V2 } },
    ]);
    expect(await run.engine().start(START)).toMatchObject(AWAITING);

    const MESSAGE = "also cover the web client in `web/src/api.ts`";
    expect(await run.web.redesign(MESSAGE)).toMatchObject({ status: 202, body: { ok: true, jumped_to: "map.extract" } });
    expect(await run.engine().resume()).toMatchObject(AWAITING);
    // round 2's prompt has it; the extract after the redesign ran again
    expect(sentPrompts(run.home)[1]).toContain(MESSAGE);
    expect(byType(run.events(), "map-extracted").map((e) => e.node)).toEqual(["map.extract", "map.extract"]);

    // a feedback round afterwards does NOT repeat it
    await run.web.comment(DELETE_USER_TS, "name it removeUser");
    await run.web.decide(false, currentRound(run.events()));
    expect(await run.engine().resume()).toMatchObject(AWAITING);
    const third = sentPrompts(run.home)[2]!;
    expect(third).toContain("name it removeUser");
    expect(third).not.toContain(MESSAGE);
  }, 60_000);

  test("a worktree edit between approve and implement parks stale-base (the requires gate), consuming no visit", async () => {
    let edited = false;
    const editingApproval: Executor = async (args) => {
      const result = await approvalExecutor(args);
      if (result.status === "succeeded" && !edited) {
        // a teammate edits the checkout right after the approval landed
        const wt = readWorktreeRecord(dirname(args.log.path))!;
        writeFileSync(join(wt.path, APP_KT), readFileSync(join(wt.path, APP_KT), "utf8") + "\n// hotfix\n");
        edited = true;
      }
      return result;
    };
    const run = e2e([{ match: "slice.ghosts", outputs: { "slice.ghosts": GHOSTS_V2 } }], { approval: editingApproval });
    expect(await run.engine().start(START)).toMatchObject(AWAITING);
    await run.web.decide(true, currentRound(run.events()));
    const result = await run.engine().resume();
    expect(result).toMatchObject({ state: "parked", node: "implementation.implement", code: "stale-base" });
    expect((result as { reason: string }).reason).toContain("tracked changes differ");
    expect(startedNodes(run.events())).not.toContain("implementation.implement");
  }, 60_000);
});
