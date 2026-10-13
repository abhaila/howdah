/**
 * HOW-59: the criteria step is told what this run can PROVE before it writes a single criterion.
 * The two evidence sources render only when the workspace has them — a sentence promising tests
 * or screenshots that will never exist is exactly what produced criteria nothing could flip.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RENDER_VERSION, renderTemplate, splitFrontMatter, templateReads } from "../core/template";
import { ACCEPTANCE_CHECKS } from "../core/acceptance";

const body = splitFrontMatter(readFileSync(join(import.meta.dir, "ticket.acceptance.md"), "utf8")).body;
const render = (ctx: Record<string, unknown>) =>
  renderTemplate(body, (k) => ctx[k] ?? "", { version: RENDER_VERSION }).text;

describe("ticket.acceptance v2", () => {
  test("it reads the two facts create_worktree publishes", () => {
    expect(templateReads(body)).toEqual(expect.arrayContaining(["worktree.verify_command", "worktree.preview_paths"]));
  });

  test("no verify command and no preview: neither source is offered", () => {
    const text = render({});
    expect(text).not.toContain("the harness runs");
    expect(text).not.toContain("captures these paths");
    expect(text).toContain("If no test command is named above, nothing will run the tests");
  });

  test("each source appears, named, only when the workspace has it", () => {
    const text = render({ "worktree.verify_command": "./gradlew test", "worktree.preview_paths": "/, /runs" });
    expect(text).toContain("the harness runs `./gradlew test` in the worktree");
    expect(text).toContain("captures these paths: /, /runs");
  });

  test("every check kind the contract accepts is explained, and the row shape carries one", () => {
    for (const c of ACCEPTANCE_CHECKS) expect(body).toContain(`\`"${c}"\``);
    expect(body).toContain('"check": "command"');
  });
});
