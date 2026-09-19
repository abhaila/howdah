/**
 * Per-file syntax facts — system-map 1b, eng review D23 (path-independent facts).
 *
 * `FileParser.parse(content, language)` turns bytes into `FileFacts`: declarations (with
 * declared parameter TYPE TEXT, extension receivers, container chains), package, imports, call
 * sites, casts (inventory only — SM-D4 gives the "unnecessary cast" judgement to the compiler),
 * names declared in function bodies, then the framework adapters' hits and coverage.
 *
 * Nothing here may depend on the file's path: the result is stored by content hash and shared
 * across paths, snapshots and runs (D14/13A). Paths, modules and identity keys are assembly's job.
 *
 * Failure policy (1b): a grammar that fails to load → `{ok: false, reason: "grammar unavailable…"}`
 * for every file of that language, never a throw. Every parser ERROR (and MISSING) node becomes an
 * `unparsed` region — the Kotlin v1.1.0 grammar fails on Kotlin 2.2 context parameters and 2.1
 * `when` guards — and NOTHING inside a region is emitted (no declarations, calls or adapter hits,
 * whose containers would be error-recovery guesses); every adapter's coverage turns partial.
 *
 * When unsure, emit nothing: anonymous objects/classes and property initializers are bodies,
 * not declaration scopes.
 */

import { readFileSync } from "node:fs";
import { Language as TSLanguage, Parser, Query } from "web-tree-sitter";
import { adaptersFor, readQuery } from "./adapters";
import { Collector, field, kids, line, endLine, named, tsStringValue, type N } from "./ast";
import { normType } from "./keys";
import { grammarPath, type GrammarOverrides } from "./languages";
import type { FileFacts, Language, OwnerRef, UnparsedRegion } from "./types";
import { cmpStr } from "./util";

/** Derived from the source of every fact-shaping module (version.ts) — never hand-bumped. */
export { EXTRACTOR_VERSION } from "./version";

interface Ctx {
  container: string[];
  enclosing: number | null;
  /**
   * Inside a function body, an anonymous object/class, or a property/field initializer:
   * declarations here are locals, never entities (an anonymous object's `run()` is not a member
   * of the class that holds it, nor a top-level function).
   */
  inBody: boolean;
  /** Kotlin: inside a lambda — an implicit receiver (`with`, `apply`, DSLs) may own any bare call. */
  inLambda?: boolean;
  /** TS: the entity node whose own parameter list must not be read as locals. */
  entityId?: number;
}

const TOP: Ctx = { container: [], enclosing: null, inBody: false };

/** ERROR / MISSING subtrees are never visited: their structure is a guess (unparsed regions). */
function visitChildren(n: N, ctx: Ctx, c: Collector, visit: Visitor): void {
  for (const k of named(n)) if (!k.isError && !k.isMissing) visit(k, ctx, c);
}

type Visitor = (n: N, ctx: Ctx, c: Collector) => void;

// ── Kotlin ──────────────────────────────────────────────────────────────────

const KOTLIN_TYPE_NODES = new Set(["user_type", "nullable_type", "function_type", "parenthesized_type", "non_nullable_type", "type_reference", "dynamic"]);

function kotlinParams(fn: N): { types: string[]; names: string[]; minArgs: number; maxArgs: number | null } {
  const types: string[] = [];
  const names: string[] = [];
  let minArgs = 0;
  let maxArgs: number | null = 0;
  const list = named(fn).find((k) => k.type === "function_value_parameters");
  if (list === undefined) return { types, names, minArgs, maxArgs };
  // `vararg` arrives as a parameter_modifiers sibling BEFORE its parameter; a default value as an
  // `=` sibling AFTER it. Both change what a call can pass (the arity guard) and the signature.
  const parts = kids(list);
  let vararg = false;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === undefined) continue;
    if (p.type === "parameter_modifiers") {
      vararg = /\bvararg\b/.test(p.text);
      continue;
    }
    if (p.type !== "parameter") continue;
    const pk = kids(p);
    const colon = pk.findIndex((k) => k.type === ":");
    const type = pk.slice(colon + 1).find((k) => k.isNamed);
    const name = pk.find((k) => k.type === "identifier");
    const t = type === undefined ? "" : normType(type.text);
    types.push(vararg ? `vararg ${t}` : t);
    names.push(name?.text ?? "");
    const hasDefault = parts[i + 1]?.type === "=";
    if (vararg) maxArgs = null;
    else {
      if (!hasDefault) minArgs++;
      if (maxArgs !== null) maxArgs++;
    }
    vararg = false;
  }
  return { types, names, minArgs, maxArgs };
}

function kotlinReceiver(fn: N): string | undefined {
  for (let i = 0; i < fn.childCount; i++) {
    if (fn.fieldNameForChild(i) === "name") return undefined;
    const k = fn.child(i);
    if (k !== null && KOTLIN_TYPE_NODES.has(k.type)) return normType(k.text);
  }
  return undefined;
}

function kotlinImport(n: N, c: Collector): void {
  const text = n.text.replace(/^import\s+/, "").replace(/\s+/g, " ").trim();
  const m = /^([\w.`]+?)(\.\*)?(?:\s+as\s+([\w`]+))?;?$/.exec(text);
  if (m === null || m[1] === undefined) return;
  c.facts.imports.push({ line: line(n), path: m[1], ...(m[2] !== undefined ? { wildcard: true } : {}), ...(m[3] !== undefined ? { alias: m[3] } : {}) });
}

/**
 * Kotlin modifiers that change who can see a declaration, or where its body lives: `private`
 * (file/class), `internal` (Gradle project), `expect`/`actual` (another source set).
 */
function kotlinVisibility(n: N): { private?: true; internal?: true; multiplatform?: true } {
  const mods = named(n).find((k) => k.type === "modifiers");
  const vis = mods === undefined ? [] : named(mods).filter((m) => m.type === "visibility_modifier").map((m) => m.text);
  const platform = mods !== undefined && named(mods).some((m) => m.type === "platform_modifier");
  return {
    ...(vis.includes("private") ? { private: true as const } : {}),
    ...(vis.includes("internal") ? { internal: true as const } : {}),
    ...(platform ? { multiplatform: true as const } : {}),
  };
}

/** Extension receiver of a property (`val String.x get() = …`), if any. */
function kotlinPropertyReceiver(n: N): string | undefined {
  for (const k of named(n)) {
    if (k.type === "variable_declaration") return undefined;
    if (KOTLIN_TYPE_NODES.has(k.type)) return normType(k.text);
  }
  return undefined;
}

const visitKotlin: Visitor = (n, ctx, c) => {
  switch (n.type) {
    case "package_header": {
      const q = named(n)[0];
      c.facts.package = q === undefined ? "" : q.text.replace(/\s+/g, "");
      return;
    }
    case "import":
      kotlinImport(n, c);
      return;
    case "type_alias": {
      const name = field(n, "type")?.text ?? "";
      if (ctx.inBody) c.local(name, n, ctx.enclosing);
      else c.addDecl(n, { kind: "type", name, container: ctx.container, topLevel: ctx.container.length === 0, ...kotlinVisibility(n) });
      return;
    }
    case "class_declaration":
    case "object_declaration":
    case "companion_object": {
      if (ctx.inBody) {
        // a local class is not an entity, but its name shadows outer classifiers
        const local = field(n, "name") ?? named(n).find((k) => k.type === "identifier") ?? null;
        if (local !== null) c.local(local.text, local, ctx.enclosing);
        break;
      }
      const nameNode = field(n, "name") ?? named(n).find((k) => k.type === "identifier") ?? null;
      const name = nameNode?.text ?? (n.type === "companion_object" ? "Companion" : "<anonymous>");
      const tokens = kids(n).map((k) => k.type);
      const mods = named(n).find((k) => k.type === "modifiers")?.text ?? "";
      const kind = n.type !== "class_declaration" ? "object" : tokens.includes("interface") ? "interface" : /\benum\b/.test(mods) ? "enum" : "class";
      const supertypes = named(n).some((k) => k.type === "delegation_specifiers");
      c.addDecl(n, { kind, name, container: ctx.container, topLevel: ctx.container.length === 0, ...(supertypes ? { supertypes: true } : {}), ...kotlinVisibility(n) });
      visitChildren(n, { ...ctx, container: [...ctx.container, name] }, c, visitKotlin);
      return;
    }
    case "object_literal":
      // `object : Runnable { override fun run() … }` — anonymous: its members are not entities.
      return visitChildren(n, { ...ctx, inBody: true }, c, visitKotlin);
    case "property_declaration":
      if (!ctx.inBody) {
        // A class/top-level property: recorded (never an entity — but names must resolve to it,
        // e.g. `"/api" bind api`); its initializer/accessors are code, not a declaration scope.
        const v = named(n).find((k) => k.type === "variable_declaration");
        const id = v === undefined ? undefined : named(v).find((k) => k.type === "identifier");
        const receiver = kotlinPropertyReceiver(n);
        if (id !== undefined) c.addDecl(n, { kind: "property", name: id.text, container: ctx.container, topLevel: ctx.container.length === 0, ...(receiver !== undefined ? { receiver } : {}), ...kotlinVisibility(n) });
        for (const k of named(n)) if (k.type !== "variable_declaration" && k.type !== "multi_variable_declaration" && !k.isError) visitKotlin(k, { ...ctx, inBody: true }, c);
        return;
      }
      break;
    case "lambda_literal":
    case "annotated_lambda":
      return visitChildren(n, { ...ctx, inLambda: true }, c, visitKotlin);
    case "function_declaration": {
      const name = field(n, "name")?.text ?? "";
      if (ctx.inBody) {
        c.local(name, n, ctx.enclosing);
        break;
      }
      const { types, names, minArgs, maxArgs } = kotlinParams(n);
      const receiver = kotlinReceiver(n);
      const idx = c.addDecl(n, {
        kind: "function",
        name,
        container: ctx.container,
        topLevel: ctx.container.length === 0,
        params: types,
        paramNames: names,
        minArgs,
        maxArgs,
        ...(receiver !== undefined ? { receiver } : {}),
        ...kotlinVisibility(n),
      });
      visitChildren(n, { ...ctx, enclosing: idx, inBody: true, inLambda: false }, c, visitKotlin);
      return;
    }
    case "call_expression": {
      const callee = named(n)[0];
      if (callee?.type === "identifier") c.call(callee.text, null, n, ctx.enclosing, ctx.inLambda === true);
      else if (callee?.type === "navigation_expression") {
        const parts = named(callee);
        const last = parts.at(-1);
        const recv = parts[0];
        if (last?.type === "identifier" && recv !== undefined && parts.length >= 2) c.call(last.text, recv.text, n, ctx.enclosing, ctx.inLambda === true);
      }
      break;
    }
    case "as_expression": {
      const op = kids(n).find((k) => k.type === "as" || k.type === "as?");
      const type = field(n, "right") ?? named(n).at(-1) ?? null;
      c.facts.casts.push({ line: line(n), kind: op?.type === "as?" ? "as?" : "as", type: type === null ? "" : normType(type.text) });
      break;
    }
    case "variable_declaration": {
      if (ctx.inBody) {
        const id = named(n).find((k) => k.type === "identifier");
        if (id !== undefined) c.local(id.text, id, ctx.enclosing);
      }
      break;
    }
  }
  visitChildren(n, ctx, c, visitKotlin);
};

// ── Java ────────────────────────────────────────────────────────────────────

const JAVA_TYPE_DECLS: Record<string, "class" | "interface" | "enum"> = {
  class_declaration: "class",
  record_declaration: "class",
  interface_declaration: "interface",
  annotation_type_declaration: "interface",
  enum_declaration: "enum",
};

function javaParams(fn: N): { types: string[]; names: string[] } {
  const types: string[] = [];
  const names: string[] = [];
  const list = field(fn, "parameters");
  if (list === null) return { types, names };
  for (const p of named(list)) {
    if (p.type === "formal_parameter") {
      const t = field(p, "type")?.text ?? "";
      const dims = field(p, "dimensions")?.text ?? "";
      types.push(normType(t + dims));
      names.push(field(p, "name")?.text ?? "");
    } else if (p.type === "spread_parameter") {
      const parts = kids(p);
      const dots = parts.findIndex((k) => k.type === "...");
      const typeText = parts
        .slice(0, dots)
        .filter((k) => k.type !== "modifiers")
        .map((k) => k.text)
        .join(" ");
      types.push(normType(typeText + "..."));
      const decl = parts.find((k) => k.type === "variable_declarator");
      names.push(decl === undefined ? "" : (field(decl, "name")?.text ?? ""));
    }
  }
  return { types, names };
}

const visitJava: Visitor = (n, ctx, c) => {
  const typeKind = JAVA_TYPE_DECLS[n.type];
  if (typeKind !== undefined) {
    if (ctx.inBody) return visitChildren(n, ctx, c, visitJava);
    const name = field(n, "name")?.text ?? "<anonymous>";
    const supertypes = kids(n).some((k) => k.type === "superclass" || k.type === "super_interfaces" || k.type === "extends_interfaces");
    c.addDecl(n, { kind: typeKind, name, container: ctx.container, topLevel: ctx.container.length === 0, ...(supertypes ? { supertypes: true } : {}) });
    return visitChildren(n, { ...ctx, container: [...ctx.container, name] }, c, visitJava);
  }
  switch (n.type) {
    case "object_creation_expression":
    case "enum_constant":
    case "static_initializer":
      // `new Runnable() { public void run() … }`, enum constant bodies, initializer blocks:
      // anonymous code — members declared here are not entities.
      return visitChildren(n, { ...ctx, inBody: true }, c, visitJava);
    case "field_declaration":
      if (!ctx.inBody) {
        // Field initializers are code; field names are not locals. Each field is a `property`
        // decl — for drift's near matches (`Runnable handler = () -> …` may be the "missing"
        // handler); the mount resolver skips Java properties, so its candidates are unchanged.
        for (const d of named(n)) {
          if (d.type !== "variable_declarator") continue;
          const nm = field(d, "name")?.text ?? "";
          if (nm !== "") c.addDecl(d, { kind: "property", name: nm, container: ctx.container, topLevel: false });
          const v = field(d, "value");
          if (v !== null && !v.isError) visitJava(v, { ...ctx, inBody: true }, c);
        }
        return;
      }
      break;
    case "package_declaration": {
      const q = named(n).find((k) => k.type === "scoped_identifier" || k.type === "identifier");
      c.facts.package = q === undefined ? "" : q.text.replace(/\s+/g, "");
      return;
    }
    case "import_declaration": {
      const q = named(n).find((k) => k.type === "scoped_identifier" || k.type === "identifier");
      if (q !== undefined) {
        const wildcard = named(n).some((k) => k.type === "asterisk");
        c.facts.imports.push({ line: line(n), path: q.text.replace(/\s+/g, ""), ...(wildcard ? { wildcard: true } : {}) });
      }
      return;
    }
    case "method_declaration":
    case "constructor_declaration":
    case "compact_constructor_declaration": {
      if (ctx.inBody) {
        // an anonymous-class member (`new Runnable() { public void run() … }`): a name, not an entity
        if (n.type === "method_declaration") c.local(field(n, "name")?.text ?? "", n, ctx.enclosing);
        break;
      }
      const name = n.type === "method_declaration" ? (field(n, "name")?.text ?? "") : "<init>";
      const { types, names } = javaParams(n);
      const varargs = types.at(-1)?.endsWith("...") === true;
      const idx = c.addDecl(n, { kind: "function", name, container: ctx.container, topLevel: false, params: types, paramNames: names, minArgs: varargs ? types.length - 1 : types.length, maxArgs: varargs ? null : types.length });
      return visitChildren(n, { ...ctx, enclosing: idx, inBody: true }, c, visitJava);
    }
    case "method_invocation": {
      const name = field(n, "name")?.text ?? "";
      const obj = field(n, "object");
      c.call(name, obj === null ? null : obj.text, n, ctx.enclosing);
      break;
    }
    case "cast_expression": {
      const types = kids(n)
        .filter((k, i) => n.fieldNameForChild(i) === "type")
        .map((k) => normType(k.text));
      c.facts.casts.push({ line: line(n), kind: "cast", type: types.join("&") || normType(field(n, "type")?.text ?? "") });
      break;
    }
    case "variable_declarator":
      if (ctx.inBody && n.parent?.type !== "spread_parameter") {
        const name = field(n, "name");
        if (name !== null) c.local(name.text, name, ctx.enclosing);
      }
      break;
    case "enhanced_for_statement":
    case "catch_formal_parameter": {
      const name = field(n, "name");
      if (name !== null && ctx.inBody) c.local(name.text, name, ctx.enclosing);
      break;
    }
    case "lambda_expression": {
      const params = field(n, "parameters");
      if (params !== null && ctx.inBody) {
        if (params.type === "identifier") c.local(params.text, params, ctx.enclosing);
        else for (const id of params.descendantsOfType("identifier")) if (id !== null && id.parent?.type !== "type_identifier") c.local(id.text, id, ctx.enclosing);
      }
      break;
    }
    case "class_body":
      if (ctx.inBody) return visitChildren(n, ctx, c, visitJava);
      break;
  }
  visitChildren(n, ctx, c, visitJava);
};

// ── TypeScript / TSX / JS ───────────────────────────────────────────────────

const TS_FN_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);
const TS_PARAM_OWNERS = new Set(["arrow_function", "function_expression", "function", "generator_function", "function_declaration", "generator_function_declaration", "method_definition"]);
const TS_CLIENT_FACTORY = /^(?:axios|ky)\.(?:create|extend)$/;
const TS_HOC = /^(?:React\.)?(?:memo|forwardRef)$|^observer$/;

function tsFunctionValue(v: N | null): N | null {
  if (v === null) return null;
  if (TS_FN_VALUES.has(v.type)) return v;
  if (v.type === "call_expression") {
    const fn = field(v, "function");
    const args = field(v, "arguments");
    if (fn !== null && args !== null && TS_HOC.test(fn.text)) {
      const inner = named(args)[0];
      if (inner !== undefined && TS_FN_VALUES.has(inner.type)) return inner;
    }
  }
  return null;
}

function tsParams(fn: N): { types: string[]; names: string[] } {
  const types: string[] = [];
  const names: string[] = [];
  const list = field(fn, "parameters");
  if (list === null) {
    const single = field(fn, "parameter");
    if (single !== null) {
      types.push("");
      names.push(single.text);
    }
    return { types, names };
  }
  for (const p of named(list)) {
    if (p.type !== "required_parameter" && p.type !== "optional_parameter") continue;
    const t = field(p, "type");
    types.push(t === null ? "" : normType(t.text.replace(/^\s*:/, "")));
    names.push(field(p, "pattern")?.text ?? "");
  }
  return { types, names };
}

function patternNames(p: N, out: N[]): void {
  if (p.type === "identifier" || p.type === "shorthand_property_identifier_pattern") out.push(p);
  else if (p.type === "pair_pattern") {
    const v = field(p, "value");
    if (v !== null) patternNames(v, out);
  } else if (p.type === "assignment_pattern" || p.type === "object_assignment_pattern") {
    const l = field(p, "left") ?? named(p)[0] ?? null;
    if (l !== null) patternNames(l, out);
  } else for (const k of named(p)) if (k.type !== "type_annotation") patternNames(k, out);
}

/** Record every name bound by a (possibly destructuring) pattern as a local. */
function patternLocals(p: N | null, ctx: Ctx, c: Collector): void {
  if (p === null) return;
  const out: N[] = [];
  patternNames(p, out);
  for (const id of out) c.local(id.text, id, ctx.enclosing);
}

function tsDeclareFunction(n: N, name: string, exportName: string | undefined, fnNode: N, ctx: Ctx, c: Collector): void {
  const { types, names } = tsParams(fnNode);
  const idx = c.addDecl(n, {
    kind: "function",
    name,
    container: ctx.container,
    topLevel: ctx.container.length === 0,
    params: types,
    paramNames: names,
    ...(exportName !== undefined ? { exported: true, exportName } : {}),
  });
  visitChildren(fnNode, { ...ctx, enclosing: idx, inBody: true, entityId: fnNode.id }, c, visitTs);
}

function tsClass(n: N, exportName: string | undefined, ctx: Ctx, c: Collector): void {
  const name = field(n, "name")?.text ?? exportName ?? "default";
  c.addDecl(n, { kind: "class", name, container: ctx.container, topLevel: ctx.container.length === 0, ...(exportName !== undefined ? { exported: true, exportName } : {}) });
  const body = field(n, "body");
  const inner: Ctx = { ...ctx, container: [...ctx.container, exportName === "default" ? "default" : name] };
  for (const k of named(n)) if (k.id !== body?.id) visitTs(k, ctx, c);
  if (body === null) return;
  for (const m of named(body)) {
    if (m.type === "method_definition") {
      tsDeclareFunction(m, field(m, "name")?.text ?? "", undefined, m, inner, c);
    } else if (m.type === "public_field_definition") {
      const fn = tsFunctionValue(field(m, "value"));
      if (fn !== null) tsDeclareFunction(m, field(m, "name")?.text ?? "", undefined, fn, inner, c);
      else {
        // `handler = debounce(fn)` — a field holding a value: recorded by name only
        const nm = field(m, "name")?.text ?? "";
        if (nm !== "") c.addDecl(m, { kind: "property", name: nm, container: inner.container, topLevel: false });
        visitTs(m, inner, c);
      }
    } else if (m.type !== "method_signature" && m.type !== "abstract_method_signature") visitTs(m, inner, c);
  }
}

/**
 * A top-level non-function binding (`export const api = { getThing() {…} }`): a `property` decl —
 * never an entity — plus one per member of an object-literal initializer (container = the
 * binding). Drift (1c) needs these names so a function written in a form the map does not model
 * is a "possible match", never proof that the function is missing.
 */
function tsValueDecl(d: N, name: string, exportName: string | undefined, value: N | null, c: Collector): void {
  c.addDecl(d, { kind: "property", name, container: [], topLevel: true, ...(exportName !== undefined ? { exported: true, exportName: name } : {}) });
  if (value?.type !== "object") return;
  for (const m of named(value)) {
    const key = m.type === "method_definition" ? field(m, "name") : m.type === "pair" ? field(m, "key") : m.type === "shorthand_property_identifier" ? m : null;
    if (key === null) continue;
    const member = key.type === "string" ? tsStringValue(key) : /^(property_identifier|identifier|shorthand_property_identifier)$/.test(key.type) ? key.text : null;
    if (member !== null && member !== "") c.addDecl(m, { kind: "property", name: member, container: [name], topLevel: false });
  }
}

/**
 * `namespace N { export function handler() {} }`: NOT modelled as entities (a key would need the
 * namespace path), so nothing inside becomes a top-level entity; the namespace and each member
 * it declares are recorded as `property` names (container = the namespace) for drift's near
 * matches, and the body is read as code (its declarations are locals).
 */
function tsNamespace(n: N, exportName: string | undefined, ctx: Ctx, c: Collector): void {
  const name = field(n, "name")?.text ?? "";
  if (name !== "") c.addDecl(n, { kind: "property", name, container: [], topLevel: true, ...(exportName !== undefined ? { exported: true, exportName: name } : {}) });
  const body = field(n, "body");
  if (body === null) return;
  for (const st of named(body)) {
    const d = st.type === "export_statement" ? field(st, "declaration") : st;
    if (d === null) continue;
    const members: N[] = [];
    if (d.type === "lexical_declaration" || d.type === "variable_declaration") {
      for (const v of named(d)) if (v.type === "variable_declarator") patternNames(field(v, "name") ?? v, members);
    } else {
      const nm = field(d, "name");
      if (nm !== null) members.push(nm);
    }
    for (const m of members) c.addDecl(m, { kind: "property", name: m.text, container: name === "" ? [] : [name], topLevel: false });
  }
  visitChildren(body, { ...ctx, inBody: true }, c, visitTs);
}

/** A top-level declaration (possibly under `export`). */
function tsTopDecl(n: N, exportName: string | undefined, isDefault: boolean, ctx: Ctx, c: Collector): boolean {
  switch (n.type) {
    case "function_declaration":
    case "generator_function_declaration": {
      const name = field(n, "name")?.text ?? "default";
      tsDeclareFunction(n, name, isDefault ? "default" : exportName !== undefined ? name : undefined, n, ctx, c);
      return true;
    }
    case "class_declaration":
    case "abstract_class_declaration":
    case "class":
      tsClass(n, isDefault ? "default" : exportName !== undefined ? (field(n, "name")?.text ?? "default") : undefined, ctx, c);
      return true;
    case "lexical_declaration":
    case "variable_declaration": {
      const isConst = kids(n).some((k) => k.type === "const");
      for (const d of named(n)) {
        if (d.type !== "variable_declarator") {
          visitTs(d, ctx, c);
          continue;
        }
        const nameNode = field(d, "name");
        const value = field(d, "value");
        const fn = tsFunctionValue(value);
        if (nameNode?.type === "identifier" && fn !== null) {
          tsDeclareFunction(d, nameNode.text, exportName !== undefined ? nameNode.text : undefined, fn, ctx, c);
          continue;
        }
        if (nameNode?.type === "identifier") tsValueDecl(d, nameNode.text, exportName, value, c);
        else if (nameNode !== null) {
          // `export const { handler } = make()` — each bound name is a top-level binding
          const out: N[] = [];
          patternNames(nameNode, out);
          for (const id of out) c.addDecl(id, { kind: "property", name: id.text, container: [], topLevel: true, ...(exportName !== undefined ? { exported: true, exportName: id.text } : {}) });
        }
        if (isConst && nameNode?.type === "identifier" && value !== null) {
          const s = tsStringValue(value);
          if (s !== null) c.consts.set(nameNode.text, s);
          // `const api = axios.create(…)` — an HTTP client by construction, whatever its name.
          if (value.type === "call_expression" && TS_CLIENT_FACTORY.test(field(value, "function")?.text ?? "")) c.clientNames.add(nameNode.text);
        }
        if (value !== null) visitTs(value, ctx, c);
      }
      return true;
    }
    case "interface_declaration":
    case "type_alias_declaration":
    case "enum_declaration": {
      const name = field(n, "name")?.text ?? "";
      const kind = n.type === "interface_declaration" ? "interface" : n.type === "enum_declaration" ? "enum" : "type";
      c.addDecl(n, { kind, name, container: [], topLevel: true, ...(exportName !== undefined ? { exported: true, exportName: name } : {}) });
      return true;
    }
    case "function_signature":
      return true; // overload / `declare function` — the implementation carries the key
    case "internal_module":
    case "module":
      tsNamespace(n, exportName, ctx, c);
      return true;
  }
  return false;
}

function tsImport(n: N, c: Collector, reexport: boolean): void {
  const src = field(n, "source");
  const source = src === null ? null : tsStringValue(src);
  if (source === null) return;
  const names: { imported: string; local: string }[] = [];
  for (const k of n.descendantsOfType(["import_specifier", "export_specifier", "namespace_import", "namespace_export", "import_clause"])) {
    if (k === null) continue;
    if (k.type === "import_specifier" || k.type === "export_specifier") {
      const nm = field(k, "name")?.text ?? "";
      const alias = field(k, "alias")?.text;
      names.push({ imported: nm, local: alias ?? nm });
    } else if (k.type === "namespace_import" || k.type === "namespace_export") {
      const id = named(k)[0];
      names.push({ imported: "*", local: id?.text ?? "*" });
    } else if (k.type === "import_clause") {
      const def = named(k).find((x) => x.type === "identifier");
      if (def !== undefined) names.push({ imported: "default", local: def.text });
    }
  }
  if (reexport && names.length === 0) names.push({ imported: "*", local: "*" });
  c.facts.imports.push({ line: line(n), source, names, ...(reexport ? { reexport: true } : {}) });
}

const visitTs: Visitor = (n, ctx, c) => {
  if (!ctx.inBody && ctx.container.length === 0 && tsTopDecl(n, undefined, false, ctx, c)) return;
  switch (n.type) {
    case "import_statement":
      tsImport(n, c, false);
      return;
    case "export_statement": {
      // `export` inside a namespace body (or any body): code, not a top-level declaration
      if (ctx.inBody) break;
      if (field(n, "source") !== null) {
        tsImport(n, c, true);
        return;
      }
      const isDefault = kids(n).some((k) => k.type === "default");
      const decl = field(n, "declaration");
      if (decl !== null) {
        tsTopDecl(decl, "export", isDefault, ctx, c);
        return;
      }
      const value = field(n, "value");
      if (isDefault && value !== null) {
        const fn = tsFunctionValue(value);
        if (fn !== null) tsDeclareFunction(n, "default", "default", fn, ctx, c);
        else if (value.type === "identifier") c.exportsInfo.aliases.set(value.text, "default");
        else if (value.type === "class") tsClass(value, "default", ctx, c);
        else {
          // `export default compose(…)` — a value, not a modelled function: recorded by name only
          c.addDecl(n, { kind: "property", name: "default", container: [], topLevel: true, exported: true, exportName: "default" });
          visitTs(value, ctx, c);
        }
        return;
      }
      for (const spec of n.descendantsOfType("export_specifier")) {
        if (spec === null) continue;
        const nm = field(spec, "name")?.text ?? "";
        c.exportsInfo.aliases.set(nm, field(spec, "alias")?.text ?? nm);
      }
      return;
    }
    case "function_declaration":
    case "generator_function_declaration":
      if (ctx.inBody) c.local(field(n, "name")?.text ?? "", n, ctx.enclosing);
      return visitChildren(n, { ...ctx, inBody: true }, c, visitTs);
    case "arrow_function":
    case "function_expression":
    case "function":
    case "generator_function":
    case "method_definition":
    case "class_body":
      // A function (or class) inside an expression is not an entity: what it declares are locals.
      return visitChildren(n, { ...ctx, inBody: true }, c, visitTs);
    case "variable_declarator":
      if (ctx.inBody) patternLocals(field(n, "name"), ctx, c);
      break;
    case "formal_parameters":
      // Parameters of a nested function are locals; those of the entity itself, or of a
      // function TYPE (`{ get(url: string): … }`), are not.
      if (ctx.inBody && n.parent !== null && n.parent.id !== ctx.entityId && TS_PARAM_OWNERS.has(n.parent.type)) {
        for (const p of named(n)) patternLocals(field(p, "pattern"), ctx, c);
      }
      break;
    case "catch_clause":
      if (ctx.inBody) patternLocals(field(n, "parameter"), ctx, c);
      break;
    case "call_expression": {
      const fn = field(n, "function");
      if (fn?.type === "identifier") c.call(fn.text, null, n, ctx.enclosing);
      else if (fn?.type === "member_expression") {
        const prop = field(fn, "property");
        const obj = field(fn, "object");
        if (prop !== null && obj !== null) c.call(prop.text, obj.text, n, ctx.enclosing);
      }
      break;
    }
    case "as_expression": {
      const t = named(n).at(-1);
      c.facts.casts.push({ line: line(n), kind: "as", type: t === undefined ? "" : normType(t.text) });
      break;
    }
    case "type_assertion": {
      const t = named(n).find((k) => k.type === "type_arguments");
      c.facts.casts.push({ line: line(n), kind: "angle", type: t === undefined ? "" : normType(t.text.replace(/^<|>$/g, "")) });
      break;
    }
    case "non_null_expression":
      c.facts.casts.push({ line: line(n), kind: "non-null", type: "" });
      break;
  }
  visitChildren(n, ctx, c, visitTs);
};

/** TS export aliases are known only after the whole file is read; apply them to the decls. */
function applyTsAliases(c: Collector): void {
  for (const d of c.facts.decls) {
    if (!d.topLevel || d.exportName !== undefined) continue;
    const alias = c.exportsInfo.aliases.get(d.name);
    if (alias !== undefined) {
      d.exported = true;
      d.exportName = alias;
    }
  }
}

// ── unparsed regions ────────────────────────────────────────────────────────

/**
 * Every ERROR / MISSING node, widened to the end of its parent: error recovery can re-attach the
 * code AFTER a bad token to the wrong parent (a class member recovered as a top-level function),
 * so nothing from the error to the end of the enclosing construct is trusted.
 */
function unparsedRegions(root: N): UnparsedRegion[] {
  const out: UnparsedRegion[] = [];
  if (!root.hasError) return out;
  const stack: N[] = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === undefined) break;
    if (n.isError || n.isMissing) {
      const end = Math.max(endLine(n), n.parent === null ? endLine(n) : endLine(n.parent));
      out.push({ startLine: line(n), endLine: end, kind: n.isError ? "error" : "missing" });
      continue;
    }
    for (const k of kids(n)) if (k.hasError || k.isMissing || k.isError) stack.push(k);
  }
  return out.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

/** Identifiers in the unparsed text: any of them may be declared there, invisibly to us. */
function unparsedNames(content: string, regions: UnparsedRegion[]): string[] {
  if (regions.length === 0) return [];
  const lines = content.split("\n");
  const out = new Set<string>();
  for (const r of regions) for (const m of lines.slice(r.startLine - 1, r.endLine).join("\n").match(/[A-Za-z_$][\w$]*/g) ?? []) out.add(m);
  return [...out].sort(cmpStr);
}

/**
 * Drop every fact that overlaps an unparsed region (and everything a dropped declaration
 * encloses), remapping `enclosing` indices; mark every adapter's coverage partial. The region
 * itself is the only fact about that code — "not checked", never a guessed declaration.
 */
function dropUnparsed(f: FileFacts): void {
  if (f.unparsed.length === 0) return;
  const overlaps = (a: number, b: number) => f.unparsed.some((r) => a <= r.endLine && r.startLine <= b);
  const remap = new Map<number, number>();
  const decls = f.decls.filter((d, i) => {
    if (overlaps(d.line, d.endLine)) return false;
    remap.set(i, remap.size);
    return true;
  });
  const enc = <T extends { enclosing: number | null }>(x: T): T | null => {
    if (x.enclosing === null) return x;
    const j = remap.get(x.enclosing);
    return j === undefined ? null : { ...x, enclosing: j };
  };
  const keep = <T extends { line: number; endLine?: number; enclosing: number | null }>(xs: T[]): T[] =>
    xs.flatMap((x) => {
      if (overlaps(x.line, x.endLine ?? x.line)) return [];
      const y = enc(x);
      return y === null ? [] : [y];
    });
  /** A local owner's `enclosing` must survive the remap too; if its function was dropped, so is it. */
  const owner = (o: OwnerRef | null): OwnerRef | null | false => {
    if (o === null || o.enclosing === null) return o;
    const j = remap.get(o.enclosing);
    return j === undefined ? false : { ...o, enclosing: j };
  };
  const withOwner = <T extends { owner: OwnerRef | null }>(xs: T[]): T[] =>
    xs.flatMap((x) => {
      const o = owner(x.owner);
      return o === false ? [] : [{ ...x, owner: o }];
    });
  f.decls = decls;
  f.calls = keep(f.calls);
  f.locals = keep(f.locals);
  f.routes = withOwner(keep(f.routes));
  f.mounts = withOwner(keep(f.mounts));
  f.serverRoots = keep(f.serverRoots);
  f.groups = f.groups.flatMap((g) => {
    if (overlaps(g.line, g.line)) return [];
    const o = owner(g);
    return o === false || o === null ? [] : [o];
  });
  f.fetches = keep(f.fetches);
  f.queryHooks = keep(f.queryHooks);
  f.casts = f.casts.filter((x) => !overlaps(x.line, x.line));
  const ranges = f.unparsed.map((r) => `${r.startLine}-${r.endLine}`).join(", ");
  f.coverage = f.coverage.map((cov) => ({
    ...cov,
    status: "partial",
    unresolved: [...cov.unresolved.filter((u) => !overlaps(u.line, u.line)), ...f.unparsed.map((r) => ({ line: r.startLine, reason: `unparsed region (lines ${ranges}): constructs there are not checked` }))]
      .sort((a, b) => a.line - b.line || cmpStr(a.reason, b.reason))
      .filter((u, i, all) => i === 0 || u.reason !== all[i - 1]?.reason || u.line !== all[i - 1]?.line),
  }));
}

// ── the parser ──────────────────────────────────────────────────────────────

export type ParseOutcome = { ok: true; facts: FileFacts } | { ok: false; reason: string };

let initOnce: Promise<void> | undefined;
function initRuntime(): Promise<void> {
  initOnce ??= Parser.init();
  return initOnce;
}

const VISITORS: Record<Language, Visitor> = {
  kotlin: visitKotlin,
  java: visitJava,
  typescript: visitTs,
  tsx: visitTs,
  javascript: visitTs,
};

export class FileParser {
  private readonly grammars = new Map<Language, Promise<TSLanguage | Error>>();
  private readonly queries = new Map<string, Query | Error>();
  private readonly parser: Parser;

  private constructor(private readonly overrides: GrammarOverrides | undefined) {
    this.parser = new Parser();
  }

  static async create(overrides?: GrammarOverrides): Promise<FileParser> {
    await initRuntime();
    return new FileParser(overrides);
  }

  private grammar(lang: Language): Promise<TSLanguage | Error> {
    let g = this.grammars.get(lang);
    if (g === undefined) {
      const path = grammarPath(lang, this.overrides);
      g = (async () => {
        try {
          return await TSLanguage.load(readFileSync(path));
        } catch (e) {
          return e instanceof Error ? e : new Error(String(e));
        }
      })();
      this.grammars.set(lang, g);
    }
    return g;
  }

  private query(lang: Language, grammar: TSLanguage, name: string): Query | Error {
    const key = `${lang}/${name}`;
    let q = this.queries.get(key);
    if (q === undefined) {
      try {
        q = new Query(grammar, readQuery(name));
      } catch (e) {
        q = e instanceof Error ? e : new Error(String(e));
      }
      this.queries.set(key, q);
    }
    return q;
  }

  async parse(content: string, lang: Language): Promise<ParseOutcome> {
    const grammar = await this.grammar(lang);
    if (grammar instanceof Error) return { ok: false, reason: `grammar unavailable: ${grammar.message.split("\n")[0] ?? ""}` };
    this.parser.setLanguage(grammar);
    const tree = this.parser.parse(content);
    if (tree === null) return { ok: false, reason: "parser returned no tree" };
    try {
      const root = tree.rootNode;
      const c = new Collector(lang);
      if (lang === "kotlin" || lang === "java") c.facts.package = "";
      VISITORS[lang](root, TOP, c);
      if (lang !== "kotlin" && lang !== "java") applyTsAliases(c);
      c.facts.unparsed = unparsedRegions(root);
      for (const a of adaptersFor(lang)) {
        c.facts.coverage.push(a.run({ root, source: content, collector: c, query: (name) => this.query(lang, grammar, name) }));
      }
      dropUnparsed(c.facts);
      c.facts.unparsedNames = unparsedNames(content, c.facts.unparsed);
      return { ok: true, facts: c.facts };
    } finally {
      tree.delete();
    }
  }
}
