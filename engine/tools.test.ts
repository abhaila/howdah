/**
 * HOW-41: a node's action space. Pinned: resolution order (tuning beats the TS node, readOnly
 * beats an allow list), the claude argv, a harness that cannot restrict tools REFUSING the
 * node (a park, not a crash, and not an unrestricted run) — including after a fallback hop —
 * the effective set logged on prompt-rendered, and the builder's advice on unknown names.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineGraph, type AgentConfig } from "../core/graph";
import { Engine, resolveAgentConfig, type AttemptResult } from "./run";
import { claudeArgs } from "../adapter/claude";
import { buildGraph, parseAgentConfig, specAdvice, isBlocking, type GraphSpec } from "../core/graph-spec";
import { pruneTuning } from "../config/tuning";
import { readLog } from "../log/write";

interface Ctx { goal: string; summary: string }
const graph = (node: AgentConfig & { readOnly?: true } = {}) => defineGraph<Ctx>({
  name: "tools", entry: "work", inputs: ["goal"],
  nodes: {
    work: { kind: "agent", prompt: "t.work" as never, reads: ["goal"], writes: { summary: { scope: "sticky" } }, ...node },
    done: { kind: "terminal", outcome: "success" },
  },
  edges: [{ from: "work", to: "done" }],
});
const def = (g: ReturnType<typeof graph>) => g.def.nodes.work as Extract<typeof g.def.nodes.work, { kind: "agent" }>;
function promptsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "howdah-tools-p-"));
  writeFileSync(join(dir, "t.work.md"), "---\nid: t.work\nversion: 1\n---\nDo {{ context.goal }}.\n");
  return dir;
}

describe("resolution", () => {
  test("a tuning override beats the TS node setting", () => {
    const g = graph({ tools: { deny: ["WebFetch"] } });
    expect(resolveAgentConfig(g, def(g), "work").tools).toEqual({ deny: ["WebFetch"] });
    const tuned = resolveAgentConfig(g, def(g), "work", { tuning: { nodes: { work: { tools: { allow: ["Bash"] } } } } });
    expect(tuned.tools).toEqual({ allow: ["Bash"] });
  });

  test("readOnly beats an allow list: a plan-mode node keeps its deny list and loses the allowance", () => {
    const g = graph({ readOnly: true, tools: { allow: ["Bash", "Edit"], deny: ["WebFetch"] } });
    expect(resolveAgentConfig(g, def(g), "work")).toMatchObject({ permissionMode: "plan", tools: { deny: ["WebFetch"] } });
    const onlyAllow = graph({ readOnly: true, tools: { allow: ["Bash"] } });
    expect(resolveAgentConfig(onlyAllow, def(onlyAllow), "work").tools).toBeUndefined();
    // and no override can put it back
    expect(resolveAgentConfig(onlyAllow, def(onlyAllow), "work", { overrides: { tools: { allow: ["Bash"] } } }).tools).toBeUndefined();
  });

  test("an empty tools setting in tuning.json is pruned, so it falls back rather than meaning 'nothing'", () => {
    expect(pruneTuning({ nodes: { work: { tools: {} } } })).toEqual({});
  });
});

describe("claude argv", () => {
  const after = (args: string[], flag: string) => args.slice(args.indexOf(flag) + 1, args.findIndex((a, i) => i > args.indexOf(flag) && a.startsWith("--")));
  test("allow", () => {
    const args = claudeArgs({ sessionId: "s", allowedTools: ["Read", "Bash(git *)"] });
    expect(after(args, "--allowedTools")).toEqual(["Read", "Bash(git *)"]);
    expect(args).not.toContain("--disallowedTools");
  });
  test("deny", () => {
    const args = claudeArgs({ sessionId: "s", disallowedTools: ["WebFetch"] });
    expect(after(args, "--disallowedTools")).toEqual(["WebFetch"]);
    expect(args).not.toContain("--allowedTools");
  });
  test("both, and neither", () => {
    const args = claudeArgs({ sessionId: "s", allowedTools: ["Read"], disallowedTools: ["Bash"] });
    expect(after(args, "--allowedTools")).toEqual(["Read"]);
    expect(after(args, "--disallowedTools")).toEqual(["Bash"]);
    expect(claudeArgs({ sessionId: "s" }).some((a) => a.includes("Tools"))).toBe(false);
  });
});

describe("a harness without tool flags refuses the node", () => {
  const ok = async (): Promise<AttemptResult> => ({ status: "succeeded", writes: { summary: "s" } });

  test("cursor: parks `tools-unsupported` before the node starts, naming the harness", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-tools-"));
    let ran = false;
    const engine = new Engine(graph({ harness: "cursor", tools: { deny: ["WebFetch"] } }), {
      dir, promptsDir: promptsDir(), executors: { agent: async () => { ran = true; return ok(); } },
    });
    const result = await engine.start({ goal: "g" });
    expect(result).toMatchObject({ state: "parked", node: "work", code: "tools-unsupported" });
    expect((result as { reason: string }).reason).toContain("cursor cannot restrict tools");
    expect(ran).toBe(false);
    expect(readLog(join(dir, "run.jsonl")).some((e) => e.type === "node-started")).toBe(false);
  });

  test("a claude → codex hop re-resolves the tool set, and parks because codex cannot honour it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-tools-hop-"));
    const seen: string[] = [];
    const engine = new Engine(graph({ tools: { allow: ["Read"] } }), {
      dir, promptsDir: promptsDir(),
      executors: {
        agent: async ({ agentConfig, log }) => {
          seen.push(agentConfig!.harness!);
          log.append({ type: "allowance", harness: agentConfig!.harness!, state: "exhausted" });
          return { status: "failed", writes: {} };
        },
      },
    });
    expect(await engine.start({ goal: "g" })).toMatchObject({ state: "parked", code: "tools-unsupported" });
    expect(seen).toEqual(["claude"]); // codex never ran unrestricted
  });

  test("claude runs, and the effective set is logged on prompt-rendered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-tools-ok-"));
    const engine = new Engine(graph({ tools: { allow: ["Read"], deny: ["WebFetch"] } }), { dir, promptsDir: promptsDir(), executors: { agent: ok } });
    expect(await engine.start({ goal: "g" })).toEqual({ state: "finished", outcome: "success" });
    const rendered = readLog(join(dir, "run.jsonl")).find((e) => e.type === "prompt-rendered");
    expect(rendered).toMatchObject({ tools: { allow: ["Read"], deny: ["WebFetch"] } });
  });
});

describe("the builder (GraphSpec)", () => {
  const spec = (tools: unknown): GraphSpec => ({
    version: 1, name: "toolish", description: "", inputs: ["goal"], entry: "draft",
    fields: [{ key: "goal", kind: "text", scope: "sticky" }, { key: "summary", kind: "text", scope: "sticky" }],
    nodes: [
      { id: "draft", kind: "agent", prompt: "toolish.draft", reads: ["goal"], writes: ["summary"], config: parseAgentConfig({ tools }) },
      { id: "done", kind: "terminal", outcome: "success" },
    ],
    edges: [{ from: "draft", to: "done" }],
  });

  test("tools round-trip through parseAgentConfig and compile onto the node", () => {
    expect(parseAgentConfig({ tools: { allow: ["Read", ""], deny: ["WebFetch"] } })).toEqual({ tools: { allow: ["Read"], deny: ["WebFetch"] } });
    expect(parseAgentConfig({ tools: { allow: [] } })).toBeUndefined();
    const node = buildGraph(spec({ deny: ["WebFetch"] })).def.nodes.draft;
    expect(node?.kind === "agent" && node.tools).toEqual({ deny: ["WebFetch"] });
  });

  test("an unknown tool name is ADVICE, never blocking (CLIs add tools)", () => {
    const advice = specAdvice(spec({ deny: ["WebFetch", "Bassh(git *)"] }));
    const tool = advice.filter((p) => p.message.includes("Bassh"));
    expect(tool).toHaveLength(1);
    expect(isBlocking(tool[0]!)).toBe(false);
    expect(specAdvice(spec({ deny: ["WebFetch", "Bash(git push *)"] })).some((p) => p.message.includes("does not ship"))).toBe(false);
  });
});
