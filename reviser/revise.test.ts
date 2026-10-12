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

/**
 * HOW-35: the reviser gets behavioural evidence — the trajectory profile of every past visit of
 * the prompt — and the block is absent when there is none.
 */
describe("behavioural evidence (HOW-35)", () => {
  const { loadProfiles, summariseProfiles } = require("./revise") as typeof import("./revise");
  type Ev = Record<string, unknown>;
  /** a run under <home>/runs/<id> whose `node` rendered `prompt` and then made the given calls */
  function writeRun(home: string, id: string, prompt: string, calls: Array<[string, unknown]>) {
    const events: Ev[] = [
      { type: "run-started", graph: "g", inputs: {}, pinned_prompts: {} },
      { type: "node-started", node: "impl", visit: 1, attempt_id: "impl#1" },
      { type: "prompt-rendered", node: "impl", visit: 1, prompt, prompt_version: 1, rendered_hash: "h", context_read: {}, harness: "claude" },
      ...calls.map(([name, input], i) => ({ type: "chunk", node: "impl", visit: 1, turn: 1, index: i, kind: "tool_call", content: JSON.stringify(input), tool_id: `t${i}`, tool_name: name })),
      { type: "node-finished", node: "impl", visit: 1, status: "succeeded", writes: {} },
    ];
    mkdirSync(join(home, "runs", id), { recursive: true });
    writeFileSync(join(home, "runs", id, "run.jsonl"), events.map((e, i) => JSON.stringify({ ...e, seq: i + 1, ts: "2026-10-12T00:00:00Z" })).join("\n") + "\n");
  }
  const edit = ["Edit", { file_path: "a.ts", old_string: "x", new_string: "y" }] as [string, unknown];
  const test_ = ["Bash", { command: "bun test" }] as [string, unknown];

  test("the summary counts visits that verified 3+ times after their last edit, as 'X of N'", () => {
    const home = mkdtempSync(join(tmpdir(), "howdah-rev-home-"));
    writeRun(home, "r1", "other", [edit, test_, test_, test_]);
    writeRun(home, "r2", "other", [edit, test_]);
    writeRun(home, "r3", "unrelated", [test_]);
    const profiles = loadProfiles("other", home);
    expect(profiles).toHaveLength(2);
    const summary = summariseProfiles(profiles)!;
    expect(summary).toContain("2 visits with tool data");
    expect(summary).toContain("In 1 of 2 visits this prompt's node ran verification 3+ times after its last edit.");
  });

  test("no tool data anywhere: no summary, and the reflection carries no evidence block", () => {
    const home = mkdtempSync(join(tmpdir(), "howdah-rev-home-"));
    writeRun(home, "r1", "other", []);
    expect(summariseProfiles(loadProfiles("other", home))).toBeUndefined();
    expect(buildReflection("other", 1, "x", [], {})).not.toContain("BEHAVIOURAL EVIDENCE");
  });

  test("HOWDAH_STUB=1: the CLI writes the reflection prompt, evidence included, and calls no model", () => {
    const r = root();
    mkdirSync(join(r, "feedback"));
    writeFileSync(join(r, "feedback", "other.jsonl"), JSON.stringify({ run: "r1", node: "impl", visit: 1, verdict: "reject", note: "too slow" }) + "\n");
    const home = mkdtempSync(join(tmpdir(), "howdah-rev-home-"));
    writeRun(home, "r1", "other", [edit, test_, test_, test_]);
    const out = join(r, "out");
    const res = Bun.spawnSync(["bun", join(import.meta.dir, "revise.ts"), "other", "--root", r, "--out", out], {
      env: { ...process.env, HOWDAH_STUB: "1", HOWDAH_HOME: home },
    });
    expect(res.exitCode).toBe(0);
    const prompt = require("node:fs").readFileSync(join(out, "other.v2.reflection-prompt.md"), "utf8") as string;
    expect(prompt).toContain("BEHAVIOURAL EVIDENCE");
    expect(prompt).toContain("In 1 of 1 visit this prompt's node ran verification 3+ times after its last edit.");
    expect(prompt).toContain("too slow");
  });
});
