/**
 * The `verify:run` contract (HOW-12) — what the built-in is called, what it publishes, and the
 * shape of the verdict a graph routes on.
 *
 * WHY THIS EXISTS. Until HOW-12 the only evidence an `implement-slice` run concluded on was
 * structural: drift is tree-sitter over source, so a `verified` ghost proves a function with
 * that name exists at that file:line — not that it runs. The first behavioural signal in the
 * system was CI on the published PR, one publish cycle too late. `verify:run` executes the
 * workspace's own verification command (tests, a build, a smoke script — whatever the operator
 * registered with `howdah workspace verify`) inside the run's worktree, BEFORE publish, and
 * records what happened as a fact.
 *
 * THE EXIT CODE IS THE VERDICT. A test runner's exit status is proof in the sense the map means
 * it; its prose is not. So `pass` means "the command exited 0", `fail` means it did not (or was
 * killed at its timeout), and the command's final JSON line of stdout — the same contract every
 * other command node uses — is carried along as `facts` for the reader, never consulted to
 * overturn the exit code.
 *
 * NOT CONFIGURED IS ITS OWN ANSWER. A workspace nobody registered a command for gets
 * `not-configured`, never `pass`: the map never presents a guess as fact, and neither does
 * this. It does not park the run either — every workspace registered before HOW-12 has no
 * command, and refusing to deliver all of them would turn a missing setting into an outage.
 * The reviewer is told the code was never run, and the thread says so (see the executor).
 *
 * This file is node-free: `core/graph-spec.ts` (which the browser bundle imports) reads the
 * built-in's name and products from here, so the builder's table cannot drift from the
 * executor's own constants.
 */

export const VERIFY_BUILTIN = "verify:run";

/** The context key the built-in writes — the ONLY fact it publishes. */
export const VERIFY_KEY = "verify.verdict";
export const VERIFY_PRODUCES = [VERIFY_KEY] as const;

/** How much of the command's combined output the verdict keeps: its END, where failures print. */
export const VERIFY_OUTPUT_TAIL = 4_000;

export type VerifyStatus = "pass" | "fail" | "not-configured";

export interface VerifyVerdict {
  status: VerifyStatus;
  /** the command that ran, verbatim — null when none is configured */
  command: string | null;
  /** the registered workspace the command came from, when there is one */
  workspace: string | null;
  /** null when nothing ran, or the process was killed before it could exit */
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  /**
   * WHICH code this verdict is about — observed from git in the worktree just before the
   * command ran. `uncommitted` > 0 means the verdict covers changes no commit holds yet, which
   * the reviewer must weigh exactly as it weighs a dirty drift stamp.
   */
  commit: string | null;
  uncommitted: number;
  /** the last VERIFY_OUTPUT_TAIL characters of stdout+stderr, in arrival order */
  output_tail: string;
  /** the final line of stdout, when it is a JSON object — structured facts from the command */
  facts?: Record<string, unknown>;
}

/** A verification that failed — the edge condition graphs route a failed run back on. */
export function verifyFailed(v: unknown): boolean {
  return typeof v === "object" && v !== null && (v as { status?: unknown }).status === "fail";
}

/** `verify:run` takes no arguments; the first word decides whether a step runs it. */
export function isVerifyBuiltin(run: string): boolean {
  return run.trim().split(/\s+/)[0] === VERIFY_BUILTIN;
}

/** The final non-empty stdout line as a JSON object, or undefined — never a throw. */
export function finalJsonFacts(stdout: string): Record<string, unknown> | undefined {
  const last = stdout.trimEnd().split("\n").at(-1)?.trim() ?? "";
  if (!last.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(last);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Keep the END of a long output, marked, so a reader knows the head was cut. */
export function outputTail(text: string, max = VERIFY_OUTPUT_TAIL): string {
  return text.length <= max ? text : `…(${text.length - max} earlier characters omitted)\n${text.slice(-max)}`;
}
