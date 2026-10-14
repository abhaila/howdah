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

/**
 * `{{ context.key }}` / `{{ inputs.key }}`, optional `| filter` tail, captured as
 * (ns, key, filter). HOW-37: the filter is CAPTURED now (it used to be parsed and dropped), so
 * a filter the renderer does not know can be refused instead of silently ignored — see
 * templateFilterProblems. Every existing caller destructures (ns, key) and is unaffected.
 */
export const TEMPLATE_REF = String.raw`\{\{\s*(context|inputs)\.([\w.]+)(?:\s*\|\s*([^}]*?))?\s*\}\}`;

/**
 * HOW-37: the filters a reference may carry. `dump` = the value as compact JSON, ALWAYS — a
 * string included, so `{{ context.x | dump }}` is unambiguous about where the value starts and
 * ends. That is what every use in prompts/ already meant (all eight are on object values,
 * where it renders byte-identically to no filter at all).
 */
export const TEMPLATE_FILTERS = ["dump"] as const;

/**
 * Every reference with a filter the renderer does not know, as a sentence naming it. A filter
 * that parses and does nothing is a trap, so this is a VALIDATION ERROR wherever a prompt is
 * checked (prompts/codegen.ts, the prompt store's accept guard, graphs/local.ts).
 */
export function templateFilterProblems(body: string): string[] {
  const problems: string[] = [];
  // HOW-44: an #if block may not contain another, and every #if needs its /if
  for (const m of body.matchAll(ifBlockPattern()))
    if (new RegExp(IF_OPEN).test(m[3] ?? "")) problems.push(`\`${m[0].slice(0, 60)}…\` nests one {{#if}} inside another, which the renderer does not support`);
  const opens = [...body.matchAll(new RegExp(IF_OPEN, "g"))].length;
  const closes = [...body.matchAll(/\{\{\/if\}\}/g)].length;
  if (opens !== closes) problems.push(`${opens} {{#if …}} but ${closes} {{/if}} — every block needs exactly one close`);
  for (const m of body.matchAll(templateRefPattern())) {
    const filter = m[3]?.trim();
    if (filter === undefined || filter === "" || (TEMPLATE_FILTERS as readonly string[]).includes(filter)) continue;
    problems.push(`\`${m[0]}\` uses the filter "${filter}", which does nothing — the only filter is \`dump\` (the value as JSON)`);
  }
  return problems;
}

/**
 * HOW-44: `{{#if context.key}}…{{/if}}` — the one block form (render v2). Its body renders
 * only when the value is a non-empty string or `true`; anything else (absent, "", false, an
 * object) renders nothing. No nesting and no `else`: a prompt that needs more logic than
 * "say this only when it is true" belongs in the graph, not the template. The key is a READ
 * like any reference (templateReads includes it), so the undeclared-read guards see it.
 */
export const IF_BLOCK = String.raw`\{\{#if\s+(context|inputs)\.([\w.]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}`;
const IF_OPEN = String.raw`\{\{#if\s+(context|inputs)\.([\w.]+)\s*\}\}`;

export function ifBlockPattern(): RegExp {
  return new RegExp(IF_BLOCK, "g");
}

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
  for (const m of body.matchAll(new RegExp(IF_OPEN, "g"))) {
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
  // HOW-44: an #if names its key too
  body = body.replace(new RegExp(IF_OPEN, "g"), (whole, ns: string, key: string) =>
    key !== from || isEngineNamespace(ns, key) ? whole : whole.replace(`${ns}.${key}`, () => `${ns}.${to}`));
  return body.replace(templateRefPattern(), (whole, ns: string, key: string) => {
    if (key !== from || isEngineNamespace(ns, key)) return whole;
    // a replacer FUNCTION, never a replacement string: `to` is whatever the operator has
    // typed so far, and `$&`/`$1` in a replacement string are substitutions
    return whole.replace(`${ns}.${key}`, () => `${ns}.${to}`);
  });
}

/**
 * `{{> prompt.id }}` — a pin-time include of another prompt file's body. Moved here from
 * core/template.ts (HOW-60) so the graph builder can refuse an include in the browser;
 * core/template.ts re-exports both names and expandIncludes still reads this one regex.
 */
export const INCLUDE_REF = String.raw`\{\{>\s*([\w.-]+)\s*\}\}`;

/** The prompt ids a body includes directly, in order. */
export function includeRefs(body: string): string[] {
  return [...body.matchAll(new RegExp(INCLUDE_REF, "g"))].map((m) => m[1]!);
}
