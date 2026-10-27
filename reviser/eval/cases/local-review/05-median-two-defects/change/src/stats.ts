export function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

/** the arithmetic mean; throws on an empty list */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) throw new RangeError("mean of an empty list");
  return sum(xs) / xs.length;
}

/** the middle value; throws on an empty list */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) throw new RangeError("median of an empty list");
  return xs[Math.floor(xs.length / 2)]!;
}
