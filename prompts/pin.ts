/**
 * The text a run pins for a prompt (OV-2, system-map 1c review) — ONE implementation, used by
 * `Engine.pinPrompts()` at run start and by `graphs/builder.ts` when a draft's `{ copyOf }`
 * body is written out as a real prompt (HOW-63).
 *
 * The two must agree byte for byte: a copied step is saved so that what the operator reviewed
 * IS what a run pins, and a local prompt cannot carry an include (specProblems refuses one), so
 * the copy has to be the already-expanded text. A second expansion here would be a second
 * opinion on what a prompt says, and the first divergence would make a saved copy differ from
 * the prompt it claims to be.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expandIncludes, splitFrontMatter } from "../core/template";

/** A raw prompt-file reader over `dirs`, first match wins. Throws naming every place it looked:
 *  a missing prompt is usually a typo or an un-scaffolded id. */
export function promptReader(dirs: readonly string[]): (id: string) => string {
  return (id) => {
    for (const d of dirs) {
      const p = join(d, `${id}.md`);
      if (existsSync(p)) return readFileSync(p, "utf8");
    }
    throw new Error(`prompt "${id}" not found in ${dirs.join(", ")}`);
  };
}

/**
 * `id`'s file as a run pins it: with no include, the raw file byte for byte; with one, its
 * front matter over the body with every `{{> id }}` expanded (`expandIncludes`, so cycles,
 * depth and missing includes throw `IncludeError`). `included` is the transitive include list.
 */
export function pinnableText(id: string, rawOf: (id: string) => string): { raw: string; pinned: string; included: string[] } {
  const raw = rawOf(id);
  const { frontmatter, body } = splitFrontMatter(raw);
  const { text, included } = expandIncludes(body, (inc) => splitFrontMatter(rawOf(inc)).body, [id]);
  return { raw, pinned: included.length ? `---\n${frontmatter ?? ""}\n---\n${text}` : raw, included };
}
