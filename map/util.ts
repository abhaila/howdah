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
