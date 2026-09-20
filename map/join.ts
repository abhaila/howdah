/**
 * Frontend → backend join — system-map 1b.
 *
 * Both sides are normalised to `METHOD + template` (keys.ts `normTemplate`). The outcome is
 * exactly one of:
 *   exact              same method, identical relative template, and BOTH keys unambiguous —
 *                      the only case that becomes an fe-be edge
 *   pattern-match (N)  N ≥ 1 routes that COULD serve the call: a dynamic segment on either side,
 *                      an unknown base URL or absolute origin (matched by suffix), a route whose
 *                      mount prefix is unknown (`GET {*}/orders`), a non-literal method, or an
 *                      ambiguous key on either end
 *   unresolved(reason) nothing to match against, or nothing matches
 * A single plausible candidate is still `pattern-match (1 candidate)`: the join never promotes a
 * guess to an edge (1b spec — "never a single guessed edge").
 */

import { cmpStr } from "./util";

export interface RouteRef {
  key: string;
  method: string;
  template: string;
  /** More than one route entity has this key. */
  ambiguous?: boolean;
}

export interface FetchRef {
  method: string;
  template: string;
  urlKind: string;
  base?: string;
  /** More than one fetch site has this key. */
  ambiguous?: boolean;
}

export interface JoinOutcome {
  status: "exact" | "pattern-match" | "unresolved";
  candidates: string[];
  reason?: string;
}

function segRegex(seg: string): RegExp {
  const parts = seg.split("{*}").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("[^/]+")}$`);
}

function segMatch(a: string, b: string): boolean {
  if (a === b || a === "{*}" || b === "{*}") return true;
  if (a.includes("{*}") && segRegex(a).test(b)) return true;
  if (b.includes("{*}") && segRegex(b).test(a)) return true;
  return false;
}

/** Split a template into (has an unknown leading prefix, path segments). */
function shape(t: string): { open: boolean; segs: string[] } {
  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(t);
  if (origin !== null) return { open: true, segs: t.slice(origin[0].length).split("/").filter((s) => s !== "") };
  if (t.startsWith("{*}/")) return { open: true, segs: t.slice(4).split("/").filter((s) => s !== "") };
  return { open: false, segs: t.split("/").filter((s) => s !== "") };
}

/** Segment-wise match; an open (unknown-prefix) side matches by suffix. */
function shapesMatch(fe: { open: boolean; segs: string[] }, be: { open: boolean; segs: string[] }): boolean {
  const a = fe.segs;
  const b = be.segs;
  const tailMatch = (long: string[], short: string[], shortIsFe: boolean) => {
    const tail = long.slice(long.length - short.length);
    return tail.every((s, i) => (shortIsFe ? segMatch(short[i] ?? "", s) : segMatch(s, short[i] ?? "")));
  };
  if (!fe.open && !be.open) return a.length === b.length && b.every((s, i) => segMatch(a[i] ?? "", s));
  if (fe.open && be.open) return a.length <= b.length ? tailMatch(b, a, true) : tailMatch(a, b, false);
  if (fe.open) return b.length >= a.length && tailMatch(b, a, true);
  return a.length >= b.length && tailMatch(a, b, false);
}

export function joinFetch(fetch: FetchRef, routes: RouteRef[]): JoinOutcome {
  if (fetch.urlKind === "unknown" || fetch.template === "{*}") {
    return { status: "unresolved", candidates: [], reason: `URL is a non-literal expression${fetch.base !== undefined ? `: ${fetch.base}` : ""}` };
  }
  const fe = shape(fetch.template);
  const absolute = fetch.urlKind === "absolute";
  const keyCount = new Map<string, number>();
  for (const r of routes) keyCount.set(r.key, (keyCount.get(r.key) ?? 0) + 1);
  const routeAmbiguous = (k: string) => (keyCount.get(k) ?? 0) > 1 || routes.some((r) => r.key === k && r.ambiguous === true);

  const reasons: string[] = [];
  if (!fe.open && fetch.method !== "*") {
    const exact = [...new Set(routes.filter((r) => r.method === fetch.method && r.template === fetch.template).map((r) => r.key))];
    const only = exact.length === 1 ? exact[0] : undefined;
    if (only !== undefined) {
      if (fetch.ambiguous !== true && !routeAmbiguous(only)) return { status: "exact", candidates: [only] };
      if (fetch.ambiguous === true) reasons.push("fetch-site key is ambiguous");
      if (routeAmbiguous(only)) reasons.push(`route key is ambiguous (${Math.max(keyCount.get(only) ?? 0, 2)} definitions)`);
    }
  }

  const candidates = [...new Set(routes.filter((r) => (fetch.method === "*" || r.method === fetch.method) && shapesMatch(fe, shape(r.template))).map((r) => r.key))].sort(cmpStr);

  if (absolute) reasons.unshift(`absolute URL (origin ${fetch.base ?? "?"}) — may not be this backend`);
  else if (fetch.template.startsWith("{*}/")) reasons.unshift(`base URL is non-literal (${fetch.base ?? "?"})`);
  else if (fetch.method === "*") reasons.unshift("HTTP method is not a literal");
  if (candidates.some((k) => k.includes(" {*}/"))) reasons.push("route mount prefix unknown");
  if (reasons.length === 0) reasons.push("dynamic path segments");

  if (candidates.length > 0) return { status: "pattern-match", candidates, reason: `${reasons.join("; ")}; ${candidates.length} candidate${candidates.length === 1 ? "" : "s"}` };
  const path = fe.open ? "/" + fe.segs.join("/") : fetch.template;
  return {
    status: "unresolved",
    candidates: [],
    reason: absolute
      ? `external origin ${fetch.base ?? "?"}; no route matches ${path}`
      : fe.open
        ? `${reasons[0] ?? ""}; no route matches suffix ${path}`
        : `no ${fetch.method} route matches ${fetch.template}`,
  };
}
