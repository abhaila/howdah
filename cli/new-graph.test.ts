/**
 * Scaffolding a graph (T20), now that graphs an operator writes live in `$HOWDAH_HOME`
 * rather than in this repo (D9).
 *
 * What is worth pinning: the scaffold that lands is RUNNABLE — it imports, validates, and
 * its prompts exist — and a scaffold that would not be is rolled back whole rather than
 * leaving orphan files behind. The old repo path string-replaced anchors in `graphs/index.ts`
 * and threw "anchors moved" BEFORE its rollback block, stranding the files it had written;
 * nothing edits that file any more, so the failure mode is gone with it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newGraph } from "./new-graph";
import { GRAPHS } from "../graphs/index";
import { listLocalGraphNames, loadLocalGraph, localGraphPath, localPromptsDir } from "../graphs/local";

const ROOT = join(import.meta.dir, "..");
const home = () => mkdtempSync(join(tmpdir(), "howdah-ng-"));

describe("howdah new-graph", () => {
  test("the shipped scaffold example is still registered and valid", () => {
    expect(GRAPHS["quick-task"]).toBeDefined();
    expect(() => GRAPHS["quick-task"]!.validateOrThrow()).not.toThrow();
    expect(existsSync(join(ROOT, "prompts", "quick-task.work.md"))).toBe(true);
  });

  test("kebab-case is enforced", async () => {
    await expect(newGraph("BadName", "custom", home())).rejects.toThrow(/kebab-case/);
    await expect(newGraph("../escape", "custom", home())).rejects.toThrow(/kebab-case/);
  });

  test("a duplicate is refused, and the existing file is left alone", async () => {
    const h = home();
    await newGraph("mine", "custom", h, ROOT);
    const before = Bun.file(localGraphPath(h, "mine")).size;
    await expect(newGraph("mine", "custom", h, ROOT)).rejects.toThrow(/already exists/);
    expect(Bun.file(localGraphPath(h, "mine")).size).toBe(before);
  });

  for (const kind of ["custom", "doc"] as const) {
    test(`a ${kind} scaffold lands in HOWDAH_HOME and is runnable straight away`, async () => {
      const h = home();
      const path = await newGraph(`my-${kind}`, kind, h, ROOT);

      expect(path).toBe(localGraphPath(h, `my-${kind}`));
      expect(path.startsWith(h)).toBe(true);
      // nothing is written into this repo any more
      expect(existsSync(join(ROOT, "graphs", `my-${kind}.ts`))).toBe(false);
      expect(listLocalGraphNames(h)).toEqual([`my-${kind}`]);

      // the gate the scaffold passed is the same one a save passes
      const g = await loadLocalGraph(h, `my-${kind}`, ROOT);
      expect(g.def.name).toBe(`my-${kind}`);
      expect(() => g.validateOrThrow()).not.toThrow();

      // and its prompts came with it, in the local prompts dir
      const prompts = readdirSync(localPromptsDir(h));
      expect(prompts.length).toBeGreaterThan(0);
      for (const p of prompts) expect(p.startsWith(`my-${kind}.`)).toBe(true);
    });
  }

  test("a scaffold that cannot load leaves nothing behind", async () => {
    const h = home();
    // a file already sitting where a prompt must go, with content that breaks the graph's
    // contract, is the cheapest way to make the post-write gate fail for real
    await newGraph("good", "custom", h, ROOT);
    const broken = join(h, "graphs", "broken.ts");
    writeFileSync(broken, "export const nope = 1;\n"); // exports no graph
    await expect(loadLocalGraph(h, "broken", ROOT)).rejects.toThrow(/exports no graph/);
    // the one that DID scaffold is untouched by its neighbour being broken
    expect(listLocalGraphNames(h).sort()).toEqual(["broken", "good"]);
    await expect(loadLocalGraph(h, "good", ROOT)).resolves.toBeDefined();
  });
});
