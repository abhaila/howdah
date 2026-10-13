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

  test("the current version is 8 and buildOutputInstruction is its contract builder", () => {
    expect(SUFFIX_VERSION).toBe(8);
    expect(buildOutputInstruction(["a", "b"])).toBe(V1_CONTRACT);
  });

  test("v8 (HOW-57) is v7 plus the STACKED briefing: everything else byte-identical, the briefing pinned literally", () => {
    const v7 = suffixBuilders(7)!;
    const v8 = suffixBuilders(8)!;
    expect(v7.stackedInstruction).toBeUndefined();
    expect(v8.outputContract(["a"])).toBe(v7.outputContract(["a"]));
    expect(v8.skillHint(["review"])).toBe(v7.skillHint(["review"]));
    expect(v8.reentryInstruction!(2)).toBe(v7.reentryInstruction!(2));
    expect(v8.stopResumeInstruction!("x")).toBe(v7.stopResumeInstruction!("x"));
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(v8.stackedInstruction!({ branch: "howdah/p--fe-1", sha })).toBe(
      "\n\n## Stacked change\n" +
        "This change is stacked on howdah/p--fe-1@0123456789ab — another slice's branch, with its own PR. " +
        "Your change is `0123456789ab..HEAD`: plan, build and judge only that range, and do not modify or review the base's commits. " +
        "Use `git diff 0123456789ab..HEAD` and `git log 0123456789ab..HEAD` to see it.",
    );
  });

  test("v8: the briefing sits right after the body, before every other suffix; a v7 render refuses one", () => {
    const parts = { body: "BODY", skills: [], outputKeys: ["a"], jumpMessage: "JUMP", stackedOn: { branch: "b", sha: "s".repeat(40) } };
    const text = assemblePrompt({ ...parts, suffixVersion: 8 });
    expect(text.startsWith("BODY\n\n## Stacked change\n")).toBe(true);
    expect(text.indexOf("## Stacked change")).toBeLessThan(text.indexOf("## Operator instruction"));
    expect(() => assemblePrompt({ ...parts, suffixVersion: 7 })).toThrow("suffix version 7 has no stacked builder");
    // without stackedOn, v8 is v7 byte for byte
    const { stackedOn: _s, ...plain } = parts;
    expect(assemblePrompt({ ...plain, suffixVersion: 8 })).toBe(assemblePrompt({ ...plain, suffixVersion: 7 }));
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

  test("v6 is v5 plus the carried-steer builder (HOW-47): everything else byte-identical, steer pinned literally", () => {
    const v5 = suffixBuilders(5)!;
    const v6 = suffixBuilders(6)!;
    expect(v6.skillHint(["review"])).toBe(v5.skillHint(["review"]));
    expect(v6.outputContract(["a"])).toBe(v5.outputContract(["a"]));
    expect(v6.replyInstruction!("x")).toBe(v5.replyInstruction!("x"));
    expect(v6.refusalInstruction!("x")).toBe(v5.refusalInstruction!("x"));
    expect(v6.reentryInstruction!(2)).toBe(v5.reentryInstruction!(2));
    expect(v6.steerInstruction!(["use the helper in core/"])).toBe(
      "\n\n## Operator steering\nWhile an earlier step was running, the operator sent this instruction. " +
        "It did not reach that step before it finished, so take it into account here:\n- use the helper in core/",
    );
    expect(v6.steerInstruction!(["one", "two\nlines"])).toBe(
      "\n\n## Operator steering\nWhile an earlier step was running, the operator sent these instructions. " +
        "They did not reach that step before it finished, so take them into account here:\n- one\n- two\n  lines",
    );
    for (const v of [1, 2, 3, 4, 5]) {
      expect(suffixBuilders(v)!.steerInstruction).toBeUndefined();
      expect(() => assemblePrompt({ body: "x", steerMessages: ["s"], skills: [], outputKeys: [], suffixVersion: v }))
        .toThrow(new RegExp(`suffix version ${v} has no steer builder`));
    }
    // an empty list renders nothing, under any version — "no steers" is not a suffix
    expect(assemblePrompt({ body: "x", steerMessages: [], skills: [], outputKeys: [], suffixVersion: 1 })).toBe(
      assemblePrompt({ body: "x", skills: [], outputKeys: [], suffixVersion: 1 }),
    );
  });

  test("v7 is v6 plus the stop-resume builder (HOW-48): everything else byte-identical, briefing pinned literally", () => {
    const v6 = suffixBuilders(6)!;
    const v7 = suffixBuilders(7)!;
    expect(v7.skillHint(["review"])).toBe(v6.skillHint(["review"]));
    expect(v7.outputContract(["a"])).toBe(v6.outputContract(["a"]));
    expect(v7.replyInstruction!("x")).toBe(v6.replyInstruction!("x"));
    expect(v7.refusalInstruction!("x")).toBe(v6.refusalInstruction!("x"));
    expect(v7.reentryInstruction!(2)).toBe(v6.reentryInstruction!(2));
    expect(v7.steerInstruction!(["s"])).toBe(v6.steerInstruction!(["s"]));
    expect(v7.stopResumeInstruction!("Tests pass.\nNext: the panel.")).toBe(
      "\n\n## Resuming after an operator stop\n" +
        "The operator stopped the previous visit of this step at a tool boundary, and it ended its turn there. " +
        "Its last message said where the work stood:\n> Tests pass.\n> Next: the panel.\n" +
        "Pick up from there: check `git status` and `git log --oneline -10` against that account, then continue rather than starting over.",
    );
    for (const v of [1, 2, 3, 4, 5, 6]) {
      expect(suffixBuilders(v)!.stopResumeInstruction).toBeUndefined();
      expect(() => assemblePrompt({ body: "x", stopResumeMessage: "m", skills: [], outputKeys: [], suffixVersion: v }))
        .toThrow(new RegExp(`suffix version ${v} has no stop-resume builder`));
    }
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
