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
 */
import { createHash } from "node:crypto";
import type { Harness } from "./graph";

/** `{{ context.key }}` / `{{ inputs.key }}`, optional `| filter` tail, captured as (ns, key). */
const TEMPLATE_REF = String.raw`\{\{\s*(context|inputs)\.([\w.]+)(?:\s*\|[^}]*)?\s*\}\}`;

/** A fresh global matcher per call — no shared lastIndex to get bitten by. */
export function templateRefPattern(): RegExp {
  return new RegExp(TEMPLATE_REF, "g");
}

/** `context.internal.*` is the engine's own namespace, not a context key: left verbatim. */
export function isEngineNamespace(ns: string, key: string): boolean {
  return ns === "context" && key.startsWith("internal.");
}

/** Every context/inputs key a template reads, sorted, engine namespace excluded. */
export function templateReads(body: string): string[] {
  const reads = new Set<string>();
  for (const m of body.matchAll(templateRefPattern())) {
    const [, ns, key] = m as unknown as [string, string, string];
    if (!isEngineNamespace(ns, key)) reads.add(key);
  }
  return [...reads].sort();
}

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
export const SUFFIX_VERSION = 1;

/** The versioned builders: what a render's `suffix_version` pins. */
export interface SuffixBuilders {
  /** names the node's skills; "" when there are none */
  skillHint(skills: readonly string[]): string;
  /** the outputs contract (T16) generated from the node's declared writes */
  outputContract(keys: readonly string[]): string;
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

const SUFFIX_BUILDERS: Readonly<Record<number, SuffixBuilders>> = { 1: V1 };
/** the builders new renders use; bump together with SUFFIX_VERSION */
const CURRENT: SuffixBuilders = V1;

/** The builders a logged `suffix_version` pins, or undefined for a version this code never had. */
export function suffixBuilders(version: number): SuffixBuilders | undefined {
  return Object.hasOwn(SUFFIX_BUILDERS, version) ? SUFFIX_BUILDERS[version] : undefined;
}

/** The current outputs contract — kept under its T16 name for callers and tests. */
export function buildOutputInstruction(keys: readonly string[]): string {
  return CURRENT.outputContract(keys);
}

/**
 * The skills that actually reach the prompt for a harness. Codex never got a skill hint
 * and still does not; claude and opencode (which runs through the claude executor) do.
 * The result is what gets logged as `skills`, so reconstruction needs no harness rule.
 */
export function skillsForHarness(harness: Harness | undefined, skills: readonly string[] | undefined): string[] {
  return harness === "codex" ? [] : [...(skills ?? [])];
}

export interface PromptParts {
  /** the rendered template body (renderTemplate's text) */
  body: string;
  /** operator jump instruction consumed by this render (built via operatorInstructionSuffix) */
  jumpMessage?: string;
  /**
   * Slot for Sprint 0.2's operator reply suffix — the already-built suffix text. Unused
   * until 0.2 adds its (versioned) builder; kept here so the order is fixed now.
   */
  replySuffix?: string;
  /** skills named in the hint — already filtered by skillsForHarness */
  skills: readonly string[];
  /** the node's declared write keys, in declaration order */
  outputKeys: readonly string[];
  suffixVersion: number;
}

/**
 * The ONE assembly of a prompt as sent. Fixed order:
 *   template body → operator jump → operator reply (0.2) → skill hint → outputs contract.
 * Throws on a suffix version with no builders — the engine only ever passes SUFFIX_VERSION,
 * and reconstruction checks suffixBuilders() first.
 */
export function assemblePrompt(parts: PromptParts): string {
  const builders = suffixBuilders(parts.suffixVersion);
  if (!builders) throw new Error(`no builders for suffix version ${parts.suffixVersion}`);
  return (
    parts.body +
    (parts.jumpMessage !== undefined ? operatorInstructionSuffix(parts.jumpMessage) : "") +
    (parts.replySuffix ?? "") +
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
