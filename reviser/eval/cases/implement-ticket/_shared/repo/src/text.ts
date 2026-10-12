/** Small text helpers. */

/** Count the words in `s`: runs of non-whitespace. */
export function wordCount(s: string): number {
  return s.split(" ").length;
}

/** Capitalise the first letter of every word. */
export function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
