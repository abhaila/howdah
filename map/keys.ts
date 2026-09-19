/**
 * Identity keys — system-map eng review D8/7A. The ONE place their grammar lives: assembly
 * builds keys here, and 1c's GhostSet validator calls `parseKey()` to check an `add` ghost's id.
 *
 * | Entity         | Key                                                                   |
 * |----------------|-----------------------------------------------------------------------|
 * | Block (JVM)    | `<buildRoot><gradlePath>/<package>` — `:api/com.example.api`,          |
 * |                | `backend:api/com.x`, `:/com.x` (root project), `/<default>` package    |
 * | Block (TS)     | nearest package.json dir, repo-relative (`web`, `.` for the root)       |
 * | Route          | `METHOD /normalised/{*}` — `{id}`, `{id:\d+}`, `:id`, `${id}` → `{*}`;  |
 * |                | `METHOD {*}/rest` when the http4k mount prefix above it is unknown     |
 * | Function (JVM) | `pkg.Outer.Inner.method(T1,T2)`; `pkg.<top>.f(T)`; `pkg.<ext Recv>.f()` |
 * | Function (TS)  | `module/path#exportName` or `module/path#Class.member`                 |
 * | Fetch site     | `<enclosing function id>|METHOD template` (`module#<module>` at top);  |
 * |                | template may be `{*}/…` (unknown base) or `https://host/…` (absolute)  |
 * | Edge           | `from→to:kind`, kind ∈ import | call | route-handler | fe-be            |
 *
 * Names: Kotlin backticked names (`\x60handles issue #12\x60`) are opaque to the grammar, and TS
 * module paths may contain Next.js `(group)`, `[id]`, `[...slug]`, `@slot` segments.
 *
 * Declared parameter TYPE TEXT is used (not resolved types — that is SCIP's job in slice 2), so
 * `fun f(x: Map<String,  Int>)` and `fun f(x: Map<String,Int>)` share a key but `List<T>` and
 * `List<*>` do not. Whitespace is normalised by `normType`.
 */

import type { EdgeKind } from "./types";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"] as const;
const METHOD_RE = /^(?:[A-Z]+|\*)$/;
export const EDGE_KINDS: readonly EdgeKind[] = ["import", "call", "route-handler", "fe-be"];

/** Collapse whitespace; drop it next to punctuation so formatting never changes a key. */
export function normType(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*(->|=>|[<>,()[\]{};=?:.*&|])\s*/g, "$1");
}

/**
 * Normalise a URL/path template: query and fragment stripped; every path parameter form
 * (`{id}`, `{id:regex}`, `:id`, `${expr}`) → `{*}`; duplicate and trailing slashes dropped. A
 * leading non-literal base stays as a leading `{*}`. An absolute URL KEEPS its (lower-cased)
 * origin — `https://api.github.com/api/orders` must never look like our `/api/orders`.
 */
export function normTemplate(raw: string): string {
  let s = raw.trim();
  s = s.replace(/\$\{[^}]*\}/g, "{*}");
  // {name} / {name:regex} — regex may itself contain braces like \d{2}; match balanced-ish.
  s = s.replace(/\{(?!\*\})(?:[^{}]|\{[^{}]*\})*\}/g, "{*}");
  const om = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(.*)$/i.exec(s);
  const origin = om === null ? "" : (om[1] ?? "").toLowerCase();
  let p = om === null ? s : (om[2] ?? "");
  p = p.split(/[?#]/)[0] ?? "";
  p = p
    .split("/")
    .map((seg) => (/^:[A-Za-z_][\w-]*$/.test(seg) ? "{*}" : seg))
    .join("/");
  p = p.replace(/(?:\{\*\}){2,}/g, "{*}");
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (origin !== "") return p === "" || p === "/" ? origin : origin + (p.startsWith("/") ? p : "/" + p);
  return p === "" ? "/" : p;
}

/** Join an http4k prefix chain: `["/api", "/v1"]` + `/orders` → `/api/v1/orders`. */
export function joinPaths(parts: string[]): string {
  const joined = parts
    .map((p) => p.trim())
    .filter((p) => p !== "" && p !== "/")
    .map((p) => (p.startsWith("/") ? p : "/" + p))
    .join("");
  const collapsed = joined.replace(/\/{2,}/g, "/");
  if (collapsed === "") return "/";
  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

// ── builders ────────────────────────────────────────────────────────────────

export function jvmBlockKey(buildRoot: string, gradlePath: string, pkg: string): string {
  return `${buildRoot}${gradlePath}/${pkg === "" ? "<default>" : pkg}`;
}

export function tsBlockKey(packageDir: string): string {
  return packageDir === "" ? "." : packageDir;
}

export function routeKey(method: string, template: string): string {
  return `${method} ${template}`;
}

export function jvmFunctionKey(f: {
  pkg: string;
  container: string[];
  name: string;
  params: string[];
  receiver?: string;
}): string {
  const qual: string[] = [];
  if (f.pkg !== "") qual.push(f.pkg);
  qual.push(...f.container);
  if (f.receiver !== undefined) qual.push(`<ext ${f.receiver}>`);
  else if (f.container.length === 0) qual.push("<top>");
  return `${qual.join(".")}.${f.name}(${f.params.join(",")})`;
}

export function tsModulePath(file: string): string {
  return file.replace(/\.(d\.)?(tsx?|jsx?|mts|cts|mjs|cjs)$/, "");
}

export function tsFunctionKey(module: string, name: string, member?: string): string {
  return member === undefined ? `${module}#${name}` : `${module}#${name}.${member}`;
}

export const TS_MODULE_LEVEL = "<module>";

export function fetchSiteKey(enclosingId: string, method: string, template: string): string {
  return `${enclosingId}|${method} ${template}`;
}

export function edgeKey(from: string, to: string, kind: EdgeKind): string {
  return `${from}→${to}:${kind}`;
}

// ── parseKey ────────────────────────────────────────────────────────────────

export type ParsedFunctionKey =
  | {
      kind: "function";
      lang: "jvm";
      /** Everything before the name, excluding `<top>`/`<ext …>` (pkg + class chain, dotted). */
      qualifier: string;
      scope: "top" | "member" | "extension";
      receiver?: string;
      name: string;
      params: string[];
    }
  | { kind: "function"; lang: "ts"; module: string; name: string; member?: string };

export type ParsedKey =
  | { kind: "block"; lang: "jvm"; buildRoot: string; gradlePath: string; package: string }
  | { kind: "block"; lang: "ts"; packageDir: string }
  | { kind: "route"; method: string; template: string }
  | ParsedFunctionKey
  | { kind: "fetch-site"; enclosing: ParsedFunctionKey; method: string; template: string }
  | { kind: "edge"; from: ParsedKey; to: ParsedKey; edgeKind: EdgeKind };

export type ParseKeyResult = { ok: true; key: ParsedKey } | { ok: false; error: string };

const ID_START = String.raw`[\p{L}\p{Nl}$_]`;
const ID_PART = String.raw`[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$\u200c\u200d]`;
/** A JVM identifier, or a Kotlin backticked name (which may contain spaces, `#`, `|`, …). */
const JVM_IDENT = String.raw`(?:${ID_START}${ID_PART}*|\x60[^\x60\n]+\x60)`;
const JVM_NAME_RE = new RegExp(String.raw`^(?:${JVM_IDENT}|<init>)$`, "u");
const JVM_QUAL_RE = new RegExp(String.raw`^${JVM_IDENT}(?:\.${JVM_IDENT})*$`, "u");
const JVM_PKG_RE = new RegExp(String.raw`^(?:<default>|${ID_START}${ID_PART}*(?:\.${ID_START}${ID_PART}*)*)$`, "u");
const TS_NAME_RE = new RegExp(String.raw`^(?:${ID_START}${ID_PART}*|<module>)$`, "u");
const TS_MEMBER_RE = new RegExp(String.raw`^#?${ID_START}${ID_PART}*$`, "u");
/**
 * A repo-relative module path / package dir: anything but whitespace and the key grammar's
 * separators (`#`, `|`, `→`, `:`, backtick). Next.js `app/(auth)/[id]/[...slug]` paths are valid.
 */
const PATH_RE = /^(?:\.|[^\s#|→:\x60]+)$/u;
/** A package dir (TS block): a path WITHOUT parentheses, so a malformed `f(T` is never a block. */
const BLOCK_PATH_RE = /^(?:\.|[^\s#|→:\x60()]+)$/u;

/**
 * Mask the inside of backtick-quoted names with `_` (same length), so structural characters
 * inside `\x60handles issue #12\x60` never split a key. null if a backtick is unterminated.
 */
function maskBackticks(key: string): string | null {
  let out = "";
  let inside = false;
  for (const ch of key) {
    if (ch === "\x60") {
      inside = !inside;
      out += ch;
    } else out += inside ? "_".repeat(ch.length) : ch;
  }
  return inside ? null : out;
}

function ok(key: ParsedKey): ParseKeyResult {
  return { ok: true, key };
}
function err(error: string): ParseKeyResult {
  return { ok: false, error };
}

/** Split on top-level commas, respecting <>, (), [] nesting (handles `Map<String,Int>`). */
export function splitTopLevel(s: string): string[] | null {
  if (s === "") return [];
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "-" && s[i + 1] === ">") {
      cur += "->";
      i++;
      continue;
    }
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "]") depth--;
    if (depth < 0) return null;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (depth !== 0) return null;
  out.push(cur);
  return out;
}

function parseTemplate(t: string): string | null {
  if (t === "{*}") return t;
  if (!(t.startsWith("/") || t.startsWith("{*}/") || /^[a-z][a-z0-9+.-]*:\/\/[^/\s]+/.test(t))) return null;
  if (/\s/.test(t)) return null;
  return normTemplate(t) === t ? t : null;
}

function parseRoute(s: string): ParseKeyResult {
  const sp = s.indexOf(" ");
  const method = s.slice(0, sp);
  const template = s.slice(sp + 1);
  if (!METHOD_RE.test(method)) return err(`route method must be upper-case or '*': ${JSON.stringify(method)}`);
  const t = parseTemplate(template);
  if (t === null) return err(`route template is not normalised (want e.g. /users/{*}): ${JSON.stringify(template)}`);
  return ok({ kind: "route", method, template: t });
}

function parseJvmFunction(s: string, m: string): ParseKeyResult {
  if (!m.endsWith(")")) return err("JVM function key must end with a parameter list");
  // find the '(' matching the final ')' — on the masked text, so backticked names can hold parens
  let depth = 0;
  let open = -1;
  for (let i = m.length - 1; i >= 0; i--) {
    const ch = m[i];
    if (ch === ")") depth++;
    else if (ch === "(") {
      depth--;
      if (depth === 0) {
        open = i;
        break;
      }
    }
  }
  if (open < 0) return err("unbalanced parameter list");
  const params = splitTopLevel(s.slice(open + 1, -1));
  if (params === null) return err("unbalanced generics in parameter list");
  if (params.some((p) => p === "" || normType(p) !== p)) return err("parameter types must be non-empty and whitespace-normalised");
  const head = s.slice(0, open);
  const dot = m.slice(0, open).lastIndexOf(".");
  const name = dot < 0 ? head : head.slice(dot + 1);
  const qualAll = dot < 0 ? "" : head.slice(0, dot);
  if (!JVM_NAME_RE.test(name)) return err(`bad function name ${JSON.stringify(name)}`);
  if (qualAll === "") return err("JVM function key needs a qualifier (`<top>`, a class, or `<ext …>`)");

  if (qualAll === "<top>" || qualAll.endsWith(".<top>")) {
    const qualifier = qualAll === "<top>" ? "" : qualAll.slice(0, -".<top>".length);
    if (qualifier !== "" && !JVM_QUAL_RE.test(qualifier)) return err(`bad package ${JSON.stringify(qualifier)}`);
    return ok({ kind: "function", lang: "jvm", qualifier, scope: "top", name, params });
  }
  const qualMasked = m.slice(0, Math.max(dot, 0));
  const ext = qualMasked.startsWith("<ext ") ? 0 : qualMasked.indexOf(".<ext ");
  if (ext >= 0) {
    const start = ext === 0 ? 0 : ext + 1;
    if (!qualAll.endsWith(">")) return err("unterminated `<ext …>`");
    const receiver = qualAll.slice(start + "<ext ".length, -1);
    const qualifier = ext === 0 ? "" : qualAll.slice(0, ext);
    if (receiver === "" || normType(receiver) !== receiver || splitTopLevel(receiver) === null) {
      return err(`bad extension receiver ${JSON.stringify(receiver)}`);
    }
    if (qualifier !== "" && !JVM_QUAL_RE.test(qualifier)) return err(`bad qualifier ${JSON.stringify(qualifier)}`);
    return ok({ kind: "function", lang: "jvm", qualifier, scope: "extension", receiver, name, params });
  }
  if (!JVM_QUAL_RE.test(qualAll)) return err(`bad qualifier ${JSON.stringify(qualAll)}`);
  return ok({ kind: "function", lang: "jvm", qualifier: qualAll, scope: "member", name, params });
}

function parseTsFunction(s: string, m: string): ParseKeyResult {
  const hash = m.indexOf("#");
  const module = s.slice(0, hash);
  const rest = s.slice(hash + 1);
  if (module === "" || !PATH_RE.test(module)) return err(`bad module path ${JSON.stringify(module)}`);
  const dot = rest.indexOf(".");
  const name = dot < 0 ? rest : rest.slice(0, dot);
  const member = dot < 0 ? undefined : rest.slice(dot + 1);
  if (!TS_NAME_RE.test(name) || (member !== undefined && !TS_MEMBER_RE.test(member))) return err(`bad TS export name ${JSON.stringify(rest)}`);
  return ok(member === undefined ? { kind: "function", lang: "ts", module, name } : { kind: "function", lang: "ts", module, name, member });
}

function parseFunction(s: string, m: string): ParseKeyResult {
  return m.includes("#") ? parseTsFunction(s, m) : parseJvmFunction(s, m);
}

/**
 * Validate a key string against the D8/7A grammar and say what it names. Used by 1c to reject
 * ghost ids that could never be observed, and tested against every key assembly can build.
 * Structure is read on a backtick-MASKED copy (Kotlin names like `\x60a|GET /b\x60` or
 * `\x60issue #12\x60` are opaque), in an unambiguous order: edges contain `→`, fetch sites `|METHOD `,
 * routes start with `METHOD `, TS functions contain `#`, JVM functions end in `)`, then blocks
 * (JVM ones contain `:`).
 */
export function parseKey(key: string): ParseKeyResult {
  if (key === "" || key !== key.trim()) return err("key is empty or has surrounding whitespace");
  const m = maskBackticks(key);
  if (m === null) return err("unterminated backtick-quoted name");
  const arrow = m.indexOf("→");
  if (arrow >= 0) {
    const colon = m.lastIndexOf(":");
    const edgeKind = key.slice(colon + 1) as EdgeKind;
    if (colon < arrow || !EDGE_KINDS.includes(edgeKind)) return err(`edge key must end with :${EDGE_KINDS.join("|")}`);
    const from = parseKey(key.slice(0, arrow));
    const to = parseKey(key.slice(arrow + 1, colon));
    if (!from.ok) return err(`edge from: ${from.error}`);
    if (!to.ok) return err(`edge to: ${to.error}`);
    return ok({ kind: "edge", from: from.key, to: to.key, edgeKind });
  }
  const bar = m.lastIndexOf("|");
  if (bar >= 0 && /^[A-Z*]+ /.test(m.slice(bar + 1))) {
    const enc = parseFunction(key.slice(0, bar), m.slice(0, bar));
    if (!enc.ok) return err(`fetch site enclosing function: ${enc.error}`);
    const r = parseRoute(key.slice(bar + 1));
    if (!r.ok) return err(`fetch site: ${r.error}`);
    if (enc.key.kind !== "function" || r.key.kind !== "route") return err("unreachable");
    return ok({ kind: "fetch-site", enclosing: enc.key, method: r.key.method, template: r.key.template });
  }
  if (/^[A-Z*]+ /.test(m)) return parseRoute(key);
  if (m.includes("#")) return parseFunction(key, m);
  if (m.endsWith(")") || m.includes("(")) return parseJvmFunction(key, m);
  // blocks
  const jb = /^([^\s:#|→\x60]*)(:[^/\s]*)\/(.+)$/u.exec(key);
  if (jb !== null) {
    const [, buildRoot, gradlePath, pkg] = jb;
    if (buildRoot === undefined || gradlePath === undefined || pkg === undefined) return err("unreachable");
    if (!/^:(?:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*)?$/.test(gradlePath)) return err(`bad Gradle project path ${JSON.stringify(gradlePath)}`);
    if (!JVM_PKG_RE.test(pkg)) return err(`bad package ${JSON.stringify(pkg)}`);
    return ok({ kind: "block", lang: "jvm", buildRoot, gradlePath, package: pkg === "<default>" ? "" : pkg });
  }
  if (BLOCK_PATH_RE.test(key) && !key.startsWith("/") && !key.endsWith("/")) return ok({ kind: "block", lang: "ts", packageDir: key });
  return err(`not a block, route, function, fetch-site or edge key: ${JSON.stringify(key)}`);
}
