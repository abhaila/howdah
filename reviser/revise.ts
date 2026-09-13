#!/usr/bin/env bun
/**
 * Howdah reviser v0 — GEPA-method reflective prompt revision as a standalone script.
 * (Eng review D5: script first, graduates to a graph once the engine exists.)
 *
 *   bun reviser/revise.ts <prompt-id> [--instances <file>] [--out <dir>]
 *
 * Pipeline (one model call, per GEPA: reflect over feedback + evidence, propose a mutation):
 *
 *   prompts/<id>.md ──┐
 *   feedback/<id>.jsonl ──┼──▶ reflection prompt ──▶ `claude -p` ──▶ proposal vN+1
 *   [instances/outcomes] ─┘                                          + unified diff
 *
 * The proposal carries base_version (eng review D7): accept tooling must refuse a stale base.
 * Nothing changes behaviour until a human accepts the diff (shaping R2).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");

function parseArgs(argv: string[]) {
  const [id, ...rest] = argv;
  if (!id) {
    console.error("usage: bun reviser/revise.ts <prompt-id> [--instances <file>] [--out <dir>]");
    process.exit(2);
  }
  const get = (flag: string) => {
    const i = rest.indexOf(flag);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  return { id, instances: get("--instances"), out: get("--out") ?? join(ROOT, "reviser", "proposals") };
}

function loadPrompt(id: string): { version: number; body: string; raw: string } {
  const raw = readFileSync(join(ROOT, "prompts", `${id}.md`), "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`prompts/${id}.md has no front-matter`);
  const vm = m[1].match(/^version:\s*(\d+)/m);
  if (!vm) throw new Error(`prompts/${id}.md front-matter has no version`);
  return { version: Number(vm[1]), body: m[2], raw };
}

function loadFeedback(id: string): Array<Record<string, unknown>> {
  const p = join(ROOT, "feedback", `${id}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function buildReflection(id: string, version: number, body: string, feedback: Array<Record<string, unknown>>, instances?: string): string {
  const fb = feedback
    .map((f, i) => `FEEDBACK ${i + 1} (run ${f.run}, node ${f.node}@${f.visit}, verdict: ${f.verdict}):\n${f.note}`)
    .join("\n\n");
  return `You are a prompt engineer improving one prompt in an agent workflow, using the GEPA method: reflect on what the current prompt produced, what the human's feedback says went wrong, and propose ONE revised prompt.

RULES:
- Preserve every existing constraint and behaviour of the current prompt that the feedback does not ask to change. Do not drop instructions, do not reorder sections without cause, do not change the declared outputs.
- Apply the feedback precisely: encode what the human asked for as durable instructions, not as one-off patches.
- Keep the prompt's voice and format consistent with the original.
- Change as little as possible while fully satisfying the feedback.

CURRENT PROMPT (id: ${id}, version: ${version}):
<<<PROMPT
${body}
PROMPT>>>

HUMAN FEEDBACK:
${fb}
${instances ? `\nRENDERED INSTANCES AND OUTCOMES (evidence):\n${instances}\n` : ""}
FIRST: in 3-5 bullet lines, reflect on exactly what the feedback demands and where in the prompt it belongs (this is your reasoning, shown to the human).
THEN: output the complete revised prompt between the markers <<<REVISED and REVISED>>> with nothing else inside them.`;
}

function runClaude(prompt: string): string {
  const res = spawnSync("claude", ["-p", "--output-format", "json", "--permission-mode", "plan"], {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 240_000,
  });
  if (res.status !== 0) throw new Error(`claude -p failed (${res.status}): ${res.stderr?.slice(0, 400)}`);
  const parsed = JSON.parse(res.stdout);
  if (parsed.is_error) throw new Error(`claude returned error: ${String(parsed.result).slice(0, 400)}`);
  return String(parsed.result);
}

function unifiedDiff(a: string, b: string, out: string): string {
  const dir = dirname(out);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".a.tmp"), a.endsWith("\n") ? a : a + "\n");
  writeFileSync(join(dir, ".b.tmp"), b.endsWith("\n") ? b : b + "\n");
  const res = spawnSync("diff", ["-u", "--label", "current", "--label", "proposed", join(dir, ".a.tmp"), join(dir, ".b.tmp")], {
    encoding: "utf8",
  });
  return res.stdout ?? "";
}

const { id, instances, out } = parseArgs(process.argv.slice(2));
const { version, body } = loadPrompt(id);
const feedback = loadFeedback(id);
if (feedback.length === 0) {
  console.error(`no feedback recorded for ${id} — nothing to revise from`);
  process.exit(1);
}
const instancesText = instances ? readFileSync(instances, "utf8") : undefined;

console.error(`revising ${id} v${version} from ${feedback.length} feedback entr${feedback.length === 1 ? "y" : "ies"}…`);
const answer = runClaude(buildReflection(id, version, body, feedback, instancesText));

const m = answer.match(/<<<REVISED\n?([\s\S]*?)\n?REVISED>>>/);
if (!m) {
  console.error("model output contained no <<<REVISED>>> block:\n" + answer.slice(0, 800));
  process.exit(1);
}
const revised = m[1];
const reflection = answer.slice(0, answer.indexOf("<<<REVISED")).trim();

mkdirSync(out, { recursive: true });
const proposalPath = join(out, `${id}.v${version + 1}.proposal.md`);
writeFileSync(
  proposalPath,
  `---\nid: ${id}\nbase_version: ${version}\nproposed_version: ${version + 1}\nstatus: pending\ncreated: ${new Date().toISOString()}\n---\n${revised}`,
);
const diff = unifiedDiff(body, revised, proposalPath);
writeFileSync(join(out, `${id}.v${version + 1}.diff`), diff);

console.log(`REFLECTION:\n${reflection}\n`);
console.log(`DIFF (current v${version} → proposed v${version + 1}):\n${diff}`);
console.log(`proposal: ${proposalPath}`);
