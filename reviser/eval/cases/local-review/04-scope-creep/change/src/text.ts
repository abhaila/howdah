/** shorten `s` to at most `max` characters, followed by "..." when it was cut */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "...";
}

/** the number of space-separated words in `s` */
export function wordCount(s: string): number {
  if (s.length === 0) return 0;
  return s.split(" ").length;
}

/** upper-case the first letter of every space-separated word, lower-case the rest */
export function titleCase(s: string): string {
  return s
    .split(" ")
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}
