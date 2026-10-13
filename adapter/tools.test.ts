/**
 * HOW-35: the per-harness call classifier. Table-driven, per harness, including the clip: a
 * logged tool_call keeps only 400 characters of its input JSON, and a decision text past the
 * cut could overturn is `unclassified`, never a guess.
 */
import { describe, expect, test } from "bun:test";
import { classifyCall, classifyShell, LOGGED_INPUT_CHARS } from "./tools";

const logged = (input: unknown) => JSON.stringify(input).slice(0, LOGGED_INPUT_CHARS);

describe("claude", () => {
  const rows: Array<[string, unknown, string, string?]> = [
    ["Read", { file_path: "src/a.ts" }, "inspect", "src/a.ts"],
    ["Grep", { pattern: "foo", path: "src" }, "inspect", "src"],
    ["Glob", { pattern: "**/*.ts" }, "inspect"],
    ["Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }, "edit", "src/a.ts"],
    ["Write", { file_path: "new.ts", content: "x" }, "edit", "new.ts"],
    ["MultiEdit", { file_path: "m.ts", edits: [] }, "edit", "m.ts"],
    ["NotebookEdit", { notebook_path: "n.ipynb" }, "edit", "n.ipynb"],
    ["Bash", { command: "bun test engine/" }, "verify"],
    ["Bash", { command: "rg -n foo src | head" }, "inspect"],
    ["Bash", { command: "git diff --stat" }, "inspect"],
    ["Bash", { command: "cat > out.ts <<'EOF'\nexport const a = 1;\nEOF" }, "edit", "out.ts"],
    ["Bash", { command: "sed -i '' 's/a/b/' src/a.ts" }, "edit", "src/a.ts"],
    ["Bash", { command: "npm install" }, "other"],
    ["TodoWrite", { todos: [] }, "other"],
  ];
  for (const [name, input, cls, path] of rows)
    test(`${name} ${JSON.stringify(input).slice(0, 50)} → ${cls}`, () => {
      const got = classifyCall("claude", name, logged(input));
      expect(got.cls).toBe(cls as never);
      if (path) expect(got.path).toBe(path);
    });

  test("opencode reads claude's table", () => {
    expect(classifyCall("opencode", "Edit", logged({ file_path: "a" })).cls).toBe("edit");
  });
});

describe("codex (item types; commands wrapped in `bash -lc`)", () => {
  const rows: Array<[string, unknown, string]> = [
    ["commandExecution", { id: "i1", type: "commandExecution", command: "bash -lc 'cargo test'", status: "inProgress" }, "verify"],
    ["commandExecution", { id: "i2", type: "commandExecution", command: ["bash", "-lc", "ls src"] }, "inspect"],
    ["commandExecution", { id: "i3", type: "commandExecution", command: "bash -lc 'echo hi > a.txt'" }, "edit"],
    ["fileChange", { id: "i4", type: "fileChange", changes: [{ path: "src/x.rs", kind: "update" }] }, "edit"],
  ];
  for (const [name, input, cls] of rows)
    test(`${name} ${JSON.stringify(input).slice(0, 60)} → ${cls}`, () => expect(classifyCall("codex", name, logged(input)).cls).toBe(cls as never));
});

describe("cursor (documented wrapper keys)", () => {
  const rows: Array<[string, unknown, string]> = [
    ["readToolCall", { readToolCall: { args: { path: "a.ts" } } }, "inspect"],
    ["editToolCall", { editToolCall: { args: { path: "a.ts" } } }, "edit"],
    ["shellToolCall", { shellToolCall: { args: { command: "pytest -q" } } }, "verify"],
    ["mcpToolCall", { mcpToolCall: { args: {} } }, "other"],
  ];
  for (const [name, input, cls] of rows)
    test(`${name} → ${cls}`, () => expect(classifyCall("cursor", name, logged(input)).cls).toBe(cls as never));
});

describe("the clip (400 chars) and the shell's honest limits", () => {
  const long = (head: string) => ({ command: `${head} ${"x".repeat(600)}` });

  test("a clipped command that only LOOKS read-only is unclassified — a redirect may follow the cut", () => {
    expect(classifyCall("claude", "Bash", logged(long("cat big.log"))).cls).toBe("unclassified");
    expect(classifyCall("claude", "Bash", logged(long("python3 script.py"))).cls).toBe("unclassified");
  });

  test("an edit or a verify visible before the cut stands", () => {
    expect(classifyCall("claude", "Bash", logged(long("cat > f.ts <<EOF\n"))).cls).toBe("edit");
    expect(classifyCall("claude", "Bash", logged(long("bun test engine/"))).cls).toBe("verify");
  });

  test("a call whose command field never made it into the log is unclassified", () => {
    const clipped = `{"description":"${"y".repeat(500)}`.slice(0, LOGGED_INPUT_CHARS);
    expect(classifyCall("claude", "Bash", clipped).cls).toBe("unclassified");
  });

  test("the workspace's own verifyCommand counts as verify, whatever it is", () => {
    expect(classifyShell("./scripts/ci.sh --fast", { verifyCommand: "./scripts/ci.sh" }).cls).toBe("verify");
    expect(classifyShell("./scripts/ci.sh --fast").cls).toBe("other");
  });

  test("redirects that write nowhere are not edits; edit beats verify", () => {
    expect(classifyShell("bun test 2>&1 | tail -20").cls).toBe("verify");
    expect(classifyShell("ls > /dev/null").cls).toBe("inspect");
    expect(classifyShell("bun test > results.txt")).toEqual({ cls: "edit", path: "results.txt" });
    expect(classifyShell("cd web && bun test").cls).toBe("verify");
    expect(classifyShell("echo done | tee -a notes.md")).toEqual({ cls: "edit", path: "notes.md" });
    expect(classifyShell("git apply fix.patch").cls).toBe("edit");
  });
});
