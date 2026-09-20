/**
 * The proposer's view of the map — system-map slice 1c (`map.neighbourhood`, sprint (c) slice 1).
 *
 * Until query tools arrive (sprint (b)), `slice.propose` sees the map only through this bounded
 * text, rendered into its prompt (so it is inside `rendered_hash`). Three pure steps:
 *
 *   ticketEntities(goal, work, map)  which entities the ticket NAMES — deterministically: file
 *                                    paths, route strings and code symbols in the text matched
 *                                    against snapshot keys, exact first, then suffix. No match →
 *                                    `needsEntryPoint`: the engine asks the operator to pick one
 *                                    (recorded as an event) instead of guessing.
 *   neighbourhood(map, seeds, hops)  those seeds expanded along edges (both directions), fetch
 *                                    site ↔ enclosing function, join candidates, and block
 *                                    membership — bounded by `cap` entities, truncation reported.
 *   renderNeighbourhood(n)           compact, deterministic text with a size bound, including the
 *                                    coverage notes that say where absence is NOT evidence.
 *
 * Matching rules (explicit over clever, so the operator can predict them):
 *   - a FILE token is any word ending in an extracted source extension; exact = the repo-relative
 *     path, suffix = a path ending in `/<token>`. It seeds every entity in that file.
 *   - a ROUTE token is `METHOD /path` or a bare `/path` / URL; it is normalised like a key
 *     (`{id}`, `:id`, `${x}` → `{*}`) and compared segment by segment with route and fetch-site
 *     templates (`{*}` matches any one segment; at least one literal segment must agree). Exact =
 *     whole template; suffix = the template's tail (or a template whose prefix is unknown).
 *   - a SYMBOL token must look like code — inside backticks, or camelCase / PascalCase-with-a-hump
 *     / snake_case / dotted / `#` / followed by `(` — so prose words ("user", "main") never seed.
 *     Exact = a whole entity key; suffix = a FUNCTION key (JVM keys also without their parameter
 *     list) ending in the token at a boundary (`.`, `#`, `/`); `name()` means any parameters.
 *   - a backticked token equal to a BLOCK key seeds that block (its entities are hop 1).
 * A suffix token matching more than MAX_SUFFIX_MATCHES entities is reported as too broad and
 * seeds nothing — a guess dressed as a seed would steer the proposer.
 */

import { HTTP_METHODS, normTemplate } from "./keys";
import { languageOf } from "./languages";
import type { AssembledMap, Block, Edge, Entity, FileCoverage, Join } from "./types";
import { cmpStr } from "./util";

export type MatchVia = "file" | "route" | "symbol" | "block";

export interface TicketMatch {
  key: string;
  via: MatchVia;
  match: "exact" | "suffix";
  /** The text that matched, as it appeared (trimmed of quotes/punctuation). */
  token: string;
}

export interface TicketEntities {
  /** Sorted, unique entity / block keys to expand from. */
  seeds: string[];
  matches: TicketMatch[];
  /** Suffix tokens that matched too many entities to be a meaningful seed. */
  tooBroad: { token: string; via: MatchVia; candidates: number }[];
  /** Nothing matched: the operator must pick an entry point. */
  needsEntryPoint: boolean;
}

export const MAX_SUFFIX_MATCHES = 20;
export const NEIGHBOURHOOD_CAP = 150;
export const RENDER_MAX_CHARS = 16_000;

const METHODS = new Set<string>(HTTP_METHODS);
const count = (s: string, ch: string) => s.split(ch).length - 1;

/** Trim quotes and sentence punctuation; brackets only when unbalanced (`getUser()` keeps its own). */
function clean(word: string): string {
  let w = word;
  for (let prev = ""; prev !== w; ) {
    prev = w;
    w = w.replace(/^[`'"<]+/, "").replace(/[`'">,;:!?.]+$/, "");
    if (w.startsWith("(") && count(w, "(") > count(w, ")")) w = w.slice(1);
    if (w.endsWith(")") && count(w, ")") > count(w, "(")) w = w.slice(0, -1);
    if (w.startsWith("[") && count(w, "[") > count(w, "]")) w = w.slice(1);
    if (w.endsWith("]") && count(w, "]") > count(w, "[")) w = w.slice(0, -1);
    if (w.startsWith("{") && count(w, "{") > count(w, "}")) w = w.slice(1);
    if (w.endsWith("}") && count(w, "}") > count(w, "{")) w = w.slice(0, -1);
    // `App.kt:12` / `App.kt:12:5` — drop a line suffix
    w = w.replace(/(\.[A-Za-z]+):\d+(?::\d+)?$/, "$1");
  }
  return w.replace(/^\.\//, "");
}

/** Does a plain (un-backticked) word look like a code symbol rather than prose? */
function codeLike(w: string): boolean {
  if (!/^[\p{L}$_][\p{L}\p{N}$_.#<>/-]*(\(.*\))?$/u.test(w)) return false;
  return /[a-z][A-Z]/.test(w) || /^[A-Z][a-z0-9]+[A-Z]/.test(w) || /_/.test(w) || /[.#]/.test(w) || /\(/.test(w);
}

/** Path segments of a normalised template; `{*}/x` (unknown prefix) is `open`; origin kept apart. */
function segments(template: string): { segs: string[]; open: boolean; origin: string } {
  const open = template.startsWith("{*}/") || template === "{*}";
  const om = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)(.*)$/i.exec(template);
  const origin = om === null ? "" : (om[1] ?? "").toLowerCase();
  const body = open ? template.slice(3) : om === null ? template : (om[2] ?? "");
  return { segs: body.split("/").filter((s) => s !== ""), open, origin };
}

/**
 * Do `tok` and `ent` align segment by segment, with at least one literal segment in common? An
 * entity `{*}` matches any token segment (`/users/42` names `/users/{*}`); a token `{*}` (the
 * ticket wrote `{id}`) matches only an entity `{*}` — a placeholder never names a literal.
 */
export function alignSegs(tok: string[], ent: string[]): boolean {
  if (tok.length !== ent.length) return false;
  let literal = tok.length === 0;
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    const e = ent[i];
    if (e === "{*}") continue;
    if (t !== e) return false;
    literal = true;
  }
  return literal;
}

/**
 * `tok` vs an entity template. A route has no origin, so a pasted `http://localhost/api/x` still
 * names it; a fetch site's origin must agree (github's `/api/orders` is not ours).
 */
export function routeMatch(tokTemplate: string, entTemplate: string, entIsFetch: boolean): "exact" | "suffix" | null {
  const t = segments(tokTemplate);
  const e = segments(entTemplate);
  if (entIsFetch && t.origin !== e.origin) return null;
  if (!e.open && alignSegs(t.segs, e.segs)) return "exact";
  if (t.segs.length > 0 && t.segs.length <= e.segs.length && alignSegs(t.segs, e.segs.slice(e.segs.length - t.segs.length))) return "suffix";
  // an open template ({*}/orders) matches a token that ENDS with its known part
  if (e.open && e.segs.length > 0 && e.segs.length <= t.segs.length && alignSegs(t.segs.slice(t.segs.length - e.segs.length), e.segs)) return "suffix";
  return null;
}

/**
 * Candidate strings a symbol suffix-matches: functions only (a route or fetch-site key ending in
 * `/health` is not the symbol `health`) — the key, and a JVM key without its `(params)`.
 */
function symbolForms(e: Entity): string[] {
  if (e.kind !== "function") return [];
  if (!e.key.endsWith(")") || e.key.includes("#")) return [e.key];
  // the '(' matching the final ')' — parameter types may hold parens themselves (`(Int)->Unit`)
  let depth = 0;
  for (let i = e.key.length - 1; i >= 0; i--) {
    const ch = e.key[i];
    if (ch === ")") depth++;
    else if (ch === "(" && --depth === 0) return i > 0 ? [e.key, e.key.slice(0, i)] : [e.key];
  }
  return [e.key];
}

function endsAtBoundary(s: string, token: string): boolean {
  if (s === token) return true;
  if (!s.endsWith(token)) return false;
  const before = s[s.length - token.length - 1];
  return before === "." || before === "#" || before === "/";
}

/**
 * Entities the ticket names. Deterministic: the same text and map always give the same seeds, in
 * the same order.
 */
export function ticketEntities(goal: string, work: string, map: AssembledMap): TicketEntities {
  const text = `${goal}\n${work}`;
  const matches: TicketMatch[] = [];
  const tooBroad: TicketEntities["tooBroad"] = [];
  const blockKeys = new Set(map.blocks.map((b) => b.key));
  const entityKeys = new Set(map.entities.map((e) => e.key));

  /** Record a token's matches: exact ones if any, else suffix ones unless too broad. */
  const take = (token: string, via: MatchVia, exact: string[], suffix: string[]): void => {
    const ex = [...new Set(exact)].sort(cmpStr);
    if (ex.length > 0) {
      for (const key of ex) matches.push({ key, via, match: "exact", token });
      return;
    }
    const sf = [...new Set(suffix)].sort(cmpStr);
    if (sf.length > MAX_SUFFIX_MATCHES) tooBroad.push({ token, via, candidates: sf.length });
    else for (const key of sf) matches.push({ key, via, match: "suffix", token });
  };

  const seen = new Set<string>();
  const once = (kind: string, token: string): boolean => {
    const k = `${kind}\0${token}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };

  // backticked spans first: they may hold whole keys with spaces (`GET /x`, `pkg.<ext A>.f()`)
  const words: { w: string; ticked: boolean }[] = [];
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const inner = (m[1] ?? "").trim();
    if (inner === "") continue;
    if (entityKeys.has(inner) || blockKeys.has(inner)) {
      if (once("key", inner)) take(inner, blockKeys.has(inner) && !entityKeys.has(inner) ? "block" : "symbol", [inner], []);
      continue;
    }
    words.push({ w: inner, ticked: true });
  }
  const plain = text.replace(/`[^`\n]+`/g, " ");

  // routes: METHOD /path (in plain text or inside a backticked span)
  const routeTokens: { method: string | null; path: string; token: string }[] = [];
  for (const src of [plain, ...words.filter((x) => x.ticked).map((x) => x.w)]) {
    for (const m of src.matchAll(/(?:^|[^A-Za-z])([A-Z]+)\s+((?:https?:\/\/[^\s/]+)?\/[^\s`'"<>]*)/g)) {
      const method = m[1] ?? "";
      if (!METHODS.has(method)) continue;
      const path = clean(m[2] ?? "");
      routeTokens.push({ method, path, token: `${method} ${path}` });
    }
  }
  // markdown links `[App.kt](web/App.kt)` and lists split into their parts
  const tokens = [...plain.split(/\s+|\]\(|,/).map((w) => ({ w, ticked: false })), ...words];
  for (const { w: raw, ticked } of tokens) {
    const w = clean(raw);
    if (w === "") continue;
    if (/^(?:https?:\/\/[^\s/]+)?\/\S*$/.test(w) && languageOf(w) === null && !routeTokens.some((r) => r.path === w)) {
      routeTokens.push({ method: null, path: w, token: w });
      continue;
    }
    if (languageOf(w) !== null && !/[#|→\s]/.test(w) && !/\(/.test(w)) {
      if (!once("file", w)) continue;
      const exact = map.entities.filter((e) => e.file === w).map((e) => e.key);
      const suffix = map.entities.filter((e) => e.file.endsWith(`/${w}`)).map((e) => e.key);
      take(w, "file", exact, suffix);
      continue;
    }
    if (ticked && blockKeys.has(w)) {
      if (once("block", w)) take(w, "block", [w], []);
      continue;
    }
    if (!ticked && !codeLike(w)) continue;
    if (ticked && !/^[\p{L}$_][^\s]*$/u.test(w)) continue;
    if (!once("symbol", w)) continue;
    // `getUser()` names the function whatever its parameters are
    const sym = w.endsWith("()") && !entityKeys.has(w) ? w.slice(0, -2) : w;
    const exact = map.entities.filter((e) => e.key === w).map((e) => e.key);
    const suffix = map.entities.filter((e) => symbolForms(e).some((f) => endsAtBoundary(f, sym))).map((e) => e.key);
    take(w, "symbol", exact, suffix);
  }
  for (const r of routeTokens) {
    if (!once("route", r.token)) continue;
    const tpl = normTemplate(r.path);
    const exact: string[] = [];
    const suffix: string[] = [];
    for (const e of map.entities) {
      const t = e.route?.template ?? e.fetch?.template;
      const method = e.route?.method ?? e.fetch?.method;
      if (t === undefined || method === undefined) continue;
      if (r.method !== null && method !== r.method && method !== "*") continue;
      const m = routeMatch(tpl, t, e.kind === "fetch-site");
      if (m === "exact") exact.push(e.key);
      else if (m === "suffix") suffix.push(e.key);
    }
    take(r.token, "route", exact, suffix);
  }

  matches.sort((a, b) => cmpStr(a.key, b.key) || cmpStr(a.via, b.via) || cmpStr(a.token, b.token));
  tooBroad.sort((a, b) => cmpStr(a.token, b.token));
  const seeds = [...new Set(matches.map((m) => m.key))].sort(cmpStr);
  return { seeds, matches, tooBroad, needsEntryPoint: seeds.length === 0 };
}

// ── neighbourhood ───────────────────────────────────────────────────────────

export interface NeighbourhoodEntity {
  entity: Entity;
  /** Hops from the nearest seed (0 = a seed). */
  hop: number;
}

export interface Neighbourhood {
  commit: string | null;
  manifestHash: string;
  seeds: string[];
  /** Seeds that are not keys in this snapshot (ignored). */
  unknownSeeds: string[];
  hops: number;
  cap: number;
  /** Included entities, ordered by block, key, file, line. Ambiguous keys list every entity. */
  entities: NeighbourhoodEntity[];
  blocks: Block[];
  /** Edges whose endpoints are both included (import edges: both blocks included). */
  edges: Edge[];
  /** Non-exact joins of included fetch sites — candidates, never facts. */
  joins: Join[];
  notes: {
    partial: FileCoverage[];
    unparsed: AssembledMap["unparsed"];
    ambiguous: { key: string; evidence: string[] }[];
    /** Skipped / not-checked files next to included ones (same directory). */
    notExtracted: { path: string; reason: string; status: "skipped" | "not-checked" }[];
  };
  /** Entity keys reachable within `hops` but beyond `cap`. */
  truncated: number;
}

/**
 * Expand `seeds` (entity or block keys) `hops` steps along edges (both directions), fetch site ↔
 * enclosing function, and join candidates; a block seed's entities are one hop away. Included
 * entities bring their block as context (blocks are never expanded into their siblings — that
 * would flood the cap in any real module). Breadth-first with sorted frontiers, so the first `cap`
 * keys are always the nearest ones, deterministically.
 */
export function neighbourhood(map: AssembledMap, seeds: readonly string[], hops = 2, cap = NEIGHBOURHOOD_CAP): Neighbourhood {
  const byKey = new Map<string, Entity[]>();
  for (const e of map.entities) byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
  const blocks = new Map(map.blocks.map((b) => [b.key, b]));
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    for (const [x, y] of [[a, b], [b, a]] as const) {
      let s = adj.get(x);
      if (s === undefined) adj.set(x, (s = new Set()));
      s.add(y);
    }
  };
  for (const e of map.edges) if (byKey.has(e.from) && byKey.has(e.to)) link(e.from, e.to);
  for (const e of map.entities) if (e.fetch !== undefined && byKey.has(e.fetch.enclosing)) link(e.key, e.fetch.enclosing);
  for (const j of map.joins) for (const c of j.candidates) if (byKey.has(c)) link(j.fetchSite, c);

  const uniqSeeds = [...new Set(seeds)].sort(cmpStr);
  const unknownSeeds = uniqSeeds.filter((s) => !byKey.has(s) && !blocks.has(s));
  const blockSeeds = uniqSeeds.filter((s) => blocks.has(s) && !byKey.has(s));
  const hopOf = new Map<string, number>();
  const order: string[] = [];
  let frontier = uniqSeeds.filter((s) => byKey.has(s));
  for (const k of frontier) (hopOf.set(k, 0), order.push(k));
  for (let h = 1; h <= hops; h++) {
    const next = new Set<string>();
    for (const k of frontier) for (const n of adj.get(k) ?? []) if (!hopOf.has(n)) next.add(n);
    if (h === 1) for (const e of map.entities) if (blockSeeds.includes(e.block) && !hopOf.has(e.key)) next.add(e.key);
    frontier = [...next].sort(cmpStr);
    for (const k of frontier) (hopOf.set(k, h), order.push(k));
    if (frontier.length === 0) break;
  }

  const kept = order.slice(0, Math.max(0, cap));
  const keptSet = new Set(kept);
  const entities: NeighbourhoodEntity[] = kept
    .flatMap((k) => (byKey.get(k) ?? []).map((entity) => ({ entity, hop: hopOf.get(k) ?? 0 })))
    .sort((a, b) => cmpStr(a.entity.block, b.entity.block) || cmpStr(a.entity.key, b.entity.key) || cmpStr(a.entity.file, b.entity.file) || a.entity.line - b.entity.line);
  const blockSet = new Set<string>([...blockSeeds, ...entities.map((e) => e.entity.block)]);
  const files = new Set(entities.map((e) => e.entity.file));
  const dirs = new Set([...files].map((f) => f.slice(0, Math.max(0, f.lastIndexOf("/")))));
  const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));

  const ambiguous = [...new Set(entities.filter((e) => e.entity.ambiguous === true).map((e) => e.entity.key))].sort(cmpStr).map((key) => ({ key, evidence: (byKey.get(key) ?? []).map((e) => e.evidence) }));
  return {
    commit: map.commit,
    manifestHash: map.manifestHash,
    seeds: uniqSeeds,
    unknownSeeds,
    hops,
    cap,
    entities,
    blocks: map.blocks.filter((b) => blockSet.has(b.key)),
    edges: map.edges.filter((e) => (keptSet.has(e.from) && keptSet.has(e.to)) || (e.kind === "import" && blockSet.has(e.from) && blockSet.has(e.to))),
    joins: map.joins.filter((j) => keptSet.has(j.fetchSite) && j.status !== "exact"),
    notes: {
      partial: map.coverage.filter((c) => files.has(c.file) && c.status === "partial"),
      unparsed: map.unparsed.filter((u) => files.has(u.file)),
      ambiguous,
      notExtracted: [
        ...map.skipped.filter((s) => dirs.has(dirOf(s.path))).map((s) => ({ path: s.path, reason: s.reason, status: "skipped" as const })),
        ...map.notChecked.filter((s) => dirs.has(dirOf(s.path))).map((s) => ({ path: s.path, reason: s.reason, status: "not-checked" as const })),
      ].sort((a, b) => cmpStr(a.path, b.path)),
    },
    truncated: Math.max(0, order.length - kept.length),
  };
}

// ── render ──────────────────────────────────────────────────────────────────

/** Line caps for the notes and joins, and a per-line cap, so no single fact eats the budget. */
const NOTE_LINES = 40;
const JOIN_LINES = 30;
const LINE_MAX = 400;
/** Share of the budget (after the header) the joins + coverage notes may take at most. */
const TAIL_SHARE = 0.4;

function capLines(lines: string[], max: number, what: string): string[] {
  return lines.length <= max ? lines : [...lines.slice(0, max), `- … ${lines.length - max} more ${what} not shown`];
}

const clip = (l: string) => (l.length > LINE_MAX ? l.slice(0, LINE_MAX - 1) + "…" : l);
const size = (ls: string[]) => ls.reduce((s, l) => s + l.length + 1, 0);

/** As many `lines` as fit in `budget` chars, then a marker saying how many were cut. */
function fit(lines: string[], budget: number, what: string): string[] {
  const out: string[] = [];
  let used = 0;
  const reserve = 64;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (used + l.length + 1 > budget - reserve) {
      const omitted = lines.slice(i).filter((x) => x.startsWith("- ")).length;
      if (omitted > 0) out.push(`- … ${omitted} more ${what} omitted (size cap)`);
      return out;
    }
    out.push(l);
    used += l.length + 1;
  }
  return out;
}

/**
 * Compact, deterministic prompt text, never longer than `maxChars` (for any `maxChars` above a
 * few hundred). Joins and coverage notes — the "where absence is not evidence" facts — get up to
 * TAIL_SHARE of the budget, first; entities, then edges, fill the rest, with an explicit marker
 * where the cap cut them. Tiers are printed on every fact; non-exact joins are labelled candidates.
 */
export function renderNeighbourhood(n: Neighbourhood, maxChars = RENDER_MAX_CHARS): string {
  const head: string[] = [`Map neighbourhood — commit ${n.commit === null ? "(none)" : n.commit.slice(0, 12)}, manifest ${n.manifestHash.slice(0, 12)}`];
  if (n.seeds.length === 0) {
    head.push("No entity was named by the ticket; no neighbourhood is shown.");
    return head.join("\n");
  }
  const distinct = new Set(n.entities.map((e) => e.entity.key)).size;
  head.push(clip(`Seeds: ${n.seeds.map((s) => `\`${s}\``).join(", ")}${n.unknownSeeds.length > 0 ? ` (not in this snapshot: ${n.unknownSeeds.join(", ")})` : ""}`));
  head.push(`${distinct} entities within ${n.hops} hop(s)${n.truncated > 0 ? `; ${n.truncated} more reachable, not shown (cap ${n.cap})` : ""}. Tier in [brackets]; absence from this list is NOT evidence of absence in the code.`);

  const body: string[] = [];
  for (const b of n.blocks) {
    body.push("", `## block \`${b.key}\` (${b.family}, ${b.files.length} file${b.files.length === 1 ? "" : "s"}) [${b.tier}]`);
    for (const { entity: e, hop } of n.entities.filter((x) => x.entity.block === b.key)) {
      body.push(`- ${e.kind} \`${e.key}\` [${e.tier}] ${e.evidence}${hop === 0 ? " (seed)" : ""}${e.ambiguous === true ? " AMBIGUOUS" : ""}`);
    }
  }
  if (n.edges.length > 0) body.push("", "## edges", ...n.edges.map((e) => `- \`${e.from}\` → \`${e.to}\` (${e.kind}) [${e.tier}] ${e.evidence}${e.ambiguous === true ? " AMBIGUOUS" : ""}`));

  const joins = capLines(
    n.joins.map((j) =>
      j.status === "pattern-match"
        ? `- \`${j.fetchSite}\`: pattern-match, ${j.candidates.length} candidate(s): ${j.candidates.map((c) => `\`${c}\``).join(", ")} [${j.tier}]`
        : `- \`${j.fetchSite}\`: unresolved — ${j.reason ?? "no reason"} [${j.tier}]`,
    ),
    JOIN_LINES,
    "joins",
  );
  const notes = capLines(
    [
      ...n.notes.partial.map((c) => `- partial ${c.adapter} coverage of ${c.file}: ${c.reasons.map((r) => `${r.reason} (${r.evidence})`).join("; ")}`),
      ...n.notes.unparsed.map((u) => `- unparsed region in ${u.file} lines ${u.startLine}-${u.endLine}: constructs there are not seen`),
      ...n.notes.ambiguous.map((a) => `- ambiguous key \`${a.key}\` (${a.evidence.join(", ")}): it can never verify — do not use it as a ghost id`),
      ...n.notes.notExtracted.map((x) => `- ${x.status}: ${x.path} (${x.reason})`),
    ],
    NOTE_LINES,
    "notes",
  );
  const tailLines = [...(joins.length > 0 ? ["", "## unresolved joins (candidates, not facts)", ...joins] : []), ...(notes.length > 0 ? ["", "## coverage notes", ...notes] : [])].map(clip);

  const remaining = maxChars - size(head);
  const tail = fit(tailLines, Math.floor(remaining * TAIL_SHARE), "notes");
  const main = fit(body.map(clip), remaining - size(tail), "lines");
  return [...head, ...main, ...tail].join("\n");
}
