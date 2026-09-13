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
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

export type GraphKind = "doc" | "research" | "code" | "custom";

const camel = (name: string) => name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());

function promptStub(id: string, body: string): string {
  return `---\nid: ${id}\nversion: 1\n---\n${body}\n`;
}

function docTemplate(name: string): { graph: string; prompts: Record<string, string> } {
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
import { defineGraph } from "../core/graph";

export interface ${v[0]!.toUpperCase()}${v.slice(1)}Ctx {
  goal: string;
  work: string;
  summary: string;
  review_verdict: "pass" | "reject";
  review_findings: unknown;
}

export const ${v} = defineGraph<${v[0]!.toUpperCase()}${v.slice(1)}Ctx>({
  name: "${name}",
  description: "TODO: one line on what this graph does",
  entry: "${name}.draft",
  inputs: ["goal", "work"],
  nodes: {
    "${name}.draft": {
      kind: "agent",
      prompt: "${name}.draft",
      reads: ["goal", "work"],
      writes: { summary: { scope: "sticky" } },
    },
    "${name}.review": {
      kind: "agent",
      prompt: "${name}.review",
      reads: ["goal", "summary"],
      writes: { review_verdict: { scope: "cleared" }, review_findings: { scope: "cleared" } },
    },
    "${name}.revise": {
      kind: "agent",
      prompt: "${name}.revise",
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

function customTemplate(name: string): { graph: string; prompts: Record<string, string> } {
  const v = camel(name);
  return {
    prompts: {
      [`${name}.work`]: promptStub(`${name}.work`, `Do the work. Goal: {{ context.goal }}\n\nReturn a summary of what you did.`),
    },
    graph: `/**
 * ${name} — scaffolded by \`howdah new-graph --kind custom\`. The smallest legal graph:
 * one agent, one terminal. Grow it node by node; validate() gates every shape.
 */
import { defineGraph } from "../core/graph";

export interface ${v[0]!.toUpperCase()}${v.slice(1)}Ctx {
  goal: string;
  summary: string;
}

export const ${v} = defineGraph<${v[0]!.toUpperCase()}${v.slice(1)}Ctx>({
  name: "${name}",
  description: "TODO: one line on what this graph does",
  entry: "${name}.work",
  inputs: ["goal"],
  nodes: {
    "${name}.work": {
      kind: "agent",
      prompt: "${name}.work",
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

export async function newGraph(name: string, kind: GraphKind): Promise<string> {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`graph name must be kebab-case: "${name}"`);
  const graphPath = join(ROOT, "graphs", `${name}.ts`);
  if (existsSync(graphPath)) throw new Error(`graphs/${name}.ts already exists`);

  // research/code reuse the doc shape for now; code additionally needs worktree nodes —
  // copy implement-ticket as the reference until a dedicated template earns its keep
  const t = kind === "custom" ? customTemplate(name) : docTemplate(name);

  const written: string[] = [graphPath];
  writeFileSync(graphPath, t.graph);
  for (const [id, body] of Object.entries(t.prompts)) {
    const p = join(ROOT, "prompts", `${id}.md`);
    written.push(p);
    writeFileSync(p, body);
  }

  // register in graphs/index.ts
  const indexPath = join(ROOT, "graphs", "index.ts");
  const index = readFileSync(indexPath, "utf8");
  const v = camel(name);
  const updated = index
    .replace(`import { research } from "./research";`, `import { research } from "./research";\nimport { ${v} } from "./${name}";`)
    .replace(`  [research.def.name]: research,`, `  [research.def.name]: research,\n  [${v}.def.name]: ${v},`);
  if (updated === index) throw new Error("could not register in graphs/index.ts — anchors moved");

  try {
    // gates: prompt ids regenerate, then the graph must import + validate clean
    writeFileSync(indexPath, updated);
    const codegen = Bun.spawnSync(["bun", join(ROOT, "prompts", "codegen.ts")], { stdout: "pipe", stderr: "pipe" });
    if (codegen.exitCode !== 0) throw new Error(`codegen failed: ${new TextDecoder().decode(codegen.stderr)}`);
    const probe = Bun.spawnSync(
      ["bun", "-e", `const { GRAPHS } = await import(${JSON.stringify(indexPath)}); GRAPHS[${JSON.stringify(name)}].validateOrThrow(); console.log("valid");`],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (probe.exitCode !== 0) throw new Error(`scaffold does not validate: ${new TextDecoder().decode(probe.stderr).slice(0, 400)}`);
  } catch (err) {
    // roll the scaffold back — never leave a broken registry
    writeFileSync(indexPath, index);
    for (const f of written) unlinkSync(f);
    Bun.spawnSync(["bun", join(ROOT, "prompts", "codegen.ts")]);
    throw err;
  }

  return graphPath;
}

if (import.meta.main) {
  const [name, ...rest] = process.argv.slice(2);
  const kind = (rest[rest.indexOf("--kind") + 1] ?? "custom") as GraphKind;
  try {
    const path = await newGraph(name ?? "", kind);
    console.log(`scaffolded ${path} (${kind}) — edit the prompts, then: howdah run ${name}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
