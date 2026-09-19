/**
 * The extractor version — system-map 1b, eng review D14/13A (object keys).
 *
 * Derived, never hand-bumped: it is a hash of the source of every module whose code decides what
 * a per-file object contains — visitors, AST helpers, adapters, key normalisers, the fact types
 * and the comparator that orders facts (util.ts). Any edit to them changes every object key, so a
 * warm (cached) extraction can never disagree with a cold one. The `.scm` query files are NOT in
 * this hash: they are keyed separately per language (`queryHash`, adapters.ts), as are grammar
 * versions (languages.ts).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./ast";

export const VERSIONED_SOURCES = ["facts.ts", "ast.ts", "adapters.ts", "keys.ts", "types.ts", "util.ts"] as const;

export function computeExtractorVersion(dir: string = import.meta.dir): string {
  const parts = VERSIONED_SOURCES.map((f) => `${f}\n${readFileSync(join(dir, f), "utf8")}`);
  return `map-1b.${sha256(parts.join("\n\0\n")).slice(0, 12)}`;
}

export const EXTRACTOR_VERSION = computeExtractorVersion();
