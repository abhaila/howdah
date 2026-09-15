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
 */
import { createHash } from "node:crypto";

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

/** The `rendered_hash` join key: first 16 hex of sha256 over the FINAL rendered text. */
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
