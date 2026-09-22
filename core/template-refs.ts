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
