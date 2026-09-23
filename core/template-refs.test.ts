/**
 * The reference grammar on its own (HOW-22), and in particular renameTemplateRef().
 *
 * Renaming a field in the builder rewrites the operator's OWN TEXT, which is the one thing in
 * this feature that could destroy work rather than merely refuse it. So the negative cases
 * carry the weight here: a naive `body.replaceAll("goal", "goal2")` passes the first test in
 * this file and fails every other one, which is exactly why the rewrite goes through
 * templateRefPattern() and compares the captured key EXACTLY.
 */
import { describe, expect, test } from "bun:test";
import { renameTemplateRef, templateReads } from "./template-refs";

describe("renameTemplateRef rewrites references and nothing else", () => {
  test("an exact key match is rewritten, in every namespace, wherever it appears", () => {
    const body = "Goal: {{ context.goal }}\n\nAlso {{ inputs.goal }} and again {{ context.goal }}.";
    expect(renameTemplateRef(body, "goal", "objective")).toBe(
      "Goal: {{ context.objective }}\n\nAlso {{ inputs.objective }} and again {{ context.objective }}.",
    );
  });

  test("the namespace is preserved — an `inputs.` reference does not become a `context.` one", () => {
    expect(renameTemplateRef("{{ inputs.goal }}", "goal", "aim")).toBe("{{ inputs.aim }}");
    expect(renameTemplateRef("{{ context.goal }}", "goal", "aim")).toBe("{{ context.aim }}");
  });

  test("a longer key that merely STARTS with the old one is left alone, and so is prose", () => {
    const body = "The goal, in goal terms: {{ context.goalkeeper }} vs {{ context.goal }} (goal).";
    expect(renameTemplateRef(body, "goal", "aim")).toBe(
      "The goal, in goal terms: {{ context.goalkeeper }} vs {{ context.aim }} (goal).",
    );
  });

  test("the filter tail and the operator's own spacing survive verbatim", () => {
    expect(renameTemplateRef("{{ context.goal | trim }}", "goal", "aim")).toBe("{{ context.aim | trim }}");
    expect(renameTemplateRef("{{context.goal}}", "goal", "aim")).toBe("{{context.aim}}");
    expect(renameTemplateRef("{{   context.goal   }}", "goal", "aim")).toBe("{{   context.aim   }}");
  });

  test("the engine's own namespace is untouchable, however a field is named", () => {
    const body = "{{ context.internal.jump }} and {{ context.internal.reply }}";
    expect(renameTemplateRef(body, "internal.jump", "mine")).toBe(body);
  });

  test("`to` is substituted literally — a `$` in it is not a replacement pattern", () => {
    // the builder dispatches a rename on every keystroke, so `to` is whatever is typed so far
    expect(renameTemplateRef("{{ context.goal }}", "goal", "$&x")).toBe("{{ context.$&x }}");
  });

  test("after a rename, templateReads() reports the new key and only the new key", () => {
    const after = renameTemplateRef("{{ context.goal }} {{ inputs.goal }} {{ context.work }}", "goal", "aim");
    expect(templateReads(after)).toEqual(["aim", "work"]);
  });
});
