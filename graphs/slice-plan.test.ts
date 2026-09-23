/**
 * The slice-plan validator (HOW-23). Every refusal here is read by the PROPOSER, not by a
 * human, so the tests assert the words that tell it what to do next — not only that it failed.
 */
import { describe, expect, test } from "bun:test";
import { dependencyCycles, MAX_SLICES, validateSlicePlan, type Slice } from "./slice-plan";

const OPTS = { knownWorkspaces: ["api", "web"] };

/** `over` is deliberately untyped: most of these tests feed the validator what a MODEL sent. */
const slice = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "add-endpoint",
  title: "Add the endpoint",
  goal: "a caller can POST /things",
  work: "scope: the route and its handler. acceptance: 201 with the created thing.",
  verify: "curl the endpoint and see a 201",
  depends_on: [],
  ...over,
});

const plan = (slices: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => ({
  feature: "things end to end",
  slices,
  out_of_scope: ["the admin UI"],
  risks: ["the migration is not reversible"],
  ...over,
});

const errorsOf = (v: unknown, opts = OPTS): string[] => {
  const r = validateSlicePlan(v, opts);
  if (r.ok) throw new Error(`expected a refusal, got ok: ${JSON.stringify(r.plan)}`);
  return r.errors;
};

const joined = (v: unknown, opts = OPTS) => errorsOf(v, opts).join("\n");

describe("a plan that is accepted", () => {
  test("normalises a well-formed plan and keeps declaration order", () => {
    const r = validateSlicePlan(
      plan([slice({ id: "b", depends_on: ["a"] }), slice({ id: "a", workspace: "web" })]),
      OPTS,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.slices.map((s) => s.id)).toEqual(["b", "a"]);
    expect(r.plan.slices[1]!.workspace).toBe("web");
    expect(r.plan.feature).toBe("things end to end");
    expect(r.plan.out_of_scope).toEqual(["the admin UI"]);
    expect(r.plan.risks).toEqual(["the migration is not reversible"]);
  });

  test("an omitted workspace stays omitted — the child inherits the parent's", () => {
    const r = validateSlicePlan(plan([slice()]), OPTS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.slices[0]!.workspace).toBeUndefined();
    expect(r.plan.slices[0]!.depends_on).toEqual([]);
  });

  test("omitted depends_on, out_of_scope and risks read as empty, not as errors", () => {
    const one = slice();
    delete one.depends_on;
    const r = validateSlicePlan({ feature: "f", slices: [one] }, OPTS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.slices[0]!.depends_on).toEqual([]);
    expect(r.plan.out_of_scope).toEqual([]);
    expect(r.plan.risks).toEqual([]);
  });

  test("text fields are trimmed", () => {
    const r = validateSlicePlan(plan([slice({ title: "  Add the endpoint  " })]), OPTS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.slices[0]!.title).toBe("Add the endpoint");
  });

  test("a forward dependency is fine — order in the array is not the dependency order", () => {
    expect(validateSlicePlan(plan([slice({ id: "a", depends_on: ["b"] }), slice({ id: "b" })]), OPTS).ok).toBe(true);
  });

  test("exactly MAX_SLICES is allowed", () => {
    const slices = Array.from({ length: MAX_SLICES }, (_, i) => slice({ id: `s-${i}` }));
    expect(validateSlicePlan(plan(slices), OPTS).ok).toBe(true);
  });
});

describe("the shape of the plan itself", () => {
  test("a non-object is refused naming what it got", () => {
    expect(joined("a plan")).toContain("must be a JSON object");
    expect(joined(null)).toContain("must be a JSON object");
    expect(joined([slice()])).toContain("must be a JSON object");
  });

  test("slices missing or not an array", () => {
    expect(joined({ feature: "f" })).toContain('"slices" must be an array');
    expect(joined({ feature: "f", slices: "one and two" })).toContain('"slices" must be an array');
  });

  test("an empty plan is refused — a decomposition has to propose something", () => {
    expect(joined(plan([]))).toContain("at least one vertical slice");
  });

  test("more than MAX_SLICES asks for a smaller first tranche rather than just saying no", () => {
    const slices = Array.from({ length: MAX_SLICES + 1 }, (_, i) => slice({ id: `s-${i}` }));
    const message = joined(plan(slices));
    expect(message).toContain(`${MAX_SLICES + 1} slices`);
    expect(message).toContain("smaller first tranche");
  });

  test("a non-object slice is refused by position, since it has no id to name", () => {
    expect(joined(plan(["build the thing" as unknown as Record<string, unknown>]))).toContain("slice 1 is a string");
  });
});

describe("slice ids (they become the child run id and its branch)", () => {
  test.each([
    ["Add Endpoint", "upper case"],
    ["add endpoint", "a space"],
    ["-leading", "a leading hyphen"],
    ["add/endpoint", "a path separator"],
    ["", "empty"],
    ["a".repeat(42), "too long"],
  ])("%s (%s) is refused, explaining that the id is identity", (id) => {
    const message = joined(plan([slice({ id })]));
    expect(message).toContain("child run id");
    expect(message).toContain("lower-case letters, digits and hyphens");
  });

  test("a missing id is refused, not read as blank", () => {
    const s = slice();
    delete s.id;
    expect(joined(plan([s]))).toContain("is not a slug");
  });

  test("41 characters is the limit, 42 is not", () => {
    expect(validateSlicePlan(plan([slice({ id: "a".repeat(41) })]), OPTS).ok).toBe(true);
    expect(errorsOf(plan([slice({ id: "a".repeat(42) })])).length).toBe(1);
  });

  test("duplicate ids are refused, and the duplicate is not also reported as a dependency target", () => {
    const message = joined(plan([slice({ id: "same" }), slice({ id: "same" })]));
    expect(message).toContain('duplicate id "same"');
  });
});

describe("required prose", () => {
  test.each(["title", "goal", "work", "verify"])("a blank %s is refused, naming the slice and what the field is for", (field) => {
    const message = joined(plan([slice({ [field]: "   " })]));
    expect(message).toContain(`slice "add-endpoint": "${field}" is blank`);
  });

  test("a missing field reads as missing rather than blank", () => {
    const s = slice();
    delete s.work;
    expect(joined(plan([s]))).toContain('"work" is missing');
  });

  test("a non-string field is refused", () => {
    expect(joined(plan([slice({ title: 42 })]))).toContain('"title" is a number');
  });
});

describe("workspaces (a slice that could never be launched is refused before approval)", () => {
  test("an unregistered workspace lists what IS registered", () => {
    const message = joined(plan([slice({ workspace: "mobile" })]));
    expect(message).toContain('workspace "mobile" is not registered');
    expect(message).toContain("api, web");
  });

  test("with nothing registered, the refusal says so and names the verb", () => {
    const message = joined(plan([slice({ workspace: "mobile" })]), { knownWorkspaces: [] });
    expect(message).toContain("no repo workspaces are registered");
    expect(message).toContain("howdah workspace add");
  });

  test("a blank or non-string workspace is refused rather than treated as omitted", () => {
    expect(joined(plan([slice({ workspace: "  " })]))).toContain('"workspace" is blank');
    expect(joined(plan([slice({ workspace: 7 })]))).toContain('"workspace" is a number');
  });

  test("an explicit null workspace reads as omitted", () => {
    expect(validateSlicePlan(plan([slice({ workspace: null })]), OPTS).ok).toBe(true);
  });
});

describe("depends_on", () => {
  test("an unknown id lists the ids the plan does have", () => {
    const message = joined(plan([slice({ id: "a", depends_on: ["nope"] }), slice({ id: "b" })]));
    expect(message).toContain('depends_on "nope"');
    expect(message).toContain("have: a, b");
  });

  test("a self-dependency is refused on its own terms", () => {
    expect(joined(plan([slice({ id: "a", depends_on: ["a"] })]))).toContain("depends_on names itself");
  });

  test("a non-array depends_on is refused", () => {
    expect(joined(plan([slice({ depends_on: "the other one" })]))).toContain('"depends_on" is a string');
  });

  test("a two-slice cycle is named as a loop", () => {
    const message = joined(plan([slice({ id: "a", depends_on: ["b"] }), slice({ id: "b", depends_on: ["a"] })]));
    expect(message).toContain("cycle (a → b → a)");
    expect(message).toContain("could ever ship first");
  });

  test("a longer cycle is named in full and reported once", () => {
    const errors = errorsOf(
      plan([
        slice({ id: "a", depends_on: ["b"] }),
        slice({ id: "b", depends_on: ["c"] }),
        slice({ id: "c", depends_on: ["a"] }),
      ]),
    );
    expect(errors.filter((e) => e.includes("cycle")).length).toBe(1);
    expect(errors[0]).toContain("a → b → c → a");
  });

  test("two independent cycles are both reported", () => {
    const errors = errorsOf(
      plan([
        slice({ id: "a", depends_on: ["b"] }),
        slice({ id: "b", depends_on: ["a"] }),
        slice({ id: "c", depends_on: ["d"] }),
        slice({ id: "d", depends_on: ["c"] }),
      ]),
    );
    expect(errors.filter((e) => e.includes("cycle")).length).toBe(2);
  });

  test("a diamond is not a cycle", () => {
    expect(
      validateSlicePlan(
        plan([
          slice({ id: "base" }),
          slice({ id: "left", depends_on: ["base"] }),
          slice({ id: "right", depends_on: ["base"] }),
          slice({ id: "top", depends_on: ["left", "right"] }),
        ]),
        OPTS,
      ).ok,
    ).toBe(true);
  });
});

describe("dependencyCycles", () => {
  const s = (id: string, depends_on: string[]): Slice => ({ id, title: "t", goal: "g", work: "w", verify: "v", depends_on });

  test("no edges, no cycles", () => {
    expect(dependencyCycles([s("a", []), s("b", ["a"])])).toEqual([]);
  });

  test("reports one cycle per loop, whichever node the walk enters from", () => {
    expect(dependencyCycles([s("b", ["c"]), s("c", ["b"]), s("a", ["b"])])).toEqual([["b", "c", "b"]]);
  });

  test("an unknown dependency is ignored here — it is already its own error", () => {
    expect(dependencyCycles([s("a", ["ghost"])])).toEqual([]);
  });

  test("a deep chain does not blow the stack", () => {
    const chain = Array.from({ length: 5000 }, (_, i) => s(`s${i}`, i === 0 ? [] : [`s${i - 1}`]));
    expect(dependencyCycles(chain)).toEqual([]);
  });
});
