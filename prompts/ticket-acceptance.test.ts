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

const raw = splitFrontMatter(readFileSync(join(import.meta.dir, "ticket.acceptance.md"), "utf8"));
const body = raw.body;
const render = (ctx: Record<string, unknown>) =>
  renderTemplate(body, (k) => ctx[k] ?? "", { version: RENDER_VERSION }).text;

describe("ticket.acceptance (v2 rules, still held by v3)", () => {
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

/**
 * HOW-72: the operator reads these rows — in the PR's "Not proven by this run" list and on the
 * card — so v3 asks for few, plain, behaviour-only criteria. Rows like "ac-6: bun test
 * engine/executors graphs is green" were written by an agent for agents, and were waived unread.
 */
describe("ticket.acceptance v3 (HOW-72)", () => {
  test("it is version 3, with the HOW-72 provenance", () => {
    expect(raw.frontmatter).toMatch(/^version: 3$/m);
    expect(raw.frontmatter).toContain("HOW-72");
  });

  test("it caps the list at five", () => {
    expect(body).toContain("Write at most five criteria.");
    expect(body).toContain("propose up to five criteria");
    expect(body).not.toContain("three to seven");
  });

  test("each row is one sentence of behaviour the ticket asks for, in its own terms", () => {
    expect(body).toContain("Each criterion is one sentence about behaviour the ticket asks for, in the ticket's own terms");
    expect(body).toContain("Do not name files, functions or other code");
  });

  test("it bans test-suite / typecheck green rows — verify:run reports those", () => {
    expect(body).toContain("Never write a criterion that the test suite, typecheck, build or lint is green.");
    expect(body).toContain("The harness runs the tests and reports that itself.");
  });

  test("it bans process-step rows", () => {
    expect(body).toContain("Never write a process step: committing, pushing, opening or updating a pull request, running a command, or updating a ticket.");
  });

  test("a ticket checkbox is never silently dropped to meet the cap; unproven rows are disclosed, not waived", () => {
    expect(body).toContain("combine closely related ones into one sentence; never drop one the ticket asks for");
    expect(body).toContain('"Not proven by this run"');
    expect(body).not.toContain("waiver");
    expect(body).not.toContain("the operator settles it");
  });

  test("it is still default-FAIL", () => {
    expect(body).toContain('`"passes": false` and `"evidence": null`, always');
  });
});
