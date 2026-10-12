/**
 * HOW-53 — every reviewer in the built-in coding graphs is read-only: plan mode for claude, the
 * read-only sandbox for codex, and no layer — run override, UI tuning, graph default — can raise
 * it. A reviewer that can edit can "fix" what it was meant to judge, then pass its own work.
 */
import { describe, expect, test } from "bun:test";
import { GRAPHS } from "./index";
import { resolveAgentConfig } from "../engine/run";

const REVIEWERS: Record<string, string[]> = {
  "implement-ticket": ["implementation.local_review", "delivery.review_repairs", "implementation.criteria"],
  "implement-slice": ["implementation.local_review", "delivery.review_repairs"],
  "improve-codebase": ["implementation.local_review", "delivery.review_repairs"],
};

describe("read-only reviewers", () => {
  for (const [graph, nodes] of Object.entries(REVIEWERS))
    for (const id of nodes)
      test(`${graph}: ${id} is readOnly, and resolves to plan mode over every override`, () => {
        const g = GRAPHS[graph]!;
        const def = g.def.nodes[id];
        expect(def?.kind).toBe("agent");
        if (def?.kind !== "agent") return;
        expect(def.readOnly).toBe(true);
        const loud = { permissionMode: "bypassPermissions" as const };
        const cfg = resolveAgentConfig(g, def, id, {
          overrides: loud,
          tuning: { nodes: { [id]: loud }, defaults: loud } as never,
        });
        expect(cfg.permissionMode).toBe("plan");
        // and on codex: plan selects the read-only sandbox executor (engine/executors/index.ts)
        expect(resolveAgentConfig(g, def, id, { overrides: { harness: "codex" } }).permissionMode).toBe("plan");
      });

  test("the builders are NOT read-only — the rule is about judging, not about agents", () => {
    for (const id of ["implementation.implement", "implementation.implement_review"])
      expect((GRAPHS["implement-ticket"]!.def.nodes[id] as { readOnly?: true }).readOnly).toBeUndefined();
  });
});
