/**
 * HOW-44: the plan-first / verification-aware experiment's prompt side.
 *
 *   - render v2's one block form, `{{#if context.key}}…{{/if}}`: truthy, empty and absent;
 *   - a workspace with no verifyCommand gets NO variant-B sentence (the ticket's edge case —
 *     otherwise the prompt would make a false claim), one with a command gets it, named;
 *   - the B/C/D proposals load, are forks (the include set changes), are not stale, and pass the
 *     store's undeclared-read guard on every graph that runs them — except improve-codebase,
 *     which has no verify:run, and is refused for B/D on purpose.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RENDER_VERSION, expandIncludes, renderTemplate, splitFrontMatter, templateFilterProblems, templateReads } from "../core/template";
import { loadProposal } from "./proposals";
import { PromptStore } from "./store";
import { GRAPHS } from "../graphs/index";

const PROMPTS = import.meta.dir;
const PROPOSALS = join(import.meta.dir, "..", "reviser", "proposals");
const v2 = { version: RENDER_VERSION };

describe("{{#if}} (render v2)", () => {
  const body = "A{{#if context.flag}} [shown: {{ context.flag }}]{{/if}}B";
  test("a non-empty string or true renders the block; the key is read", () => {
    expect(renderTemplate(body, () => "bun test", v2).text).toBe("A [shown: bun test]B");
    expect(renderTemplate("{{#if context.on}}yes{{/if}}", () => true, v2).text).toBe("yes");
  });
  test("empty, absent, false and objects render nothing — and the inner reference is never read", () => {
    for (const value of ["", undefined, false, {}, 0]) {
      const r = renderTemplate(body, () => value, v2);
      expect(r.text).toBe("AB");
      expect(Object.keys(r.read)).toEqual(["flag"]);
    }
  });
  test("the block's key is a declared read, and nesting or a missing close is refused", () => {
    expect(templateReads(body)).toEqual(["flag"]);
    expect(templateFilterProblems("{{#if context.a}}{{#if context.b}}x{{/if}}{{/if}}")[0]).toContain("nests");
    expect(templateFilterProblems("{{#if context.a}}x")[0]).toContain("every block needs exactly one close");
    expect(templateFilterProblems(body)).toEqual([]);
  });
});

const bodyOf = (id: string) => splitFrontMatter(readFileSync(join(PROMPTS, `${id}.md`), "utf8")).body;

describe("variant B is conditional on the workspace actually verifying", () => {
  const expanded = expandIncludes("{{> implementation._verify_aware }}", bodyOf, ["x"]).text;
  test("no verifyCommand: no sentence at all", () => {
    expect(renderTemplate(expanded, () => "", v2).text.trim()).toBe("");
  });
  test("a verifyCommand: the sentence, naming it", () => {
    const text = renderTemplate(expanded, () => "bun test", v2).text;
    expect(text).toContain("The harness runs `bun test` in this worktree after you finish");
    expect(text).toContain("do not re-run the full suite once your last edit is done");
  });
});

describe("the B/C/D proposals", () => {
  const files = readdirSync(PROPOSALS).filter((f) => /\.v2\.[bcd]-[\w-]+\.proposal\.md$/.test(f));
  const store = new PromptStore(PROMPTS);
  const graphs = Object.values(GRAPHS);

  test("three variants for each build prompt, each a fork with a reflection and a diff", () => {
    expect(files.sort()).toEqual([
      "implementation.implement.v2.b-verify-aware.proposal.md",
      "implementation.implement.v2.c-plan-first.proposal.md",
      "implementation.implement.v2.d-plan-first-verify-aware.proposal.md",
      "slice.implement.v2.b-verify-aware.proposal.md",
      "slice.implement.v2.c-plan-first.proposal.md",
      "slice.implement.v2.d-plan-first-verify-aware.proposal.md",
    ]);
    for (const f of files) {
      const p = loadProposal(join(PROPOSALS, f));
      expect(p.fork).toBe(true);
      // once one variant of a prompt is accepted, its siblings are stale by design — the guard
      // that stops a second accept from silently overwriting the first
      const winner = files.map((g) => loadProposal(join(PROPOSALS, g))).find((q) => q.id === p.id && q.status === "accepted");
      if (winner === undefined) expect(store.staleness(p.id, p.base_version, p.base_includes)).toBeNull();
      else if (p.status === "accepted") expect(store.load(p.id).version).toBe(p.proposed_version);
      else expect(store.staleness(p.id, p.base_version, p.base_includes)).toContain("stale base");
      expect(readFileSync(join(PROPOSALS, f.replace(".proposal.md", ".reflection.md")), "utf8")).toContain("HOW-44");
      expect(readFileSync(join(PROPOSALS, f.replace(".proposal.md", ".diff")), "utf8")).toContain("+{{> implementation._");
    }
  });

  test("the store's read guard: clean wherever the sentence is true, refused on improve-codebase for B and D", () => {
    for (const f of files) {
      const p = loadProposal(join(PROPOSALS, f));
      const problems = store.validateTemplateReads(p.id, p.body, graphs);
      const verifyAware = f.includes("verify-aware");
      if (p.id === "implementation.implement" && verifyAware)
        expect(problems).toEqual(['improve-codebase/implementation.implement: template reads "worktree.verify_command" but the node does not declare it']);
      else expect(problems).toEqual([]);
    }
  });
});
