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
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shapeOf, probeValues } from "./spec-shape";
import { GRAPHS } from "./index";

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
