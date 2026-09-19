/**
 * The shapes the extractor produces and 1c (ghosts + drift) consumes — system-map slice 1b.
 *
 * Two layers, deliberately separate (eng review D23 / D14-13A):
 *   - `FileFacts` — per-file, PATH-INDEPENDENT syntax facts. They depend only on the file's
 *     bytes, its language and the extractor/grammar/query versions, so they are stored once in
 *     the content-addressed object store and shared by every snapshot that has those bytes.
 *   - `AssembledMap` — the contextualised view of one `Manifest`: paths, module membership
 *     (blocks), identity keys (D8/7A), evidence `file:line`, joins. Identical bytes at two paths
 *     are two entities because identity is assigned here, never in the object.
 *
 * Every fact the tree-sitter layer produces is tier `syntactic` (SM-D4); a join it cannot prove
 * is tier `unresolved`. Nothing here is ever a guess presented as fact.
 */

export type Language = "kotlin" | "java" | "typescript" | "tsx" | "javascript";

/** SM-D4 tier order: observed > resolved > syntactic > evidence-checked > unresolved. */
export type Tier = "observed" | "resolved" | "syntactic" | "evidence-checked" | "unresolved";

export type EntityKind = "route" | "function" | "fetch-site";
export type EdgeKind = "import" | "call" | "route-handler" | "fe-be";

// ── per-file facts (object store) ────────────────────────────────────────────

export interface DeclFact {
  /** `property`: Kotlin top-level/member properties (never entities; needed to resolve names). */
  kind: "class" | "interface" | "object" | "enum" | "type" | "function" | "property";
  name: string;
  /** Enclosing class/object chain, outermost first (`["Renderer", "Inner"]`). */
  container: string[];
  topLevel: boolean;
  line: number;
  endLine: number;
  /** Declared parameter type TEXT, whitespace-normalised, in order (functions only). */
  params?: string[];
  paramNames?: string[];
  /** Kotlin extension receiver type text, normalised. */
  receiver?: string;
  /** TS: exported, and under which name (`default` for a default export). */
  exported?: boolean;
  exportName?: string;
  /** Classes/objects: declares supertypes, so a bare call inside may resolve to an inherited member. */
  supertypes?: true;
  /** Kotlin/Java `private` — visible only in its file (top level) or class. */
  private?: true;
  /** Kotlin `internal` — visible only within its Gradle project (module). */
  internal?: true;
  /** Kotlin `expect` / `actual` — the implementation lives in another source set. */
  multiplatform?: true;
  /** Functions: fewest arguments a call can pass (params without default, vararg excluded). */
  minArgs?: number;
  /** Functions: most arguments a call can pass; null = unbounded (vararg). */
  maxArgs?: number | null;
  /** sha256 of the declaration's source text (first 16 hex) — drift's "content changed". */
  contentHash: string;
}

export interface ImportFact {
  line: number;
  /** JVM: the imported qualified name (`com.example.core.Greeter`), without `.*`. */
  path?: string;
  wildcard?: boolean;
  alias?: string;
  /** TS: the module specifier (`./api`, `react`). */
  source?: string;
  /** TS: bound names. `imported` is `default` / `*` for default / namespace imports. */
  names?: { imported: string; local: string }[];
  /** TS: `export … from` rather than `import`. */
  reexport?: boolean;
}

export interface CallFact {
  line: number;
  callee: string;
  /** Receiver expression text (truncated), or null for a bare call. */
  receiver: string | null;
  /** Index into `decls` of the innermost enclosing function, or null at file/class level. */
  enclosing: number | null;
  /** Kotlin: inside a lambda, where an implicit receiver may own the callee. */
  inLambda?: true;
}

export type CastKind = "as" | "as?" | "cast" | "angle" | "non-null";
export interface CastFact {
  line: number;
  kind: CastKind;
  /** Target type text (empty for TS non-null `!`). Inventory only — no "unnecessary" judgement. */
  type: string;
}

export interface LocalNameFact {
  name: string;
  line: number;
  enclosing: number | null;
}

export interface RouteFact {
  line: number;
  endLine: number;
  method: string;
  /**
   * Literal path joined through the enclosing `"/p" bind routes(…)` groups IN THIS FILE, relative
   * to the owner's outermost group (`/api/v1/orders/{orderId:\d+}`). Where the owner itself is
   * mounted is only known at assembly (it may be mounted from another file).
   */
  path: string;
  /** Normalised relative template (`/api/v1/orders/{*}`). */
  template: string;
  /** The declaration whose body holds the outermost routes(…) group; null if none. */
  owner: OwnerRef | null;
  /** The group is the receiver of `.asServer(…)` through modelled wrappers only — the server root. */
  rooted: boolean;
  /** Why an `.asServer(…)` above this group does NOT root it (an unmodelled wrapper in between). */
  rootNote?: string;
  handler: { kind: "reference" | "lambda" | "expression"; text: string; name: string | null };
  enclosing: number | null;
  contentHash: string;
}

/**
 * A routes group's owner, as a DECLARATION (never a bare name): the function or property at
 * `line` named `name`. Non-local owners are also in `decls`; a local owner (a `val` inside a
 * function body) is scoped to its enclosing function `enclosing`.
 */
export interface OwnerRef {
  name: string;
  line: number;
  local: boolean;
  enclosing: number | null;
}

/**
 * A syntactic reference to a routes handler, resolved at assembly with scope rules:
 *   call    `orderRoutes()`          → a function
 *   name    `app`                    → a property (a local/param resolves to nothing)
 *   member  `A().api()` / `Api.routes` → a member of class/object `className`
 *   opaque  anything else            → unresolvable
 */
export type HandlerRef =
  /** `args`: the call's argument count (calls only; absent when a spread makes it unknowable). */
  | { kind: "call" | "name"; name: string; args?: number }
  /** `static`: `Holder.api()` (object / companion member); else `A().api()` (instance member). */
  | { kind: "member"; className: string; name: string; call: boolean; static: boolean; args?: number }
  | { kind: "opaque"; text: string };

/** Where a reference appears: its enclosing function and class chain (for scope resolution). */
export interface RefSite {
  line: number;
  enclosing: number | null;
  container: string[];
  /** Inside a lambda (an implicit receiver — `with`, `apply`, `run`, DSLs — may own any name). */
  inLambda?: true;
}

/** http4k: a group mounted by reference — `"/api" bind orderRoutes()` or `routes(adminRoutes())`. */
export interface MountFact extends RefSite {
  endLine: number;
  /** Literal prefix within the owner group (`/api`); null when not a literal. */
  prefix: string | null;
  target: HandlerRef;
  owner: OwnerRef | null;
  rooted: boolean;
  rootNote?: string;
  text: string;
}

/** http4k: the handler served by `X.asServer(…)`. */
export interface ServerRootFact extends RefSite {
  ref: HandlerRef;
  text: string;
}

export interface UrlFact {
  /**
   * literal: fully static path; template: dynamic segments; base: leading non-literal base;
   * absolute: carries its own origin (`https://host/…`) — never the same thing as our backend;
   * unknown: no static part.
   */
  kind: "literal" | "template" | "base" | "absolute" | "unknown";
  /** Normalised template: dynamic parts → `{*}`, query stripped, origin KEPT (`{*}/orders/{*}`, `https://h/x`). */
  template: string;
  /** Source text of the URL expression. */
  text: string;
  /** The leading non-literal expression (`base` / `unknown`) or the origin (`absolute`). */
  base?: string;
}

export interface FetchFact {
  line: number;
  endLine: number;
  via: "fetch" | "client";
  /** Upper-case HTTP method, or `*` when not a literal. */
  method: string;
  url: UrlFact;
  enclosing: number | null;
  contentHash: string;
}

export interface QueryHookFact {
  line: number;
  hook: string;
  /** `queryFn` / `mutationFn`, or null when the options object had neither. */
  fnKey: "queryFn" | "mutationFn" | null;
  fnText: string;
  /** When the fn is a bare identifier (`mutationFn: createUser`), that name. */
  reference: string | null;
  enclosing: number | null;
}

export interface CoverageFact {
  adapter: string;
  status: "full" | "partial";
  /** Candidate constructs seen (resolved + unresolved). */
  candidates: number;
  unresolved: { line: number; reason: string }[];
}

export interface UnparsedRegion {
  startLine: number;
  endLine: number;
  kind: "error" | "missing";
}

export interface FileFacts {
  language: Language;
  /** JVM package (`com.example.api`), "" for the default package; absent for TS. */
  package?: string;
  decls: DeclFact[];
  imports: ImportFact[];
  calls: CallFact[];
  casts: CastFact[];
  locals: LocalNameFact[];
  routes: RouteFact[];
  mounts: MountFact[];
  /** http4k: what each `.asServer(…)` serves (its receiver), as a reference. */
  serverRoots: ServerRootFact[];
  /** http4k: the owner of every routes(…) group, including groups with no literal route. */
  groups: OwnerRef[];
  /** Every identifier inside an unparsed region — a declaration there could shadow any of them. */
  unparsedNames: string[];
  fetches: FetchFact[];
  queryHooks: QueryHookFact[];
  coverage: CoverageFact[];
  unparsed: UnparsedRegion[];
}

/** What sits at `<store>/objects/<key>.json`. Immutable once written. */
export interface StoredObject {
  schema: 1;
  language: Language;
  contentSha256: string;
  grammar: string;
  queryHash: string;
  adapterVersion: string;
  extractorVersion: string;
  facts: FileFacts;
}

// ── snapshot manifest ────────────────────────────────────────────────────────

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface NotCheckedFile {
  path: string;
  /** `grammar unavailable: …` / `worker error: …` — never cached, re-attempted next time. */
  reason: string;
}

export interface Manifest {
  schema: 1;
  extractorVersion: string;
  /** The commit extracted (`--commit`), or HEAD for a working-tree extraction (null if unborn). */
  commit: string | null;
  source: "commit" | "worktree";
  /** path → object key, for every source file with facts. */
  files: Record<string, string>;
  /** build/package manifests: path → sha256 (content kept in `<store>/blobs/`). */
  buildManifests: Record<string, string>;
  skipped: SkippedFile[];
  notChecked: NotCheckedFile[];
}

// ── assembled map ────────────────────────────────────────────────────────────

export interface Block {
  key: string;
  family: "jvm" | "ts";
  /** JVM: Gradle build root dir ("" = repo root), project path (`:api`), package. */
  buildRoot?: string;
  gradleProject?: string;
  package?: string;
  /** TS: nearest package.json dir ("." = repo root). */
  packageDir?: string;
  files: string[];
  tier: Tier;
  evidence: string;
}

export interface Entity {
  key: string;
  kind: EntityKind;
  name: string;
  block: string;
  file: string;
  line: number;
  endLine: number;
  tier: Tier;
  evidence: string;
  contentHash: string;
  /** Set when the assembled snapshot has more than one entity with this key — never verifies. */
  ambiguous?: true;
  function?: { language: Language; params?: string[]; receiver?: string; container: string[]; exported?: boolean };
  route?: { method: string; template: string; path: string; handler: string | null };
  fetch?: { method: string; template: string; via: "fetch" | "client"; urlKind: UrlFact["kind"]; url: string; enclosing: string; base?: string };
}

export interface Edge {
  key: string;
  from: string;
  to: string;
  kind: EdgeKind;
  tier: Tier;
  evidence: string;
  ambiguous?: true;
}

export interface Join {
  fetchSite: string;
  status: "exact" | "pattern-match" | "unresolved";
  candidates: string[];
  reason?: string;
  tier: Tier;
  evidence: string;
  /** The fetch-site key is shared by several sites (all evidence listed) — never exact. */
  ambiguous?: true;
  evidenceAll?: string[];
}

export interface FileCoverage {
  file: string;
  adapter: string;
  status: "full" | "partial";
  candidates: number;
  reasons: { line: number; reason: string; evidence: string }[];
}

export interface AdapterInfo {
  name: string;
  version: string;
  languages: Language[];
  /** What a `full` coverage from this adapter lets drift claim is `missing` (D20). */
  covers: (EntityKind | "query-hook")[];
  queries: string[];
}

export interface AssembledFile {
  path: string;
  language: Language;
  block: string;
  objectKey: string;
  module?: string;
}

export interface AssembledMap {
  manifestHash: string;
  commit: string | null;
  extractorVersion: string;
  files: AssembledFile[];
  blocks: Block[];
  entities: Entity[];
  edges: Edge[];
  joins: Join[];
  coverage: FileCoverage[];
  unparsed: ({ file: string; evidence: string } & UnparsedRegion)[];
  casts: ({ file: string; evidence: string } & CastFact)[];
  names: { file: string; name: string; line: number; enclosing: string | null }[];
  skipped: SkippedFile[];
  notChecked: NotCheckedFile[];
  adapters: AdapterInfo[];
}

export interface Progress {
  done: number;
  total: number;
  skipped: number;
}
