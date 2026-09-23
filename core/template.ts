/**
 * The prompt template contract — ONE implementation of "what `{{ context.x }}` means",
 * shared by everything that touches a rendered prompt (T21).
 *
 * Three callers depend on identical behaviour:
 *   engine/run.ts        renders the pinned template and hashes the result (rendered_hash)
 *   prompts/store.ts     extracts the reads a revision introduces (OV-3 accept guard)
 *   prompts/library.ts   RECONSTRUCTS a past render from the pinned file + context_read
 *                        and proves it by re-hashing to the recorded rendered_hash
 *
 * The third caller is why this file exists: the log stores the hash, not the text, so the
 * reconstruction is only trustworthy while it renders byte-identically to the engine. Two
 * copies of this regex would make hash verification a coin toss the first time one drifted.
 *
 * system-map 0.1: the same holds for everything APPENDED to the template. The skill hint
 * and outputs contract used to be bolted on inside the executors, after hashing, so
 * rendered_hash never covered the bytes the agent actually read. Every suffix is now built
 * here, assembled by assemblePrompt() in one fixed order, and applied by the engine BEFORE
 * hashing; executors send the result unchanged. Suffix wording is keyed by SUFFIX_VERSION
 * (logged on prompt-rendered), so rewording a suffix bumps the version instead of silently
 * turning every earlier render UNVERIFIED.
 *
 * system-map 0.2: an operator's reply to a failed agent attempt is rendered into the
 * retried prompt. Its wording is a versioned builder like the others — v2 is v1 plus
 * replyInstruction, and v1 stays byte-for-byte what it was.
 *
 * system-map 1c: v3 = v2 + refusalInstruction — when the graph's validateProposal refused a
 * proposer's output, the retried attempt is told WHY (the validator's errors), so it can fix
 * them instead of drawing the same thing again. Its source is the refusal logged on that
 * attempt's node-finished (engine/replay.ts refusalNote), so reconstruction rebuilds it.
 *
 * Includes (system-map 1c review): `{{> prompt.id }}` pulls another prompt file's body in AT
 * PIN TIME — expandIncludes() runs when a run pins its prompts, and the pinned file holds the
 * expanded text. Rendering, rendered_hash and reconstruction therefore never see an include:
 * the single-renderer invariant holds unchanged. The prompt store's undeclared-read guard and
 * the codegen check expand through the same function.
 */
import { createHash } from "node:crypto";
import { harnessSpec, isHarness } from "./harnesses";
import { isEngineNamespace, templateRefPattern } from "./template-refs";
import type { Harness } from "./graph";

/**
 * HOW-22: the reference grammar itself lives in core/template-refs.ts, which is node-free so
 * the viewer can bundle it (the graph builder needs templateReads live, in the browser).
 * Re-exported here because this file is still the one place a caller asks about templates —
 * the split moved the regex, it did not add a second one.
 */
export { TEMPLATE_REF, templateRefPattern, isEngineNamespace, templateReads } from "./template-refs";

/**
 * Substitute every ref via `resolve`. Strings interpolate raw, everything else as JSON —
 * the engine's rule, kept here so reconstruction matches it. `resolve` may throw (the
 * engine's ContextStore does, on an unreadable key) and the throw propagates untouched.
 */
export function renderTemplate(
  body: string,
  resolve: (key: string) => unknown,
): { text: string; read: Record<string, unknown> } {
  const read: Record<string, unknown> = {};
  const text = body.replace(templateRefPattern(), (whole: string, ns: string, key: string) => {
    if (isEngineNamespace(ns, key)) return whole;
    const value = resolve(key);
    read[key] = value;
    return typeof value === "string" ? value : JSON.stringify(value);
  });
  return { text, read };
}

/** The `rendered_hash` join key: first 16 hex of sha256 over the FINAL text as sent — template + every suffix (system-map 0.1). */
export function renderedHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * The suffix an operator jump appends to the target node's next render. Shared because
 * reconstruction has to reproduce it byte-for-byte to verify a jumped-into turn's hash.
 */
export function operatorInstructionSuffix(message: string): string {
  return `\n\n## Operator instruction\nThe operator moved the run to this step with this instruction — it takes precedence:\n${message}`;
}

// ---- suffixes (system-map 0.1) ---------------------------------------------------

/** The suffix wording new renders use. Bump it — and add a builder set — to reword. */
export const SUFFIX_VERSION = 3;

/** The versioned builders: what a render's `suffix_version` pins. */
export interface SuffixBuilders {
  /** names the node's skills; "" when there are none */
  skillHint(skills: readonly string[]): string;
  /** the outputs contract (T16) generated from the node's declared writes */
  outputContract(keys: readonly string[]): string;
  /**
   * system-map 0.2: the operator's reply to the park this attempt retries. Absent from
   * versions that predate it (v1) — such a version cannot have rendered a reply.
   */
  replyInstruction?(message: string): string;
  /**
   * system-map 1c: why the graph refused the previous attempt's proposal. Absent from versions
   * that predate it (v1, v2) — such a version cannot have rendered a refusal.
   */
  refusalInstruction?(reason: string): string;
}

/**
 * v1 is byte-for-byte what claude.ts / codex.ts appended before 0.1, so the text agents
 * read did not change when the proof moved to cover it. NEVER edit a published version.
 */
const V1: SuffixBuilders = {
  skillHint: (skills) =>
    skills.length ? `\n\nRelevant installed skills for this task: ${skills.map((s) => `/${s}`).join(", ")} — invoke them where they apply.` : "",
  outputContract: (keys) => {
    if (keys.length === 0)
      return "\n\n## Output\nWhen your work is complete, end your reply with a one-line summary of what you did.";
    return (
      `\n\n## Output contract (required)\n` +
      `When your work is complete, the LAST line of your reply must be a single JSON object of the form\n` +
      `{"outputs": {${keys.map((k) => `"${k}": <value>`).join(", ")}}}\n` +
      `containing exactly these keys: ${keys.join(", ")}. No markdown fence, no trailing text.`
    );
  },
};

/** v2 (system-map 0.2) = v1 + the operator reply suffix. NEVER edit a published version. */
const V2: SuffixBuilders = {
  ...V1,
  replyInstruction: (message) =>
    `\n\n## Operator reply\nThe previous attempt at this step failed and the run parked. The operator replied — take it into account on this attempt:\n${message}`,
};

/** v3 (system-map 1c) = v2 + the proposal-refusal suffix. NEVER edit a published version. */
const V3: SuffixBuilders = {
  ...V2,
  refusalInstruction: (reason) =>
    `\n\n## Your previous proposal was refused\nThe previous attempt at this step produced a proposal the graph's validator refused. Fix every problem below and return the corrected proposal:\n${reason}`,
};

const SUFFIX_BUILDERS: Readonly<Record<number, SuffixBuilders>> = { 1: V1, 2: V2, 3: V3 };
/** the builders new renders use; bump together with SUFFIX_VERSION */
const CURRENT: SuffixBuilders = V3;

/** The builders a logged `suffix_version` pins, or undefined for a version this code never had. */
export function suffixBuilders(version: number): SuffixBuilders | undefined {
  return Object.hasOwn(SUFFIX_BUILDERS, version) ? SUFFIX_BUILDERS[version] : undefined;
}

/** The current outputs contract — kept under its T16 name for callers and tests. */
export function buildOutputInstruction(keys: readonly string[]): string {
  return CURRENT.outputContract(keys);
}

/**
 * The skills that actually reach the prompt for a harness. Codex never got a skill hint and
 * still does not; claude and opencode (which runs through the claude executor) do; cursor
 * does not, because cursor-agent has no Claude Code skills and a hint would name tools it
 * cannot run. The result is what gets LOGGED as `skills`, so this must answer for the
 * prompt that was actually sent — a harness handed a hint it never got would break
 * reconstruction. HOW-17: that answer is a declared field on harnessSpec, never a default,
 * so a new harness cannot inherit claude's by omission — and a name the table does not know
 * (a hand-edited tuning.json) gets no hint rather than a throw, for the same reason: naming
 * Claude Code skills to an unidentified CLI is exactly the accident this field prevents.
 */
export function skillsForHarness(harness: Harness | undefined, skills: readonly string[] | undefined): string[] {
  if (harness === undefined) return [...(skills ?? [])];
  if (!isHarness(harness)) return [];
  if (!harnessSpec(harness).skillHint) return [];
  return [...(skills ?? [])];
}

export interface PromptParts {
  /** the rendered template body (renderTemplate's text) */
  body: string;
  /** operator jump instruction consumed by this render (built via operatorInstructionSuffix) */
  jumpMessage?: string;
  /**
   * system-map 0.2: the operator's reply to the park this attempt retries — the raw
   * message; the version's replyInstruction builder words it.
   */
  replyMessage?: string;
  /** system-map 1c: the validator's refusal of the previous attempt's proposal — raw text */
  refusalMessage?: string;
  /** skills named in the hint — already filtered by skillsForHarness */
  skills: readonly string[];
  /** the node's declared write keys, in declaration order */
  outputKeys: readonly string[];
  suffixVersion: number;
}

/**
 * The ONE assembly of a prompt as sent. Fixed order:
 *   template body → operator jump → operator reply (0.2) → proposal refusal (1c) → skill hint
 *   → outputs contract.
 * Throws on a suffix version with no builders — the engine only ever passes SUFFIX_VERSION,
 * and reconstruction checks suffixBuilders() first — and on a reply under a version with
 * no reply builder, which no engine ever produced.
 */
export function assemblePrompt(parts: PromptParts): string {
  const builders = suffixBuilders(parts.suffixVersion);
  if (!builders) throw new Error(`no builders for suffix version ${parts.suffixVersion}`);
  let reply = "";
  if (parts.replyMessage !== undefined) {
    if (!builders.replyInstruction) throw new Error(`suffix version ${parts.suffixVersion} has no reply builder`);
    reply = builders.replyInstruction(parts.replyMessage);
  }
  let refusal = "";
  if (parts.refusalMessage !== undefined) {
    if (!builders.refusalInstruction) throw new Error(`suffix version ${parts.suffixVersion} has no refusal builder`);
    refusal = builders.refusalInstruction(parts.refusalMessage);
  }
  return (
    parts.body +
    (parts.jumpMessage !== undefined ? operatorInstructionSuffix(parts.jumpMessage) : "") +
    reply +
    refusal +
    builders.skillHint(parts.skills) +
    builders.outputContract(parts.outputKeys)
  );
}

/** Split `---\nfront-matter\n---\nbody`; returns the whole text as body when absent. */
export function splitFrontMatter(raw: string): { frontmatter: string | null; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m || m[1] === undefined || m[2] === undefined) return { frontmatter: null, body: raw };
  return { frontmatter: m[1], body: m[2] };
}

/** A scalar front-matter field, or null. */
export function frontMatterField(frontmatter: string | null, name: string): string | null {
  if (!frontmatter) return null;
  const m = frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
  return m && m[1] !== undefined ? m[1].trim() : null;
}

// ---- includes (system-map 1c review) ----------------------------------------------------

/** `{{> prompt.id }}` — a pin-time include of another prompt file's body. */
const INCLUDE_REF = String.raw`\{\{>\s*([\w.-]+)\s*\}\}`;
/** includes may nest this deep (a partial including a partial); deeper is refused */
export const MAX_INCLUDE_DEPTH = 3;

export class IncludeError extends Error {}

/** The prompt ids a body includes directly, in order. */
export function includeRefs(body: string): string[] {
  return [...body.matchAll(new RegExp(INCLUDE_REF, "g"))].map((m) => m[1]!);
}

/**
 * Expand every `{{> id }}` with `load(id)` — the included prompt's BODY (front-matter already
 * stripped) — recursively, trailing whitespace of each included body trimmed. Refuses cycles,
 * nesting deeper than MAX_INCLUDE_DEPTH and ids `load` cannot provide (IncludeError). Returns
 * the text and every id included (transitively), in first-use order. A body with no include is
 * returned unchanged, byte for byte.
 */
export function expandIncludes(body: string, load: (id: string) => string, stack: readonly string[] = []): { text: string; included: string[] } {
  const included: string[] = [];
  const text = body.replace(new RegExp(INCLUDE_REF, "g"), (_whole: string, id: string) => {
    if (stack.includes(id)) throw new IncludeError(`include cycle: ${[...stack, id].join(" → ")}`);
    if (stack.length >= MAX_INCLUDE_DEPTH) throw new IncludeError(`includes nest deeper than ${MAX_INCLUDE_DEPTH}: ${[...stack, id].join(" → ")}`);
    let inner: string;
    try {
      inner = load(id);
    } catch (err) {
      throw new IncludeError(`cannot include "${id}"${stack.length ? ` (from ${stack.at(-1)})` : ""}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const expanded = expandIncludes(inner, load, [...stack, id]);
    for (const i of [id, ...expanded.included]) if (!included.includes(i)) included.push(i);
    return expanded.text.replace(/\s+$/, "");
  });
  return { text, included };
}

/** A prompt id that names a partial (last dot-segment starts with `_`): included, never run. */
export function isPartialId(id: string): boolean {
  return (id.split(".").at(-1) ?? "").startsWith("_");
}
