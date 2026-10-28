/**
 * B1 (HOW-31, docs/designs/graph-drafting.md): the built-ins are being converted from
 * hand-built `defineGraph` calls to `GraphSpec` literals compiled by `buildGraph`, so every
 * graph in the catalog carries a spec.
 *
 * The conversion is only safe if the compiled `Graph` is INDISTINGUISHABLE from what the
 * hand-written one produced. `fixtures/pre-spec-shapes.json` is `shapeOf` over all eight
 * graphs; the first test here is the regression net for every conversion still to come. A
 * converted graph that changes any observable property fails it.
 *
 * The fixture was REGENERATED once, when `shapeOf` learned that an absent `writes` and an
 * empty one are the same node to the engine (see spec-shape.ts). That is still a faithful
 * pre-conversion snapshot: the graphs already converted at that point were proven identical
 * under the stricter earlier rule, and the rest were untouched, so regenerating from HEAD
 * produced exactly the pre-conversion shapes modulo a normalisation that only widens equality.
 *
 * ONE ENTRY WAS UPDATED DELIBERATELY, 2026-10-12 (HOW-40): implement-ticket gained a
 * `verify.run` step before its local review. That is a behaviour change the ticket asked for,
 * not a conversion, so only the `implement-ticket` entry was rewritten from `shapeOf` — every
 * other graph's entry is byte-identical. HOW-44 (same day) then updated implement-ticket and
 * implement-slice together: create_worktree publishes `worktree.verify_command` and each graph's
 * implement step reads it. The rule still stands for conversions: a diff here that no ticket
 * asked for is a conversion changing behaviour.
 *
 * Each further deliberate change is listed here, and moves only the changed graph's entry, in
 * the SAME commit as the graph edit, with its existing key order kept:
 *   HOW-52  implement-ticket: `implementation.evidence` (evidence:screenshot) runs after
 *           `verify.run`, before every local review, which reads `evidence.items` through the
 *           new `ticket.local_review`.
 *   HOW-51  implement-ticket: `implementation.criteria` opens the acceptance contract,
 *           local_review is read-only and writes `acceptance`, and delivery.publish
 *           `requiresAcceptance`.
 *   HOW-53  implement-ticket, implement-slice, improve-codebase: every review node
 *           (implementation.local_review, delivery.review_repairs) is `readOnly`.
 *   HOW-54  implement-ticket, implement-slice, improve-codebase: the steps that plan or publish
 *           (implementation.plan_review, delivery.publish) declare `changesFiles: false`.
 *   HOW-59  implement-ticket and implement-stacked (through stackedFrom): create_worktree also
 *           publishes `worktree.preview_paths`, and implementation.criteria reads it and
 *           `worktree.verify_command`, so the contract only asks for evidence the run can produce.
 *   HOW-57  plan-feature: the description only — it is now the one way into stacked slices
 *           (implement-stacked is no longer offered in New run), so it says so.
 *   (repair scope) implement-ticket, implement-slice, implement-stacked, improve-codebase:
 *           delivery.review_repairs declares `reviewsWorkOf` (the four code-changing repairs),
 *           so it is briefed to judge the repairs' diff rather than the whole branch again.
 *   HOW-70  implement-ticket, implement-slice, implement-stacked (through stackedFrom),
 *           improve-codebase: delivery.probe_pr also publishes `pr.review_activity` (per-visit),
 *           and delivery.address_reviews reads it — the review comments the probe found new.
 *
 * ONE ENTRY WAS ADDED BY HAND, 2026-10-13 (HOW-57, decision G9): `implement-stacked` is a NEW
 * graph, not a conversion, so it has no pre-conversion shape to be faithful to. Its entry was
 * written from `shapeOf` at the commit that introduced it, inserted in key order, and every
 * existing entry was left byte-identical (the commit's diff of the fixture is insertions only).
 * From here on it is pinned like any other: a change to implement-stacked — including one that
 * arrives through `stackedFrom(implement-ticket)` — moves its entry deliberately or fails here.
 *
 * A SECOND NEW GRAPH, 2026-10-21 (HOW-64, HOW-56 T5): `draft-graph` was born a GraphSpec, so it
 * too was added by hand from `shapeOf`, insertions only, and is pinned like the rest from here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shapeOf, probeValues } from "./spec-shape";
import { GRAPHS } from "./index";
import { buildGraph, parseGraphSpec } from "../core/graph-spec";

type Shape = ReturnType<typeof shapeOf>;
const BEFORE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "pre-spec-shapes.json"), "utf8")) as Record<string, Shape>;

describe("B1: converting a built-in to a GraphSpec changes nothing (HOW-31)", () => {
  test("every graph's compiled shape still matches the pre-conversion snapshot", () => {
    // Fails loudly if a conversion drops a write, moves a scope, renames an edge label or
    // reorders edges — the ways a conversion can look right and route wrong.
    expect(Object.keys(GRAPHS).sort()).toEqual(Object.keys(BEFORE).sort());
    // The name travels INSIDE the compared value so a failure says which graph drifted;
    // bun:test's expect() takes no message argument.
    for (const [name, g] of Object.entries(GRAPHS)) {
      const before = BEFORE[name];
      expect(before).toBeDefined();
      if (!before) continue; // noUncheckedIndexedAccess: the key check above is the assertion
      expect({ [name]: shapeOf(g) }).toEqual({ [name]: before });
    }
  });

  test("every registered graph validates", () => {
    const broken = Object.entries(GRAPHS).filter(([, g]) => {
      try { g.validate(); return false; } catch { return true; }
    });
    expect(broken.map(([name]) => name)).toEqual([]);
  });

  test("a converted graph carries its spec back for an exact round trip", () => {
    // What items 3 and 5 of the plan need, and what graphs/builder.ts refuses to infer.
    expect(GRAPHS["write-doc"]!.def.spec).toBeDefined();
    expect(GRAPHS["write-doc"]!.def.spec!.name).toBe("write-doc");
  });

  test("write-doc's compiled conditions route exactly as the hand-written tests did", () => {
    // Structure can match while routing differs: the old form was an arbitrary `test`
    // function, the new one is compilePredicate over a Predicate.
    const g = GRAPHS["write-doc"]!;
    const edge = (to: string) => g.def.edges.find((e) => e.from === "doc.review" && e.to === to)!;
    const revise = edge("doc.revise").condition!;
    const done = edge("done").condition!;

    expect(revise.test({ review_verdict: "reject" } as any)).toBe(true);
    expect(done.test({ review_verdict: "pass" } as any)).toBe(true);
    expect(revise.test({ review_verdict: "pass" } as any)).toBe(false);
    expect(done.test({ review_verdict: "reject" } as any)).toBe(false);

    // Orbital semantics: an unmatched value matches NO condition and parks the run. Neither
    // branch may quietly become a catch-all.
    for (const v of probeValues(g)) {
      if (v.review_verdict === "reject" || v.review_verdict === "pass") continue;
      expect([v, revise.test(v as any), done.test(v as any)]).toEqual([v, false, false]);
    }
  });

  test("improve-codebase's worktree.clean branch is STRICT, which the hand-written test was not", () => {
    // The one semantic change the B1 conversion makes, recorded deliberately. The old edge
    // was `test: (v) => v["worktree.clean"]` — truthy — and `is-true` compiles to `=== true`.
    // Unreachable in practice: every write site in engine/executors/worktree.ts (:75, :81,
    // :87, :93) publishes a literal boolean. Where they WOULD differ, strict is the better
    // answer, because routing on a value nothing declared is the guess this engine refuses to
    // make: no edge matches, and the run parks.
    const clean = GRAPHS["improve-codebase"]!.def.edges.find((e) => e.from === "cleanup" && e.to === "discover")!.condition!;
    expect(clean.test({ "worktree.clean": true } as any)).toBe(true);
    expect(clean.test({ "worktree.clean": false } as any)).toBe(false);
    for (const truthyButNotTrue of ["yes", 1, [], {}, "false"]) {
      expect([truthyButNotTrue, clean.test({ "worktree.clean": truthyButNotTrue } as any)]).toEqual([truthyButNotTrue, false]);
    }
  });

  test("implement-ticket routes every PR state where it always did", () => {
    // The most-used graph here (10 of 14 runs on disk), and the one whose delivery half was
    // inlined out of graphs/delivery.ts rather than transcribed from a sibling. MERGED goes to
    // complete_ticket, NOT to cleanup as it does in improve-codebase — the two halves differ and
    // a copy-paste between them would land here.
    const edges = GRAPHS["implement-ticket"]!.def.edges.filter((e) => e.from === "delivery.probe_pr" && e.condition);
    const routeFor = (state: string) => {
      const hits = edges.filter((e) => e.condition!.test({ "pr.state": state } as any));
      expect([state, hits.length]).toEqual([state, 1]);
      return hits[0]!.to;
    };
    expect(routeFor("MERGED")).toBe("complete_ticket");
    expect(routeFor("CLOSED")).toBe("cleanup_closed");
    expect(routeFor("CONFLICTS")).toBe("delivery.resolve_conflicts");
    expect(routeFor("CHANGES_REQUIRED")).toBe("delivery.address_reviews");
    expect(routeFor("CI_FAILED")).toBe("delivery.fix_ci");
    expect(edges.filter((e) => e.condition!.test({ "pr.state": "OPEN" } as any))).toEqual([]);

    // Both cleanup paths are strict on worktree.clean, as improve-codebase is.
    for (const from of ["cleanup_merged", "cleanup_closed"]) {
      const c = GRAPHS["implement-ticket"]!.def.edges.find((e) => e.from === from && e.condition)!.condition!;
      expect([from, c.test({ "worktree.clean": true } as any)]).toEqual([from, true]);
      expect([from, c.test({ "worktree.clean": "yes" } as any)]).toEqual([from, false]);
    }
  });

  test("probe_pr's five PR states keep their routing order after the weight offset", () => {
    // compileEdges derives weight as `count - i`, so probe_pr's hand-written 6..2 became
    // 5..1. Only the ORDER is observable (engine/run.ts:708 takes the max), so this pins the
    // order rather than the numbers: each state routes where it always did, and exactly one
    // condition fires per state.
    const edges = GRAPHS["improve-codebase"]!.def.edges.filter((e) => e.from === "delivery.probe_pr" && e.condition);
    const routeFor = (state: string) => {
      const hits = edges.filter((e) => e.condition!.test({ "pr.state": state } as any));
      expect([state, hits.length]).toEqual([state, 1]);
      return hits[0]!.to;
    };
    expect(routeFor("MERGED")).toBe("cleanup");
    expect(routeFor("CLOSED")).toBe("cleanup");
    expect(routeFor("CONFLICTS")).toBe("delivery.resolve_conflicts");
    expect(routeFor("CHANGES_REQUIRED")).toBe("delivery.address_reviews");
    expect(routeFor("CI_FAILED")).toBe("delivery.fix_ci");
    // OPEN is a legitimate probe:pr answer with no condition: it falls to the wait edge.
    expect(edges.filter((e) => e.condition!.test({ "pr.state": "OPEN" } as any))).toEqual([]);
  });
});

describe("a drafted built-in compiles to the same graph (HOW-56 T3)", () => {
  test("every GraphSpec built-in, with `drafted` added and re-parsed, has an unchanged shape", () => {
    // the provenance is part of the artifact and never of the Graph: what a drafted graph DOES
    // is exactly what its spec says, whoever wrote it
    const specced = Object.entries(GRAPHS).filter(([, g]) => g.def.spec !== undefined);
    expect(specced.length).toBeGreaterThan(0);
    for (const [name, g] of specced) {
      const parsed = parseGraphSpec(JSON.parse(JSON.stringify({ ...g.def.spec!, drafted: { run: "r", draftHash: "c53:00000000000000" } })));
      expect([name, parsed.ok]).toEqual([name, true]);
      if (!parsed.ok) continue;
      expect([name, parsed.spec.drafted?.run]).toEqual([name, "r"]);
      expect({ [name]: shapeOf(buildGraph(parsed.spec)) }).toEqual({ [name]: shapeOf(g) });
    }
  });
});
