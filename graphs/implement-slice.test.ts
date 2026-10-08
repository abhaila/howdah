/**
 * implement-slice + the shared delivery half (system-map 1c, T12):
 *   - both graphs validate; implement-ticket's structure is pinned exactly as it was before
 *     deliveryGraph() was extracted (its behaviour tests live, unchanged, in implement-ticket.test.ts);
 *   - verifyAfterRepair wiring: every code-changing repair is re-extracted and drift-checked
 *     before review or publish;
 *   - a CI fix that breaks a ghost surfaces as drift BEFORE the next publish (real map built-ins
 *     over the fixture repo, scripted in-process agents);
 *   - validateProposal refuses a ghost set that does not fit the base, or an ignored expected_file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { implementTicket } from "./implement-ticket";
import { implementSlice, validateSliceProposal } from "./implement-slice";
import { CODE_CHANGING_REPAIRS, deliveryGraph, type PrState } from "./delivery";
import { GRAPHS } from "./index";
import { Engine, resolveAgentConfig, type AttemptResult, type Executor } from "../engine/run";
import { approvalExecutor } from "../engine/executors/approval";
import { commandExecutor } from "../engine/executors/worktree";
import { approve, pinComment, redesign, sendFeedback } from "../engine/control";
import { reconstructRender } from "../prompts/library";
import type { LoggedEvent } from "../log/events";
import { EventLog } from "../log/write";
import type { SliceDrift } from "../engine/slice-map";
import type { BaseSnapshot } from "../engine/slice-decision";
import {
  sliceRepo, applyEdits, commitAll, implementedV2, GHOSTS_V1, GHOSTS_V2, API_TS, DELETE_USER_TS, DELETE_ROUTE, DELETE_FETCH, SLICE_GOAL, SLICE_WORK,
} from "./slice-fixture";

const PROMPTS = join(dirname(import.meta.dir), "prompts");

// the map store is $HOWDAH_HOME/maps for both the built-ins and validateProposal: each run
// points HOWDAH_HOME at its own temp dir, restored after every test
const ORIGINAL_HOME = process.env.HOWDAH_HOME;
afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOWDAH_HOME;
  else process.env.HOWDAH_HOME = ORIGINAL_HOME;
});
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const ok = (writes: Record<string, unknown> = {}): AttemptResult => ({ status: "succeeded", writes });

const edgeList = (edges: ReadonlyArray<{ from: string; to: string; condition?: { label: string; reads: string[] }; weight?: number }>) =>
  edges.map((e) => `${e.from} -> ${e.to}${e.condition ? ` [${e.condition.label}] reads=${e.condition.reads.join(",")}` : ""}${e.weight !== undefined ? ` w=${e.weight}` : ""}`);

describe("graphs validate", () => {
  test("implement-slice is registered and passes structure + the MUST-analysis", () => {
    expect(GRAPHS["implement-slice"]).toBe(implementSlice);
    expect(implementSlice.validate()).toEqual({ structural: [], paths: [] });
    expect(implementTicket.validate()).toEqual({ structural: [], paths: [] });
  });

  test("slice.propose resolves read-only even when the run asks for bypassPermissions", () => {
    const def = implementSlice.def.nodes["slice.propose"];
    if (def?.kind !== "agent") throw new Error("slice.propose must be an agent node");
    expect(resolveAgentConfig(implementSlice, def, "slice.propose", { overrides: { permissionMode: "bypassPermissions" } }).permissionMode).toBe("plan");
  });

  test("the approval node owns the decision and redesigns into map.extract, which must not declare the feedback key", () => {
    const writes = implementSlice.writesOf("map.extract");
    expect(writes["slice.feedback"]?.scope).toBe("sticky"); // engine-owned
    const extract = implementSlice.def.nodes["map.extract"];
    expect(extract?.kind === "command" && extract.writes && "slice.feedback" in extract.writes).toBe(false);
  });
});

describe("deliveryGraph extraction keeps implement-ticket identical", () => {
  test("implement-ticket's definition hashes exactly as it did before the extraction", () => {
    const d = implementTicket.def;
    const s = JSON.stringify({ name: d.name, description: d.description, defaults: d.defaults, entry: d.entry, inputs: d.inputs, nodes: d.nodes, edges: edgeList(d.edges) });
    // Captured from the pre-extraction graphs/implement-ticket.ts: the rebased T5 commit
    // "fix(engine): Bound review loops and let a jump restart visit budgets" (7c590df on
    // rebase/sprint-0) — upstream implement-ticket as of origin/main 6a31486 (f8c8d96's
    // probe_pr/repair reads, CHANGES_REQUIRED before CI_FAILED, revise_repairs → publish)
    // plus our maxVisits, and untouched by the commits between it and this extraction.
    // Computed by running exactly this serialisation over `git show 7c590df:graphs/
    // implement-ticket.ts` (the same method reproduces the pre-rebase pin e1ae0a30… from
    // the original c506e2b).
    expect(createHash("sha256").update(s).digest("hex")).toBe("896c8c4258519541ffce4cf4e5590d7e04d22ff7121d7484ef50bdba258eb3ce");
  });

  test("verifyAfterRepair: false is the plain half; true only reroutes repairs and swaps in design-aware prompts", () => {
    const plain = deliveryGraph({ verifyAfterRepair: false });
    const verified = deliveryGraph({ verifyAfterRepair: true });
    expect(Object.keys(verified.nodes).sort()).toEqual(
      [...Object.keys(plain.nodes), "delivery.drift", "delivery.reextract", "delivery.drift_revision", "delivery.reextract_revision"].sort(),
    );
    for (const id of [...CODE_CHANGING_REPAIRS, "delivery.review_repairs"]) {
      const n = verified.nodes[id];
      expect(n?.kind === "agent" && n.prompt.startsWith("slice.")).toBe(true);
      expect(n?.kind === "agent" && n.reads).toEqual(expect.arrayContaining(["slice.ghosts", "slice.drift"]));
    }
    // unchanged elsewhere: publish, probe, wait, completion and cleanup are the plain nodes
    for (const id of ["delivery.publish", "delivery.probe_pr", "delivery.wait", "complete_ticket", "cleanup_merged", "cleanup_closed"])
      expect(verified.nodes[id]).toEqual(plain.nodes[id] as never);
  });

  test("with verifyAfterRepair every code-changing repair goes through reextract → drift, never straight to review or publish", () => {
    const { edges, nodes } = deliveryGraph({ verifyAfterRepair: true });
    for (const repair of CODE_CHANGING_REPAIRS)
      expect(edges.filter((e) => e.from === repair).map((e) => e.to)).toEqual([
        repair === "delivery.revise_repairs" ? "delivery.reextract_revision" : "delivery.reextract",
      ]);
    expect(edges.filter((e) => e.from === "delivery.reextract").map((e) => e.to)).toEqual(["delivery.drift"]);
    expect(edgeList(edges.filter((e) => e.from === "delivery.drift"))).toEqual([
      "delivery.drift -> delivery.revise_repairs [slice.drift has new problems (missing / changed-unexpectedly / still-present / unchanged)] reads=slice.drift w=1",
      "delivery.drift -> delivery.review_repairs",
    ]);
    for (const id of ["delivery.drift", "delivery.drift_revision"]) {
      const drift = nodes[id];
      expect(drift?.kind === "command" && drift.run).toBe("map:drift --since delivery.publish");
    }
  });

  // f8c8d96 made the plain half publish a revision instead of re-reviewing it; the verified
  // half does the same once the map check passes, and revises again if the revision broke the design.
  test("a verified revision is re-extracted, drift-checked and then PUBLISHED (the plain half's revise → publish)", () => {
    const plain = deliveryGraph({ verifyAfterRepair: false });
    expect(edgeList(plain.edges.filter((e) => e.from === "delivery.revise_repairs"))).toEqual(["delivery.revise_repairs -> delivery.publish"]);
    const { edges } = deliveryGraph({ verifyAfterRepair: true });
    expect(edges.filter((e) => e.from === "delivery.reextract_revision").map((e) => e.to)).toEqual(["delivery.drift_revision"]);
    expect(edgeList(edges.filter((e) => e.from === "delivery.drift_revision"))).toEqual([
      "delivery.drift_revision -> delivery.revise_repairs [slice.drift has new problems (missing / changed-unexpectedly / still-present / unchanged)] reads=slice.drift w=1",
      "delivery.drift_revision -> delivery.publish",
    ]);
  });

  test("the review-aware repairs read the previous review in both halves (their delivery prompts do)", () => {
    for (const verifyAfterRepair of [false, true] as const) {
      const { nodes } = verifyAfterRepair ? deliveryGraph({ verifyAfterRepair }) : deliveryGraph({ verifyAfterRepair });
      for (const id of ["delivery.address_reviews", "delivery.fix_ci"]) {
        const n = nodes[id];
        expect(n?.kind === "agent" && n.reads).toEqual(expect.arrayContaining(["review_verdict", "review_findings"]));
      }
      const probe = nodes["delivery.probe_pr"];
      expect(probe?.kind === "command" && probe.reads).toEqual(["publication_summary"]);
    }
  });
});

// ---- a scripted run over the real map built-ins -------------------------------------------

interface Script {
  /** pr.state per probe, in order (last repeats); null = no PR found (the probe throws → park) */
  pr: Array<PrState | null>;
  /** what each agent node does, by node id: writes, and optionally file edits in the repo */
  agents: Record<string, (visit: number, repo: string) => Record<string, unknown>>;
  /** proposals, in order (last repeats) */
  proposals?: unknown[];
  /** runs when create_worktree does (the stub worktree is the repo itself) */
  onCreate?: (repo: string) => void;
  /** runs inside every slice.propose attempt (e.g. a proposer that moves the worktree) */
  onPropose?: (repo: string, visit: number) => void;
  /** the map object store the built-ins write to, relative to the run's HOWDAH_HOME (default: maps) */
  storeDir?: string;
}

function sliceRun(script: Script) {
  const { dir: repo } = sliceRepo();
  const home = tmp("howdah-slice-home-");
  process.env.HOWDAH_HOME = home;
  const runDir = join(home, "runs", "slice-run");
  const prs = [...script.pr];
  const proposals = [...(script.proposals ?? [GHOSTS_V2])];
  const prompts: Array<{ node: string; visit: number; prompt: string }> = [];
  const agent: Executor = async ({ nodeId, visit, renderedPrompt }) => {
    prompts.push({ node: nodeId, visit, prompt: renderedPrompt ?? "" });
    if (nodeId === "slice.propose") {
      script.onPropose?.(repo, visit);
      return ok({ "slice.ghosts": proposals.length > 1 ? proposals.shift() : proposals[0] });
    }
    const act = script.agents[nodeId];
    if (!act) throw new Error(`unscripted agent node ${nodeId}`);
    return ok(act(visit, repo));
  };
  const command = commandExecutor({
    map: { workers: 0, ...(script.storeDir !== undefined ? { storeDir: join(home, script.storeDir) } : {}) },
    prProbe: () => {
      const state = prs.length > 1 ? prs.shift() : prs[0];
      return state === null || state === undefined ? null : { state, url: "https://example.test/pr/1" };
    },
  });
  const worktree: Executor = async ({ nodeId }) => {
    if (nodeId === "create_worktree") script.onCreate?.(repo);
    return ok(nodeId.startsWith("cleanup") ? { "worktree.clean": true } : {});
  };
  const engine = () =>
    new Engine(implementSlice, { dir: runDir, cwd: repo, folderKind: "repo", promptsDir: PROMPTS, executors: { agent, command, worktree, approval: approvalExecutor, wait: async () => ok() } });
  return { repo, home, runDir, engine, prompts, events: () => engine().log.read() };
}

const byType = <T extends LoggedEvent["type"]>(events: LoggedEvent[], type: T) => events.filter((e): e is Extract<LoggedEvent, { type: T }> => e.type === type);
const started = (events: LoggedEvent[]) => events.flatMap((e) => (e.type === "node-started" ? [e.node] : []));

describe("verifyAfterRepair: a CI fix that breaks a ghost surfaces drift before publish", () => {
  test("fix_ci deletes a designed function → drift says missing → revise_repairs restores it → published only once the design holds", async () => {
    const full = { value: [] as Array<{ path: string; content: string }> };
    const run = sliceRun({
      pr: ["CI_FAILED", "MERGED"],
      agents: {
        "implementation.implement": (_v, repo) => {
          full.value = implementedV2(repo);
          applyEdits(repo, full.value);
          commitAll(repo, "implement v2");
          return { implementation_summary: "built v2" };
        },
        "implementation.local_review": () => ({ review_verdict: "pass", review_findings: [] }),
        "delivery.publish": () => ({ publication_summary: "PR #1" }),
        // the "CI fix" drops the web half — the build goes green, the design breaks
        "delivery.fix_ci": (_v, repo) => {
          writeFileSync(join(repo, API_TS), full.value.find((e) => e.path === API_TS)!.content.replace(/\nexport async function deleteUser[\s\S]*$/, "\n"));
          commitAll(repo, "fix ci");
          return { repair_summary: "removed the failing call" };
        },
        "delivery.revise_repairs": (_v, repo) => {
          applyEdits(repo, full.value);
          commitAll(repo, "restore the designed call");
          return { repair_summary: "restored deleteUser" };
        },
        "delivery.review_repairs": () => ({ review_verdict: "pass", review_findings: [] }),
        complete_ticket: () => ({ completion_summary: "done" }),
      },
    });

    expect(await run.engine().start({ goal: SLICE_GOAL, work: SLICE_WORK })).toMatchObject({ state: "parked", node: "slice.approve", code: "awaiting-approval" });
    expect(approve(run.runDir)).toMatchObject({ ok: true });
    expect(await run.engine().resume()).toEqual({ state: "finished", outcome: "success" });

    const events = run.events();
    const order = started(events);
    const fixAt = order.indexOf("delivery.fix_ci");
    // the revision is verified on its own path and then published (f8c8d96: revise → publish)
    expect(order.slice(fixAt, fixAt + 7)).toEqual([
      "delivery.fix_ci", "delivery.reextract", "delivery.drift", "delivery.revise_repairs",
      "delivery.reextract_revision", "delivery.drift_revision", "delivery.publish",
    ]);

    // the drift after the CI fix — logged BEFORE the next publish started — names the broken ghost
    const drifts = events.filter((e): e is Extract<LoggedEvent, { type: "drift-detected" }> => e.type === "drift-detected");
    expect(drifts.map((d) => d.node)).toEqual(["map.drift", "delivery.drift", "delivery.drift_revision"]);
    const afterFix = drifts[1]!;
    const republish = events.filter((e) => e.type === "node-started" && e.node === "delivery.publish")[1]!;
    expect(afterFix.seq).toBeLessThan(republish.seq);
    expect(afterFix.items.find((i) => i.key === DELETE_USER_TS && i.op === "add")?.outcome).toBe("missing");
    const fixDrift = events.find((e) => e.type === "node-finished" && e.node === "delivery.drift")!;
    expect((fixDrift.type === "node-finished" && (fixDrift.writes["slice.drift"] as SliceDrift).new_problems)).toContain(`missing ${DELETE_USER_TS}`);
    expect(events.some((e) => e.type === "edge-taken" && e.from === "delivery.drift" && e.to === "delivery.revise_repairs")).toBe(true);

    // the implementation-phase drift and the final repair drift both verify the design
    for (const d of [drifts[0]!, drifts[2]!]) expect(d.counts.missing + d.counts["changed-unexpectedly"] + d.counts["still-present"]).toBe(0);

    // the repair agents saw the design and the drift
    const revise = run.prompts.find((p) => p.node === "delivery.revise_repairs")!.prompt;
    expect(revise).toContain(DELETE_USER_TS);
    expect(revise).toContain(`missing ${DELETE_USER_TS}`);
  });

  test("a repair that keeps breaking the design parks on revise_repairs' maxVisits instead of publishing", async () => {
    const run = sliceRun({
      pr: ["CI_FAILED"],
      agents: {
        "implementation.implement": (_v, repo) => (applyEdits(repo, implementedV2(repo)), { implementation_summary: "built" }),
        "implementation.local_review": () => ({ review_verdict: "pass", review_findings: [] }),
        "delivery.publish": () => ({ publication_summary: "PR #1" }),
        "delivery.fix_ci": (_v, repo) => {
          writeFileSync(join(repo, API_TS), "export interface User {\n  id: string;\n}\n");
          return { repair_summary: "gutted api.ts" };
        },
        "delivery.revise_repairs": () => ({ repair_summary: "did nothing useful" }),
      },
    });
    await run.engine().start({ goal: SLICE_GOAL, work: SLICE_WORK });
    approve(run.runDir);
    const result = await run.engine().resume();
    expect(result).toMatchObject({ state: "parked", node: "delivery.revise_repairs", code: "max-visits" });
    const publishes = run.events().filter((e) => e.type === "node-started" && e.node === "delivery.publish");
    expect(publishes.length).toBe(1); // never republished with the design broken
  });
});

describe("map.extract failures park the run", () => {
  test("an unfingerprintable worktree (FingerprintError) parks map.extract attempt-failed — no base, no proposal", async () => {
    const secret = (repo: string) => join(repo, "web", "src", "secret.ts");
    // the run starts on a readable tree; the file turns unreadable before map.extract runs
    const run = sliceRun({ pr: ["OPEN"], agents: {}, onCreate: (repo) => (writeFileSync(secret(repo), "export const s = 1;\n"), chmodSync(secret(repo), 0o000)) });
    try {
      const result = await run.engine().start({ goal: SLICE_GOAL, work: SLICE_WORK });
      expect(result).toMatchObject({ state: "parked", node: "map.extract", code: "attempt-failed" });
      expect((result as { reason: string }).reason).toContain("cannot fingerprint the worktree");
      expect(run.events().some((e) => e.type === "map-extracted" || e.type === "ghost-proposed")).toBe(false);
    } finally {
      chmodSync(secret(run.repo), 0o644);
    }
  });
});

describe("validateProposal (GhostSet against the base the proposal was drawn on)", () => {
  test("a proposal with an unknown existing id is refused: the proposer attempt fails and the run parks with the errors", async () => {
    const bad = { ...GHOSTS_V1, entities: [{ id: "com.example.api.<top>.nope(Request)", op: "modify", block: ":api/com.example.api", kind: "function", expected_file: "api/src/main/kotlin/com/example/api/App.kt" }] };
    const run = sliceRun({ pr: ["OPEN"], agents: {}, proposals: [bad] });
    const result = await run.engine().start({ goal: SLICE_GOAL, work: SLICE_WORK });
    expect(result).toMatchObject({ state: "parked", node: "slice.propose", code: "attempt-failed" });
    expect((result as { reason: string }).reason).toContain("needs an entity that exists in the base snapshot");
    expect(run.events().some((e) => e.type === "ghost-proposed")).toBe(false);
  });

  test("the refusal reaches the proposer's retry (suffix v3), exactly once, and the retried render reconstructs verified", async () => {
    const bad = { ...GHOSTS_V1, entities: [{ id: "com.example.api.<top>.nope(Request)", op: "modify", block: ":api/com.example.api", kind: "function", expected_file: "api/src/main/kotlin/com/example/api/App.kt" }] };
    const run = sliceRun({ pr: ["OPEN"], agents: {}, proposals: [bad, GHOSTS_V1, GHOSTS_V2] });
    expect(await run.engine().start({ goal: SLICE_GOAL, work: SLICE_WORK })).toMatchObject({ state: "parked", node: "slice.propose", code: "attempt-failed" });
    const refusedFinish = run.events().find((e) => e.type === "node-finished" && e.node === "slice.propose")!;
    expect(refusedFinish).toMatchObject({ status: "failed", refused: expect.stringContaining("needs an entity that exists in the base snapshot") });

    // the retry is told why
    expect(await run.engine().resume()).toMatchObject({ state: "parked", node: "slice.approve", code: "awaiting-approval" });
    const retry = run.prompts.filter((p) => p.node === "slice.propose")[1]!.prompt;
    expect(retry).toContain("## Your previous proposal was refused");
    expect(retry).toContain("com.example.api.<top>.nope(Request)");
    const retryRender = run.events().filter((e) => e.type === "prompt-rendered" && e.node === "slice.propose")[1]!;
    if (retryRender.type !== "prompt-rendered") throw new Error("no render");
    expect(retryRender.suffix_version).toBe(4);
    expect(reconstructRender(run.runDir, retryRender.rendered_hash)).toMatchObject({ verified: true, text: retry });

    // ...once: the redraw after operator feedback does not repeat it
    pinComment(run.runDir, DELETE_ROUTE, "add the web half");
    sendFeedback(run.runDir);
    await run.engine().resume();
    const third = run.prompts.filter((p) => p.node === "slice.propose")[2]!.prompt;
    expect(third).toContain("add the web half");
    expect(third).not.toContain("## Your previous proposal was refused");
  });

  test("an expected_file git ignores is refused up front (never extracted, so never verifiable)", async () => {
    const { dir } = sliceRepo();
    writeFileSync(join(dir, ".gitignore"), "web/src/local/\n");
    commitAll(dir, "ignore local");
    const home = tmp("howdah-slice-validate-");
    process.env.HOWDAH_HOME = home;
    const runDir = join(home, "runs", "r");
    // extract a base the way map.extract does, then validate against it
    const extracted = await commandExecutor({ map: { workers: 0 } })({
      nodeId: "map.extract",
      def: implementSlice.def.nodes["map.extract"]!,
      visit: 1, attemptId: "x", cwd: dir, runId: "r",
      log: new EventLog(join(runDir, "run.jsonl")),
      reads: { goal: SLICE_GOAL, work: SLICE_WORK },
      effects: { claim: () => false, done: () => {} },
    });
    const base = extracted.writes["map.base"];
    const ignored = { ...GHOSTS_V2, entities: [...GHOSTS_V2.entities, { id: "web/src/local/x#helper", op: "add", block: "web", kind: "function", expected_file: "web/src/local/x.ts" }] };
    const refusal = validateSliceProposal(ignored, { dir: runDir, base, cwd: dir });
    expect(refusal).toContain('expected_file "web/src/local/x.ts" is ignored by git');
  });
});

// ---- every implement-slice edge over the real map built-ins (1c review item 4) ------------------

const START = { goal: SLICE_GOAL, work: SLICE_WORK };
const AWAITING = { state: "parked", node: "slice.approve", code: "awaiting-approval" } as const;
const finishesOf = (events: LoggedEvent[], node: string) =>
  events.filter((e): e is Extract<LoggedEvent, { type: "node-finished" }> => e.type === "node-finished" && e.node === node);
const edgesTaken = (events: LoggedEvent[]) => events.flatMap((e) => (e.type === "edge-taken" ? [`${e.from} -> ${e.to}`] : []));
const touch = (repo: string, note: string) => writeFileSync(join(repo, "README.md"), readFileSync(join(repo, "README.md"), "utf8") + `\n${note}\n`);

describe("approve → map.extract on stale", () => {
  test("the tree moved after the proposal: stale re-extracts, re-seeds slice.drift / review_findings, and redraws", async () => {
    const run = sliceRun({ pr: ["OPEN"], agents: {}, proposals: [GHOSTS_V2] });
    expect(await run.engine().start(START)).toMatchObject(AWAITING);
    touch(run.repo, "a teammate edit"); // tracked change after the proposal
    expect(await run.engine().resume()).toMatchObject(AWAITING);

    const events = run.events();
    expect(started(events)).toEqual(["create_worktree", "map.extract", "slice.propose", "slice.approve", "slice.approve", "map.extract", "slice.propose", "slice.approve"]);
    expect(edgesTaken(events)).toContain("slice.approve -> map.extract");
    const approval = finishesOf(events, "slice.approve")[0]!.writes["slice.approval"] as { outcome: string; reason: string };
    expect(approval).toMatchObject({ outcome: "stale", reason: expect.stringContaining("worktree changed since slice.propose proposed") });
    const [first, second] = finishesOf(events, "map.extract");
    expect(second!.writes).toMatchObject({ "slice.drift": [], review_findings: null });
    // README.md is not source: same manifest, but a new fingerprint — the new round binds to it
    const base2 = second!.writes["map.base"] as BaseSnapshot;
    expect(base2.fingerprint).not.toEqual((first!.writes["map.base"] as BaseSnapshot).fingerprint);
    expect(byType(events, "ghost-proposed").at(-1)).toMatchObject({ manifest_hash: base2.manifest_hash, fingerprint: base2.fingerprint });
  });

  test("a base that keeps moving parks map.extract on maxVisits 5 instead of looping", async () => {
    // a proposer that edits the checkout every time: each round is stale before anyone decides
    const run = sliceRun({ pr: ["OPEN"], agents: {}, proposals: [GHOSTS_V2], onPropose: (repo, visit) => touch(repo, `propose ${visit}`) });
    const result = await run.engine().start(START);
    expect(result).toMatchObject({ state: "parked", node: "map.extract", code: "max-visits" });
    expect(started(run.events()).filter((n) => n === "map.extract")).toHaveLength(5);
    const reasons = finishesOf(run.events(), "slice.approve").map((f) => (f.writes["slice.approval"] as { reason: string }).reason);
    expect(reasons.every((r) => r.includes("worktree changed during slice.propose"))).toBe(true);
  });
});

describe("local_review → implement on reject", () => {
  test("the re-entry passes the requires gate although implement moved the tree, and sees the drift and the findings", async () => {
    const run = sliceRun({
      pr: ["MERGED"],
      agents: {
        "implementation.implement": (visit, repo) => {
          const [app, api] = implementedV2(repo);
          applyEdits(repo, visit === 1 ? [app!] : [api!]); // the web half only on the second attempt
          commitAll(repo, `implement ${visit}`);
          return { implementation_summary: `attempt ${visit}` };
        },
        "implementation.local_review": (visit) =>
          visit === 1 ? { review_verdict: "reject", review_findings: ["the web deleteUser call is missing"] } : { review_verdict: "pass", review_findings: [] },
        "delivery.publish": () => ({ publication_summary: "PR" }),
        complete_ticket: () => ({ completion_summary: "done" }),
      },
    });
    expect(await run.engine().start(START)).toMatchObject(AWAITING);
    approve(run.runDir);
    expect(await run.engine().resume()).toEqual({ state: "finished", outcome: "success" });

    const events = run.events();
    expect(started(events).filter((n) => n === "implementation.implement")).toHaveLength(2);
    expect(events.some((e) => e.type === "attention-raised")).toBe(true); // only the awaiting-approval park
    expect(events.filter((e) => e.type === "attention-raised").map((e) => e.type === "attention-raised" && e.code)).toEqual(["awaiting-approval"]);
    const second = run.prompts.filter((p) => p.node === "implementation.implement")[1]!.prompt;
    expect(second).toContain(`"outcome":"missing"`);
    expect(second).toContain(`"key":"${DELETE_USER_TS}"`);
    expect(second).toContain("the web deleteUser call is missing");
    const drifts = events.filter((e): e is Extract<LoggedEvent, { type: "drift-detected" }> => e.type === "drift-detected");
    expect(drifts.map((d) => d.counts.missing > 0)).toEqual([true, false]);
  });
});

describe("resolve_conflicts and address_reviews are re-verified too", () => {
  test("both repairs route through delivery.reextract → delivery.drift before review_repairs", async () => {
    const run = sliceRun({
      pr: ["CONFLICTS", "CHANGES_REQUIRED", "MERGED"],
      agents: {
        "implementation.implement": (_v, repo) => (applyEdits(repo, implementedV2(repo)), commitAll(repo, "implement"), { implementation_summary: "built" }),
        "implementation.local_review": () => ({ review_verdict: "pass", review_findings: [] }),
        "delivery.publish": () => ({ publication_summary: "PR" }),
        "delivery.resolve_conflicts": (_v, repo) => (touch(repo, "rebased"), commitAll(repo, "rebase"), { repair_summary: "rebased" }),
        "delivery.address_reviews": (_v, repo) => (touch(repo, "addressed"), commitAll(repo, "review"), { repair_summary: "addressed" }),
        "delivery.review_repairs": () => ({ review_verdict: "pass", review_findings: [] }),
        complete_ticket: () => ({ completion_summary: "done" }),
      },
    });
    await run.engine().start(START);
    approve(run.runDir);
    expect(await run.engine().resume()).toEqual({ state: "finished", outcome: "success" });
    const taken = edgesTaken(run.events());
    for (const repair of ["delivery.resolve_conflicts", "delivery.address_reviews"]) {
      expect(taken).toContain(`${repair} -> delivery.reextract`);
      expect(taken).not.toContain(`${repair} -> delivery.review_repairs`);
    }
    expect(taken.filter((t) => t === "delivery.drift -> delivery.review_repairs")).toHaveLength(2);
  });
});

describe("redesign during delivery, then the --since baseline", () => {
  test("after a redesign, a repair is judged against the drift the LATEST publish had, not the first one", async () => {
    // round 2 keeps the backend (built in round 1) and adds the web half
    const V3 = {
      blocks: [],
      entities: [
        { id: DELETE_ROUTE, op: "keep", block: ":api/com.example.api", kind: "route", expected_file: "api/src/main/kotlin/com/example/api/App.kt" },
        GHOSTS_V2.entities.find((e) => e.id === DELETE_USER_TS)!,
        GHOSTS_V2.entities.find((e) => e.id === DELETE_FETCH)!,
      ],
      edges: [{ from: DELETE_FETCH, to: DELETE_ROUTE, kind: "fe-be", op: "add" }],
      trace: [],
    };
    const run = sliceRun({
      pr: [null, "CI_FAILED", "MERGED"],
      proposals: [GHOSTS_V1, V3],
      agents: {
        "implementation.implement": (visit, repo) => {
          const [app] = implementedV2(repo);
          if (visit === 1) applyEdits(repo, [app!]);
          // round 2 builds deleteUser WITHOUT its fetch: the fetch-site ghost stays missing
          else writeFileSync(join(repo, API_TS), readFileSync(join(repo, API_TS), "utf8") + "\nexport async function deleteUser(id: string): Promise<void> {\n  void id;\n}\n");
          commitAll(repo, `implement ${visit}`);
          return { implementation_summary: `round ${visit}` };
        },
        "implementation.local_review": () => ({ review_verdict: "pass", review_findings: [] }),
        "delivery.publish": () => ({ publication_summary: "PR" }),
        "delivery.fix_ci": (_v, repo) => (touch(repo, "ci"), commitAll(repo, "fix ci"), { repair_summary: "fixed ci" }),
        "delivery.review_repairs": () => ({ review_verdict: "pass", review_findings: [] }),
        complete_ticket: () => ({ completion_summary: "done" }),
      },
    });
    expect(await run.engine().start(START)).toMatchObject(AWAITING);
    approve(run.runDir);
    // round 1 publishes, then the PR probe fails: the run parks inside delivery
    expect(await run.engine().resume()).toMatchObject({ state: "parked", node: "delivery.probe_pr", code: "executor-threw" });

    expect(redesign(run.runDir, "add the web client call in `web/src/api.ts`", { graphs: GRAPHS })).toMatchObject({ ok: true, jumped_to: "map.extract" });
    expect(await run.engine().resume()).toMatchObject(AWAITING);
    expect(byType(run.events(), "ghost-proposed").at(-1)?.proposal).toEqual(V3);
    approve(run.runDir);
    expect(await run.engine().resume()).toEqual({ state: "finished", outcome: "success" });

    const events = run.events();
    const drifts = byType(events, "drift-detected");
    // round 2's pre-publish drift has the fetch-site problem; round 1's never did (V1 had no such ghost)
    const [round1, round2, repair] = drifts;
    expect(round1!.items.some((i) => i.key === DELETE_FETCH)).toBe(false);
    expect(round2!.items.find((i) => i.key === DELETE_FETCH && i.op === "add")?.outcome).toBe("missing");
    expect(repair!.node).toBe("delivery.drift");
    const repairDrift = finishesOf(events, "delivery.drift")[0]!.writes["slice.drift"] as SliceDrift;
    expect(repairDrift.problems).toContain(`missing ${DELETE_FETCH}`);
    expect(repairDrift.new_problems).toEqual([]); // already there when publish #2 started: not the repair's fault
    expect(edgesTaken(events)).toContain("delivery.drift -> delivery.review_repairs");
    expect(edgesTaken(events)).not.toContain("delivery.drift -> delivery.revise_repairs");
  });
});

describe("validateProposal honours the configured map store", () => {
  test("a run whose built-ins write to their own store validates against it (recorded on map-extracted)", async () => {
    const run = sliceRun({ pr: ["OPEN"], agents: {}, storeDir: "own-store" });
    expect(await run.engine().start(START)).toMatchObject(AWAITING); // the default store is empty: this only passes through the recorded one
    expect(byType(run.events(), "map-extracted")[0]!.store).toEndWith("/own-store");
  });
});

describe("an implementation that is not committed verifies nothing", () => {
  test("implement leaves its edits uncommitted: drift is stamped '+ uncommitted changes' and reports no verified item", async () => {
    const run = sliceRun({
      pr: ["MERGED"],
      agents: {
        "implementation.implement": (_v, repo) => (applyEdits(repo, implementedV2(repo)), { implementation_summary: "built, not committed" }),
        "implementation.local_review": () => ({ review_verdict: "pass", review_findings: [] }),
        "delivery.publish": () => ({ publication_summary: "PR" }),
        complete_ticket: () => ({ completion_summary: "done" }),
      },
    });
    await run.engine().start(START);
    approve(run.runDir);
    await run.engine().resume();
    const [drift] = byType(run.events(), "drift-detected");
    expect(drift).toMatchObject({ dirty: true, stamp: expect.stringContaining("+ uncommitted changes") });
    expect(drift!.counts.verified).toBe(0);
    for (const g of GHOSTS_V2.entities) expect(drift!.items.find((i) => i.key === g.id && i.op !== null)?.outcome).toBe("not-checked");
    const after = finishesOf(run.events(), "map.reextract")[0]!.writes["map.after"] as { dirty: boolean };
    expect(after.dirty).toBe(true);
  });
});
