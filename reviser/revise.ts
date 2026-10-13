#!/usr/bin/env bun
/**
 * Howdah reviser v0 — GEPA-method reflective prompt revision as a standalone script.
 * (Eng review D5: script first, graduates to a graph once the engine exists.)
 *
 *   bun reviser/revise.ts <prompt-id> [--instances <file>] [--out <dir>] [--evidence-from <includer-id>] [--root <repo>]
 *
 * Pipeline (one model call, per GEPA: reflect over feedback + evidence, propose a mutation):
 *
 *   prompts/<id>.md ──┐
 *   feedback/<id>.jsonl ──┼──▶ reflection prompt ──▶ `claude -p` ──▶ proposal vN+1
 *   [instances/outcomes] ─┘                                          + unified diff
 *
 * The proposal carries base_version (eng review D7): accept tooling must refuse a stale base.
 * Nothing changes behaviour until a human accepts the diff (shaping R2).
 *
 * Includes (system-map 1c review):
 *   - A prompt that `{{> id }}`-includes others is revised as ITS OWN text only. The model sees
 *     each included prompt's text in a clearly marked read-only block, and is told to keep every
 *     `{{> id }}` line exactly. The proposal records `base_includes` (every included prompt's
 *     version), so accepting it is refused if one of them moved since (prompts/store.ts), and
 *     accepting a revision that changes the include lines is refused unless marked `fork: true`.
 *   - A PARTIAL (`_`-prefixed id, e.g. `slice._design`) is never rendered on its own, so it has no
 *     feedback of its own. Chosen rule: revising one is refused unless `--evidence-from
 *     <includer-id>` names a prompt that includes it; that includer's feedback is the evidence,
 *     and the model is told the feedback judged the includer's renders, of which the partial is
 *     one part. (Aggregating every includer's feedback was rejected: feedback on unrelated parts
 *     of each includer would drown the part the partial owns.)
 *
 * Behavioural evidence (HOW-35): every run under $HOWDAH_HOME/runs that rendered the evidence
 * prompt contributes its node@visit trajectory profile (log/trajectory.ts) — derived by rule,
 * not judged — and the reflection gets a `BEHAVIOURAL EVIDENCE` block summarising them ("in 7
 * of 9 visits this prompt's node ran verification 3+ times after its last edit"). The block is
 * left out entirely when no run has tool data, so a prompt with none reads exactly as before.
 * Under HOWDAH_STUB=1 no model is called: the reflection prompt is written next to where the
 * proposal would go and the script exits, which is how the pipeline is tested without tokens.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { expandIncludes, isPartialId, splitFrontMatter } from "../core/template";
import { readLog } from "../log/write";
import { deriveProfile, type TrajectoryProfile, type TrajectoryData } from "../log/trajectory";
import { howdahHome } from "../config/config";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");

export interface PromptSource {
  version: number;
  body: string;
  raw: string;
}

export function loadPrompt(id: string, root = ROOT): PromptSource {
  const raw = readFileSync(join(root, "prompts", `${id}.md`), "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m || m[1] === undefined || m[2] === undefined) throw new Error(`prompts/${id}.md has no front-matter`);
  const vm = m[1].match(/^version:\s*(\d+)/m);
  if (!vm || vm[1] === undefined) throw new Error(`prompts/${id}.md front-matter has no version`);
  return { version: Number(vm[1]), body: m[2], raw };
}

export function loadFeedback(id: string, root = ROOT): Array<Record<string, unknown>> {
  const p = join(root, "feedback", `${id}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** A prompt this one includes: its id, current version and (expanded) text. */
export interface IncludedPrompt {
  id: string;
  version: number;
  text: string;
}

/** Every prompt `body` includes, transitively, in first-use order, with its expanded text. */
export function includedPrompts(id: string, body: string, root = ROOT): IncludedPrompt[] {
  const bodyOf = (i: string) => splitFrontMatter(readFileSync(join(root, "prompts", `${i}.md`), "utf8")).body;
  const { included } = expandIncludes(body, bodyOf, [id]);
  return included.map((i) => ({ id: i, version: loadPrompt(i, root).version, text: expandIncludes(bodyOf(i), bodyOf, [id, i]).text }));
}

/** Where the evidence for revising `id` comes from — itself, or (partials) a named includer. */
export function evidenceSource(id: string, evidenceFrom: string | undefined, root = ROOT): string {
  if (!isPartialId(id)) {
    if (evidenceFrom !== undefined && evidenceFrom !== id) throw new Error(`--evidence-from is only for partials; ${id} has feedback of its own`);
    return id;
  }
  if (evidenceFrom === undefined)
    throw new Error(
      `${id} is a partial: it is never rendered on its own, so it has no feedback of its own to revise from. ` +
        `Run with --evidence-from <includer-id> — a prompt that includes it — to revise it from that prompt's feedback`,
    );
  const includer = loadPrompt(evidenceFrom, root);
  if (!includedPrompts(evidenceFrom, includer.body, root).some((p) => p.id === id))
    throw new Error(`--evidence-from ${evidenceFrom} does not include ${id}, so its feedback says nothing about it`);
  return evidenceFrom;
}

/**
 * HOW-35: the profile of every node@visit, in any run under `home`/runs, that rendered `promptId`
 * (directly, or — for an includer's evidence — as the prompt that did). Visits with no tool data
 * are returned too, as `no-data`, so the summary can say how many there were.
 */
export function loadProfiles(promptId: string, home = howdahHome()): TrajectoryProfile[] {
  const runs = join(home, "runs");
  if (!existsSync(runs)) return [];
  const out: TrajectoryProfile[] = [];
  for (const run of readdirSync(runs).sort()) {
    const path = join(runs, run, "run.jsonl");
    if (!existsSync(path)) continue;
    const events = readLog(path);
    const seen = new Set<string>();
    for (const e of events) {
      if (e.type !== "prompt-rendered" || e.prompt !== promptId) continue;
      const key = `${e.node}@${e.visit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(deriveProfile(events, e.node, e.visit));
    }
  }
  return out;
}

/**
 * HOW-35: the profiles in sentences a reflection can act on, or undefined when no visit has
 * tool data (the block is then omitted). Counts are "in X of N visits", never percentages of a
 * handful — the reader should see how little evidence there is when there is little.
 */
export function summariseProfiles(profiles: readonly TrajectoryProfile[]): string | undefined {
  const data = profiles.filter((p): p is TrajectoryData => p.status === "ok");
  if (data.length === 0) return undefined;
  const n = data.length;
  const of = (k: number) => `${k} of ${n} visit${n === 1 ? "" : "s"}`;
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  };
  const lines = [
    `${n} visit${n === 1 ? "" : "s"} with tool data${profiles.length > n ? ` (${profiles.length - n} more with none logged)` : ""}.`,
    `Median calls per visit: ${median(data.map((p) => p.calls.inspect))} inspect, ${median(data.map((p) => p.calls.edit))} edit, ${median(data.map((p) => p.calls.verify))} verify, ${median(data.map((p) => p.calls.other))} other.`,
  ];
  const lateVerify = data.filter((p) => (p.verify_after_last_edit ?? 0) >= 3).length;
  if (lateVerify) lines.push(`In ${of(lateVerify)} this prompt's node ran verification 3+ times after its last edit.`);
  const noEdit = data.filter((p) => p.ended_without_edit === true).length;
  if (noEdit) lines.push(`In ${of(noEdit)} it ended without editing any file.`);
  const repatched = data.filter((p) => p.repatch_count > 0).length;
  if (repatched) lines.push(`In ${of(repatched)} it edited a file it had already edited (re-patch).`);
  const looping = data.filter((p) => p.longest_identical_streak >= 5).length;
  if (looping) lines.push(`In ${of(looping)} it repeated one identical call 5+ times in a row.`);
  const abnormal = new Map<string, number>();
  for (const p of data) if (p.termination !== "succeeded" && p.termination !== "failed") abnormal.set(p.termination, (abnormal.get(p.termination) ?? 0) + 1);
  for (const [t, k] of abnormal) lines.push(`${k} visit${k === 1 ? "" : "s"} ended ${t}.`);
  return lines.map((l) => `- ${l}`).join("\n");
}

export function buildReflection(
  id: string,
  version: number,
  body: string,
  feedback: Array<Record<string, unknown>>,
  opts: { instances?: string; included?: IncludedPrompt[]; evidenceFrom?: string; behaviour?: string } = {},
): string {
  const fb = feedback
    .map((f, i) => `FEEDBACK ${i + 1} (run ${f.run}, node ${f.node}@${f.visit}, verdict: ${f.verdict}):\n${f.note}`)
    .join("\n\n");
  const included = opts.included ?? [];
  const includesSection = included.length
    ? `
INCLUDED PROMPTS (read-only context). The current prompt contains \`{{> id }}\` lines; when a run starts, each is replaced by the named prompt's text, shown below. Those are SEPARATE prompts with their own versions and feedback:
- keep every \`{{> id }}\` line in your revision EXACTLY as it is, where it is;
- do not copy included text into your revision, and do not edit it here — a change it needs belongs in a revision of that prompt.
${included.map((p) => `<<<INCLUDED ${p.id} v${p.version}\n${p.text}\nINCLUDED ${p.id}>>>`).join("\n")}
`
    : "";
  const evidenceNote =
    opts.evidenceFrom && opts.evidenceFrom !== id
      ? `\nNOTE: ${id} is a partial — it is only ever rendered inside other prompts. The feedback below judged renders of ${opts.evidenceFrom}, which includes it: act only on the parts of that feedback that concern the text ${id} owns.\n`
      : "";
  return `You are a prompt engineer improving one prompt in an agent workflow, using the GEPA method: reflect on what the current prompt produced, what the human's feedback says went wrong, and propose ONE revised prompt.

RULES:
- Preserve every existing constraint and behaviour of the current prompt that the feedback does not ask to change. Do not drop instructions, do not reorder sections without cause, do not change the declared outputs.
- Apply the feedback precisely: encode what the human asked for as durable instructions, not as one-off patches.
- Keep the prompt's voice and format consistent with the original.
- Change as little as possible while fully satisfying the feedback.${included.length ? "\n- Keep every `{{> id }}` include line exactly (see INCLUDED PROMPTS)." : ""}

CURRENT PROMPT (id: ${id}, version: ${version}):
<<<PROMPT
${body}
PROMPT>>>
${includesSection}${evidenceNote}
HUMAN FEEDBACK:
${fb}
${opts.instances ? `\nRENDERED INSTANCES AND OUTCOMES (evidence):\n${opts.instances}\n` : ""}${opts.behaviour ? `\nBEHAVIOURAL EVIDENCE (derived by rule from the tool calls of past runs of this prompt — what the agent DID, not what it said; weigh it alongside the feedback, and do not invent a change it does not support):\n${opts.behaviour}\n` : ""}
FIRST: in 3-5 bullet lines, reflect on exactly what the feedback demands and where in the prompt it belongs (this is your reasoning, shown to the human).
THEN: output the complete revised prompt between the markers <<<REVISED and REVISED>>> with nothing else inside them.`;
}

/** The proposal file: front-matter (with base_includes when the prompt includes others) + body. */
export function proposalFile(id: string, version: number, included: IncludedPrompt[], revised: string, created = new Date().toISOString()): string {
  const baseIncludes = included.length ? `base_includes: ${JSON.stringify(Object.fromEntries(included.map((p) => [p.id, p.version])))}\n` : "";
  return `---\nid: ${id}\nbase_version: ${version}\n${baseIncludes}proposed_version: ${version + 1}\nstatus: pending\ncreated: ${created}\n---\n${revised}`;
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

function parseArgs(argv: string[]) {
  const [id, ...rest] = argv;
  if (!id) {
    console.error("usage: bun reviser/revise.ts <prompt-id> [--instances <file>] [--out <dir>] [--evidence-from <includer-id>]");
    process.exit(2);
  }
  const get = (flag: string) => {
    const i = rest.indexOf(flag);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const root = get("--root") ?? ROOT;
  return { id, instances: get("--instances"), out: get("--out") ?? join(root, "reviser", "proposals"), evidenceFrom: get("--evidence-from"), root };
}

if (import.meta.main) {
  const { id, instances, out, evidenceFrom, root } = parseArgs(process.argv.slice(2));
  let source: string;
  try {
    source = evidenceSource(id, evidenceFrom, root);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const { version, body } = loadPrompt(id, root);
  const included = includedPrompts(id, body, root);
  const feedback = loadFeedback(source, root);
  if (feedback.length === 0) {
    console.error(`no feedback recorded for ${source} — nothing to revise from`);
    process.exit(1);
  }
  const instancesText = instances ? readFileSync(instances, "utf8") : undefined;

  console.error(`revising ${id} v${version} from ${feedback.length} feedback entr${feedback.length === 1 ? "y" : "ies"}${source !== id ? ` on ${source}` : ""}…`);
  const behaviour = summariseProfiles(loadProfiles(source));
  const reflectionPrompt = buildReflection(id, version, body, feedback, { instances: instancesText, included, evidenceFrom: source, behaviour });
  if (process.env.HOWDAH_STUB) {
    // no tokens: show what the model WOULD have been asked, and stop
    mkdirSync(out, { recursive: true });
    const path = join(out, `${id}.v${version + 1}.reflection-prompt.md`);
    writeFileSync(path, reflectionPrompt);
    console.log(`HOWDAH_STUB: reflection prompt written to ${path}; no model was called`);
    process.exit(0);
  }
  const answer = runClaude(reflectionPrompt);

  const m = answer.match(/<<<REVISED\n?([\s\S]*?)\n?REVISED>>>/);
  if (!m || m[1] === undefined) {
    console.error("model output contained no <<<REVISED>>> block:\n" + answer.slice(0, 800));
    process.exit(1);
  }
  const revised = m[1];
  const reflection = answer.slice(0, answer.indexOf("<<<REVISED")).trim();

  mkdirSync(out, { recursive: true });
  const proposalPath = join(out, `${id}.v${version + 1}.proposal.md`);
  writeFileSync(proposalPath, proposalFile(id, version, included, revised));
  const diff = unifiedDiff(body, revised, proposalPath);
  writeFileSync(join(out, `${id}.v${version + 1}.diff`), diff);
  // the reflection is the model's stated reason for the change — the evidence a human judges
  // the diff against, so it is persisted next to the proposal instead of only printed
  writeFileSync(join(out, `${id}.v${version + 1}.reflection.md`), reflection + "\n");

  console.log(`REFLECTION:\n${reflection}\n`);
  console.log(`DIFF (current v${version} → proposed v${version + 1}):\n${diff}`);
  console.log(`proposal: ${proposalPath}`);
}
