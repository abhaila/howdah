/**
 * system-map 1a CLI verbs, driven as real subprocesses (the verbs exist for scripts, so
 * the exit code IS the contract): approve / comment / send-feedback / redesign, plus a
 * CLI-vs-web race on one proposal round.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeAndRedraw, seedAwaitingRun } from "../engine/slice-decision.fixtures";
import { claimRunner, releaseRunner } from "../engine/control";
import { EventLog } from "../log/write";
import { processStart } from "../log/lockfile";
import { AttentionCenter } from "../engine/attention";
import { splitProposalFlag } from "./main";
import { createHowdahServer } from "../web/server";

const MAIN = join(import.meta.dir, "main.ts");

function home() {
  const base = mkdtempSync(join(tmpdir(), "howdah-cli-"));
  const runsDir = join(base, "runs");
  mkdirSync(runsDir, { recursive: true });
  return { base, runsDir };
}

async function cli(base: string, ...args: string[]) {
  const p = Bun.spawn(["bun", MAIN, ...args], {
    env: { ...process.env, HOWDAH_HOME: base, HOWDAH_STUB: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

describe("approval verbs (system-map 1a)", () => {
  test("approve: exit 0 and says which round; again: exit 0, idempotent; one decision event", async () => {
    const { base, runsDir } = home();
    const run = seedAwaitingRun(runsDir, "r1");
    const first = await cli(base, "approve", "r1");
    expect(first).toMatchObject({ code: 0, stdout: `approved proposal #${run.round.proposal_id}` });
    const again = await cli(base, "approve", "r1");
    expect(again).toMatchObject({ code: 0, stdout: `proposal #${run.round.proposal_id} was already approved` });
    expect(run.events().filter((e) => e.type === "slice-approved")).toHaveLength(1);
  }, 20000);

  test("comment then send-feedback: exit 0; feedback after approval: exit 1 naming the approval", async () => {
    const { base, runsDir } = home();
    const run = seedAwaitingRun(runsDir, "r2");
    const pinned = await cli(base, "comment", "r2", "route:/users", "paginate", "this", "list");
    expect(pinned.code).toBe(0);
    expect(pinned.stdout).toMatch(/^pinned c\d+ to route:\/users on proposal #\d+$/);
    expect(run.events().find((e) => e.type === "comment-pinned")).toMatchObject({ entity_id: "route:/users", text: "paginate this list" });
    expect(await cli(base, "send-feedback", "r2")).toMatchObject({ code: 0, stdout: `sent feedback on proposal #${run.round.proposal_id}` });

    const other = seedAwaitingRun(runsDir, "r3");
    await cli(base, "approve", "r3");
    const refused = await cli(base, "send-feedback", "r3");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/already approved at \d\d:\d\d \[already-decided\]$/);
    expect(other.events().filter((e) => e.type === "slice-feedback-sent")).toHaveLength(0);
  }, 20000);

  test("refusals exit 1: unknown run, empty feedback, blank comment, redesign of an unregistered graph", async () => {
    const { base, runsDir } = home();
    seedAwaitingRun(runsDir, "r4");
    const unknown = await cli(base, "approve", "nope");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("unknown run: nope [unknown-run]");
    const empty = await cli(base, "send-feedback", "r4");
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain("no comments are pinned");
    expect((await cli(base, "comment", "r4", "e")).code).toBe(1);
    const redesign = await cli(base, "redesign", "r4", "try", "again");
    expect(redesign.code).toBe(1);
    expect(redesign.stderr).toContain("not registered in graphs/index.ts [unknown-graph]");
  }, 20000);

  test("CLI and web racing on one round land exactly one decision", async () => {
    const { base, runsDir } = home();
    const server = createHowdahServer({ runsDir, attentionDir: join(base, "attention"), port: 0, resumeRun: () => {} });
    try {
      for (const [i, webApproves] of [true, false, true].entries()) {
        const id = `race${i}`;
        const run = seedAwaitingRun(runsDir, id);
        const web = fetch(`http://localhost:${server.port}/api/runs/${id}/comments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ entity_id: "e", text: "c" }),
        }).then(() =>
          fetch(`http://localhost:${server.port}/api/runs/${id}/approval`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ approved: webApproves, proposal_id: run.round.proposal_id }),
          }),
        );
        const [res, out] = await Promise.all([web, cli(base, "approve", id)]);
        const decisions = run.events().filter((e) => e.type === "slice-approved" || e.type === "slice-feedback-sent");
        expect(decisions).toHaveLength(1);
        if (webApproves) {
          // same decision from both sides: both succeed, one of them idempotently
          expect(res.status).toBe(200);
          expect(out.code).toBe(0);
        } else {
          // different decisions: exactly one side wins, the other is refused
          const winners = [res.status === 200, out.code === 0].filter(Boolean);
          expect(winners).toHaveLength(1);
          if (res.status !== 200) expect(((await res.json()) as { code: string }).code).toBe("already-decided");
        }
      }
    } finally {
      server.stop(true);
    }
  }, 30000);

  test("--proposal binds the verb to a round: current → ok, superseded → exit 1, malformed → exit 1", async () => {
    const { base, runsDir } = home();
    const run = seedAwaitingRun(runsDir, "bind");
    const r1 = run.round;
    expect((await cli(base, "comment", "bind", "e", "first", "--proposal", String(r1.proposal_id))).code).toBe(0);
    expect((await cli(base, "send-feedback", "bind", "--proposal", String(r1.proposal_id))).code).toBe(0);
    const r2 = consumeAndRedraw(run.log, { v: 2 });
    const stale = await cli(base, "approve", "bind", "--proposal", String(r1.proposal_id));
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain(`proposal #${r1.proposal_id} was superseded by #${r2.proposal_id}`);
    const bad = await cli(base, "approve", "bind", "--proposal", "latest");
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("--proposal needs a proposal id");
    expect(await cli(base, "approve", "--proposal", String(r2.proposal_id), "bind")).toMatchObject({ code: 0, stdout: `approved proposal #${r2.proposal_id}` });
  }, 30000);
});

describe("one runner per run (system-map 1a review item 2)", () => {
  test("`resume` while another live runner holds the run exits quietly and appends nothing; once released it runs", async () => {
    const { base, runsDir } = home();
    const runDir = join(runsDir, "held");
    const log = new EventLog(join(runDir, "run.jsonl"));
    log.append({ type: "run-started", graph: "write-doc", inputs: { goal: "g", work: "w" }, pinned_prompts: {} });
    expect(claimRunner(runDir)).toBeNull(); // this test process is the live runner
    try {
      const before = log.read().length;
      const out = await cli(base, "resume", "held");
      expect(out.code).toBe(0);
      expect(out.stdout).toBe(`run held already has a live runner (pid ${process.pid}) — nothing to do`);
      expect(log.read()).toHaveLength(before);
      // a second claim in the same process is refused too (two engines in one process)
      expect(claimRunner(runDir)).toMatchObject({ pid: process.pid, genuine: true });
    } finally {
      releaseRunner(runDir);
    }
    const out = await cli(base, "resume", "held");
    expect(out.stdout).not.toContain("already has a live runner");
    expect(log.read().some((e) => e.type === "node-started")).toBe(true);
  }, 30000);
});


describe("runner lock escape hatch (system-map 1a re-review item 1)", () => {
  function heldRun(base: string, runsDir: string, id: string) {
    const runDir = join(runsDir, id);
    const log = new EventLog(join(runDir, "run.jsonl"));
    log.append({ type: "run-started", graph: "write-doc", inputs: { goal: "g", work: "w" }, pinned_prompts: {} });
    return { runDir, log };
  }

  test("a legacy lock naming a live bun process that is NOT this run's runner: attention + exit 1; --force breaks it", async () => {
    const { base, runsDir } = home();
    const { runDir, log } = heldRun(base, runsDir, "stuck");
    const impostor = Bun.spawn(["bun", "-e", "await Bun.sleep(30000)"]);
    try {
      await Bun.sleep(100);
      writeFileSync(join(runDir, "runner.pid"), String(impostor.pid));
      const out = await cli(base, "resume", "stuck");
      expect(out.code).toBe(1);
      expect(out.stderr).toContain(`run stuck is locked by pid ${impostor.pid}`);
      expect(out.stderr).toContain("`resume stuck --force` breaks the lock");
      const pending = new AttentionCenter(join(base, "attention"), []).pending();
      expect(pending).toEqual([expect.objectContaining({ run: "stuck", node: "runner-lock", reason: expect.stringContaining("--force") })]);
      expect(log.read()).toHaveLength(1);

      const forced = await cli(base, "resume", "stuck", "--force");
      expect(forced.stderr).not.toContain("cannot force");
      expect(log.read().some((e) => e.type === "node-started")).toBe(true);
    } finally {
      impostor.kill(9);
      await impostor.exited;
    }
  }, 30000);

  test("--force never breaks a GENUINE live runner (identity matches)", async () => {
    const { base, runsDir } = home();
    const { runDir, log } = heldRun(base, runsDir, "genuine");
    const runner = Bun.spawn(["sleep", "30"]);
    try {
      const identity = `${runner.pid} ${processStart(runner.pid)}`;
      writeFileSync(join(runDir, "runner.pid"), identity);
      const out = await cli(base, "resume", "genuine", "--force");
      expect(out.code).toBe(1);
      expect(out.stderr).toContain(`cannot force: pid ${runner.pid} is this run's live runner`);
      expect(readFileSync(join(runDir, "runner.pid"), "utf8")).toBe(identity);
      expect(log.read()).toHaveLength(1);
      // without --force: a genuine runner owns the run, quietly
      expect(await cli(base, "resume", "genuine")).toMatchObject({ code: 0, stdout: `run genuine already has a live runner (pid ${runner.pid}) — nothing to do` });
    } finally {
      runner.kill(9);
      await runner.exited;
    }
  }, 30000);
});

describe("--proposal parsing never eats comment text (re-review item 4)", () => {
  test("leading flag, `--` separator, and text that mentions --proposal", () => {
    expect(splitProposalFlag(["r1", "--proposal", "7"])).toEqual({ proposalId: 7, rest: ["r1"] });
    expect(splitProposalFlag(["r1", "--proposal", "7", "e1", "some", "text"], 2)).toEqual({ proposalId: 7, rest: ["r1", "e1", "some", "text"] });
    expect(splitProposalFlag(["r1", "e1", "the", "--proposal", "flag", "is", "odd"], 2)).toEqual({
      proposalId: undefined,
      rest: ["r1", "e1", "the", "--proposal", "flag", "is", "odd"],
    });
    expect(splitProposalFlag(["r1", "e1", "--", "--proposal", "9"], 2)).toEqual({ proposalId: undefined, rest: ["r1", "e1", "--proposal", "9"] });
    expect(() => splitProposalFlag(["r1", "--proposal", "x"])).toThrow("--proposal needs a proposal id");
  });

  test("a comment whose text contains --proposal is pinned verbatim", async () => {
    const { base, runsDir } = home();
    const run = seedAwaitingRun(runsDir, "txt");
    const out = await cli(base, "comment", "txt", "e1", "why", "is", "--proposal", "12", "here");
    expect(out.code).toBe(0);
    expect(run.events().find((e) => e.type === "comment-pinned")).toMatchObject({ text: "why is --proposal 12 here" });
  }, 20000);
});

describe("legacy locks held by cli/main.ts and the `up` supervisor (final review items 2, 3)", () => {
  test("--force refuses a legacy holder running cli/main.ts that does not name the run (maybe an old `run <graph>`)", async () => {
    const { base, runsDir } = home();
    const runDir = join(runsDir, "old");
    new EventLog(join(runDir, "run.jsonl")).append({ type: "run-started", graph: "write-doc", inputs: { goal: "g", work: "w" }, pinned_prompts: {} });
    const oldRunner = Bun.spawn(["bun", "-e", "setInterval(()=>{},1e9)", "/somewhere/cli/main.ts"]);
    try {
      await Bun.sleep(200);
      writeFileSync(join(runDir, "runner.pid"), String(oldRunner.pid));
      const plain = await cli(base, "resume", "old");
      expect(plain.code).toBe(1);
      expect(plain.stderr).toContain("runs cli/main.ts but does not name this run — it may be an older runner of it; pause or abort it");
      const forced = await cli(base, "resume", "old", "--force");
      expect(forced.code).toBe(1);
      expect(forced.stderr).toContain(`cannot force: pid ${oldRunner.pid} runs cli/main.ts and may be this run's (older) runner`);
      expect(readFileSync(join(runDir, "runner.pid"), "utf8")).toBe(String(oldRunner.pid));
      expect(oldRunner.exitCode).toBeNull();
    } finally {
      oldRunner.kill(9);
      await oldRunner.exited;
    }
  }, 30000);

  test("`up` raises runner-lock attention (once) for a run locked by a non-runner, instead of skipping silently", async () => {
    const { base, runsDir } = home();
    const runDir = join(runsDir, "wedged");
    new EventLog(join(runDir, "run.jsonl")).append({ type: "run-started", graph: "write-doc", inputs: { goal: "g", work: "w" }, pinned_prompts: {} });
    const bystander = Bun.spawn(["bun", "-e", "setInterval(()=>{},1e9)"]);
    try {
      await Bun.sleep(200);
      writeFileSync(join(runDir, "runner.pid"), String(bystander.pid));
      await cli(base, "up", "--once");
      await cli(base, "up", "--once");
      const pending = new AttentionCenter(join(base, "attention"), []).pending();
      expect(pending).toEqual([expect.objectContaining({ run: "wedged", node: "runner-lock", reason: expect.stringContaining("resume wedged --force") })]);
      expect(bystander.exitCode).toBeNull();
    } finally {
      bystander.kill(9);
      await bystander.exited;
    }
  }, 30000);
});
