/**
 * implement-stacked (HOW-57 S6). Three things are pinned:
 *   - NO SILENT DRIFT (5A + G3): it is `stackedFrom(implement-ticket)`, so every implement-ticket
 *     node is in it and every implement-ticket edge is in it or named in REWIRED_EDGES — and
 *     REWIRED_EDGES names only edges that exist;
 *   - ROUTE ORDER (G4): the restack route outranks every repair, CONFLICTS included;
 *   - THE STACKED BRIEFING (G8) reaches every agent step and reconstructs VERIFIED.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { implementStacked, REWIRED_EDGES, spec, stackedFrom } from "./implement-stacked";
import { implementTicket, spec as ticketSpec } from "./implement-ticket";
import { GRAPHS } from "./index";
import { defineGraph } from "../core/graph";
import { Engine, type AttemptResult } from "../engine/run";
import { reconstructRender } from "../prompts/library";

const edgeKey = (e: { from: string; to: string; condition?: { label: string } }) => `${e.from} → ${e.to}${e.condition ? ` [${e.condition.label}]` : ""}`;

describe("implement-stacked is implement-ticket, stacked — never a silent fork", () => {
  test("it is registered and validates", () => {
    expect(GRAPHS["implement-stacked"]).toBe(implementStacked);
    expect(implementStacked.validate()).toEqual({ structural: [], paths: [] });
  });

  test("every implement-ticket node is present, as the same kind", () => {
    for (const [id, node] of Object.entries(implementTicket.def.nodes)) {
      const mine = implementStacked.def.nodes[id];
      expect(mine?.kind, id).toBe(node.kind);
    }
  });

  test("every implement-ticket edge is present, or named in REWIRED_EDGES", () => {
    const mine = new Set(implementStacked.def.edges.map(edgeKey));
    const missing = implementTicket.def.edges
      .filter((e) => !mine.has(edgeKey(e)))
      .filter((e) => !REWIRED_EDGES.some((r) => r.from === e.from && r.to === e.to));
    expect(missing.map(edgeKey)).toEqual([]);
  });

  test("REWIRED_EDGES names only edges implement-ticket has, and none of them survives verbatim", () => {
    const theirs = implementTicket.def.edges;
    for (const r of REWIRED_EDGES) {
      expect(theirs.some((e) => e.from === r.from && e.to === r.to), `${r.from} → ${r.to}`).toBe(true);
      expect(implementStacked.def.edges.some((e) => e.from === r.from && e.to === r.to), `${r.from} → ${r.to}`).toBe(false);
    }
  });

  test("stackedFrom is pure: implement-ticket's spec is untouched, and the transform is repeatable", () => {
    const before = JSON.stringify(ticketSpec);
    expect(stackedFrom(ticketSpec)).toEqual(spec);
    expect(JSON.stringify(ticketSpec)).toBe(before);
  });

  test("a spec missing a step the transform stacks onto is refused by name", () => {
    expect(() => stackedFrom({ ...ticketSpec, nodes: ticketSpec.nodes.filter((n) => n.id !== "delivery.wait") })).toThrow('has no "delivery.wait" step');
  });

  test("the run starts by waiting, and only a ready answer reaches the worktree", () => {
    const d = implementStacked.def;
    expect(d.entry).toBe("deps.await");
    expect(d.inputs).toEqual(["goal", "work", "deps"]);
    expect(d.nodes["deps.wait"]).toEqual({ kind: "wait", duration: "5m", backoff: ["15m", "30m"], class: "deps" });
    const out = d.edges.filter((e) => e.from === "deps.await").map(edgeKey);
    expect(out).toEqual(["deps.await → create_worktree [deps.ready == true]", "deps.await → deps.wait"]);
    expect(d.nodes.create_worktree).toMatchObject({ kind: "worktree", reads: ["deps.base", "deps.base_tip"] });
  });

  test("publish is stacked.publish, and probe_pr ignores dependency PRs and reports approval", () => {
    const d = implementStacked.def;
    expect(d.nodes["delivery.publish"]).toMatchObject({ prompt: "stacked.publish", requiresAcceptance: true, maxVisits: 5 });
    expect((d.nodes["delivery.publish"] as { reads: string[] }).reads).toEqual(expect.arrayContaining(["deps.base", "deps.prs"]));
    expect((d.nodes["delivery.probe_pr"] as { reads: string[] }).reads).toContain("deps.prs");
    expect(Object.keys((d.nodes["delivery.probe_pr"] as { writes: object }).writes)).toEqual(["pr.state", "pr.review_activity", "pr.approved"]);
    // HOW-70: the stacked repair is handed the review activity of every PR in the stack too
    expect((d.nodes["delivery.address_reviews"] as { reads: string[] }).reads).toContain("pr.review_activity");
  });

  test("the base is re-read before EVERY PR probe: publish and the wait both go through deps.probe", () => {
    const into = implementStacked.def.edges.filter((e) => e.to === "deps.probe").map((e) => e.from).sort();
    expect(into).toEqual(["delivery.publish", "delivery.wait"]);
    expect(implementStacked.def.edges.filter((e) => e.to === "delivery.probe_pr").map((e) => e.from)).toEqual(["deps.probe"]);
  });
});

describe("G4: route order out of probe_pr — restack first", () => {
  const ranked = () =>
    implementStacked.def.edges
      .filter((e) => e.from === "delivery.probe_pr" && e.condition)
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .map((e) => e.condition!.label);

  test("the restack route outweighs every repair, CONFLICTS included", () => {
    expect(ranked()).toEqual([
      "deps.restack == true",
      "pr.state == 'MERGED'",
      "pr.state == 'CLOSED'",
      "pr.state == 'CONFLICTS'",
      "pr.state == 'CHANGES_REQUIRED'",
      "pr.state == 'CI_FAILED'",
    ]);
  });

  test("the engine's router picks restack when a restack is due and the PR also conflicts", () => {
    const edges = implementStacked.def.edges.filter((e) => e.from === "delivery.probe_pr" && e.condition);
    const values = { "deps.restack": true, "pr.state": "CONFLICTS" } as Record<string, unknown>;
    const best = edges
      .filter((e) => e.condition!.test(Object.fromEntries(e.condition!.reads.map((k) => [k, values[k]])) as never))
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0]!;
    expect(best.to).toBe("delivery.restack");
  });

  test("a restack conflict goes to the agent that is given the --onto command; a clean one waits", () => {
    const out = implementStacked.def.edges.filter((e) => e.from === "delivery.restack").map(edgeKey);
    expect(out).toEqual(["delivery.restack → delivery.resolve_restack [restack.conflict is set]", "delivery.restack → delivery.wait"]);
    expect(implementStacked.def.nodes["delivery.resolve_restack"]).toMatchObject({ prompt: "stacked.resolve_restack", reads: expect.arrayContaining(["restack.conflict"]), maxVisits: 3 });
  });
});

describe("G8: the STACKED briefing (suffix v8)", () => {
  interface C { goal: string; "deps.base": string; "deps.base_tip": string; summary: string }
  const graph = () =>
    defineGraph<C>({
      name: "mini-stacked",
      entry: "stack",
      inputs: ["goal"],
      nodes: {
        stack: { kind: "command", run: "x", writes: { "deps.base": { scope: "sticky" }, "deps.base_tip": { scope: "sticky" } } },
        work: { kind: "agent", prompt: "work" as never, reads: ["goal"], writes: { summary: { scope: "sticky" } } },
        done: { kind: "terminal", outcome: "success" },
      },
      edges: [{ from: "stack", to: "work" }, { from: "work", to: "done" }],
    });
  const run = async (base: string, tip: string) => {
    const prompts = mkdtempSync(join(tmpdir(), "howdah-stacked-p-"));
    writeFileSync(join(prompts, "work.md"), "---\nid: work\nversion: 1\n---\nDo {{ context.goal }}.\n");
    const dir = join(mkdtempSync(join(tmpdir(), "howdah-stacked-")), "run-s");
    const sent: string[] = [];
    const engine = new Engine(graph(), {
      dir, promptsDir: prompts,
      executors: {
        command: async (): Promise<AttemptResult> => ({ status: "succeeded", writes: { "deps.base": base, "deps.base_tip": tip } }),
        agent: async ({ renderedPrompt }): Promise<AttemptResult> => {
          sent.push(renderedPrompt!);
          return { status: "succeeded", writes: { summary: "s" } };
        },
      },
    });
    await engine.start({ goal: "ship" });
    const render = engine.log.read().find((e) => e.type === "prompt-rendered");
    if (render?.type !== "prompt-rendered") throw new Error("no render");
    return { dir, render, sent: sent[0]! };
  };
  const TIP = "0123456789abcdef0123456789abcdef01234567";

  test("an agent step of a stacked run is told its range, logs what it was stacked on, and reconstructs VERIFIED", async () => {
    const { dir, render, sent } = await run("howdah/p--fe-1", TIP);
    expect(sent).toContain("This change is stacked on howdah/p--fe-1@0123456789ab");
    expect(sent).toContain("Your change is `0123456789ab..HEAD`");
    expect(render).toMatchObject({ suffix_version: 10, stacked_on: { branch: "howdah/p--fe-1", sha: TIP } });
    const r = reconstructRender(dir, render.rendered_hash)!;
    expect(r.verified).toBe(true);
    expect(r.text).toBe(sent);
  });

  test("not stacked (an empty base — it merged and was replayed away) renders no briefing", async () => {
    const { render, sent } = await run("", "");
    expect(sent).not.toContain("Stacked change");
    expect(render.stacked_on).toBeUndefined();
  });
});
