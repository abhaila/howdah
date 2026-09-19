/**
 * The reviser with includes (system-map 1c review) — pure parts only, no model call:
 *   - a prompt that includes others is shown its own body (with the `{{> id }}` lines) plus each
 *     included prompt's text in a marked read-only block, and told to keep the include lines;
 *   - the proposal records base_includes;
 *   - a partial is refused unless revised from an includer's evidence (--evidence-from).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReflection, evidenceSource, includedPrompts, loadPrompt, proposalFile } from "./revise";
import { loadProposal } from "../prompts/proposals";

function root(): string {
  const r = mkdtempSync(join(tmpdir(), "howdah-revise-"));
  mkdirSync(join(r, "prompts"));
  const write = (id: string, version: number, body: string) => writeFileSync(join(r, "prompts", `${id}.md`), `---\nid: ${id}\nversion: ${version}\n---\n${body}`);
  write("repair", 3, "Repair the build.\n\n{{> shared._design }}\n");
  write("shared._design", 2, "## Design\n{{> shared._inner }}\n");
  write("shared._inner", 5, "Keep the ghosts.\n");
  write("other", 1, "Unrelated.\n");
  return r;
}

describe("revising a prompt that includes others", () => {
  test("the model sees its own body with the include line, and every included text in a marked read-only block", () => {
    const r = root();
    const { version, body } = loadPrompt("repair", r);
    const included = includedPrompts("repair", body, r);
    expect(included).toEqual([
      { id: "shared._design", version: 2, text: "## Design\nKeep the ghosts.\n" },
      { id: "shared._inner", version: 5, text: "Keep the ghosts.\n" },
    ]);
    const text = buildReflection("repair", version, body, [{ run: "r", node: "n", visit: 1, verdict: "reject", note: "too slow" }], { included });
    expect(text).toContain("<<<PROMPT\nRepair the build.\n\n{{> shared._design }}\n");
    expect(text).toContain("<<<INCLUDED shared._design v2\n## Design\nKeep the ghosts.\n\nINCLUDED shared._design>>>");
    expect(text).toContain("keep every `{{> id }}` line in your revision EXACTLY");
    expect(text).toContain("- Keep every `{{> id }}` include line exactly");
  });

  test("a prompt without includes gets the reflection it always got (no include section)", () => {
    const r = root();
    const { version, body } = loadPrompt("other", r);
    const text = buildReflection("other", version, body, [], { included: includedPrompts("other", body, r) });
    expect(text).not.toContain("INCLUDED");
  });

  test("the proposal records base_includes — and accept tooling reads it back", () => {
    const r = root();
    const { version, body } = loadPrompt("repair", r);
    const file = proposalFile("repair", version, includedPrompts("repair", body, r), "Repair it.\n\n{{> shared._design }}\n", "2026-09-19T00:00:00Z");
    const path = join(r, "repair.v4.proposal.md");
    writeFileSync(path, file);
    expect(loadProposal(path)).toMatchObject({ id: "repair", base_version: 3, proposed_version: 4, base_includes: { "shared._design": 2, "shared._inner": 5 }, fork: false });
    expect(proposalFile("other", 1, [], "x\n", "t")).not.toContain("base_includes");
  });
});

describe("partials: revised only from an includer's evidence", () => {
  test("refused without --evidence-from, with a message that says why and what to do", () => {
    expect(() => evidenceSource("shared._design", undefined, root())).toThrow(/is a partial: it is never rendered on its own.*--evidence-from <includer-id>/);
  });

  test("the includer's feedback is the evidence; a prompt that does not include it is refused", () => {
    const r = root();
    expect(evidenceSource("shared._design", "repair", r)).toBe("repair");
    expect(evidenceSource("shared._inner", "repair", r)).toBe("repair"); // transitively
    expect(() => evidenceSource("shared._design", "other", r)).toThrow(/does not include shared._design/);
    expect(() => evidenceSource("repair", "other", r)).toThrow(/only for partials/);
    expect(evidenceSource("repair", undefined, r)).toBe("repair");
    const text = buildReflection("shared._design", 2, "## Design\n", [], { evidenceFrom: "repair" });
    expect(text).toContain("The feedback below judged renders of repair, which includes it");
  });
});
