/**
 * The suffix half of the render contract (system-map 0.1). The v1 strings below are
 * copied from what the executors appended before 0.1 — pinned here as literals so a
 * rewording that forgets to bump SUFFIX_VERSION fails loudly instead of silently turning
 * every recorded v1 render UNVERIFIED.
 *
 * system-map 0.2 added v2 = v1 + the operator reply suffix; its wording is pinned the same way.
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
const V2_REPLY =
  "\n\n## Operator reply\nThe previous attempt at this step failed and the run parked. The operator replied — take it into account on this attempt:\nuse the v2 API";

describe("versioned suffix builders (system-map 0.1)", () => {
  test("v1 reproduces the pre-0.1 executor wording byte-for-byte", () => {
    const v1 = suffixBuilders(1)!;
    expect(v1.skillHint(["review", "qa"])).toBe(V1_SKILL_HINT);
    expect(v1.skillHint([])).toBe("");
    expect(v1.outputContract(["a", "b"])).toBe(V1_CONTRACT);
    expect(v1.outputContract([])).toBe(V1_SUMMARY_ONLY);
  });

  test("the current version is 2 and buildOutputInstruction is its contract builder", () => {
    expect(SUFFIX_VERSION).toBe(2);
    expect(buildOutputInstruction(["a", "b"])).toBe(V1_CONTRACT);
  });

  test("v1 has no reply builder — a v1 render cannot have carried a reply (system-map 0.2)", () => {
    expect(suffixBuilders(1)!.replyInstruction).toBeUndefined();
    expect(() =>
      assemblePrompt({ body: "x", replyMessage: "hi", skills: [], outputKeys: [], suffixVersion: 1 }),
    ).toThrow(/suffix version 1 has no reply builder/);
  });

  test("v2 is v1 plus the reply builder: skill hint and contract unchanged, reply pinned literally", () => {
    const v2 = suffixBuilders(2)!;
    expect(v2.skillHint(["review", "qa"])).toBe(V1_SKILL_HINT);
    expect(v2.skillHint([])).toBe("");
    expect(v2.outputContract(["a", "b"])).toBe(V1_CONTRACT);
    expect(v2.outputContract([])).toBe(V1_SUMMARY_ONLY);
    expect(v2.replyInstruction!("use the v2 API")).toBe(V2_REPLY);
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
      replyMessage: "use the v2 API",
      skills: ["review", "qa"],
      outputKeys: ["a", "b"],
      suffixVersion: 2,
    });
    expect(text).toBe("BODY" + operatorInstructionSuffix("JUMP") + V2_REPLY + V1_SKILL_HINT + V1_CONTRACT);
  });

  test("absent jump, reply and skills contribute nothing — under v1 and v2 alike", () => {
    expect(assemblePrompt({ body: "BODY", skills: [], outputKeys: [], suffixVersion: 1 })).toBe("BODY" + V1_SUMMARY_ONLY);
    expect(assemblePrompt({ body: "BODY", skills: [], outputKeys: [], suffixVersion: 2 })).toBe("BODY" + V1_SUMMARY_ONLY);
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
