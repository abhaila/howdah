/**
 * Small tree-sitter helpers + the per-file fact `Collector` — system-map 1b.
 *
 * The collector is shared by the language visitors (declarations, calls, casts, names) and the
 * framework adapters (routes, fetch sites), so an adapter hit can name its enclosing function
 * without re-walking the tree. Everything it records is path-independent (eng review D23): no
 * file paths, only lines and text, so the result can be stored by content hash.
 */

import { createHash } from "node:crypto";
import type { Node } from "web-tree-sitter";
import type { DeclFact, FileFacts, Language } from "./types";

export type N = Node;

export function kids(n: N): N[] {
  return n.children.filter((c): c is N => c !== null);
}

export function named(n: N): N[] {
  return n.namedChildren.filter((c): c is N => c !== null && c.type !== "comment" && c.type !== "line_comment" && c.type !== "block_comment" && c.type !== "multiline_comment");
}

export function field(n: N, name: string): N | null {
  return n.childForFieldName(name);
}

export function line(n: N): number {
  return n.startPosition.row + 1;
}

/** Last line the node occupies (a node ending at column 0 ends on the previous line). */
export function endLine(n: N): number {
  const e = n.endPosition;
  return e.column === 0 && e.row > n.startPosition.row ? e.row : e.row + 1;
}

export function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

export function hash16(text: string): string {
  return sha256(text).slice(0, 16);
}

/** Collapse whitespace and cap length — for receiver/handler/reason text in facts. */
export function short(text: string, max = 80): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function decodeEscape(esc: string): string {
  switch (esc) {
    case "\\n":
      return "\n";
    case "\\t":
      return "\t";
    case "\\r":
      return "\r";
    case "\\b":
      return "\b";
    case "\\0":
      return "\0";
    default:
      if (/^\\u[0-9a-fA-F]{4}$/.test(esc)) return String.fromCharCode(parseInt(esc.slice(2), 16));
      return esc.startsWith("\\") ? esc.slice(1) : esc;
  }
}

/**
 * The value of a Kotlin string literal, or null if it is not a pure literal. The v1.1.0 grammar
 * tokenises a simple `$name` template as plain `string_content` pieces, so a piece that starts
 * with `$` followed by an identifier/brace is treated as interpolation (non-literal).
 */
export function kotlinStringValue(n: N): string | null {
  if (n.type !== "string_literal" && n.type !== "multiline_string_literal") return null;
  let out = "";
  const parts = kids(n);
  for (let i = 0; i < parts.length; i++) {
    const c = parts[i];
    if (c === undefined) continue;
    if (c.type === "string_content") {
      const next = parts[i + 1];
      if (c.text === "$" && next !== undefined && next.type === "string_content" && /^[A-Za-z_{]/.test(next.text)) return null;
      if (/^\$[A-Za-z_{]/.test(c.text)) return null;
      out += c.text;
    } else if (c.type === "escape_sequence") out += decodeEscape(c.text);
    else if (c.type === "interpolation") return null;
    else if (!c.isNamed) continue;
    else return null;
  }
  return out;
}

/** The value of a TS/JS `string` node (or a substitution-free template), else null. */
export function tsStringValue(n: N): string | null {
  if (n.type !== "string" && n.type !== "template_string") return null;
  let out = "";
  for (const c of kids(n)) {
    if (c.type === "string_fragment") out += c.text;
    else if (c.type === "escape_sequence") out += decodeEscape(c.text);
    else if (c.type === "template_substitution") return null;
    else if (!c.isNamed) continue;
    else return null;
  }
  return out;
}

export function emptyFacts(language: Language): FileFacts {
  return {
    language,
    decls: [],
    imports: [],
    calls: [],
    casts: [],
    locals: [],
    routes: [],
    mounts: [],
    serverRoots: [],
    groups: [],
    unparsedNames: [],
    fetches: [],
    queryHooks: [],
    coverage: [],
    unparsed: [],
  };
}

export class Collector {
  readonly facts: FileFacts;
  /** Function declarations' ranges, for "which function encloses this adapter hit". */
  private readonly fnRanges: { start: number; end: number; idx: number }[] = [];
  /** TS: file-level `const X = "literal"` bindings, for URL evaluation. */
  readonly consts = new Map<string, string>();
  /** TS: `export { a as b }` / `export default a` — local name → exported name. */
  readonly exportsInfo = { aliases: new Map<string, string>() };
  /** TS: file-level names bound to `axios.create()` / `ky.create()` — HTTP clients by construction. */
  readonly clientNames = new Set<string>();

  constructor(language: Language) {
    this.facts = emptyFacts(language);
  }

  addDecl(node: N, d: Omit<DeclFact, "line" | "endLine" | "contentHash">): number {
    const idx = this.facts.decls.length;
    this.facts.decls.push({ ...d, line: line(node), endLine: endLine(node), contentHash: hash16(node.text) });
    if (d.kind === "function") this.fnRanges.push({ start: node.startIndex, end: node.endIndex, idx });
    return idx;
  }

  /** Innermost function declaration containing `node`, or null. */
  enclosingAt(node: N): number | null {
    let best: { start: number; end: number; idx: number } | null = null;
    for (const r of this.fnRanges) {
      if (r.start <= node.startIndex && node.endIndex <= r.end) {
        if (best === null || r.end - r.start < best.end - best.start) best = r;
      }
    }
    return best === null ? null : best.idx;
  }

  local(name: string, node: N, enclosing: number | null): void {
    if (name === "" || name === "_") return;
    this.facts.locals.push({ name, line: line(node), enclosing });
  }

  call(callee: string, receiver: string | null, node: N, enclosing: number | null, inLambda = false): void {
    if (callee === "") return;
    this.facts.calls.push({ line: line(node), callee, receiver: receiver === null ? null : short(receiver), enclosing, ...(inLambda ? { inLambda: true as const } : {}) });
  }

  /** Names declared as locals or parameters of function `idx` — they shadow file-level names. */
  scopeNames(idx: number | null): Set<string> {
    const out = new Set<string>();
    if (idx === null) return out;
    for (const l of this.facts.locals) if (l.enclosing === idx) out.add(l.name);
    // param "names" may be destructuring patterns (`{ id, name }`): every identifier in them binds
    for (const p of this.facts.decls[idx]?.paramNames ?? []) for (const m of p.match(/[A-Za-z_$][\w$]*/g) ?? []) out.add(m);
    return out;
  }
}
