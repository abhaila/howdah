/**
 * Languages, grammars and the version strings that go into object keys — system-map 1b.
 *
 * web-tree-sitter (WASM) because the native `tree-sitter` bindings fail under bun (verified in
 * the research spike). Grammars ship their own `.wasm`; a grammar that fails to load is NOT a
 * crash — every file of that language becomes `not-checked (grammar unavailable)` (1b spec).
 *
 * The grammar version string is part of every object key (eng review D14/13A): upgrading a
 * grammar package re-parses exactly the files of that language and nothing else.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Language } from "./types";

const require = createRequire(import.meta.url);

interface GrammarSpec {
  pkg: string;
  wasm: string;
}

const GRAMMARS: Record<Language, GrammarSpec> = {
  kotlin: { pkg: "@tree-sitter-grammars/tree-sitter-kotlin", wasm: "tree-sitter-kotlin.wasm" },
  java: { pkg: "tree-sitter-java", wasm: "tree-sitter-java.wasm" },
  typescript: { pkg: "tree-sitter-typescript", wasm: "tree-sitter-typescript.wasm" },
  tsx: { pkg: "tree-sitter-typescript", wasm: "tree-sitter-tsx.wasm" },
  // Plain JS is parsed with the TSX grammar (a superset for our purposes: JSX + no types).
  javascript: { pkg: "tree-sitter-typescript", wasm: "tree-sitter-tsx.wasm" },
};

export const LANGUAGES = Object.keys(GRAMMARS) as Language[];

const EXT: Record<string, Language> = {
  ".kt": "kotlin",
  ".java": "java",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
};

/** The language a path is parsed as, or null if it isn't source we extract. */
export function languageOf(path: string): Language | null {
  if (/\.d\.[mc]?ts$/.test(path)) return null;
  const m = /\.[A-Za-z]+$/.exec(path);
  return m === null ? null : (EXT[m[0].toLowerCase()] ?? null);
}

export function familyOf(lang: Language): "jvm" | "ts" {
  return lang === "kotlin" || lang === "java" ? "jvm" : "ts";
}

function pkgDir(pkg: string): string | null {
  try {
    return dirname(require.resolve(`${pkg}/package.json`));
  } catch {
    return null;
  }
}

function pkgVersion(pkg: string): string {
  const dir = pkgDir(pkg);
  if (dir === null) return "missing";
  try {
    const v = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : "unknown";
  } catch {
    return "unknown";
  }
}

export type GrammarOverrides = Partial<Record<Language, string>>;

/** Absolute path of a language's .wasm (an override wins — tests use it to break a grammar). */
export function grammarPath(lang: Language, overrides?: GrammarOverrides): string {
  const o = overrides?.[lang];
  if (o !== undefined) return o;
  const spec = GRAMMARS[lang];
  const dir = pkgDir(spec.pkg);
  return dir === null ? `<unresolved ${spec.pkg}>/${spec.wasm}` : join(dir, spec.wasm);
}

let runtimeVersion: string | undefined;
function runtime(): string {
  runtimeVersion ??= `web-tree-sitter@${pkgVersion("web-tree-sitter")}`;
  return runtimeVersion;
}

/** `tree-sitter-java@0.23.5/tree-sitter-java.wasm+web-tree-sitter@0.25.10` — part of the object key. */
export function grammarVersion(lang: Language, overrides?: GrammarOverrides): string {
  const o = overrides?.[lang];
  if (o !== undefined) return `override:${o}+${runtime()}`;
  const spec = GRAMMARS[lang];
  return `${spec.pkg}@${pkgVersion(spec.pkg)}/${spec.wasm}+${runtime()}`;
}
