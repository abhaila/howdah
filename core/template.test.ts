/**
 * The suffix half of the render contract (system-map 0.1). The v1 strings below are
 * copied from what the executors appended before 0.1 — pinned here as literals so a
 * rewording that forgets to bump SUFFIX_VERSION fails loudly instead of silently turning
 * every recorded v1 render UNVERIFIED.
 */
import { describe, expect, test } from "bun:test";
import {
  SUFFIX_VERSION,
  assemblePrompt,
  buildOutputInstruction,
  operatorInstructionSuffix,
  skillsForHarness,
  suffixBuilders,
} from "./template";

const V1_SKILL_HINT = "\n\nRelevant installed skills for this task: /review, /qa — invoke them where they apply.";
const V1_CONTRACT =
  "\n\n## Output contract (required)\n" +
  "When your work is complete, the LAST line of your reply must be a single JSON object of the form\n" +
  '{"outputs": {"a": <value>, "b": <value>}}\n' +
  "containing exactly these keys: a, b. No markdown fence, no trailing text.";
const V1_SUMMARY_ONLY = "\n\n## Output\nWhen your work is complete, end your reply with a one-line summary of what you did.";

describe("versioned suffix builders (system-map 0.1)", () => {
  test("v1 reproduces the pre-0.1 executor wording byte-for-byte", () => {
    const v1 = suffixBuilders(1)!;
    expect(v1.skillHint(["review", "qa"])).toBe(V1_SKILL_HINT);
    expect(v1.skillHint([])).toBe("");
    expect(v1.outputContract(["a", "b"])).toBe(V1_CONTRACT);
    expect(v1.outputContract([])).toBe(V1_SUMMARY_ONLY);
  });

  test("the current version is 1 and buildOutputInstruction is its contract builder", () => {
    expect(SUFFIX_VERSION).toBe(1);
    expect(buildOutputInstruction(["a", "b"])).toBe(V1_CONTRACT);
  });

  test("an unknown version has no builders — callers must not guess", () => {
    expect(suffixBuilders(0)).toBeUndefined();
    expect(suffixBuilders(999)).toBeUndefined();
    expect(() => assemblePrompt({ body: "x", skills: [], outputKeys: [], suffixVersion: 999 })).toThrow(/suffix version 999/);
  });
});

describe("assemblePrompt — one fixed order", () => {
  test("body → jump → reply → skill hint → outputs contract", () => {
    const text = assemblePrompt({
      body: "BODY",
      jumpMessage: "JUMP",
      replySuffix: "<REPLY>",
      skills: ["review", "qa"],
      outputKeys: ["a", "b"],
      suffixVersion: 1,
    });
    expect(text).toBe("BODY" + operatorInstructionSuffix("JUMP") + "<REPLY>" + V1_SKILL_HINT + V1_CONTRACT);
  });

  test("absent jump, reply and skills contribute nothing", () => {
    expect(assemblePrompt({ body: "BODY", skills: [], outputKeys: [], suffixVersion: 1 })).toBe("BODY" + V1_SUMMARY_ONLY);
  });
});

describe("skillsForHarness — per-harness behaviour preserved", () => {
  test("codex never gets a skill hint; claude, opencode and the default do", () => {
    expect(skillsForHarness("codex", ["review"])).toEqual([]);
    expect(skillsForHarness("claude", ["review"])).toEqual(["review"]);
    expect(skillsForHarness("opencode", ["review"])).toEqual(["review"]);
    expect(skillsForHarness(undefined, ["review"])).toEqual(["review"]);
    expect(skillsForHarness("claude", undefined)).toEqual([]);
  });
});
