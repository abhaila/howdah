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

const COMMENT = /comment/;
/** Node types whose inner text is data (string contents): gaps and whitespace inside are kept verbatim. */
const VERBATIM = /string|template|heredoc/;
/** Marks a newline the normaliser must keep because it changes meaning (Kotlin, see below). */
const NEWLINE = "\u23ce";

/** JSX text the way JSX itself reads it: whitespace runs that contain a newline collapse away. */
function jsxText(t: string): string {
  if (!/[\r\n]/.test(t)) return t;
  const lines = t.split(/\r\n|\n|\r/);
  return lines
    .map((l, i) => {
      let s = l;
      if (i > 0) s = s.replace(/^[ \t]+/, "");
      if (i < lines.length - 1) s = s.replace(/[ \t]+$/, "");
      return s;
    })
    .filter((s) => s !== "")
    .join(" ");
}

const CLOSERS = new Set([")", "]", "}", ">"]);
const OPENERS = new Set(["(", "[", "{", "<", ","]);
/**
 * A trailing comma (`f(a, b,)`, `[a,]`) — formatter churn with no meaning, so it is not hashed.
 * Not when an opener or another comma precedes it: `[,]` and `[a,,]` have holes, so there the
 * comma counts.
 */
function trailingComma(parent: N, i: number): boolean {
  const ch = parent.child(i);
  if (ch === null || ch.type !== "," || ch.childCount !== 0) return false;
  /** Nearest non-comment sibling in direction `d`. */
  const sib = (d: 1 | -1): N | null => {
    for (let j = i + d; j >= 0 && j < parent.childCount; j += d) {
      const x = parent.child(j);
      if (x !== null && !COMMENT.test(x.type)) return x;
    }
    return null;
  };
  const next = sib(1);
  const prev = sib(-1);
  return next !== null && CLOSERS.has(next.type) && prev !== null && !OPENERS.has(prev.type);
}

/**
 * Kotlin newlines that change meaning, so a newline in the gap before them is kept as a marker:
 *   - a binary `+` / `-` operator token: `return a⏎- b` returns `a` (the grammar mis-joins it);
 *   - a trailing lambda: `g()⏎{ x }` is a call plus a separate lambda, not `g() { x }`.
 * ktlint never starts a line with a binary operator or a trailing lambda, so formatting churn does
 * not trip it; a unary `-1` argument on its own line is a prefix expression, not this token.
 */
function kotlinSignificantNewline(parent: N, ch: N): boolean {
  if (ch.childCount === 0 && (ch.type === "+" || ch.type === "-")) return parent.type === "binary_expression" || parent.type === "additive_expression";
  return ch.type === "annotated_lambda" || (ch.type === "lambda_literal" && parent.type === "call_suffix");
}

/**
 * Drift's "content changed" hash (1c, D19): the node's NORMALISED TOKEN STREAM, not its raw
 * text — every named node's type as structure markers, every token's text, comments dropped,
 * whitespace between tokens dropped. So re-indenting, re-wrapping or editing a comment leaves the
 * hash unchanged (`modify` stays `unchanged`, `keep` stays `verified`), while any token, any
 * string content (whitespace inside a literal included), or any change in how the code parses
 * changes it. Deliberate exceptions and limits:
 *   - JSX text is compared as JSX renders it (whitespace runs containing a newline collapse), so
 *     re-flowing `<p>Hello world</p>` over several lines is not a change;
 *   - ADDED OR REMOVED PARENTHESES ARE A CHANGE (they are nodes; prettier wrapping multi-line JSX in
 *     `( … )` changes the hash) — parentheses can change meaning (`(a?.b).c` vs `a?.b.c`), and the
 *     hash never guesses which ones do not;
 *   - a trailing comma before a closing bracket is formatter churn and is not hashed (`trailingComma`);
 *   - Kotlin keeps the newlines that change meaning (`kotlinSignificantNewline`).
 * Offsets are UTF-16 code units, the same as JS string indices, so gap slices are exact for
 * non-ASCII source.
 */
export function contentHash(node: N, language?: Language): string {
  const kotlin = language === "kotlin";
  const parts: string[] = [];
  const walk = (n: N): void => {
    if (COMMENT.test(n.type)) return;
    const count = n.childCount;
    if (count === 0) {
      const t = n.type === "jsx_text" ? jsxText(n.text) : n.text;
      // named leaves (identifiers, string_content, …) are data even when they are only spaces
      if (n.isNamed && n.type !== "jsx_text" ? t !== "" : t.trim() !== "") parts.push(t);
      return;
    }
    const verbatim = VERBATIM.test(n.type);
    const text = n.text;
    const gap = (g: string) => {
      if (verbatim ? g !== "" : g.trim() !== "") parts.push(verbatim ? g : g.trim());
    };
    if (n.isNamed) parts.push(`(${n.type}`);
    let pos = n.startIndex;
    for (let i = 0; i < count; i++) {
      const ch = n.child(i);
      if (ch === null) continue;
      const g = text.slice(pos - n.startIndex, ch.startIndex - n.startIndex);
      gap(g);
      if (!verbatim && trailingComma(n, i)) {
        pos = ch.endIndex;
        continue;
      }
      if (kotlin && !verbatim && /[\r\n]/.test(g) && kotlinSignificantNewline(n, ch)) parts.push(NEWLINE);
      walk(ch);
      pos = ch.endIndex;
    }
    gap(text.slice(pos - n.startIndex));
    if (n.isNamed) parts.push(")");
  };
  walk(node);
  return hash16(parts.join("\u0001"));
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
    this.facts.decls.push({ ...d, line: line(node), endLine: endLine(node), contentHash: contentHash(node, this.facts.language) });
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
