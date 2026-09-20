#!/usr/bin/env bun
/**
 * howdah new-graph (T20): scaffold a runnable graph + its prompt stubs.
 *
 *   howdah new-graph <name> --kind doc|research|code|custom
 *
 * Authoring stays TS-native (eng review D2): the scaffolder writes the file, your IDE and
 * `tsc` + validate() are the editor — there is no visual editor to drift out of sync.
 * The scaffold: graphs/<name>.ts, prompts/<name>.*.md, registration in graphs/index.ts,
 * prompt-id regeneration, and a validation gate — a scaffold that does not validate is
 * rolled back.
 */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureLocalDirs, LOCAL_NAME, loadLocalGraph, localGraphPath, localPromptsDir } from "../graphs/local";
import { howdahHome } from "../config/config";

const ROOT = join(import.meta.dir, "..");

export type GraphKind = "doc" | "research" | "code" | "custom";

const camel = (name: string) => name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());

function promptStub(id: string, body: string): string {
  return `---\nid: ${id}\nversion: 1\n---\n${body}\n`;
}

function docTemplate(name: string, coreGraph: string): { graph: string; prompts: Record<string, string> } {
  const v = camel(name);
  return {
    prompts: {
      [`${name}.draft`]: promptStub(`${name}.draft`, `Do the work. Goal: {{ context.goal }}\n\nWork item: {{ context.work }}\n\nProduce the deliverable in the working folder and return a summary.`),
      [`${name}.review`]: promptStub(`${name}.review`, `Review the work against the goal. Goal: {{ context.goal }}\n\nSummary so far: {{ context.summary }}\n\nVerdict "pass" only if the goal is met; otherwise "reject" with specific findings.`),
      [`${name}.revise`]: promptStub(`${name}.revise`, `Resolve the review findings. Goal: {{ context.goal }}\n\nCurrent summary: {{ context.summary }}\n\nFindings: {{ context.review_findings }}\n\nEdit the deliverable and return an updated summary.`),
    },
    graph: `/**
 * ${name} — scaffolded by \`howdah new-graph --kind doc\`. Plain-folder graph:
 * no worktree, no forge; terminates on the reviewer's verdict (R5).
 */
import { defineGraph, type PromptRef } from "${coreGraph}";

/**
 * Prompt ids of a LOCAL graph are not in the generated PromptId union — that union is built
 * from the Howdah repo's own prompts/, and these live beside this file in $HOWDAH_HOME.
 * Howdah checks every id here resolves to a real .md before the graph is ever runnable.
 */
const prompt = (id: string) => id as PromptRef;

export interface ${v[0]!.toUpperCase()}${v.slice(1)}Ctx {
  goal: string;
  work: string;
  summary: string;
  review_verdict: "pass" | "reject";
  review_findings: unknown;
}

export const ${v} = defineGraph<${v[0]!.toUpperCase()}${v.slice(1)}Ctx>({
  name: "${name}",
  // Claude runs in auto mode by default; Codex uses full-access sandboxing in its executor.
  defaults: { permissionMode: "auto" },
  description: "TODO: one line on what this graph does",
  entry: "${name}.draft",
  inputs: ["goal", "work"],
  nodes: {
    "${name}.draft": {
      kind: "agent",
      prompt: prompt("${name}.draft"),
      reads: ["goal", "work"],
      writes: { summary: { scope: "sticky" } },
    },
    "${name}.review": {
      kind: "agent",
      prompt: prompt("${name}.review"),
      reads: ["goal", "summary"],
      writes: { review_verdict: { scope: "cleared" }, review_findings: { scope: "cleared" } },
    },
    "${name}.revise": {
      kind: "agent",
      prompt: prompt("${name}.revise"),
      reads: ["goal", "summary", "review_findings"],
      writes: { summary: { scope: "sticky" } },
      maxVisits: 3,
    },
    done: { kind: "terminal", outcome: "success" },
  },
  edges: [
    { from: "${name}.draft", to: "${name}.review" },
    {
      from: "${name}.review",
      to: "${name}.revise",
      condition: { reads: ["review_verdict"], test: (v) => v.review_verdict === "reject", label: "review_verdict == 'reject'" },
      weight: 2,
    },
    {
      from: "${name}.review",
      to: "done",
      condition: { reads: ["review_verdict"], test: (v) => v.review_verdict === "pass", label: "review_verdict == 'pass'" },
      weight: 1,
    },
    { from: "${name}.revise", to: "${name}.review" },
  ],
});
`,
  };
}

function customTemplate(name: string, coreGraph: string): { graph: string; prompts: Record<string, string> } {
  const v = camel(name);
  return {
    prompts: {
      [`${name}.work`]: promptStub(`${name}.work`, `Do the work. Goal: {{ context.goal }}\n\nReturn a summary of what you did.`),
    },
    graph: `/**
 * ${name} — scaffolded by \`howdah new-graph --kind custom\`. The smallest legal graph:
 * one agent, one terminal. Grow it node by node; validate() gates every shape.
 */
import { defineGraph, type PromptRef } from "${coreGraph}";

/**
 * Prompt ids of a LOCAL graph are not in the generated PromptId union — that union is built
 * from the Howdah repo's own prompts/, and these live beside this file in $HOWDAH_HOME.
 * Howdah checks every id here resolves to a real .md before the graph is ever runnable.
 */
const prompt = (id: string) => id as PromptRef;

export interface ${v[0]!.toUpperCase()}${v.slice(1)}Ctx {
  goal: string;
  summary: string;
}

export const ${v} = defineGraph<${v[0]!.toUpperCase()}${v.slice(1)}Ctx>({
  name: "${name}",
  // Claude runs in auto mode by default; Codex uses full-access sandboxing in its executor.
  defaults: { permissionMode: "auto" },
  description: "TODO: one line on what this graph does",
  entry: "${name}.work",
  inputs: ["goal"],
  nodes: {
    "${name}.work": {
      kind: "agent",
      prompt: prompt("${name}.work"),
      reads: ["goal"],
      writes: { summary: { scope: "sticky" } },
    },
    done: { kind: "terminal", outcome: "success" },
  },
  edges: [{ from: "${name}.work", to: "done" }],
});
`,
  };
}

/**
 * Scaffold a LOCAL graph into `$HOWDAH_HOME` (D9). Nothing is written into this repo, so
 * `graphs/index.ts` is never machine-edited — the old path string-replaced anchors in it and
 * failed with "anchors moved" when they drifted, leaving the written files behind.
 *
 * The gate is the same one a save passes: the graph must import, validate, and name prompt
 * files that exist. A scaffold that does not is rolled back whole.
 */
export async function newGraph(name: string, kind: GraphKind, home: string, repoRoot = ROOT): Promise<string> {
  if (!LOCAL_NAME.test(name)) throw new Error(`graph name must be kebab-case: "${name}"`);
  const graphPath = localGraphPath(home, name);
  if (existsSync(graphPath)) throw new Error(`${name} already exists at ${graphPath}`);

  ensureLocalDirs(home);
  // research/code reuse the doc shape for now; code additionally needs worktree nodes —
  // copy implement-ticket as the reference until a dedicated template earns its keep
  const coreGraph = join(repoRoot, "core", "graph");
  const t = kind === "custom" ? customTemplate(name, coreGraph) : docTemplate(name, coreGraph);

  const written: string[] = [graphPath];
  writeFileSync(graphPath, t.graph);
  for (const [id, body] of Object.entries(t.prompts)) {
    const p = join(localPromptsDir(home), `${id}.md`);
    written.push(p);
    writeFileSync(p, body);
  }

  try {
    await loadLocalGraph(home, name, repoRoot);
  } catch (err) {
    for (const f of written) if (existsSync(f)) unlinkSync(f);
    throw new Error(`scaffold does not validate: ${err instanceof Error ? err.message : String(err)}`);
  }
  return graphPath;
}

if (import.meta.main) {
  const [name, ...rest] = process.argv.slice(2);
  const kind = (rest[rest.indexOf("--kind") + 1] ?? "custom") as GraphKind;
  try {
    const path = await newGraph(name ?? "", kind, howdahHome());
    console.log(`scaffolded ${path} (${kind}) — edit the prompts, then: howdah run ${name}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
