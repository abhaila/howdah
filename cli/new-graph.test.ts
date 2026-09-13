import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { newGraph } from "./new-graph";
import { GRAPHS } from "../graphs/index";

describe("howdah new-graph (T20)", () => {
  test("the shipped scaffold example registered and validates", () => {
    expect(GRAPHS["quick-task"]).toBeDefined();
    expect(() => GRAPHS["quick-task"]!.validateOrThrow()).not.toThrow();
    expect(existsSync(join(import.meta.dir, "..", "prompts", "quick-task.work.md"))).toBe(true);
  });

  test("kebab-case is enforced and duplicates are refused", async () => {
    await expect(newGraph("BadName", "custom")).rejects.toThrow(/kebab-case/);
    await expect(newGraph("quick-task", "custom")).rejects.toThrow(/already exists/);
  });
});
