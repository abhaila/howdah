/** shorten `s` to at most `max` characters, ending in "…" when it was cut */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** the number of whitespace-separated words in `s` */
export function wordCount(s: string): number {
  const t = s.trim();
  if (t.length === 0) return 0;
  return t.split(" ").length;
}
