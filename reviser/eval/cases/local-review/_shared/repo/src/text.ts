/** shorten `s` to at most `max` characters, ending in "…" when it was cut */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** the number of space-separated words in `s` */
export function wordCount(s: string): number {
  if (s.length === 0) return 0;
  return s.split(" ").length;
}
