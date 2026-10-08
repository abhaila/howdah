/**
 * The behavioural-evidence contract (HOW-12) — what `verify:run` publishes, as DATA a graph,
 * the builder and the executor share. Node-free on purpose: graphs must not import an
 * executor, and core/graph-spec.ts (which the browser bundles) reads VERIFY_PRODUCES.
 *
 * Why it exists: drift (map/drift.ts) is tree-sitter over source, so a `verified` ghost proves
 * a function with that name exists where the design said — not that it runs. Before HOW-12 the
 * only behavioural signal in implement-slice was CI on the PR, i.e. after `delivery.publish`.
 * `verify:run` runs the workspace's own test command in the run's worktree BEFORE the local
 * review, and hands the reviewer a verdict tied to the commit it ran against.
 *
 * Three outcomes, never two. `not-checked` is not a pass: it says the code was never run and
 * why (no command configured, no worktree), in the same spirit as the map's `not-checked` — a
 * gap is reported as a gap, never presented as evidence either way.
 *
 * This is Option A of HOW-12. Option B — a runtime-evidence tier joined to each ghost, so a
 * ghost reaches `verified` only with structural AND behavioural proof — is the follow-up
 * target (shaping.md, "Behavioural evidence").
 */

export const VERIFY_BUILTIN = "verify:run";

/** The context key the built-in publishes — and the ONLY one (the builder gates on it). */
export const VERIFY_RESULT_KEY = "verify.result";
export const VERIFY_PRODUCES = [VERIFY_RESULT_KEY] as const;

/** How much of the combined stdout+stderr reaches context: the tail, where failures print. */
export const VERIFY_OUTPUT_TAIL_CHARS = 4096;

export type VerifyOutcome = "pass" | "fail" | "not-checked";

export interface VerifyResult {
  outcome: VerifyOutcome;
  /** the command that ran (absent when nothing did) */
  command?: string;
  /** null when the process ended on a signal (a timeout kill) */
  exit_code?: number | null;
  duration_ms?: number;
  timed_out?: boolean;
  /** the last VERIFY_OUTPUT_TAIL_CHARS of stdout+stderr; the whole output is in the log as chunks */
  output_tail: string;
  /** HEAD of the worktree the command ran in — the verdict is about THIS commit */
  commit?: string | null;
  /** uncommitted changes were on top of `commit` when it ran (the verdict covers those too) */
  dirty?: boolean;
  /** the command's final stdout line, when it is a JSON object ("facts from the final JSON line") */
  facts?: Record<string, unknown>;
  /** why the outcome is what it is — always set for `not-checked` */
  reason?: string;
}

/** The last `max` characters of `text`, marked as cut when it was. */
export function tail(text: string, max = VERIFY_OUTPUT_TAIL_CHARS): string {
  if (text.length <= max) return text;
  const marker = `… [${text.length - max} earlier characters are in the run log]\n`;
  return marker + text.slice(text.length - max);
}
