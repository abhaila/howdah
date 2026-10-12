/**
 * The suffix half of the render contract (system-map 0.1). The v1 strings below are
 * copied from what the executors appended before 0.1 — pinned here as literals so a
 * rewording that forgets to bump SUFFIX_VERSION fails loudly instead of silently turning
 * every recorded v1 render UNVERIFIED.
 *
 * system-map 0.2 added v2 = v1 + the operator reply suffix; its wording is pinned the same way.
 * HOW-14 added v4 = v3 + the context re-entry briefing, pinned the same way.
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
import { RATE_LIMIT_TEXT } from "../engine/executors/harness-failure";

const V1_SKILL_HINT = "\n\nRelevant installed skills for this task: /review, /qa — invoke them where they apply.";
const V1_CONTRACT =
  "\n\n## Output contract (required)\n" +
  "When your work is complete, the LAST line of your reply must be a single JSON object of the form\n" +
  '{"outputs": {"a": <value>, "b": <value>}}\n' +
  "containing exactly these keys: a, b. No markdown fence, no trailing text.";
const V1_SUMMARY_ONLY = "\n\n## Output\nWhen your work is complete, end your reply with a one-line summary of what you did.";
const V2_REPLY =
  "\n\n## Operator reply\nThe previous attempt at this step failed and the run parked. The operator replied — take it into account on this attempt:\nuse the v2 API";

const V4_REENTRY_AFTER_2 =
  "\n\n## Re-entering this step\n" +
  "Visit 2 of this step ran out of context window space before it finished. " +
  "Its work may already be partly done in the working directory, and you do not have its conversation. " +
  "Get your bearings before changing anything:\n" +
  "1. Run `git status`, `git diff --stat` and `git log --oneline -20` to see what is already done.\n" +
  "2. Re-read the task above.\n" +
  "3. Continue from where the work stands rather than starting over, and commit as you go so progress survives if this happens again.";

describe("versioned suffix builders (system-map 0.1)", () => {
  test("v1 reproduces the pre-0.1 executor wording byte-for-byte", () => {
    const v1 = suffixBuilders(1)!;
    expect(v1.skillHint(["review", "qa"])).toBe(V1_SKILL_HINT);
    expect(v1.skillHint([])).toBe("");
    expect(v1.outputContract(["a", "b"])).toBe(V1_CONTRACT);
    expect(v1.outputContract([])).toBe(V1_SUMMARY_ONLY);
  });

  test("the current version is 5 and buildOutputInstruction is its contract builder", () => {
    expect(SUFFIX_VERSION).toBe(5);
    expect(buildOutputInstruction(["a", "b"])).toBe(V1_CONTRACT);
  });

  test("v3 is v2 plus the refusal builder (system-map 1c): everything else byte-identical, refusal pinned literally", () => {
    const v2 = suffixBuilders(2)!;
    const v3 = suffixBuilders(3)!;
    expect(v3.skillHint(["review"])).toBe(v2.skillHint(["review"]));
    expect(v3.outputContract(["a"])).toBe(v2.outputContract(["a"]));
    expect(v3.replyInstruction!("x")).toBe(v2.replyInstruction!("x"));
    expect(v3.refusalInstruction!("entities[0]: bad key")).toBe(
      "\n\n## Your previous proposal was refused\nThe previous attempt at this step produced a proposal the graph's validator refused. Fix every problem below and return the corrected proposal:\nentities[0]: bad key",
    );
    expect(v2.refusalInstruction).toBeUndefined();
    expect(() => assemblePrompt({ body: "x", refusalMessage: "no", skills: [], outputKeys: [], suffixVersion: 2 })).toThrow(/suffix version 2 has no refusal builder/);
    // order: body → reply → refusal → skill hint → contract
    const text = assemblePrompt({ body: "B", replyMessage: "R", refusalMessage: "F", skills: ["s"], outputKeys: ["k"], suffixVersion: 3 });
    expect(text.indexOf("R")).toBeLessThan(text.indexOf("refused"));
    expect(text.indexOf("refused")).toBeLessThan(text.indexOf("/s"));
  });

  test("v4 is v3 plus the context re-entry builder (HOW-14): everything else byte-identical, briefing pinned literally", () => {
    const v3 = suffixBuilders(3)!;
    const v4 = suffixBuilders(4)!;
    expect(v4.skillHint(["review"])).toBe(v3.skillHint(["review"]));
    expect(v4.outputContract(["a"])).toBe(v3.outputContract(["a"]));
    expect(v4.replyInstruction!("x")).toBe(v3.replyInstruction!("x"));
    expect(v4.refusalInstruction!("x")).toBe(v3.refusalInstruction!("x"));
    expect(v4.reentryInstruction!(2)).toBe(V4_REENTRY_AFTER_2);
    for (const v of [1, 2, 3]) {
      expect(suffixBuilders(v)!.reentryInstruction).toBeUndefined();
      expect(() => assemblePrompt({ body: "x", reentryAfterVisit: 1, skills: [], outputKeys: [], suffixVersion: v }))
        .toThrow(new RegExp(`suffix version ${v} has no re-entry builder`));
    }
  });

  test("v5 is v4 plus the carried-steer builder (HOW-47): everything else byte-identical, steer pinned literally", () => {
    const v4 = suffixBuilders(4)!;
    const v5 = suffixBuilders(5)!;
    expect(v5.skillHint(["review"])).toBe(v4.skillHint(["review"]));
    expect(v5.outputContract(["a"])).toBe(v4.outputContract(["a"]));
    expect(v5.replyInstruction!("x")).toBe(v4.replyInstruction!("x"));
    expect(v5.refusalInstruction!("x")).toBe(v4.refusalInstruction!("x"));
    expect(v5.reentryInstruction!(2)).toBe(v4.reentryInstruction!(2));
    expect(v5.steerInstruction!(["use the helper in core/"])).toBe(
      "\n\n## Operator steering\nWhile an earlier step was running, the operator sent this instruction. " +
        "It did not reach that step before it finished, so take it into account here:\n- use the helper in core/",
    );
    expect(v5.steerInstruction!(["one", "two\nlines"])).toBe(
      "\n\n## Operator steering\nWhile an earlier step was running, the operator sent these instructions. " +
        "They did not reach that step before it finished, so take them into account here:\n- one\n- two\n  lines",
    );
    for (const v of [1, 2, 3, 4]) {
      expect(suffixBuilders(v)!.steerInstruction).toBeUndefined();
      expect(() => assemblePrompt({ body: "x", steerMessages: ["s"], skills: [], outputKeys: [], suffixVersion: v }))
        .toThrow(new RegExp(`suffix version ${v} has no steer builder`));
    }
    // an empty list renders nothing, under any version — "no steers" is not a suffix
    expect(assemblePrompt({ body: "x", steerMessages: [], skills: [], outputKeys: [], suffixVersion: 1 })).toBe(
      assemblePrompt({ body: "x", skills: [], outputKeys: [], suffixVersion: 1 }),
    );
  });

  test("the re-entry briefing never reads as an allowance failure to the harness fallback", () => {
    // engine/run.ts hops harnesses when a failed attempt's text matches RATE_LIMIT_TEXT; the
    // briefing is never in a chunk today, but it names the failure, so pin it anyway
    expect(RATE_LIMIT_TEXT.test(suffixBuilders(4)!.reentryInstruction!(1))).toBe(false);
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

describe("assemblePrompt — re-entry (HOW-14)", () => {
  test("body → jump → reply → refusal → re-entry → skill hint → outputs contract", () => {
    const v4 = suffixBuilders(4)!;
    const text = assemblePrompt({
      body: "BODY",
      jumpMessage: "JUMP",
      replyMessage: "use the v2 API",
      refusalMessage: "REFUSED",
      reentryAfterVisit: 2,
      skills: ["review", "qa"],
      outputKeys: ["a", "b"],
      suffixVersion: 4,
    });
    expect(text).toBe(
      "BODY" + operatorInstructionSuffix("JUMP") + V2_REPLY + v4.refusalInstruction!("REFUSED") +
      V4_REENTRY_AFTER_2 + V1_SKILL_HINT + V1_CONTRACT,
    );
  });

  test("no re-entry visit, no briefing — v4 without it is byte-identical to v3", () => {
    const parts = { body: "BODY", replyMessage: "r", skills: ["s"], outputKeys: ["k"] };
    expect(assemblePrompt({ ...parts, suffixVersion: 4 })).toBe(assemblePrompt({ ...parts, suffixVersion: 3 }));
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
