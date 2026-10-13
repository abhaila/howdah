/**
 * The paired-comparison statistics the A/B harness reports (HOW-42), as the harness-design
 * study does it (HOW-32): task-paired binary outcomes, an EXACT two-sided McNemar test, and
 * Benjamini–Hochberg correction when several comparisons are made at once.
 *
 * Exact, not the chi-square approximation, because Howdah's case sets are small: with a handful
 * of discordant pairs the approximation is meaningless. And honest about power — below
 * MIN_DISCORDANT discordant pairs no exact two-sided test can reach p < 0.05 at all, so the
 * verdict there is "not enough cases to tell", never "no difference".
 */

/** log n! by summation — exact enough for n in the thousands, no gamma approximation needed */
function logFactorial(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

/** P(X = k) for X ~ Binomial(n, 1/2) */
function binomHalf(k: number, n: number): number {
  return Math.exp(logFactorial(n) - logFactorial(k) - logFactorial(n - k) - n * Math.LN2);
}

/**
 * Exact two-sided McNemar p for `b` (A passed, B failed) and `c` (B passed, A failed):
 * min(1, 2 · P(X ≤ min(b, c))), X ~ Binomial(b + c, 1/2). 1 when there are no discordant pairs.
 */
export function mcnemarExact(b: number, c: number): number {
  if (!Number.isInteger(b) || !Number.isInteger(c) || b < 0 || c < 0) throw new Error(`mcnemarExact needs counts, got ${b}, ${c}`);
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binomHalf(i, n);
  return Math.min(1, 2 * tail);
}

/**
 * Below this many discordant pairs, even a perfectly one-sided split cannot give an exact
 * two-sided p under 0.05 (5 discordant pairs all one way: p = 2 · 0.5^5 = 0.0625).
 */
export const MIN_DISCORDANT = 6;

export function enoughDiscordant(discordant: number): boolean {
  return discordant >= MIN_DISCORDANT;
}

/**
 * Benjamini–Hochberg adjusted p-values (step-up, monotone), in the INPUT order: rank the p's,
 * scale each by m / rank, then take the running minimum from the largest rank down.
 */
export function benjaminiHochberg(ps: readonly number[]): number[] {
  const m = ps.length;
  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(m);
  let running = 1;
  for (let r = m; r >= 1; r--) {
    const { p, i } = order[r - 1]!;
    running = Math.min(running, (p * m) / r);
    adjusted[i] = Math.min(1, running);
  }
  return adjusted;
}

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
