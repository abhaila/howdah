/** HOW-57 S1: the `until` eval's scorer, pinned without any agent. */
import { describe, expect, test } from "bun:test";
import { scoreUntils } from "./plan-until.eval";

const s = (id: string, over: Record<string, unknown> = {}) => ({ id, title: id, goal: "g", work: "w", verify: "v", depends_on: [], ...over });

describe("scoreUntils", () => {
  test("a stacked api and a web slice waiting on the package passes", () => {
    const score = scoreUntils({
      feature: "f",
      slices: [
        s("be-1"),
        s("be-2", { depends_on: [{ slice: "be-1", until: "published" }] }),
        s("fe-1", { workspace: "web", depends_on: [{ slice: "be-2", until: "package" }] }),
      ],
    });
    expect(score).toMatchObject({ valid: true, crossRepo: { total: 1, package: 1 }, sameRepo: { total: 1, published: 1 }, pass: true });
  });

  test("a web slice that only waits for the merge does not pass", () => {
    const score = scoreUntils({
      feature: "f",
      slices: [s("be-1"), s("be-2", { depends_on: [{ slice: "be-1", until: "published" }] }), s("fe-1", { workspace: "web", depends_on: ["be-2"] })],
    });
    expect(score.crossRepo).toEqual({ total: 1, package: 0 });
    expect(score.pass).toBe(false);
  });

  test("an invalid plan scores invalid with the validator's reasons", () => {
    const score = scoreUntils({ feature: "f", slices: [s("fe-1", { workspace: "web", depends_on: [{ slice: "be-1", until: "published" }] }), s("be-1")] });
    expect(score.valid).toBe(false);
    expect(score.errors.join("\n")).toContain("a stack base must be in the same workspace");
  });
});
