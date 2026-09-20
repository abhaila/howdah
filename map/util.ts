/**
 * Tiny shared helpers for map/ — one byte-order string comparator (paths, keys) so every sorted
 * list in manifests and assembled maps orders identically, independent of locale.
 */

export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function byPath<T extends { path: string }>(a: T, b: T): number {
  return cmpStr(a.path, b.path);
}

/** SM-D4 tier order, strongest first: observed > resolved > syntactic > evidence-checked > unresolved. */
export const TIER_ORDER = ["observed", "resolved", "syntactic", "evidence-checked", "unresolved"] as const;

/** Is `tier` at least as strong as `floor`? (drift only verifies at ≥ syntactic.) */
export function tierAtLeast(tier: (typeof TIER_ORDER)[number], floor: (typeof TIER_ORDER)[number]): boolean {
  return TIER_ORDER.indexOf(tier) <= TIER_ORDER.indexOf(floor);
}
