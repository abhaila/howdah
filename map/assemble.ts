/**
 * Snapshot assembly — system-map 1b (eng review D14/13A + D23 + D8/7A).
 *
 * `assemble(manifest, store)` contextualises path-free objects into a map: it adds each file's
 * path, its block (Gradle project + package for JVM, nearest package.json dir for TS), identity
 * keys, evidence `file:line`, and the facts that need more than one file — http4k mount prefixes,
 * edges, FE→BE joins. It is a pure function of (manifest, store): the same manifest always
 * reconstructs the same map, which is what lets a run log carry only a manifest hash.
 *
 * Rule throughout: when unsure, emit nothing / `partial` coverage with a reason — never a guess.
 *
 * http4k mounts: a routes group's absolute prefix is known only if its owner DECLARATION is what
 * an `.asServer(…)` serves (or the group is literally that receiver), or is mounted exactly
 * once, by a literal prefix, from an owner whose prefix is itself known — across files. Every
 * reference is resolved by scope to one declaration (see MountResolver); a bare name never
 * matches "any declaration with that name". Otherwise the routes are keyed `METHOD {*}/path` and
 * the file's http4k coverage is partial with the reason.
 *
 * Collisions: if two entities end up with the same key, EVERY one of them is marked
 * `ambiguous` (and so is any edge touching one); a join involving one is never `exact`.
 *
 * Call edges are syntactic (SM-D4): a bare call becomes an edge only when the callee's simple
 * name resolves to exactly one function by scope (same class → same file → same package/module →
 * explicit import), and NOT when it may bind to something syntax can't see: a local or parameter
 * of that name, an inherited member (the caller's class has supertypes → same-class only), or a
 * Kotlin lambda's implicit receiver (`with(sb) { append(…) }` → no edge). SCIP owns the rest.
 *
 * A missing/corrupt object or build-manifest blob never crashes assembly: the file is reported
 * `not-checked` with the reason.
 */

import { posix } from "node:path";
import { adapterInfo, refName } from "./adapters";
import { joinFetch, type RouteRef } from "./join";
import { edgeKey, fetchSiteKey, joinPaths, jvmBlockKey, jvmFunctionKey, normTemplate, routeKey, tsBlockKey, tsFunctionKey, tsModulePath, TS_MODULE_LEVEL } from "./keys";
import { familyOf } from "./languages";
import { gradleBuilds, jvmModuleOf, projectInfos, tsPackageDirOf } from "./modules";
import { manifestHash, type MapStore } from "./store";
import type { AssembledFile, AssembledMap, Block, DeclFact, Edge, EdgeKind, Entity, FileCoverage, FileFacts, HandlerRef, Join, Manifest, MountFact, NotCheckedFile, OwnerRef, RefSite, RouteFact } from "./types";
import { byPath, cmpStr } from "./util";

const TS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

interface FileCtx {
  file: AssembledFile;
  /** JVM: the Gradle build root the file belongs to ("" = repo root). */
  buildRoot: string;
  /** JVM: build root + Gradle project path (`:m1`) — Kotlin's module, for same-package/internal. */
  project: string;
  facts: FileFacts;
  /** decl index → entity key (functions only). */
  declKeys: Map<number, string>;
}

function ev(file: string, line: number): string {
  return `${file}:${line}`;
}

function resolveTsImport(from: string, source: string, files: Set<string>): string | null {
  if (!source.startsWith(".")) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), source));
  const stem = base.replace(/\.(m?js|cjs|jsx)$/, "");
  const tries = [base, ...TS_EXTS.map((e) => stem + e), ...TS_EXTS.map((e) => `${base}/index${e}`)];
  for (const t of tries) if (files.has(t)) return tsModulePath(t);
  return null;
}

function fnKeyOf(f: FileCtx, d: DeclFact): string {
  if (f.file.module !== undefined) {
    const [cls] = d.container;
    return cls === undefined ? tsFunctionKey(f.file.module, d.exportName ?? d.name) : tsFunctionKey(f.file.module, cls, d.name);
  }
  return jvmFunctionKey({ pkg: f.facts.package ?? "", container: d.container, name: d.name, params: d.params ?? [], ...(d.receiver !== undefined ? { receiver: d.receiver } : {}) });
}

/** Locals and parameters of function `idx` — names that shadow anything declared outside it. */
function scopeNames(facts: FileFacts, idx: number): Set<string> {
  const out = new Set<string>();
  for (const l of facts.locals) if (l.enclosing === idx) out.add(l.name);
  for (const p of facts.decls[idx]?.paramNames ?? []) for (const m of p.match(/[A-Za-z_$][\w$]*/g) ?? []) out.add(m);
  return out;
}

/** Does any class/object in `container` declare supertypes (so a bare call may be inherited)? */
function inheritsIn(facts: FileFacts, container: string[]): boolean {
  for (let i = 1; i <= container.length; i++) {
    const outer = container.slice(0, i - 1).join(".");
    const name = container[i - 1];
    if (facts.decls.some((d) => (d.kind === "class" || d.kind === "object" || d.kind === "interface" || d.kind === "enum") && d.name === name && d.container.join(".") === outer && d.supertypes === true)) return true;
  }
  return false;
}

// ── http4k mount resolution ─────────────────────────────────────────────────

interface Located<T> {
  file: string;
  fact: T;
}

/**
 * Where a group sits: `prefix` is the part of the path proven by literal mounts; `open` means
 * something unknown sits in front of it (the key then starts with `{*}`); `why` says what.
 */
interface Placement {
  prefix: string;
  open: boolean;
  why: string;
}

type Resolved = { id: string } | { why: string };

interface DeclRow {
  id: string;
  file: string;
  pkg: string;
  /** Fully qualified name (`a.app`, `c.X.Holder`). */
  fqn: string;
  build: string;
  project: string;
  internal: boolean;
  container: string;
  name: string;
  kind: DeclFact["kind"];
  private: boolean;
  topLevel: boolean;
  /** An extension (function or property) — callable through an implicit receiver. */
  ext: boolean;
  multiplatform: boolean;
  supertypes: boolean;
  minArgs?: number;
  maxArgs?: number | null;
}

const CLASS_KINDS = new Set<DeclFact["kind"]>(["class", "object", "interface", "enum"]);
/** Classifier-like names: classes, objects, interfaces, enums and typealiases. */
const CLASSIFIER_KINDS = new Set<DeclFact["kind"]>([...CLASS_KINDS, "type"]);

const declId = (file: string, line: number, name: string): string => `${file}:${line}:${name}`;
const ownerId = (file: string, o: OwnerRef): string => declId(file, o.line, o.name) + (o.local ? ":local" : "");

const JVM_SOURCE = /\.(kt|java)$/;

/**
 * http4k mount resolution — PESSIMISTIC BY CONSTRUCTION (slice 1; exact resolution is SCIP's job
 * in slice 2). Owners are declarations (file + line + name). A reference — a mount target
 * (`"/api" bind orderRoutes()`) or what `.asServer(…)` serves — resolves to a declaration ONLY in
 * the simple, fully-modelled cases below; every other case is UNKNOWN (the group's routes get a
 * `{*}` prefix and the file partial coverage, with the reason). Audit, rule by rule:
 *
 *   U1 lambdas         a reference inside any lambda → unknown (an implicit receiver — `with`,
 *                      `apply`, `run`, `this@Label`, DSL builders — may own the name).
 *   U2 opaque          anything but `name()`, `name`, `Cls().m()`, `Cls.m()`, `Cls.p`, `.then(x)`,
 *                      `x.withFilter(f)` → unknown (`this.x`, `this@L.x`, chains, `if`, …).
 *   U3 locals          a local/param/local class/local function with the name → unknown, except a
 *                      local `val` holding a routes group, referenced by name (it shadows exactly).
 *   U4 extensions      any extension function/property with the name anywhere in the snapshot →
 *                      unknown for a bare name (implicit receivers are not modelled).
 *   U5 one candidate   a bare name (call or value) resolves only if EXACTLY ONE declaration with
 *                      that name is visible across EVERY scope level at once — enclosing classes'
 *                      members and companions, explicit imports, same package, star imports.
 *                      Two or more (overloads, member vs top-level, companion vs top-level,
 *                      explicit import vs same package, default/named args picking an overload)
 *                      → unknown: applicability-based overload resolution is not modelled.
 *   U6 kinds           a call must resolve to a function — a property, object or class with the
 *                      name means `invoke` or a constructor → unknown. A value reference must
 *                      resolve to a property.
 *   U7 supertypes      any enclosing class (or a class being looked into) with supertypes →
 *                      unknown (an inherited member or nested classifier could be the target).
 *   U8 imports         explicit imports bind `alias ?? last segment`. More than one binding
 *                      import, or a binding import whose target is outside the snapshot →
 *                      unknown. A name imported under an alias is not visible under its original
 *                      name. Any star import of a package absent from the snapshot → unknown.
 *   U9 modules         same-package declarations from EVERY Gradle project and build are COUNTED
 *                      for U5 (a dependency's package is visible without an import, so a
 *                      cross-project duplicate blocks), except `internal` outside its own project
 *                      and `private` outside its file. But a name RESOLVES only if the unique
 *                      candidate is in the site's OWN Gradle project; a unique candidate in any
 *                      other project — same package, explicit import or classifier — → unknown:
 *                      cross-project resolution needs the dependency graph and is out of scope
 *                      for the syntactic tier (SCIP, slice 2). Build scripts' dependencies are
 *                      never read.
 *   U10 completeness   a JVM file of the site's, the target's, or any same-package project that
 *                      was skipped or not checked, whose unparsed regions mention the name, or a
 *                      project applying ksp/kapt or a generated srcDir → unknown (a hidden
 *                      declaration could change the answer). Generated sources outside git are a
 *                      blind spot; test source sets share their project's key (recall, not
 *                      precision).
 *   U11 multiplatform  any candidate marked `expect`/`actual` → unknown.
 *   U12 typealiases    a class name that resolves to a typealias → unknown.
 *   U13 classifiers    `Cls` in `Cls.m()` / `Cls().m()` resolves by exact classifier priority:
 *                      innermost enclosing class's NESTED classifiers first (outward), then
 *                      explicit import, same package (same project), star import — with U7/U8/U9/
 *                      U10/U12; any value or function with that name in the member scopes →
 *                      unknown. `Cls.m` looks in object `Cls` or `Cls`'s companion; `Cls().m` in
 *                      class `Cls` itself; exactly one member with that name, of the right kind.
 *   U14 Java           Java declarations take part as candidates (so they trigger U5) but are
 *                      never routes owners; Java call sites are not modelled.
 *   U15 arity          a call whose argument count cannot match the lone candidate's parameters
 *                      (defaults and vararg accounted for) → unknown. Spread arguments skip it.
 *   U16 wrappers       a group is `rooted` only when the `.asServer(…)` receiver reaches it through
 *                      modelled wrappers (parentheses, `.then(x)`'s single argument, the receiver
 *                      of `.withFilter(f)`); any other call or member in between (`.withBasePath`,
 *                      `createApp(routes(…))`) → unknown, with that wrapper named.
 *
 * Documented limitations. All but the two marked PRECISION cost recall only (routes keyed `{*}/…`,
 * files partial):
 *   - Routes served through anything other than a direct, unique, same-project Kotlin reference
 *     stay `{*}`: references inside lambdas, local factory vals (`val app = createApp()`),
 *     filters other than `.then(x)` / `.withFilter(f)`, `.withBasePath(…)`, extension-function
 *     owners, typealiases, expect/actual, Java call sites, and every cross-project reference.
 *   - U5 is pessimistic: overloads, same-named test helpers (test source sets share their
 *     project's key), member vs top-level, and cross-project duplicates all make a name unknown.
 *   - PRECISION blind spot: generated sources that are not in git are invisible. Projects
 *     applying ksp/kapt or a generated srcDir are treated as incomplete; other generators are
 *     not detected, so a hidden same-named declaration would not block U5.
 *   - PRECISION blind spot: declarations from library jars in the app's own package are
 *     invisible — a jar could hold the real target of a name we resolve (the U15 arity guard
 *     covers only part of this). SCIP (slice 2) closes both.
 *   - Call edges, joins and keys are the syntactic tier; exact resolution belongs to SCIP
 *     (slice 2).
 * Any name with more than one owner declaration is therefore never rooted or mounted through.
 */
class MountResolver {
  private readonly rows: DeclRow[] = [];
  private readonly byName = new Map<string, DeclRow[]>();
  private readonly byFqn = new Map<string, DeclRow[]>();
  /** Every JVM package with at least one declaration in the snapshot. */
  private readonly packages = new Set<string>();
  private readonly localOwners = new Map<string, string>();
  /** ownerIds that hold a routes(…) group. */
  readonly groups = new Set<string>();
  /** ownerIds whose group has at least one literal route or mount. */
  readonly populated = new Set<string>();
  private readonly names = new Map<string, string>();
  private readonly roots = new Set<string>();
  /** `.asServer` receivers that resolved to nothing, by the simple name they refer to. */
  private readonly unresolvedRoots: { name: string; text: string }[] = [];
  private readonly mountsByTarget = new Map<string, Located<MountFact>[]>();
  /** Per mount (file:line): what its target resolved to. */
  readonly mountTargets = new Map<string, Resolved>();
  private readonly memo = new Map<string, Placement>();
  /** Per Gradle project: names mentioned in unparsed regions (U10). */
  private readonly hiddenNames = new Map<string, Set<string>>();

  /** Per package: every project with a declaration in it (U10 looks at all of them). */
  private readonly packageProjects = new Map<string, Set<string>>();

  /** `incomplete`: per Gradle project, why its sources may be incomplete (U10). */
  constructor(
    ctxs: FileCtx[],
    private readonly incomplete: Map<string, string[]>,
  ) {
    for (const f of ctxs) {
      if (f.file.module !== undefined) continue;
      const pkg = f.facts.package ?? "";
      const hidden = this.hiddenNames.get(f.project) ?? new Set<string>();
      for (const n of f.facts.unparsedNames ?? []) hidden.add(n);
      this.hiddenNames.set(f.project, hidden);
      for (const d of f.facts.decls) {
        if (d.kind !== "function" && d.kind !== "property" && !CLASSIFIER_KINDS.has(d.kind)) continue;
        const fqn = [pkg, ...d.container, d.name].filter((x) => x !== "").join(".");
        const row: DeclRow = {
          id: declId(f.file.path, d.line, d.name),
          file: f.file.path,
          pkg,
          fqn,
          build: f.buildRoot,
          project: f.project,
          internal: d.internal === true,
          container: d.container.join("."),
          name: d.name,
          kind: d.kind,
          private: d.private === true,
          topLevel: d.topLevel,
          ext: d.receiver !== undefined,
          multiplatform: d.multiplatform === true,
          supertypes: d.supertypes === true,
          ...(d.minArgs !== undefined ? { minArgs: d.minArgs } : {}),
          ...(d.maxArgs !== undefined ? { maxArgs: d.maxArgs } : {}),
        };
        this.rows.push(row);
        const list = this.byName.get(d.name) ?? [];
        list.push(row);
        this.byName.set(d.name, list);
        const byF = this.byFqn.get(fqn) ?? [];
        byF.push(row);
        this.byFqn.set(fqn, byF);
        this.packages.add(pkg);
        const pp = this.packageProjects.get(pkg) ?? new Set<string>();
        pp.add(f.project);
        this.packageProjects.set(pkg, pp);
      }
      for (const g of f.facts.groups) {
        const id = ownerId(f.file.path, g);
        this.groups.add(id);
        this.names.set(id, g.name);
        if (g.local) this.localOwners.set(`${f.file.path}:${g.enclosing ?? "-"}:${g.name}`, id);
      }
      for (const r of f.facts.routes) if (r.owner !== null) this.populated.add(ownerId(f.file.path, r.owner));
      for (const m of f.facts.mounts) if (m.owner !== null) this.populated.add(ownerId(f.file.path, m.owner));
    }
    for (const f of ctxs) {
      for (const sr of f.facts.serverRoots) {
        const r = this.resolve(f, sr.ref, sr);
        if ("id" in r) this.roots.add(r.id);
        else if (sr.ref.kind !== "opaque") this.unresolvedRoots.push({ name: sr.ref.name, text: `${sr.text} (${r.why})` });
      }
      for (const m of f.facts.mounts) {
        const r = this.resolve(f, m.target, m);
        this.mountTargets.set(`${f.file.path}:${m.line}`, r);
        if (!("id" in r)) continue;
        const list = this.mountsByTarget.get(r.id) ?? [];
        list.push({ file: f.file.path, fact: m });
        this.mountsByTarget.set(r.id, list);
      }
    }
  }

  // ── helpers ──

  private visibleFrom(f: FileCtx) {
    return (r: DeclRow) => !(r.private && r.file !== f.file.path) && !(r.internal && r.project !== f.project);
  }

  /** U10: could a hidden declaration in these projects (or any project of `pkg`) carry `name`? */
  private incompleteFor(name: string, projects: string[], pkg?: string): string | null {
    const all = [...projects, ...(pkg === undefined ? [] : [...(this.packageProjects.get(pkg) ?? [])])];
    for (const p of [...new Set(all)].sort(cmpStr)) {
      const why = this.incomplete.get(p) ?? [];
      if (why.length > 0) return `project ${p || ":"} may hide declarations: ${why.slice(0, 3).join("; ")}${why.length > 3 ? "; …" : ""}`;
      if (this.hiddenNames.get(p)?.has(name) === true) return `an unparsed region in project ${p || ":"} mentions \`${name}\``;
    }
    return null;
  }

  /** U9: only a candidate in the site's OWN Gradle project may be the answer. */
  private crossProject(f: FileCtx, row: DeclRow): string | null {
    if (row.project === f.project) return null;
    return `\`${row.name}\` is declared in project ${row.project || ":"}; cross-project resolution is out of scope for the syntactic tier (SCIP, slice 2)`;
  }

  /** U15: can a call with `args` arguments bind to `row`? */
  private arity(row: DeclRow, args: number | undefined, what: string): string | null {
    if (args === undefined || row.minArgs === undefined) return null;
    if (args < row.minArgs || (row.maxArgs !== null && row.maxArgs !== undefined && args > row.maxArgs)) {
      return `the call passes ${args} argument(s); \`${what}\` takes ${row.minArgs}${row.maxArgs === null ? "+" : row.maxArgs === row.minArgs ? "" : `..${row.maxArgs}`}`;
    }
    return null;
  }

  /** Enclosing class levels, innermost first: [{container path, row of the class}]. */
  private levels(f: FileCtx, container: string[]): { path: string; cls: DeclRow | undefined }[] {
    const out: { path: string; cls: DeclRow | undefined }[] = [];
    for (let i = container.length; i >= 1; i--) {
      const path = container.slice(0, i).join(".");
      const outer = container.slice(0, i - 1).join(".");
      const cls = this.rows.find((r) => r.file === f.file.path && CLASS_KINDS.has(r.kind) && r.container === outer && r.name === container[i - 1]);
      out.push({ path, cls });
    }
    return out;
  }

  /**
   * U8: the explicit imports binding `name`. `{ rows }` when exactly one import binds it and
   * its target is in the snapshot; `{ why }` when that is unknowable; null when none binds it.
   */
  private explicitImport(f: FileCtx, name: string): { rows: DeclRow[] } | { why: string } | null {
    const imports = f.facts.imports.filter((i): i is typeof i & { path: string } => i.path !== undefined && i.wildcard !== true);
    const last = (path: string) => path.split(".").at(-1) ?? path;
    const binding = imports.filter((i) => (i.alias ?? last(i.path)) === name);
    if (binding.length === 0) return null;
    if (binding.length > 1) return { why: `${binding.length} imports bind \`${name}\` (${binding.map((i) => i.path + (i.alias !== undefined ? ` as ${i.alias}` : "")).join(", ")})` };
    const imp = binding[0];
    if (imp === undefined) return null;
    const rows = (this.byFqn.get(imp.path) ?? []).filter(this.visibleFrom(f));
    if (rows.length === 0) return { why: `\`${name}\` is imported from ${imp.path}, which is not in this snapshot` };
    return { rows };
  }

  /** Top-level candidates for `name` from file `f`: same package (U9) + star imports (U8). */
  private topLevelRows(f: FileCtx, name: string): { rows: DeclRow[] } | { why: string } {
    const imports = f.facts.imports.filter((i): i is typeof i & { path: string } => i.path !== undefined);
    const last = (path: string) => path.split(".").at(-1) ?? path;
    const aliasedAway = new Set(imports.filter((i) => i.wildcard !== true && i.alias !== undefined && last(i.path) === name).map((i) => i.path));
    const pkg = f.facts.package ?? "";
    const visible = this.visibleFrom(f);
    const cands = (this.byName.get(name) ?? []).filter((r) => r.topLevel && visible(r) && !aliasedAway.has(r.fqn));
    const stars = imports.filter((i) => i.wildcard === true);
    const external = stars.filter((st) => !this.packages.has(st.path));
    if (external.length > 0) return { why: `\`${name}\` may come from star import ${external.map((st) => `${st.path}.*`).join(", ")} (not in this snapshot)` };
    // U9: same package from EVERY project/build (visibility already enforces private/internal)
    return { rows: cands.filter((r) => r.pkg === pkg || stars.some((st) => st.path === r.pkg)) };
  }

  private one(cands: DeclRow[], what: string): Resolved {
    const ids = [...new Set(cands.map((c) => c.id))];
    const only = ids[0];
    if (ids.length === 1 && only !== undefined) return { id: only };
    if (ids.length === 0) return { why: `\`${what}\` resolves to no declaration in scope` };
    return { why: `\`${what}\` has ${ids.length} visible declarations (overload/scope resolution by applicability is not modelled)` };
  }

  // ── resolution ──

  resolve(f: FileCtx, ref: HandlerRef, site: RefSite): Resolved {
    if (f.file.module !== undefined || f.file.language !== "kotlin") return { why: "only Kotlin call sites are modelled" };
    if (ref.kind === "opaque") return { why: `\`${ref.text}\` is not a modelled reference` }; // U2
    if (site.inLambda === true) return { why: `\`${refName(ref)}\` is referenced inside a lambda (an implicit receiver may own it)` }; // U1
    return ref.kind === "member" ? this.resolveMember(f, ref, site) : this.resolveBare(f, ref, site);
  }

  /** U3–U11 for `name()` / `name`. */
  private resolveBare(f: FileCtx, ref: { kind: "call" | "name"; name: string; args?: number }, site: RefSite): Resolved {
    const { name } = ref;
    if (site.enclosing !== null && scopeNames(f.facts, site.enclosing).has(name)) {
      const local = this.localOwners.get(`${f.file.path}:${site.enclosing}:${name}`);
      if (ref.kind === "name" && local !== undefined) return { id: local };
      return { why: `\`${name}\` is a local, parameter or local declaration; what it holds is not visible to syntax` }; // U3
    }
    if ((this.byName.get(name) ?? []).some((r) => r.ext)) return { why: `an extension named \`${name}\` exists (implicit receivers are not modelled)` }; // U4

    const cands: DeclRow[] = [];
    for (const lv of this.levels(f, site.container)) {
      if (lv.cls?.supertypes === true) return { why: `\`${lv.path}\` has supertypes; \`${name}\` may be inherited` }; // U7
      cands.push(...this.rows.filter((r) => r.file === f.file.path && (r.container === lv.path || r.container === `${lv.path}.Companion`) && r.name === name));
    }
    const imp = this.explicitImport(f, name);
    if (imp !== null && "why" in imp) return imp; // U8
    if (imp !== null) cands.push(...imp.rows);
    const top = this.topLevelRows(f, name);
    if ("why" in top) return top; // U8
    cands.push(...top.rows);

    const hidden = this.incompleteFor(name, [f.project, ...cands.map((c) => c.project)], f.facts.package ?? "");
    if (hidden !== null) return { why: hidden }; // U10
    if (cands.some((c) => c.multiplatform)) return { why: `\`${name}\` has an expect/actual declaration` }; // U11
    const r = this.one(cands, name); // U5
    if (!("id" in r)) return r;
    const row = cands.find((c) => c.id === r.id);
    if (row === undefined) return { why: "unreachable" };
    const want = ref.kind === "call" ? "function" : "property";
    if (row.kind !== want) return { why: `\`${name}\` is a ${row.kind}, not a ${want}${ref.kind === "call" ? " (invoke/constructor not modelled)" : ""}` }; // U6
    const cross = this.crossProject(f, row);
    if (cross !== null) return { why: cross }; // U9
    const arity = ref.kind === "call" ? this.arity(row, ref.args, name) : null;
    if (arity !== null) return { why: arity }; // U15
    return r;
  }

  /** U13: resolve `Cls` by classifier priority, then exactly one member. */
  private resolveMember(f: FileCtx, ref: { className: string; name: string; call: boolean; static: boolean; args?: number }, site: RefSite): Resolved {
    const cls = this.resolveClassifier(f, ref.className, site);
    if (!("id" in cls)) return { why: `class \`${ref.className}\`: ${cls.why}` };
    const row = this.rows.find((r) => r.id === cls.id);
    if (row === undefined) return { why: "unreachable" };
    if (row.kind === "type") return { why: `\`${ref.className}\` is a typealias (not modelled)` }; // U12
    if (row.supertypes) return { why: `\`${ref.className}\` has supertypes; \`${ref.name}\` may be inherited` }; // U7
    if (row.multiplatform) return { why: `\`${ref.className}\` is expect/actual` }; // U11
    const path = [row.container, row.name].filter((x) => x !== "").join(".");
    let scope: string;
    if (!ref.static) {
      if (row.kind !== "class") return { why: `\`${ref.className}()\` does not construct a class` };
      scope = path;
    } else scope = row.kind === "object" ? path : `${path}.Companion`;
    const companion = scope.endsWith(".Companion") ? this.rows.find((r) => r.file === row.file && CLASS_KINDS.has(r.kind) && r.fqn === `${row.fqn}.Companion`) : undefined;
    if (companion?.supertypes === true) return { why: `the companion of \`${ref.className}\` has supertypes; \`${ref.name}\` may be inherited` }; // U7
    const hidden = this.incompleteFor(ref.name, [row.project]);
    if (hidden !== null) return { why: hidden }; // U10
    const members = this.rows.filter((r) => r.file === row.file && r.container === scope && r.name === ref.name);
    const r = this.one(members, `${ref.className}.${ref.name}`);
    if (!("id" in r)) return r;
    const m = members.find((x) => x.id === r.id);
    const want = ref.call ? "function" : "property";
    if (m?.kind !== want) return { why: `\`${ref.className}.${ref.name}\` is a ${m?.kind ?? "?"}, not a ${want}` }; // U6
    if (m.multiplatform) return { why: `\`${ref.className}.${ref.name}\` is expect/actual` }; // U11
    const arity = ref.call ? this.arity(m, ref.args, `${ref.className}.${ref.name}`) : null;
    if (arity !== null) return { why: arity }; // U15
    return r;
  }

  /** U13 classifier priority: nested (innermost out) → explicit import → same package → star. */
  private resolveClassifier(f: FileCtx, name: string, site: RefSite): Resolved {
    if (site.enclosing !== null && scopeNames(f.facts, site.enclosing).has(name)) return { why: `\`${name}\` is a local; its type is not visible to syntax` }; // U3
    for (const lv of this.levels(f, site.container)) {
      if (lv.cls?.supertypes === true) return { why: `\`${lv.path}\` has supertypes; an inherited \`${name}\` may shadow` }; // U7
      const here = this.rows.filter((r) => r.file === f.file.path && (r.container === lv.path || r.container === `${lv.path}.Companion`) && r.name === name);
      if (here.some((r) => !CLASSIFIER_KINDS.has(r.kind))) return { why: `a value or function named \`${name}\` is in scope in \`${lv.path}\`` };
      if (here.length > 0) return this.one(here, name);
    }
    const imp = this.explicitImport(f, name);
    if (imp !== null && "why" in imp) return imp; // U8
    const top = imp !== null ? { rows: imp.rows } : this.topLevelRows(f, name);
    if ("why" in top) return top; // U8
    const hidden = this.incompleteFor(name, [f.project, ...top.rows.map((c) => c.project)], f.facts.package ?? "");
    if (hidden !== null) return { why: hidden }; // U10
    if (top.rows.some((r) => !CLASSIFIER_KINDS.has(r.kind))) return { why: `a value or function named \`${name}\` is also visible` };
    const r = this.one(top.rows, name);
    if (!("id" in r)) return r;
    const row = top.rows.find((c) => c.id === r.id);
    const cross = row === undefined ? null : this.crossProject(f, row);
    return cross === null ? r : { why: cross }; // U9
  }

  /** Placement of the group owned by declaration `id`. */
  owner(id: string, seen: Set<string> = new Set()): Placement {
    const cached = this.memo.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return { prefix: "", open: true, why: `mount cycle through \`${this.names.get(id) ?? id}\`` };
    const out = this.compute(id, new Set([...seen, id]));
    this.memo.set(id, out);
    return out;
  }

  private compute(id: string, seen: Set<string>): Placement {
    const name = this.names.get(id) ?? id;
    const unknown = (why: string): Placement => ({ prefix: "", open: true, why });
    const mounts = this.mountsByTarget.get(id) ?? [];
    const root = this.roots.has(id);
    if (root && mounts.length === 0) return { prefix: "", open: false, why: "" };
    if (root || mounts.length > 1) return unknown(`\`${name}\` is mounted ${mounts.length + (root ? 1 : 0)} times`);
    const mt = mounts[0];
    if (mt === undefined) {
      // only receivers whose simple name could refer to THIS declaration
      const could = this.unresolvedRoots.filter((u) => u.name === name).map((u) => u.text);
      const roots = could.length === 0 ? "" : `; unresolved .asServer receiver(s) named \`${name}\`: ${could.join(", ")}`;
      return unknown(`routes in \`${name}\` are not mounted under a server root (no .asServer(…) or mount resolves to this declaration${roots})`);
    }
    const m = mt.fact;
    if (m.prefix === null) return unknown(`\`${name}\` is mounted with a non-literal prefix (${m.text})`);
    if (!m.rooted && m.rootNote !== undefined) return unknown(`the mount of \`${name}\` is ${m.rootNote}`); // U16
    if (m.rooted) return { prefix: m.prefix, open: false, why: "" };
    if (m.owner === null) return unknown(`the mount of \`${name}\` is outside any function or property`);
    const up = this.owner(ownerId(mt.file, m.owner), seen);
    return { prefix: joinPaths([up.prefix, m.prefix]), open: up.open, why: up.open ? `mounted at ${m.prefix} by \`${m.owner.name}\`, whose prefix is unknown: ${up.why}` : "" };
  }

  /** A route's absolute template, or `{*}/known/part/path` when what's above is unknown. */
  route(file: string, r: RouteFact): { template: string; path: string; why: string | null } {
    const p: Placement = r.rooted
      ? { prefix: "", open: false, why: "" }
      : r.rootNote !== undefined
        ? { prefix: "", open: true, why: `the group is ${r.rootNote}` } // U16
        : r.owner === null
          ? { prefix: "", open: true, why: "routes group is outside any function or property" }
          : this.owner(ownerId(file, r.owner));
    const joined = joinPaths([p.prefix, r.path]);
    if (!p.open) return { template: normTemplate(joined), path: joined, why: null };
    const path = "{*}" + (joined === "/" ? "" : joined);
    return { template: normTemplate(path), path, why: p.why };
  }
}

// ── assembly ────────────────────────────────────────────────────────────────

export function assemble(manifest: Manifest, store: MapStore): AssembledMap {
  const notChecked: NotCheckedFile[] = [...manifest.notChecked];
  const manifestPaths = Object.keys(manifest.buildManifests).sort(cmpStr);
  const blob = (p: string): string | null => {
    const text = store.readBlob(manifest.buildManifests[p] ?? "");
    if (text === null) notChecked.push({ path: p, reason: "build manifest blob missing or corrupt in the map store; module membership may be coarser — re-extract" });
    return text;
  };
  const settings = manifestPaths.filter((p) => /(^|\/)settings\.gradle(\.kts)?$/.test(p)).flatMap((p) => {
    const text = blob(p);
    return text === null ? [] : [{ path: p, text }];
  });
  const builds = gradleBuilds(settings);
  const packageJsons = manifestPaths.filter((p) => /(^|\/)package\.json$/.test(p));
  const sourcePaths = new Set(Object.keys(manifest.files));

  // ── files and blocks ──
  const ctxs: FileCtx[] = [];
  const blocks = new Map<string, Block>();
  for (const path of Object.keys(manifest.files).sort(cmpStr)) {
    const objectKey = manifest.files[path] ?? "";
    const obj = store.readObject(objectKey);
    if (obj === null) {
      notChecked.push({ path, reason: "map object missing or corrupt in the store — re-extract" });
      continue;
    }
    const facts = obj.facts;
    let block: string;
    let module: string | undefined;
    let buildRootOf = "";
    let projectOf = "";
    if (familyOf(obj.language) === "jvm") {
      const { buildRoot, gradlePath } = jvmModuleOf(path, builds);
      buildRootOf = buildRoot;
      projectOf = `${buildRoot}${gradlePath}`;
      const pkg = facts.package ?? "";
      block = jvmBlockKey(buildRoot, gradlePath, pkg);
      if (!blocks.has(block)) blocks.set(block, { key: block, family: "jvm", buildRoot, gradleProject: gradlePath, package: pkg, files: [], tier: "syntactic", evidence: ev(path, 1) });
    } else {
      const dir = tsPackageDirOf(path, packageJsons);
      block = tsBlockKey(dir);
      module = tsModulePath(path);
      if (!blocks.has(block)) blocks.set(block, { key: block, family: "ts", packageDir: block, files: [], tier: "syntactic", evidence: ev(path, 1) });
    }
    blocks.get(block)?.files.push(path);
    ctxs.push({ file: { path, language: obj.language, block, objectKey, ...(module !== undefined ? { module } : {}) }, facts, buildRoot: buildRootOf, project: projectOf, declKeys: new Map() });
  }

  // assembly-level coverage findings, per (file, adapter)
  const extraCoverage = new Map<string, { line: number; reason: string }[]>();
  const partial = (file: string, adapter: string, line: number, reason: string): void => {
    const k = `${file}\0${adapter}`;
    const list = extraCoverage.get(k) ?? [];
    list.push({ line, reason });
    extraCoverage.set(k, list);
  };

  // ── http4k mounts ──
  const buildFiles = new Map<string, string | null>();
  for (const p of manifestPaths.filter((x) => /(^|\/)build\.gradle(\.kts)?$/.test(x))) buildFiles.set(p, blob(p));
  const infos = projectInfos(builds, buildFiles);
  const incomplete = new Map<string, string[]>();
  const addIncomplete = (key: string, why: string) => incomplete.set(key, [...(incomplete.get(key) ?? []), why]);
  for (const x of [...manifest.skipped, ...notChecked]) {
    if (!JVM_SOURCE.test(x.path)) continue;
    const { buildRoot, gradlePath } = jvmModuleOf(x.path, builds);
    addIncomplete(`${buildRoot}${gradlePath}`, `${x.path} was not extracted (${x.reason})`);
  }
  for (const info of infos.values()) if (info.generated !== null) addIncomplete(info.key, info.generated);
  const mounts = new MountResolver(ctxs, incomplete);
  for (const f of ctxs) {
    for (const m of f.facts.mounts) {
      const name = refName(m.target);
      const r = mounts.mountTargets.get(`${f.file.path}:${m.line}`);
      if (r === undefined || !("id" in r)) partial(f.file.path, "http4k", m.line, `mounted \`${name}\` could not be resolved (${r === undefined ? "?" : r.why}): its routes are unseen`);
      else if (!mounts.groups.has(r.id)) partial(f.file.path, "http4k", m.line, `mounted \`${name}\` declares no routes(…) group (routes built another way): its routes are unseen`);
      else if (!mounts.populated.has(r.id)) partial(f.file.path, "http4k", m.line, `mounted \`${name}\` has a routes group but no route with a literal path`);
      else if (m.prefix === null) partial(f.file.path, "http4k", m.line, `\`${name}\` is mounted with a non-literal prefix`);
    }
  }

  // ── entities ──
  const entities: Entity[] = [];
  const routes: Entity[] = [];
  for (const f of ctxs) {
    const { path } = f.file;
    f.facts.decls.forEach((d, i) => {
      if (d.kind !== "function") return;
      const key = fnKeyOf(f, d);
      f.declKeys.set(i, key);
      entities.push({
        key,
        kind: "function",
        name: d.name,
        block: f.file.block,
        file: path,
        line: d.line,
        endLine: d.endLine,
        tier: "syntactic",
        evidence: ev(path, d.line),
        contentHash: d.contentHash,
        function: {
          language: f.file.language,
          container: d.container,
          ...(d.params !== undefined ? { params: d.params } : {}),
          ...(d.receiver !== undefined ? { receiver: d.receiver } : {}),
          ...(d.exported !== undefined ? { exported: d.exported } : {}),
        },
      });
    });
    for (const r of f.facts.routes) {
      const abs = mounts.route(path, r);
      if (abs.why !== null) partial(path, "http4k", r.line, `route mount prefix unknown (keyed ${r.method} ${abs.template}): ${abs.why}`);
      const e: Entity = {
        key: routeKey(r.method, abs.template),
        kind: "route",
        name: `${r.method} ${abs.path}`,
        block: f.file.block,
        file: path,
        line: r.line,
        endLine: r.endLine,
        tier: "syntactic",
        evidence: ev(path, r.line),
        contentHash: r.contentHash,
        route: { method: r.method, template: abs.template, path: abs.path, handler: r.handler.name },
      };
      entities.push(e);
      routes.push(e);
    }
    for (const x of f.facts.fetches) {
      const enclosing = (x.enclosing === null ? undefined : f.declKeys.get(x.enclosing)) ?? tsFunctionKey(f.file.module ?? tsModulePath(path), TS_MODULE_LEVEL);
      entities.push({
        key: fetchSiteKey(enclosing, x.method, x.url.template),
        kind: "fetch-site",
        name: `${x.method} ${x.url.text}`,
        block: f.file.block,
        file: path,
        line: x.line,
        endLine: x.endLine,
        tier: "syntactic",
        evidence: ev(path, x.line),
        contentHash: x.contentHash,
        fetch: { method: x.method, template: x.url.template, via: x.via, urlKind: x.url.kind, url: x.url.text, enclosing, ...(x.url.base !== undefined ? { base: x.url.base } : {}) },
      });
    }
  }
  const keyCount = new Map<string, number>();
  for (const e of entities) keyCount.set(e.key, (keyCount.get(e.key) ?? 0) + 1);
  const ambiguous = new Set([...keyCount].filter(([, n]) => n > 1).map(([k]) => k));
  for (const e of entities) if (ambiguous.has(e.key)) e.ambiguous = true;
  const entityKeys = new Set(keyCount.keys());

  // ── indexes for syntactic resolution ──
  interface FnRef {
    key: string;
    file: string;
    container: string;
    name: string;
    pkg: string;
    topLevel: boolean;
  }
  const jvmFns = new Map<string, FnRef[]>();
  for (const f of ctxs) {
    if (f.file.module !== undefined) continue;
    f.facts.decls.forEach((d, i) => {
      const key = f.declKeys.get(i);
      if (key === undefined) return;
      const ref = { key, file: f.file.path, container: d.container.join("."), name: d.name, pkg: f.facts.package ?? "", topLevel: d.topLevel && d.receiver === undefined };
      const list = jvmFns.get(d.name);
      if (list === undefined) jvmFns.set(d.name, [ref]);
      else list.push(ref);
    });
  }
  const unique = (keys: string[]): string | null => {
    const s = [...new Set(keys)];
    return s.length === 1 ? (s[0] ?? null) : null;
  };

  /** `memberOnly`: the caller may inherit the name — only a same-class member is certain. */
  const resolveJvm = (f: FileCtx, callerContainer: string, name: string, memberOnly: boolean): string | null => {
    const byName = jvmFns.get(name) ?? [];
    if (byName.length === 0) return null;
    const pkg = f.facts.package ?? "";
    const member = callerContainer === "" ? [] : byName.filter((x) => x.file === f.file.path && x.container === callerContainer);
    if (member.length > 0 || memberOnly) return unique(member.map((x) => x.key));
    const scopes: FnRef[][] = [
      byName.filter((x) => x.file === f.file.path && x.topLevel),
      byName.filter((x) => x.pkg === pkg && x.topLevel),
      byName.filter((x) => x.topLevel && f.facts.imports.some((i) => i.path === (x.pkg === "" ? name : `${x.pkg}.${name}`))),
    ];
    for (const s of scopes) if (s.length > 0) return unique(s.map((x) => x.key));
    return null;
  };

  const resolveTs = (f: FileCtx, name: string, receiver: string | null): string | null => {
    const module = f.file.module;
    if (module === undefined) return null;
    if (receiver === null) {
      const local = f.facts.decls.find((d) => d.kind === "function" && d.topLevel && d.name === name);
      if (local !== undefined) return fnKeyOf(f, local);
    }
    for (const imp of f.facts.imports) {
      if (imp.source === undefined || imp.names === undefined) continue;
      const binding = imp.names.find((b) => (receiver === null ? b.local === name && b.imported !== "*" : b.imported === "*" && b.local === receiver));
      if (binding === undefined) continue;
      const target = resolveTsImport(f.file.path, imp.source, sourcePaths);
      if (target === null) return null;
      const key = tsFunctionKey(target, receiver === null ? binding.imported : name);
      return entityKeys.has(key) ? key : null;
    }
    return null;
  };

  // ── edges ──
  const edgeMap = new Map<string, Edge>();
  const addEdge = (from: string, to: string, kind: EdgeKind, evidence: string): void => {
    if (from === to) return;
    const key = edgeKey(from, to, kind);
    if (edgeMap.has(key)) return;
    const e: Edge = { key, from, to, kind, tier: "syntactic", evidence };
    if (ambiguous.has(from) || ambiguous.has(to)) e.ambiguous = true;
    edgeMap.set(key, e);
  };

  const jvmPackages = new Map<string, Set<string>>();
  for (const f of ctxs) {
    if (f.file.module !== undefined) continue;
    const pkg = f.facts.package ?? "";
    let s = jvmPackages.get(pkg);
    if (s === undefined) jvmPackages.set(pkg, (s = new Set()));
    s.add(f.file.block);
  }
  const topNames = new Map<string, Set<string>>();
  for (const f of ctxs) {
    let s = topNames.get(f.file.block);
    if (s === undefined) topNames.set(f.file.block, (s = new Set()));
    for (const d of f.facts.decls) if (d.topLevel) s.add(d.name);
  }
  const declaresTop = (block: string, name: string): boolean => topNames.get(block)?.has(name) === true;
  const byModule = new Map<string, FileCtx>();
  for (const f of ctxs) if (f.file.module !== undefined && !byModule.has(f.file.module)) byModule.set(f.file.module, f);

  for (const f of ctxs) {
    const { path, block } = f.file;
    const scopes = new Map<number, Set<string>>();
    const scopeOf = (idx: number): Set<string> => {
      let s = scopes.get(idx);
      if (s === undefined) scopes.set(idx, (s = scopeNames(f.facts, idx)));
      return s;
    };
    // imports → block edges
    for (const imp of f.facts.imports) {
      if (f.file.module !== undefined) {
        if (imp.source === undefined) continue;
        const target = resolveTsImport(path, imp.source, sourcePaths);
        const tf = target === null ? undefined : byModule.get(target);
        if (tf !== undefined) addEdge(block, tf.file.block, "import", ev(path, imp.line));
      } else if (imp.path !== undefined) {
        const segsOf = imp.path.split(".");
        for (let n = imp.wildcard === true ? segsOf.length : segsOf.length - 1; n >= 1; n--) {
          const pkg = segsOf.slice(0, n).join(".");
          const cands = jvmPackages.get(pkg);
          if (cands === undefined) continue;
          const next = segsOf[n];
          const pick = cands.size === 1 ? [...cands] : next === undefined ? [] : [...cands].filter((b) => declaresTop(b, next));
          if (pick.length === 1 && pick[0] !== undefined) addEdge(block, pick[0], "import", ev(path, imp.line));
          break;
        }
      }
    }
    // calls
    for (const call of f.facts.calls) {
      if (call.enclosing === null) continue;
      const from = f.declKeys.get(call.enclosing);
      const caller = f.facts.decls[call.enclosing];
      if (from === undefined || caller === undefined) continue;
      if (call.receiver === null && scopeOf(call.enclosing).has(call.callee)) continue; // a local/param
      let to: string | null = null;
      if (f.file.module !== undefined) to = resolveTs(f, call.callee, call.receiver);
      else if ((call.receiver === null || call.receiver === "this") && call.inLambda !== true) {
        to = resolveJvm(f, caller.container.join("."), call.callee, inheritsIn(f.facts, caller.container));
      }
      if (to !== null) addEdge(from, to, "call", ev(path, call.line));
    }
    // react-query `mutationFn: createUser` — a reference, not a call, but the same dependency
    for (const h of f.facts.queryHooks) {
      if (h.reference === null || h.enclosing === null || scopeOf(h.enclosing).has(h.reference)) continue;
      const from = f.declKeys.get(h.enclosing);
      const to = resolveTs(f, h.reference, null);
      if (from !== undefined && to !== null) addEdge(from, to, "call", ev(path, h.line));
    }
    // route → handler
    for (const r of f.facts.routes) {
      if (r.handler.name === null) continue;
      const to = resolveJvm(f, "", r.handler.name, false);
      if (to !== null) addEdge(routeKey(r.method, mounts.route(path, r).template), to, "route-handler", ev(path, r.line));
    }
  }

  // ── FE → BE joins: one row per fetch-site KEY ──
  const routeRefs: RouteRef[] = routes.map((r) => ({ key: r.key, method: r.route?.method ?? "", template: r.route?.template ?? "", ...(r.ambiguous === true ? { ambiguous: true } : {}) }));
  const sitesByKey = new Map<string, Entity[]>();
  for (const e of entities) {
    if (e.kind !== "fetch-site" || e.fetch === undefined) continue;
    const list = sitesByKey.get(e.key) ?? [];
    list.push(e);
    sitesByKey.set(e.key, list);
  }
  const joins: Join[] = [];
  for (const [key, sites] of sitesByKey) {
    const first = sites[0];
    if (first?.fetch === undefined) continue;
    const isAmb = sites.length > 1;
    const out = joinFetch({ ...first.fetch, ...(isAmb ? { ambiguous: true } : {}) }, routeRefs);
    joins.push({
      fetchSite: key,
      status: out.status,
      candidates: out.candidates,
      ...(out.reason !== undefined ? { reason: out.reason } : {}),
      tier: out.status === "exact" ? "syntactic" : "unresolved",
      evidence: first.evidence,
      ...(isAmb ? { ambiguous: true as const, evidenceAll: sites.map((s) => s.evidence) } : {}),
    });
    const target = out.candidates[0];
    if (out.status === "exact" && target !== undefined) addEdge(key, target, "fe-be", first.evidence);
  }

  // ── inventories ──
  const coverage: FileCoverage[] = [];
  const unparsed: AssembledMap["unparsed"] = [];
  const casts: AssembledMap["casts"] = [];
  const names: AssembledMap["names"] = [];
  for (const f of ctxs) {
    const { path } = f.file;
    for (const c of f.facts.coverage) {
      const extra = extraCoverage.get(`${path}\0${c.adapter}`) ?? [];
      const reasons = [...c.unresolved, ...extra].sort((a, b) => a.line - b.line || cmpStr(a.reason, b.reason)).map((u) => ({ ...u, evidence: ev(path, u.line) }));
      coverage.push({ file: path, adapter: c.adapter, status: reasons.length > 0 ? "partial" : c.status, candidates: c.candidates, reasons });
    }
    for (const u of f.facts.unparsed) unparsed.push({ file: path, evidence: ev(path, u.startLine), ...u });
    for (const c of f.facts.casts) casts.push({ file: path, evidence: ev(path, c.line), ...c });
    for (const l of f.facts.locals) names.push({ file: path, name: l.name, line: l.line, enclosing: l.enclosing === null ? null : (f.declKeys.get(l.enclosing) ?? null) });
  }

  const byKey = <T extends { key: string }>(a: T, b: T) => cmpStr(a.key, b.key);
  entities.sort((a, b) => cmpStr(a.key, b.key) || cmpStr(a.file, b.file) || a.line - b.line);
  joins.sort((a, b) => cmpStr(a.fetchSite, b.fetchSite));

  return {
    manifestHash: manifestHash(manifest),
    commit: manifest.commit,
    extractorVersion: manifest.extractorVersion,
    files: ctxs.map((c) => c.file),
    blocks: [...blocks.values()].sort(byKey),
    entities,
    edges: [...edgeMap.values()].sort(byKey),
    joins,
    coverage,
    unparsed,
    casts,
    names,
    skipped: manifest.skipped,
    notChecked: notChecked.sort(byPath),
    adapters: adapterInfo(),
  };
}
