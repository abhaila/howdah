export function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

/** the arithmetic mean; throws on an empty list */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) throw new RangeError("mean of an empty list");
  return sum(xs) / xs.length;
}

/** `x` limited to the closed range [lo, hi]; throws when the range is empty */
export function clamp(x: number, lo: number, hi: number): number {
  if (lo > hi) throw new RangeError(`clamp: lo (${lo}) is greater than hi (${hi})`);
  return Math.min(hi, Math.max(lo, x));
}
