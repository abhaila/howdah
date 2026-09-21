/**
 * What it means when a harness CLI dies before it says anything.
 *
 * Both agent executors spawn a CLI and read stream-json off stdout. Until now neither read
 * the process's EXIT CODE, so a CLI that never started — most often because it is not logged
 * in — looked identical to one that ran and produced nothing. The attempt then fell through
 * to the outputs check and parked as `attempt-failed` with "[output contract violation]",
 * which blames the model for a problem the model never saw. Worse, the CLI's own explanation
 * ("Please run /login") went to a stderr file in the run dir that nothing in the viewer reads.
 *
 * So: classify the exit here, once, for every harness. An auth failure gets its own ParkCode
 * so the operator is told what is actually wrong and which verb fixes it, and every other
 * startup failure at least carries the CLI's own words instead of a contract complaint.
 *
 * The auth patterns are matched against stderr text, which is a harness's wording and can
 * change. That is why a miss degrades to `attempt-failed` WITH the stderr tail attached
 * rather than to a wrong diagnosis: an unrecognised message still reaches the human intact.
 */
import { harnessSpec, harnessSpecForCommand, isHarness } from "../../core/harnesses";
import type { ParkCode } from "../../log/events";

/** how much of stderr is worth putting in front of a human (and into the run log) */
export const STDERR_TAIL_CHARS = 600;

/**
 * Wording seen from `claude` and `codex` when credentials are missing or expired. Kept
 * deliberately broad: a false positive here names the wrong fix, but a false negative loses
 * nothing, because the fallback still shows the operator the raw text.
 *
 * HOW-17: nothing was added for cursor. cursor-agent is not installed here, so its
 * logged-out wording has never been seen, and a pattern invented for it could only mislead.
 * An unmatched message still degrades to attempt-failed WITH the stderr tail attached — the
 * operator reads what the CLI said, which beats a confident wrong diagnosis.
 */
const AUTH_PATTERNS = [
  /\/login\b/i,
  /\bplease log ?in\b/i,
  /\bnot logged ?in\b/i,
  /\blog in to (your )?(anthropic|openai|claude|codex)\b/i,
  /\binvalid api key\b/i,
  /\bauthentication (failed|required|error)\b/i,
  /\bunauthorized\b/i,
  /\boauth token (has )?expired\b/i,
  /\bcredentials? (are )?(missing|invalid|expired)\b/i,
  /\bsession (has )?expired\b/i,
  /\b401\b/,
];

export function looksUnauthenticated(stderr: string): boolean {
  return AUTH_PATTERNS.some((re) => re.test(stderr));
}

/** the last of stderr, trimmed and collapsed, safe to put in a log line */
export function stderrTail(stderr: string, max = STDERR_TAIL_CHARS): string {
  const t = stderr.trim();
  if (!t) return "";
  const tail = t.length > max ? `…${t.slice(-max)}` : t;
  return tail.split("\n").map((l) => l.trimEnd()).filter(Boolean).join("\n");
}

export interface HarnessExit {
  harness: string;
  /** null when the process was killed or never reported one */
  exitCode: number | null;
  stderr: string;
  /** did the CLI emit ANY parsable protocol output before dying? */
  sawOutput: boolean;
}

/**
 * null means "this exit is not itself the failure" — the caller carries on to its own turn
 * error and outputs checks, which have better information than an exit code does.
 */
export function classifyHarnessExit({ harness, exitCode, stderr, sawOutput }: HarnessExit):
  | { code: ParkCode; reason: string; note: string }
  | null {
  // A CLI that spoke the protocol did start. Whatever went wrong after that belongs to the
  // turn error or the outputs contract, which say more than "exit 1" ever could.
  if (sawOutput) return null;
  if (exitCode === 0 || exitCode === null) return null;

  const tail = stderrTail(stderr);
  if (looksUnauthenticated(stderr)) {
    // HOW-17: the login verb comes off the harness table, not a two-way ternary. `harness`
    // is whatever the executor spawned — a name, a binary, or a test fake's path — so a
    // command we do not recognise keeps the old generic wording rather than guessing.
    const spec = harnessSpecForCommand(harness);
    const login = spec ? `${spec.binary} ${spec.loginVerb}` : `${harness} auth login`;
    return {
      code: "harness-unauthenticated",
      reason:
        `${harness} is not logged in (exit ${exitCode}). Log in with \`${login}\`, ` +
        `then resume this run.` + (tail ? `\n\n${harness} said:\n${tail}` : ""),
      note: `\n[${harness} is not logged in — exit ${exitCode} before any output]${tail ? `\n${tail}` : ""}`,
    };
  }
  return {
    code: "attempt-failed",
    reason:
      `${harness} exited ${exitCode} before producing any output.` +
      (tail ? `\n\n${harness} said:\n${tail}` : ` Nothing was written to stderr either.`),
    note: `\n[${harness} exited ${exitCode} before any output]${tail ? `\n${tail}` : ""}`,
  };
}

/**
 * Runs a harness's own auth-status subcommand. `claude auth status` prints JSON carrying
 * `loggedIn`; `codex login status` prints a line and exits non-zero when logged out; cursor
 * declares `cursor-agent status`. All are local and free, which is why this can be a
 * `doctor` check rather than a test run.
 *
 * `unknown` when the CLI is absent, has no probe on the table, or answers in wording we do
 * not recognise — an old CLI must not be reported as logged out. Being on PATH is not being
 * logged in, and that rule now holds for three harnesses: cursor-agent's own wording is
 * unverified here, so its status output falls through to the generic exit-code reading
 * rather than to an invented pattern.
 */
export function probeAuth(harness: string, run = defaultRun): "in" | "out" | "unknown" {
  // HOW-17: the argv is read off the harness table, so a new harness arrives here with its
  // entry rather than through an edit nobody remembers to make. Three different "we cannot
  // ask" cases end up with no argv, and all three must read as `unknown`: a name no entry
  // answers to, an `internal` harness (probing opencode would spawn claude's own probe and
  // report the answer under opencode's name), and a CLI with no auth-status subcommand.
  const spec = isHarness(harness) ? harnessSpec(harness) : undefined;
  const argv = spec && spec.status !== "internal" ? spec.authProbe : undefined;
  if (!argv) return "unknown";
  const r = run([...argv]);
  if (r === null) return "unknown";
  const text = `${r.stdout}\n${r.stderr}`;
  // claude: JSON with an explicit boolean, which beats guessing from the exit code
  const m = text.match(/"loggedIn"\s*:\s*(true|false)/);
  if (m) return m[1] === "true" ? "in" : "out";
  if (/\bnot logged ?in\b|\bplease (run )?.*login\b/i.test(text)) return "out";
  if (r.code === 0 && /\blogged in\b/i.test(text)) return "in";
  if (r.code === 0) return "unknown"; // exit 0 with wording we do not recognise
  return "out";
}

export interface ProbeRun {
  (argv: string[]): { code: number; stdout: string; stderr: string } | null;
}

const defaultRun: ProbeRun = (argv) => {
  try {
    const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    const dec = new TextDecoder();
    return { code: r.exitCode ?? 1, stdout: dec.decode(r.stdout), stderr: dec.decode(r.stderr) };
  } catch {
    return null; // not on PATH
  }
};
