/**
 * The template REFERENCE grammar — `{{ context.key }}` / `{{ inputs.key }}` — split out of
 * core/template.ts so the browser can read it (HOW-22).
 *
 * Why a split at all: core/template.ts imports `node:crypto` for renderedHash, and the
 * viewer's bundle (web/server.ts buildApp) targets the browser. The graph builder has to
 * answer "which context keys will this step be given?" LIVE, from the prompt body the
 * operator is typing, with no round trip — and that answer is exactly templateReads().
 *
 * This is a pure move, not a second implementation. There is still ONE regex for what a
 * reference is, and core/template.ts re-exports these four names, so every existing import
 * path keeps working and the single-renderer invariant is strengthened rather than bent.
 * Nothing node-specific may be added here.
 */

/** `{{ context.key }}` / `{{ inputs.key }}`, optional `| filter` tail, captured as (ns, key). */
export const TEMPLATE_REF = String.raw`\{\{\s*(context|inputs)\.([\w.]+)(?:\s*\|[^}]*)?\s*\}\}`;

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
 * Rewrite every `{{ context.<from> }}` / `{{ inputs.<from> }}` to name `<to>` instead.
 *
 * The graph builder renames a field by editing ONE registry row, and the instructions that
 * mention it have to follow — otherwise the body and the step's derived `reads` disagree, the
 * browser calls the draft clean and the server refuses it (HOW-22 review, finding 2).
 *
 * It goes through templateRefPattern() rather than a string replace, and that is the whole
 * point: there is still exactly ONE definition of what a reference is, so a field called
 * `goal` cannot rewrite `goalkeeper` or the word "goal" in prose. Only the KEY inside the
 * match is swapped, so the namespace, any `| filter` tail and the operator's own spacing come
 * through verbatim, and `context.internal.*` — the engine's namespace, not a field — is left
 * exactly as written.
 */
export function renameTemplateRef(body: string, from: string, to: string): string {
  return body.replace(templateRefPattern(), (whole, ns: string, key: string) => {
    if (key !== from || isEngineNamespace(ns, key)) return whole;
    // a replacer FUNCTION, never a replacement string: `to` is whatever the operator has
    // typed so far, and `$&`/`$1` in a replacement string are substitutions
    return whole.replace(`${ns}.${key}`, () => `${ns}.${to}`);
  });
}
