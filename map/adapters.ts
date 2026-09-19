/**
 * Framework adapters — system-map 1b, eng review D20 (coverage).
 *
 * Each adapter is a handful of SMALL `.scm` queries (one pattern per file — combined queries
 * silently dropped matches in the spike) joined in code. Each declares the constructs it covers;
 * a file with a candidate construct the adapter could not resolve (a `routes(` argument that
 * isn't a bind, a bind whose path isn't a literal, a fetch whose URL is a non-literal
 * identifier) is marked `partial` for that adapter, with the reason and line. Drift (1c) may
 * only claim a ghost is `missing` from a file with `full` coverage — so an adapter's honesty
 * about what it could not see is what keeps "missing" from being a false accusation.
 *
 *   http4k       Kotlin   `"/p" bind GET to h`, `bind Method.GET`, nested `"/api" bind routes(…)`
 *   fetch        TS/JS    `fetch(url, {method})`, `client.get|post|put|patch|delete|head(url)`
 *   react-query  TS/JS    `useQuery|useMutation|useSuspenseQuery|useInfiniteQuery({queryFn|mutationFn})`
 *
 * Bump an adapter's `version` whenever its code changes what it emits: the version is part of
 * every object key, so cached facts from the old adapter are never reused.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Query } from "web-tree-sitter";
import { Collector, field, hash16, kids, kotlinStringValue, line, endLine, named, short, sha256, tsStringValue, type N } from "./ast";
import { HTTP_METHODS, joinPaths, normTemplate } from "./keys";
import type { AdapterInfo, CoverageFact, HandlerRef, Language, OwnerRef, RefSite, RouteFact, UrlFact } from "./types";
import { cmpStr } from "./util";

export const QUERY_DIR = join(import.meta.dir, "queries");

export interface AdapterRun {
  root: N;
  /** The file's text — for cheap pre-filters: a query cannot match if its anchor token is absent. */
  source: string;
  collector: Collector;
  /** Compiled query by file name, or an Error if it failed to compile against this grammar. */
  query(name: string): Query | Error;
}

export interface Adapter extends AdapterInfo {
  run(ctx: AdapterRun): CoverageFact;
}

const TS_LANGS: Language[] = ["typescript", "tsx", "javascript"];

function capture(m: { captures: { name: string; node: N }[] }, name: string): N | null {
  return m.captures.find((c) => c.name === name)?.node ?? null;
}

class Coverage {
  candidates = 0;
  readonly unresolved: { line: number; reason: string }[] = [];
  constructor(private readonly adapter: string) {}
  seen(n = 1): void {
    this.candidates += n;
  }
  miss(node: N, reason: string): void {
    this.unresolved.push({ line: line(node), reason });
  }
  fact(): CoverageFact {
    const unresolved = [...this.unresolved].sort((a, b) => a.line - b.line || cmpStr(a.reason, b.reason));
    return { adapter: this.adapter, status: unresolved.length === 0 ? "full" : "partial", candidates: this.candidates, unresolved };
  }
}

function queryOrMiss(ctx: AdapterRun, cov: Coverage, name: string): Query | null {
  const q = ctx.query(name);
  if (q instanceof Error) {
    cov.miss(ctx.root, `adapter query ${name} unavailable: ${short(q.message)}`);
    return null;
  }
  return q;
}

// ── http4k ──────────────────────────────────────────────────────────────────

function isOp(infix: N, op: string): boolean {
  const parts = named(infix);
  return parts.length === 3 && parts[1]?.type === "identifier" && parts[1].text === op;
}

function isRoutesCall(n: N | undefined): boolean {
  if (n === undefined || n.type !== "call_expression") return false;
  const callee = named(n)[0];
  return callee !== undefined && callee.type === "identifier" && callee.text === "routes";
}

function httpMethodOf(n: N): string | null {
  const name = n.type === "identifier" ? n.text : n.type === "navigation_expression" ? (named(n).at(-1)?.text ?? "") : "";
  return (HTTP_METHODS as readonly string[]).includes(name) ? name : null;
}

const LAMBDA_TYPES = ["lambda_literal", "annotated_lambda", "anonymous_function"];

/**
 * The handler's function name, only when syntax proves it (item: never guess):
 *   `::health`                 → health        (`handlers::list` has a receiver → unresolved)
 *   `{ req -> getUser(req) }`  → getUser       (body is exactly one call, with no nested calls/lambdas)
 *   anything else              → null
 */
function handlerOf(n: N): RouteFact["handler"] {
  if (n.type === "callable_reference") {
    const parts = kids(n);
    const colons = parts.findIndex((k) => k.type === "::");
    const id = named(n).at(-1);
    const bare = colons === 0 && id?.type === "identifier";
    return { kind: "reference", text: short(n.text), name: bare && id !== undefined ? id.text : null };
  }
  if (n.type === "lambda_literal" || n.type === "annotated_lambda") {
    const lambda = n.type === "annotated_lambda" ? (named(n).find((k) => k.type === "lambda_literal") ?? n) : n;
    const stmts = named(lambda).filter((k) => k.type !== "lambda_parameters");
    const only = stmts.length === 1 ? stmts[0] : undefined;
    const callee = only?.type === "call_expression" ? named(only)[0] : undefined;
    const calls = lambda.descendantsOfType("call_expression").length;
    const lambdas = only === undefined ? 1 : only.descendantsOfType(LAMBDA_TYPES).length;
    const name = callee?.type === "identifier" && calls === 1 && lambdas === 0 ? callee.text : null;
    return { kind: "lambda", text: short(n.text), name };
  }
  // A bare identifier is a val/param holding an HttpHandler, not a function: not resolvable here.
  return { kind: "expression", text: short(n.text), name: null };
}

const CLASS_LIKE = new Set(["class_declaration", "object_declaration", "companion_object"]);

/** Class/object chain enclosing `node`, outermost first (companions named `Companion`). */
function classChainOf(node: N): string[] {
  const out: string[] = [];
  for (let a = node.parent; a !== null; a = a.parent) {
    if (!CLASS_LIKE.has(a.type)) continue;
    const id = field(a, "name") ?? named(a).find((k) => k.type === "identifier") ?? null;
    out.unshift(id?.text ?? (a.type === "companion_object" ? "Companion" : "<anonymous>"));
  }
  return out;
}

const LAMBDAS = new Set(["lambda_literal", "annotated_lambda", "anonymous_function"]);

function siteOf(node: N, c: Collector): RefSite {
  let inLambda = false;
  for (let a = node.parent; a !== null && a.type !== "function_declaration"; a = a.parent) if (LAMBDAS.has(a.type)) inLambda = true;
  return { line: line(node), enclosing: c.enclosingAt(node), container: classChainOf(node), ...(inLambda ? { inLambda: true as const } : {}) };
}

/**
 * A reference to a routes handler, as syntax shows it (resolved at assembly by scope rules):
 * `orderRoutes()` → call; `api` → name; `A().api()` / `Api.routes` → member of that class/object;
 * `filters.then(x)` / `x.withFilter(f)` → whatever `x` is; anything else → opaque.
 */
function handlerRef(n: N): HandlerRef {
  if (n.type === "parenthesized_expression") {
    const inner = named(n)[0];
    return inner === undefined ? { kind: "opaque", text: short(n.text, 60) } : handlerRef(inner);
  }
  if (n.type === "identifier") return { kind: "name", name: n.text };
  if (n.type === "call_expression") {
    const parts = named(n);
    const callee = parts[0];
    const onlyArgs = parts.slice(1).every((a) => a.type === "value_arguments");
    const count = argCount(n);
    if (callee?.type === "identifier" && callee.text !== "routes" && onlyArgs) return { kind: "call", name: callee.text, ...(count !== null ? { args: count } : {}) };
    if (callee?.type === "navigation_expression" && onlyArgs) {
      const nav = named(callee);
      const recv = nav[0];
      const member = nav.at(-1);
      const args = parts[1] === undefined ? [] : named(parts[1]).filter((a) => a.type === "value_argument");
      if (member?.text === "then" && args.length === 1) {
        const arg = named(args[0] as N)[0];
        if (arg !== undefined) return handlerRef(arg);
      }
      if (member?.text === "withFilter" && recv !== undefined) return handlerRef(recv);
      const cls = recv === undefined ? null : classRef(recv);
      if (cls !== null && member?.type === "identifier" && nav.length === 2) return { kind: "member", className: cls.name, name: member.text, call: true, static: cls.static, ...(count !== null ? { args: count } : {}) };
    }
  }
  if (n.type === "navigation_expression") {
    const nav = named(n);
    const recv = nav[0];
    const member = nav.at(-1);
    const cls = recv === undefined ? null : classRef(recv);
    if (cls !== null && member?.type === "identifier" && nav.length === 2) return { kind: "member", className: cls.name, name: member.text, call: false, static: cls.static };
  }
  return { kind: "opaque", text: short(n.text, 60) };
}

/** Number of arguments a call passes, or null when a spread (`*arr`) makes it unknowable. */
function argCount(call: N): number | null {
  const args = named(call).find((k) => k.type === "value_arguments");
  if (args === undefined) return 0;
  const list = named(args).filter((a) => a.type === "value_argument");
  if (list.some((a) => named(a).some((k) => k.type === "spread_expression"))) return null;
  return list.length;
}

/** `A()` (a constructor call → instance) or `Api` (an object / companion → static) — the class it names. */
function classRef(n: N): { name: string; static: boolean } | null {
  if (n.type === "identifier") return { name: n.text, static: true };
  if (n.type === "call_expression") {
    const parts = named(n);
    const callee = parts[0];
    if (callee?.type === "identifier" && parts.slice(1).every((a) => a.type === "value_arguments")) return { name: callee.text, static: false };
  }
  return null;
}

function refName(r: HandlerRef): string {
  return r.kind === "opaque" ? r.text : r.kind === "member" ? `${r.className}.${r.name}` : r.name;
}

/** The DECLARATION (function or property) whose body holds `node` — the group's owner. */
function ownerOf(node: N, c: Collector): OwnerRef | null {
  for (let a = node.parent; a !== null; a = a.parent) {
    let name: string | undefined;
    if (a.type === "function_declaration") name = field(a, "name")?.text;
    else if (a.type === "property_declaration") {
      const v = named(a).find((k) => k.type === "variable_declaration");
      name = (v === undefined ? undefined : named(v).find((k) => k.type === "identifier"))?.text;
    } else continue;
    if (name === undefined) return null;
    const l = line(a);
    const decl = c.facts.decls.some((d) => d.line === l && d.name === name && (d.kind === "function" || d.kind === "property"));
    return { name, line: l, local: !decl, enclosing: decl ? null : c.enclosingAt(a) };
  }
  return null;
}

/**
 * Is the routes group holding `node` served by an `.asServer(…)` DIRECTLY — through nothing but
 * the wrappers handlerRef models (parentheses, the single argument of `.then(…)`, the receiver of
 * `.withFilter(…)`)? Any other call argument or member call in between (`.withBasePath("/v2")`,
 * `createApp(routes(…))`) may move or re-mount the routes: not rooted, with a note saying why.
 */
function rootedAt(node: N): { rooted: boolean; note?: string } {
  // the outermost routes(…) group holding the node (inner literal prefixes are prefixesOf's job)
  let group: N | null = null;
  for (let a: N | null = node; a !== null; a = a.parent) if (isRoutesCall(a)) group = a;
  if (group === null) return { rooted: false };
  let cur: N = group;
  for (;;) {
    const p = cur.parent;
    if (p === null) return { rooted: false };
    if (p.type === "parenthesized_expression") {
      cur = p;
      continue;
    }
    if (p.type === "navigation_expression" && named(p)[0]?.id === cur.id) {
      const member = named(p).at(-1)?.text;
      if (member === "asServer") return { rooted: true };
      const call = p.parent;
      if (member === "withFilter" && call?.type === "call_expression" && named(call)[0]?.id === p.id) {
        cur = call;
        continue;
      }
      return servedAbove(p) ? { rooted: false, note: `served through \`.${member ?? "?"}(…)\`, which is not modelled` } : { rooted: false };
    }
    if (p.type === "value_argument") {
      const args = p.parent;
      const call = args?.parent;
      const callee = call === null || call === undefined ? undefined : named(call)[0];
      const only = args !== null && named(args).filter((a) => a.type === "value_argument").length === 1;
      if (call?.type === "call_expression" && callee?.type === "navigation_expression" && named(callee).at(-1)?.text === "then" && only) {
        cur = call;
        continue;
      }
      return call !== null && call !== undefined && servedAbove(call) ? { rooted: false, note: `served as an argument of \`${short(call.text, 40)}\`, which is not modelled` } : { rooted: false };
    }
    return servedAbove(p) ? { rooted: false, note: `served through \`${short(p.text, 40)}\`, which is not modelled` } : { rooted: false };
  }
}

/** Some ancestor of `n` is the receiver of `.asServer(…)`. */
function servedAbove(n: N): boolean {
  for (let a: N | null = n; a !== null; a = a.parent) {
    const p = a.parent;
    if (p?.type === "navigation_expression" && named(p)[0]?.id === a.id && named(p).at(-1)?.text === "asServer") return true;
  }
  return false;
}

export const http4kAdapter: Adapter = {
  name: "http4k",
  version: "3",
  languages: ["kotlin"],
  covers: ["route"],
  queries: ["http4k-bind.scm", "http4k-routes.scm"],
  run(ctx) {
    const cov = new Coverage("http4k");
    const c = ctx.collector;
    // Only files that import http4k are candidates: `bind` is also a Koin/Kodein infix.
    if (!c.facts.imports.some((i) => i.path?.startsWith("org.http4k") === true)) return cov.fact();

    // Server roots: what each `X.asServer(…)` serves, as a reference resolved at assembly.
    // (A routes(…) group that is itself the receiver is `rooted` on its routes instead.)
    if (ctx.source.includes("asServer")) {
      for (const nav of ctx.root.descendantsOfType("navigation_expression")) {
        if (nav === null || named(nav).at(-1)?.text !== "asServer") continue;
        const recv = named(nav)[0];
        if (recv === undefined || isRoutesCall(recv)) continue;
        c.facts.serverRoots.push({ ...siteOf(nav, c), ref: handlerRef(recv), text: short(recv.text, 60) });
      }
    }

    const bindQ = queryOrMiss(ctx, cov, "http4k-bind.scm");
    const routesQ = queryOrMiss(ctx, cov, "http4k-routes.scm");
    if (bindQ === null || routesQ === null) return cov.fact();

    for (const call of c.facts.calls) {
      if (call.callee === "contract" || call.callee === "bindContract") {
        cov.seen();
        cov.unresolved.push({ line: call.line, reason: `http4k contract routes (${call.callee}) are not covered` });
      }
    }

    const binds = bindQ.matches(ctx.root).map((m) => ({ bind: capture(m, "bind"), path: capture(m, "path"), target: capture(m, "target") }));
    const bindById = new Map<number, { path: N; target: N }>();
    for (const b of binds) if (b.bind !== null && b.path !== null && b.target !== null) bindById.set(b.bind.id, { path: b.path, target: b.target });

    /**
     * Literal prefixes of the `"/p" bind routes(…)` groups enclosing `node` in this file,
     * outermost first. null if one isn't literal, or if the chain passes through a bind whose
     * target is not a bare routes(…) (`"/a" bind filter.then(routes(…))`): prefix unknown.
     */
    const prefixesOf = (node: N): string[] | null => {
      const out: string[] = [];
      for (let a = node.parent; a !== null; a = a.parent) {
        const b = bindById.get(a.id);
        if (b === undefined || !(b.target.startIndex <= node.startIndex && node.endIndex <= b.target.endIndex)) continue;
        if (!isRoutesCall(b.target)) return null;
        const p = kotlinStringValue(b.path);
        if (p === null) return null;
        out.unshift(p);
      }
      return out;
    };

    const mount = (node: N, prefix: string | null, target: HandlerRef): void => {
      const root = rootedAt(node);
      c.facts.mounts.push({ ...siteOf(node, c), endLine: endLine(node), prefix, target, owner: ownerOf(node, c), rooted: root.rooted, ...(root.note !== undefined ? { rootNote: root.note } : {}), text: short(node.text, 60) });
    };

    // routes(...) groups: each argument is a bind, a nested group, or a NAMED group (a mount,
    // resolved at assembly — possibly in another file). Anything else is unseen routes.
    const groups = new Map<string, OwnerRef>();
    for (const m of routesQ.matches(ctx.root)) {
      const args = capture(m, "args");
      const call = capture(m, "call");
      if (args === null) continue;
      cov.seen();
      const owner = call === null ? null : ownerOf(call, c);
      if (owner !== null) groups.set(`${owner.line}:${owner.name}`, owner);
      for (const arg of named(args)) {
        if (arg.type !== "value_argument") continue;
        const spread = kids(arg).some((k) => k.text === "*");
        const expr = named(arg)[0];
        if (expr === undefined) continue;
        const isBind = expr.type === "infix_expression" && (isOp(expr, "bind") || (isOp(expr, "to") && named(expr)[0]?.type === "infix_expression" && isOp(named(expr)[0] as N, "bind")));
        if (isBind || isRoutesCall(expr)) continue;
        const target = spread ? null : handlerRef(expr);
        if (target === null || target.kind === "opaque") {
          cov.miss(expr, `routes() argument is not a bind or a named routes group: ${short(arg.text, 60)}`);
          continue;
        }
        cov.seen();
        const pre = prefixesOf(expr);
        mount(expr, pre === null ? null : joinPaths(pre), target);
      }
    }

    for (const b of binds) {
      const { bind, path, target } = b;
      if (bind === null || path === null || target === null) continue;
      cov.seen();
      const lit = kotlinStringValue(path);
      if (lit === null) {
        cov.miss(bind, `bind path is not a string literal: ${short(path.text, 60)}`);
        continue;
      }
      if (isRoutesCall(target)) continue; // a prefix group; its routes are emitted from their own binds
      const parent = bind.parent;
      const parentParts = parent === null ? [] : named(parent);
      const isRoute = parent !== null && parent.type === "infix_expression" && isOp(parent, "to") && parentParts[0]?.id === bind.id;
      const prefixes = prefixesOf(bind);
      if (!isRoute) {
        const ref = handlerRef(target);
        if (ref.kind === "opaque") {
          cov.miss(bind, `bind target is neither routes(...), a named routes group, nor \`METHOD to handler\`: ${short(target.text, 60)}`);
          continue;
        }
        mount(bind, prefixes === null ? null : joinPaths([...prefixes, lit]), ref);
        continue;
      }
      const method = httpMethodOf(target);
      if (method === null) {
        cov.miss(bind, `route method is not a literal HTTP method: ${short(target.text, 40)}`);
        continue;
      }
      if (prefixes === null) {
        cov.miss(bind, "an enclosing bind prefix is not a string literal, or passes through a non-routes target");
        continue;
      }
      const handlerNode = parentParts[2];
      const joined = joinPaths([...prefixes, lit]);
      const root = rootedAt(parent);
      c.facts.routes.push({
        line: line(parent),
        endLine: endLine(parent),
        method,
        path: joined,
        template: normTemplate(joined),
        owner: ownerOf(parent, c),
        rooted: root.rooted,
        ...(root.note !== undefined ? { rootNote: root.note } : {}),
        handler: handlerNode === undefined ? { kind: "expression", text: "", name: null } : handlerOf(handlerNode),
        enclosing: c.enclosingAt(parent),
        contentHash: hash16(parent.text),
      });
    }
    c.facts.groups = [...groups.values()].sort((x, y) => x.line - y.line || cmpStr(x.name, y.name));
    return cov.fact();
  },
};

export { refName };

// ── fetch / HTTP client ─────────────────────────────────────────────────────

type Part = { lit: string } | { dyn: string };

function urlParts(n: N, consts: Map<string, string>, shadow: Set<string>, depth = 0): Part[] {
  if (depth > 20) return [{ dyn: n.text }];
  switch (n.type) {
    case "string": {
      const v = tsStringValue(n);
      return v === null ? [{ dyn: n.text }] : [{ lit: v }];
    }
    case "template_string": {
      const out: Part[] = [];
      for (const c of kids(n)) {
        if (c.type === "string_fragment") out.push({ lit: c.text });
        else if (c.type === "escape_sequence") out.push({ lit: c.text.slice(1) });
        else if (c.type === "template_substitution") {
          const inner = named(c)[0];
          out.push(...(inner === undefined ? [{ dyn: c.text }] : urlParts(inner, consts, shadow, depth + 1)));
        }
      }
      return out;
    }
    case "binary_expression": {
      const op = field(n, "operator")?.text;
      const l = field(n, "left");
      const r = field(n, "right");
      if (op === "+" && l !== null && r !== null) return [...urlParts(l, consts, shadow, depth + 1), ...urlParts(r, consts, shadow, depth + 1)];
      return [{ dyn: n.text }];
    }
    case "parenthesized_expression": {
      const inner = named(n)[0];
      return inner === undefined ? [{ dyn: n.text }] : urlParts(inner, consts, shadow, depth + 1);
    }
    case "identifier": {
      // A local/param of the enclosing function shadows the file-level const: dynamic.
      const v = shadow.has(n.text) ? undefined : consts.get(n.text);
      return v === undefined ? [{ dyn: n.text }] : [{ lit: v }];
    }
    default:
      return [{ dyn: n.text }];
  }
}

const ORIGIN_RE = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i;

/**
 * Evaluate a URL expression as far as syntax allows: same-file string consts resolve (unless
 * shadowed by a local of the enclosing function), nothing else. An absolute URL keeps its origin:
 * `https://api.github.com/api/orders` is not our `/api/orders`.
 */
export function evalUrl(n: N, consts: Map<string, string>, shadow: Set<string> = new Set()): UrlFact {
  const parts: Part[] = [];
  for (const p of urlParts(n, consts, shadow)) {
    const last = parts.at(-1);
    if ("lit" in p && last !== undefined && "lit" in last) last.lit += p.lit;
    else parts.push({ ...p });
  }
  const text = short(n.text, 120);
  const lits = parts.filter((p): p is { lit: string } => "lit" in p);
  const first = parts[0];
  if (first === undefined || lits.length === 0 || lits.every((l) => l.lit.trim() === "")) {
    return { kind: "unknown", template: "{*}", text, base: first !== undefined && "dyn" in first ? short(first.dyn, 60) : text };
  }
  const raw = parts.map((p) => ("lit" in p ? p.lit : "{*}")).join("");
  if ("dyn" in first) return { kind: "base", template: normTemplate(raw), text, base: short(first.dyn, 60) };
  const tpl = normTemplate(raw);
  const origin = ORIGIN_RE.exec(tpl);
  if (origin !== null) return { kind: "absolute", template: tpl, text, base: origin[1] ?? "" };
  if (!tpl.startsWith("/")) return { kind: "base", template: normTemplate("{*}/" + tpl), text, base: "<relative>" };
  return { kind: parts.some((p) => "dyn" in p) ? "template" : "literal", template: tpl, text };
}

/** Receivers that are HTTP clients by name (`api`, `this.http`, `apiClient`, `axios`, …). */
const CLIENT_RECEIVER = /(?:^|\.)\w*(api|client|http|axios|request|instance|ky|fetcher)$/i;
/** Receivers that REGISTER routes (`app.get("/x", h)`) — server code, never a fetch site. */
const SERVER_RECEIVER = /(?:^|\.)(app|router|server|fastify|hono|express|route)$/i;
const FN_LITERALS = new Set(["arrow_function", "function_expression", "function"]);

/**
 * A property of an object literal: the value node; null when present but unusable
 * (shorthand) OR absent while the object spreads other options (`{...opts}` may carry it);
 * undefined when definitely absent.
 */
function objectPair(obj: N, key: string): N | null | undefined {
  let spread = false;
  for (const p of named(obj)) {
    if (p.type === "pair") {
      const k = field(p, "key");
      const name = k === null ? null : k.type === "property_identifier" ? k.text : tsStringValue(k);
      if (name === key) return field(p, "value");
    } else if (p.type === "shorthand_property_identifier" && p.text === key) return null;
    else if (p.type === "spread_element") spread = true;
  }
  return spread ? null : undefined;
}

export const fetchAdapter: Adapter = {
  name: "fetch",
  version: "2",
  languages: TS_LANGS,
  covers: ["fetch-site"],
  queries: ["fetch.scm", "http-client.scm"],
  run(ctx) {
    const cov = new Coverage("fetch");
    const c = ctx.collector;

    // HTTP call forms this adapter does not model: counted, and the file is partial.
    for (const call of c.facts.calls) {
      if (call.callee === "fetch" && call.receiver !== null) {
        cov.seen();
        cov.unresolved.push({ line: call.line, reason: `member fetch call is not covered: ${call.receiver}.fetch(…)` });
      } else if (call.callee === "axios" && call.receiver === null) {
        cov.seen();
        cov.unresolved.push({ line: call.line, reason: "axios(config) call is not covered" });
      } else if (call.callee === "request" && call.receiver !== null && (CLIENT_RECEIVER.test(call.receiver) || c.clientNames.has(call.receiver))) {
        cov.seen();
        cov.unresolved.push({ line: call.line, reason: `${call.receiver}.request(config) call is not covered` });
      }
    }

    // Sound pre-filters (queries cost ~100 ms per 100 files even when nothing matches).
    const mayFetch = /\bfetch\b/.test(ctx.source);
    const mayClient = /\.\s*(get|post|put|patch|delete|head)\b/.test(ctx.source);
    if (!mayFetch && !mayClient) return cov.fact();
    const fetchQ = queryOrMiss(ctx, cov, "fetch.scm");
    const clientQ = queryOrMiss(ctx, cov, "http-client.scm");
    if (fetchQ === null || clientQ === null) return cov.fact();

    const record = (call: N, via: "fetch" | "client", method: string, url: UrlFact): void => {
      c.facts.fetches.push({ line: line(call), endLine: endLine(call), via, method, url, enclosing: c.enclosingAt(call), contentHash: hash16(call.text) });
    };

    for (const m of mayFetch ? fetchQ.matches(ctx.root) : []) {
      const call = capture(m, "call");
      const args = capture(m, "args");
      if (call === null || args === null) continue;
      cov.seen();
      const [urlNode, init] = named(args);
      if (urlNode === undefined) {
        cov.miss(call, "fetch() without arguments");
        continue;
      }
      const url = evalUrl(urlNode, c.consts, c.scopeNames(c.enclosingAt(call)));
      if (url.kind === "unknown") cov.miss(call, `fetch URL is a non-literal expression: ${short(urlNode.text, 60)}`);
      let method = "GET";
      if (init !== undefined) {
        if (init.type !== "object") {
          method = "*";
          cov.miss(call, `fetch init is not an object literal: ${short(init.text, 40)}`);
        } else {
          const v = objectPair(init, "method");
          const lit = v === null || v === undefined ? null : tsStringValue(v);
          if (v === undefined) method = "GET";
          else if (lit === null) {
            method = "*";
            cov.miss(call, v === null && named(init).some((p) => p.type === "spread_element") ? "fetch init spreads options without a literal method" : "fetch method is not a string literal");
          } else method = lit.toUpperCase();
        }
      }
      record(call, "fetch", method, url);
    }

    for (const m of mayClient ? clientQ.matches(ctx.root) : []) {
      const call = capture(m, "call");
      const args = capture(m, "args");
      const recv = capture(m, "recv");
      const methodNode = capture(m, "method");
      if (call === null || args === null || recv === null || methodNode === null) continue;
      const argList = named(args);
      const recvText = recv.text.replace(/\?$/, "");
      // Route REGISTRATION (`app.get("/x", (req, res) => …)`), not a call to a backend.
      if (SERVER_RECEIVER.test(recvText) || argList.slice(1).some((a) => FN_LITERALS.has(a.type))) continue;
      const urlNode = argList[0];
      const url = urlNode === undefined ? null : evalUrl(urlNode, c.consts, c.scopeNames(c.enclosingAt(call)));
      const looksLikeUrl = url !== null && (url.kind === "absolute" || (url.kind !== "unknown" && url.template.startsWith("/")));
      const isClient = CLIENT_RECEIVER.test(recvText) || c.clientNames.has(recvText.split(".").at(-1) ?? recvText);
      if (!isClient) {
        // Map.get("k"), params.get("id") are not HTTP; a path-like literal through an unknown
        // receiver might be — say so rather than guess.
        if (looksLikeUrl) {
          cov.seen();
          cov.miss(call, `possible HTTP call through an unrecognised receiver: ${short(recvText, 30)}.${methodNode.text}(…)`);
        }
        continue;
      }
      cov.seen();
      if (url === null) {
        cov.miss(call, `HTTP client call without a URL argument: ${short(call.text, 60)}`);
        continue;
      }
      if (url.kind === "unknown") cov.miss(call, `client URL is a non-literal expression: ${short(urlNode?.text ?? "", 60)}`);
      record(call, "client", methodNode.text.toUpperCase(), url);
    }
    c.facts.fetches.sort((a, b) => a.line - b.line || cmpStr(a.contentHash, b.contentHash));
    return cov.fact();
  },
};

// ── react-query ─────────────────────────────────────────────────────────────

export const reactQueryAdapter: Adapter = {
  name: "react-query",
  version: "1",
  languages: TS_LANGS,
  covers: ["query-hook"],
  queries: ["react-query.scm"],
  run(ctx) {
    const cov = new Coverage("react-query");
    const c = ctx.collector;
    if (!/\buse(Query|Mutation|SuspenseQuery|InfiniteQuery|SuspenseInfiniteQuery)\s*[(<]/.test(ctx.source)) return cov.fact();
    const q = queryOrMiss(ctx, cov, "react-query.scm");
    if (q === null) return cov.fact();
    for (const m of q.matches(ctx.root)) {
      const call = capture(m, "call");
      const hook = capture(m, "hook");
      const args = capture(m, "args");
      if (call === null || hook === null || args === null) continue;
      cov.seen();
      const opts = named(args)[0];
      const base = { line: line(call), hook: hook.text, enclosing: c.enclosingAt(call) };
      if (opts === undefined || opts.type !== "object") {
        cov.miss(call, `${hook.text} options are not an object literal: ${short(opts?.text ?? "()", 50)}`);
        c.facts.queryHooks.push({ ...base, fnKey: null, fnText: "", reference: null });
        continue;
      }
      const key = hook.text === "useMutation" ? "mutationFn" : "queryFn";
      const fn = objectPair(opts, key);
      if (fn === undefined || fn === null) {
        cov.miss(call, `${hook.text} has no literal ${key}${named(opts).some((p) => p.type === "spread_element") ? " (options spread)" : ""}`);
        c.facts.queryHooks.push({ ...base, fnKey: null, fnText: "", reference: null });
        continue;
      }
      c.facts.queryHooks.push({ ...base, fnKey: key, fnText: short(fn.text), reference: fn.type === "identifier" ? fn.text : null });
    }
    return cov.fact();
  },
};

export const ADAPTERS: Adapter[] = [http4kAdapter, fetchAdapter, reactQueryAdapter];

export function adaptersFor(lang: Language): Adapter[] {
  return ADAPTERS.filter((a) => a.languages.includes(lang));
}

export function adapterInfo(): AdapterInfo[] {
  return ADAPTERS.map(({ name, version, languages, covers, queries }) => ({ name, version, languages, covers, queries }));
}

const queryText = new Map<string, string>();
export function readQuery(name: string): string {
  let t = queryText.get(name);
  if (t === undefined) {
    t = readFileSync(join(QUERY_DIR, name), "utf8");
    queryText.set(name, t);
  }
  return t;
}

/** Hash of every query file + adapter version that applies to `lang` — part of the object key. */
export function adapterFingerprint(lang: Language): { queryHash: string; adapterVersion: string } {
  const adapters = adaptersFor(lang);
  const queryHash = sha256(adapters.flatMap((a) => a.queries.map((q) => `${q}\n${readQuery(q)}`)).join("\n\0\n"));
  const adapterVersion = adapters.map((a) => `${a.name}@${a.version}`).join(",");
  return { queryHash, adapterVersion };
}

